const { getPool, sql } = require('../config/database');
const EmailTemplatesService = require('./emailTemplates.service');
const { trySendEmailImmediate } = require('./immediateEmailSend');
const { trySendSmsImmediate } = require('./immediateSmsSend');
const { nextAllowedSendTime } = require('../utils/nextAllowedSendTime');

/** SMS: trim and strip non-digits (spaces, dashes, parens) then E.164 + prefix — matches Message Center formatPhone. */
function normalizeSmsRecipientE164(raw) {
  if (raw == null || raw === '') return raw;
  const s = String(raw).trim();
  if (!s) return '';
  let cleaned = s.replace(/\D/g, '');
  if (!cleaned) return s;
  if (cleaned.length === 10) cleaned = '1' + cleaned;
  if (!cleaned.startsWith('+')) cleaned = '+' + cleaned;
  return cleaned;
}

/**
 * MESSAGE QUEUE SERVICE
 * 
 * Handles queuing and sending emails through the message system
 */

class MessageQueueService {
  /** Defer billing/payment notifications to next 11:00 ET window (no Sunday). */
  static billingNotificationQueueOptions() {
    return {
      tryImmediateSend: false,
      scheduledSendDate: nextAllowedSendTime(),
    };
  }

  /**
   * Queue a message (Email or SMS)
   * @param {Object} messageData - Message data
   * @returns {Promise<string>} Message ID
   */
  static async queueMessage(messageData) {
    const {
      tenantId,
      messageType, // 'Email' or 'SMS'
      subject,
      messageBody,
      status = 'Pending',
      createdBy = null,
      recipientId = null,
      batchId = null,
      queuePriority = 0,
      tryImmediateSend,
      scheduledSendDate = null
    } = messageData;

    let recipientAddress = messageData.recipientAddress;
    if (messageType === 'SMS' && recipientAddress) {
      recipientAddress = normalizeSmsRecipientE164(recipientAddress);
    }

    const pool = await getPool();
    const messageId = require('crypto').randomUUID();

    const scheduledAt = scheduledSendDate ? new Date(scheduledSendDate) : null;
    const isFutureScheduled = scheduledAt && !Number.isNaN(scheduledAt.getTime()) && scheduledAt.getTime() > Date.now();

    const immediateSmsAllowed =
      messageType === 'SMS' &&
      tenantId &&
      status === 'Pending' &&
      !isFutureScheduled &&
      process.env.MESSAGE_IMMEDIATE_SEND !== 'false' &&
      tryImmediateSend !== false;

    if (immediateSmsAllowed) {
      try {
        const sent = await trySendSmsImmediate({
          pool,
          messageId,
          tenantId,
          recipientId,
          recipientAddress,
          messageBody,
          batchId: batchId || null
        });
        if (sent) {
          console.log(`✅ SMS sent immediately (not queued): ${messageId} to ${recipientAddress}`);
          return messageId;
        }
        console.warn(`⚠️ [MessageQueue.queueMessage] Immediate SMS did not complete; queueing Pending row messageId=${messageId} to=${recipientAddress}`);
      } catch (immediateErr) {
        console.warn(`⚠️ Immediate SMS error, falling back to queue: ${immediateErr.message}`);
      }
    }

    try {
      const query = `
        INSERT INTO oe.MessageQueue (
          MessageId, TenantId, RecipientId, MessageType,
          RecipientAddress, Subject, Body, Status,
          RetryCount, CreatedDate, CreatedBy, BatchId, QueuePriority, ScheduledSendDate
        ) VALUES (
          @messageId, @tenantId, @recipientId, @messageType,
          @recipientAddress, @subject, @body, @status,
          0, GETUTCDATE(), @createdBy, @batchId, @queuePriority, @scheduledSendDate
        )
      `;

      const request = pool.request();
      request.input('messageId', sql.UniqueIdentifier, messageId);
      request.input('tenantId', sql.UniqueIdentifier, tenantId);
      // Handle nullable recipientId - SQL Server UniqueIdentifier can accept null
      if (recipientId) {
        request.input('recipientId', sql.UniqueIdentifier, recipientId);
      } else {
        request.input('recipientId', sql.UniqueIdentifier, null);
      }
      request.input('messageType', sql.NVarChar, messageType);
      request.input('recipientAddress', sql.NVarChar, recipientAddress);
      request.input('subject', sql.NVarChar, subject);
      request.input('body', sql.NVarChar, messageBody);
      request.input('status', sql.NVarChar, status);
      request.input('createdBy', sql.UniqueIdentifier, createdBy);
      if (batchId) {
        request.input('batchId', sql.UniqueIdentifier, batchId);
      } else {
        request.input('batchId', sql.UniqueIdentifier, null);
      }
      request.input('queuePriority', sql.Int, queuePriority);
      request.input('scheduledSendDate', sql.DateTime2, isFutureScheduled ? scheduledAt : null);

      await request.query(query);
      console.log(`✅ Queued ${messageType} message: ${messageId} to ${recipientAddress}`);

      return messageId;
    } catch (error) {
      console.error(`❌ Error queuing ${messageType}:`, error);
      throw error;
    }
  }
  
