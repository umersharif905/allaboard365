/**
 * DIME Webhook Processor - Simplified Single Table Approach
 * All payment events stored in oe.Payments table
 */

const crypto = require('crypto');
const { getPool, sql } = require('../shared/db');
const { createLogger } = require('../shared/logger');
// const MessageQueueService = require('../../backend/services/messageQueue.service'); // TODO: Fix import path for Azure Functions

module.exports = async function (context, req) {
  const logger = createLogger(context);
  logger.info('Webhook received');

  let pool;

  try {
    // Verify webhook signature
    const signature = req.headers['x-dime-signature'];
    const payload = JSON.stringify(req.body);
    
    const signatureResult = verifyWebhookSignature(signature, payload);
    if (!signatureResult.valid) {
      logger.error(`Invalid webhook signature from ${signatureResult.environment} environment`);
      context.res = { status: 401, body: { error: 'Invalid signature' } };
      return;
    }
    
    logger.info(`Webhook verified from ${signatureResult.environment} environment`);

    const { event_type, data } = req.body;
    logger.info(`Event type: ${event_type}`);

    // Connect to database
    pool = await getPool();
    let webhookEventId = null;

    try {
    // Store webhook event
      webhookEventId = await storeWebhookEvent(pool, event_type, data, signatureResult.environment);
      logger.info(`Stored webhook event: ${webhookEventId} from ${signatureResult.environment} environment`);

    // Process based on event type
    switch (event_type) {
        // Credit Card Events
        case 'credit_card_charge':
          await handleCreditCardCharge(pool, data, webhookEventId, logger);
          break;
        case 'credit_card_refund':
          await handleCreditCardRefund(pool, data, webhookEventId, logger);
          break;
        case 'credit_card_void':
          await handleCreditCardVoid(pool, data, webhookEventId, logger);
          break;
        case 'credit_card_chargeback':
          await handleCreditCardChargeback(pool, data, webhookEventId, logger);
          break;

        // ACH Events
        case 'ach_charge':
          await handleACHCharge(pool, data, webhookEventId, logger);
          break;
        case 'ach_payment_return':
          await handleACHPaymentReturn(pool, data, webhookEventId, logger);
          break;
        case 'ach_refund':
          await handleACHRefund(pool, data, webhookEventId, logger);
          break;

        // Deposit Events
        case 'deposit_sent':
          await handleDepositSent(pool, data, webhookEventId, logger);
          break;

        // Recurring Payment Events
      case 'recurring_payment.success':
        await handleRecurringPaymentSuccess(pool, data, webhookEventId, logger);
        break;
      case 'recurring_payment.failed':
        await handleRecurringPaymentFailed(pool, data, webhookEventId, logger);
        break;
      case 'recurring_payment.schedule_updated':
        logger.info('Schedule updated event received (informational only)');
        break;
        case 'recurring_payment.schedule_canceled':
          logger.info('Schedule canceled event received (informational only)');
          break;

      default:
        logger.warn(`Unknown event type: ${event_type}`);
    }

      // Mark webhook as processed
      await markWebhookProcessed(pool, webhookEventId, true);

      context.res = { status: 200, body: { success: true, event_type, processed: true } };

    } catch (error) {
      logger.error(`Error processing webhook: ${error.message}`);
      
      if (webhookEventId) {
        await markWebhookProcessed(pool, webhookEventId, false, error.message);
      }
      
      context.res = { status: 200, body: { success: false, error: error.message } };
    }

  } catch (error) {
    logger.error(`Webhook processing failed: ${error.message}`);
    context.res = { status: 500, body: { error: 'Internal server error' } };
  } finally {
    if (pool) {
      await pool.close();
    }
  }
};

function verifyWebhookSignature(signature, payload) {
  const demoSecret = process.env.DIME_DEMO_WEBHOOK_SECRET;
  const prodSecret = process.env.DIME_WEBHOOK_SECRET;
  
  // Try demo environment first
  if (demoSecret) {
    const expectedSignature = crypto
      .createHmac('sha256', demoSecret)
      .update(payload)
      .digest('hex');
    
    if (signature === `sha256=${expectedSignature}`) {
      return { valid: true, environment: 'demo' };
    }
  }
  
  // Try production environment
  if (prodSecret) {
  const expectedSignature = crypto
      .createHmac('sha256', prodSecret)
    .update(payload)
    .digest('hex');

    if (signature === `sha256=${expectedSignature}`) {
      return { valid: true, environment: 'production' };
    }
  }
  
  // No valid signature found
  if (!demoSecret && !prodSecret) {
    console.warn('No DIME webhook secrets configured, skipping signature verification');
    return { valid: true, environment: 'development' };
  }
  
  return { valid: false, environment: 'unknown' };
}

async function storeWebhookEvent(pool, eventType, data, environment = 'unknown') {
  const result = await pool.request()
    .input('eventType', sql.NVarChar(100), eventType)
    .input('eventId', sql.NVarChar(255), data.event_id || data.id || `webhook_${Date.now()}`)
    .input('processor', sql.NVarChar(50), 'DIME')
    .input('processorEventId', sql.NVarChar(255), data.event_id || data.id)
    .input('merchantId', sql.NVarChar(100), data.merchant_id || 'unknown')
    .input('payload', sql.NVarChar(sql.MAX), JSON.stringify(data))
    .input('transactionId', sql.NVarChar(255), data.transaction_id || data.transactionNumber)
    .input('amount', sql.Decimal(10,2), data.amount)
    .input('status', sql.NVarChar(50), data.status)
    .query(`
      INSERT INTO oe.PaymentWebhookEvents (
        EventId, EventType, Processor, ProcessorEventId, MerchantId, Payload, 
        TransactionId, Amount, Status, Processed, CreatedDate, ModifiedDate
      )
      OUTPUT inserted.WebhookEventId
      VALUES (
        NEWID(), @eventType, @processor, @processorEventId, @merchantId, @payload,
        @transactionId, @amount, @status, 0, GETUTCDATE(), GETUTCDATE()
      )
    `);

  return result.recordset[0].WebhookEventId;
}

async function markWebhookProcessed(pool, webhookEventId, success, errorMessage = null) {
  await pool.request()
    .input('webhookEventId', sql.Int, webhookEventId)
    .input('processed', sql.Bit, success)
    .input('processedAt', sql.DateTime2, success ? new Date() : null)
    .input('errorMessage', sql.NVarChar(sql.MAX), errorMessage)
    .query(`
      UPDATE oe.PaymentWebhookEvents
      SET Processed = @processed, 
          ProcessedAt = @processedAt,
          ErrorMessage = @errorMessage,
          ModifiedDate = GETUTCDATE()
      WHERE WebhookEventId = @webhookEventId
    `);
}

