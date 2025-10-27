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
  if (!enrollmentId) return { groupId: null, tenantId: null };
  
  try {
    const enrollmentContext = await pool.request()
      .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
      .query(`
        SELECT m.GroupId, g.TenantId
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        INNER JOIN oe.Groups g ON m.GroupId = g.GroupId
        WHERE e.EnrollmentId = @enrollmentId
      `);
    
    if (enrollmentContext.recordset.length > 0) {
      return {
        groupId: enrollmentContext.recordset[0].GroupId,
        tenantId: enrollmentContext.recordset[0].TenantId
      };
    }
  } catch (error) {
    logger.warn(`Could not get enrollment context: ${error.message}`);
  }
  
  return { groupId: null, tenantId: null };
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
async function sendPaymentFailureNotification(pool, paymentData, logger) {
  try {
    // Get member information for the payment
    const memberResult = await pool.request()
      .input('enrollmentId', sql.UniqueIdentifier, paymentData.enrollment_id)
      .query(`
        SELECT 
          m.MemberId,
          m.UserId,
          u.FirstName,
          u.LastName,
          u.Email,
          g.TenantId
        FROM oe.Enrollments e
        LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
        LEFT JOIN oe.Users u ON m.UserId = u.UserId
        LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
        WHERE e.EnrollmentId = @enrollmentId
      `);

    if (memberResult.recordset.length === 0) {
      logger.warn('No member found for payment failure notification');
      return;
    }

    const member = memberResult.recordset[0];
    
    // Generate email content - MessageCenter expects plain HTML
    const subject = `Payment Failed - $${paymentData.amount}`;
    const emailBody = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Payment Failed</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
    <div style="background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); padding: 20px;">
        <h2 style="color: #dc2626; margin-top: 0;">Payment Failed</h2>
        <p>Your payment has failed for the following reason:</p>
        <div style="background-color: #f9fafb; border-left: 4px solid #dc2626; padding: 15px; margin: 20px 0;">
            <p style="margin: 5px 0;"><strong>Amount:</strong> $${paymentData.amount}</p>
            <p style="margin: 5px 0;"><strong>Payment Method:</strong> ${paymentData.payment_method || 'Unknown'}</p>
            <p style="margin: 5px 0;"><strong>Transaction ID:</strong> ${paymentData.transaction_id || 'N/A'}</p>
            <p style="margin: 5px 0;"><strong>Failure Reason:</strong> ${paymentData.failure_reason || 'Unknown'}</p>
            ${paymentData.return_code ? `<p style="margin: 5px 0;"><strong>ACH Return Code:</strong> ${paymentData.return_code}</p>` : ''}
            ${paymentData.return_reason ? `<p style="margin: 5px 0;"><strong>ACH Return Reason:</strong> ${paymentData.return_reason}</p>` : ''}
            ${paymentData.chargeback_reason ? `<p style="margin: 5px 0;"><strong>Chargeback Reason:</strong> ${paymentData.chargeback_reason}</p>` : ''}
        </div>
        <p><strong>Next Steps:</strong></p>
        <ul>
            <li>Update your payment method</li>
            <li>Check with your bank or card issuer</li>
            <li>Contact support if the issue persists</li>
        </ul>
        <p style="color: #6b7280; font-size: 14px; margin-top: 20px;">This is an automated notification from your insurance administrator.</p>
    </div>
</body>
</html>
    `;
    
    // Insert directly into MessageQueue
    const messageId = require('crypto').randomUUID();
    await pool.request()
      .input('messageId', sql.UniqueIdentifier, messageId)
      .input('tenantId', sql.UniqueIdentifier, member.TenantId)
      .input('recipientId', sql.UniqueIdentifier, member.UserId)
      .input('messageType', sql.NVarChar, 'Email')
      .input('recipientAddress', sql.NVarChar, member.Email)
      .input('subject', sql.NVarChar, subject)
      .input('body', sql.NVarChar(sql.MAX), emailBody)
      .input('status', sql.NVarChar, 'Pending')
      .input('createdBy', sql.NVarChar, 'System')
      .query(`
        INSERT INTO oe.MessageQueue (
          MessageId, TenantId, RecipientId, MessageType,
          RecipientAddress, Subject, Body, Status,
          RetryCount, CreatedDate, CreatedBy
        ) VALUES (
          @messageId, @tenantId, @recipientId, @messageType,
          @recipientAddress, @subject, @body, @status,
          0, GETUTCDATE(), @createdBy
        )
      `);

    logger.info(`✅ Payment failure notification queued for ${member.Email}`);
  } catch (error) {
    logger.error('Error sending payment failure notification:', error);
    // Don't throw - email failure shouldn't break webhook processing
  }
}

async function handleCreditCardCharge(pool, data, webhookEventId, logger) {
  const transactionId = data.transaction_id || data.transactionNumber;
  const amount = data.amount;
  const status = data.status === 'completed' ? 'Completed' : 'Failed';
  const paymentMethod = data.payment_method || data.paymentMethod || 'Credit Card';

  logger.info(`Credit Card Charge: Transaction ${transactionId}, Amount: $${amount}, Status: ${status}, Method: ${paymentMethod}`);

  // Get GroupId and TenantId from enrollment context
  const { groupId, tenantId } = await getEnrollmentContext(pool, data.enrollment_id, logger);

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
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('attemptNumber', sql.Int, attemptInfo.attemptNumber)
    .input('originalPaymentId', sql.UniqueIdentifier, attemptInfo.originalPaymentId)
    .input('consecutiveFailures', sql.Int, attemptInfo.consecutiveFailures)
    .input('failureReason', sql.NVarChar(sql.MAX), data.failure_reason || null)
    .input('lastFailureDate', sql.DateTime2, status === 'Failed' ? new Date() : null)
    .query(`
      INSERT INTO oe.Payments (
        PaymentId, EnrollmentId, HouseholdId, TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, FailureReason, WebhookEventId, PaymentDate, 
        GroupId, TenantId, AttemptNumber, OriginalPaymentId, ConsecutiveFailureCount, LastFailureDate,
        CreatedDate, ModifiedDate
      ) VALUES (
        NEWID(), NULL, NULL, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @failureReason, @webhookEventId, @paymentDate, 
        @groupId, @tenantId, @attemptNumber, @originalPaymentId, @consecutiveFailures, @lastFailureDate,
        GETUTCDATE(), GETUTCDATE()
      )
    `);

  logger.success(`Credit card charge processed: ${transactionId}${attemptInfo.attemptNumber ? ` (Attempt ${attemptInfo.attemptNumber})` : ''}`);
  
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

async function handleCreditCardRefund(pool, data, webhookEventId, logger) {
  const transactionId = data.transaction_id || data.transactionNumber;
  const amount = data.amount;
  const originalTransactionId = data.original_transaction_id;

  logger.info(`Credit Card Refund: Transaction ${transactionId}, Amount: $${amount}`);

  // Find original payment
  const originalPayment = await pool.request()
    .input('processorTransactionId', sql.NVarChar(255), originalTransactionId)
    .query(`
      SELECT PaymentId, GroupId, TenantId FROM oe.Payments 
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

  // Insert refund record (negative amount)
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
    .query(`
      INSERT INTO oe.Payments (
        PaymentId, EnrollmentId, HouseholdId, TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, OriginalPaymentId, WebhookEventId, PaymentDate, GroupId, TenantId,
        CreatedDate, ModifiedDate
      ) VALUES (
        NEWID(), NULL, NULL, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @originalPaymentId, @webhookEventId, @paymentDate, @groupId, @tenantId,
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

  // Find original payment
  const originalPayment = await pool.request()
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .query(`
      SELECT PaymentId, GroupId, TenantId FROM oe.Payments 
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

  // Insert chargeback record (negative amount)
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
    .query(`
      INSERT INTO oe.Payments (
        PaymentId, EnrollmentId, HouseholdId, TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, OriginalPaymentId, ChargebackReason, WebhookEventId, PaymentDate, GroupId, TenantId,
        CreatedDate, ModifiedDate
      ) VALUES (
        NEWID(), NULL, NULL, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @originalPaymentId, @chargebackReason, @webhookEventId, @paymentDate, @groupId, @tenantId,
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

  // Get GroupId and TenantId from enrollment context
  const { groupId, tenantId } = await getEnrollmentContext(pool, data.enrollment_id, logger);

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
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      INSERT INTO oe.Payments (
        PaymentId, EnrollmentId, HouseholdId, TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, WebhookEventId, PaymentDate, GroupId, TenantId,
        CreatedDate, ModifiedDate
      ) VALUES (
        NEWID(), NULL, NULL, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @webhookEventId, @paymentDate, @groupId, @tenantId,
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

  // Find original payment
  const originalPayment = await pool.request()
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .query(`
      SELECT PaymentId, GroupId, TenantId FROM oe.Payments 
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

  // Insert ACH return record (negative amount)
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
    .query(`
      INSERT INTO oe.Payments (
        PaymentId, EnrollmentId, HouseholdId, TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, OriginalPaymentId, ACHReturnCode, ACHReturnReason, WebhookEventId, PaymentDate, GroupId, TenantId,
        CreatedDate, ModifiedDate
      ) VALUES (
        NEWID(), NULL, NULL, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @originalPaymentId, @achReturnCode, @achReturnReason, @webhookEventId, @paymentDate, @groupId, @tenantId,
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

  // Find original payment
  const originalPayment = await pool.request()
    .input('processorTransactionId', sql.NVarChar(255), originalTransactionId)
    .query(`
      SELECT PaymentId, GroupId, TenantId FROM oe.Payments 
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

  // Insert refund record (negative amount)
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
      .query(`
      INSERT INTO oe.Payments (
        PaymentId, EnrollmentId, HouseholdId, TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, OriginalPaymentId, WebhookEventId, PaymentDate, GroupId, TenantId,
        CreatedDate, ModifiedDate
      ) VALUES (
        NEWID(), NULL, NULL, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @originalPaymentId, @webhookEventId, @paymentDate, @groupId, @tenantId,
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

  // Insert deposit record
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
      .query(`
      INSERT INTO oe.Payments (
        PaymentId, EnrollmentId, HouseholdId, TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, WebhookEventId, PaymentDate, GroupId, TenantId,
        CreatedDate, ModifiedDate
      ) VALUES (
        NEWID(), NULL, NULL, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @webhookEventId, @paymentDate, @groupId, @tenantId,
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
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      INSERT INTO oe.Payments (
        PaymentId, EnrollmentId, HouseholdId, TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, WebhookEventId, PaymentDate, GroupId, TenantId,
        CreatedDate, ModifiedDate
      ) VALUES (
        NEWID(), NULL, NULL, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @webhookEventId, @paymentDate, @groupId, @tenantId,
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
      .query(`
      INSERT INTO oe.Payments (
        PaymentId, EnrollmentId, HouseholdId, TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, FailureReason, WebhookEventId, PaymentDate, GroupId, TenantId,
        CreatedDate, ModifiedDate
      ) VALUES (
        NEWID(), NULL, NULL, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @failureReason, @webhookEventId, @paymentDate, @groupId, @tenantId,
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