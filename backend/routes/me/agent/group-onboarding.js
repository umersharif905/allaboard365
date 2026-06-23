const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authorize, getUserRoles } = require('../../../middleware/auth');
const requireTenantAccess = require('../../../middleware/requireTenantAccess');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const MessageQueueService = require('../../../services/messageQueue.service');
const appConfig = require('../../../config/app');
const { DEFAULT_LINK_EXPIRATION_HOURS } = require('../../../constants/linkExpiration');
const { appendGroupScopeForTenantUsers } = require('../../../utils/groupRouteAccess');

// GET /api/me/agent/groups/:groupId/onboarding-links
// Get all onboarding links for a specific group
router.get('/groups/:groupId/onboarding-links', authorize(['Agent', 'TenantAdmin', 'SysAdmin', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId } = req.params;
    const pool = await getPool();
    
    // Verify group access
    let groupQuery = `
      SELECT g.GroupId, g.Name, g.TenantId
      FROM oe.Groups g
      WHERE g.GroupId = @groupId AND g.Status = 'Active'
    `;
    
    const groupRequest = pool.request();
    groupRequest.input('groupId', sql.UniqueIdentifier, groupId);
    
    const userRoles = getUserRoles(req.user);
    groupQuery = appendGroupScopeForTenantUsers(groupQuery, groupRequest, req, userRoles);
    
    const groupResult = await groupRequest.query(groupQuery);
    
    if (groupResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Group not found or access denied'
      });
    }
    
    // Get onboarding links for this group
    const linksQuery = `
      SELECT 
        gol.LinkId,
        gol.GroupId,
        gol.LinkToken,
        gol.Status,
        gol.ExpiresAt,
        gol.CreatedDate,
        gol.UsedDate,
        gol.CreatedBy,
        gol.UsedBy,
        gol.RecipientEmail,
        gol.RecipientName,
        u.FirstName + ' ' + u.LastName as CreatedByName,
        u2.FirstName + ' ' + u2.LastName as UsedByName
      FROM oe.GroupOnboardingLinks gol
      LEFT JOIN oe.Agents a ON gol.CreatedBy = a.AgentId
      LEFT JOIN oe.Users u ON a.UserId = u.UserId
      LEFT JOIN oe.Users u2 ON gol.UsedBy = u2.UserId
      WHERE gol.GroupId = @groupId
      ORDER BY gol.CreatedDate DESC
    `;
    
    const linksRequest = pool.request();
    linksRequest.input('groupId', sql.UniqueIdentifier, groupId);
    
    const linksResult = await linksRequest.query(linksQuery);
    
    // Transform the data for frontend
    const links = linksResult.recordset.map(link => ({
      linkId: link.LinkId,
      groupId: link.GroupId,
      linkToken: link.LinkToken,
      status: link.Status,
      expiresAt: link.ExpiresAt,
      createdDate: link.CreatedDate,
      usedDate: link.UsedDate,
      createdBy: link.CreatedBy,
      usedBy: link.UsedBy,
      recipientEmail: link.RecipientEmail,
      recipientName: link.RecipientName,
      createdByName: link.CreatedByName,
      usedByName: link.UsedByName
    }));
    
    res.json({
      success: true,
      data: links
    });
    
  } catch (error) {
    console.error('❌ Error fetching onboarding links:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching onboarding links'
    });
  }
});

