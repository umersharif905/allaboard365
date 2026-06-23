// File: backend/routes/me/agent/enrollment-links.js

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authorize } = require('../../../middleware/auth');
const ShortCodeService = require('../../../services/shared/short-code.service');
const { isUplineAncestor } = require('../../../utils/agentHierarchy');

/**
 * @route   POST /api/me/agent/enrollment-links/create-static
 * @desc    Create a static (reusable) enrollment link for an agent
 * @access  Private (Agent)
 */
router.post('/create-static', authorize(['Agent']), async (req, res) => {
  try {
    const { templateId } = req.body;
    const userId = req.user.UserId;

    console.log('🔍 Creating static enrollment link for agent:', { userId, templateId });

    // Validate required fields
    if (!templateId) {
      return res.status(400).json({
        success: false,
        message: 'Template ID is required'
      });
    }

    const pool = await getPool();

    // Get agent information
    const agentQuery = `
      SELECT 
        a.AgentId,
        a.TenantId,
        a.AgencyId,
        u.FirstName,
        u.LastName,
        u.Email
      FROM oe.Agents a
      INNER JOIN oe.Users u ON a.UserId = u.UserId
      WHERE a.UserId = @userId AND a.Status = 'Active'
    `;

    const agentRequest = pool.request();
    agentRequest.input('userId', sql.UniqueIdentifier, userId);
    const agentResult = await agentRequest.query(agentQuery);

    if (agentResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Agent profile not found'
      });
    }

    const agent = agentResult.recordset[0];

    // Verify template exists, belongs to agent's tenant, and is type 'Individual'
    const templateQuery = `
      SELECT TemplateId, TemplateName, TemplateType, TenantId, LinkMetaData, AgentId AS TemplateAgentId
      FROM oe.EnrollmentLinkTemplates
      WHERE TemplateId = @templateId
        AND TenantId = @tenantId
        AND TemplateType = 'Individual'
        AND IsActive = 1
    `;

    const templateRequest = pool.request();
    templateRequest.input('templateId', sql.UniqueIdentifier, templateId);
    templateRequest.input('tenantId', sql.UniqueIdentifier, agent.TenantId);
    const templateResult = await templateRequest.query(templateQuery);

    if (templateResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Template not found or is not an Individual template'
      });
    }

    const template = templateResult.recordset[0];

    // Resolve link agent: template may be for self or a downline agent
    let linkAgentId = template.TemplateAgentId || agent.AgentId;
    let linkFirstName = agent.FirstName;
    let linkLastName = agent.LastName;
    if (template.TemplateAgentId && template.TemplateAgentId !== agent.AgentId) {
      const allowed = await isUplineAncestor(pool, template.TemplateAgentId, agent.AgentId);
      if (!allowed) {
        return res.status(403).json({
          success: false,
          message: 'Template is for another agent; you can only create links for yourself or your downline.'
        });
      }
      const downlineReq = pool.request().input('agentId', sql.UniqueIdentifier, template.TemplateAgentId);
      const downlineRes = await downlineReq.query(`
        SELECT u.FirstName, u.LastName FROM oe.Agents a INNER JOIN oe.Users u ON a.UserId = u.UserId WHERE a.AgentId = @agentId
      `);
      if (downlineRes.recordset.length === 0) {
        return res.status(404).json({ success: false, message: 'Template agent not found.' });
      }
      linkFirstName = downlineRes.recordset[0].FirstName;
      linkLastName = downlineRes.recordset[0].LastName;
    }

    // Check if agent already has an Agent-Static link for THIS template
    const existingLinkQuery = `
      SELECT LinkId, LinkToken, ShortCode, LinkUrl
      FROM oe.EnrollmentLinks
      WHERE AgentId = @agentId
        AND EnrollmentLinkTemplateId = @templateId
        AND LinkType = 'Agent-Static'
        AND IsActive = 1
    `;

    const existingLinkRequest = pool.request();
    existingLinkRequest.input('agentId', sql.UniqueIdentifier, linkAgentId);
    existingLinkRequest.input('templateId', sql.UniqueIdentifier, templateId);
    const existingLinkResult = await existingLinkRequest.query(existingLinkQuery);

    // If a static link already exists for this template, return it
    if (existingLinkResult.recordset.length > 0) {
      const existingLink = existingLinkResult.recordset[0];

      console.log('✅ Agent already has static link for this template:', existingLink.LinkId);

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
          message: 'Static enrollment link retrieved successfully'
        }
      });
    }

    // Generate unique short code from link owner's name
    // Count existing Agent-Static links for this agent to determine suffix number
    const countRequest = pool.request();
    countRequest.input('agentId', sql.UniqueIdentifier, linkAgentId);
    const countResult = await countRequest.query(`
      SELECT COUNT(*) as linkCount
      FROM oe.EnrollmentLinks
      WHERE AgentId = @agentId
        AND LinkType = 'Agent-Static'
        AND IsActive = 1
    `);
    const existingCount = countResult.recordset[0].linkCount;

    let shortCode;
    if (existingCount === 0) {
      // First static link for this agent - use base short code
      shortCode = await ShortCodeService.generateAgentShortCode(
        linkFirstName,
        linkLastName,
        pool
      );
    } else {
      // Additional static links - append number suffix
      const baseCode = `ag_${ShortCodeService.normalize(linkFirstName)}_${ShortCodeService.normalize(linkLastName)}`;
      let suffix = existingCount + 1;
      shortCode = `${baseCode}_${suffix}`;
      // Ensure uniqueness - keep incrementing if taken
      const dbPool = pool;
      let attempts = 0;
      while (attempts < 20) {
        const checkReq = dbPool.request();
        checkReq.input('code', sql.NVarChar, shortCode);
        const checkRes = await checkReq.query('SELECT ShortCode FROM oe.EnrollmentLinks WHERE ShortCode = @code');
        if (checkRes.recordset.length === 0) break;
        suffix++;
        shortCode = `${baseCode}_${suffix}`;
        attempts++;
      }
    }

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
    createLinkRequest.input('groupId', sql.UniqueIdentifier, null); // No group for agent-static
    createLinkRequest.input('memberId', sql.UniqueIdentifier, null); // No member for agent-static
    createLinkRequest.input('linkToken', sql.NVarChar, linkToken);
    createLinkRequest.input('linkUrl', sql.NVarChar, enrollmentUrl);
    createLinkRequest.input('linkType', sql.NVarChar, 'Agent-Static');
    createLinkRequest.input('shortCode', sql.NVarChar, shortCode);
    createLinkRequest.input('description', sql.NVarChar, `Static enrollment link - ${linkFirstName} ${linkLastName}`);
    createLinkRequest.input('expiresAt', sql.DateTime2, null); // Never expires
    createLinkRequest.input('isActive', sql.Bit, true);
    createLinkRequest.input('usageCount', sql.Int, 0);
    createLinkRequest.input('maxUsage', sql.Int, null); // Unlimited usage
    createLinkRequest.input('templateId', sql.UniqueIdentifier, templateId);
    createLinkRequest.input('agentId', sql.UniqueIdentifier, linkAgentId);
    // DON'T set AgencyId - CHECK constraint requires AgentId OR AgencyId, not both
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
 * @route   GET /api/me/agent/enrollment-links/static
 * @desc    Get agent's static enrollment link (if exists)
 * @access  Private (Agent)
 */
