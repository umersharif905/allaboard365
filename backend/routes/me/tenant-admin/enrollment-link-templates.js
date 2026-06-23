const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authorize, getUserRoles } = require('../../../middleware/auth');
const agencyAdmins = require('../../../utils/agencyAdmins');

// Normalize tenant ID for comparison (handles string, Buffer, object from mssql)
function normalizeTenantId(id) {
  if (id == null) return '';
  if (Buffer.isBuffer(id)) return id.toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5').toLowerCase();
  return String(id).toLowerCase().replace(/[{}]/g, '').trim();
}

// Helper function to get agent's AgentId from UserId
async function getAgentIdFromUserId(pool, userId) {
  if (!userId) return null;
  const request = pool.request();
  request.input('UserId', sql.UniqueIdentifier, userId);
  const result = await request.query(`
    SELECT AgentId FROM oe.Agents WHERE UserId = @UserId AND Status = 'Active'
  `);
  return result.recordset.length > 0 ? result.recordset[0].AgentId : null;
}

async function isAgencyOwner(pool, agencyId, agentId) {
  return agencyAdmins.isAgencyAdmin(pool, agencyId, agentId);
}

/**
 * @route   GET /api/me/tenant-admin/enrollment-link-templates
 * @desc    Get all enrollment link templates for the authenticated tenant admin's tenant
 * @access  Private (TenantAdmin)
 */