// ============================================================================
// WEBHOOK EVENT HANDLERS - SIMPLIFIED SINGLE TABLE APPROACH
// ============================================================================

// Helper function to get GroupId and TenantId from enrollment context
async function getEnrollmentContext(pool, enrollmentId, logger) {
  if (!enrollmentId) return { 
    groupId: null, 
    tenantId: null, 
    agentId: null,
    householdId: null,
    netRate: null,
    commission: null,
    overrideRate: null,
    systemFees: null
  };
  
  try {
    const enrollmentContext = await pool.request()
      .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
      .query(`
        SELECT 
          m.GroupId,
          e.HouseholdId,
          COALESCE(g.TenantId, p.ProductOwnerId) as TenantId,
          e.AgentId,
          e.NetRate,
          e.Commission,
          e.OverrideRate,
          e.SystemFees
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        INNER JOIN oe.Products p ON e.ProductId = p.ProductId
        LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
        WHERE e.EnrollmentId = @enrollmentId
      `);
    
    if (enrollmentContext.recordset.length > 0) {
      const row = enrollmentContext.recordset[0];
      return {
        groupId: row.GroupId,
        householdId: row.HouseholdId || null,
        tenantId: row.TenantId || null,
        agentId: row.AgentId || null,
        netRate: row.NetRate || 0,
        commission: row.Commission || 0,
        overrideRate: row.OverrideRate || 0,
        systemFees: row.SystemFees || 0
      };
    }
  } catch (error) {
    logger.warn(`Could not get enrollment context: ${error.message}`);
  }
  
  return { 
    groupId: null, 
    tenantId: null, 
    agentId: null,
    householdId: null,
    netRate: null,
    commission: null,
    overrideRate: null,
    systemFees: null
  };
}

// Helper function to get failure attempt information for a payment
async function getFailureAttemptInfo(pool, groupId, tenantId, amount, paymentMethod, logger) {
  try {
    if (!groupId || !tenantId) {
      return { attemptNumber: 1, consecutiveFailures: 0, originalPaymentId: null };
    }

    // Find the most recent failed payment for this group/tenant with same amount/method
    const failureResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('amount', sql.Decimal(10,2), amount)
      .input('paymentMethod', sql.NVarChar(50), paymentMethod)
      .query(`
        SELECT TOP 1 
          PaymentId,
          AttemptNumber,
          ConsecutiveFailureCount,
          OriginalPaymentId
        FROM oe.Payments
        WHERE GroupId = @groupId 
          AND TenantId = @tenantId
          AND Amount = @amount
          AND PaymentMethod = @paymentMethod
          AND Status = 'Failed'
          AND TransactionType = 'Payment'
        ORDER BY CreatedDate DESC
      `);

    if (failureResult.recordset.length === 0) {
      // First attempt
      return { attemptNumber: 1, consecutiveFailures: 0, originalPaymentId: null };
    }

    const lastFailure = failureResult.recordset[0];
    const lastAttempt = lastFailure.AttemptNumber || 1;
    const lastConsecutiveFailures = lastFailure.ConsecutiveFailureCount || 0;
    const originalPaymentId = lastFailure.OriginalPaymentId || lastFailure.PaymentId;

    return {
      attemptNumber: lastAttempt + 1,
      consecutiveFailures: lastConsecutiveFailures + 1,
      originalPaymentId: originalPaymentId
    };
  } catch (error) {
    logger.warn(`Could not get failure attempt info: ${error.message}`);
    return { attemptNumber: 1, consecutiveFailures: 0, originalPaymentId: null };
  }
}

