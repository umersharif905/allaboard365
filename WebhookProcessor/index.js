/**
 * DIME Webhook Processor - Simplified Single Table Approach
 * All payment events stored in oe.Payments table
 */

const crypto = require('crypto');
const { getPool, sql } = require('../shared/db');
const { createLogger } = require('../shared/logger');

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

async function handleCreditCardCharge(pool, data, webhookEventId, logger) {
  const transactionId = data.transaction_id || data.transactionNumber;
  const amount = data.amount;
  const status = data.status === 'completed' ? 'Completed' : 'Failed';

  logger.info(`Credit Card Charge: Transaction ${transactionId}, Amount: $${amount}, Status: ${status}`);

  // Get GroupId and TenantId from enrollment context
  const { groupId, tenantId } = await getEnrollmentContext(pool, data.enrollment_id, logger);

  // Insert payment record
  await pool.request()
    .input('transactionType', sql.NVarChar(50), 'Payment')
    .input('amount', sql.Decimal(10,2), amount)
    .input('status', sql.NVarChar(50), status)
    .input('processor', sql.NVarChar(50), 'DIME')
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .input('paymentMethod', sql.NVarChar(50), 'CreditCard')
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

  logger.success(`Credit card charge processed: ${transactionId}`);
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
}

async function handleACHCharge(pool, data, webhookEventId, logger) {
  const transactionId = data.transaction_id || data.transactionNumber;
  const amount = data.amount;
  const status = data.status === 'completed' ? 'Completed' : 'Failed';

  logger.info(`ACH Charge: Transaction ${transactionId}, Amount: $${amount}, Status: ${status}`);

  // Get GroupId and TenantId from enrollment context
  const { groupId, tenantId } = await getEnrollmentContext(pool, data.enrollment_id, logger);

  // Insert payment record
  await pool.request()
    .input('transactionType', sql.NVarChar(50), 'Payment')
    .input('amount', sql.Decimal(10,2), amount)
    .input('status', sql.NVarChar(50), status)
    .input('processor', sql.NVarChar(50), 'DIME')
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .input('paymentMethod', sql.NVarChar(50), 'ACH')
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
}

async function handleACHPaymentReturn(pool, data, webhookEventId, logger) {
  const transactionId = data.transaction_id || data.transactionNumber;
  const amount = data.amount;
  const returnCode = data.return_code || data.code;
  const returnReason = data.return_reason || data.reason || 'Unknown';

  logger.error(`ACH Payment Return: Transaction ${transactionId}, Amount: $${amount}, Code: ${returnCode}`);

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
}