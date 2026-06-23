const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../config/database');
const { authorize: authMiddleware, getUserRoles } = require('../../middleware/auth');
const requireTenantAccess = require('../../middleware/requireTenantAccess');
const { EnrollmentLinkService } = require('../../services/shared');
const { DEFAULT_LINK_EXPIRATION_HOURS } = require('../../constants/linkExpiration');

const ACTIVE_ENROLLMENT_SQL = `
  SELECT COUNT(1) AS activeCount
  FROM oe.Enrollments e
  WHERE e.MemberId = @memberId
    AND e.Status = 'Active'
    AND (e.EffectiveDate IS NULL OR CAST(e.EffectiveDate AS date) <= CAST(GETUTCDATE() AS date))
    AND (e.TerminationDate IS NULL OR CAST(e.TerminationDate AS date) >= CAST(GETUTCDATE() AS date))
`;

async function getMemberEligibilityForLink(pool, memberId, tenantId) {
  const memberReq = pool.request();
  memberReq.input('memberId', sql.UniqueIdentifier, memberId);
  memberReq.input('tenantId', sql.UniqueIdentifier, tenantId);
  const memberRes = await memberReq.query(`
    SELECT TOP 1
      m.MemberId,
      m.GroupId,
      m.Status,
      u.Email,
      u.FirstName,
      u.LastName,
      u.PhoneNumber
    FROM oe.Members m
    INNER JOIN oe.Users u ON u.UserId = m.UserId
    WHERE m.MemberId = @memberId
      AND m.TenantId = @tenantId
  `);

  if (memberRes.recordset.length === 0) return null;

  const member = memberRes.recordset[0];
  const activeReq = pool.request();
  activeReq.input('memberId', sql.UniqueIdentifier, member.MemberId);
  const activeRes = await activeReq.query(ACTIVE_ENROLLMENT_SQL);
  const activeCount = Number(activeRes.recordset?.[0]?.activeCount || 0);
  const hasActiveEnrollments = activeCount > 0;
  const inGroup = !!member.GroupId;
  const canSend = !inGroup && !hasActiveEnrollments;

  return {
    memberId: member.MemberId,
    email: member.Email,
    firstName: member.FirstName,
    lastName: member.LastName,
    phoneNumber: member.PhoneNumber || null,
    groupId: member.GroupId || null,
    status: member.Status,
    hasActiveEnrollments,
    canSend
  };
}

// Search existing members for quick-send existing-member option
router.get('/member-search', authMiddleware(['Agent', 'SysAdmin', 'TenantAdmin', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const query = String(req.query.query || '').trim();
    const tenantId = req.tenantId;

    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant context is required' });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input('tenantId', sql.UniqueIdentifier, tenantId);
    request.input('query', sql.NVarChar, `%${query}%`);

    const result = await request.query(`
      SELECT TOP 50
        m.MemberId,
        m.GroupId,
        m.Status,
        u.Email,
        u.FirstName,
        u.LastName,
        u.PhoneNumber
      FROM oe.Members m
      INNER JOIN oe.Users u ON u.UserId = m.UserId
      WHERE m.TenantId = @tenantId
        AND (
          @query = '%%'
          OR u.Email LIKE @query
          OR u.FirstName LIKE @query
          OR u.LastName LIKE @query
          OR (u.FirstName + ' ' + u.LastName) LIKE @query
        )
      ORDER BY u.LastName, u.FirstName
    `);

    return res.json({
      success: true,
      data: result.recordset || []
    });
  } catch (error) {
    console.error('❌ member-search error:', error);
    return res.status(500).json({ success: false, message: 'Failed to search members' });
  }
});