// Helper function to send payment failure notification email
async function sendPaymentFailureNotification(pool, paymentData, logger, groupId, tenantId) {
  try {
    logger.info(`sendPaymentFailureNotification called - GroupId: ${groupId}, TenantId: ${tenantId}, EnrollmentId: ${paymentData.enrollment_id}`);
    
    // Try to get group contact email if no enrollment_id
    let groupContactEmail = null;
    let memberResult = null;
    let groupName = null;
    let userId = null;
    
    if (groupId && !paymentData.enrollment_id) {
      // For group-level payments, get the group's contact email
      logger.info(`Looking up group contact email for GroupId: ${groupId}`);
      const groupResult = await pool.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .query(`
          SELECT ContactEmail, Name as GroupName
          FROM oe.Groups
          WHERE GroupId = @groupId
        `);
      
      if (groupResult.recordset.length > 0) {
        groupContactEmail = groupResult.recordset[0].ContactEmail;
        groupName = groupResult.recordset[0].GroupName;
        logger.info(`Group contact email found: ${groupContactEmail}`);
      } else {
        logger.warn(`No group found with GroupId: ${groupId}`);
      }
    }
    
    // Get member information for the payment (if enrollment_id exists)
    if (paymentData.enrollment_id) {
      memberResult = await pool.request()
        .input('enrollmentId', sql.UniqueIdentifier, paymentData.enrollment_id)
        .query(`
          SELECT 
            m.MemberId,
            m.UserId,
            u.FirstName,
            u.LastName,
            u.Email,
            g.TenantId,
            g.Name as GroupName
          FROM oe.Enrollments e
          LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
          LEFT JOIN oe.Users u ON m.UserId = u.UserId
          LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
          WHERE e.EnrollmentId = @enrollmentId
        `);

      if (memberResult.recordset.length > 0) {
        const member = memberResult.recordset[0];
        // Use member email
        groupContactEmail = member.Email;
        userId = member.UserId;
        groupName = member.GroupName;
      }
    }

    if (!groupContactEmail) {
      logger.warn('No contact email found for payment failure notification');
      return;
    }

    // Fetch payment method details (last 4 digits)
    let paymentMethodLast4 = null;
    let paymentMethodType = paymentData.payment_method || 'Unknown';
    if (groupId) {
      try {
        // Look for the most recent default payment method for this group
        const paymentMethodResult = await pool.request()
          .input('groupId', sql.UniqueIdentifier, groupId)
          .input('paymentMethodType', sql.NVarChar(50), paymentMethodType)
          .query(`
            SELECT TOP 1 
              CardLast4, 
              AccountNumberLast4,
              Type
            FROM oe.GroupPaymentMethods
            WHERE GroupId = @groupId
              AND Status = 'Active'
              AND Type = @paymentMethodType
            ORDER BY IsDefault DESC, CreatedDate DESC
          `);
        
        if (paymentMethodResult.recordset.length > 0) {
          const pm = paymentMethodResult.recordset[0];
          paymentMethodLast4 = pm.CardLast4 || pm.AccountNumberLast4 || null;
          paymentMethodType = pm.Type || paymentMethodType;
        }
      } catch (pmError) {
        logger.warn(`Could not fetch payment method details: ${pmError.message}`);
      }
    }

    // Get tenant settings for dashboard URL
    let dashboardUrl = 'https://open-enroll.com/member/dashboard'; // Default fallback
    try {
      const tenantResult = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT 
            CustomDomain,
            AdvancedSettings
          FROM oe.Tenants
          WHERE TenantId = @tenantId
        `);
      
      if (tenantResult.recordset.length > 0) {
        const tenant = tenantResult.recordset[0];
        const customDomain = tenant.CustomDomain;
        let verificationStatus = null;
        
        // Parse AdvancedSettings JSON if available
        if (tenant.AdvancedSettings) {
          try {
            const advancedSettings = JSON.parse(tenant.AdvancedSettings);
            verificationStatus = advancedSettings.domain?.verificationStatus || null;
          } catch (e) {
            logger.warn(`Could not parse AdvancedSettings JSON: ${e.message}`);
          }
        }
        
        // Use custom domain if available and verified
        if (customDomain && 
            (verificationStatus?.toLowerCase() === 'verified' || !verificationStatus)) {
          dashboardUrl = `https://${customDomain}${userId ? '/member/dashboard' : '/group-admin/dashboard'}`;
        }
      }
    } catch (urlError) {
      logger.warn(`Could not fetch tenant settings for dashboard URL: ${urlError.message}`);
    }

    // For group payments, RecipientId can be NULL
    let recipientId = userId || null;
    let finalTenantId = tenantId;
    
    // If we have member data from enrollment, use it
    if (paymentData.enrollment_id && memberResult && memberResult.recordset.length > 0) {
      const member = memberResult.recordset[0];
      recipientId = member.UserId;
      finalTenantId = member.TenantId || tenantId;
    }
    
    // Validate tenantId is a valid GUID or set to null
    logger.info(`Validating TenantId: ${finalTenantId}, Type: ${typeof finalTenantId}, Raw value: ${JSON.stringify(finalTenantId)}`);
    
    if (!finalTenantId) {
      logger.warn(`TenantId is ${finalTenantId} (undefined/null) - email not sent`);
      return;
    }

    // Convert to string if needed and validate GUID format
    let tenantIdStr = String(finalTenantId).trim();
    const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!guidPattern.test(tenantIdStr)) {
      logger.warn(`Invalid TenantId format: ${tenantIdStr}. Email not sent.`);
      return;
    }

    logger.info(`TenantId validated: ${tenantIdStr}`);
    finalTenantId = tenantIdStr;

    // Format payment method display
    const paymentMethodDisplay = paymentMethodLast4 
      ? `${paymentMethodType} ending in ${paymentMethodLast4}`
      : paymentMethodType;
    
    // Format attempt number display
    const attemptDisplay = paymentData.attempt_number 
      ? ` (Attempt ${paymentData.attempt_number})`
      : '';

    // Generate email content - Follow same table-based format as other emails
    const subject = `Payment Failed - $${paymentData.amount}${attemptDisplay}`;
    const failureReason = paymentData.failure_reason || paymentData.return_reason || paymentData.chargeback_reason || 'Unknown';
    
    const emailBody = `
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Payment Failed</title>
</head>
<body style="margin:0;padding:0;background-color:#f8f9fa;font-family:Arial,Helvetica,sans-serif;color:#333333;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f8f9fa;">
<tr>
<td align="center" style="padding:20px 0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1);">
<tr>
<td style="padding:30px 30px 20px 30px;text-align:center;border-bottom:2px solid #dc2626;">
<h1 style="margin:0;font-size:28px;font-weight:600;color:#dc2626;font-family:Arial,Helvetica,sans-serif;">Payment Failed${attemptDisplay}</h1>
</td>
</tr>
<tr>
<td style="padding:30px 30px;">
<h2 style="margin:0 0 20px 0;font-size:20px;font-weight:600;color:#333333;font-family:Arial,Helvetica,sans-serif;">Payment Attempt Unsuccessful</h2>
<p style="margin:0 0 20px 0;font-size:16px;line-height:24px;color:#555555;font-family:Arial,Helvetica,sans-serif;">Your payment of <strong>$${paymentData.amount}</strong> was not processed successfully.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f8f9fa;border-radius:6px;margin:20px 0;">
<tr>
<td style="padding:20px;">
<p style="margin:5px 0;font-size:14px;color:#666666;font-family:Arial,Helvetica,sans-serif;"><strong>Amount:</strong> $${paymentData.amount}</p>
<p style="margin:5px 0;font-size:14px;color:#666666;font-family:Arial,Helvetica,sans-serif;"><strong>Payment Method:</strong> ${paymentMethodDisplay}</p>
${paymentData.attempt_number ? `<p style="margin:5px 0;font-size:14px;color:#666666;font-family:Arial,Helvetica,sans-serif;"><strong>Attempt Number:</strong> ${paymentData.attempt_number}</p>` : ''}
<p style="margin:5px 0;font-size:14px;color:#666666;font-family:Arial,Helvetica,sans-serif;"><strong>Failure Reason:</strong> ${failureReason}</p>
</td>
</tr>
</table>
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:30px 0;">
<tr>
<td align="center">
<a href="${dashboardUrl}" style="display:inline-block;background-color:#1f8dbf;color:#ffffff;text-decoration:none;padding:15px 30px;border-radius:4px;font-size:16px;font-weight:600;font-family:Arial,Helvetica,sans-serif;">Update Payment Method</a>
</td>
</tr>
</table>
<p style="margin:20px 0 0 0;font-size:14px;color:#666666;font-family:Arial,Helvetica,sans-serif;">Please update your payment method in your dashboard to ensure your payments process successfully.</p>
</td>
</tr>
<tr>
<td style="padding:25px 30px;background-color:#f8f9fa;border-top:1px solid #e9ecef;text-align:center;border-radius:0 0 8px 8px;">
<p style="margin:0;font-size:13px;color:#666666;font-family:Arial,Helvetica,sans-serif;">This is an automated notification from your insurance administrator.</p>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>
    `;
    
    // Insert directly into MessageQueue
    logger.info(`Queuing email to MessageQueue - TenantId: ${finalTenantId}, Recipient: ${groupContactEmail}`);
    console.log('DEBUG: finalTenantId =', finalTenantId, typeof finalTenantId);
    
    // Build the INSERT query with proper NULL handling
    const recipientIdParam = recipientId || null;
    
    // Validate finalTenantId before using it (already validated earlier, but double-check)
    if (!finalTenantId || (typeof finalTenantId === 'string' && !finalTenantId.trim())) {
      logger.error(`Invalid tenantId for email queue: ${finalTenantId}`);
      return;
    }

    // Clean GUIDs (already validated earlier at line 365, guidPattern declared there)
    const cleanTenantId = String(finalTenantId).trim();
    const cleanRecipientId = recipientIdParam ? String(recipientIdParam).trim() : null;
    
    // Additional validation for recipientId if provided
    if (cleanRecipientId && !guidPattern.test(cleanRecipientId)) {
      logger.error(`Invalid RecipientId GUID format: ${cleanRecipientId}`);
      return;
    }

    // Embed GUIDs directly in SQL (already validated as proper GUIDs, safe from SQL injection)
    // This avoids mssql library parameter conversion issues
    const escapeSqlString = (str) => String(str).replace(/'/g, "''"); // Escape single quotes for SQL
    const recipientIdValue = cleanRecipientId ? `'${escapeSqlString(cleanRecipientId)}'` : 'NULL';
    
    const query = `
      INSERT INTO oe.MessageQueue (
        MessageId, TenantId, RecipientId, MessageType,
        RecipientAddress, Subject, Body, Status,
        RetryCount, CreatedDate, CreatedBy
      ) VALUES (
        NEWID(), 
        '${escapeSqlString(cleanTenantId)}', 
        ${recipientIdValue}, 
        @messageType,
        @recipientAddress, @subject, @body, 'Pending',
        0, GETUTCDATE(), NULL
      )
    `;
    
    const request = pool.request();
    request.input('messageType', sql.NVarChar, 'Email');
    request.input('recipientAddress', sql.NVarChar, groupContactEmail);
    request.input('subject', sql.NVarChar, subject);
    request.input('body', sql.NVarChar(sql.MAX), emailBody);
    
    logger.info(`Executing MessageQueue INSERT - TenantId: ${cleanTenantId} (embedded), RecipientId: ${cleanRecipientId || 'NULL'}`);
    
    await request.query(query);

    logger.info(`✅ Payment failure notification queued for ${groupContactEmail}`);
  } catch (error) {
    logger.error('Error sending payment failure notification:', error);
    logger.error(`Error details - TenantId: ${finalTenantId || 'unknown'}, GroupContactEmail: ${groupContactEmail || 'unknown'}, Error: ${error.message}`);
    console.error('PAYMENT FAILURE EMAIL ERROR:', {
      tenantId: finalTenantId || 'unknown',
      groupContactEmail: groupContactEmail || 'unknown',
      error: error.message,
      stack: error.stack
    });
    // Don't throw - email failure shouldn't break webhook processing
  }
}