router.get('/static', authorize(['Agent']), async (req, res) => {
  try {
    const userId = req.user.UserId;

    const pool = await getPool();

    // Get agent's AgentId
    const agentQuery = `
      SELECT AgentId FROM oe.Agents 
      WHERE UserId = @userId AND Status = 'Active'
    `;

    const agentRequest = pool.request();
    agentRequest.input('userId', sql.UniqueIdentifier, userId);
    const agentResult = await agentRequest.query(agentQuery);

    if (agentResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Agent profile not found'
      });
    }

    const agentId = agentResult.recordset[0].AgentId;

    // Auto-materialize: ensure every Individual template the agent owns (that doesn't
    // already have a Marketing link) has a corresponding Agent-Static link. Templates
    // and links are deliberately separate in the schema and links are normally created
    // on demand via row actions in the Enrollment Links tab; this keeps the proposal
    // dropdown in sync with the tab for templates that haven't had their row actions
    // triggered yet. No-op after first call per template.
    const missingQ = `
      SELECT elt.TemplateId
      FROM oe.EnrollmentLinkTemplates elt
      WHERE elt.AgentId = @agentId
        AND elt.TemplateType = 'Individual'
        AND elt.IsActive = 1
        AND NOT EXISTS (
          SELECT 1 FROM oe.EnrollmentLinks el
          WHERE el.EnrollmentLinkTemplateId = elt.TemplateId
            AND el.AgentId = @agentId
            AND el.LinkType = 'Agent-Static'
            AND el.IsActive = 1
        )
        AND NOT EXISTS (
          SELECT 1 FROM oe.EnrollmentLinks el
          WHERE el.EnrollmentLinkTemplateId = elt.TemplateId
            AND el.LinkType = 'Marketing'
            AND el.IsActive = 1
        )
    `;
    const missingReq = pool.request();
    missingReq.input('agentId', sql.UniqueIdentifier, agentId);
    const missingResult = await missingReq.query(missingQ);

    if (missingResult.recordset.length > 0) {
      const nameReq = pool.request();
      nameReq.input('agentId', sql.UniqueIdentifier, agentId);
      const nameResult = await nameReq.query(`
        SELECT u.FirstName, u.LastName
        FROM oe.Agents a INNER JOIN oe.Users u ON a.UserId = u.UserId
        WHERE a.AgentId = @agentId
      `);
      const { FirstName: firstName, LastName: lastName } = nameResult.recordset[0] || {};

      const countReq = pool.request();
      countReq.input('agentId', sql.UniqueIdentifier, agentId);
      const countResult = await countReq.query(`
        SELECT COUNT(*) AS c FROM oe.EnrollmentLinks
        WHERE AgentId = @agentId AND LinkType = 'Agent-Static' AND IsActive = 1
      `);
      let existingCount = countResult.recordset[0].c;

      const baseUrl = req.get('origin') || `${req.protocol}://${req.get('host')}`;
      const baseCode = `ag_${ShortCodeService.normalize(firstName)}_${ShortCodeService.normalize(lastName)}`;

      for (const row of missingResult.recordset) {
        let shortCode;
        if (existingCount === 0) {
          shortCode = await ShortCodeService.generateAgentShortCode(firstName, lastName, pool);
        } else {
          let suffix = existingCount + 1;
          shortCode = `${baseCode}_${suffix}`;
          let attempts = 0;
          while (attempts < 20) {
            const checkReq = pool.request().input('code', sql.NVarChar, shortCode);
            const checkRes = await checkReq.query('SELECT ShortCode FROM oe.EnrollmentLinks WHERE ShortCode = @code');
            if (checkRes.recordset.length === 0) break;
            suffix++;
            shortCode = `${baseCode}_${suffix}`;
            attempts++;
          }
        }

        const linkToken = `enroll_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const linkId = require('crypto').randomUUID();
        const enrollmentUrl = `${baseUrl}/enroll-now/${shortCode}`;

        const insertReq = pool.request();
        insertReq.input('linkId', sql.UniqueIdentifier, linkId);
        insertReq.input('linkToken', sql.NVarChar, linkToken);
        insertReq.input('linkUrl', sql.NVarChar, enrollmentUrl);
        insertReq.input('shortCode', sql.NVarChar, shortCode);
        insertReq.input('description', sql.NVarChar, `Static enrollment link - ${firstName} ${lastName}`);
        insertReq.input('templateId', sql.UniqueIdentifier, row.TemplateId);
        insertReq.input('agentId', sql.UniqueIdentifier, agentId);
        insertReq.input('createdBy', sql.UniqueIdentifier, userId);
        await insertReq.query(`
          INSERT INTO oe.EnrollmentLinks (
            LinkId, GroupId, MemberId, LinkToken, LinkUrl, LinkType, ShortCode,
            Description, ExpiresAt, IsActive, UsageCount, MaxUsage,
            EnrollmentLinkTemplateId, AgentId,
            CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
          ) VALUES (
            @linkId, NULL, NULL, @linkToken, @linkUrl, 'Agent-Static', @shortCode,
            @description, NULL, 1, 0, NULL,
            @templateId, @agentId,
            GETUTCDATE(), GETUTCDATE(), @createdBy, @createdBy
          )
        `);

        existingCount++;
      }
    }

    // Get ALL static links with template information and usage statistics
    const linkQuery = `
      SELECT 
        el.LinkId,
        el.LinkToken,
        el.ShortCode,
        el.LinkUrl,
        el.Description,
        el.UsageCount,
        el.IsActive,
        el.CreatedDate,
        el.EnrollmentLinkTemplateId as TemplateId,
        elt.TemplateName,
        elt.TemplateType,
        elt.LinkMetaData,
        -- Get enrollment count from this link
        (SELECT COUNT(*) 
         FROM oe.Enrollments e 
         INNER JOIN oe.Members m ON e.MemberId = m.MemberId
         WHERE m.AgentId = el.AgentId 
           AND e.CreatedDate >= el.CreatedDate) as EnrollmentCount
      FROM oe.EnrollmentLinks el
      LEFT JOIN oe.EnrollmentLinkTemplates elt ON el.EnrollmentLinkTemplateId = elt.TemplateId
      WHERE el.AgentId = @agentId
        AND el.LinkType = 'Agent-Static'
        AND elt.TemplateType = 'Individual'
        AND el.IsActive = 1
      ORDER BY el.CreatedDate DESC
    `;

    const linkRequest = pool.request();
    linkRequest.input('agentId', sql.UniqueIdentifier, agentId);
    const linkResult = await linkRequest.query(linkQuery);

    if (linkResult.recordset.length === 0) {
      return res.json({
        success: true,
        data: [],
        message: 'No static enrollment links found'
      });
    }

    // Return array of all static links
    const staticLinks = linkResult.recordset.map(link => ({
      linkId: link.LinkId,
      linkToken: link.LinkToken,
      shortCode: link.ShortCode,
      enrollmentUrl: link.LinkUrl,
      description: link.Description,
      usageCount: link.UsageCount,
      enrollmentCount: link.EnrollmentCount,
      isActive: link.IsActive,
      createdDate: link.CreatedDate,
      templateId: link.TemplateId,
      template: {
        name: link.TemplateName,
        type: link.TemplateType,
        metadata: link.LinkMetaData
      }
    }));

    res.json({
      success: true,
      data: staticLinks
    });

  } catch (error) {
    console.error('❌ Error fetching static enrollment link:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch static enrollment link',
      error: {
        message: error.message,
        code: 'FETCH_STATIC_LINK_ERROR'
      }
    });
  }
});

/**
 * @route   POST /api/me/agent/enrollment-links/create-marketing
 * @desc    Create a marketing (reusable) enrollment link for an agent
 * @access  Private (Agent)
 */
router.post('/create-marketing', authorize(['Agent']), async (req, res) => {
  try {
    const { templateId } = req.body;
    const userId = req.user.UserId;

    console.log('🔍 Creating marketing enrollment link for agent:', { userId, templateId });

    // Validate required fields
    if (!templateId) {
      return res.status(400).json({
        success: false,
        message: 'Template ID is required'
      });
    }

    const pool = await getPool();

    // Get agent information
    const agentQuery = `
      SELECT 
        a.AgentId,
        a.TenantId,
        a.AgencyId,
        u.FirstName,
        u.LastName,
        u.Email
      FROM oe.Agents a
      INNER JOIN oe.Users u ON a.UserId = u.UserId
      WHERE a.UserId = @userId AND a.Status = 'Active'
    `;

    const agentRequest = pool.request();
    agentRequest.input('userId', sql.UniqueIdentifier, userId);
    const agentResult = await agentRequest.query(agentQuery);

    if (agentResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Agent profile not found'
      });
    }

    const agent = agentResult.recordset[0];

    // Verify template exists, belongs to agent's tenant; Marketing links support both Individual and Group templates
    const templateQuery = `
      SELECT TemplateId, TemplateName, TemplateType, TenantId, LinkMetaData, AgentId AS TemplateAgentId
      FROM oe.EnrollmentLinkTemplates
      WHERE TemplateId = @templateId
        AND TenantId = @tenantId
        AND TemplateType IN ('Individual', 'Group')
        AND IsActive = 1
    `;

    const templateRequest = pool.request();
    templateRequest.input('templateId', sql.UniqueIdentifier, templateId);
    templateRequest.input('tenantId', sql.UniqueIdentifier, agent.TenantId);
    const templateResult = await templateRequest.query(templateQuery);

    if (templateResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Template not found or not active.'
      });
    }

    const template = templateResult.recordset[0];

    // Resolve link agent: template may be for self or a downline agent
    let linkAgentId = template.TemplateAgentId || agent.AgentId;
    let linkFirstName = agent.FirstName;
    let linkLastName = agent.LastName;
    if (template.TemplateAgentId && template.TemplateAgentId !== agent.AgentId) {
      const allowed = await isUplineAncestor(pool, template.TemplateAgentId, agent.AgentId);
      if (!allowed) {
        return res.status(403).json({
          success: false,
          message: 'Template is for another agent; you can only create links for yourself or your downline.'
        });
      }
      const downlineReq = pool.request().input('agentId', sql.UniqueIdentifier, template.TemplateAgentId);
      const downlineRes = await downlineReq.query(`
        SELECT u.FirstName, u.LastName FROM oe.Agents a INNER JOIN oe.Users u ON a.UserId = u.UserId WHERE a.AgentId = @agentId
      `);
      if (downlineRes.recordset.length === 0) {
        return res.status(404).json({ success: false, message: 'Template agent not found.' });
      }
      linkFirstName = downlineRes.recordset[0].FirstName;
      linkLastName = downlineRes.recordset[0].LastName;
    }

    // Check if link owner already has a Marketing link for this template
    const existingLinkQuery = `
      SELECT LinkId, LinkToken, ShortCode, LinkUrl
      FROM oe.EnrollmentLinks
      WHERE AgentId = @agentId
        AND LinkType = 'Marketing'
        AND EnrollmentLinkTemplateId = @templateId
        AND IsActive = 1
    `;

    const existingLinkRequest = pool.request();
    existingLinkRequest.input('agentId', sql.UniqueIdentifier, linkAgentId);
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

    // Generate unique short code from link owner's name with marketing prefix
    const shortCode = await ShortCodeService.generateAgentShortCode(
      linkFirstName,
      linkLastName,
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
    createLinkRequest.input('groupId', sql.UniqueIdentifier, null); // No group for marketing
    createLinkRequest.input('memberId', sql.UniqueIdentifier, null); // No member for marketing
    createLinkRequest.input('linkToken', sql.NVarChar, linkToken);
    createLinkRequest.input('linkUrl', sql.NVarChar, enrollmentUrl);
    createLinkRequest.input('linkType', sql.NVarChar, 'Marketing');
    createLinkRequest.input('shortCode', sql.NVarChar, shortCode);
    createLinkRequest.input('description', sql.NVarChar, `Marketing enrollment link - ${linkFirstName} ${linkLastName}`);
    createLinkRequest.input('expiresAt', sql.DateTime2, null); // Never expires
    createLinkRequest.input('isActive', sql.Bit, true);
    createLinkRequest.input('usageCount', sql.Int, 0);
    createLinkRequest.input('maxUsage', sql.Int, null); // Unlimited usage
    createLinkRequest.input('templateId', sql.UniqueIdentifier, templateId);
    createLinkRequest.input('agentId', sql.UniqueIdentifier, linkAgentId);
    // DON'T set AgencyId - CHECK constraint requires AgentId OR AgencyId, not both
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
 * @route   GET /api/me/agent/enrollment-links/available-templates
 * @desc    Get agent's Individual enrollment link templates for static link dropdown
 * @access  Private (Agent)
 */
router.get('/available-templates', authorize(['Agent']), async (req, res) => {
  try {
    const userId = req.user.UserId;

    const pool = await getPool();

    // Get agent's tenant ID
    const agentQuery = `
      SELECT TenantId FROM oe.Agents 
      WHERE UserId = @userId AND Status = 'Active'
    `;

    const agentRequest = pool.request();
    agentRequest.input('userId', sql.UniqueIdentifier, userId);
    const agentResult = await agentRequest.query(agentQuery);

    if (agentResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Agent profile not found'
      });
    }

    const tenantId = agentResult.recordset[0].TenantId;

    // Get Individual templates for this tenant
    const templatesQuery = `
      SELECT 
        TemplateId,
        TemplateName,
        TemplateType,
        LinkMetaData,
        Description,
        CreatedDate,
        IsActive
      FROM oe.EnrollmentLinkTemplates
      WHERE TenantId = @tenantId
        AND TemplateType = 'Individual'
        AND IsActive = 1
      ORDER BY TemplateName
    `;

    const templatesRequest = pool.request();
    templatesRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
    const templatesResult = await templatesRequest.query(templatesQuery);

    console.log(`✅ Found ${templatesResult.recordset.length} Individual templates for agent`);

    res.json({
      success: true,
      data: templatesResult.recordset.map(template => ({
        templateId: template.TemplateId,
        templateName: template.TemplateName,
        templateType: template.TemplateType,
        description: template.Description,
        linkMetaData: template.LinkMetaData ? JSON.parse(template.LinkMetaData) : null,
        createdDate: template.CreatedDate,
        isActive: template.IsActive
      }))
    });

  } catch (error) {
    console.error('❌ Error fetching enrollment link templates:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch enrollment link templates',
      error: {
        message: error.message,
        code: 'FETCH_TEMPLATES_ERROR'
      }
    });
  }
});

module.exports = router;