// Resolve manual email/member selection into an eligible recipient for quick-send
router.post('/resolve-recipient', authMiddleware(['Agent', 'SysAdmin', 'TenantAdmin', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { email, memberId } = req.body || {};
    const tenantId = req.tenantId;

    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant context is required' });
    }

    const pool = await getPool();

    if (memberId) {
      const resolved = await getMemberEligibilityForLink(pool, memberId, tenantId);
      if (!resolved) {
        return res.status(404).json({ success: false, message: 'Member not found in this tenant' });
      }

      if (!resolved.canSend) {
        return res.json({
          success: true,
          data: {
            mode: 'existingMember',
            canSend: false,
            reason: resolved.groupId
              ? 'This member is associated with a group and cannot receive an individual static link.'
              : 'This member already has active enrollments and cannot receive a new enrollment link.',
            member: resolved
          }
        });
      }

      return res.json({
        success: true,
        data: { mode: 'existingMember', canSend: true, member: resolved }
      });
    }

    if (!email || !String(email).trim()) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }

    const lookupReq = pool.request();
    lookupReq.input('tenantId', sql.UniqueIdentifier, tenantId);
    lookupReq.input('email', sql.NVarChar, String(email).trim());
    const lookupRes = await lookupReq.query(`
      SELECT TOP 1 m.MemberId
      FROM oe.Users u
      INNER JOIN oe.Members m ON m.UserId = u.UserId
      WHERE m.TenantId = @tenantId
        AND u.Email = @email
      ORDER BY
        CASE WHEN m.Status = 'Active' THEN 0 WHEN m.Status = 'Pending Payment' THEN 1 ELSE 2 END,
        m.ModifiedDate DESC
    `);

    if (lookupRes.recordset.length === 0) {
      return res.json({
        success: true,
        data: { mode: 'newMember', canSend: true, member: null }
      });
    }

    const existingMemberId = lookupRes.recordset[0].MemberId;
    const resolved = await getMemberEligibilityForLink(pool, existingMemberId, tenantId);
    if (!resolved) {
      return res.json({
        success: true,
        data: { mode: 'newMember', canSend: true, member: null }
      });
    }

    if (!resolved.canSend) {
      return res.json({
        success: true,
        data: {
          mode: 'existingMember',
          canSend: false,
          reason: resolved.groupId
            ? 'This email belongs to a member associated with a group and cannot receive an individual static link.'
            : 'This email belongs to a member with active enrollments. A new link cannot be sent.',
          member: resolved
        }
      });
    }

    return res.json({
      success: true,
      data: { mode: 'existingMember', canSend: true, member: resolved }
    });
  } catch (error) {
    console.error('❌ resolve-recipient error:', error);
    return res.status(500).json({ success: false, message: 'Failed to resolve recipient' });
  }
});

/**
 * POST /api/me/enrollment-links/send-individual - Send individual enrollment link to a member
 * This endpoint requires authentication and is used by authenticated users to send enrollment links
 */
