const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authorize } = require('../../../middleware/auth');

/**
 * @route   GET /api/me/sysadmin/enrollment-link-templates
 * @desc    Get all enrollment link templates (sysadmin can see all)
 * @access  Private (SysAdmin)
 */
router.get('/', authorize(['SysAdmin']), async (req, res) => {
    try {
        const userId = req.user?.UserId;
        
        if (!userId) {
            return res.status(401).json({ 
                success: false, 
                message: 'User not authenticated.' 
            });
        }
        
        console.log('🔍 GET /api/me/sysadmin/enrollment-link-templates - Request received');
        console.log('👤 SysAdmin User:', { 
            userId: userId,
            roles: req.user?.roles,
            email: req.user?.Email
        });
        
        // Extract pagination and filtering parameters
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const search = req.query.search || '';
        const templateType = req.query.templateType || '';
        const isActive = req.query.isActive;
        const tenantId = req.query.tenantId; // SysAdmin can filter by tenant
        const groupId = req.query.groupId || ''; // Look up AgentId from oe.Groups
        const agentId = req.query.agentId || ''; // Direct agentId for individual members
        const excludeHasMarketingLink = req.query.excludeHasMarketingLink === '1' || req.query.excludeHasMarketingLink === 'true';
        const hasMarketingLink = req.query.hasMarketingLink === '1' || req.query.hasMarketingLink === 'true';
        
        const offset = (page - 1) * limit;
        
        console.log('📊 Query parameters:', { page, limit, search, templateType, isActive, tenantId, groupId, agentId, offset });
        
        const pool = await getPool();
        
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
        
        // Build the WHERE clause - SysAdmin can see all templates
        let whereConditions = ['1=1']; // Always true condition for SysAdmin
        const request = pool.request();
        request.input('limit', sql.Int, limit);
        request.input('offset', sql.Int, offset);
        
        if (search) {
            whereConditions.push('(elt.TemplateName LIKE @search OR elt.Description LIKE @search)');
            request.input('search', sql.NVarChar, `%${search}%`);
        }
        
        if (templateType) {
            whereConditions.push('elt.TemplateType = @templateType');
            request.input('templateType', sql.NVarChar, templateType);
        }
        
        if (isActive !== undefined) {
            const activeValue = isActive === 'true' || isActive === true;
            whereConditions.push('elt.IsActive = @isActive');
            request.input('isActive', sql.Bit, activeValue);
        }
        
        if (tenantId) {
            whereConditions.push('elt.TenantId = @tenantId');
            request.input('tenantId', sql.UniqueIdentifier, tenantId);
        }
        
        // Filter by agent - either from group lookup or direct agentId parameter
        const finalAgentId = agentIdFromGroup || agentId;
        if (finalAgentId) {
            whereConditions.push('(elt.AgentId = @agentId OR elt.AgencyId = @agentId)');
            request.input('agentId', sql.UniqueIdentifier, finalAgentId);
            console.log(`🎯 Filtering templates by AgentId/AgencyId: ${finalAgentId} (${agentIdFromGroup ? 'from group' : 'direct parameter'})`);
        }
        // When groupId is provided, only return Group-type templates linked to this group
        if (groupId) {
            whereConditions.push('elt.TemplateType = \'Group\' AND elt.GroupId = @groupId');
            request.input('groupId', sql.UniqueIdentifier, groupId);
        }
        if (excludeHasMarketingLink) {
            whereConditions.push("NOT EXISTS (SELECT 1 FROM oe.EnrollmentLinks el WHERE el.EnrollmentLinkTemplateId = elt.TemplateId AND el.LinkType = 'Marketing' AND el.IsActive = 1)");
        }
        if (hasMarketingLink) {
            whereConditions.push("EXISTS (SELECT 1 FROM oe.EnrollmentLinks el WHERE el.EnrollmentLinkTemplateId = elt.TemplateId AND el.LinkType = 'Marketing' AND el.IsActive = 1)");
        }
        
        const whereClause = whereConditions.join(' AND ');
        
        // Get paginated results
        const dataQuery = `
            SELECT 
                elt.TemplateId,
                elt.TemplateName,
                elt.TemplateType,
                elt.TenantId,
                elt.AgentId,
                elt.AgencyId,
                elt.GroupId,
                elt.LinkMetaData,
                elt.IsActive,
                elt.Description,
                elt.CreatedDate,
                elt.ModifiedDate,
                elt.CreatedBy,
                elt.ModifiedBy,
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
                ISNULL(t.Name, 'Unknown Tenant') as TenantName,
                CASE 
                    WHEN elt.AgentId IS NOT NULL THEN CONCAT(ISNULL(u.FirstName, ''), ' ', ISNULL(u.LastName, ''))
                    WHEN elt.AgencyId IS NOT NULL THEN ag.AgencyName
                    ELSE NULL
                END as AgentName,
                g.Name AS GroupName
            FROM oe.EnrollmentLinkTemplates elt
            LEFT JOIN oe.Tenants t ON elt.TenantId = t.TenantId
            LEFT JOIN oe.Agents a ON elt.AgentId = a.AgentId
            LEFT JOIN oe.Users u ON a.UserId = u.UserId
            LEFT JOIN oe.Agencies ag ON elt.AgencyId = ag.AgencyId
            LEFT JOIN oe.Groups g ON elt.GroupId = g.GroupId
            WHERE ${whereClause}
            ORDER BY elt.ModifiedDate DESC
            OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
        `;
        
        console.log('🔎 Data query:', dataQuery);
        const dataResult = await request.query(dataQuery);
        
        // Get total count for pagination
        const countQuery = `
            SELECT COUNT(*) as TotalCount
            FROM oe.EnrollmentLinkTemplates elt
            WHERE ${whereClause}
        `;
        
        const countResult = await request.query(countQuery);
        const totalCount = countResult.recordset[0].TotalCount;
        const totalPages = Math.ceil(totalCount / limit);
        
        console.log('📊 Found templates:', {
            count: dataResult.recordset.length,
            totalCount: totalCount,
            totalPages: totalPages,
            currentPage: page
        });
        
        res.json({
            success: true,
            data: {
                data: dataResult.recordset,
                pagination: {
                    currentPage: page,
                    totalPages: totalPages,
                    totalItems: totalCount,
                    itemsPerPage: limit,
                    hasNextPage: page < totalPages,
                    hasPrevPage: page > 1
                }
            }
        });
        
    } catch (error) {
        console.error('❌ Error fetching sysadmin enrollment link templates:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching enrollment link templates'
        });
    }
});

