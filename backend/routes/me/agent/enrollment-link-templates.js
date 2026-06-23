const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authorize, getUserRoles } = require('../../../middleware/auth');
const { isUplineAncestor } = require('../../../utils/agentHierarchy');
const agencyAdmins = require('../../../utils/agencyAdmins');

/** CTE fragment for self + downline AgentIds (AgencyOwner). Use with @userId. */
const DOWNLINE_CTE = `
WITH Downline AS (
    SELECT a.AgentId FROM oe.Agents a WHERE a.UserId = @userId AND a.Status = 'Active'
    UNION ALL
    SELECT ah.AgentId FROM oe.AgentHierarchy ah
    INNER JOIN Downline d ON ah.ParentId = d.AgentId
    WHERE ah.Status = 'Active'
)
`;

async function resolveEffectiveAgencyOwner(pool, req, userId) {
    const userRoles = getUserRoles(req.user) || [];
    if (userRoles.includes('AgencyOwner')) {
        return { isAgencyOwner: true };
    }

    const agentRequest = pool.request();
    agentRequest.input('userId', sql.UniqueIdentifier, userId);
    const agentResult = await agentRequest.query('SELECT AgentId, AgencyId FROM oe.Agents WHERE UserId = @userId AND Status = \'Active\'');
    const currentUserAgentId = agentResult.recordset[0]?.AgentId || null;
    const currentAgencyId = agentResult.recordset[0]?.AgencyId || null;
    const isAgencyOwner =
        currentUserAgentId && currentAgencyId
            ? await agencyAdmins.isAgencyAdmin(pool, currentAgencyId, currentUserAgentId)
            : false;

    return { isAgencyOwner };
}

/**
 * @route   GET /api/me/agent/enrollment-link-templates
 * @desc    Get all enrollment link templates created by the authenticated agent (or all templates for agents in tenant if TenantAdmin)
 * @access  Private (Agent, AgencyOwner, TenantAdmin)
 */