router.post('/send-individual', authMiddleware(['Agent', 'SysAdmin', 'TenantAdmin', 'GroupAdmin']), requireTenantAccess, async (req, res) => {
  console.log('🔍 DEBUG: send-individual endpoint called');
  console.log('🔍 DEBUG: Request body:', req.body);
  console.log('🔍 DEBUG: Request headers:', req.headers);
  
  try {
    const { memberId, templateId, effectiveDate, groupId, deliveryPreferences, phoneNumber, copyOnly, linkBaseUrl, confirmInvalidate, attestSmsConsent } = req.body;
    
    // If copyOnly is true, skip sending email/SMS and just return the link
    let sendEmail, sendSMS;
    if (copyOnly) {
      // Set both to false to skip sending
      sendEmail = false;
      sendSMS = false;
    } else {
      // Default to email if not specified
      sendEmail = deliveryPreferences?.sendEmail !== false; // Default true
      sendSMS = deliveryPreferences?.sendSMS === true;
      
      // Validate that at least one delivery method is selected (only if not copyOnly)
      if (!sendEmail && !sendSMS) {
        return res.status(400).json({
          success: false,
          message: 'At least one delivery method (email or SMS) must be selected'
        });
      }
    }
    
    console.log('🔍 DEBUG: Extracted values:', { memberId, templateId, effectiveDate, groupId, sendEmail, sendSMS });
    
    if (!memberId || !templateId) {
      console.log('❌ DEBUG: Missing required fields');
      return res.status(400).json({
        success: false,
        message: 'Member ID and template ID are required'
      });
    }

    const pool = await getPool();
    
    try {
      console.log('🔍 DEBUG: Getting member information...');
      
      // Get member information using unified service
      const member = await EnrollmentLinkService.getMemberInfo(memberId, pool);
      
      if (!member) {
        console.log('❌ DEBUG: Member not found or inactive');
        return res.status(404).json({
          success: false,
          message: 'Member not found or inactive'
        });
      }
      
      // If member has declined coverage, undo the decline so we can send a new enrollment link (e.g. they changed their mind)
      if (member._isDeclinedCoverage || member.Status === 'Declined' || member.HasDeclinedCoverage) {
        console.log('🔄 DEBUG: Member had declined coverage — resetting decline and proceeding to send link');
        const resetDeclineRequest = pool.request();
        resetDeclineRequest.input('memberId', sql.UniqueIdentifier, memberId);
        await resetDeclineRequest.query(`
          UPDATE oe.DeclineAcknowledgements SET Status = 'Inactive' WHERE MemberId = @memberId AND Status = 'Active'
        `);
        await resetDeclineRequest.query(`
          UPDATE oe.Members SET Status = 'Active', ModifiedDate = GETUTCDATE() WHERE MemberId = @memberId AND Status = 'Declined'
        `);
        // Re-fetch member so rest of flow sees non-declined state
        const reFetched = await EnrollmentLinkService.getMemberInfo(memberId, pool);
        if (!reFetched || reFetched._isDeclinedCoverage) {
          console.log('❌ DEBUG: Failed to reset declined coverage');
          return res.status(400).json({
            success: false,
            message: 'Could not reset declined coverage for this member.',
            errorCode: 'MEMBER_DECLINED_COVERAGE'
          });
        }
        Object.assign(member, reFetched);
      }

      console.log('🔍 DEBUG: Found member:', member);
      
      // Check if member already has active enrollments in the current coverage window
      console.log('🔍 DEBUG: Checking for existing enrollments...');
      const enrollmentCheckQuery = ACTIVE_ENROLLMENT_SQL;
      
      const enrollmentCheckRequest = pool.request();
      enrollmentCheckRequest.input('memberId', sql.UniqueIdentifier, memberId);
      
      const enrollmentCheckResult = await enrollmentCheckRequest.query(enrollmentCheckQuery);
      const enrollmentCount = enrollmentCheckResult.recordset[0].activeCount;
      
      if (enrollmentCount > 0) {
        console.log('❌ DEBUG: Member already has active enrollments');
        return res.status(400).json({
          success: false,
          message: 'Member already has active enrollments'
        });
      }

      console.log('✅ DEBUG: Member has no active enrollments, proceeding...');
      
      // Initialize expirationHours at the top level so it's accessible in all code paths
      let expirationHours = DEFAULT_LINK_EXPIRATION_HOURS;
      
      // When copy or send link is used: if their existing enrollment link has expired, generate a new one.
      // Deactivate any expired links for this member+template so we never reuse them.
      const deactivateExpiredRequest = pool.request();
      deactivateExpiredRequest.input('memberId', sql.UniqueIdentifier, memberId);
      deactivateExpiredRequest.input('templateId', sql.UniqueIdentifier, templateId);
      await deactivateExpiredRequest.query(`
        UPDATE oe.EnrollmentLinks
        SET IsActive = 0, ModifiedDate = GETUTCDATE()
        WHERE MemberId = @memberId AND EnrollmentLinkTemplateId = @templateId AND IsActive = 1
          AND ExpiresAt IS NOT NULL AND ExpiresAt <= GETUTCDATE()
      `);
      
      // Check for existing non-expired enrollment link for this member and template
      console.log('🔍 DEBUG: Checking for existing non-expired enrollment link...');
      const existingLinkQuery = `
        SELECT TOP 1 
          el.LinkId,
          el.LinkToken,
          el.LinkUrl,
          el.ExpiresAt,
          el.IsActive,
          el.UsageCount,
          el.MaxUsage
        FROM oe.EnrollmentLinks el
        WHERE el.MemberId = @memberId 
          AND el.EnrollmentLinkTemplateId = @templateId
          AND el.IsActive = 1
          AND (el.ExpiresAt IS NULL OR el.ExpiresAt > GETUTCDATE())
        ORDER BY el.CreatedDate DESC
      `;
      
      const existingLinkRequest = pool.request();
      existingLinkRequest.input('memberId', sql.UniqueIdentifier, memberId);
      existingLinkRequest.input('templateId', sql.UniqueIdentifier, templateId);
      const existingLinkResult = await existingLinkRequest.query(existingLinkQuery);
      
      let linkData = null;
      let isExistingLink = false;
      
      // When copyOnly (e.g. "Copy link"), prefer existing non-expired link so we don't invalidate it. Otherwise when linkBaseUrl is provided, create new with that base.
      const useExistingLink = existingLinkResult.recordset.length > 0
        && (copyOnly === true || !(linkBaseUrl && String(linkBaseUrl).trim()));
      
      if (useExistingLink) {
        const existingLink = existingLinkResult.recordset[0];
        // Check usage limits
        if (existingLink.MaxUsage && existingLink.UsageCount >= existingLink.MaxUsage) {
          // fall through to create new
        } else {
          linkData = {
            enrollmentUrl: existingLink.LinkUrl,
            linkToken: existingLink.LinkToken,
            linkId: existingLink.LinkId,
            expiresAt: existingLink.ExpiresAt
          };
          isExistingLink = true;
          console.log('✅ DEBUG: Using existing enrollment link:', linkData.linkToken);
        }
      }

      // Would invalidate existing link (create new one) but user has not confirmed
      const hasExistingActiveLink = existingLinkResult.recordset.length > 0;
      if (!linkData && hasExistingActiveLink && !confirmInvalidate) {
        const existingLink = existingLinkResult.recordset[0];
        return res.status(200).json({
          success: false,
          code: 'EXISTING_LINK_WOULD_BE_INVALIDATED',
          message: 'Creating a new link will invalidate the current enrollment link for this member. Confirm to continue.',
          data: { existingEnrollmentUrl: existingLink.LinkUrl }
        });
      }
      
      // If no valid existing link (or linkBaseUrl changed), create a new one
      if (!linkData) {
        console.log('🔍 DEBUG: No valid existing link found, invalidating old links and creating new one...');
      const invalidateLinksQuery = `
        UPDATE oe.EnrollmentLinks 
        SET IsActive = 0, ModifiedDate = GETUTCDATE()
        WHERE MemberId = @memberId AND IsActive = 1
      `;
      
      const invalidateRequest = pool.request();
      invalidateRequest.input('memberId', sql.UniqueIdentifier, memberId);
      const invalidateResult = await invalidateRequest.query(invalidateLinksQuery);
      console.log(`🔍 DEBUG: Invalidated ${invalidateResult.rowsAffected[0]} existing enrollment links`);
      
      // Determine expected template type based on member's GroupId
      const expectedTemplateType = member.GroupId ? 'Group' : 'Individual';
      const activeTenantId = req.tenantId || req.user.TenantId;
      const userRolesStr = getUserRoles(req.user).join(', ');
      console.log('🔍 DEBUG: Expected template type:', expectedTemplateType);
      console.log('🔍 DEBUG: Validating template with tenantId:', activeTenantId, 'roles:', userRolesStr);
      
      // Verify the template exists and is active
      const template = await EnrollmentLinkService.validateTemplate(
        templateId, 
        activeTenantId, 
        userRolesStr, 
        pool,
        expectedTemplateType
      );
      
      if (!template) {
        console.log(`❌ DEBUG: Template not found or not suitable for ${expectedTemplateType.toLowerCase()} enrollment. TenantId used: ${activeTenantId}, templateId: ${templateId}`);
        return res.status(404).json({
          success: false,
          message: `Enrollment template not found or not suitable for ${expectedTemplateType.toLowerCase()} enrollment`
        });
      }
      
      console.log('🔍 DEBUG: Found template:', template);
      
      // Fetch full template data to get AgentId/AgencyId
      const templateDataQuery = `
        SELECT AgentId, AgencyId
        FROM oe.EnrollmentLinkTemplates
        WHERE TemplateId = @templateId
      `;
      const templateDataRequest = pool.request();
      templateDataRequest.input('templateId', sql.UniqueIdentifier, templateId);
      const templateDataResult = await templateDataRequest.query(templateDataQuery);
      const templateData = templateDataResult.recordset[0] || {};
      
      console.log('🔍 DEBUG: Template agent/agency data:', {
        agentId: templateData.AgentId,
        agencyId: templateData.AgencyId
      });
      
      // Calculate expiration hours based on enrollment period (for group members)
      // Note: expirationHours is already declared at the top level, just update it here
      let groupPeriod = null; // Initialize groupPeriod outside the if block
      
      if (member.GroupId) {
        console.log('🔍 DEBUG: [step=groups-period] Querying oe.Groups for IsInInitialEnrollmentPeriod, groupId:', member.GroupId);
        const t0 = Date.now();
        // Use NOLOCK here - this is a read of group metadata, stale reads are fine and we don't want
        // to block behind other sessions that may have a stale row lock on this Groups row.
        const enrollmentPeriodQuery = `
          SELECT IsInInitialEnrollmentPeriod, InitialEnrollmentPeriodEnd
          FROM oe.Groups WITH (NOLOCK)
          WHERE GroupId = @groupId
        `;
        const periodReq = pool.request();
        periodReq.input('groupId', sql.UniqueIdentifier, member.GroupId);
        periodReq.timeout = 10000; // fail fast if blocked
        const periodResult = await periodReq.query(enrollmentPeriodQuery);
        console.log(`🔍 DEBUG: [step=groups-period] oe.Groups returned in ${Date.now() - t0}ms`);
        
        if (periodResult.recordset.length > 0) {
          groupPeriod = periodResult.recordset[0];
          
          if (groupPeriod.IsInInitialEnrollmentPeriod && groupPeriod.InitialEnrollmentPeriodEnd) {
            const periodEnd = new Date(groupPeriod.InitialEnrollmentPeriodEnd);
            const now = new Date();
            const hoursUntilPeriodEnd = Math.ceil((periodEnd - now) / (1000 * 60 * 60));
            
            // Use the greater of 7 days or time until period ends (if period still in future)
            expirationHours = Math.max(DEFAULT_LINK_EXPIRATION_HOURS, hoursUntilPeriodEnd);
            
            console.log('🔍 Individual link - Initial enrollment period active - extended expiration:', {
              periodEnd: periodEnd.toISOString(),
              hoursUntilEnd: hoursUntilPeriodEnd,
              expirationHours: expirationHours
            });
          }
        }
      }
      
        // If expiration is based on enrollment period end, pass the actual date only when period end is in the future
        let expiresAtDate = null;
        if (member.GroupId && groupPeriod && groupPeriod.IsInInitialEnrollmentPeriod && groupPeriod.InitialEnrollmentPeriodEnd) {
          const periodEnd = new Date(groupPeriod.InitialEnrollmentPeriodEnd);
          if (periodEnd > new Date()) {
            expiresAtDate = periodEnd;
          }
          // If period end is in the past, leave expiresAtDate null so we use expirationHours (7 days) and link is not already expired
        }
        
        // Create enrollment link using unified service
        const baseUrlOverride = (linkBaseUrl && String(linkBaseUrl).trim()) ? linkBaseUrl.trim() : undefined;
        console.log('🔍 DEBUG: [step=insert-link] Calling EnrollmentLinkService.createEnrollmentLink...');
        const tInsert = Date.now();
        linkData = await EnrollmentLinkService.createEnrollmentLink({
          memberId,
          templateId,
          groupId: member.GroupId || groupId || null,
          groupName: member.GroupName || null,
          templateName: template.TemplateName,
          effectiveDate,
          createdBy: req.user.UserId,
          expirationHours: expirationHours,
          expiresAtDate: expiresAtDate,
          req,
          agentId: templateData.AgentId,
          agencyId: templateData.AgencyId,
          baseUrlOverride
        });
        console.log(`🔍 DEBUG: [step=insert-link] createEnrollmentLink completed in ${Date.now() - tInsert}ms`);
      
        console.log(`✅ Individual enrollment link created: ${linkData.linkToken} for member ${memberId}`);
        console.log(`🔗 Enrollment URL: ${linkData.enrollmentUrl}`);
      } else {
        // Calculate expiration hours from existing link's expiration date
        if (linkData.expiresAt) {
          const now = new Date();
          const expiresAt = new Date(linkData.expiresAt);
          expirationHours = Math.ceil((expiresAt - now) / (1000 * 60 * 60));
        }
        console.log(`✅ Using existing enrollment link: ${linkData.linkToken} for member ${memberId}`);
        console.log(`🔗 Enrollment URL: ${linkData.enrollmentUrl}`);
      }
      
      console.log(`📧 Member Email: ${member.Email}`);
      console.log(`👤 Member Name: ${member.FirstName} ${member.LastName}`);
      console.log(`🆔 Member ID: ${memberId}`);
      console.log(`📋 Template ID: ${templateId}`);
      console.log(`📅 Effective Date: ${effectiveDate || 'Not set'}`);
      
      // Note: Recurring payment plan setup is handled during enrollment completion, not here
      // This ensures we only create recurring payments when there are actual premiums to collect
      
      // Get member phone number (stored in Users table, not Members)
      const memberPhoneQuery = `
        SELECT u.PhoneNumber
        FROM oe.Members m
        JOIN oe.Users u ON m.UserId = u.UserId
        WHERE m.MemberId = @memberId
      `;
      const phoneRequest = pool.request();
      phoneRequest.input('memberId', sql.UniqueIdentifier, memberId);
      const phoneResult = await phoneRequest.query(memberPhoneQuery);
      let phoneNumberToUse = phoneResult.recordset[0]?.PhoneNumber;
      
      // Update phone number if provided and different
      if (sendSMS && phoneNumber && phoneNumber.trim() && phoneNumber.trim() !== phoneNumberToUse) {
        const newPhoneNumber = phoneNumber.trim();
        // Update phone number in Users table
        if (member.UserId) {
          const updatePhoneQuery = `
            UPDATE oe.Users
            SET PhoneNumber = @phoneNumber, ModifiedDate = GETUTCDATE()
            WHERE UserId = @userId
          `;
          const updateRequest = pool.request();
          updateRequest.input('phoneNumber', sql.NVarChar, newPhoneNumber);
          updateRequest.input('userId', sql.UniqueIdentifier, member.UserId);
          await updateRequest.query(updatePhoneQuery);
          console.log(`✅ Updated phone number for user ${member.UserId}: ${newPhoneNumber}`);
        }
        
                  // Note: Phone numbers are only stored in Users table, not Members table
        
        phoneNumberToUse = newPhoneNumber;
      }
      
      // Send enrollment invitation email
      let emailResult = null;
      if (sendEmail && member.Email) {
        try {
          const MessageQueueService = require('../../services/messageQueue.service');
          const messageId = await MessageQueueService.sendEnrollmentInvitation({
            tenantId: req.user.TenantId,
            memberId: memberId,
            memberUserId: member.UserId, // Use UserId for foreign key constraint
            memberFirstName: member.FirstName,
            memberEmail: member.Email,
            enrollmentUrl: linkData.enrollmentUrl,
            groupId: member.GroupId,
            createdBy: req.user.UserId,
            expiresAt: linkData.expiresAt,
            expirationHours: expirationHours
          });
          console.log(`✅ Queued enrollment invitation email for ${member.Email}: ${messageId}`);
          emailResult = { messageId, success: true };
        } catch (emailError) {
          console.error('❌ Error sending enrollment invitation email:', emailError);
          emailResult = { error: emailError.message, success: false };
        }
      } else if (sendEmail && !member.Email) {
        emailResult = { error: 'No email address', success: false };
      }
      
      // When sending SMS, require either member SmsConsent or agent attestation of prior consent
      if (sendSMS && phoneNumberToUse) {
        const hasSmsConsent = member.SmsConsent === true || member.SmsConsent === 1;
        if (!hasSmsConsent && !attestSmsConsent) {
          return res.status(400).json({
            success: false,
            message: 'This member has not given SMS consent in our system. Please confirm you have the member’s prior consent to send them a text, or send the link via email only.',
            code: 'SMS_CONSENT_REQUIRED'
          });
        }
        if (attestSmsConsent) {
          try {
            await pool.request()
              .input('memberId', sql.UniqueIdentifier, memberId)
              .input('smsConsent', sql.Bit, 1)
              .query(`
                UPDATE oe.Members SET SmsConsent = @smsConsent, ModifiedDate = GETUTCDATE() WHERE MemberId = @memberId
              `);
            console.log('✅ Recorded SMS consent (agent attestation) for member:', memberId);
          } catch (updateErr) {
            console.warn('⚠️ Failed to record SMS consent (attestation):', updateErr?.message);
          }
        }
      }

      // Send SMS if requested
      let smsResult = null;
      if (sendSMS && phoneNumberToUse) {
        try {
          const MessageQueueService = require('../../services/messageQueue.service');
          // Generate SMS content with expiration date
          // Use helper to format date without timezone conversion
          const { formatDateWithoutTimezone } = require('../../utils/enrollmentDateHelpers');
          // Convert expiresAt to ISO string if it's a Date object
          const expiresAtString = linkData.expiresAt instanceof Date 
            ? linkData.expiresAt.toISOString() 
            : (linkData.expiresAt || '');
          const expirationDate = formatDateWithoutTimezone(expiresAtString, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
          });
          const smsContent = `Hi ${member.FirstName}, complete your benefits enrollment here: ${linkData.enrollmentUrl}\n\nThis link expires on ${expirationDate}.`;
          
          const messageId = await MessageQueueService.queueMessage({
            tenantId: req.user.TenantId,
            messageType: 'SMS',
            recipientAddress: phoneNumberToUse,
            subject: null, // SMS doesn't have subject
            messageBody: smsContent,
            status: 'Pending',
            createdBy: req.user.UserId,
            recipientId: member.UserId
          });
          
          console.log(`✅ Queued enrollment invitation SMS for ${phoneNumberToUse}: ${messageId}`);
          smsResult = { messageId, success: true, phoneNumber: phoneNumberToUse };
        } catch (smsError) {
          console.error('❌ Error sending enrollment invitation SMS:', smsError);
          smsResult = { error: smsError.message, success: false, phoneNumber: phoneNumberToUse };
        }
      } else if (sendSMS && !phoneNumberToUse) {
        smsResult = { error: 'No phone number available', success: false };
      }
      
      res.json({
        success: true,
        message: isExistingLink ? 'Using existing enrollment link' : 'Enrollment link created successfully',
        data: {
          linkId: linkData.linkId,
          linkToken: linkData.linkToken,
          enrollmentUrl: linkData.enrollmentUrl,
          expiresAt: linkData.expiresAt,
          memberEmail: member.Email,
          memberName: `${member.FirstName} ${member.LastName}`,
          effectiveDate,
          isExisting: isExistingLink,
          emailResult,
          smsResult
        }
      });
    
    } catch (error) {
      console.error('❌ Error creating individual enrollment link:', error);
      res.status(500).json({
        success: false,
        message: 'Server error while creating enrollment link'
      });
    }
  } catch (error) {
    console.error('❌ Error creating individual enrollment link:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while creating enrollment link'
    });
  }
});