/**
 * @route   POST /api/me/sysadmin/enrollment-link-templates/sync-group-products
 * @desc    Update all enrollment link templates for a group to use the given product set
 * @access  Private (SysAdmin)
 */
router.post('/sync-group-products', authorize(['SysAdmin']), async (req, res) => {
    try {
        const { groupId, productIds } = req.body;
        const userId = req.user?.UserId;
        const pool = await getPool();
        if (!userId || !groupId || !Array.isArray(productIds)) {
            return res.status(400).json({ success: false, message: 'groupId and productIds (array) are required.' });
        }
        const groupRow = (await pool.request().input('groupId', sql.UniqueIdentifier, groupId).query('SELECT GroupId, TenantId FROM oe.Groups WHERE GroupId = @groupId')).recordset[0];
        if (!groupRow) return res.status(404).json({ success: false, message: 'Group not found.' });
        const tenantId = groupRow.TenantId;
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
            SELECT TemplateId, LinkMetaData FROM oe.EnrollmentLinkTemplates WHERE GroupId = @groupId AND TenantId = @tenantId
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
        console.error('❌ Error syncing group products (sysadmin):', error);
        res.status(500).json({ success: false, message: 'Server error while syncing enrollment link templates.' });
    }
});

/**
 * @route   GET /api/me/sysadmin/enrollment-link-templates/:templateId
 * @desc    Get a specific enrollment link template by ID (sysadmin access - any template)
 * @access  Private (SysAdmin)
 */