router.get('/', authorize(['Agent', 'AgencyOwner', 'TenantAdmin']), async (req, res) => {
    try {
        const userId = req.user?.UserId;
        if (!userId) {
            return res.status(401).json({ 
                success: false, 
                message: 'User not authenticated or user ID is missing.' 
            });
        }
        
        console.log('🔍 GET /api/me/agent/enrollment-link-templates - Request received');
        console.log('👤 User:', { 
            userId: userId,
            roles: req.user?.roles,
            email: req.user?.Email
        });
        
        // Parse pagination and filter parameters
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        const search = req.query.search || '';
        const templateType = req.query.templateType || '';
        const isActive = req.query.isActive;
        const groupId = req.query.groupId || ''; // Look up AgentId from oe.Groups
        const agentIdParam = req.query.agentId || ''; // Direct agentId parameter
        const viewDownline = req.query.viewDownline === '1' || req.query.viewDownline === 'true'; // AgencyOwner: all downline templates
        const excludeHasMarketingLink = req.query.excludeHasMarketingLink === '1' || req.query.excludeHasMarketingLink === 'true';
        const hasMarketingLink = req.query.hasMarketingLink === '1' || req.query.hasMarketingLink === 'true';
        
        const pool = await getPool();
        const currentRole = req.user?.currentRole;
        const { isAgencyOwner } = await resolveEffectiveAgencyOwner(pool, req, userId);
        
        // If groupId is provided, look up the AgentId from oe.Groups
        let agentIdFromGroup = null;
        if (groupId) {
            const groupRequest = pool.request();
            groupRequest.input('groupId', sql.UniqueIdentifier, groupId);
            const groupResult = await groupRequest.query(`
                SELECT AgentId FROM oe.Groups WHERE GroupId = @groupId
            `);
            
            if (groupResult.recordset.length > 0) {
                agentIdFromGroup = groupResult.recordset[0].AgentId;
                console.log(`🎯 Looked up AgentId from group ${groupId}: ${agentIdFromGroup}`);
            } else {
                console.log(`⚠️ Group ${groupId} not found`);
            }
        }
        
        // Check currentRole - TenantAdmins can see all templates for agents in their tenant
        const isTenantAdmin = currentRole === 'TenantAdmin' || currentRole === 'SysAdmin';
        
        let agentId = null;
        let tenantId = null;
        let whereClause = '';
        
        if (isTenantAdmin) {
            // TenantAdmin: Get TenantId and show all templates for agents in their tenant
            tenantId = req.user?.TenantId || req.tenantId;
            
            if (!tenantId) {
                // Try to get TenantId from Users table
                const userTenantQuery = 'SELECT TenantId FROM oe.Users WHERE UserId = @userId';
                const userTenantRequest = pool.request();
                userTenantRequest.input('userId', sql.UniqueIdentifier, userId);
                const userTenantResult = await userTenantRequest.query(userTenantQuery);
                
                if (userTenantResult.recordset.length > 0 && userTenantResult.recordset[0].TenantId) {
                    tenantId = userTenantResult.recordset[0].TenantId;
                }
            }
            
            if (!tenantId) {
                console.log('❌ No tenant found for TenantAdmin user:', userId);
                return res.status(404).json({ 
                    success: false, 
                    message: 'Tenant not found for authenticated user.' 
                });
            }
            
            console.log('✅ TenantAdmin access - TenantId:', tenantId);
            // TenantAdmin can see all templates for agents in their tenant
            // But if groupId or agentId is provided, filter by that agent
            const finalAgentId = agentIdFromGroup || agentIdParam;
            if (finalAgentId) {
                whereClause = 'elt.TenantId = @tenantId AND (elt.AgentId = @agentId OR elt.AgencyId = @agentId)';
            } else {
                whereClause = 'elt.TenantId = @tenantId';
            }
        } else {
            // Regular Agent or AgencyOwner: Get the AgentId from the oe.Agents table
            const agentRequest = pool.request();
            agentRequest.input('userId', sql.UniqueIdentifier, userId);
            const agentResult = await agentRequest.query('SELECT AgentId FROM oe.Agents WHERE UserId = @userId');
            if (agentResult.recordset.length === 0) {
                console.log('❌ No agent found for user:', userId);
                return res.status(404).json({ success: false, message: 'Agent profile not found for authenticated user.' });
            }
            const currentUserAgentId = agentResult.recordset[0].AgentId;

            if (agentIdFromGroup) {
                agentId = agentIdFromGroup;
                console.log('✅ Using AgentId from group:', agentId);
                whereClause = '(elt.AgentId = @agentId OR elt.AgencyId = @agentId)';
            } else if (isAgencyOwner && viewDownline && !agentIdParam) {
                // AgencyOwner viewing all downline templates: use CTE (self + downline)
                whereClause = `(elt.AgentId IN (SELECT AgentId FROM Downline) OR elt.AgencyId IN (SELECT AgentId FROM Downline))`;
                console.log('✅ AgencyOwner viewDownline - templates for self + downline');
            } else if (isAgencyOwner && agentIdParam) {
                // AgencyOwner filtering by one agent: verify agentIdParam is self or in downline
                const allowRequest = pool.request();
                allowRequest.input('userId', sql.UniqueIdentifier, userId);
                allowRequest.input('targetAgentId', sql.UniqueIdentifier, agentIdParam);
                const allowResult = await allowRequest.query(`
                    ${DOWNLINE_CTE}
                    SELECT 1 AS Allowed FROM Downline WHERE AgentId = @targetAgentId
                `);
                if (allowResult.recordset.length === 0) {
                    return res.status(403).json({ success: false, message: 'Agent not in your downline.' });
                }
                agentId = agentIdParam;
                console.log('✅ AgencyOwner filtering by agent:', agentId);
                whereClause = '(elt.AgentId = @agentId OR elt.AgencyId = @agentId)';
            } else if (agentIdParam) {
                // Plain Agent (not AgencyOwner): only allow self or downline
                if (!isAgencyOwner) {
                    const isSelf = String(agentIdParam).toLowerCase() === String(currentUserAgentId).toLowerCase();
                    const isDownline = await isUplineAncestor(pool, agentIdParam, currentUserAgentId);
                    if (!isSelf && !isDownline) {
                        return res.status(403).json({ success: false, message: 'Agent not in your downline.' });
                    }
                }
                agentId = agentIdParam;
                console.log('✅ Using provided AgentId parameter:', agentId);
                whereClause = '(elt.AgentId = @agentId OR elt.AgencyId = @agentId)';
            } else {
                agentId = currentUserAgentId;
                console.log('✅ Found AgentId (my links):', agentId);
                whereClause = '(elt.AgentId = @agentId OR elt.AgencyId = @agentId)';
            }
        }
        
        const request = pool.request();
        if (isTenantAdmin) {
            request.input('tenantId', sql.UniqueIdentifier, tenantId);
            const finalAgentId = agentIdFromGroup || agentIdParam;
            if (finalAgentId) {
                request.input('agentId', sql.UniqueIdentifier, finalAgentId);
            }
        } else {
            if (agentId) {
                request.input('agentId', sql.UniqueIdentifier, agentId);
            }
        }
        request.input('offset', sql.Int, offset);
        request.input('limit', sql.Int, limit);
        
        // Add search filter
        if (search) {
            whereClause += ' AND (elt.TemplateName LIKE @search OR elt.Description LIKE @search)';
            request.input('search', sql.NVarChar, `%${search}%`);
        }
        
        // Add template type filter
        if (templateType) {
            whereClause += ' AND elt.TemplateType = @templateType';
            request.input('templateType', sql.NVarChar, templateType);
        }
        // When groupId is provided, only return Group-type templates linked to this group
        if (groupId) {
            whereClause += ' AND elt.TemplateType = \'Group\' AND elt.GroupId = @groupId';
            request.input('groupId', sql.UniqueIdentifier, groupId);
        }
        
        // Add active status filter
        if (isActive !== undefined && isActive !== '') {
            whereClause += ' AND elt.IsActive = @isActive';
            request.input('isActive', sql.Bit, isActive === 'true' ? 1 : 0);
        } else {
            // Default to only active templates
            whereClause += ' AND elt.IsActive = 1';
        }
        
        if (excludeHasMarketingLink) {
            whereClause += " AND NOT EXISTS (SELECT 1 FROM oe.EnrollmentLinks el WHERE el.EnrollmentLinkTemplateId = elt.TemplateId AND el.LinkType = 'Marketing' AND el.IsActive = 1)";
        }
        if (hasMarketingLink) {
            whereClause += " AND EXISTS (SELECT 1 FROM oe.EnrollmentLinks el WHERE el.EnrollmentLinkTemplateId = elt.TemplateId AND el.LinkType = 'Marketing' AND el.IsActive = 1)";
        }
        
        // When AgencyOwner viewDownline, prepend CTE and pass userId
        const useDownlineCte = whereClause.includes('FROM Downline');
        if (useDownlineCte) {
            request.input('userId', sql.UniqueIdentifier, userId);
        }
        
        // Get enrollment link templates with pagination
        const templatesQuery = (useDownlineCte ? DOWNLINE_CTE : '') + `
            SELECT 
                elt.TemplateId,
                elt.TemplateName,
                elt.TemplateType,
                elt.AgentId,
                elt.AgencyId,
                elt.GroupId,
                elt.TenantId,
                elt.LinkMetaData,
                elt.IsActive,
                elt.Description,
                elt.CreatedDate,
                elt.ModifiedDate,
                elt.CreatedBy,
                elt.ModifiedBy,
                -- Get count of active enrollment links using this template
                (SELECT COUNT(*) FROM oe.EnrollmentLinks el 
                 WHERE el.EnrollmentLinkTemplateId = elt.TemplateId AND el.IsActive = 1) as ActiveLinksCount,
                -- Check if this template has a marketing link
                CASE 
                    WHEN EXISTS (
                        SELECT 1 FROM oe.EnrollmentLinks el 
                        WHERE el.EnrollmentLinkTemplateId = elt.TemplateId 
                        AND el.LinkType = 'Marketing' 
                        AND el.IsActive = 1
                    ) THEN 1
                    ELSE 0
                END as HasMarketingLink,
                -- Get creator name
                creator.FirstName + ' ' + creator.LastName as CreatedByName,
                -- Get modifier name
                modifier.FirstName + ' ' + modifier.LastName as ModifiedByName,
                -- Add tenant and agent names for consistency with other endpoints
                ISNULL(t.Name, 'Unknown Tenant') as TenantName,
                CASE 
                    WHEN elt.AgentId IS NOT NULL THEN CONCAT(ISNULL(u.FirstName, ''), ' ', ISNULL(u.LastName, ''))
                    WHEN elt.AgencyId IS NOT NULL THEN ag.AgencyName
                    ELSE NULL
                END as AgentName,
                g.Name AS GroupName
            FROM oe.EnrollmentLinkTemplates elt
            LEFT JOIN oe.Users creator ON elt.CreatedBy = creator.UserId
            LEFT JOIN oe.Users modifier ON elt.ModifiedBy = modifier.UserId
            LEFT JOIN oe.Agents a ON elt.AgentId = a.AgentId
            LEFT JOIN oe.Users u ON a.UserId = u.UserId
            LEFT JOIN oe.Agencies ag ON elt.AgencyId = ag.AgencyId
            LEFT JOIN oe.Tenants t ON elt.TenantId = t.TenantId
            LEFT JOIN oe.Groups g ON elt.GroupId = g.GroupId
            WHERE ${whereClause}
            ORDER BY elt.ModifiedDate DESC
            OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
        `;
        
        console.log('🔎 Data query:', templatesQuery);
        const templatesResult = await request.query(templatesQuery);
        
        // Get total count for pagination
        const countQuery = (useDownlineCte ? DOWNLINE_CTE : '') + `
            SELECT COUNT(*) as TotalCount
            FROM oe.EnrollmentLinkTemplates elt
            WHERE ${whereClause}
        `;
        
        const countResult = await request.query(countQuery);
        const totalCount = countResult.recordset[0].TotalCount;
        const totalPages = Math.ceil(totalCount / limit);
        
        console.log('📊 Found templates:', {
            count: templatesResult.recordset.length,
            totalCount: totalCount,
            totalPages: totalPages,
            currentPage: page
        });
        
        console.log(`✅ Found ${templatesResult.recordset.length} enrollment link templates for agent ${agentId}`);

        // Auto-create a default Individual template when an agent has none
        if (!isTenantAdmin && totalCount === 0 && !search && !templateType) {
            try {
                console.log('🆕 No templates found for agent, auto-creating default Individual template');

                // Fetch all active products for the tenant
                const productsRequest = pool.request();
                productsRequest.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
                const productsResult = await productsRequest.query(`
                    SELECT ProductId, ProductName, ProductType
                    FROM oe.Products
                    WHERE TenantId = @tenantId AND IsActive = 1
                    ORDER BY ProductType, ProductName
                `);

                // Group products by ProductType
                const productsByType = {};
                for (const row of productsResult.recordset) {
                    if (!productsByType[row.ProductType]) {
                        productsByType[row.ProductType] = [];
                    }
                    productsByType[row.ProductType].push(row.ProductId);
                }

                const linkMetaData = {
                    household: {
                        collectSSN: false,
                        collectDOB: true,
                        collectGender: false,
                        collectAddress: true,
                        collectPhone: true,
                    },
                    products: Object.entries(productsByType).map(([productType, productIds]) => ({
                        page: productType,
                        header: `Select Your ${productType} Coverage`,
                        productType: productType.toLowerCase(),
                        sectionType: 'products',
                        includePdfLinks: true,
                        includeVideos: false,
                        effectiveDateRules: { type: 'MemberSelected' },
                        specificProducts: productIds
                    }))
                };

                const templateId = require('crypto').randomUUID();
                const insertRequest = pool.request();
                insertRequest.input('templateId', sql.UniqueIdentifier, templateId);
                insertRequest.input('templateName', sql.NVarChar, 'My Enrollment Link');
                insertRequest.input('templateType', sql.NVarChar, 'Individual');
                insertRequest.input('agentId', sql.UniqueIdentifier, agentId);
                insertRequest.input('tenantId', sql.UniqueIdentifier, req.user.TenantId);
                insertRequest.input('description', sql.NVarChar, 'Default enrollment link with all available products');
                insertRequest.input('linkMetaData', sql.NVarChar, JSON.stringify(linkMetaData));
                insertRequest.input('userId', sql.UniqueIdentifier, userId);

                await insertRequest.query(`
                    INSERT INTO oe.EnrollmentLinkTemplates
                        (TemplateId, TemplateName, TemplateType, AgentId, TenantId, Description, LinkMetaData, IsActive, CreatedBy, ModifiedBy, CreatedDate, ModifiedDate)
                    VALUES
                        (@templateId, @templateName, @templateType, @agentId, @tenantId, @description, @linkMetaData, 1, @userId, @userId, GETUTCDATE(), GETUTCDATE())
                `);

                console.log('✅ Default template created:', templateId);

                // Re-run the data and count queries to include the new template
                const reRequest = pool.request();
                if (agentId) {
                    reRequest.input('agentId', sql.UniqueIdentifier, agentId);
                }
                reRequest.input('offset', sql.Int, offset);
                reRequest.input('limit', sql.Int, limit);
                if (useDownlineCte) {
                    reRequest.input('userId', sql.UniqueIdentifier, userId);
                }

                const reTemplatesResult = await reRequest.query(templatesQuery);
                const reCountResult = await reRequest.query(countQuery);
                const reTotalCount = reCountResult.recordset[0].TotalCount;
                const reTotalPages = Math.ceil(reTotalCount / limit);

                return res.json({
                    success: true,
                    data: {
                        data: reTemplatesResult.recordset,
                        pagination: {
                            currentPage: page,
                            totalPages: reTotalPages,
                            totalCount: reTotalCount,
                            limit: limit,
                            hasNextPage: page < reTotalPages,
                            hasPreviousPage: page > 1
                        }
                    }
                });
            } catch (autoCreateError) {
                console.error('⚠️ Failed to auto-create default template, returning empty result:', autoCreateError.message);
                // Fall through to return the empty result below
            }
        }

        res.json({
            success: true,
            data: {
                data: templatesResult.recordset,
                pagination: {
                    currentPage: page,
                    totalPages: totalPages,
                    totalCount: totalCount,
                    limit: limit,
                    hasNextPage: page < totalPages,
                    hasPreviousPage: page > 1
                }
            }
        });
        
    } catch (error) {
        console.error('❌ Error fetching agent enrollment link templates:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching enrollment link templates',
            error: {
                message: error.message,
                code: 'AGENT_ENROLLMENT_TEMPLATES_ERROR'
            }
        });
    }
});