  /**
   * Queue an email message
   * @param {Object} messageData - Message data
   * @returns {Promise<string>} Message ID
   */
  static async queueEmail(messageData) {
    const {
      tenantId,
      toEmail,
      toName,
      subject,
      htmlContent,
      textContent,
      messageType = 'Email',
      createdBy,
      recipientId = null,
      replyToEmail = null,
      fromEmail = null,
      fromName = null,
      tryImmediateSend,
      marketingCompliance = null,
      scheduledSendDate = null
    } = messageData;

    const pool = await getPool();
    const messageId = require('crypto').randomUUID();
    const dbName = (pool.config && pool.config.database) ? pool.config.database : 'unknown';
    const dbServer = (pool.config && pool.config.server) ? pool.config.server : 'unknown';

    let htmlBody = htmlContent;
    let listUnsubscribeUrl = null;
    if (marketingCompliance && marketingCompliance.memberId && marketingCompliance.tenantId) {
      const { buildMarketingFooterAndUnsubscribeUrl } = require('./marketingEmailCompliance.service');
      const built = buildMarketingFooterAndUnsubscribeUrl(htmlContent || '', marketingCompliance);
      htmlBody = built.htmlWithFooter;
      listUnsubscribeUrl = built.listUnsubscribeUrl;
    }

    // Store both HTML and text content for better email client compatibility
    // Also include reply-to, from, and List-Unsubscribe URL as metadata (same shape MessageProcessor expects)
    let emailBody = textContent
      ? `<!-- TEXT VERSION -->\n${textContent}\n\n<!-- HTML VERSION -->\n${htmlBody}`
      : htmlBody;

    const metadata = {};
    if (replyToEmail) metadata.replyToEmail = replyToEmail;
    if (fromEmail) metadata.fromEmail = fromEmail;
    if (fromName) metadata.fromName = fromName;
    if (listUnsubscribeUrl) metadata.listUnsubscribeUrl = listUnsubscribeUrl;
    if (Object.keys(metadata).length > 0) {
      emailBody = `<!-- METADATA:${JSON.stringify(metadata)} -->\n${emailBody}`;
    }

    const scheduledAt = scheduledSendDate ? new Date(scheduledSendDate) : null;
    const isFutureScheduled = scheduledAt && !Number.isNaN(scheduledAt.getTime()) && scheduledAt.getTime() > Date.now();

    // Single-recipient email: try SendGrid + MessageHistory first; queue only if send fails or disabled
    const immediateAllowed =
      process.env.MESSAGE_IMMEDIATE_SEND !== 'false' &&
      tryImmediateSend !== false &&
      !isFutureScheduled &&
      messageType === 'Email' &&
      tenantId;

    if (immediateAllowed) {
      try {
        const sent = await trySendEmailImmediate({
          pool,
          messageId,
          tenantId,
          recipientId,
          toEmail,
          subject,
          emailBody,
          batchId: null
        });
        if (sent) {
          console.log(`✅ Email sent immediately (not queued): ${messageId} to ${toEmail}`);
          return messageId;
        }
        console.warn(`⚠️ [MessageQueue.queueEmail] Immediate send did not complete; queueing Pending row messageId=${messageId} to=${toEmail}`);
      } catch (immediateErr) {
        console.warn(`⚠️ Immediate send error, falling back to queue: ${immediateErr.message}`);
      }
    }

    try {
      // Ground truth: ask SQL Server which DB this connection is using (not just pool.config)
      const dbCheck = await pool.request().query('SELECT DB_NAME() AS CurrentDB, @@SERVERNAME AS ServerName');
      const actualDb = dbCheck.recordset && dbCheck.recordset[0] ? dbCheck.recordset[0].CurrentDB : '?';
      const actualServer = dbCheck.recordset && dbCheck.recordset[0] ? dbCheck.recordset[0].ServerName : '?';
      console.log(`📬 [MessageQueue.queueEmail] Actual DB from SQL: ${actualServer} / ${actualDb} (pool.config: ${dbServer} / ${dbName})`);

      const query = `
        INSERT INTO oe.MessageQueue (
          MessageId, TenantId, RecipientId, MessageType,
          RecipientAddress, Subject, Body, Status,
          RetryCount, CreatedDate, CreatedBy, BatchId, QueuePriority, ScheduledSendDate
        ) VALUES (
          @messageId, @tenantId, @recipientId, @messageType,
          @recipientAddress, @subject, @body, 'Pending',
          0, GETUTCDATE(), @createdBy, @batchId, @queuePriority, @scheduledSendDate
        )
      `;

      const request = pool.request();
      request.input('messageId', sql.UniqueIdentifier, messageId);
      request.input('tenantId', sql.UniqueIdentifier, tenantId);
      request.input('batchId', sql.UniqueIdentifier, null);
      // Handle nullable recipientId - SQL Server UniqueIdentifier can accept null
      if (recipientId) {
        request.input('recipientId', sql.UniqueIdentifier, recipientId);
      } else {
        request.input('recipientId', sql.UniqueIdentifier, null);
      }
      request.input('messageType', sql.NVarChar, messageType);
      request.input('recipientAddress', sql.NVarChar, toEmail);
      request.input('subject', sql.NVarChar, subject);
      
      const bodyLength = (emailBody && emailBody.length) || 0;
      console.log(`📬 [MessageQueue.queueEmail] DB: ${dbServer} / ${dbName}, to: ${toEmail}, subject: "${(subject || '').slice(0, 50)}...", body length: ${bodyLength}, messageId: ${messageId}`);
      request.input('body', sql.NVarChar, emailBody);
      request.input('createdBy', sql.UniqueIdentifier, createdBy);
      request.input('queuePriority', sql.Int, 0);
      request.input('scheduledSendDate', sql.DateTime2, isFutureScheduled ? scheduledAt : null);

      const insertResult = await request.query(query);
      const rowsAffected = (insertResult && insertResult.rowsAffected && insertResult.rowsAffected[0]) || 0;
      console.log(`📬 [MessageQueue.queueEmail] INSERT completed, rowsAffected: ${rowsAffected}, messageId: ${messageId}`);

      // Verify row exists in oe.MessageQueue (same connection = same DB)
      const verifyRequest = pool.request();
      verifyRequest.input('messageId', sql.UniqueIdentifier, messageId);
      const verifyResult = await verifyRequest.query(
        'SELECT MessageId, RecipientAddress, Subject, Status, CreatedDate FROM oe.MessageQueue WHERE MessageId = @messageId'
      );
      const found = verifyResult.recordset && verifyResult.recordset.length > 0;
      const row = found ? verifyResult.recordset[0] : null;
      console.log(`📬 [MessageQueue.queueEmail] Same-connection SELECT: ${found ? 'FOUND' : 'NOT FOUND'} for messageId: ${messageId}` + (row ? `, CreatedDate: ${row.CreatedDate}` : ''));

      // Second connection: prove row is committed and visible to other connections (same DB as db-query.sh would use)
      let secondConnFound = false;
      try {
        const mssql = require('mssql');
        const secondConfig = {
          user: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          server: process.env.DB_SERVER,
          database: process.env.DB_NAME,
          options: { encrypt: true, trustServerCertificate: false }
        };
        const secondPool = new mssql.ConnectionPool(secondConfig);
        await secondPool.connect();
        const secondDbCheck = await secondPool.request().query('SELECT DB_NAME() AS CurrentDB, @@SERVERNAME AS ServerName');
        const sDb = secondDbCheck.recordset?.[0]?.CurrentDB ?? '?';
        const sSrv = secondDbCheck.recordset?.[0]?.ServerName ?? '?';
        const secondReq = secondPool.request();
        secondReq.input('messageId', sql.UniqueIdentifier, messageId);
        const secondResult = await secondReq.query('SELECT MessageId, RecipientAddress, Status, CreatedDate FROM oe.MessageQueue WHERE MessageId = @messageId');
        secondConnFound = secondResult.recordset && secondResult.recordset.length > 0;
        console.log(`📬 [MessageQueue.queueEmail] Second-connection SELECT (${sSrv} / ${sDb}): row ${secondConnFound ? 'FOUND' : 'NOT FOUND'} for messageId: ${messageId}`);
        await secondPool.close();
      } catch (secondErr) {
        console.error(`📬 [MessageQueue.queueEmail] Second-connection check failed:`, secondErr.message);
      }
      if (found && !secondConnFound) {
        console.error(`📬 [MessageQueue.queueEmail] WARNING: Row visible on same connection but NOT on second connection - possible uncommitted write or different DB.`);
      }

      console.log(`✅ Queued email message: ${messageId} to ${toEmail}`);

      return messageId;
    } catch (error) {
      console.error('❌ Error queuing email:', {
        message: error.message,
        code: error.code,
        toEmail,
        messageId,
        dbServer,
        dbName,
        precedingErrors: error.precedingErrors || null
      });
      throw error;
    }
  }