// POST /api/me/agent/groups/:groupId/onboarding-links
// Create or update the single onboarding link for a group
router.post('/groups/:groupId/onboarding-links', authorize(['Agent', 'TenantAdmin', 'SysAdmin', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    console.log('🚀 POST /groups/:groupId/onboarding-links - Route reached!');
    console.log('📊 Request params:', req.params);
    console.log('📊 Request body:', req.body);
    console.log('📊 User from req.user:', req.user);
    const { groupId } = req.params;
    const { sendEmail, groupAdminEmail, groupAdminName, linkBaseUrl: linkBaseUrlOverride } = req.body;
    
    console.log('🔍 Extracted values:', {
      groupId,
      sendEmail,
      groupAdminEmail,
      groupAdminName
    });
    const pool = await getPool();
    
    // Verify group access
    let groupQuery = `
      SELECT g.GroupId, g.Name, g.TenantId, g.ContactEmail, g.PrimaryContact, g.AgentId
      FROM oe.Groups g
      WHERE g.GroupId = @groupId AND g.Status = 'Active'
    `;
    
    const groupRequest = pool.request();
    groupRequest.input('groupId', sql.UniqueIdentifier, groupId);
    
    const userRoles = getUserRoles(req.user);
    groupQuery = appendGroupScopeForTenantUsers(groupQuery, groupRequest, req, userRoles);
    
    const groupResult = await groupRequest.query(groupQuery);
    
    if (groupResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Group not found or access denied'
      });
    }
    
    const group = groupResult.recordset[0];
    
    // Fetch tenant's custom domain for URL construction
    const tenantQuery = `
      SELECT 
        t.CustomDomain,
        json_value(t.AdvancedSettings, '$.domain.customDomain') as CustomDomainFromJson
      FROM oe.Tenants t
      WHERE t.TenantId = @tenantId
    `;
    
    const tenantRequest = pool.request();
    tenantRequest.input('tenantId', sql.UniqueIdentifier, group.TenantId);
    const tenantResult = await tenantRequest.query(tenantQuery);
    
    // Get custom domain (prefer direct field, fallback to JSON, then to default)
    const customDomain = tenantResult.recordset[0]?.CustomDomain || 
                        tenantResult.recordset[0]?.CustomDomainFromJson || 
                        null;
    
    console.log('🌐 Tenant custom domain:', customDomain);
    
    // Get AgentId for the onboarding link creation
    let agentId = null;
    
    // First, try to find an existing agent record for the current user
    const agentQuery = `
      SELECT AgentId FROM oe.Agents 
      WHERE UserId = @userId
    `;
    
    const agentRequest = pool.request();
    agentRequest.input('userId', sql.UniqueIdentifier, req.user.UserId);
    
    console.log('🔍 Looking for agent with UserId:', req.user.UserId);
    const agentResult = await agentRequest.query(agentQuery);
    console.log('🔍 Agent query result:', agentResult.recordset.length, 'records');
    
    if (agentResult.recordset.length > 0) {
      // User already has an agent record
      agentId = agentResult.recordset[0].AgentId;
      console.log('✅ Found existing agent record:', agentId);
    } else {
      // User doesn't have an agent record, use the group's AgentId if it exists
      console.log('🔍 No existing agent record, checking group\'s AgentId');
      
      if (group.AgentId) {
        // Use the group's assigned agent
        agentId = group.AgentId;
        console.log('✅ Using group\'s AgentId:', agentId);
      } else {
        // No agent available - this shouldn't happen for a valid group
        console.log('❌ No agent found for UserId and group has no AgentId');
        return res.status(400).json({
          success: false,
          message: 'No agent associated with this group or user account',
          debug: {
            userId: req.user.UserId,
            userRole: getUserRoles(req.user),
            groupId: groupId,
            groupAgentId: group.AgentId
          }
        });
      }
    }
    
    // Recipient email checks (same tenant as the group)
    if (groupAdminEmail) {
      const normalizedEmail = String(groupAdminEmail).trim();
      const tenantId = group.TenantId;

      // Already registered as an agent for this tenant — cannot use for group-admin onboarding
      const agentEmailReq = pool.request();
      agentEmailReq.input('email', sql.NVarChar, normalizedEmail);
      agentEmailReq.input('tenantId', sql.UniqueIdentifier, tenantId);
      const agentEmailResult = await agentEmailReq.query(`
        SELECT a.AgentId
        FROM oe.Users u
        INNER JOIN oe.Agents a ON a.UserId = u.UserId
        WHERE LOWER(LTRIM(ISNULL(u.Email, N''))) = LOWER(LTRIM(@email))
          AND a.TenantId = @tenantId
      `);
      if (agentEmailResult.recordset.length > 0) {
        return res.status(400).json({
          success: false,
          message:
            'This email is already registered as an agent for this tenant. Group onboarding invites must go to someone who is not already an agent. Use a different email or have that person sign in with their agent account.',
          code: 'RECIPIENT_EMAIL_IS_AGENT'
        });
      }

      const existingUserQuery = `
        SELECT u.UserId, m.GroupId, g.Name as GroupName
        FROM oe.Users u
        LEFT JOIN oe.Members m ON u.UserId = m.UserId
        LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
        WHERE LOWER(LTRIM(ISNULL(u.Email, N''))) = LOWER(LTRIM(@email))
          AND u.TenantId = @tenantId
      `;

      const existingUserRequest = pool.request();
      existingUserRequest.input('email', sql.NVarChar, normalizedEmail);
      existingUserRequest.input('tenantId', sql.UniqueIdentifier, tenantId);

      const existingUserResult = await existingUserRequest.query(existingUserQuery);

      if (existingUserResult.recordset.length > 0) {
        const rows = existingUserResult.recordset;
        const gidStr = String(groupId).toLowerCase();
        const conflictOtherGroup = rows.find(
          (r) => r.GroupId && String(r.GroupId).toLowerCase() !== gidStr
        );
        if (conflictOtherGroup) {
          return res.status(400).json({
            success: false,
            message: `Cannot send onboarding link. The email ${groupAdminEmail} is already associated with group "${conflictOtherGroup.GroupName}".`,
            data: {
              existingGroupId: conflictOtherGroup.GroupId,
              existingGroupName: conflictOtherGroup.GroupName,
              targetGroupId: groupId,
              targetGroupName: group.Name
            },
            code: 'RECIPIENT_EMAIL_OTHER_GROUP'
          });
        }
        const memberOfThisGroup = rows.some(
          (r) => r.GroupId && String(r.GroupId).toLowerCase() === gidStr
        );
        if (!memberOfThisGroup) {
          return res.status(400).json({
            success: false,
            message:
              'This email is already registered in Open Enroll for this tenant (not as a member of this group). Use a different email for the group admin onboarding invite, or sign in with that existing account.',
            code: 'RECIPIENT_EMAIL_EXISTS_IN_TENANT'
          });
        }
      }
    }
    
    // Check if there's already an existing link for this group
    const existingLinkQuery = `
      SELECT gol.LinkId, gol.LinkToken, gol.Status, gol.ExpiresAt, gol.CreatedDate
      FROM oe.GroupOnboardingLinks gol
      WHERE gol.GroupId = @groupId
      ORDER BY gol.CreatedDate DESC
    `;
    
    const existingLinkRequest = pool.request();
    existingLinkRequest.input('groupId', sql.UniqueIdentifier, groupId);
    
    const existingLinkResult = await existingLinkRequest.query(existingLinkQuery);
    
    let linkId, linkToken, expiresAt;
    
    if (existingLinkResult.recordset.length > 0) {
      // Update existing link with fresh expiration
      const existingLink = existingLinkResult.recordset[0];
      linkId = existingLink.LinkId;
      linkToken = existingLink.LinkToken;
      expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + DEFAULT_LINK_EXPIRATION_HOURS);
      
      const updateLinkQuery = `
        UPDATE oe.GroupOnboardingLinks 
        SET Status = 'Active', ExpiresAt = @expiresAt, CreatedDate = @createdDate
        WHERE LinkId = @linkId AND GroupId = @groupId
      `;
      
      const updateRequest = pool.request();
      updateRequest.input('linkId', sql.UniqueIdentifier, linkId);
      updateRequest.input('groupId', sql.UniqueIdentifier, groupId);
      updateRequest.input('expiresAt', sql.DateTime2, expiresAt);
      updateRequest.input('createdDate', sql.DateTime2, new Date());
      
      await updateRequest.query(updateLinkQuery);
      
      console.log('✅ Updated existing onboarding link with fresh expiration');
    } else {
      // Create new link
      linkToken = crypto.randomBytes(32).toString('hex');
      linkId = uuidv4();
      expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + DEFAULT_LINK_EXPIRATION_HOURS);
      
      const createLinkQuery = `
        INSERT INTO oe.GroupOnboardingLinks (
          LinkId, GroupId, LinkToken, Status, ExpiresAt, CreatedDate, CreatedBy, RecipientEmail, RecipientName
        ) VALUES (
          @linkId, @groupId, @linkToken, @status, @expiresAt, @createdDate, @createdBy, @recipientEmail, @recipientName
        )
      `;
      
      const createRequest = pool.request();
      createRequest.input('linkId', sql.UniqueIdentifier, linkId);
      createRequest.input('groupId', sql.UniqueIdentifier, groupId);
      createRequest.input('linkToken', sql.NVarChar, linkToken);
      createRequest.input('status', sql.NVarChar, 'Active');
      createRequest.input('expiresAt', sql.DateTime2, expiresAt);
      createRequest.input('createdDate', sql.DateTime2, new Date());
      createRequest.input('createdBy', sql.UniqueIdentifier, agentId);
      const recipientEmail = groupAdminEmail || group.ContactEmail;
      const recipientName = groupAdminName || group.PrimaryContact;
      
      console.log('🔍 Database insert values:', {
        recipientEmail,
        recipientName,
        groupAdminEmail,
        groupAdminName,
        groupContactEmail: group.ContactEmail,
        groupPrimaryContact: group.PrimaryContact
      });
      
      createRequest.input('recipientEmail', sql.NVarChar, recipientEmail);
      createRequest.input('recipientName', sql.NVarChar, recipientName);
      
      console.log('🔍 About to execute SQL with parameters:', {
        linkId,
        groupId,
        linkToken,
        status: 'Active',
        expiresAt,
        createdDate: new Date(),
        createdBy: agentId,
        recipientEmail,
        recipientName
      });
      
      await createRequest.query(createLinkQuery);
      
      console.log('✅ Created new onboarding link');
    }
    
    // Store recipient information for response
    const recipientEmail = groupAdminEmail || group.ContactEmail;
    const recipientName = groupAdminName || group.PrimaryContact;
    
    // Send onboarding invitation email if requested
    let emailResult = null;
    if (sendEmail && groupAdminEmail) {
      try {
        // Build the onboarding URL: optional override (e.g. from localhost domain selector), then tenant custom domain, then referer, then default
        let baseUrl;
        if (linkBaseUrlOverride && typeof linkBaseUrlOverride === 'string' && linkBaseUrlOverride.trim()) {
          baseUrl = linkBaseUrlOverride.trim().replace(/\/$/, '');
        } else if (customDomain) {
          baseUrl = `https://${customDomain}`;
        } else {
          const referer = req.get('referer') || req.get('origin');
          if (referer) {
            const refererUrl = new URL(referer);
            baseUrl = `${refererUrl.protocol}//${refererUrl.hostname}${refererUrl.port ? ':' + refererUrl.port : ''}`;
          } else {
            baseUrl = appConfig.urls.getDefaultAppUrl();
          }
        }
        const onboardingUrl = `${baseUrl}/group-onboarding/${linkToken}`;
        console.log('🌐 Generated onboarding URL:', onboardingUrl);
        
        const messageId = await MessageQueueService.sendOnboardingInvitation({
          tenantId: group.TenantId,
          groupId: groupId,
          groupName: group.Name,
          contactEmail: groupAdminEmail,
          contactFirstName: recipientName || 'Contact',
          onboardingUrl: onboardingUrl,
          createdBy: req.user.UserId
        });
        console.log(`✅ Queued onboarding email for ${groupAdminEmail}: ${messageId}`);
        emailResult = { messageId, success: true };
      } catch (error) {
        console.error(`❌ Failed to queue onboarding email for ${groupAdminEmail}:`, error);
        emailResult = { error: error.message, success: false };
      }
    }

    // If caller asked to send email and queueing failed, do not report success (no side effects on users, but UI must not show "sent")
    if (sendEmail && groupAdminEmail && emailResult && emailResult.success === false) {
      return res.status(503).json({
        success: false,
        message: emailResult.error || 'Failed to queue onboarding email. Try again or copy the link manually.',
        code: 'ONBOARDING_EMAIL_QUEUE_FAILED',
        data: {
          linkId,
          linkToken,
          expiresAt,
          groupName: group.Name,
          groupAdminEmail: recipientEmail,
          groupAdminName: recipientName
        },
        emailResult
      });
    }

    res.json({
      success: true,
      data: {
        linkId,
        linkToken,
        expiresAt,
        groupName: group.Name,
        groupAdminEmail: recipientEmail,
        groupAdminName: recipientName,
        recipientEmail: recipientEmail,
        recipientName: recipientName
      },
      message: `Onboarding link created/updated successfully${emailResult?.success ? ' and email queued' : emailResult?.error ? ' but email failed' : ''}`,
      emailResult
    });
    
  } catch (error) {
    console.error('❌ Error creating/updating onboarding link:', error);
    console.error('❌ Error details:', {
      message: error.message,
      stack: error.stack,
      groupId: req.params.groupId,
      body: req.body
    });
    res.status(500).json({
      success: false,
      message: 'Server error while creating/updating onboarding link',
      error: {
        message: error.message,
        stack: error.stack,
        details: 'Check backend logs for full details'
      }
    });
  }
});