/**
 * @route   POST /api/me/agent/enrollment-link-templates/sync-group-products
 * @desc    Update all enrollment link templates for a group to use the given product set (agent must own group or be TenantAdmin)
 * @access  Private (Agent, AgencyOwner, TenantAdmin)
 */
router.post('/sync-group-products', authorize(['Agent', 'AgencyOwner', 'TenantAdmin']), async (req, res) => {
    try {
        const { groupId, productIds } = req.body;
        const userId = req.user?.UserId;
        const pool = await getPool();

        if (!userId) {
            return res.status(401).json({ success: false, message: 'User not authenticated.' });
        }
        if (!groupId || !Array.isArray(productIds)) {
            return res.status(400).json({ success: false, message: 'groupId and productIds (array) are required.' });
        }

        const groupReq = pool.request().input('groupId', sql.UniqueIdentifier, groupId);
        const groupRow = (await groupReq.query('SELECT GroupId, AgentId, TenantId FROM oe.Groups WHERE GroupId = @groupId')).recordset[0];
        if (!groupRow) {
            return res.status(404).json({ success: false, message: 'Group not found.' });
        }
        const tenantId = groupRow.TenantId;
        const currentRole = req.user?.currentRole;
        const isTenantAdmin = currentRole === 'TenantAdmin' || currentRole === 'SysAdmin';
        if (!isTenantAdmin) {
            const agentReq = pool.request().input('userId', sql.UniqueIdentifier, userId);
            const agentId = (await agentReq.query('SELECT AgentId FROM oe.Agents WHERE UserId = @userId')).recordset[0]?.AgentId;
            const { isAgencyOwner } = await resolveEffectiveAgencyOwner(pool, req, userId);
            const canAccess = groupRow.AgentId && (groupRow.AgentId === agentId || (isAgencyOwner && (await pool.request().input('parentId', sql.UniqueIdentifier, agentId).input('agentId', sql.UniqueIdentifier, groupRow.AgentId).query(`
                SELECT 1 FROM oe.AgentHierarchy WHERE ParentId = @parentId AND AgentId = @agentId AND Status = 'Active'
            `)).recordset.length > 0));
            if (!canAccess) {
                return res.status(403).json({ success: false, message: 'You do not have access to this group.' });
            }
        }

        const productIdsParam = productIds.filter(Boolean);
        let products = [];
        if (productIdsParam.length > 0) {
            const placeholders = productIdsParam.map((_, i) => `@p${i}`).join(',');
            const reqProducts = pool.request().input('tenantId', sql.UniqueIdentifier, tenantId);
            productIdsParam.forEach((id, i) => reqProducts.input(`p${i}`, sql.UniqueIdentifier, id));
            products = (await reqProducts.query(`
                SELECT ProductId, ProductType, IsBundle FROM oe.Products WHERE TenantId = @tenantId AND ProductId IN (${placeholders})
            `)).recordset || [];
        }
        const productsByType = {};
        let bundleProductIds = [];
        products.forEach(p => {
            const pt = p.ProductType || 'Other';
            if (pt === 'Bundle') {
                bundleProductIds.push(p.ProductId);
                return;
            }
            if (!productsByType[pt]) productsByType[pt] = [];
            productsByType[pt].push(p.ProductId);
        });
        const productSections = [];
        for (const [productType, productIds] of Object.entries(productsByType)) {
            if (!productIds.length) continue;
            const isHealthcareOrMedical = productType === 'Healthcare' || productType === 'Medical';
            const specificProducts = isHealthcareOrMedical && bundleProductIds.length > 0
                ? [...productIds, ...bundleProductIds]
                : productIds;
            if (isHealthcareOrMedical) bundleProductIds = [];
            productSections.push({
                page: productType,
                header: `Select Your ${productType} Coverage`,
                productType,
                includePdfLinks: true,
                includeVideos: false,
                effectiveDateRules: { type: 'GroupDefined' },
                specificProducts
            });
        }
        if (bundleProductIds.length > 0) {
            productSections.push({
                page: 'Healthcare',
                header: 'Select Your Healthcare Coverage',
                productType: 'Healthcare',
                includePdfLinks: true,
                includeVideos: false,
                effectiveDateRules: { type: 'GroupDefined' },
                specificProducts: bundleProductIds
            });
        }
        const sectionOrder = ['Healthcare', 'Medical', 'Dental', 'Vision', 'Other'];
        productSections.sort((a, b) => {
            const i = sectionOrder.indexOf(a.productType);
            const j = sectionOrder.indexOf(b.productType);
            const orderA = i === -1 ? sectionOrder.length : i;
            const orderB = j === -1 ? sectionOrder.length : j;
            return orderA !== orderB ? orderA - orderB : (a.productType || '').localeCompare(b.productType || '');
        });

        const templatesResult = await pool.request().input('groupId', sql.UniqueIdentifier, groupId).input('tenantId', sql.UniqueIdentifier, tenantId).query(`
            SELECT TemplateId, TemplateName, LinkMetaData FROM oe.EnrollmentLinkTemplates WHERE GroupId = @groupId AND TenantId = @tenantId
        `);
        const templates = templatesResult.recordset || [];
        for (const row of templates) {
            let meta = {};
            try { meta = JSON.parse(row.LinkMetaData || '{}'); } catch (_) {}
            meta.products = productSections;
            const newMeta = JSON.stringify(meta);
            await pool.request().input('templateId', sql.UniqueIdentifier, row.TemplateId).input('linkMetaData', sql.NVarChar, newMeta).input('modifiedBy', sql.UniqueIdentifier, userId).query(`
                UPDATE oe.EnrollmentLinkTemplates SET LinkMetaData = @linkMetaData, ModifiedBy = @modifiedBy, ModifiedDate = GETUTCDATE() WHERE TemplateId = @templateId
            `);
        }
        res.json({ success: true, message: `${templates.length} enrollment link template(s) updated.`, updatedCount: templates.length });
    } catch (error) {
        console.error('❌ Error syncing group products (agent):', error);
        res.status(500).json({ success: false, message: 'Server error while syncing enrollment link templates.' });
    }
});