router.get('/:templateId', authorize(['SysAdmin']), async (req, res) => {
    try {
        const { templateId } = req.params;
        
        console.log('🔍 GET /api/me/sysadmin/enrollment-link-templates/:templateId - Request received');
        console.log('📋 Template ID:', templateId);
        
        const pool = await getPool();
        const request = pool.request();
        request.input('templateId', sql.UniqueIdentifier, templateId);
        
        const query = `
            SELECT 
                elt.TemplateId,
                elt.TemplateName,
                elt.TemplateType,
                elt.TenantId,
                elt.AgentId,
                elt.LinkMetaData,
                elt.IsActive,
                elt.Description,
                elt.CreatedDate,
                elt.ModifiedDate,
                elt.CreatedBy,
                elt.ModifiedBy,
                ISNULL(t.Name, 'Unknown Tenant') as TenantName,
                CONCAT(ISNULL(a.FirstName, ''), ' ', ISNULL(a.LastName, '')) as AgentName
            FROM oe.EnrollmentLinkTemplates elt
            LEFT JOIN oe.Tenants t ON elt.TenantId = t.TenantId
            LEFT JOIN oe.Agents a ON elt.AgentId = a.AgentId
            WHERE elt.TemplateId = @templateId
        `;
        
        const result = await request.query(query);
        
        if (result.recordset.length === 0) {
            console.log('❌ Template not found');
            return res.status(404).json({
                success: false,
                message: 'Template not found.'
            });
        }
        
        console.log('✅ Template found');
        res.json({
            success: true,
            data: result.recordset[0]
        });
        
    } catch (error) {
        console.error('❌ Error fetching enrollment link template:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching enrollment link template'
        });
    }
});

/**
 * @route   POST /api/me/sysadmin/enrollment-link-templates
 * @desc    Create a new enrollment link template (sysadmin)
 * @access  Private (SysAdmin)
 */
router.post('/', authorize(['SysAdmin']), async (req, res) => {
    try {
        const { templateName, templateType, tenantId, agentId, linkMetaData, description, isActive = true } = req.body;
        const userId = req.user?.UserId;
        
        if (!userId) {
            return res.status(401).json({ 
                success: false, 
                message: 'User not authenticated.' 
            });
        }
        
        if (!templateName || !templateType || !tenantId || !agentId) {
            return res.status(400).json({
                success: false,
                message: 'Template name, template type, tenant ID, and agent/agency ID are required.'
            });
        }
        
        console.log('🔍 POST /api/me/sysadmin/enrollment-link-templates - Request received');
        console.log('📋 Template data:', { templateName, templateType, tenantId, agentId, isActive });
        
        const pool = await getPool();
        
        // Verify that the agent or agency belongs to the specified tenant
        const agentVerifyRequest = pool.request();
        agentVerifyRequest.input('agentId', sql.UniqueIdentifier, agentId);
        agentVerifyRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
        
        // Check both Agents and Agencies tables to determine type
        const agentVerifyQuery = `
            SELECT 'Agent' as Type FROM oe.Agents 
            WHERE AgentId = @agentId AND TenantId = @tenantId
            UNION
            SELECT 'Agency' as Type FROM oe.Agencies 
            WHERE AgencyId = @agentId AND TenantId = @tenantId
        `;
        
        const agentVerifyResult = await agentVerifyRequest.query(agentVerifyQuery);
        
        if (agentVerifyResult.recordset.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Selected agent or agency does not belong to the specified tenant.'
            });
        }
        
        const assigneeType = agentVerifyResult.recordset[0].Type; // 'Agent' or 'Agency'
        console.log('✅ Verified assignee type:', assigneeType);
        
        // Generate a new TemplateId
        const templateId = require('crypto').randomUUID();
        
        const request = pool.request();
        request.input('templateId', sql.UniqueIdentifier, templateId);
        request.input('templateName', sql.NVarChar, templateName);
        request.input('templateType', sql.NVarChar, templateType);
        request.input('tenantId', sql.UniqueIdentifier, tenantId);
        request.input('linkMetaData', sql.NVarChar, linkMetaData || '{}');
        request.input('isActive', sql.Bit, isActive);
        request.input('description', sql.NVarChar, description || '');
        request.input('createdBy', sql.UniqueIdentifier, userId);
        request.input('modifiedBy', sql.UniqueIdentifier, userId);
        
        // Determine which column to populate based on assignee type
        let insertQuery;
        if (assigneeType === 'Agent') {
            request.input('agentId', sql.UniqueIdentifier, agentId);
            insertQuery = `
                INSERT INTO oe.EnrollmentLinkTemplates (
                    TemplateId, TemplateName, TemplateType, TenantId, AgentId, AgencyId,
                    LinkMetaData, IsActive, Description, CreatedBy, ModifiedBy
                ) VALUES (
                    @templateId, @templateName, @templateType, @tenantId, @agentId, NULL,
                    @linkMetaData, @isActive, @description, @createdBy, @modifiedBy
                )
            `;
        } else {
            request.input('agencyId', sql.UniqueIdentifier, agentId); // agentId parameter contains AgencyId
            insertQuery = `
                INSERT INTO oe.EnrollmentLinkTemplates (
                    TemplateId, TemplateName, TemplateType, TenantId, AgentId, AgencyId,
                    LinkMetaData, IsActive, Description, CreatedBy, ModifiedBy
                ) VALUES (
                    @templateId, @templateName, @templateType, @tenantId, NULL, @agencyId,
                    @linkMetaData, @isActive, @description, @createdBy, @modifiedBy
                )
            `;
        }
        
        await request.query(insertQuery);
        
        console.log('✅ Created enrollment link template:', templateName);
        
        res.status(201).json({
            success: true,
            data: {
                templateId: templateId,
                templateName: templateName,
                templateType: templateType,
                tenantId: tenantId,
                agentId: agentId,
                isActive: isActive,
                description: description
            },
            message: 'Enrollment link template created successfully'
        });
        
    } catch (error) {
        console.error('❌ Error creating enrollment link template:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while creating enrollment link template'
        });
    }
});