async function handleCreditCardCharge(pool, data, webhookEventId, logger) {
  const transactionId = data.transaction_id || data.transactionNumber;
  const amount = data.amount;
  const status = data.status === 'completed' ? 'Completed' : 'Failed';
  const paymentMethod = data.payment_method || data.paymentMethod || 'Credit Card';

  logger.info(`Credit Card Charge: Transaction ${transactionId}, Amount: $${amount}, Status: ${status}, Method: ${paymentMethod}`);

  // Get GroupId, TenantId, AgentId, HouseholdId and pricing fields from enrollment context or webhook data
  const contextFromEnrollment = await getEnrollmentContext(pool, data.enrollment_id, logger);
  const groupId = contextFromEnrollment.groupId || data.group_id;
  const tenantId = contextFromEnrollment.tenantId || data.tenant_id;
  const agentId = contextFromEnrollment.agentId || null;
  const enrollmentId = data.enrollment_id || null;
  const householdId = contextFromEnrollment.householdId || null;
  const netRate = contextFromEnrollment.netRate || 0;
  const commission = contextFromEnrollment.commission || 0;
  const overrideRate = contextFromEnrollment.overrideRate || 0;
  const systemFees = contextFromEnrollment.systemFees || 0;

  // Get failure attempt tracking info if payment failed
  let attemptInfo = { attemptNumber: null, consecutiveFailures: null, originalPaymentId: null };
  if (status === 'Failed') {
    attemptInfo = await getFailureAttemptInfo(pool, groupId, tenantId, amount, paymentMethod, logger);
    logger.info(`Payment failure attempt ${attemptInfo.attemptNumber} (${attemptInfo.consecutiveFailures} consecutive failures)`);
  }

  // Insert payment record
  await pool.request()
    .input('transactionType', sql.NVarChar(50), 'Payment')
    .input('amount', sql.Decimal(10,2), amount)
    .input('status', sql.NVarChar(50), status)
    .input('processor', sql.NVarChar(50), 'DIME')
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .input('paymentMethod', sql.NVarChar(50), paymentMethod)
    .input('webhookEventId', sql.Int, webhookEventId)
    .input('paymentDate', sql.DateTime2, new Date())
    .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
    .input('agentId', sql.UniqueIdentifier, agentId)
    .input('householdId', sql.UniqueIdentifier, householdId)
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('netRate', sql.Decimal(10,2), netRate)
    .input('commission', sql.Decimal(10,2), commission)
    .input('overrideRate', sql.Decimal(10,2), overrideRate)
    .input('systemFees', sql.Decimal(10,2), systemFees)
    .input('attemptNumber', sql.Int, attemptInfo.attemptNumber)
    .input('originalPaymentId', sql.UniqueIdentifier, attemptInfo.originalPaymentId)
    .input('consecutiveFailures', sql.Int, attemptInfo.consecutiveFailures)
    .input('failureReason', sql.NVarChar(sql.MAX), data.failure_reason || null)
    .input('lastFailureDate', sql.DateTime2, status === 'Failed' ? new Date() : null)
    .query(`
      INSERT INTO oe.Payments (
        PaymentId, EnrollmentId, AgentId, HouseholdId, TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, FailureReason, WebhookEventId, PaymentDate, 
        GroupId, TenantId, NetRate, Commission, OverrideRate, SystemFees,
        AttemptNumber, OriginalPaymentId, ConsecutiveFailureCount, LastFailureDate,
        CreatedDate, ModifiedDate
      ) VALUES (
        NEWID(), @enrollmentId, @agentId, @householdId, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @failureReason, @webhookEventId, @paymentDate, 
        @groupId, @tenantId, @netRate, @commission, @overrideRate, @systemFees,
        @attemptNumber, @originalPaymentId, @consecutiveFailures, @lastFailureDate,
        GETUTCDATE(), GETUTCDATE()
      )
    `);

  logger.success(`Credit card charge processed: ${transactionId}${attemptInfo.attemptNumber ? ` (Attempt ${attemptInfo.attemptNumber})` : ''}`);
  
  // Send email notification if payment failed
  if (status === 'Failed') {
    try {
      logger.info(`Attempting to send payment failure notification. GroupId: ${groupId}, TenantId: ${tenantId}`);
      await sendPaymentFailureNotification(pool, {
        enrollment_id: data.enrollment_id,
        amount: amount,
        payment_method: paymentMethod,
        transaction_id: transactionId,
        failure_reason: data.failure_reason,
        attempt_number: attemptInfo.attemptNumber
      }, logger, groupId, tenantId);
    } catch (emailError) {
      logger.error('Failed to send payment failure notification:', emailError);
    }
  }
}