// GET /api/me/agent/groups/:groupId/onboarding-status
// Get onboarding completion status for a group
router.get('/groups/:groupId/onboarding-status', authorize(['Agent', 'TenantAdmin', 'SysAdmin', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId } = req.params;
    const pool = await getPool();
    
    // Verify group access
    let groupQuery = `
      SELECT g.GroupId, g.Name, g.TenantId, g.PrimaryContact, g.ContactEmail
      FROM oe.Groups g
      WHERE g.GroupId = @groupId AND g.Status = 'Active'
    `;
    
    const groupRequest = pool.request();
    groupRequest.input('groupId', sql.UniqueIdentifier, groupId);
    
    const userRoles = getUserRoles(req.user);
    groupQuery = appendGroupScopeForTenantUsers(groupQuery, groupRequest, req, userRoles);
    
    const groupResult = await groupRequest.query(groupQuery);
    
    if (groupResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Group not found or access denied'
      });
    }
    
    // Check if group has completed onboarding (has a GroupAdmin user)
    const onboardingQuery = `
      SELECT 
        u.UserId,
        u.FirstName,
        u.LastName,
        u.Email,
        gol.UsedDate as OnboardingCompletedDate
      FROM oe.Users u
      INNER JOIN oe.GroupOnboardingLinks gol ON u.UserId = gol.UsedBy
      WHERE gol.GroupId = @groupId AND gol.Status = 'Used'
      ORDER BY gol.UsedDate DESC
    `;
    
    const onboardingRequest = pool.request();
    onboardingRequest.input('groupId', sql.UniqueIdentifier, groupId);
    
    const onboardingResult = await onboardingRequest.query(onboardingQuery);
    let markedComplete = false;
    try {
      const markedReq = pool.request().input('groupId', sql.UniqueIdentifier, groupId);
      const markedRes = await markedReq.query('SELECT ISNULL(OnboardingMarkedComplete, 0) as OnboardingMarkedComplete FROM oe.Groups WHERE GroupId = @groupId');
      if (markedRes.recordset.length > 0) {
        const v = markedRes.recordset[0].OnboardingMarkedComplete;
        markedComplete = v === true || v === 1;
      }
    } catch (_) {
      // Column may not exist before migration
    }
    const isOnboarded = onboardingResult.recordset.length > 0 || markedComplete;
    const groupAdmin = isOnboarded && onboardingResult.recordset.length > 0 ? onboardingResult.recordset[0] : null;
    
    // Get the current onboarding link (most recent one)
    const currentLinkQuery = `
      SELECT 
        gol.LinkId,
        gol.GroupId,
        gol.LinkToken,
        gol.Status,
        gol.ExpiresAt,
        gol.CreatedDate,
        gol.UsedDate,
        gol.CreatedBy,
        gol.UsedBy,
        gol.RecipientEmail,
        gol.RecipientName,
        u.FirstName + ' ' + u.LastName as CreatedByName,
        u2.FirstName + ' ' + u2.LastName as UsedByName
      FROM oe.GroupOnboardingLinks gol
      LEFT JOIN oe.Agents a ON gol.CreatedBy = a.AgentId
      LEFT JOIN oe.Users u ON a.UserId = u.UserId
      LEFT JOIN oe.Users u2 ON gol.UsedBy = u2.UserId
      WHERE gol.GroupId = @groupId
      ORDER BY gol.CreatedDate DESC
    `;
    
    const currentLinkRequest = pool.request();
    currentLinkRequest.input('groupId', sql.UniqueIdentifier, groupId);
    
    const currentLinkResult = await currentLinkRequest.query(currentLinkQuery);
    
    let currentLink = null;
    if (currentLinkResult.recordset.length > 0) {
      const link = currentLinkResult.recordset[0];
      const group = groupResult.recordset[0];
      currentLink = {
        linkId: link.LinkId,
        groupId: link.GroupId,
        linkToken: link.LinkToken,
        status: link.Status,
        expiresAt: link.ExpiresAt,
        createdDate: link.CreatedDate,
        usedDate: link.UsedDate,
        createdBy: link.CreatedBy,
        usedBy: link.UsedBy,
        recipientEmail: link.RecipientEmail, // Only show stored recipient email
        recipientName: link.RecipientName, // Only show stored recipient name
        createdByName: link.CreatedByName,
        usedByName: link.UsedByName
      };
    }
    
    res.json({
      success: true,
      data: {
        isOnboarded,
        groupAdmin,
        completedDate: groupAdmin?.OnboardingCompletedDate || null,
        currentLink
      }
    });
    
  } catch (error) {
    console.error('❌ Error fetching onboarding status:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching onboarding status'
    });
  }
});