/**
 * @route   POST /api/me/sysadmin/enrollment-link-templates/:templateId/duplicate
 * @desc    Duplicate an enrollment link template with new IDs
 * @access  Private (SysAdmin)
 */
router.post('/:templateId/duplicate', authorize(['SysAdmin']), async (req, res) => {
    try {
        const { templateId } = req.params;
        const userId = req.user?.UserId;
        
        if (!userId) {
            return res.status(401).json({ 
                success: false, 
                message: 'User not authenticated.' 
            });
        }
        
        console.log('🔍 POST /api/me/sysadmin/enrollment-link-templates/:templateId/duplicate - Request received');
        console.log('📋 Template ID to duplicate:', templateId);
        
        const pool = await getPool();
        
        // Get the original template (SysAdmin can duplicate any template)
        const getTemplateRequest = pool.request();
        getTemplateRequest.input('templateId', sql.UniqueIdentifier, templateId);
        
        const templateResult = await getTemplateRequest.query(`
            SELECT TemplateId, TemplateName, TemplateType, GroupId, AgentId, TenantId, LinkMetaData, Description, IsActive
            FROM oe.EnrollmentLinkTemplates
            WHERE TemplateId = @templateId
        `);
        
        if (templateResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Template not found.'
            });
        }
        
        const originalTemplate = templateResult.recordset[0];
        
        // Generate new template name with " (Copy)" suffix
        let newTemplateName = originalTemplate.TemplateName + ' (Copy)';
        
        // Check if a template with this name already exists for this agent, if so, append number
        let counter = 2;
        let checkNameRequest = pool.request();
        checkNameRequest.input('templateName', sql.NVarChar, newTemplateName);
        checkNameRequest.input('agentId', sql.UniqueIdentifier, originalTemplate.AgentId);
        let nameCheckResult = await checkNameRequest.query(`
            SELECT COUNT(*) as count FROM oe.EnrollmentLinkTemplates
            WHERE TemplateName = @templateName AND AgentId = @agentId
        `);
        
        while (nameCheckResult.recordset[0].count > 0) {
            newTemplateName = originalTemplate.TemplateName + ` (Copy ${counter})`;
            counter++;
            checkNameRequest = pool.request();
            checkNameRequest.input('templateName', sql.NVarChar, newTemplateName);
            checkNameRequest.input('agentId', sql.UniqueIdentifier, originalTemplate.AgentId);
            nameCheckResult = await checkNameRequest.query(`
                SELECT COUNT(*) as count FROM oe.EnrollmentLinkTemplates
                WHERE TemplateName = @templateName AND AgentId = @agentId
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
        createRequest.input('agentId', sql.UniqueIdentifier, originalTemplate.AgentId);
        createRequest.input('tenantId', sql.UniqueIdentifier, originalTemplate.TenantId);
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
                code: 'SYSADMIN_DUPLICATE_TEMPLATE_ERROR'
            }
        });
    }
});

/**
 * @route   PUT /api/me/sysadmin/enrollment-link-templates/:templateId
 * @desc    Update an enrollment link template (sysadmin - any template)
 * @access  Private (SysAdmin)
 */
router.put('/:templateId', authorize(['SysAdmin']), async (req, res) => {
    try {
        const { templateId } = req.params;
        const { templateName, templateType, tenantId, agentId, linkMetaData, description, isActive } = req.body;
        const userId = req.user?.UserId;
        
        if (!userId) {
            return res.status(401).json({ 
                success: false, 
                message: 'User not authenticated.' 
            });
        }
        
        console.log('🔍 PUT /api/me/sysadmin/enrollment-link-templates/:templateId - Request received');
        console.log('📋 Template ID:', templateId);
        console.log('📋 Update data:', { templateName, templateType, tenantId, agentId, isActive });
        
        const pool = await getPool();
        
        // Verify template exists
        const verifyRequest = pool.request();
        verifyRequest.input('templateId', sql.UniqueIdentifier, templateId);
        
        const verifyQuery = `
            SELECT TemplateId, TemplateName FROM oe.EnrollmentLinkTemplates 
            WHERE TemplateId = @templateId
        `;
        
        const verifyResult = await verifyRequest.query(verifyQuery);
        
        if (verifyResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Template not found.'
            });
        }
        
        // If agentId and tenantId are provided, verify they match
        if (agentId && tenantId) {
            const agentVerifyRequest = pool.request();
            agentVerifyRequest.input('agentId', sql.UniqueIdentifier, agentId);
            agentVerifyRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
            
            // Check both Agents and Agencies tables
            const agentVerifyQuery = `
                SELECT 'Agent' as Type FROM oe.Agents 
                WHERE AgentId = @agentId AND TenantId = @tenantId
                UNION
                SELECT 'Agency' as Type FROM oe.Agencies 
                WHERE AgencyId = @agentId AND TenantId = @tenantId
            `;
            
            const agentVerifyResult = await agentVerifyRequest.query(agentVerifyQuery);
            
            if (agentVerifyResult.recordset.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Selected agent or agency does not belong to the specified tenant.'
                });
            }
        }
        
        // Build dynamic update query
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
        if (tenantId !== undefined) {
            updates.push('TenantId = @tenantId');
            request.input('tenantId', sql.UniqueIdentifier, tenantId);
        }
        if (agentId !== undefined) {
            // Determine if it's an Agent or Agency and update accordingly
            const typeCheckRequest = pool.request();
            typeCheckRequest.input('assigneeId', sql.UniqueIdentifier, agentId);
            typeCheckRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
            
            const typeCheckResult = await typeCheckRequest.query(`
                SELECT 'Agent' as Type FROM oe.Agents WHERE AgentId = @assigneeId AND TenantId = @tenantId
                UNION
                SELECT 'Agency' as Type FROM oe.Agencies WHERE AgencyId = @assigneeId AND TenantId = @tenantId
            `);
            
            if (typeCheckResult.recordset.length > 0) {
                const updateAssigneeType = typeCheckResult.recordset[0].Type;
                if (updateAssigneeType === 'Agent') {
                    updates.push('AgentId = @agentId, AgencyId = NULL');
                    request.input('agentId', sql.UniqueIdentifier, agentId);
                } else {
                    updates.push('AgentId = NULL, AgencyId = @agencyId');
                    request.input('agencyId', sql.UniqueIdentifier, agentId);
                }
            }
        }
        if (linkMetaData !== undefined) {
            updates.push('LinkMetaData = @linkMetaData');
            request.input('linkMetaData', sql.NVarChar, linkMetaData);
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
            message: 'Server error while updating enrollment link template'
        });
    }
});

/**
 * @route   DELETE /api/me/sysadmin/enrollment-link-templates/:templateId
 * @desc    Delete an enrollment link template (sysadmin - any template)
 * @access  Private (SysAdmin)
 */
router.delete('/:templateId', authorize(['SysAdmin']), async (req, res) => {
    try {
        const { templateId } = req.params;
        
        console.log('🔍 DELETE /api/me/sysadmin/enrollment-link-templates/:templateId - Request received');
        console.log('📋 Template ID:', templateId);
        
        const pool = await getPool();
        
        // Verify template exists and get its name for logging
        const verifyRequest = pool.request();
        verifyRequest.input('templateId', sql.UniqueIdentifier, templateId);
        
        const verifyQuery = `
            SELECT TemplateName FROM oe.EnrollmentLinkTemplates 
            WHERE TemplateId = @templateId
        `;
        
        const verifyResult = await verifyRequest.query(verifyQuery);
        console.log('📊 DELETE Verification result:', verifyResult.recordset);
        
        if (verifyResult.recordset.length === 0) {
            console.log('❌ Template not found for deletion');
            return res.status(404).json({
                success: false,
                message: 'Template not found.'
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
            message: 'Server error while deleting enrollment link template'
        });
    }
});

/**
 * @route   GET /api/me/sysadmin/enrollment-link-templates/dropdown-data/tenants
 * @desc    Get tenants for dropdown (sysadmin only)
 * @access  Private (SysAdmin)
 */
router.get('/dropdown-data/tenants', authorize(['SysAdmin']), async (req, res) => {
    try {
        console.log('🔍 GET /api/me/sysadmin/enrollment-link-templates/dropdown-data/tenants');
        
        const pool = await getPool();
        const request = pool.request();
        
        const query = `
            SELECT 
                TenantId,
                Name as TenantName,
                Status,
                CASE WHEN Status = 'Active' THEN 1 ELSE 0 END as IsActive
            FROM oe.Tenants
            WHERE Status = 'Active'
            ORDER BY Name
        `;
        
        const result = await request.query(query);
        
        console.log('✅ Found tenants for dropdown:', result.recordset.length);
        
        res.json({
            success: true,
            data: result.recordset
        });
        
    } catch (error) {
        console.error('❌ Error fetching tenants for dropdown:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching tenants'
        });
    }
});

/**
 * @route   GET /api/me/sysadmin/enrollment-link-templates/dropdown-data/agents
 * @desc    Get agents for a given tenant (sysadmin only) with optional search
 * @access  Private (SysAdmin)
 * Query:
 *  - tenantId: required (GUID)
 *  - search: optional (string)
 */
router.get('/dropdown-data/agents', authorize(['SysAdmin']), async (req, res) => {
    try {
        const { tenantId, search = '' } = req.query;

        if (!tenantId) {
            return res.status(400).json({
                success: false,
                message: 'tenantId is required'
            });
        }

        const pool = await getPool();
        const request = pool.request();
        request.input('tenantId', sql.UniqueIdentifier, tenantId);

        let whereConditions = [
            'a.TenantId = @tenantId',
            "a.Status = 'Active'",
            "u.Status = 'Active'"
        ];

        // Build search conditions for both agents and agencies
        let searchConditions = [];
        if (search && String(search).trim().length > 0) {
            request.input('search', sql.NVarChar, `%${search}%`);
            searchConditions = [
                "(ISNULL(u.FirstName,'') + ' ' + ISNULL(u.LastName,'')) LIKE @search",
                "u.Email LIKE @search",
                "ISNULL(a.NPN, '') LIKE @search",
                "ag.AgencyName LIKE @search"
            ];
        }

        const whereClause = whereConditions.join(' AND ');
        const searchClause = searchConditions.length > 0 ? `AND (${searchConditions.join(' OR ')})` : '';

        // UNION query to get both agents and agencies
        const query = `
            -- Get Agents
            SELECT 
                a.AgentId as Id,
                'Agent' as Type,
                a.TenantId,
                a.AgencyId,
                ISNULL(u.FirstName, '') + ' ' + ISNULL(u.LastName, '') AS Name,
                u.Email,
                ISNULL(a.NPN, '') AS AgentCode,
                t.Name AS TenantName,
                ag.AgencyName
            FROM oe.Agents a
            INNER JOIN oe.Users u ON a.UserId = u.UserId
            INNER JOIN oe.Tenants t ON a.TenantId = t.TenantId
            LEFT JOIN oe.Agencies ag ON a.AgencyId = ag.AgencyId
            WHERE ${whereClause} ${searchClause}
            
            UNION ALL
            
            -- Get Agencies
            SELECT 
                ag2.AgencyId as Id,
                'Agency' as Type,
                ag2.TenantId,
                NULL as AgencyId,
                ag2.AgencyName AS Name,
                ag2.ContactEmail AS Email,
                NULL AS AgentCode,
                t2.Name AS TenantName,
                NULL as AgencyName
            FROM oe.Agencies ag2
            INNER JOIN oe.Tenants t2 ON ag2.TenantId = t2.TenantId
            WHERE ag2.TenantId = @tenantId
              AND ag2.Status = 'Active'
              ${search && String(search).trim().length > 0 ? 'AND ag2.AgencyName LIKE @search' : ''}
            
            ORDER BY Name
        `;

        const result = await request.query(query);

        return res.json({
            success: true,
            data: result.recordset
        });
    } catch (error) {
        console.error('❌ Error fetching agents for dropdown (sysadmin):', error);
        return res.status(500).json({
            success: false,
            message: 'Server error while fetching agents'
        });
    }
});

/**
 * @route   GET /api/me/sysadmin/enrollment-link-templates/static-by-agent
 * @desc    Get static enrollment link for a specific agent and template
 * @access  Private (SysAdmin)
 * Query params: agentId (required), templateId (required)
 */
router.get('/static-by-agent', authorize(['SysAdmin']), async (req, res) => {
    try {
        const { agentId, templateId } = req.query;
        
        if (!agentId || !templateId) {
            return res.status(400).json({
                success: false,
                message: 'agentId and templateId are required'
            });
        }
        
        const pool = await getPool();
        const request = pool.request();
        request.input('agentId', sql.UniqueIdentifier, agentId);
        request.input('templateId', sql.UniqueIdentifier, templateId);
        
        // Get static or marketing link for this agent and template
        const linkQuery = `
            SELECT 
                el.LinkId,
                el.LinkToken,
                el.ShortCode,
                el.LinkUrl as enrollmentUrl,
                el.Description,
                el.UsageCount,
                el.IsActive,
                el.CreatedDate as createdDate,
                el.AgentId,
                el.EnrollmentLinkTemplateId as templateId,
                el.LinkType as linkType
            FROM oe.EnrollmentLinks el
            WHERE el.AgentId = @agentId
                AND el.EnrollmentLinkTemplateId = @templateId
                AND (el.LinkType = 'Agent-Static' OR el.LinkType = 'Marketing')
                AND el.IsActive = 1
        `;
        
        const linkResult = await request.query(linkQuery);
        
        if (linkResult.recordset.length === 0) {
            return res.json({
                success: true,
                data: null,
                message: 'Static or marketing link not found for this agent and template'
            });
        }
        
        const link = linkResult.recordset[0];
        
        res.json({
            success: true,
            data: {
                linkId: link.LinkId,
                linkToken: link.LinkToken,
                shortCode: link.ShortCode,
                enrollmentUrl: link.enrollmentUrl,
                description: link.Description,
                usageCount: link.UsageCount,
                isActive: link.IsActive,
                createdDate: link.createdDate,
                agentId: link.AgentId,
                templateId: link.templateId,
                linkType: link.linkType
            }
        });
        
    } catch (error) {
        console.error('❌ Error fetching static link by agent:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch static link',
            error: {
                message: error.message,
                code: 'FETCH_STATIC_LINK_ERROR'
            }
        });
    }
});

module.exports = router;