/**
 * @route   GET /api/me/agent/enrollment-link-templates/:templateId
 * @desc    Get a specific enrollment link template by ID (must belong to agent)
 * @access  Private (Agent, AgencyOwner, TenantAdmin)
 */
router.get('/:templateId', authorize(['Agent', 'AgencyOwner', 'TenantAdmin']), async (req, res) => {
    try {
        const userId = req.user?.UserId;
        const { templateId } = req.params;
        
        if (!userId) {
            return res.status(401).json({ 
                success: false, 
                message: 'User not authenticated or user ID is missing.' 
            });
        }
        
        if (!templateId) {
            return res.status(400).json({ 
                success: false, 
                message: 'Template ID is required.' 
            });
        }
        
        console.log('🔍 GET /api/me/agent/enrollment-link-templates/:templateId - Request received');
        console.log('👤 User:', { userId, templateId });
        
        const pool = await getPool();
        
        // Check currentRole - TenantAdmins can see any template in their tenant
        // Use currentRole instead of checking roles array to avoid conflicts when user has multiple roles
        const currentRole = req.user?.currentRole;
        const isTenantAdmin = currentRole === 'TenantAdmin' || currentRole === 'SysAdmin';
        
        let agentId = null;
        let tenantId = null;
        let accessCondition = '';
        
        if (isTenantAdmin) {
            // TenantAdmin: Get TenantId and allow access to any template in their tenant
            tenantId = req.user?.TenantId || req.tenantId;
            
            if (!tenantId) {
                // Try to get TenantId from Users table
                const userTenantQuery = 'SELECT TenantId FROM oe.Users WHERE UserId = @userId';
                const userTenantRequest = pool.request();
                userTenantRequest.input('userId', sql.UniqueIdentifier, userId);
                const userTenantResult = await userTenantRequest.query(userTenantQuery);
                
                if (userTenantResult.recordset.length > 0 && userTenantResult.recordset[0].TenantId) {
                    tenantId = userTenantResult.recordset[0].TenantId;
                }
            }
            
            if (!tenantId) {
                return res.status(404).json({ 
                    success: false, 
                    message: 'Tenant not found for authenticated user.' 
                });
            }
            
            console.log('✅ TenantAdmin access - TenantId:', tenantId);
            accessCondition = 'AND elt.TenantId = @tenantId';
        } else {
            // Regular Agent or AgencyOwner
            const { isAgencyOwner: isAgencyOwnerGet } = await resolveEffectiveAgencyOwner(pool, req, userId);
            const agentRequest = pool.request();
            agentRequest.input('userId', sql.UniqueIdentifier, userId);
            const agentResult = await agentRequest.query('SELECT AgentId FROM oe.Agents WHERE UserId = @userId');
            if (agentResult.recordset.length === 0) {
                return res.status(404).json({ success: false, message: 'Agent profile not found for authenticated user.' });
            }
            agentId = agentResult.recordset[0].AgentId;
            if (isAgencyOwnerGet) {
                accessCondition = 'AND (elt.AgentId IN (SELECT AgentId FROM Downline) OR elt.AgencyId IN (SELECT AgentId FROM Downline))';
            } else {
                accessCondition = 'AND (elt.AgentId = @agentId OR elt.AgencyId = @agentId)';
            }
        }
        
        // Get specific template (must belong to this agent or be in tenant for TenantAdmin)
        const useDownlineCteGet = accessCondition.includes('FROM Downline');
        const templateQuery = (useDownlineCteGet ? DOWNLINE_CTE : '') + `
            SELECT 
                elt.TemplateId,
                elt.TemplateName,
                elt.TemplateType,
                elt.AgentId,
                elt.GroupId,
                elt.TenantId,
                elt.LinkMetaData,
                elt.IsActive,
                elt.Description,
                elt.CreatedDate,
                elt.ModifiedDate,
                elt.CreatedBy,
                elt.ModifiedBy,
                -- Get count of active enrollment links using this template
                (SELECT COUNT(*) FROM oe.EnrollmentLinks el 
                 WHERE el.EnrollmentLinkTemplateId = elt.TemplateId AND el.IsActive = 1) as ActiveLinksCount,
                -- Get creator name
                creator.FirstName + ' ' + creator.LastName as CreatedByName,
                -- Get modifier name
                modifier.FirstName + ' ' + modifier.LastName as ModifiedByName
            FROM oe.EnrollmentLinkTemplates elt
            LEFT JOIN oe.Users creator ON elt.CreatedBy = creator.UserId
            LEFT JOIN oe.Users modifier ON elt.ModifiedBy = modifier.UserId
            WHERE elt.TemplateId = @templateId 
              ${accessCondition}
              AND elt.IsActive = 1
        `;
        
        const templateRequest = pool.request();
        templateRequest.input('templateId', sql.UniqueIdentifier, templateId);
        if (isTenantAdmin) {
            templateRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
        } else {
            if (useDownlineCteGet) templateRequest.input('userId', sql.UniqueIdentifier, userId);
            else templateRequest.input('agentId', sql.UniqueIdentifier, agentId);
        }
        const templateResult = await templateRequest.query(templateQuery);
        
        if (templateResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Enrollment link template not found or access denied'
            });
        }
        
        console.log('✅ Found enrollment link template:', templateId);
        
        res.json({
            success: true,
            data: templateResult.recordset[0]
        });
        
    } catch (error) {
        console.error('❌ Error fetching enrollment link template:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching enrollment link template',
            error: {
                message: error.message,
                code: 'AGENT_ENROLLMENT_TEMPLATE_ERROR'
            }
        });
    }
});

