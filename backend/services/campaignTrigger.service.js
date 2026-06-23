// backend/services/campaignTrigger.service.js
const sql = require('mssql');
const MessageQueueService = require('./messageQueue.service');
const {
  isEmailMarketingOptedOut,
  isSmsMarketingBlocked
} = require('./memberCommunicationPreferences.service');
const {
  substituteVariables,
  SQL_MEMBER_EFFECTIVE_TERMINATION_DATE
} = require('./shared/variableSubstitution');

class CampaignTriggerService {
  /**
   * Fire a campaign trigger for a member.
   * Finds all active campaigns matching the triggerType for the tenant,
   * creates CampaignEnrollment rows, and immediately processes Day 0 steps.
   *
   * @param {object} pool - mssql connection pool
   * @param {string} triggerType - 'EnrollmentCompletion' | 'FirstDayOfCoverage' | 'DependentAdded' | 'PlanTermination'
   * @param {object} context - { memberId, tenantId, groupId?, agentId?, planName? }
   * @returns {{ campaignsTriggered: number, messagesQueued: number }}
   */
  static async fireTrigger(pool, triggerType, context) {
    const { memberId, tenantId, planName } = context;
    let campaignsTriggered = 0;
    let messagesQueued = 0;

    // PlanTermination campaigns are, by definition, for members who are now terminated —
    // so the usual "skip terminated members" guard must NOT apply here, otherwise the
    // termination email would be cancelled before it is ever sent.
    const skipTerminationGuard = triggerType === 'PlanTermination';

    // Find active campaigns for this trigger type. XOR storage:
    //   - Tenant campaigns: TenantId = @tenantId AND VendorId IS NULL
    //   - Vendor campaigns: TenantId IS NULL AND VendorId IN (vendors with users in this tenant)
    // A vendor campaign fires in every tenant the vendor serves (i.e., has portal users in).
    const campaignsResult = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('triggerType', sql.NVarChar(50), triggerType)
      .query(`
        SELECT CampaignId, TenantId, RecipientType
        FROM oe.Campaigns
        WHERE TriggerType = @triggerType
          AND IsActive = 1
          AND (
            (TenantId = @tenantId AND VendorId IS NULL)
            OR
            (TenantId IS NULL AND VendorId IN (
              SELECT DISTINCT VendorId
                FROM oe.Users
               WHERE TenantId = @tenantId
                 AND VendorId IS NOT NULL
            ))
          )
      `);

    if (!campaignsResult.recordset.length) {
      return { campaignsTriggered: 0, messagesQueued: 0 };
    }

    for (const campaign of campaignsResult.recordset) {
      // Check if member is already in this campaign
      const existingResult = await pool.request()
        .input('campaignId', sql.UniqueIdentifier, campaign.CampaignId)
        .input('memberId', sql.UniqueIdentifier, memberId)
        .query(`
          SELECT CampaignEnrollmentId
          FROM oe.CampaignEnrollments
          WHERE CampaignId = @campaignId AND MemberId = @memberId AND Status = 'Active'
        `);

      if (existingResult.recordset.length > 0) {
        continue; // Already in this campaign
      }

      // Get Day 0 steps
      const stepsResult = await pool.request()
        .input('campaignId', sql.UniqueIdentifier, campaign.CampaignId)
        .query(`
          SELECT StepId, StepOrder, DelayDays, EmailTemplateId, SmsTemplateId, IsActive
          FROM oe.CampaignSteps
          WHERE CampaignId = @campaignId AND DelayDays = 0 AND IsActive = 1
          ORDER BY StepOrder
        `);

      // Check if member is terminated (use TerminationDate, NOT Status).
      // For PlanTermination campaigns we intentionally do not treat termination as a skip
      // reason — the member being terminated is the whole point of the campaign.
      const isTerminated = skipTerminationGuard
        ? false
        : await CampaignTriggerService.checkMemberTerminated(pool, memberId);

      // Create the enrollment
      const enrollmentId = require('crypto').randomUUID();
      await pool.request()
        .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
        .input('campaignId', sql.UniqueIdentifier, campaign.CampaignId)
        .input('memberId', sql.UniqueIdentifier, memberId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('status', sql.NVarChar(20), isTerminated ? 'Cancelled' : 'Active')
        .query(`
          INSERT INTO oe.CampaignEnrollments
            (CampaignEnrollmentId, CampaignId, MemberId, TenantId, TriggerDate, CurrentStepOrder, Status)
          VALUES
            (@enrollmentId, @campaignId, @memberId, @tenantId, CAST(GETUTCDATE() AS DATE), 0, @status)
        `);

      if (isTerminated) {
        continue; // Don't send any messages to terminated members
      }

      // Process Day 0 steps immediately
      const queued = await CampaignTriggerService.processSteps(
        pool, enrollmentId, campaign.CampaignId, memberId, tenantId, stepsResult.recordset,
        campaign.RecipientType || 'Member', { planName }
      );

      messagesQueued += queued;
      campaignsTriggered++;

      // Determine the max step order across ALL steps in the campaign
      const allStepsResult = await pool.request()
        .input('campaignId', sql.UniqueIdentifier, campaign.CampaignId)
        .query(`
          SELECT MAX(StepOrder) AS MaxStep FROM oe.CampaignSteps
          WHERE CampaignId = @campaignId AND IsActive = 1
        `);

      const day0MaxStep = stepsResult.recordset.length > 0
        ? Math.max(...stepsResult.recordset.map(s => s.StepOrder))
        : 0;
      const campaignMaxStep = allStepsResult.recordset[0]?.MaxStep || 0;

      if (day0MaxStep >= campaignMaxStep) {
        // All campaign steps are Day 0 — mark enrollment complete
        await pool.request()
          .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
          .query(`
            UPDATE oe.CampaignEnrollments
            SET Status = 'Completed', CompletedDate = SYSUTCDATETIME(), CurrentStepOrder = ${day0MaxStep}
            WHERE CampaignEnrollmentId = @enrollmentId
          `);
      } else {
        // More steps remain for the ScheduledProcessor to handle later
        await pool.request()
          .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
          .input('stepOrder', sql.Int, day0MaxStep)
          .query(`
            UPDATE oe.CampaignEnrollments
            SET CurrentStepOrder = @stepOrder
            WHERE CampaignEnrollmentId = @enrollmentId
          `);
      }
    }

    return { campaignsTriggered, messagesQueued };
  }

  /**
   * Process campaign steps — load member context + templates, substitute variables, queue messages.
   * Used by both fireTrigger (Day 0) and the daily ScheduledProcessor.
   *
   * Fetches member context and template data in a single JOIN query per step so that
   * variable substitution has full member/agent/tenant/group context.
   *
   * @param {object} pool - mssql connection pool
   * @param {string} enrollmentId - CampaignEnrollmentId
   * @param {string} campaignId - CampaignId
   * @param {string} memberId - MemberId
   * @param {string} tenantId - TenantId
   * @param {Array} steps - Array of step rows from oe.CampaignSteps
   * @param {string} [recipientType='Member'] - 'Member' sends to the enrolling member;
   *        'Agent' sends to the member's assigned agent (e.g. notify the agent that a
   *        client enrolled under them). Agent steps are skipped when no agent is assigned.
   * @param {object} [extraContext] - Optional extra template context, e.g. { planName } for PlanTermination
   * @returns {number} Number of messages queued
   */
  static async processSteps(pool, enrollmentId, campaignId, memberId, tenantId, steps, recipientType = 'Member', extraContext = {}) {
    if (!steps || !steps.length) return 0;

    const toAgent = recipientType === 'Agent';

    let messagesQueued = 0;

    for (const step of steps) {
      // Fetch member context joined with both email and SMS templates in one query
      const contextResult = await pool.request()
        .input('memberId', sql.UniqueIdentifier, memberId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('emailTemplateId', sql.UniqueIdentifier, step.EmailTemplateId || null)
        .input('smsTemplateId', sql.UniqueIdentifier, step.SmsTemplateId || null)
        .query(`
          SELECT
            m.MemberId, u.UserId,
            u.FirstName, u.LastName, u.Email, u.PhoneNumber AS Phone,
            ${SQL_MEMBER_EFFECTIVE_TERMINATION_DATE} AS MemberTerminationDate,
            m.TenantId,
            t.Name AS TenantName, t.ContactEmail AS TenantEmail, t.ContactPhone AS TenantPhone,
            t.PrimaryAddress AS TenantPrimaryAddress, t.PrimaryCity AS TenantPrimaryCity,
            t.PrimaryState AS TenantPrimaryState, t.PrimaryZip AS TenantPrimaryZip,
            g.Name AS GroupName,
            au.UserId AS AgentUserId,
            au.FirstName AS AgentFirstName, au.LastName AS AgentLastName,
            au.Email AS AgentEmail, au.PhoneNumber AS AgentPhone,
            et.Subject, et.Body, et.ReplyTo AS EmailReplyTo,
            ISNULL(et.MessageCategory, 'Marketing') AS EmailTemplateCategory,
            st.Body AS SmsBody, st.Subject AS SmsSubject,
            ISNULL(st.MessageCategory, 'Marketing') AS SmsTemplateCategory
          FROM oe.Members m
          JOIN oe.Users u ON m.UserId = u.UserId
          LEFT JOIN oe.Tenants t ON m.TenantId = t.TenantId
          LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
          LEFT JOIN oe.Agents a ON m.AgentId = a.AgentId
          LEFT JOIN oe.Users au ON a.UserId = au.UserId
          LEFT JOIN oe.MessageTemplates et ON et.TemplateId = @emailTemplateId AND et.IsActive = 1
          LEFT JOIN oe.MessageTemplates st ON st.TemplateId = @smsTemplateId AND st.IsActive = 1
          WHERE m.MemberId = @memberId
        `);

      if (!contextResult.recordset.length) continue;

      const ctx = contextResult.recordset[0];
      const varContext = {
        member: {
          FirstName: ctx.FirstName,
          LastName: ctx.LastName,
          Email: ctx.Email,
          Phone: ctx.Phone,
          TerminationDate: ctx.MemberTerminationDate ?? null
        },
        agent: { FirstName: ctx.AgentFirstName, LastName: ctx.AgentLastName, Email: ctx.AgentEmail, Phone: ctx.AgentPhone },
        tenant: { Name: ctx.TenantName, Email: ctx.TenantEmail, Phone: ctx.TenantPhone },
        group: { Name: ctx.GroupName },
        plan: { Name: extraContext.planName || '' },
        system: { LoginUrl: process.env.LOGIN_URL || process.env.FRONTEND_URL || '' }
      };

      // Resolve the recipient. Member campaigns deliver to the member; Agent
      // campaigns deliver to the member's assigned agent (skip when unassigned).
      const recipient = toAgent
        ? { userId: ctx.AgentUserId, email: ctx.AgentEmail, phone: ctx.AgentPhone }
        : { userId: ctx.UserId, email: ctx.Email, phone: ctx.Phone };

      // Agent campaign with no agent assigned — nothing to send for this member.
      if (toAgent && !recipient.userId) continue;

      const emailCat = (ctx.EmailTemplateCategory || 'Marketing');
      const smsCat = (ctx.SmsTemplateCategory || 'Marketing');

      // Process email template
      if (step.EmailTemplateId && ctx.Subject != null && recipient.email) {
        // Marketing compliance (opt-out + unsubscribe footer) is keyed to the
        // member, so it only applies when the member is the recipient.
        const applyEmailCompliance = !toAgent && emailCat === 'Marketing';
        if (applyEmailCompliance && (await isEmailMarketingOptedOut(memberId))) {
          await pool.request()
            .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
            .input('stepId', sql.UniqueIdentifier, step.StepId)
            .query(`
              INSERT INTO oe.CampaignMessageLog (LogId, CampaignEnrollmentId, StepId, MessageType, MessageId, SentDate, Status)
              VALUES (NEWID(), @enrollmentId, @stepId, 'Email', NULL, SYSUTCDATETIME(), 'Skipped')
            `);
        } else {
          const subject = substituteVariables(ctx.Subject || '', varContext);
          const body = substituteVariables(ctx.Body || '', varContext);
          const replyTo = ctx.EmailReplyTo ? substituteVariables(ctx.EmailReplyTo, varContext) : null;
          const postalParts = [ctx.TenantPrimaryAddress, ctx.TenantPrimaryCity, ctx.TenantPrimaryState, ctx.TenantPrimaryZip].filter(Boolean);
          const postalLine = postalParts.length ? postalParts.join(', ') : '';

          const messageId = await MessageQueueService.queueEmail({
            tenantId,
            toEmail: recipient.email,
            subject,
            htmlContent: body,
            textContent: '',
            messageType: 'Email',
            recipientId: recipient.userId,
            replyToEmail: replyTo,
            marketingCompliance: applyEmailCompliance
              ? {
                  memberId,
                  tenantId,
                  tenantName: ctx.TenantName,
                  postalLine
                }
              : null
          });

          await pool.request()
            .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
            .input('stepId', sql.UniqueIdentifier, step.StepId)
            .input('messageId', sql.UniqueIdentifier, messageId)
            .query(`
              INSERT INTO oe.CampaignMessageLog (LogId, CampaignEnrollmentId, StepId, MessageType, MessageId, SentDate, Status)
              VALUES (NEWID(), @enrollmentId, @stepId, 'Email', @messageId, SYSUTCDATETIME(), 'Sent')
            `);

          messagesQueued++;
        }
      }

      // Process SMS template
      if (step.SmsTemplateId && ctx.SmsBody != null && recipient.phone) {
        // Marketing opt-out is keyed to the member — only gate member sends.
        const applySmsCompliance = !toAgent && smsCat === 'Marketing';
        if (applySmsCompliance && (await isSmsMarketingBlocked(memberId))) {
          await pool.request()
            .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
            .input('stepId', sql.UniqueIdentifier, step.StepId)
            .query(`
              INSERT INTO oe.CampaignMessageLog (LogId, CampaignEnrollmentId, StepId, MessageType, MessageId, SentDate, Status)
              VALUES (NEWID(), @enrollmentId, @stepId, 'SMS', NULL, SYSUTCDATETIME(), 'Skipped')
            `);
        } else {
          const body = substituteVariables(ctx.SmsBody || '', varContext);

          const messageId = await MessageQueueService.queueMessage({
            tenantId,
            recipientAddress: recipient.phone,
            messageType: 'SMS',
            subject: null,
            messageBody: body,
            recipientId: recipient.userId
          });

          await pool.request()
            .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
            .input('stepId', sql.UniqueIdentifier, step.StepId)
            .input('messageId', sql.UniqueIdentifier, messageId)
            .query(`
              INSERT INTO oe.CampaignMessageLog (LogId, CampaignEnrollmentId, StepId, MessageType, MessageId, SentDate, Status)
              VALUES (NEWID(), @enrollmentId, @stepId, 'SMS', @messageId, SYSUTCDATETIME(), 'Sent')
            `);

          messagesQueued++;
        }
      }
    }

    return messagesQueued;
  }

  /**
   * Check if a member is terminated by looking for a TerminationDate on any enrollment.
   * Per business rule: use TerminationDate column on oe.Enrollments, NOT the Status field.
   *
   * @param {object} pool - mssql connection pool
   * @param {string} memberId - MemberId to check
   * @returns {Promise<boolean>} true if member has a non-null TerminationDate
   */
  static async checkMemberTerminated(pool, memberId) {
    const result = await pool.request()
      .input('memberId', sql.UniqueIdentifier, memberId)
      .query(`
        SELECT TOP 1 TerminationDate
        FROM oe.Enrollments
        WHERE MemberId = @memberId AND TerminationDate IS NOT NULL
      `);
    return result.recordset.length > 0;
  }
}

module.exports = CampaignTriggerService;