  /**
   * Send enrollment invitation email
   * @param {Object} params - Email parameters
   * @returns {Promise<string>} Message ID
   */
  static async sendEnrollmentInvitation(params) {
    const {
      tenantId,
      memberId,
      memberUserId, // This should be the UserId, not MemberId
      memberFirstName,
      memberEmail,
      enrollmentUrl,
      groupId = null,
      createdBy,
      expiresAt = null,
      expirationHours = 72
    } = params;

    try {
      // Generate email content
      const htmlContent = await EmailTemplatesService.generateEnrollmentInvitation({
        tenantId,
        memberId,
        memberFirstName,
        memberEmail,
        enrollmentUrl,
        groupId,
        expiresAt,
        expirationHours
      });

      // Get tenant config for subject and from address
      const tenantConfig = await EmailTemplatesService.getTenantEmailConfig(tenantId);
      const groupInfo = groupId ? await EmailTemplatesService.getGroupInfo(groupId) : null;

      const subject = `Complete Your Benefits Enrollment${groupInfo ? ` - ${groupInfo.groupName}` : ''}`;

      // Queue the email
      return await this.queueEmail({
        tenantId,
        toEmail: memberEmail,
        toName: memberFirstName,
        subject,
        htmlContent,
        messageType: 'Email',
        createdBy,
        recipientId: memberUserId
      });
    } catch (error) {
      console.error('❌ Error sending enrollment invitation:', error);
      throw error;
    }
  }