router.get('/', authorize(['TenantAdmin']), async (req, res) => {
    try {
        const userId = req.user?.UserId;
        // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
        const tenantId = req.tenantId || req.user?.TenantId;
        
        if (!userId || !tenantId) {
            return res.status(401).json({ 
                success: false, 
                message: 'User not authenticated or tenant information is missing.' 
            });
        }
        
        console.log('🔍 GET /api/me/tenant-admin/enrollment-link-templates - Request received');
        console.log('👤 User:', { 
            userId: userId,
            tenantId: tenantId,
            roles: req.user?.roles,
            email: req.user?.Email
        });
        
        // Extract pagination and filtering parameters
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const search = req.query.search || '';
        const templateType = req.query.templateType || '';
        const isActive = req.query.isActive;
        const groupId = req.query.groupId || ''; // Look up AgentId from oe.Groups
        const agentId = req.query.agentId || ''; // Direct agentId for individual members
        const excludeHasMarketingLink = req.query.excludeHasMarketingLink === '1' || req.query.excludeHasMarketingLink === 'true';
        const hasMarketingLink = req.query.hasMarketingLink === '1' || req.query.hasMarketingLink === 'true';
        
        const offset = (page - 1) * limit;
        
        console.log('📊 Query parameters:', { page, limit, search, templateType, isActive, groupId, agentId, offset });
        
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
        
        // Build the WHERE clause
        let whereConditions = ['elt.TenantId = @tenantId'];
        const request = pool.request();
        request.input('tenantId', sql.UniqueIdentifier, tenantId);
        request.input('limit', sql.Int, limit);
        request.input('offset', sql.Int, offset);
        
        if (search) {
            // Search by template name, description, or agent name
            whereConditions.push(`(
                elt.TemplateName LIKE @search 
                OR elt.Description LIKE @search
                OR CONCAT(ISNULL(u.FirstName, ''), ' ', ISNULL(u.LastName, '')) LIKE @search
                OR ag.AgencyName LIKE @search
            )`);
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
                -- Check if this template has a static link (Agent-Static)
                CASE 
                    WHEN EXISTS (
                        SELECT 1 FROM oe.EnrollmentLinks el 
                        WHERE el.EnrollmentLinkTemplateId = elt.TemplateId 
                        AND el.LinkType = 'Agent-Static' 
                        AND el.IsActive = 1
                    ) THEN 1
                    ELSE 0
                END as HasStaticLink,
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
        
        // Get total count for pagination (same JOINs as data query so WHERE can reference u, ag)
        const countQuery = `
            SELECT COUNT(*) as TotalCount
            FROM oe.EnrollmentLinkTemplates elt
            LEFT JOIN oe.Agents a ON elt.AgentId = a.AgentId
            LEFT JOIN oe.Users u ON a.UserId = u.UserId
            LEFT JOIN oe.Agencies ag ON elt.AgencyId = ag.AgencyId
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
        
        // DEBUG: Log actual TemplateName and link flags being sent
        if (dataResult.recordset.length > 0) {
            console.log('🔍 DEBUG: Template Names in response:');
            dataResult.recordset.forEach((template, index) => {
                console.log(`  Template ${index + 1}: "${template.TemplateName}" (length: ${template.TemplateName?.length}, last 5: "${template.TemplateName?.slice(-5)}")`);
            });
            const first = dataResult.recordset[0];
            console.log('🔍 DEBUG: First template HasStaticLink/HasMarketingLink:', { HasStaticLink: first.HasStaticLink, HasMarketingLink: first.HasMarketingLink, tenantId });
        }

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
        console.error('❌ Error fetching tenant admin enrollment link templates:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching enrollment link templates'
        });
    }
});

/**
 * @route   GET /api/me/tenant-admin/enrollment-link-templates/static-by-agent
 * @desc    Get static enrollment link for a specific agent and template
 * @access  Private (TenantAdmin, AgencyOwner)
 * Query params: agentId (required), templateId (required)
 * NOTE: This route must be defined BEFORE /static to avoid route conflicts
 */
router.get('/static-by-agent', authorize(['TenantAdmin', 'Agent']), async (req, res) => {
  try {
    const { agentId, templateId } = req.query;
    // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
    const tenantId = req.tenantId || req.user?.TenantId;
    
    if (!agentId || !templateId) {
      return res.status(400).json({
        success: false,
        message: 'agentId and templateId are required'
      });
    }
    
    if (!tenantId) {
      return res.status(401).json({
        success: false,
        message: 'Tenant information is missing.'
      });
    }

    const pool = await getPool();

    // Resolve agentId: may be AgentId or AgencyId (for agency templates, links are stored under OwnerAgentId)
    let resolvedAgentId = agentId;
    const agentCheckRequest = pool.request();
    agentCheckRequest.input('agentId', sql.UniqueIdentifier, agentId);
    agentCheckRequest.input('tenantId', sql.UniqueIdentifier, tenantId);

    const agentCheckResult = await agentCheckRequest.query(`
      SELECT AgentId FROM oe.Agents
      WHERE AgentId = @agentId AND TenantId = @tenantId AND Status = 'Active'
    `);

    if (agentCheckResult.recordset.length === 0) {
      // Try as AgencyId and resolve to OwnerAgentId (may be NULL for agency with no owner)
      const agencyCheckRequest = pool.request();
      agencyCheckRequest.input('agencyId', sql.UniqueIdentifier, agentId);
      agencyCheckRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
      const agencyCheckResult = await agencyCheckRequest.query(`
        SELECT (
          SELECT TOP 1 aa.AgentId FROM oe.AgencyAdmins aa
          WHERE aa.AgencyId = ag.AgencyId AND aa.Status = 'Active' ORDER BY aa.AgentId
        ) AS AgentId
        FROM oe.Agencies ag
        WHERE ag.AgencyId = @agencyId AND ag.TenantId = @tenantId AND ag.Status = 'Active'
      `);
      if (agencyCheckResult.recordset.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Agent or Agency not found or does not belong to your tenant'
        });
      }
      resolvedAgentId = agencyCheckResult.recordset[0].AgentId; // may be NULL
    } else {
      resolvedAgentId = agentCheckResult.recordset[0].AgentId;
    }

    // For Agent role (not TenantAdmin), check they can access this agent (self or agency owner); skip when resolvedAgentId is NULL (agency with no owner)
    const userRoles = getUserRoles(req.user);
    if (userRoles.includes('Agent') && !userRoles.includes('TenantAdmin') && !userRoles.includes('SysAdmin')) {
      const requestingAgentId = await getAgentIdFromUserId(pool, req.user.UserId);
      if (!requestingAgentId) {
        return res.status(403).json({ success: false, message: 'Agent profile not found' });
      }
      if (requestingAgentId !== resolvedAgentId) {
        const targetAgentRequest = pool.request();
        targetAgentRequest.input('targetAgentId', sql.UniqueIdentifier, resolvedAgentId);
        const targetAgentResult = await targetAgentRequest.query(`
          SELECT AgencyId FROM oe.Agents WHERE AgentId = @targetAgentId
        `);
        if (targetAgentResult.recordset.length === 0 || !targetAgentResult.recordset[0].AgencyId) {
          return res.status(403).json({
            success: false,
            message: 'You do not have permission to access this link'
          });
        }
        const targetAgencyId = targetAgentResult.recordset[0].AgencyId;
        const isOwner = await isAgencyOwner(pool, targetAgencyId, requestingAgentId);
        if (!isOwner) {
          return res.status(403).json({
            success: false,
            message: 'You do not have permission to access this agent\'s static links'
          });
        }
      }
    }

    // Get static or marketing link for this agent and template (resolvedAgentId may be NULL for agency with no owner)
    const linkRequest = pool.request();
    linkRequest.input('agentId', sql.UniqueIdentifier, resolvedAgentId);
    linkRequest.input('templateId', sql.UniqueIdentifier, templateId);

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
      WHERE (el.AgentId = @agentId OR (@agentId IS NULL AND el.AgentId IS NULL))
        AND el.EnrollmentLinkTemplateId = @templateId
        AND (el.LinkType = 'Agent-Static' OR el.LinkType = 'Marketing')
        AND el.IsActive = 1
    `;

    const linkResult = await linkRequest.query(linkQuery);
    
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

/**
 * @route   GET /api/me/tenant-admin/enrollment-link-templates/static
 * @desc    Get all static enrollment links for agents in the tenant (with pagination)
 * @access  Private (TenantAdmin)
 * NOTE: This route must be defined BEFORE /:templateId to avoid route conflicts
 */
router.get('/static', authorize(['TenantAdmin']), async (req, res) => {
  try {
    // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
    const tenantId = req.tenantId || req.user?.TenantId;
    
    if (!tenantId) {
      return res.status(401).json({
        success: false,
        message: 'Tenant information is missing.'
      });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const agentId = req.query.agentId || null; // Optional: filter by agent (e.g. for Send Proposal)

    console.log('🔍 GET /api/me/tenant-admin/enrollment-link-templates/static - Request received');
    console.log('📊 Pagination:', { page, limit, offset, search, agentId });

    const pool = await getPool();

    // Get total count
    const countRequest = pool.request();
    countRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
    
    let countWhereClause = `(el.LinkType = 'Agent-Static' OR el.LinkType = 'Marketing') AND el.IsActive = 1 AND a.TenantId = @tenantId`;
    if (agentId) {
      countWhereClause += ` AND el.AgentId = @agentId`;
      countRequest.input('agentId', sql.UniqueIdentifier, agentId);
    }
    if (search) {
      countWhereClause += ` AND (
        CONCAT(ISNULL(u.FirstName, ''), ' ', ISNULL(u.LastName, '')) LIKE @search
        OR u.Email LIKE @search
        OR elt.TemplateName LIKE @search
      )`;
      countRequest.input('search', sql.NVarChar, `%${search}%`);
    }
    
    const countQuery = `
      SELECT COUNT(*) as TotalCount
      FROM oe.EnrollmentLinks el
      INNER JOIN oe.Agents a ON el.AgentId = a.AgentId
      LEFT JOIN oe.Users u ON a.UserId = u.UserId
      LEFT JOIN oe.EnrollmentLinkTemplates elt ON el.EnrollmentLinkTemplateId = elt.TemplateId
      WHERE ${countWhereClause}
    `;
    
    const countResult = await countRequest.query(countQuery);
    const totalCount = countResult.recordset[0].TotalCount;
    const totalPages = Math.ceil(totalCount / limit);

    // Get paginated static links with agent and template info
    const dataRequest = pool.request();
    dataRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
    dataRequest.input('offset', sql.Int, offset);
    dataRequest.input('limit', sql.Int, limit);
    if (agentId) {
      dataRequest.input('agentId', sql.UniqueIdentifier, agentId);
    }

    let dataWhereClause = `(el.LinkType = 'Agent-Static' OR el.LinkType = 'Marketing') AND el.IsActive = 1 AND a.TenantId = @tenantId`;
    if (agentId) {
      dataWhereClause += ` AND el.AgentId = @agentId`;
    }
    if (search) {
      dataWhereClause += ` AND (
        CONCAT(ISNULL(u.FirstName, ''), ' ', ISNULL(u.LastName, '')) LIKE @search
        OR u.Email LIKE @search
        OR elt.TemplateName LIKE @search
      )`;
      dataRequest.input('search', sql.NVarChar, `%${search}%`);
    }

    const dataQuery = `
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
        el.LinkType as linkType,
        elt.TemplateName,
        elt.TemplateType,
        elt.LinkMetaData,
        CONCAT(ISNULL(u.FirstName, ''), ' ', ISNULL(u.LastName, '')) as AgentName,
        u.Email as AgentEmail,
        -- Get enrollment count from this link
        (SELECT COUNT(*) 
         FROM oe.Enrollments e 
         INNER JOIN oe.Members m ON e.MemberId = m.MemberId
         WHERE m.AgentId = el.AgentId 
           AND e.CreatedDate >= el.CreatedDate) as enrollmentCount
      FROM oe.EnrollmentLinks el
      INNER JOIN oe.Agents a ON el.AgentId = a.AgentId
      LEFT JOIN oe.Users u ON a.UserId = u.UserId
      LEFT JOIN oe.EnrollmentLinkTemplates elt ON el.EnrollmentLinkTemplateId = elt.TemplateId
      WHERE ${dataWhereClause}
      ORDER BY el.CreatedDate DESC
      OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
    `;

    const dataResult = await dataRequest.query(dataQuery);

    console.log('✅ Found static links:', {
      count: dataResult.recordset.length,
      totalCount: totalCount,
      totalPages: totalPages,
      currentPage: page
    });

    res.json({
      success: true,
      data: dataResult.recordset.map(link => ({
        linkId: link.LinkId,
        linkToken: link.LinkToken,
        shortCode: link.ShortCode,
        enrollmentUrl: link.enrollmentUrl,
        description: link.Description,
        usageCount: link.UsageCount,
        enrollmentCount: link.enrollmentCount,
        isActive: link.IsActive,
        createdDate: link.createdDate,
        agentId: link.AgentId,
        agentName: link.AgentName,
        agentEmail: link.AgentEmail,
        templateId: link.templateId,
        linkType: link.linkType, // Include linkType for filtering
        template: {
          name: link.TemplateName,
          type: link.TemplateType,
          metadata: link.LinkMetaData
        }
      })),
      pagination: {
        currentPage: page,
        totalPages: totalPages,
        totalCount: totalCount,
        limit: limit,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1
      }
    });

  } catch (error) {
    console.error('❌ Error fetching static enrollment links:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch static enrollment links',
      error: {
        message: error.message,
        code: 'FETCH_STATIC_LINKS_ERROR'
      }
    });
  }
});

/**
 * @route   POST /api/me/tenant-admin/enrollment-link-templates/create-static
 * @desc    Create a static enrollment link for an agent in the tenant
 * @access  Private (TenantAdmin)
 * NOTE: This route must be defined BEFORE /:templateId to avoid route conflicts
 */
router.post('/create-static', authorize(['TenantAdmin']), async (req, res) => {
  try {
    // Accept agentId or agencyId (same as create-marketing)
    const agentId = req.body.agentId || req.body.agencyId;
    const { templateId } = req.body;
    const userId = req.user.UserId;
    const pool = await getPool();

    console.log('🔍 Creating static enrollment link for tenant admin:', { userId, templateId, agentId, reqTenantId: req.tenantId, userTenantId: req.user.TenantId });

    // Validate required fields
    if (!templateId || !agentId) {
      return res.status(400).json({
        success: false,
        message: 'Template ID and Agent or Agency ID are required'
      });
    }

    // Resolve template first and use its TenantId for agency lookup (same as create-marketing)
    let accessibleTenantIds = [req.tenantId || req.user.TenantId];
    const userTenantsReq = pool.request().input('userId', sql.UniqueIdentifier, userId);
    const userTenantsResult = await userTenantsReq.query(`
      SELECT TenantId, AdditionalTenants FROM oe.Users WHERE UserId = @userId
    `);
    if (userTenantsResult.recordset.length > 0) {
      const primary = userTenantsResult.recordset[0].TenantId;
      let additional = [];
      try {
        if (userTenantsResult.recordset[0].AdditionalTenants) {
          additional = JSON.parse(userTenantsResult.recordset[0].AdditionalTenants) || [];
        }
      } catch (_) {}
      accessibleTenantIds = [primary, ...additional];
    }
    const accessibleTenantNorms = accessibleTenantIds.map(t => t && normalizeTenantId(t)).filter(Boolean);

    const templateRequest = pool.request();
    templateRequest.input('templateId', sql.UniqueIdentifier, templateId);
    const templateQuery = `
      SELECT TemplateId, TemplateName, TemplateType, TenantId, LinkMetaData
      FROM oe.EnrollmentLinkTemplates
      WHERE TemplateId = @templateId
        AND TemplateType = 'Individual'
        AND IsActive = 1
    `;
    const templateResult = await templateRequest.query(templateQuery);
    if (templateResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Template not found or is not an Individual template'
      });
    }
    const template = templateResult.recordset[0];
    const templateTenantId = template.TenantId;
    const templateTenantNorm = normalizeTenantId(templateTenantId);
    if (!accessibleTenantNorms.length || !accessibleTenantNorms.includes(templateTenantNorm)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have access to this template\'s tenant.'
      });
    }

    const tenantId = templateTenantId;

    // Verify agent or agency belongs to the template's tenant
    let agentQuery = `
      SELECT 
        a.AgentId,
        a.TenantId,
        a.AgencyId,
        u.FirstName,
        u.LastName,
        u.Email
      FROM oe.Agents a
      INNER JOIN oe.Users u ON a.UserId = u.UserId
      WHERE a.AgentId = @agentId 
        AND a.TenantId = @tenantId 
        AND a.Status = 'Active'
    `;

    let agentRequest = pool.request();
    agentRequest.input('agentId', sql.UniqueIdentifier, agentId);
    agentRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
    let agentResult = await agentRequest.query(agentQuery);

    if (agentResult.recordset.length === 0) {
      const agencyQuery = `
        SELECT 
          rep.AgentId,
          ag.TenantId,
          ag.AgencyId,
          ag.AgencyName,
          ISNULL(u_owner.FirstName, ag.AgencyName) as FirstName,
          ISNULL(NULLIF(RTRIM(LTRIM(ISNULL(u_owner.LastName, ''))), ''), 'Agency') as LastName,
          u_owner.Email
        FROM oe.Agencies ag
        OUTER APPLY (
          SELECT TOP 1 aa.AgentId AS AgentId FROM oe.AgencyAdmins aa
          WHERE aa.AgencyId = ag.AgencyId AND aa.Status = 'Active' ORDER BY aa.AgentId
        ) rep
        LEFT JOIN oe.Agents a_owner ON a_owner.AgentId = rep.AgentId
        LEFT JOIN oe.Users u_owner ON a_owner.UserId = u_owner.UserId
        WHERE ag.AgencyId = @agentId 
          AND ag.TenantId = @tenantId
      `;
      const agencyRequest = pool.request();
      agencyRequest.input('agentId', sql.UniqueIdentifier, agentId);
      agencyRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
      agentResult = await agencyRequest.query(agencyQuery);

      // Fallback: agency by AgencyId only (may be under different tenant; user has template-tenant access)
      if (agentResult.recordset.length === 0) {
        const agencyAnyTenantQuery = `
          SELECT 
            rep.AgentId,
            ag.TenantId,
            ag.AgencyId,
            ag.AgencyName,
            ISNULL(u_owner.FirstName, ag.AgencyName) as FirstName,
            ISNULL(NULLIF(RTRIM(LTRIM(ISNULL(u_owner.LastName, ''))), ''), 'Agency') as LastName,
            u_owner.Email
          FROM oe.Agencies ag
          OUTER APPLY (
            SELECT TOP 1 aa.AgentId AS AgentId FROM oe.AgencyAdmins aa
            WHERE aa.AgencyId = ag.AgencyId AND aa.Status = 'Active' ORDER BY aa.AgentId
          ) rep
          LEFT JOIN oe.Agents a_owner ON a_owner.AgentId = rep.AgentId
          LEFT JOIN oe.Users u_owner ON a_owner.UserId = u_owner.UserId
          WHERE ag.AgencyId = @agentId
        `;
        const agencyAnyReq = pool.request().input('agentId', sql.UniqueIdentifier, agentId);
        const agencyAnyResult = await agencyAnyReq.query(agencyAnyTenantQuery).catch(() => ({ recordset: [] }));
        if (agencyAnyResult.recordset && agencyAnyResult.recordset.length > 0) {
          agentResult = agencyAnyResult;
        }
      }
    }

    if (agentResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Agent or Agency not found or does not belong to your tenant'
      });
    }

    const agent = agentResult.recordset[0];

    // Business rule: every member must have an agent. Do not create static links for agencies with no owner agent.
    if (agent.AgentId == null) {
      return res.status(400).json({
        success: false,
        message: 'This agency has no assigned agent. Please add an agent to the agency before creating enrollment links. Every member must have an agent.'
      });
    }

    // Check if agent/agency already has an Agent-Static or Marketing link for this template (handle AgentId NULL for agency with no owner)
    const existingLinkQuery = `
      SELECT LinkId, LinkToken, ShortCode, LinkUrl, LinkType, EnrollmentLinkTemplateId
      FROM oe.EnrollmentLinks
      WHERE (AgentId = @agentId OR (@agentId IS NULL AND AgentId IS NULL))
        AND (LinkType = 'Agent-Static' OR LinkType = 'Marketing')
        AND EnrollmentLinkTemplateId = @templateId
        AND IsActive = 1
    `;

    const existingLinkRequest = pool.request();
    existingLinkRequest.input('agentId', sql.UniqueIdentifier, agent.AgentId);
    existingLinkRequest.input('templateId', sql.UniqueIdentifier, templateId);
    const existingLinkResult = await existingLinkRequest.query(existingLinkQuery);

    // If agent already has a static or marketing link for this template, return it
    if (existingLinkResult.recordset.length > 0) {
      const existingLink = existingLinkResult.recordset[0];
      
      console.log(`🔄 Agent already has ${existingLink.LinkType} link for this template:`, existingLink.LinkId);

      const updateLinkRequest = pool.request();
      updateLinkRequest.input('linkId', sql.UniqueIdentifier, existingLink.LinkId);
      updateLinkRequest.input('templateId', sql.UniqueIdentifier, templateId);
      updateLinkRequest.input('modifiedBy', sql.UniqueIdentifier, userId);

      await updateLinkRequest.query(`
        UPDATE oe.EnrollmentLinks
        SET EnrollmentLinkTemplateId = @templateId,
            ModifiedDate = GETUTCDATE(),
            ModifiedBy = @modifiedBy
        WHERE LinkId = @linkId
      `);

      // Get base URL from request
      const baseUrl = req.get('origin') || `${req.protocol}://${req.get('host')}`;
      const enrollmentUrl = `${baseUrl}/enroll-now/${existingLink.ShortCode}`;

      return res.json({
        success: true,
        data: {
          linkId: existingLink.LinkId,
          linkToken: existingLink.LinkToken,
          shortCode: existingLink.ShortCode,
          enrollmentUrl: enrollmentUrl,
          linkType: existingLink.LinkType,
          templateName: template.TemplateName,
          message: `${existingLink.LinkType} enrollment link already exists for this template`
        }
      });
    }

    // Generate unique short code from agent name
    const ShortCodeService = require('../../../services/shared/short-code.service');
    const shortCode = await ShortCodeService.generateAgentShortCode(
      agent.FirstName, 
      agent.LastName, 
      pool
    );

    // Generate unique link token
    const linkToken = `enroll_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Generate UUID for LinkId
    const linkId = require('crypto').randomUUID();
    
    // Get base URL from request
    const baseUrl = req.get('origin') || `${req.protocol}://${req.get('host')}`;
    const enrollmentUrl = `${baseUrl}/enroll-now/${shortCode}`;
    
    // Create static enrollment link
    const createLinkQuery = `
      INSERT INTO oe.EnrollmentLinks (
        LinkId, GroupId, MemberId, LinkToken, LinkUrl, LinkType, ShortCode,
        Description, ExpiresAt, IsActive, UsageCount, MaxUsage,
        EnrollmentLinkTemplateId, AgentId,
        CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
      ) VALUES (
        @linkId, @groupId, @memberId, @linkToken, @linkUrl, @linkType, @shortCode,
        @description, @expiresAt, @isActive, @usageCount, @maxUsage,
        @templateId, @agentId,
        GETUTCDATE(), GETUTCDATE(), @createdBy, @modifiedBy
      )
    `;

    const createLinkRequest = pool.request();
    createLinkRequest.input('linkId', sql.UniqueIdentifier, linkId);
    createLinkRequest.input('groupId', sql.UniqueIdentifier, null);
    createLinkRequest.input('memberId', sql.UniqueIdentifier, null);
    createLinkRequest.input('linkToken', sql.NVarChar, linkToken);
    createLinkRequest.input('linkUrl', sql.NVarChar, enrollmentUrl);
    createLinkRequest.input('linkType', sql.NVarChar, 'Agent-Static');
    createLinkRequest.input('shortCode', sql.NVarChar, shortCode);
    createLinkRequest.input('description', sql.NVarChar, `Static enrollment link - ${agent.FirstName} ${agent.LastName}`);
    createLinkRequest.input('expiresAt', sql.DateTime2, null);
    createLinkRequest.input('isActive', sql.Bit, true);
    createLinkRequest.input('usageCount', sql.Int, 0);
    createLinkRequest.input('maxUsage', sql.Int, null);
    createLinkRequest.input('templateId', sql.UniqueIdentifier, templateId);
    createLinkRequest.input('agentId', sql.UniqueIdentifier, agent.AgentId);
    createLinkRequest.input('createdBy', sql.UniqueIdentifier, userId);
    createLinkRequest.input('modifiedBy', sql.UniqueIdentifier, userId);

    await createLinkRequest.query(createLinkQuery);

    console.log('✅ Static enrollment link created:', {
      linkId,
      shortCode,
      enrollmentUrl
    });

    res.status(201).json({
      success: true,
      data: {
        linkId,
        linkToken,
        shortCode,
        enrollmentUrl,
        templateName: template.TemplateName,
        message: 'Static enrollment link created successfully'
      }
    });

  } catch (error) {
    console.error('❌ Error creating static enrollment link:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create static enrollment link',
      error: {
        message: error.message,
        code: 'CREATE_STATIC_LINK_ERROR'
      }
    });
  }
});