/**
 * @route   POST /api/me/agent/enrollment-link-templates
 * @desc    Create a new enrollment link template (agent). AgencyOwner may pass body.agentId to create for a downline agent.
 * @access  Private (Agent, AgencyOwner)
 */
router.post('/', authorize(['Agent', 'AgencyOwner']), async (req, res) => {
    try {
        const { templateName, templateType, linkMetaData, description, isActive = true, groupId: bodyGroupId, agentId: bodyAgentId } = req.body;
        const userId = req.user?.UserId;
        
        if (!userId) {
            return res.status(401).json({ 
                success: false, 
                message: 'User not authenticated or user ID is missing.' 
            });
        }
        
        if (!templateName || !templateType) {
            return res.status(400).json({
                success: false,
                message: 'Template name and template type are required.'
            });
        }
        // GroupId is optional for Group templates (e.g. group marketing link without a specific group)
        
        console.log('🔍 POST /api/me/agent/enrollment-link-templates - Request received');
        console.log('📋 Template data:', { templateName, templateType, groupId: bodyGroupId, agentId: bodyAgentId, isActive });
        
        const pool = await getPool();
        
        // Get the AgentId and TenantId from the oe.Agents table using the current user's UserId
        const agentRequest = pool.request();
        agentRequest.input('userId', sql.UniqueIdentifier, userId);
        const agentResult = await agentRequest.query('SELECT AgentId, TenantId FROM oe.Agents WHERE UserId = @userId');
        
        if (agentResult.recordset.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Agent profile not found for authenticated user.' 
            });
        }
        
        let agentId = agentResult.recordset[0].AgentId;
        const tenantId = agentResult.recordset[0].TenantId;
        // Any Agent can create a template for self or a downline agent
        if (bodyAgentId) {
            const selfOk = String(bodyAgentId).toLowerCase() === String(agentId).toLowerCase();
            const downlineOk = await isUplineAncestor(pool, bodyAgentId, agentId);
            if (!selfOk && !downlineOk) {
                return res.status(403).json({ success: false, message: 'You can only create templates for yourself or your downline agents.' });
            }
            agentId = bodyAgentId;
        }
        console.log('✅ Using AgentId:', agentId, 'TenantId:', tenantId);
        
        // Generate a new TemplateId
        const templateId = require('crypto').randomUUID();
        
        // Create the template (Group type includes GroupId)
        const createRequest = pool.request();
        createRequest.input('templateId', sql.UniqueIdentifier, templateId);
        createRequest.input('templateName', sql.NVarChar, templateName);
        createRequest.input('templateType', sql.NVarChar, templateType);
        createRequest.input('agentId', sql.UniqueIdentifier, agentId);
        createRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
        createRequest.input('linkMetaData', sql.NVarChar, typeof linkMetaData === 'string' ? linkMetaData : JSON.stringify(linkMetaData));
        createRequest.input('description', sql.NVarChar, description || null);
        createRequest.input('isActive', sql.Bit, isActive);
        createRequest.input('createdBy', sql.UniqueIdentifier, userId);
        createRequest.input('modifiedBy', sql.UniqueIdentifier, userId);
        createRequest.input('groupId', sql.UniqueIdentifier, templateType === 'Group' && bodyGroupId ? bodyGroupId : null);
        
        const createQuery = `
            INSERT INTO oe.EnrollmentLinkTemplates (
                TemplateId, TemplateName, TemplateType, AgentId, TenantId, GroupId,
                LinkMetaData, Description, IsActive, CreatedBy, ModifiedBy,
                CreatedDate, ModifiedDate
            ) VALUES (
                @templateId, @templateName, @templateType, @agentId, @tenantId, @groupId,
                @linkMetaData, @description, @isActive, @createdBy, @modifiedBy,
                GETUTCDATE(), GETUTCDATE()
            )
        `;
        
        await createRequest.query(createQuery);
        
        console.log('✅ Created enrollment link template:', templateName, templateType === 'Group' ? 'with GroupId: ' + bodyGroupId : '');
        
        res.status(201).json({
            success: true,
            data: { templateId },
            message: 'Enrollment link template created successfully'
        });
        
    } catch (error) {
        console.error('❌ Error creating enrollment link template:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while creating enrollment link template',
            error: {
                message: error.message,
                code: 'AGENT_CREATE_ENROLLMENT_TEMPLATE_ERROR'
            }
        });
    }
});