  /**
   * Send onboarding invitation email
   * @param {Object} params - Email parameters
   * @returns {Promise<string>} Message ID
   */
  static async sendOnboardingInvitation(params) {
    const {
      tenantId,
      contactFirstName,
      contactEmail,
      onboardingUrl,
      groupId,
      groupName,
      createdBy
    } = params;

    try {
      // Generate email content
      const htmlContent = await EmailTemplatesService.generateOnboardingInvitation({
        tenantId,
        contactFirstName,
        contactEmail,
        onboardingUrl,
        groupId,
        groupName
      });

      // Get tenant config for subject and from address
      const tenantConfig = await EmailTemplatesService.getTenantEmailConfig(tenantId);
      const groupInfo = await EmailTemplatesService.getGroupInfo(groupId);

      const subject = `Welcome to ${tenantConfig.tenantName} - ${groupInfo?.groupName || groupName} Onboarding`;

      // Queue the email
      return await this.queueEmail({
        tenantId,
        toEmail: contactEmail,
        toName: contactFirstName,
        subject,
        htmlContent,
        messageType: 'Email',
        createdBy
      });
    } catch (error) {
      console.error('❌ Error sending onboarding invitation:', error);
      throw error;
    }
  }

  /**
   * Send user welcome email
   * @param {Object} params - Email parameters
   * @returns {Promise<string>} Message ID
   */
  static async sendUserWelcome(params) {
    const {
      tenantId,
      userId,
      userEmail,
      firstName,
      userType,
      setupUrl,
      createdBy,
      organizationName
    } = params;

    try {
      // Generate email content
      const htmlContent = await EmailTemplatesService.generateUserWelcome({
        tenantId,
        firstName,
        userEmail,
        userType,
        setupUrl,
        organizationName
      });

      // Get tenant config for subject (e.g. vendor users: organizationName = VendorName, not product-owner tenant)
      const tenantConfig = await EmailTemplatesService.getTenantEmailConfig(tenantId);
      const subjectOrg =
        organizationName != null && String(organizationName).trim() !== ''
          ? String(organizationName).trim()
          : tenantConfig.tenantName;
      const subject = `Welcome to ${subjectOrg} - Account Setup`;

      // Queue the email
      return await this.queueEmail({
        tenantId,
        toEmail: userEmail,
        toName: firstName,
        subject,
        htmlContent,
        messageType: 'Email',
        createdBy,
        recipientId: userId
      });
    } catch (error) {
      console.error('❌ Error sending user welcome:', error);
      throw error;
    }
  }