// POST /api/me/agent/groups/:groupId/onboarding-status/mark-complete
// Manually mark group onboarding as complete (Agent/TenantAdmin/SysAdmin)
router.post('/groups/:groupId/onboarding-status/mark-complete', authorize(['Agent', 'TenantAdmin', 'SysAdmin', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req.user?.UserId;
    const pool = await getPool();

    let groupQuery = `
      SELECT g.GroupId FROM oe.Groups g
      WHERE g.GroupId = @groupId AND g.Status = 'Active'
    `;
    const groupRequest = pool.request();
    groupRequest.input('groupId', sql.UniqueIdentifier, groupId);
    const userRoles = getUserRoles(req.user);
    if (!userRoles.includes('SysAdmin')) {
      groupQuery += ' AND g.TenantId = @userTenantId';
      groupRequest.input('userTenantId', sql.UniqueIdentifier, req.tenantId);
    }
    const groupResult = await groupRequest.query(groupQuery);
    if (groupResult.recordset.length === 0) {
      return res.status(404).json({ success: false, message: 'Group not found or access denied' });
    }

    const updateRequest = pool.request();
    updateRequest.input('groupId', sql.UniqueIdentifier, groupId);
    updateRequest.input('userId', sql.UniqueIdentifier, userId);
    await updateRequest.query(`
      UPDATE oe.Groups
      SET OnboardingMarkedComplete = 1,
          OnboardingMarkedCompleteAt = GETUTCDATE(),
          OnboardingMarkedCompleteBy = @userId
      WHERE GroupId = @groupId
    `);

    res.json({ success: true, message: 'Onboarding marked as complete' });
  } catch (error) {
    console.error('❌ Error marking onboarding complete:', error);
    res.status(500).json({ success: false, message: 'Server error while marking onboarding complete' });
  }
});