/**
 * @route   POST /api/me/tenant-admin/enrollment-link-templates/create-marketing
 * @desc    Create a marketing (reusable) enrollment link for an agent
 * @access  Private (TenantAdmin)
 */
router.post('/create-marketing', authorize(['TenantAdmin']), async (req, res) => {
  try {
    // Ensure this handler is the one running (restart backend if you don't see CREATE-MARKETING-HANDLER-HIT in logs)
    console.log('🔍 CREATE-MARKETING-HANDLER-HIT', { path: req.path, method: req.method });
    // Accept agentId or agencyId (frontend may send either; backend resolves agency to OwnerAgentId)
    const agentId = req.body.agentId || req.body.agencyId;
    const { templateId } = req.body;
    const userId = req.user.UserId;
    const pool = await getPool();

    console.log('🔍 Creating marketing enrollment link for tenant admin:', { userId, templateId, agentId, bodyAgentId: req.body.agentId, bodyAgencyId: req.body.agencyId, reqTenantId: req.tenantId, userTenantId: req.user.TenantId });

    // Validate required fields
    if (!templateId || !agentId) {
      return res.status(400).json({
        success: false,
        message: 'Template ID and Agent or Agency ID are required'
      });
    }

    // Resolve template first and use its TenantId for agency lookup (ensures correct tenant when switching)
    let accessibleTenantIds = [req.tenantId || req.user.TenantId];
    const userTenantsReq = pool.request().input('userId', sql.UniqueIdentifier, userId);
    const userTenantsResult = await userTenantsReq.query(`
      SELECT TenantId, AdditionalTenants FROM oe.Users WHERE UserId = @userId
    `);
    if (userTenantsResult.recordset.length > 0) {
      const primary = userTenantsResult.recordset[0].TenantId;
      let additional = [];
      try {
        if (userTenantsResult.recordset[0].AdditionalTenants) {
          additional = JSON.parse(userTenantsResult.recordset[0].AdditionalTenants) || [];
        }
      } catch (_) {}
      accessibleTenantIds = [primary, ...additional];
    }
    const accessibleTenantNorms = accessibleTenantIds.map(t => t && normalizeTenantId(t)).filter(Boolean);

    const templateRequest = pool.request();
    templateRequest.input('templateId', sql.UniqueIdentifier, templateId);
    const templateQuery = `
      SELECT TemplateId, TemplateName, TemplateType, TenantId, LinkMetaData, AgentId, AgencyId
      FROM oe.EnrollmentLinkTemplates
      WHERE TemplateId = @templateId
        AND TemplateType IN ('Individual', 'Group')
        AND IsActive = 1
    `;
    const templateResult = await templateRequest.query(templateQuery);
    if (templateResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Template not found or not active.'
      });
    }
    const template = templateResult.recordset[0];
    const templateTenantId = template.TenantId;
    const templateTenantNorm = normalizeTenantId(templateTenantId);
    // Driver may return PascalCase or lowercase columns
    const templateAgencyId = template.AgencyId ?? template.agencyid;
    const templateAgentId = template.AgentId ?? template.agentid;
    console.log('🔍 create-marketing: template loaded', { templateId, templateAgencyId, templateAgentId, keys: Object.keys(template) });

    if (!accessibleTenantNorms.length || !accessibleTenantNorms.includes(templateTenantNorm)) {
      return res.status(403).json({
        success: false,
        message: 'You do not have access to this template\'s tenant.'
      });
    }

    const tenantId = templateTenantId;

    // Use template's stored AgencyId/AgentId as source of truth (same row we just saved); fall back to request body
    const resolveFromTemplate = !!(templateAgencyId || templateAgentId);

    let agentResult = { recordset: [] };

    if (resolveFromTemplate && templateAgencyId) {
      // Look up agency by template's AgencyId only (no tenant/status filter – template is source of truth)
      const agencyByTemplateQuery = `
        SELECT 
          rep.AgentId,
          ag.TenantId,
          ag.AgencyId,
          ag.AgencyName,
          ISNULL(u_owner.FirstName, ag.AgencyName) as FirstName,
          ISNULL(NULLIF(RTRIM(LTRIM(ISNULL(u_owner.LastName, ''))), ''), 'Agency') as LastName,
          u_owner.Email
        FROM oe.Agencies ag
        OUTER APPLY (
          SELECT TOP 1 aa.AgentId AS AgentId FROM oe.AgencyAdmins aa
          WHERE aa.AgencyId = ag.AgencyId AND aa.Status = 'Active' ORDER BY aa.AgentId
        ) rep
        LEFT JOIN oe.Agents a_owner ON a_owner.AgentId = rep.AgentId
        LEFT JOIN oe.Users u_owner ON a_owner.UserId = u_owner.UserId
        WHERE ag.AgencyId = @agencyId
      `;
      const agencyByTemplateReq = pool.request().input('agencyId', sql.UniqueIdentifier, templateAgencyId);
      try {
        const agencyByTemplateResult = await agencyByTemplateReq.query(agencyByTemplateQuery);
        if (agencyByTemplateResult.recordset && agencyByTemplateResult.recordset.length > 0) {
          agentResult = agencyByTemplateResult;
        }
      } catch (err) {
        console.warn('🔍 create-marketing: Agency lookup by template.AgencyId failed', { error: err.message, agencyId: templateAgencyId });
      }
    }

    if (agentResult.recordset.length === 0 && resolveFromTemplate && templateAgentId) {
      const agentByTemplateQuery = `
        SELECT a.AgentId, a.TenantId, a.AgencyId, u.FirstName, u.LastName, u.Email
        FROM oe.Agents a
        INNER JOIN oe.Users u ON a.UserId = u.UserId
        WHERE a.AgentId = @agentId AND a.TenantId = @tenantId AND a.Status = 'Active'
      `;
      const agentByTemplateReq = pool.request();
      agentByTemplateReq.input('agentId', sql.UniqueIdentifier, templateAgentId);
      agentByTemplateReq.input('tenantId', sql.UniqueIdentifier, tenantId);
      const agentByTemplateResult = await agentByTemplateReq.query(agentByTemplateQuery);
      if (agentByTemplateResult.recordset && agentByTemplateResult.recordset.length > 0) {
        agentResult = agentByTemplateResult;
      }
    }

    // Fallback: resolve from request body (agentId/agencyId) as before
    if (agentResult.recordset.length === 0 && agentId) {
      let agentRequest = pool.request();
      agentRequest.input('agentId', sql.UniqueIdentifier, agentId);
      agentRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
      agentResult = await agentRequest.query(`
        SELECT a.AgentId, a.TenantId, a.AgencyId, u.FirstName, u.LastName, u.Email
        FROM oe.Agents a
        INNER JOIN oe.Users u ON a.UserId = u.UserId
        WHERE a.AgentId = @agentId AND a.TenantId = @tenantId AND a.Status = 'Active'
      `);

      if (agentResult.recordset.length === 0) {
        const agencyRequest = pool.request();
        agencyRequest.input('agentId', sql.UniqueIdentifier, agentId);
        agencyRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
        agentResult = await agencyRequest.query(`
          SELECT rep.AgentId, ag.TenantId, ag.AgencyId, ag.AgencyName,
            ISNULL(u_owner.FirstName, ag.AgencyName) as FirstName,
            ISNULL(NULLIF(RTRIM(LTRIM(ISNULL(u_owner.LastName, ''))), ''), 'Agency') as LastName,
            u_owner.Email
          FROM oe.Agencies ag
          OUTER APPLY (
            SELECT TOP 1 aa.AgentId AS AgentId FROM oe.AgencyAdmins aa
            WHERE aa.AgencyId = ag.AgencyId AND aa.Status = 'Active' ORDER BY aa.AgentId
          ) rep
          LEFT JOIN oe.Agents a_owner ON a_owner.AgentId = rep.AgentId
          LEFT JOIN oe.Users u_owner ON a_owner.UserId = u_owner.UserId
          WHERE ag.AgencyId = @agentId AND ag.TenantId = @tenantId
        `);
      }

      if (agentResult.recordset.length === 0) {
        const agencyAnyReq = pool.request().input('agentId', sql.UniqueIdentifier, agentId);
        try {
          const agencyAnyResult = await agencyAnyReq.query(`
            SELECT rep.AgentId, ag.TenantId, ag.AgencyId, ag.AgencyName,
              ISNULL(u_owner.FirstName, ag.AgencyName) as FirstName,
              ISNULL(NULLIF(RTRIM(LTRIM(ISNULL(u_owner.LastName, ''))), ''), 'Agency') as LastName,
              u_owner.Email
            FROM oe.Agencies ag
            OUTER APPLY (
              SELECT TOP 1 aa.AgentId AS AgentId FROM oe.AgencyAdmins aa
              WHERE aa.AgencyId = ag.AgencyId AND aa.Status = 'Active' ORDER BY aa.AgentId
            ) rep
            LEFT JOIN oe.Agents a_owner ON a_owner.AgentId = rep.AgentId
            LEFT JOIN oe.Users u_owner ON a_owner.UserId = u_owner.UserId
            WHERE ag.AgencyId = @agentId
          `);
          if (agencyAnyResult.recordset && agencyAnyResult.recordset.length > 0) {
            agentResult = agencyAnyResult;
          }
        } catch (_) {}
      }
    }

    if (agentResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Agent or Agency not found or does not belong to your tenant'
      });
    }

    const agent = agentResult.recordset[0];

    // Business rule: every member must have an agent. Do not create marketing links for agencies with no owner agent.
    if (templateAgencyId && agent.AgentId == null) {
      return res.status(400).json({
        success: false,
        message: 'This agency has no assigned agent. Please add an agent to the agency before creating enrollment links. Every member must have an agent.'
      });
    }

    // Check if agent/agency already has a Marketing link for this template (handle AgentId NULL for agency with no owner)
    const existingLinkQuery = `
      SELECT LinkId, LinkToken, ShortCode, LinkUrl
      FROM oe.EnrollmentLinks
      WHERE (AgentId = @agentId OR (@agentId IS NULL AND AgentId IS NULL))
        AND LinkType = 'Marketing'
        AND EnrollmentLinkTemplateId = @templateId
        AND IsActive = 1
    `;

    const existingLinkRequest = pool.request();
    existingLinkRequest.input('agentId', sql.UniqueIdentifier, agent.AgentId);
    existingLinkRequest.input('templateId', sql.UniqueIdentifier, templateId);
    const existingLinkResult = await existingLinkRequest.query(existingLinkQuery);

    // If agent already has a marketing link for this template, return it
    if (existingLinkResult.recordset.length > 0) {
      const existingLink = existingLinkResult.recordset[0];
      
      console.log('🔄 Agent already has marketing link for this template:', existingLink.LinkId);

      // Get base URL from request
      const baseUrl = req.get('origin') || `${req.protocol}://${req.get('host')}`;
      const enrollmentUrl = `${baseUrl}/enroll-now/${existingLink.ShortCode}`;

      return res.json({
        success: true,
        data: {
          linkId: existingLink.LinkId,
          linkToken: existingLink.LinkToken,
          shortCode: existingLink.ShortCode,
          enrollmentUrl: enrollmentUrl,
          templateName: template.TemplateName,
          message: 'Marketing enrollment link already exists for this template'
        }
      });
    }

    // Generate unique short code from agent name with marketing prefix
    const ShortCodeService = require('../../../services/shared/short-code.service');
    const shortCode = await ShortCodeService.generateAgentShortCode(
      agent.FirstName, 
      agent.LastName, 
      pool,
      'mk' // Prefix for marketing links (mk_)
    );

    // Generate unique link token
    const linkToken = `enroll_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Generate UUID for LinkId
    const linkId = require('crypto').randomUUID();
    
    // Get base URL from request
    const baseUrl = req.get('origin') || `${req.protocol}://${req.get('host')}`;
    const enrollmentUrl = `${baseUrl}/enroll-now/${shortCode}`;
    
    // Create marketing enrollment link
    const createLinkQuery = `
      INSERT INTO oe.EnrollmentLinks (
        LinkId, GroupId, MemberId, LinkToken, LinkUrl, LinkType, ShortCode,
        Description, ExpiresAt, IsActive, UsageCount, MaxUsage,
        EnrollmentLinkTemplateId, AgentId,
        CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
      ) VALUES (
        @linkId, @groupId, @memberId, @linkToken, @linkUrl, @linkType, @shortCode,
        @description, @expiresAt, @isActive, @usageCount, @maxUsage,
        @templateId, @agentId,
        GETUTCDATE(), GETUTCDATE(), @createdBy, @modifiedBy
      )
    `;

    const createLinkRequest = pool.request();
    createLinkRequest.input('linkId', sql.UniqueIdentifier, linkId);
    createLinkRequest.input('groupId', sql.UniqueIdentifier, null);
    createLinkRequest.input('memberId', sql.UniqueIdentifier, null);
    createLinkRequest.input('linkToken', sql.NVarChar, linkToken);
    createLinkRequest.input('linkUrl', sql.NVarChar, enrollmentUrl);
    createLinkRequest.input('linkType', sql.NVarChar, 'Marketing');
    createLinkRequest.input('shortCode', sql.NVarChar, shortCode);
    createLinkRequest.input('description', sql.NVarChar, `Marketing enrollment link - ${agent.FirstName} ${agent.LastName}`);
    createLinkRequest.input('expiresAt', sql.DateTime2, null); // Never expires
    createLinkRequest.input('isActive', sql.Bit, true);
    createLinkRequest.input('usageCount', sql.Int, 0);
    createLinkRequest.input('maxUsage', sql.Int, null);
    createLinkRequest.input('templateId', sql.UniqueIdentifier, templateId);
    createLinkRequest.input('agentId', sql.UniqueIdentifier, agent.AgentId);
    createLinkRequest.input('createdBy', sql.UniqueIdentifier, userId);
    createLinkRequest.input('modifiedBy', sql.UniqueIdentifier, userId);

    await createLinkRequest.query(createLinkQuery);

    console.log('✅ Marketing enrollment link created:', {
      linkId,
      shortCode,
      enrollmentUrl
    });

    res.status(201).json({
      success: true,
      data: {
        linkId,
        linkToken,
        shortCode,
        enrollmentUrl,
        templateName: template.TemplateName,
        message: 'Marketing enrollment link created successfully'
      }
    });

  } catch (error) {
    console.error('❌ Error creating marketing enrollment link:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create marketing enrollment link',
      error: {
        message: error.message,
        code: 'CREATE_MARKETING_LINK_ERROR'
      }
    });
  }
});