/**
 * @route   POST /api/me/agent/enrollment-link-templates/:templateId/duplicate
 * @desc    Duplicate an enrollment link template with new IDs
 * @access  Private (Agent, AgencyOwner)
 */
router.post('/:templateId/duplicate', authorize(['Agent', 'AgencyOwner']), async (req, res) => {
    try {
        const { templateId } = req.params;
        const userId = req.user?.UserId;
        
        if (!userId) {
            return res.status(401).json({ 
                success: false, 
                message: 'User not authenticated or user ID is missing.' 
            });
        }
        
        console.log('🔍 POST /api/me/agent/enrollment-link-templates/:templateId/duplicate - Request received');
        console.log('📋 Template ID to duplicate:', templateId);
        
        const pool = await getPool();
        
        // Get the AgentId and TenantId from the oe.Agents table
        const agentRequest = pool.request();
        agentRequest.input('userId', sql.UniqueIdentifier, userId);
        const agentResult = await agentRequest.query('SELECT AgentId, TenantId FROM oe.Agents WHERE UserId = @userId');
        
        if (agentResult.recordset.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Agent profile not found for authenticated user.' 
            });
        }
        
        const currentUserAgentId = agentResult.recordset[0].AgentId;
        const tenantId = agentResult.recordset[0].TenantId;
        const { isAgencyOwner: isAgencyOwnerDup } = await resolveEffectiveAgencyOwner(pool, req, userId);
        
        // Get the original template (self or downline for AgencyOwner)
        let templateResult;
        if (isAgencyOwnerDup) {
            const getTemplateRequest = pool.request();
            getTemplateRequest.input('templateId', sql.UniqueIdentifier, templateId);
            getTemplateRequest.input('userId', sql.UniqueIdentifier, userId);
            templateResult = await getTemplateRequest.query(`
                ${DOWNLINE_CTE}
                SELECT elt.TemplateId, elt.TemplateName, elt.TemplateType, elt.GroupId, elt.LinkMetaData, elt.Description, elt.IsActive, elt.AgentId, elt.TenantId
                FROM oe.EnrollmentLinkTemplates elt
                WHERE elt.TemplateId = @templateId
                  AND (elt.AgentId IN (SELECT AgentId FROM Downline) OR elt.AgencyId IN (SELECT AgentId FROM Downline))
            `);
        } else {
            const getTemplateRequest = pool.request();
            getTemplateRequest.input('templateId', sql.UniqueIdentifier, templateId);
            getTemplateRequest.input('agentId', sql.UniqueIdentifier, currentUserAgentId);
            getTemplateRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
            templateResult = await getTemplateRequest.query(`
                SELECT TemplateId, TemplateName, TemplateType, GroupId, LinkMetaData, Description, IsActive, AgentId, TenantId
                FROM oe.EnrollmentLinkTemplates
                WHERE TemplateId = @templateId
                  AND (AgentId = @agentId OR AgencyId = @agentId)
                  AND TenantId = @tenantId
            `);
        }
        
        if (templateResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Template not found or you do not have permission to duplicate it.'
            });
        }
        
        const originalTemplate = templateResult.recordset[0];
        const agentIdForDuplicate = originalTemplate.AgentId || currentUserAgentId;
        const tenantIdForDuplicate = originalTemplate.TenantId || tenantId;
        
        // Generate new template name with " (Copy)" suffix
        let newTemplateName = originalTemplate.TemplateName + ' (Copy)';
        
        // Check if a template with this name already exists, if so, append number
        let counter = 2;
        let checkNameRequest = pool.request();
        checkNameRequest.input('templateName', sql.NVarChar, newTemplateName);
        checkNameRequest.input('agentId', sql.UniqueIdentifier, agentIdForDuplicate);
        let nameCheckResult = await checkNameRequest.query(`
            SELECT COUNT(*) as count FROM oe.EnrollmentLinkTemplates
            WHERE TemplateName = @templateName AND AgentId = @agentId
        `);
        
        while (nameCheckResult.recordset[0].count > 0) {
            newTemplateName = originalTemplate.TemplateName + ` (Copy ${counter})`;
            counter++;
            checkNameRequest = pool.request();
            checkNameRequest.input('templateName', sql.NVarChar, newTemplateName);
            checkNameRequest.input('agentId', sql.UniqueIdentifier, agentId);
            nameCheckResult = await checkNameRequest.query(`
                SELECT COUNT(*) as count FROM oe.EnrollmentLinkTemplates
                WHERE TemplateName = @templateName AND (AgentId = @agentId OR AgencyId = @agentId)
            `);
        }
        
        // Generate new TemplateId
        const newTemplateId = require('crypto').randomUUID();
        
        // Create the duplicated template
        const createRequest = pool.request();
        createRequest.input('templateId', sql.UniqueIdentifier, newTemplateId);
        createRequest.input('templateName', sql.NVarChar, newTemplateName);
        createRequest.input('templateType', sql.NVarChar, originalTemplate.TemplateType);
        createRequest.input('groupId', sql.UniqueIdentifier, originalTemplate.GroupId);
        createRequest.input('agentId', sql.UniqueIdentifier, agentIdForDuplicate);
        createRequest.input('tenantId', sql.UniqueIdentifier, tenantIdForDuplicate);
        createRequest.input('linkMetaData', sql.NVarChar, originalTemplate.LinkMetaData);
        createRequest.input('description', sql.NVarChar, originalTemplate.Description);
        createRequest.input('isActive', sql.Bit, originalTemplate.IsActive !== false ? 1 : 0);
        createRequest.input('createdBy', sql.UniqueIdentifier, userId);
        createRequest.input('modifiedBy', sql.UniqueIdentifier, userId);
        
        const createQuery = `
            INSERT INTO oe.EnrollmentLinkTemplates (
                TemplateId, TemplateName, TemplateType, GroupId, AgentId, TenantId, 
                LinkMetaData, Description, IsActive, CreatedBy, ModifiedBy,
                CreatedDate, ModifiedDate
            ) VALUES (
                @templateId, @templateName, @templateType, @groupId, @agentId, @tenantId,
                @linkMetaData, @description, @isActive, @createdBy, @modifiedBy,
                GETUTCDATE(), GETUTCDATE()
            )
        `;
        
        await createRequest.query(createQuery);
        
        console.log('✅ Duplicated enrollment link template:', { original: originalTemplate.TemplateName, new: newTemplateName });
        
        res.status(201).json({
            success: true,
            data: { 
                templateId: newTemplateId,
                templateName: newTemplateName
            },
            message: 'Enrollment link template duplicated successfully'
        });
        
    } catch (error) {
        console.error('❌ Error duplicating enrollment link template:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while duplicating enrollment link template',
            error: {
                message: error.message,
                code: 'AGENT_DUPLICATE_TEMPLATE_ERROR'
            }
        });
    }
});