/**
 * POST /api/me/enrollment-links/:linkId/copy-as-static - Copy a member-specific link as a static link
 * This endpoint converts a member-specific Individual link (LinkType='Member') to a static link (LinkType='Agent-Static')
 */
router.post('/:linkId/copy-as-static', authMiddleware(['Agent', 'SysAdmin', 'TenantAdmin', 'AgencyOwner']), requireTenantAccess, async (req, res) => {
  try {
    const { linkId } = req.params;
    const userId = req.user?.UserId;
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated'
      });
    }
    
    console.log('🔍 POST /api/me/enrollment-links/:linkId/copy-as-static - Request received');
    console.log('📋 Link ID:', linkId);
    
    const pool = await getPool();
    
    // Get the enrollment link
    const getLinkRequest = pool.request();
    getLinkRequest.input('linkId', sql.UniqueIdentifier, linkId);
    
    const linkResult = await getLinkRequest.query(`
      SELECT 
        el.LinkId,
        el.MemberId,
        el.LinkType,
        el.EnrollmentLinkTemplateId,
        el.AgentId,
        el.AgencyId,
        elt.TemplateType,
        elt.TemplateName,
        a.TenantId
      FROM oe.EnrollmentLinks el
      INNER JOIN oe.EnrollmentLinkTemplates elt ON el.EnrollmentLinkTemplateId = elt.TemplateId
      LEFT JOIN oe.Agents a ON el.AgentId = a.AgentId
      WHERE el.LinkId = @linkId
    `);
    
    if (linkResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Enrollment link not found'
      });
    }
    
    const link = linkResult.recordset[0];
    
    // Validate: Link must be Member type and from Individual template
    if (link.LinkType !== 'Member') {
      return res.status(400).json({
        success: false,
        message: 'Only member-specific links (LinkType=Member) can be copied as static links'
      });
    }
    
    if (link.TemplateType !== 'Individual') {
      return res.status(400).json({
        success: false,
        message: 'Only Individual template links can be copied as static links'
      });
    }
    
    // Check authorization - user must have access to this link's agent/tenant
    const currentRole = req.user?.currentRole || getUserRoles(req.user)[0];
    const userTenantId = req.user?.TenantId;
    
    if (currentRole === 'Agent' || currentRole === 'AgencyOwner') {
      // Agent can only copy their own links
      const agentRequest = pool.request();
      agentRequest.input('userId', sql.UniqueIdentifier, userId);
      const agentResult = await agentRequest.query(`
        SELECT AgentId FROM oe.Agents WHERE UserId = @userId AND Status = 'Active'
      `);
      
      if (agentResult.recordset.length === 0 || agentResult.recordset[0].AgentId !== link.AgentId) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to copy this link'
        });
      }
    } else if (currentRole === 'TenantAdmin') {
      // TenantAdmin can copy links from their tenant
      if (link.TenantId !== userTenantId) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to copy this link'
        });
      }
    }
    // SysAdmin can copy any link
    
    // Get agent information for short code generation
    let agentFirstName = '';
    let agentLastName = '';
    let agentId = link.AgentId;
    
    if (agentId) {
      const agentInfoRequest = pool.request();
      agentInfoRequest.input('agentId', sql.UniqueIdentifier, agentId);
      const agentInfoResult = await agentInfoRequest.query(`
        SELECT u.FirstName, u.LastName
        FROM oe.Agents a
        INNER JOIN oe.Users u ON a.UserId = u.UserId
        WHERE a.AgentId = @agentId
      `);
      
      if (agentInfoResult.recordset.length > 0) {
        agentFirstName = agentInfoResult.recordset[0].FirstName || '';
        agentLastName = agentInfoResult.recordset[0].LastName || '';
      }
    }
    
    // Generate short code
    const ShortCodeService = require('../../services/shared/short-code.service');
    const shortCode = await ShortCodeService.generateAgentShortCode(agentFirstName, agentLastName, pool, 'ag');
    
    // Generate new link token
    const linkToken = `enroll_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Generate new LinkId
    const newLinkId = require('crypto').randomUUID();
    
    // Get base URL from request
    const baseUrl = req.get('origin') || `${req.protocol}://${req.get('host')}`;
    const enrollmentUrl = `${baseUrl}/enroll-now/${shortCode}`;
    
    // Create static enrollment link
    const createLinkRequest = pool.request();
    createLinkRequest.input('linkId', sql.UniqueIdentifier, newLinkId);
    createLinkRequest.input('groupId', sql.UniqueIdentifier, null);
    createLinkRequest.input('memberId', sql.UniqueIdentifier, null);
    createLinkRequest.input('linkToken', sql.NVarChar, linkToken);
    createLinkRequest.input('linkUrl', sql.NVarChar, enrollmentUrl);
    createLinkRequest.input('linkType', sql.NVarChar, 'Agent-Static');
    createLinkRequest.input('shortCode', sql.NVarChar, shortCode);
    createLinkRequest.input('description', sql.NVarChar, `Static enrollment link - ${link.TemplateName}`);
    createLinkRequest.input('expiresAt', sql.DateTime2, null);
    createLinkRequest.input('isActive', sql.Bit, true);
    createLinkRequest.input('usageCount', sql.Int, 0);
    createLinkRequest.input('maxUsage', sql.Int, null);
    createLinkRequest.input('templateId', sql.UniqueIdentifier, link.EnrollmentLinkTemplateId);
    createLinkRequest.input('agentId', sql.UniqueIdentifier, link.AgentId);
    createLinkRequest.input('createdBy', sql.UniqueIdentifier, userId);
    createLinkRequest.input('modifiedBy', sql.UniqueIdentifier, userId);
    
    await createLinkRequest.query(`
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
    `);
    
    console.log('✅ Copied member-specific link as static link:', {
      originalLinkId: linkId,
      newLinkId: newLinkId,
      shortCode: shortCode,
      enrollmentUrl: enrollmentUrl
    });
    
    res.status(201).json({
      success: true,
      data: {
        linkId: newLinkId,
        linkToken: linkToken,
        shortCode: shortCode,
        enrollmentUrl: enrollmentUrl,
        templateName: link.TemplateName,
        message: 'Link copied as static link successfully'
      }
    });
    
  } catch (error) {
    console.error('❌ Error copying link as static:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to copy link as static',
      error: {
        message: error.message,
        code: 'COPY_AS_STATIC_ERROR'
      }
    });
  }
});

module.exports = router;