/**
 * @route   POST /api/me/tenant-admin/enrollment-link-templates/sync-group-products
 * @desc    Update all enrollment link templates for a group to use the given product set (productIds).
 *          Builds product sections by ProductType and updates each template's LinkMetaData.products.
 * @access  Private (TenantAdmin)
 */
router.post('/sync-group-products', authorize(['TenantAdmin']), async (req, res) => {
    try {
        const { groupId, productIds } = req.body;
        const userId = req.user?.UserId;
        const tenantId = req.tenantId || req.user?.TenantId;

        if (!groupId || !Array.isArray(productIds)) {
            return res.status(400).json({
                success: false,
                message: 'groupId and productIds (array) are required.'
            });
        }

        const pool = await getPool();

        // Resolve product details (ProductId, ProductType, IsBundle) for the given productIds
        if (productIds.length === 0) {
            const templatesResult = await pool.request()
                .input('groupId', sql.UniqueIdentifier, groupId)
                .input('tenantId', sql.UniqueIdentifier, tenantId)
                .query(`
                    SELECT TemplateId, TemplateName, LinkMetaData
                    FROM oe.EnrollmentLinkTemplates
                    WHERE GroupId = @groupId AND TenantId = @tenantId
                `);
            const templates = templatesResult.recordset || [];
            for (const row of templates) {
                let meta = {};
                try {
                    meta = JSON.parse(row.LinkMetaData || '{}');
                } catch (_) {}
                meta.products = [];
                const newMeta = JSON.stringify(meta);
                await pool.request()
                    .input('templateId', sql.UniqueIdentifier, row.TemplateId)
                    .input('linkMetaData', sql.NVarChar, newMeta)
                    .input('modifiedBy', sql.UniqueIdentifier, userId)
                    .query(`
                        UPDATE oe.EnrollmentLinkTemplates
                        SET LinkMetaData = @linkMetaData, ModifiedBy = @modifiedBy, ModifiedDate = GETUTCDATE()
                        WHERE TemplateId = @templateId
                    `);
            }
            return res.json({
                success: true,
                message: `${templates.length} enrollment link template(s) updated.`,
                updatedCount: templates.length
            });
        }

        const productIdsParam = productIds.map(id => id).filter(Boolean);
        const request = pool.request();
        request.input('tenantId', sql.UniqueIdentifier, tenantId);
        const placeholders = productIdsParam.map((_, i) => `@p${i}`).join(',');
        productIdsParam.forEach((id, i) => request.input(`p${i}`, sql.UniqueIdentifier, id));

        const productsResult = await request.query(`
            SELECT ProductId, ProductType, IsBundle
            FROM oe.Products
            WHERE TenantId = @tenantId AND ProductId IN (${placeholders})
        `);
        const products = productsResult.recordset || [];

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

        const templatesResult = await pool.request()
            .input('groupId', sql.UniqueIdentifier, groupId)
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .query(`
                SELECT TemplateId, TemplateName, LinkMetaData
                FROM oe.EnrollmentLinkTemplates
                WHERE GroupId = @groupId AND TenantId = @tenantId
            `);
        const templates = templatesResult.recordset || [];

        for (const row of templates) {
            let meta = {};
            try {
                meta = JSON.parse(row.LinkMetaData || '{}');
            } catch (_) {}
            meta.products = productSections;
            const newMeta = JSON.stringify(meta);
            await pool.request()
                .input('templateId', sql.UniqueIdentifier, row.TemplateId)
                .input('linkMetaData', sql.NVarChar, newMeta)
                .input('modifiedBy', sql.UniqueIdentifier, userId)
                .query(`
                    UPDATE oe.EnrollmentLinkTemplates
                    SET LinkMetaData = @linkMetaData, ModifiedBy = @modifiedBy, ModifiedDate = GETUTCDATE()
                    WHERE TemplateId = @templateId
                `);
        }

        res.json({
            success: true,
            message: `${templates.length} enrollment link template(s) updated to reflect the group's products.`,
            updatedCount: templates.length
        });
    } catch (error) {
        console.error('❌ Error syncing group products to enrollment link templates:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while syncing enrollment link templates.'
        });
    }
});