/**
 * @route   PUT /api/me/agent/enrollment-link-templates/:templateId
 * @desc    Update an enrollment link template (agent). AgencyOwner can update templates for self or downline.
 * @access  Private (Agent, AgencyOwner)
 */
router.put('/:templateId', authorize(['Agent', 'AgencyOwner']), async (req, res) => {
    try {
        const { templateId } = req.params;
        const { templateName, templateType, linkMetaData, description, isActive } = req.body;
        const userId = req.user?.UserId;
        
        if (!userId) {
            return res.status(401).json({ 
                success: false, 
                message: 'User not authenticated or user ID is missing.' 
            });
        }
        
        console.log('🔍 PUT /api/me/agent/enrollment-link-templates/:templateId - Request received');
        console.log('📋 Template ID:', templateId);
        console.log('📋 Update data:', { templateName, templateType, isActive });
        
        const pool = await getPool();
        
        const agentRequest = pool.request();
        agentRequest.input('userId', sql.UniqueIdentifier, userId);
        const agentResult = await agentRequest.query('SELECT AgentId FROM oe.Agents WHERE UserId = @userId');
        
        if (agentResult.recordset.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Agent profile not found for authenticated user.' 
            });
        }
        
        const currentUserAgentId = agentResult.recordset[0].AgentId;
        const { isAgencyOwner: isAgencyOwnerPut } = await resolveEffectiveAgencyOwner(pool, req, userId);
        
        // Verify template exists and belongs to this agent (or downline for AgencyOwner)
        let verifyResult;
        if (isAgencyOwnerPut) {
            const verifyRequest = pool.request();
            verifyRequest.input('templateId', sql.UniqueIdentifier, templateId);
            verifyRequest.input('userId', sql.UniqueIdentifier, userId);
            verifyResult = await verifyRequest.query(`
                ${DOWNLINE_CTE}
                SELECT elt.TemplateId, elt.TemplateName FROM oe.EnrollmentLinkTemplates elt
                WHERE elt.TemplateId = @templateId
                  AND (elt.AgentId IN (SELECT AgentId FROM Downline) OR elt.AgencyId IN (SELECT AgentId FROM Downline))
            `);
        } else {
            const verifyRequest = pool.request();
            verifyRequest.input('templateId', sql.UniqueIdentifier, templateId);
            verifyRequest.input('agentId', sql.UniqueIdentifier, currentUserAgentId);
            verifyResult = await verifyRequest.query(`
                SELECT TemplateId, TemplateName FROM oe.EnrollmentLinkTemplates 
                WHERE TemplateId = @templateId AND (AgentId = @agentId OR AgencyId = @agentId)
            `);
        }
        
        if (verifyResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Template not found or access denied.'
            });
        }
        
        // Build update query dynamically (update by templateId only; ownership already verified)
        const updates = [];
        const request = pool.request();
        request.input('templateId', sql.UniqueIdentifier, templateId);
        request.input('modifiedBy', sql.UniqueIdentifier, userId);
        
        if (templateName !== undefined) {
            updates.push('TemplateName = @templateName');
            request.input('templateName', sql.NVarChar, templateName);
        }
        if (templateType !== undefined) {
            updates.push('TemplateType = @templateType');
            request.input('templateType', sql.NVarChar, templateType);
        }
        if (linkMetaData !== undefined) {
            updates.push('LinkMetaData = @linkMetaData');
            request.input('linkMetaData', sql.NVarChar, typeof linkMetaData === 'string' ? linkMetaData : JSON.stringify(linkMetaData));
        }
        if (description !== undefined) {
            updates.push('Description = @description');
            request.input('description', sql.NVarChar, description);
        }
        if (isActive !== undefined) {
            updates.push('IsActive = @isActive');
            request.input('isActive', sql.Bit, isActive);
        }
        
        if (updates.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No valid fields provided for update.'
            });
        }
        
        updates.push('ModifiedBy = @modifiedBy');
        updates.push('ModifiedDate = GETUTCDATE()');
        
        const updateQuery = `
            UPDATE oe.EnrollmentLinkTemplates 
            SET ${updates.join(', ')}
            WHERE TemplateId = @templateId
        `;
        
        await request.query(updateQuery);
        
        const templateName_display = verifyResult.recordset[0].TemplateName;
        console.log('✅ Updated enrollment link template:', templateName_display);
        
        res.json({
            success: true,
            message: 'Enrollment link template updated successfully'
        });
        
    } catch (error) {
        console.error('❌ Error updating enrollment link template:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while updating enrollment link template',
            error: {
                message: error.message,
                code: 'AGENT_UPDATE_ENROLLMENT_TEMPLATE_ERROR'
            }
        });
    }
});