// POST /api/me/agent/groups/:groupId/onboarding-links/resend
// Resend the onboarding link (update expiration)
router.post('/groups/:groupId/onboarding-links/resend', authorize(['Agent', 'TenantAdmin', 'SysAdmin', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId } = req.params;
    const pool = await getPool();
    
    // Verify group access
    let groupQuery = `
      SELECT g.GroupId, g.Name, g.TenantId
      FROM oe.Groups g
      WHERE g.GroupId = @groupId AND g.Status = 'Active'
    `;
    
    const groupRequest = pool.request();
    groupRequest.input('groupId', sql.UniqueIdentifier, groupId);
    
    // Add tenant filtering for non-SysAdmin users
    const userRoles = getUserRoles(req.user);
    if (!userRoles.includes('SysAdmin')) {
      groupQuery += ' AND g.TenantId = @userTenantId';
      groupRequest.input('userTenantId', sql.UniqueIdentifier, req.tenantId);
    }
    
    const groupResult = await groupRequest.query(groupQuery);
    
    if (groupResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Group not found or access denied'
      });
    }
    
    // Get the current onboarding link
    const currentLinkQuery = `
      SELECT gol.LinkId, gol.LinkToken, gol.Status, gol.ExpiresAt
      FROM oe.GroupOnboardingLinks gol
      WHERE gol.GroupId = @groupId
      ORDER BY gol.CreatedDate DESC
    `;
    
    const currentLinkRequest = pool.request();
    currentLinkRequest.input('groupId', sql.UniqueIdentifier, groupId);
    
    const currentLinkResult = await currentLinkRequest.query(currentLinkQuery);
    
    if (currentLinkResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No onboarding link found for this group'
      });
    }
    
    const currentLink = currentLinkResult.recordset[0];
    
    // Update the link with fresh expiration
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + DEFAULT_LINK_EXPIRATION_HOURS);
    
    const updateLinkQuery = `
      UPDATE oe.GroupOnboardingLinks 
      SET Status = 'Active', ExpiresAt = @expiresAt, CreatedDate = @createdDate
      WHERE LinkId = @linkId AND GroupId = @groupId
    `;
    
    const updateRequest = pool.request();
    updateRequest.input('linkId', sql.UniqueIdentifier, currentLink.LinkId);
    updateRequest.input('groupId', sql.UniqueIdentifier, groupId);
    updateRequest.input('expiresAt', sql.DateTime2, expiresAt);
    updateRequest.input('createdDate', sql.DateTime2, new Date());
    
    await updateRequest.query(updateLinkQuery);
    
    res.json({
      success: true,
      data: {
        linkId: currentLink.LinkId,
        linkToken: currentLink.LinkToken,
        expiresAt,
        groupName: groupResult.recordset[0].Name
      },
      message: 'Onboarding link resent successfully'
    });
    
  } catch (error) {
    console.error('❌ Error resending onboarding link:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while resending onboarding link'
    });
  }
});