  /**
   * Get tenant email configuration for sending
   * @param {string} tenantId - Tenant ID
   * @returns {Promise<Object>} Email configuration
   */
  static async getTenantEmailConfig(tenantId) {
    try {
      const pool = await getPool();
      const query = `
        SELECT 
          t.Name as tenantName,
          t.AdvancedSettings
        FROM oe.Tenants t
        WHERE t.TenantId = @tenantId
      `;
      
      const request = pool.request();
      request.input('tenantId', sql.UniqueIdentifier, tenantId);
      const result = await request.query(query);
      
      if (result.recordset.length === 0) {
        throw new Error('Tenant not found');
      }
      
      const tenant = result.recordset[0];
      const advancedSettings = tenant.AdvancedSettings ? JSON.parse(tenant.AdvancedSettings) : {};
      
      const { resolveFromEmailForTenant, platformDefaultFromEmail } = require('../utils/tenantEmailFrom');
      return {
        tenantName: tenant.tenantName,
        customFromAddress: resolveFromEmailForTenant(advancedSettings.email),
        defaultFromEmail:
          advancedSettings.email?.defaultFromEmail || platformDefaultFromEmail(),
      };
    } catch (error) {
      console.error('❌ Error getting tenant email config:', error);
      throw error;
    }
  }

  /**
   * Send payment failure notification email
   * @param {Object} params - Email parameters
   * @returns {Promise<string>} Message ID
   */
  static async sendPaymentFailureNotification(params) {
    const {
      tenantId,
      memberId,
      memberUserId,
      memberName,
      memberEmail,
      paymentAmount,
      paymentDate,
      paymentMethod,
      transactionId,
      failureReason,
      achReturnCode,
      achReturnReason,
      chargebackReason,
      createdBy
    } = params;

    try {
      // Generate email content
      const htmlContent = await EmailTemplatesService.generatePaymentFailureNotification({
        tenantId,
        memberName,
        paymentAmount,
        paymentDate,
        paymentMethod,
        transactionId,
        failureReason,
        achReturnCode,
        achReturnReason,
        chargebackReason
      });

      // Get tenant config for subject and from address
      const tenantConfig = await EmailTemplatesService.getTenantEmailConfig(tenantId);
      const formattedAmountLabel = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD'
      }).format(Number(paymentAmount));

      const subject = `Payment failed — ${formattedAmountLabel} — ${tenantConfig.tenantName}`;