async function handleCreditCardRefund(pool, data, webhookEventId, logger) {
  const transactionId = data.transaction_id || data.transactionNumber;
  const amount = data.amount;
  const originalTransactionId = data.original_transaction_id;

  logger.info(`Credit Card Refund: Transaction ${transactionId}, Amount: $${amount}`);

  // Find original payment (including pricing fields)
  const originalPayment = await pool.request()
    .input('processorTransactionId', sql.NVarChar(255), originalTransactionId)
    .query(`
      SELECT PaymentId, GroupId, TenantId, NetRate, Commission, OverrideRate, SystemFees
      FROM oe.Payments 
      WHERE ProcessorTransactionId = @processorTransactionId 
        AND TransactionType = 'Payment'
    `);

  if (originalPayment.recordset.length === 0) {
    throw new Error(`Original payment not found: ${originalTransactionId}`);
  }

  const originalPaymentData = originalPayment.recordset[0];
  const originalPaymentId = originalPaymentData.PaymentId;
  const groupId = originalPaymentData.GroupId;
  const tenantId = originalPaymentData.TenantId;
  const netRate = originalPaymentData.NetRate || 0;
  const commission = originalPaymentData.Commission || 0;
  const overrideRate = originalPaymentData.OverrideRate || 0;
  const systemFees = originalPaymentData.SystemFees || 0;

  // Insert refund record (negative amount, carry forward pricing from original)
  await pool.request()
    .input('transactionType', sql.NVarChar(50), 'Refund')
    .input('amount', sql.Decimal(10,2), -amount) // Negative amount for refund
    .input('status', sql.NVarChar(50), 'Completed')
    .input('processor', sql.NVarChar(50), 'DIME')
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .input('paymentMethod', sql.NVarChar(50), 'CreditCard')
    .input('originalPaymentId', sql.UniqueIdentifier, originalPaymentId)
    .input('webhookEventId', sql.Int, webhookEventId)
    .input('paymentDate', sql.DateTime2, new Date())
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('netRate', sql.Decimal(10,2), netRate)
    .input('commission', sql.Decimal(10,2), commission)
    .input('overrideRate', sql.Decimal(10,2), overrideRate)
    .input('systemFees', sql.Decimal(10,2), systemFees)
    .query(`
      INSERT INTO oe.Payments (
        PaymentId, EnrollmentId, HouseholdId, TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, OriginalPaymentId, WebhookEventId, PaymentDate, GroupId, TenantId,
        NetRate, Commission, OverrideRate, SystemFees,
        CreatedDate, ModifiedDate
      ) VALUES (
        NEWID(), NULL, NULL, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @originalPaymentId, @webhookEventId, @paymentDate, @groupId, @tenantId,
        @netRate, @commission, @overrideRate, @systemFees,
        GETUTCDATE(), GETUTCDATE()
      )
    `);

  logger.success(`Credit card refund processed: ${transactionId}`);
}

async function handleCreditCardVoid(pool, data, webhookEventId, logger) {
  const transactionId = data.transaction_id || data.transactionNumber;

  logger.info(`Credit Card Void: Transaction ${transactionId}`);

  // Update original payment status
  await pool.request()
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .input('webhookEventId', sql.Int, webhookEventId)
    .query(`
      UPDATE oe.Payments
      SET Status = 'Voided', WebhookEventId = @webhookEventId, ModifiedDate = GETUTCDATE()
      WHERE ProcessorTransactionId = @processorTransactionId
        AND TransactionType = 'Payment'
    `);

  logger.success(`Credit card void processed: ${transactionId}`);
}