// DELETE /api/me/agent/groups/:groupId/onboarding-links/:linkId
// Invalidate/delete an onboarding link
router.delete('/groups/:groupId/onboarding-links/:linkId', authorize(['Agent', 'TenantAdmin', 'SysAdmin', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { groupId, linkId } = req.params;
    const pool = await getPool();
    
    // Verify group access
    let groupQuery = `
      SELECT g.GroupId, g.Name, g.TenantId
      FROM oe.Groups g
      WHERE g.GroupId = @groupId AND g.Status = 'Active'
    `;
    
    const groupRequest = pool.request();
    groupRequest.input('groupId', sql.UniqueIdentifier, groupId);
    
    const userRoles = getUserRoles(req.user);
    groupQuery = appendGroupScopeForTenantUsers(groupQuery, groupRequest, req, userRoles);
    
    const groupResult = await groupRequest.query(groupQuery);
    
    if (groupResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Group not found or access denied'
      });
    }
    
    // Check if the link exists and belongs to this group
    const linkQuery = `
      SELECT gol.LinkId, gol.Status, gol.UsedDate
      FROM oe.GroupOnboardingLinks gol
      WHERE gol.LinkId = @linkId AND gol.GroupId = @groupId
    `;
    
    const linkRequest = pool.request();
    linkRequest.input('linkId', sql.UniqueIdentifier, linkId);
    linkRequest.input('groupId', sql.UniqueIdentifier, groupId);
    
    const linkResult = await linkRequest.query(linkQuery);
    
    if (linkResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Onboarding link not found'
      });
    }
    
    const link = linkResult.recordset[0];
    
    // Don't allow deletion of already used links
    if (link.Status === 'Used') {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete an onboarding link that has already been used'
      });
    }
    
    // Update the link status to 'Expired' to invalidate it
    const updateQuery = `
      UPDATE oe.GroupOnboardingLinks 
      SET Status = 'Expired'
      WHERE LinkId = @linkId AND GroupId = @groupId
    `;
    
    const updateRequest = pool.request();
    updateRequest.input('linkId', sql.UniqueIdentifier, linkId);
    updateRequest.input('groupId', sql.UniqueIdentifier, groupId);
    
    await updateRequest.query(updateQuery);
    
    res.json({
      success: true,
      message: 'Onboarding link invalidated successfully'
    });
    
  } catch (error) {
    console.error('❌ Error invalidating onboarding link:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while invalidating onboarding link',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router;