/**
 * @route   GET /api/me/tenant-admin/enrollment-link-templates/:templateId
 * @desc    Get a specific enrollment link template by ID (tenant admin access)
 * @access  Private (TenantAdmin)
 */
router.get('/:templateId', authorize(['TenantAdmin']), async (req, res) => {
    try {
        const { templateId } = req.params;
        // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
        const tenantId = req.tenantId || req.user?.TenantId;
        
        if (!tenantId) {
            return res.status(401).json({ 
                success: false, 
                message: 'Tenant information is missing.' 
            });
        }
        
        console.log('🔍 GET /api/me/tenant-admin/enrollment-link-templates/:templateId - Request received');
        console.log('📋 Template ID:', templateId);
        console.log('🏢 Tenant ID:', tenantId);
        
        const pool = await getPool();
        const request = pool.request();
        request.input('templateId', sql.UniqueIdentifier, templateId);
        request.input('tenantId', sql.UniqueIdentifier, tenantId);
        
        const query = `
            SELECT 
                elt.TemplateId,
                elt.TemplateName,
                elt.TemplateType,
                elt.TenantId,
                elt.AgentId,
                elt.GroupId,
                elt.LinkMetaData,
                elt.IsActive,
                elt.Description,
                elt.CreatedDate,
                elt.ModifiedDate,
                elt.CreatedBy,
                elt.ModifiedBy,
                ISNULL(t.Name, 'Unknown Tenant') as TenantName,
                CONCAT(ISNULL(a.FirstName, ''), ' ', ISNULL(a.LastName, '')) as AgentName,
                g.Name AS GroupName
            FROM oe.EnrollmentLinkTemplates elt
            LEFT JOIN oe.Tenants t ON elt.TenantId = t.TenantId
            LEFT JOIN oe.Agents a ON elt.AgentId = a.AgentId
            LEFT JOIN oe.Groups g ON elt.GroupId = g.GroupId
            WHERE elt.TemplateId = @templateId AND elt.TenantId = @tenantId
        `;
        
        const result = await request.query(query);
        
        if (result.recordset.length === 0) {
            console.log('❌ Template not found or access denied');
            return res.status(404).json({
                success: false,
                message: 'Template not found or access denied.'
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
 * @route   POST /api/me/tenant-admin/enrollment-link-templates
 * @desc    Create a new enrollment link template (tenant admin)
 * @access  Private (TenantAdmin)
 */
router.post('/', authorize(['TenantAdmin']), async (req, res) => {
    try {
        const { templateName, templateType, agentId, groupId, linkMetaData, description, isActive = true } = req.body;
        const userId = req.user?.UserId;
        // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
        const tenantId = req.tenantId || req.user?.TenantId;
        
        if (!userId || !tenantId) {
            return res.status(401).json({ 
                success: false, 
                message: 'User not authenticated or tenant information is missing.' 
            });
        }
        
        if (!templateName || !templateType || !agentId) {
            return res.status(400).json({
                success: false,
                message: 'Template name, template type, and agent/agency ID are required.'
            });
        }
        
        // GroupId is optional for Group templates (e.g. group marketing link without a specific group)
        
        if (templateType === 'Individual' && groupId) {
            return res.status(400).json({
                success: false,
                message: 'Individual templates cannot have a groupId'
            });
        }
        
        console.log('🔍 POST /api/me/tenant-admin/enrollment-link-templates - Request received');
        console.log('📋 Template data:', { templateName, templateType, agentId, groupId, tenantId, isActive });
        
        const pool = await getPool();
        
        // Verify that the agent or agency belongs to this tenant
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
                message: 'Selected agent or agency does not belong to your tenant.'
            });
        }
        
        const assigneeType = agentVerifyResult.recordset[0].Type; // 'Agent' or 'Agency'
        console.log('✅ Verified assignee type:', assigneeType);

        // Business rule: every member must have an agent. Agencies with no owner agent cannot have enrollment links.
        if (assigneeType === 'Agency') {
            const agencyOwnerCheck = pool.request();
            agencyOwnerCheck.input('agencyId', sql.UniqueIdentifier, agentId);
            const agencyOwnerResult = await agencyOwnerCheck.query(`
                SELECT (
                  SELECT TOP 1 aa.AgentId FROM oe.AgencyAdmins aa
                  WHERE aa.AgencyId = ag.AgencyId AND aa.Status = 'Active' ORDER BY aa.AgentId
                ) AS HasAdmin
                FROM oe.Agencies ag WHERE ag.AgencyId = @agencyId
            `);
            if (agencyOwnerResult.recordset.length > 0 && agencyOwnerResult.recordset[0].HasAdmin == null) {
                return res.status(400).json({
                    success: false,
                    message: 'This agency has no assigned agent. Please add an agent to the agency before creating enrollment link templates. Every member must have an agent.'
                });
            }
        }
        
        // Generate a new TemplateId
        const templateId = require('crypto').randomUUID();
        
        const request = pool.request();
        request.input('templateId', sql.UniqueIdentifier, templateId);
        request.input('templateName', sql.NVarChar, templateName);
        request.input('templateType', sql.NVarChar, templateType);
        request.input('tenantId', sql.UniqueIdentifier, tenantId);
        request.input('groupId', sql.UniqueIdentifier, groupId || null);
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
                    TemplateId, TemplateName, TemplateType, TenantId, AgentId, AgencyId, GroupId,
                    LinkMetaData, IsActive, Description, CreatedBy, ModifiedBy,
                    CreatedDate, ModifiedDate
                ) VALUES (
                    @templateId, @templateName, @templateType, @tenantId, @agentId, NULL, @groupId,
                    @linkMetaData, @isActive, @description, @createdBy, @modifiedBy,
                    GETUTCDATE(), GETUTCDATE()
                )
            `;
        } else {
            request.input('agencyId', sql.UniqueIdentifier, agentId); // agentId parameter contains AgencyId
            insertQuery = `
                INSERT INTO oe.EnrollmentLinkTemplates (
                    TemplateId, TemplateName, TemplateType, TenantId, AgentId, AgencyId, GroupId,
                    LinkMetaData, IsActive, Description, CreatedBy, ModifiedBy,
                    CreatedDate, ModifiedDate
                ) VALUES (
                    @templateId, @templateName, @templateType, @tenantId, NULL, @agencyId, @groupId,
                    @linkMetaData, @isActive, @description, @createdBy, @modifiedBy,
                    GETUTCDATE(), GETUTCDATE()
                )
            `;
        }
        
        console.log('🔍 DEBUG Executing INSERT query with GroupId:', groupId);
        console.log('🔍 DEBUG INSERT query:', insertQuery);
        await request.query(insertQuery);
        
        console.log('✅ Created enrollment link template:', templateName, 'with GroupId:', groupId);
        
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
 * @route   POST /api/me/tenant-admin/enrollment-link-templates/:templateId/duplicate
 * @desc    Duplicate an enrollment link template with new IDs
 * @access  Private (TenantAdmin)
 */
router.post('/:templateId/duplicate', authorize(['TenantAdmin']), async (req, res) => {
    try {
        const { templateId } = req.params;
        const userId = req.user?.UserId;
        const tenantId = req.user?.TenantId;
        
        if (!userId || !tenantId) {
            return res.status(401).json({ 
                success: false, 
                message: 'User not authenticated or tenant information is missing.' 
            });
        }
        
        console.log('🔍 POST /api/me/tenant-admin/enrollment-link-templates/:templateId/duplicate - Request received');
        console.log('📋 Template ID to duplicate:', templateId);
        
        const pool = await getPool();
        
        // Get the original template (must belong to tenant)
        const getTemplateRequest = pool.request();
        getTemplateRequest.input('templateId', sql.UniqueIdentifier, templateId);
        getTemplateRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
        
        const templateResult = await getTemplateRequest.query(`
            SELECT TemplateId, TemplateName, TemplateType, GroupId, AgentId, LinkMetaData, Description, IsActive
            FROM oe.EnrollmentLinkTemplates
            WHERE TemplateId = @templateId
              AND TenantId = @tenantId
        `);
        
        if (templateResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Template not found or you do not have permission to duplicate it.'
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
        createRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
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
                code: 'TENANT_ADMIN_DUPLICATE_TEMPLATE_ERROR'
            }
        });
    }
});

/**
 * @route   PUT /api/me/tenant-admin/enrollment-link-templates/:templateId
 * @desc    Update an enrollment link template (tenant admin)
 * @access  Private (TenantAdmin)
 */
router.put('/:templateId', authorize(['TenantAdmin']), async (req, res) => {
    try {
        const { templateId } = req.params;
        const { templateName, templateType, agentId, groupId, linkMetaData, description, isActive } = req.body;
        const userId = req.user?.UserId;
        // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
        const tenantId = req.tenantId || req.user?.TenantId;
        
        if (!userId || !tenantId) {
            return res.status(401).json({ 
                success: false, 
                message: 'User not authenticated or tenant information is missing.' 
            });
        }
        
        console.log('🔍 PUT /api/me/tenant-admin/enrollment-link-templates/:templateId - Request received');
        console.log('📋 Template ID:', templateId);
        console.log('📋 Update data:', { templateName, templateType, agentId, groupId, isActive });
        
        const pool = await getPool();
        
        // Verify template exists and belongs to this tenant
        const verifyRequest = pool.request();
        verifyRequest.input('templateId', sql.UniqueIdentifier, templateId);
        verifyRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
        
        const verifyQuery = `
            SELECT TemplateId, TemplateName FROM oe.EnrollmentLinkTemplates 
            WHERE TemplateId = @templateId AND TenantId = @tenantId
        `;
        
        const verifyResult = await verifyRequest.query(verifyQuery);
        
        if (verifyResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Template not found or access denied.'
            });
        }
        
        // If agentId is provided, verify it belongs to this tenant
        if (agentId) {
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
                    message: 'Selected agent or agency does not belong to your tenant.'
                });
            }
        }
        
        // Build dynamic update query
        const updates = [];
        const request = pool.request();
        request.input('templateId', sql.UniqueIdentifier, templateId);
        request.input('tenantId', sql.UniqueIdentifier, tenantId);
        request.input('modifiedBy', sql.UniqueIdentifier, userId);
        
        if (templateName !== undefined) {
            updates.push('TemplateName = @templateName');
            request.input('templateName', sql.NVarChar, templateName);
        }
        if (templateType !== undefined) {
            updates.push('TemplateType = @templateType');
            request.input('templateType', sql.NVarChar, templateType);
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
        if (groupId !== undefined) {
            const groupIdValue = groupId || null;
            console.log('🔍 DEBUG UPDATE GroupId parameter:', { groupId, groupIdValue, type: typeof groupId });
            updates.push('GroupId = @groupId');
            request.input('groupId', sql.UniqueIdentifier, groupIdValue);
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
            WHERE TemplateId = @templateId AND TenantId = @tenantId
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
 * @route   DELETE /api/me/tenant-admin/enrollment-link-templates/:templateId
 * @desc    Delete an enrollment link template (tenant admin)
 * @access  Private (TenantAdmin)
 */
router.delete('/:templateId', authorize(['TenantAdmin']), async (req, res) => {
    try {
        const { templateId } = req.params;
        const tenantId = req.user?.TenantId;
        
        if (!tenantId) {
            return res.status(401).json({ 
                success: false, 
                message: 'Tenant information is missing.' 
            });
        }
        
        console.log('🔍 DELETE /api/me/tenant-admin/enrollment-link-templates/:templateId - Request received');
        console.log('📋 Template ID:', templateId);
        console.log('🏢 Tenant ID:', tenantId);
        
        const pool = await getPool();
        
        // Verify template exists and get its name for logging
        const verifyRequest = pool.request();
        verifyRequest.input('templateId', sql.UniqueIdentifier, templateId);
        verifyRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
        
        const verifyQuery = `
            SELECT TemplateName FROM oe.EnrollmentLinkTemplates 
            WHERE TemplateId = @templateId AND TenantId = @tenantId
        `;
        
        const verifyResult = await verifyRequest.query(verifyQuery);
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
        deleteRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
        
        const deleteQuery = `
            DELETE FROM oe.EnrollmentLinkTemplates
            WHERE TemplateId = @templateId AND TenantId = @tenantId
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
 * @route   GET /api/me/tenant-admin/enrollment-link-templates/dropdown-data/agents
 * @desc    Get agents for dropdown (tenant admin - only agents in their tenant)
 * @access  Private (TenantAdmin)
 */
router.get('/dropdown-data/agents', authorize(['TenantAdmin']), async (req, res) => {
    try {
        const tenantId = req.user?.TenantId;
        
        if (!tenantId) {
            return res.status(401).json({ 
                success: false, 
                message: 'Tenant information is missing.' 
            });
        }
        
        console.log('🔍 GET /api/me/tenant-admin/enrollment-link-templates/dropdown-data/agents');
        console.log('🏢 Tenant ID:', tenantId);
        
        const pool = await getPool();
        const request = pool.request();
        request.input('tenantId', sql.UniqueIdentifier, tenantId);
        
        const query = `
            SELECT 
                a.AgentId,
                a.TenantId,
                CONCAT(ISNULL(a.FirstName, ''), ' ', ISNULL(a.LastName, '')) as AgentName,
                a.Email,
                a.AgentCode,
                t.Name as TenantName
            FROM oe.Agents a
            LEFT JOIN oe.Tenants t ON a.TenantId = t.TenantId
            WHERE a.TenantId = @tenantId AND a.Status = 'Active'
            ORDER BY a.FirstName, a.LastName
        `;
        
        const result = await request.query(query);
        
        console.log('✅ Found agents for dropdown:', result.recordset.length);
        
        res.json({
            success: true,
            data: result.recordset
        });
        
    } catch (error) {
        console.error('❌ Error fetching agents for dropdown:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching agents'
        });
    }
});

module.exports = router;