async function handleCreditCardChargeback(pool, data, webhookEventId, logger) {
  const transactionId = data.transaction_id || data.transactionNumber;
  const amount = data.amount;
  const reason = data.chargeback_reason || data.reason || 'Unknown';

  logger.error(`Credit Card Chargeback: Transaction ${transactionId}, Amount: $${amount}, Reason: ${reason}`);

  // Find original payment (including pricing fields)
  const originalPayment = await pool.request()
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .query(`
      SELECT PaymentId, GroupId, TenantId, NetRate, Commission, OverrideRate, SystemFees
      FROM oe.Payments 
      WHERE ProcessorTransactionId = @processorTransactionId 
        AND TransactionType = 'Payment'
    `);

  if (originalPayment.recordset.length === 0) {
    throw new Error(`Original payment not found: ${transactionId}`);
  }

  const originalPaymentData = originalPayment.recordset[0];
  const originalPaymentId = originalPaymentData.PaymentId;
  const groupId = originalPaymentData.GroupId;
  const tenantId = originalPaymentData.TenantId;
  const netRate = originalPaymentData.NetRate || 0;
  const commission = originalPaymentData.Commission || 0;
  const overrideRate = originalPaymentData.OverrideRate || 0;
  const systemFees = originalPaymentData.SystemFees || 0;

  // Insert chargeback record (negative amount, carry forward pricing from original)
    await pool.request()
    .input('transactionType', sql.NVarChar(50), 'Chargeback')
    .input('amount', sql.Decimal(10,2), -amount) // Negative amount for chargeback
    .input('status', sql.NVarChar(50), 'Open')
    .input('processor', sql.NVarChar(50), 'DIME')
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .input('paymentMethod', sql.NVarChar(50), 'CreditCard')
    .input('originalPaymentId', sql.UniqueIdentifier, originalPaymentId)
    .input('chargebackReason', sql.NVarChar(sql.MAX), reason)
    .input('webhookEventId', sql.Int, webhookEventId)
    .input('paymentDate', sql.DateTime2, new Date())
      .input('groupId', sql.UniqueIdentifier, groupId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('netRate', sql.Decimal(10,2), netRate)
    .input('commission', sql.Decimal(10,2), commission)
    .input('overrideRate', sql.Decimal(10,2), overrideRate)
    .input('systemFees', sql.Decimal(10,2), systemFees)
    .query(`
      INSERT INTO oe.Payments (
        PaymentId, EnrollmentId, HouseholdId, TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, OriginalPaymentId, ChargebackReason, WebhookEventId, PaymentDate, GroupId, TenantId,
        NetRate, Commission, OverrideRate, SystemFees,
        CreatedDate, ModifiedDate
      ) VALUES (
        NEWID(), NULL, NULL, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @originalPaymentId, @chargebackReason, @webhookEventId, @paymentDate, @groupId, @tenantId,
        @netRate, @commission, @overrideRate, @systemFees,
        GETUTCDATE(), GETUTCDATE()
      )
    `);

  logger.success(`Credit card chargeback processed: ${transactionId}`);
  
  // Send email notification for chargeback (payment failure)
  try {
    await sendPaymentFailureNotification(pool, {
      enrollment_id: null, // We don't have enrollment_id for chargebacks
      amount: amount,
      payment_method: 'Credit Card',
      transaction_id: transactionId,
      chargeback_reason: reason
    }, logger);
  } catch (emailError) {
    logger.error('Failed to send chargeback notification:', emailError);
  }
}

async function handleACHCharge(pool, data, webhookEventId, logger) {
  const transactionId = data.transaction_id || data.transactionNumber;
  const amount = data.amount;
  const status = data.status === 'completed' ? 'Completed' : 'Failed';
  const paymentMethod = data.payment_method || data.paymentMethod || 'ACH';

  logger.info(`ACH Charge: Transaction ${transactionId}, Amount: $${amount}, Status: ${status}, Method: ${paymentMethod}`);

  // Get GroupId, TenantId, HouseholdId and pricing fields from enrollment context
  const contextFromEnrollment = await getEnrollmentContext(pool, data.enrollment_id, logger);
  const groupId = contextFromEnrollment.groupId || null;
  const tenantId = contextFromEnrollment.tenantId || null;
  const householdId = contextFromEnrollment.householdId || null;
  const netRate = contextFromEnrollment.netRate || 0;
  const commission = contextFromEnrollment.commission || 0;
  const overrideRate = contextFromEnrollment.overrideRate || 0;
  const systemFees = contextFromEnrollment.systemFees || 0;

  // Insert payment record
  await pool.request()
    .input('transactionType', sql.NVarChar(50), 'Payment')
      .input('amount', sql.Decimal(10,2), amount)
    .input('status', sql.NVarChar(50), status)
    .input('processor', sql.NVarChar(50), 'DIME')
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .input('paymentMethod', sql.NVarChar(50), paymentMethod)
    .input('webhookEventId', sql.Int, webhookEventId)
    .input('paymentDate', sql.DateTime2, new Date())
    .input('enrollmentId', sql.UniqueIdentifier, data.enrollment_id || null)
    .input('householdId', sql.UniqueIdentifier, householdId)
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('netRate', sql.Decimal(10,2), netRate)
    .input('commission', sql.Decimal(10,2), commission)
    .input('overrideRate', sql.Decimal(10,2), overrideRate)
    .input('systemFees', sql.Decimal(10,2), systemFees)
    .query(`
      INSERT INTO oe.Payments (
        PaymentId, EnrollmentId, HouseholdId, TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, WebhookEventId, PaymentDate, GroupId, TenantId,
        NetRate, Commission, OverrideRate, SystemFees,
        CreatedDate, ModifiedDate
      ) VALUES (
        NEWID(), @enrollmentId, @householdId, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @webhookEventId, @paymentDate, @groupId, @tenantId,
        @netRate, @commission, @overrideRate, @systemFees,
        GETUTCDATE(), GETUTCDATE()
      )
    `);

  logger.success(`ACH charge processed: ${transactionId}`);
  
  // Send email notification if payment failed
  if (status === 'Failed') {
    try {
      await sendPaymentFailureNotification(pool, {
        enrollment_id: data.enrollment_id,
        amount: amount,
        payment_method: paymentMethod,
        transaction_id: transactionId,
        failure_reason: data.failure_reason
      }, logger);
    } catch (emailError) {
      logger.error('Failed to send payment failure notification:', emailError);
    }
  }
}

async function handleACHPaymentReturn(pool, data, webhookEventId, logger) {
  const transactionId = data.transaction_id || data.transactionNumber;
  const amount = data.amount;
  const returnCode = data.return_code || data.code;
  const returnReason = data.return_reason || data.reason || 'Unknown';
  const paymentMethod = data.payment_method || data.paymentMethod || 'ACH';

  logger.error(`ACH Payment Return: Transaction ${transactionId}, Amount: $${amount}, Code: ${returnCode}, Method: ${paymentMethod}`);

  // Find original payment (including pricing fields)
  const originalPayment = await pool.request()
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .query(`
      SELECT PaymentId, GroupId, TenantId, NetRate, Commission, OverrideRate, SystemFees
      FROM oe.Payments 
      WHERE ProcessorTransactionId = @processorTransactionId 
        AND TransactionType = 'Payment'
    `);

  if (originalPayment.recordset.length === 0) {
    throw new Error(`Original payment not found: ${transactionId}`);
  }

  const originalPaymentData = originalPayment.recordset[0];
  const originalPaymentId = originalPaymentData.PaymentId;
  const groupId = originalPaymentData.GroupId;
  const tenantId = originalPaymentData.TenantId;
  const netRate = originalPaymentData.NetRate || 0;
  const commission = originalPaymentData.Commission || 0;
  const overrideRate = originalPaymentData.OverrideRate || 0;
  const systemFees = originalPaymentData.SystemFees || 0;

  // Insert ACH return record (negative amount, carry forward pricing from original)
  await pool.request()
    .input('transactionType', sql.NVarChar(50), 'ACH_Return')
    .input('amount', sql.Decimal(10,2), -amount) // Negative amount for return
    .input('status', sql.NVarChar(50), 'Open')
    .input('processor', sql.NVarChar(50), 'DIME')
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .input('paymentMethod', sql.NVarChar(50), 'ACH')
    .input('originalPaymentId', sql.UniqueIdentifier, originalPaymentId)
    .input('achReturnCode', sql.NVarChar(50), returnCode)
    .input('achReturnReason', sql.NVarChar(sql.MAX), returnReason)
    .input('webhookEventId', sql.Int, webhookEventId)
    .input('paymentDate', sql.DateTime2, new Date())
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('netRate', sql.Decimal(10,2), netRate)
    .input('commission', sql.Decimal(10,2), commission)
    .input('overrideRate', sql.Decimal(10,2), overrideRate)
    .input('systemFees', sql.Decimal(10,2), systemFees)
    .query(`
      INSERT INTO oe.Payments (
        PaymentId, EnrollmentId, HouseholdId, TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, OriginalPaymentId, ACHReturnCode, ACHReturnReason, WebhookEventId, PaymentDate, GroupId, TenantId,
        NetRate, Commission, OverrideRate, SystemFees,
        CreatedDate, ModifiedDate
      ) VALUES (
        NEWID(), NULL, NULL, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @originalPaymentId, @achReturnCode, @achReturnReason, @webhookEventId, @paymentDate, @groupId, @tenantId,
        @netRate, @commission, @overrideRate, @systemFees,
        GETUTCDATE(), GETUTCDATE()
      )
    `);

  logger.success(`ACH payment return processed: ${transactionId}`);
  
  // Send email notification for ACH return (payment failure)
  try {
    await sendPaymentFailureNotification(pool, {
      enrollment_id: null, // We don't have enrollment_id for returns
      amount: amount,
      payment_method: 'ACH',
      transaction_id: transactionId,
      return_code: returnCode,
      return_reason: returnReason
    }, logger);
  } catch (emailError) {
    logger.error('Failed to send ACH return notification:', emailError);
  }
}

async function handleACHRefund(pool, data, webhookEventId, logger) {
  const transactionId = data.transaction_id || data.transactionNumber;
  const amount = data.amount;
  const originalTransactionId = data.original_transaction_id;

  logger.info(`ACH Refund: Transaction ${transactionId}, Amount: $${amount}`);

  // Find original payment (including pricing fields)
  const originalPayment = await pool.request()
    .input('processorTransactionId', sql.NVarChar(255), originalTransactionId)
    .query(`
      SELECT PaymentId, GroupId, TenantId, NetRate, Commission, OverrideRate, SystemFees
      FROM oe.Payments 
      WHERE ProcessorTransactionId = @processorTransactionId 
        AND TransactionType = 'Payment'
    `);

  if (originalPayment.recordset.length === 0) {
    throw new Error(`Original payment not found: ${originalTransactionId}`);
  }

  const originalPaymentData = originalPayment.recordset[0];
  const originalPaymentId = originalPaymentData.PaymentId;
  const groupId = originalPaymentData.GroupId;
  const tenantId = originalPaymentData.TenantId;
  const netRate = originalPaymentData.NetRate || 0;
  const commission = originalPaymentData.Commission || 0;
  const overrideRate = originalPaymentData.OverrideRate || 0;
  const systemFees = originalPaymentData.SystemFees || 0;

  // Insert refund record (negative amount, carry forward pricing from original)
  await pool.request()
    .input('transactionType', sql.NVarChar(50), 'Refund')
    .input('amount', sql.Decimal(10,2), -amount) // Negative amount for refund
    .input('status', sql.NVarChar(50), 'Completed')
    .input('processor', sql.NVarChar(50), 'DIME')
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .input('paymentMethod', sql.NVarChar(50), 'ACH')
    .input('originalPaymentId', sql.UniqueIdentifier, originalPaymentId)
    .input('webhookEventId', sql.Int, webhookEventId)
    .input('paymentDate', sql.DateTime2, new Date())
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('netRate', sql.Decimal(10,2), netRate)
    .input('commission', sql.Decimal(10,2), commission)
    .input('overrideRate', sql.Decimal(10,2), overrideRate)
    .input('systemFees', sql.Decimal(10,2), systemFees)
      .query(`
      INSERT INTO oe.Payments (
        PaymentId, EnrollmentId, HouseholdId, TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, OriginalPaymentId, WebhookEventId, PaymentDate, GroupId, TenantId,
        NetRate, Commission, OverrideRate, SystemFees,
        CreatedDate, ModifiedDate
      ) VALUES (
        NEWID(), NULL, NULL, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @originalPaymentId, @webhookEventId, @paymentDate, @groupId, @tenantId,
        @netRate, @commission, @overrideRate, @systemFees,
        GETUTCDATE(), GETUTCDATE()
      )
    `);

  logger.success(`ACH refund processed: ${transactionId}`);
}

async function handleDepositSent(pool, data, webhookEventId, logger) {
  const depositId = data.deposit_id;
  const amount = data.amount;
  const depositDate = data.deposit_date || new Date();

  logger.info(`Deposit Sent: Deposit ${depositId}, Amount: $${amount}`);

  // Get GroupId and TenantId from enrollment context if available
  const { groupId, tenantId } = await getEnrollmentContext(pool, data.enrollment_id, logger);

  // Insert deposit record (deposits are bank transfers, pricing fields are 0)
    await pool.request()
    .input('transactionType', sql.NVarChar(50), 'Deposit')
    .input('amount', sql.Decimal(10,2), amount)
    .input('status', sql.NVarChar(50), 'Sent')
    .input('processor', sql.NVarChar(50), 'DIME')
    .input('processorTransactionId', sql.NVarChar(255), depositId)
    .input('paymentMethod', sql.NVarChar(50), 'Deposit')
    .input('webhookEventId', sql.Int, webhookEventId)
    .input('paymentDate', sql.DateTime2, new Date(depositDate))
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('netRate', sql.Decimal(10,2), 0)
    .input('commission', sql.Decimal(10,2), 0)
    .input('overrideRate', sql.Decimal(10,2), 0)
    .input('systemFees', sql.Decimal(10,2), 0)
      .query(`
      INSERT INTO oe.Payments (
        PaymentId, EnrollmentId, HouseholdId, TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, WebhookEventId, PaymentDate, GroupId, TenantId,
        NetRate, Commission, OverrideRate, SystemFees,
        CreatedDate, ModifiedDate
      ) VALUES (
        NEWID(), NULL, NULL, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @webhookEventId, @paymentDate, @groupId, @tenantId,
        @netRate, @commission, @overrideRate, @systemFees,
        GETUTCDATE(), GETUTCDATE()
      )
    `);

  logger.success(`Deposit sent processed: ${depositId}`);
}

async function handleRecurringPaymentSuccess(pool, data, webhookEventId, logger) {
  const scheduleId = data.schedule_id || data.recurring_payment_id;
  const transactionId = data.transaction_id;
  const amount = data.amount;

  logger.info(`Recurring Payment Success: Schedule ${scheduleId}, Transaction ${transactionId}, Amount: $${amount}`);

  // Find the group associated with this schedule and get enrollment context
  const groupResult = await pool.request()
    .input('scheduleId', sql.NVarChar(255), scheduleId)
    .query(`
      SELECT 
        g.GroupId, 
        g.TenantId,
        e.EnrollmentId,
        e.AgentId
      FROM oe.GroupRecurringPaymentPlans grp
      INNER JOIN oe.Groups g ON grp.GroupId = g.GroupId
      LEFT JOIN (
        SELECT TOP 1 EnrollmentId, AgentId, MemberId
        FROM oe.Enrollments
        WHERE Status = 'Active'
        ORDER BY EffectiveDate DESC
      ) e ON EXISTS (
        SELECT 1 FROM oe.Members m 
        WHERE m.MemberId = e.MemberId AND m.GroupId = g.GroupId
      )
      WHERE grp.DimeScheduleId = @scheduleId
    `);

  if (groupResult.recordset.length === 0) {
    throw new Error(`Group not found for schedule: ${scheduleId}`);
  }

  const groupData = groupResult.recordset[0];
  const groupId = groupData.GroupId;
  const tenantId = groupData.TenantId;
  const enrollmentId = groupData.EnrollmentId || null;
  const agentId = groupData.AgentId || null;

  // For recurring payments, aggregate pricing from all active group enrollments
  // Recurring payments represent total premiums for the entire group
  let netRate = 0;
  let commission = 0;
  let overrideRate = 0;
  let systemFees = 0;

  try {
    const pricingResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`
        SELECT 
          SUM(COALESCE(e.NetRate, 0)) as NetRate,
          SUM(COALESCE(e.Commission, 0)) as Commission,
          SUM(COALESCE(e.OverrideRate, 0)) as OverrideRate,
          SUM(COALESCE(e.SystemFees, 0)) as SystemFees
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.GroupId = @groupId
          AND e.Status = 'Active'
          AND e.EffectiveDate <= GETUTCDATE()
          AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
      `);
    
    if (pricingResult.recordset.length > 0) {
      netRate = pricingResult.recordset[0].NetRate || 0;
      commission = pricingResult.recordset[0].Commission || 0;
      overrideRate = pricingResult.recordset[0].OverrideRate || 0;
      systemFees = pricingResult.recordset[0].SystemFees || 0;
    }
  } catch (error) {
    logger.warn(`Could not aggregate pricing for group ${groupId}: ${error.message}`);
  }

  // Insert payment record
  await pool.request()
    .input('transactionType', sql.NVarChar(50), 'Payment')
    .input('amount', sql.Decimal(10,2), amount)
    .input('status', sql.NVarChar(50), 'Completed')
    .input('processor', sql.NVarChar(50), 'DIME')
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .input('paymentMethod', sql.NVarChar(50), 'Recurring')
    .input('webhookEventId', sql.Int, webhookEventId)
    .input('paymentDate', sql.DateTime2, new Date())
    .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
    .input('agentId', sql.UniqueIdentifier, agentId)
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('netRate', sql.Decimal(10,2), netRate)
    .input('commission', sql.Decimal(10,2), commission)
    .input('overrideRate', sql.Decimal(10,2), overrideRate)
    .input('systemFees', sql.Decimal(10,2), systemFees)
    .query(`
      INSERT INTO oe.Payments (
        PaymentId, EnrollmentId, AgentId, HouseholdId, TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, WebhookEventId, PaymentDate, GroupId, TenantId,
        NetRate, Commission, OverrideRate, SystemFees,
        CreatedDate, ModifiedDate
      ) VALUES (
        NEWID(), @enrollmentId, @agentId, NULL, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @webhookEventId, @paymentDate, @groupId, @tenantId,
        @netRate, @commission, @overrideRate, @systemFees,
        GETUTCDATE(), GETUTCDATE()
      )
    `);

  logger.success(`Recurring payment success processed for group: ${groupId}`);
}