/**
 * @route   DELETE /api/me/agent/enrollment-link-templates/:templateId
 * @desc    Delete an enrollment link template (agent). AgencyOwner can delete templates for self or downline.
 * @access  Private (Agent, AgencyOwner)
 */
router.delete('/:templateId', authorize(['Agent', 'AgencyOwner']), async (req, res) => {
    try {
        const { templateId } = req.params;
        const userId = req.user?.UserId;
        
        if (!userId) {
            return res.status(401).json({ 
                success: false, 
                message: 'User not authenticated or user ID is missing.' 
            });
        }
        
        console.log('🔍 DELETE /api/me/agent/enrollment-link-templates/:templateId - Request received');
        console.log('📋 Template ID:', templateId);
        console.log('👤 User ID:', userId);
        
        const pool = await getPool();
        
        const agentRequest = pool.request();
        agentRequest.input('userId', sql.UniqueIdentifier, userId);
        const agentResult = await agentRequest.query('SELECT AgentId FROM oe.Agents WHERE UserId = @userId');
        
        if (agentResult.recordset.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Agent profile not found for authenticated user.' 
            });
        }
        
        const currentUserAgentId = agentResult.recordset[0].AgentId;
        const { isAgencyOwner: isAgencyOwnerDel } = await resolveEffectiveAgencyOwner(pool, req, userId);
        
        // Verify template exists and get its name for logging (self or downline for AgencyOwner)
        let verifyResult;
        if (isAgencyOwnerDel) {
            const verifyRequest = pool.request();
            verifyRequest.input('templateId', sql.UniqueIdentifier, templateId);
            verifyRequest.input('userId', sql.UniqueIdentifier, userId);
            verifyResult = await verifyRequest.query(`
                ${DOWNLINE_CTE}
                SELECT TemplateName FROM oe.EnrollmentLinkTemplates elt
                WHERE elt.TemplateId = @templateId
                  AND (elt.AgentId IN (SELECT AgentId FROM Downline) OR elt.AgencyId IN (SELECT AgentId FROM Downline))
            `);
        } else {
            const verifyRequest = pool.request();
            verifyRequest.input('templateId', sql.UniqueIdentifier, templateId);
            verifyRequest.input('agentId', sql.UniqueIdentifier, currentUserAgentId);
            verifyResult = await verifyRequest.query(`
                SELECT TemplateName FROM oe.EnrollmentLinkTemplates 
                WHERE TemplateId = @templateId AND (AgentId = @agentId OR AgencyId = @agentId)
            `);
        }
        console.log('📊 DELETE Verification result:', verifyResult.recordset);
        
        if (verifyResult.recordset.length === 0) {
            console.log('❌ Template not found or access denied for deletion');
            return res.status(404).json({
                success: false,
                message: 'Template not found or access denied.'
            });
        }
        
        const templateName = verifyResult.recordset[0].TemplateName;
        
        // Check if template has any enrollment links (for logging purposes)
        const checkLinksRequest = pool.request();
        checkLinksRequest.input('templateId', sql.UniqueIdentifier, templateId);
        
        const checkLinksQuery = `
            SELECT COUNT(*) as LinkCount
            FROM oe.EnrollmentLinks
            WHERE EnrollmentLinkTemplateId = @templateId
        `;
        
        const linkCheckResult = await checkLinksRequest.query(checkLinksQuery);
        const linkCount = linkCheckResult.recordset[0].LinkCount;
        
        if (linkCount > 0) {
            console.log(`⚠️  Template has ${linkCount} enrollment links - will delete them first`);
            
            // CASCADE DELETE: First delete all enrollment links using this template
            const deleteLinksRequest = pool.request();
            deleteLinksRequest.input('templateId', sql.UniqueIdentifier, templateId);
            
            const deleteLinksQuery = `
                DELETE FROM oe.EnrollmentLinks
                WHERE EnrollmentLinkTemplateId = @templateId
            `;
            
            const deletedLinksResult = await deleteLinksRequest.query(deleteLinksQuery);
            console.log(`✅ Deleted ${deletedLinksResult.rowsAffected[0]} enrollment links`);
        }
        
        // Hard delete the template (permanent removal from database)
        const deleteRequest = pool.request();
        deleteRequest.input('templateId', sql.UniqueIdentifier, templateId);
        
        const deleteQuery = `
            DELETE FROM oe.EnrollmentLinkTemplates
            WHERE TemplateId = @templateId
        `;
        
        await deleteRequest.query(deleteQuery);
        
        console.log('✅ Permanently deleted enrollment link template:', templateName);
        
        const message = linkCount > 0 
            ? `Enrollment link template and ${linkCount} associated enrollment link${linkCount > 1 ? 's' : ''} deleted successfully`
            : 'Enrollment link template deleted successfully';
        
        res.json({
            success: true,
            message: message,
            deletedLinksCount: linkCount
        });
        
    } catch (error) {
        console.error('❌ Error deleting enrollment link template:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while deleting enrollment link template',
            error: {
                message: error.message,
                code: 'AGENT_DELETE_ENROLLMENT_TEMPLATE_ERROR'
            }
        });
    }
});

module.exports = router;