      // Queue the email
      return await this.queueEmail({
        tenantId,
        toEmail: memberEmail,
        toName: memberName,
        subject,
        htmlContent,
        messageType: 'Email',
        createdBy,
        recipientId: memberUserId,
        ...MessageQueueService.billingNotificationQueueOptions(),
      });
    } catch (error) {
      console.error('❌ Error sending payment failure notification:', error);
      throw error;
    }
  }

  /**
   * Webhook/internal: queue member + agent payment failure notices (distinct copy per audience).
   * @param {Object} body
   */
  static async queuePaymentFailureNotifications(body) {
    const tenantId = body.tenantId;
    if (!tenantId || String(tenantId).trim() === '') {
      throw new Error('tenantId is required');
    }
    const paymentAmount = Number(body.paymentAmount);
    if (!Number.isFinite(paymentAmount)) {
      throw new Error('paymentAmount must be a finite number');
    }

    const normEmail = (e) => {
      if (e == null || e === '') return '';
      const s = String(e).trim();
      return s;
    };
    const memberEmail = normEmail(body.memberEmail);
    const agentEmail = normEmail(body.agentEmail);

    const paymentDate = body.paymentDate || new Date().toISOString();
    const tenantConfig = await EmailTemplatesService.getTenantEmailConfig(tenantId);
    const formattedAmountLabel = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(paymentAmount);

    const failureBundle = {
      failureReason: body.failureReason ?? null,
      achReturnCode: body.achReturnCode ?? body.return_code ?? null,
      achReturnReason: body.achReturnReason ?? body.return_reason ?? null,
      chargebackReason: body.chargebackReason ?? null
    };

    const rawAttempt = body.paymentAttemptNumber ?? body.payment_attempt_number;
    const paymentAttemptNumber =
      rawAttempt != null && rawAttempt !== '' && Number.isFinite(Number(rawAttempt)) ? Number(rawAttempt) : null;
    const rawConsec = body.paymentConsecutiveFailureCount ?? body.payment_consecutive_failure_count;
    const paymentConsecutiveFailureCount =
      rawConsec != null && rawConsec !== '' && Number.isFinite(Number(rawConsec)) ? Number(rawConsec) : null;

    const retryBundle = {
      paymentAttemptNumber,
      paymentConsecutiveFailureCount
    };

    const retrySubjectFrag =
      EmailTemplatesService.paymentFailureSubjectRetryFragment(paymentAttemptNumber);

    const messageIds = [];
    let memberQueued = false;
    let agentQueued = false;
    let skippedReason = null;

    const gb =
      body.groupBillingContact === true ||
      body.groupBillingContact === 'true' ||
      body.groupBillingContact === 1 ||
      body.groupBillingContact === '1';

    if (!memberEmail && !agentEmail) {
      skippedReason = 'no_recipient_emails';
      return { memberQueued: false, agentQueued: false, messageIds: [], skippedReason };
    }

    if (memberEmail) {
      const htmlContent = await EmailTemplatesService.generatePaymentFailureNotification({
        tenantId,
        memberName: body.memberDisplayName || 'there',
        groupName: body.groupName || '',
        groupBillingContact: gb,
        paymentAmount,
        paymentDate,
        paymentMethod: body.paymentMethod,
        transactionId: body.transactionId,
        ...failureBundle,
        ...retryBundle
      });
      const subjectMember = gb
        ? `Group payment failed${retrySubjectFrag} — ${formattedAmountLabel} — ${tenantConfig.tenantName}`
        : `Payment failed${retrySubjectFrag} — ${formattedAmountLabel} — ${tenantConfig.tenantName}`;
      const mid = await this.queueEmail({
        tenantId,
        toEmail: memberEmail,
        toName: body.memberDisplayName || 'Member',
        subject: subjectMember,
        htmlContent,
        messageType: 'Email',
        createdBy: body.createdBy ?? null,
        recipientId: body.memberUserId || null,
        ...MessageQueueService.billingNotificationQueueOptions(),
      });
      messageIds.push(mid);
      memberQueued = true;
    }

    // Respect the agent's "payment alerts" notification preference before sending the agent copy.
    let agentOptedOutOfPaymentAlerts = false;
    if (agentEmail) {
      try {
        const { resolveAgentByUserId, isAgentNotificationOptedOut } = require('./agentCommunicationPreferences.service');
        let agentId = body.agentId || null;
        if (!agentId && body.agentUserId) {
          const resolved = await resolveAgentByUserId(body.agentUserId);
          agentId = resolved && resolved.agentId;
        }
        if (agentId) {
          agentOptedOutOfPaymentAlerts = await isAgentNotificationOptedOut(agentId, 'payment');
        }
      } catch (prefErr) {
        console.warn('⚠️ [paymentFailure] agent payment-alert preference check failed; sending anyway:', prefErr.message);
      }
    }

    if (agentEmail && !agentOptedOutOfPaymentAlerts) {
      const agentScopeRaw = body.agentScope;
      const agentScope = agentScopeRaw === 'group' ? 'group' : 'member';

      const htmlAgent = await EmailTemplatesService.generatePaymentFailureAgentNotification({
        tenantId,
        agentName: body.agentDisplayName || body.agentFirstName || 'Agent',
        agentScope,
        memberDisplayNameForAgent:
          agentScope === 'group'
            ? ''
            : (body.memberDisplayNameForAgent ?? body.memberDisplayName ?? ''),
        groupName: body.groupName || '',
        paymentAmount,
        paymentDate,
        paymentMethod: body.paymentMethod,
        transactionId: body.transactionId,
        ...failureBundle,
        ...retryBundle
      });

      const subjectAgent =
        agentScope === 'group'
          ? `Group payment declined${retrySubjectFrag} — ${formattedAmountLabel} — ${tenantConfig.tenantName}`
          : `Member payment declined${retrySubjectFrag} — ${formattedAmountLabel} — ${tenantConfig.tenantName}`;

      const aid = await this.queueEmail({
        tenantId,
        toEmail: agentEmail,
        toName: body.agentDisplayName || 'Agent',
        subject: subjectAgent,
        htmlContent: htmlAgent,
        messageType: 'Email',
        createdBy: body.createdBy ?? null,
        recipientId: body.agentUserId || null,
        ...MessageQueueService.billingNotificationQueueOptions(),
      });
      messageIds.push(aid);
      agentQueued = true;
    }

    if (agentEmail && agentOptedOutOfPaymentAlerts) {
      skippedReason = skippedReason || 'agent_opted_out_payment_alerts';
    }

    return { memberQueued, agentQueued, messageIds, skippedReason, agentOptedOut: agentOptedOutOfPaymentAlerts };
  }

  /**
   * Queue one BulkBatch job row for the Message Center worker (SendGrid/Twilio fan-out, MessageHistory per recipient).
   * @param {Object} params
   * @param {string} params.tenantId
   * @param {string} params.batchId - MessageSendBatch.BatchId
   * @param {Object} params.bodyPayload - v1 JSON for processBulkBatch
   * @param {string|null} params.createdBy
   * @returns {Promise<string>} Bulk job MessageId
   */
  static async queueBulkBatchMessage({ tenantId, batchId, bodyPayload, createdBy }) {
    const pool = await getPool();
    const messageId = require('crypto').randomUUID();
    const bodyStr = typeof bodyPayload === 'string' ? bodyPayload : JSON.stringify(bodyPayload);

    const query = `
      INSERT INTO oe.MessageQueue (
        MessageId, TenantId, RecipientId, MessageType,
        RecipientAddress, Subject, Body, Status,
        RetryCount, CreatedDate, CreatedBy, BatchId, QueuePriority
      ) VALUES (
        @messageId, @tenantId, @recipientId, @messageType,
        @recipientAddress, @subject, @body, 'Pending',
        0, GETUTCDATE(), @createdBy, @batchId, @queuePriority
      )
    `;

    const request = pool.request();
    request.input('messageId', sql.UniqueIdentifier, messageId);
    request.input('tenantId', sql.UniqueIdentifier, tenantId);
    request.input('recipientId', sql.UniqueIdentifier, null);
    request.input('messageType', sql.NVarChar, 'BulkBatch');
    request.input('recipientAddress', sql.NVarChar, 'bulk@local');
    request.input('subject', sql.NVarChar, 'Message blast');
    request.input('body', sql.NVarChar(sql.MAX), bodyStr);
    request.input('createdBy', sql.UniqueIdentifier, createdBy || null);
    request.input('batchId', sql.UniqueIdentifier, batchId);
    request.input('queuePriority', sql.Int, 10);

    await request.query(query);
    console.log(`✅ Queued BulkBatch job: ${messageId} batchId=${batchId}`);
    return messageId;
  }

}

module.exports = MessageQueueService;