async function handleRecurringPaymentFailed(pool, data, webhookEventId, logger) {
    const scheduleId = data.schedule_id || data.recurring_payment_id;
    const transactionId = data.transaction_id;
  const amount = data.amount;
  const failureReason = data.failure_reason || 'Unknown';

  logger.error(`Recurring Payment Failed: Schedule ${scheduleId}, Transaction ${transactionId}, Amount: $${amount}, Reason: ${failureReason}`);

  // Find the group associated with this schedule
    const groupResult = await pool.request()
      .input('scheduleId', sql.NVarChar(255), scheduleId)
      .query(`
      SELECT g.GroupId, g.TenantId FROM oe.GroupRecurringPaymentPlans grp
      INNER JOIN oe.Groups g ON grp.GroupId = g.GroupId
      WHERE grp.DimeScheduleId = @scheduleId
      `);

    if (groupResult.recordset.length === 0) {
    throw new Error(`Group not found for schedule: ${scheduleId}`);
    }

  const groupData = groupResult.recordset[0];
  const groupId = groupData.GroupId;
  const tenantId = groupData.TenantId;

  // For recurring payments, aggregate pricing from all active group enrollments
  let netRate = 0;
  let commission = 0;
  let overrideRate = 0;
  let systemFees = 0;

  try {
    const pricingResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`
        SELECT 
          SUM(COALESCE(e.NetRate, 0)) as NetRate,
          SUM(COALESCE(e.Commission, 0)) as Commission,
          SUM(COALESCE(e.OverrideRate, 0)) as OverrideRate,
          SUM(COALESCE(e.SystemFees, 0)) as SystemFees
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.GroupId = @groupId
          AND e.Status = 'Active'
          AND e.EffectiveDate <= GETUTCDATE()
          AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
      `);
    
    if (pricingResult.recordset.length > 0) {
      netRate = pricingResult.recordset[0].NetRate || 0;
      commission = pricingResult.recordset[0].Commission || 0;
      overrideRate = pricingResult.recordset[0].OverrideRate || 0;
      systemFees = pricingResult.recordset[0].SystemFees || 0;
    }
  } catch (error) {
    logger.warn(`Could not aggregate pricing for group ${groupId}: ${error.message}`);
  }

  // Insert failed payment record
    await pool.request()
    .input('transactionType', sql.NVarChar(50), 'Payment')
    .input('amount', sql.Decimal(10,2), amount)
    .input('status', sql.NVarChar(50), 'Failed')
    .input('processor', sql.NVarChar(50), 'DIME')
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .input('paymentMethod', sql.NVarChar(50), 'Recurring')
    .input('failureReason', sql.NVarChar(sql.MAX), failureReason)
    .input('webhookEventId', sql.Int, webhookEventId)
    .input('paymentDate', sql.DateTime2, new Date())
      .input('groupId', sql.UniqueIdentifier, groupId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('netRate', sql.Decimal(10,2), netRate)
    .input('commission', sql.Decimal(10,2), commission)
    .input('overrideRate', sql.Decimal(10,2), overrideRate)
    .input('systemFees', sql.Decimal(10,2), systemFees)
      .query(`
      INSERT INTO oe.Payments (
        PaymentId, EnrollmentId, HouseholdId, TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, FailureReason, WebhookEventId, PaymentDate, GroupId, TenantId,
        NetRate, Commission, OverrideRate, SystemFees,
        CreatedDate, ModifiedDate
      ) VALUES (
        NEWID(), NULL, NULL, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @failureReason, @webhookEventId, @paymentDate, @groupId, @tenantId,
        @netRate, @commission, @overrideRate, @systemFees,
        GETUTCDATE(), GETUTCDATE()
      )
    `);

  logger.error(`Recurring payment failure processed for group: ${groupId}`);
  
  // Send email notification for payment failure
  try {
    await sendPaymentFailureNotification(pool, {
      enrollment_id: null, // Recurring payments don't have enrollment_id
      amount: amount,
      payment_method: 'Recurring',
      transaction_id: transactionId,
      failure_reason: failureReason
    }, logger);
  } catch (emailError) {
    logger.error('Failed to send payment failure notification:', emailError);
  }
}