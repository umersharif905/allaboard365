/**
 * DIME Webhook Processor - Simplified Single Table Approach
 * All payment events stored in oe.Payments table
 */

const sql = require('mssql');
const crypto = require('crypto');
const oePaymentStatus = require('../shared/payment-status');

// Database configuration
const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  options: {
    encrypt: true,
    trustServerCertificate: true
  }
};

module.exports = async function (context, req) {
  const logger = {
    info: (...args) => context.log.info(...args),
    warn: (...args) => context.log.warn(...args),
    error: (...args) => context.log.error(...args),
    success: (...args) => context.log.info('✅', ...args)
  };

  try {
    // Verify webhook signature
    const signature = req.headers['x-dime-signature'];
    const payload = JSON.stringify(req.body);
    
    if (!verifyWebhookSignature(signature, payload)) {
      logger.error('Invalid webhook signature');
      return {
        status: 401,
        body: { error: 'Invalid signature' }
      };
    }

    const { event_type, data } = req.body;
    logger.info(`DIME Webhook received: ${event_type}`, data);

    // Connect to database
    const pool = await sql.connect(config);
    let webhookEventId = null;

    try {
      // Store webhook event
      webhookEventId = await storeWebhookEvent(pool, event_type, data);

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

      return {
        status: 200,
        body: { success: true, event_type, processed: true }
      };

    } catch (error) {
      logger.error(`Error processing webhook: ${error.message}`);
      
      if (webhookEventId) {
        await markWebhookProcessed(pool, webhookEventId, false, error.message);
      }
      
      return {
        status: 200, // Return 200 to DIME even on error
        body: { success: false, error: error.message }
      };
    } finally {
      await pool.close();
    }

  } catch (error) {
    logger.error(`Webhook processing failed: ${error.message}`);
    return {
      status: 500,
      body: { error: 'Internal server error' }
    };
  }
};

function verifyWebhookSignature(signature, payload) {
  if (!signature || !process.env.DIME_WEBHOOK_SECRET) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac('sha256', process.env.DIME_WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');

  return signature === `sha256=${expectedSignature}`;
}

async function storeWebhookEvent(pool, eventType, data) {
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

async function handleCreditCardCharge(pool, data, webhookEventId, logger) {
  const transactionId = data.transaction_id || data.transactionNumber;
  const amount = data.amount;
  const status = data.status === 'completed' ? 'Completed' : 'Failed';

  logger.info(`Credit Card Charge: Transaction ${transactionId}, Amount: $${amount}, Status: ${status}`);

  // Insert payment record
  await pool.request()
    .input('paymentId', sql.UniqueIdentifier, sql.UniqueIdentifier())
    .input('transactionType', sql.NVarChar(50), 'Payment')
    .input('amount', sql.Decimal(10,2), amount)
    .input('status', sql.NVarChar(50), status)
    .input('processor', sql.NVarChar(50), 'DIME')
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .input('paymentMethod', sql.NVarChar(50), 'CreditCard')
    .input('webhookEventId', sql.Int, webhookEventId)
    .input('paymentDate', sql.DateTime2, new Date())
    .query(`
      INSERT INTO oe.Payments (
        PaymentId, TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, WebhookEventId, PaymentDate,
        CreatedDate, ModifiedDate
      ) VALUES (
        @paymentId, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @webhookEventId, @paymentDate,
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
      SELECT PaymentId FROM oe.Payments 
      WHERE ProcessorTransactionId = @processorTransactionId 
        AND TransactionType = 'Payment'
    `);

  if (originalPayment.recordset.length === 0) {
    throw new Error(`Original payment not found: ${originalTransactionId}`);
  }

  // Insert refund record (negative amount)
  await pool.request()
    .input('paymentId', sql.UniqueIdentifier, sql.UniqueIdentifier())
    .input('transactionType', sql.NVarChar(50), 'Refund')
    .input('amount', sql.Decimal(10,2), -amount) // Negative amount for refund
    .input('status', sql.NVarChar(50), 'Completed')
    .input('processor', sql.NVarChar(50), 'DIME')
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .input('paymentMethod', sql.NVarChar(50), 'CreditCard')
    .input('originalPaymentId', sql.UniqueIdentifier, originalPayment.recordset[0].PaymentId)
    .input('webhookEventId', sql.Int, webhookEventId)
    .input('paymentDate', sql.DateTime2, new Date())
    .query(`
      INSERT INTO oe.Payments (
        PaymentId, TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, OriginalPaymentId, WebhookEventId, PaymentDate,
        CreatedDate, ModifiedDate
      ) VALUES (
        @paymentId, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @originalPaymentId, @webhookEventId, @paymentDate,
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
      SELECT PaymentId FROM oe.Payments 
      WHERE ProcessorTransactionId = @processorTransactionId 
        AND TransactionType = 'Payment'
    `);

  if (originalPayment.recordset.length === 0) {
    throw new Error(`Original payment not found: ${transactionId}`);
  }

  // Insert chargeback record (negative amount)
  await pool.request()
    .input('paymentId', sql.UniqueIdentifier, sql.UniqueIdentifier())
    .input('transactionType', sql.NVarChar(50), 'Chargeback')
    .input('amount', sql.Decimal(10,2), -amount) // Negative amount for chargeback
    .input('status', sql.NVarChar(50), 'Open')
    .input('processor', sql.NVarChar(50), 'DIME')
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .input('paymentMethod', sql.NVarChar(50), 'CreditCard')
    .input('originalPaymentId', sql.UniqueIdentifier, originalPayment.recordset[0].PaymentId)
    .input('chargebackReason', sql.NVarChar(sql.MAX), reason)
    .input('webhookEventId', sql.Int, webhookEventId)
    .input('paymentDate', sql.DateTime2, new Date())
    .query(`
      INSERT INTO oe.Payments (
        PaymentId, TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, OriginalPaymentId, ChargebackReason, WebhookEventId, PaymentDate,
        CreatedDate, ModifiedDate
      ) VALUES (
        @paymentId, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @originalPaymentId, @chargebackReason, @webhookEventId, @paymentDate,
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

  // Insert payment record
  await pool.request()
    .input('paymentId', sql.UniqueIdentifier, sql.UniqueIdentifier())
    .input('transactionType', sql.NVarChar(50), 'Payment')
    .input('amount', sql.Decimal(10,2), amount)
    .input('status', sql.NVarChar(50), status)
    .input('processor', sql.NVarChar(50), 'DIME')
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .input('paymentMethod', sql.NVarChar(50), 'ACH')
    .input('webhookEventId', sql.Int, webhookEventId)
    .input('paymentDate', sql.DateTime2, new Date())
    .query(`
      INSERT INTO oe.Payments (
        PaymentId, TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, WebhookEventId, PaymentDate,
        CreatedDate, ModifiedDate
      ) VALUES (
        @paymentId, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @webhookEventId, @paymentDate,
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
      SELECT PaymentId FROM oe.Payments 
      WHERE ProcessorTransactionId = @processorTransactionId 
        AND TransactionType = 'Payment'
    `);

  if (originalPayment.recordset.length === 0) {
    throw new Error(`Original payment not found: ${transactionId}`);
  }

  // Insert ACH return record (negative amount)
  await pool.request()
    .input('paymentId', sql.UniqueIdentifier, sql.UniqueIdentifier())
    .input('transactionType', sql.NVarChar(50), 'ACH_Return')
    .input('amount', sql.Decimal(10,2), -amount) // Negative amount for return
    .input('status', sql.NVarChar(50), 'Open')
    .input('processor', sql.NVarChar(50), 'DIME')
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .input('paymentMethod', sql.NVarChar(50), 'ACH')
    .input('originalPaymentId', sql.UniqueIdentifier, originalPayment.recordset[0].PaymentId)
    .input('achReturnCode', sql.NVarChar(50), returnCode)
    .input('achReturnReason', sql.NVarChar(sql.MAX), returnReason)
    .input('webhookEventId', sql.Int, webhookEventId)
    .input('paymentDate', sql.DateTime2, new Date())
    .query(`
      INSERT INTO oe.Payments (
        PaymentId, TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, OriginalPaymentId, ACHReturnCode, ACHReturnReason, WebhookEventId, PaymentDate,
        CreatedDate, ModifiedDate
      ) VALUES (
        @paymentId, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @originalPaymentId, @achReturnCode, @achReturnReason, @webhookEventId, @paymentDate,
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
      SELECT PaymentId FROM oe.Payments 
      WHERE ProcessorTransactionId = @processorTransactionId 
        AND TransactionType = 'Payment'
    `);

  if (originalPayment.recordset.length === 0) {
    throw new Error(`Original payment not found: ${originalTransactionId}`);
  }

  // Insert refund record (negative amount)
  await pool.request()
    .input('paymentId', sql.UniqueIdentifier, sql.UniqueIdentifier())
    .input('transactionType', sql.NVarChar(50), 'Refund')
    .input('amount', sql.Decimal(10,2), -amount) // Negative amount for refund
    .input('status', sql.NVarChar(50), 'Completed')
    .input('processor', sql.NVarChar(50), 'DIME')
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .input('paymentMethod', sql.NVarChar(50), 'ACH')
    .input('originalPaymentId', sql.UniqueIdentifier, originalPayment.recordset[0].PaymentId)
    .input('webhookEventId', sql.Int, webhookEventId)
    .input('paymentDate', sql.DateTime2, new Date())
    .query(`
      INSERT INTO oe.Payments (
        PaymentId, TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, OriginalPaymentId, WebhookEventId, PaymentDate,
        CreatedDate, ModifiedDate
      ) VALUES (
        @paymentId, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @originalPaymentId, @webhookEventId, @paymentDate,
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

  // Insert deposit record
  await pool.request()
    .input('paymentId', sql.UniqueIdentifier, sql.UniqueIdentifier())
    .input('transactionType', sql.NVarChar(50), 'Deposit')
    .input('amount', sql.Decimal(10,2), amount)
    .input('status', sql.NVarChar(50), 'Sent')
    .input('processor', sql.NVarChar(50), 'DIME')
    .input('processorTransactionId', sql.NVarChar(255), depositId)
    .input('paymentMethod', sql.NVarChar(50), 'Deposit')
    .input('webhookEventId', sql.Int, webhookEventId)
    .input('paymentDate', sql.DateTime2, new Date(depositDate))
    .query(`
      INSERT INTO oe.Payments (
        PaymentId, TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, WebhookEventId, PaymentDate,
        CreatedDate, ModifiedDate
      ) VALUES (
        @paymentId, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @webhookEventId, @paymentDate,
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
      SELECT GroupId FROM oe.GroupRecurringPaymentPlans 
      WHERE DimeScheduleId = @scheduleId
    `);

  if (groupResult.recordset.length === 0) {
    throw new Error(`Group not found for schedule: ${scheduleId}`);
  }

  const groupId = groupResult.recordset[0].GroupId;

  // Insert payment record
  await pool.request()
    .input('paymentId', sql.UniqueIdentifier, sql.UniqueIdentifier())
    .input('transactionType', sql.NVarChar(50), 'Payment')
    .input('amount', sql.Decimal(10,2), amount)
    .input('status', sql.NVarChar(50), 'Completed')
    .input('processor', sql.NVarChar(50), 'DIME')
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .input('paymentMethod', sql.NVarChar(50), 'Recurring')
    .input('webhookEventId', sql.Int, webhookEventId)
    .input('paymentDate', sql.DateTime2, new Date())
    .query(`
      INSERT INTO oe.Payments (
        PaymentId, TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, WebhookEventId, PaymentDate,
        CreatedDate, ModifiedDate
      ) VALUES (
        @paymentId, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @webhookEventId, @paymentDate,
        GETUTCDATE(), GETUTCDATE()
      )
    `);

  logger.success(`Recurring payment success processed for group: ${groupId}`);
}

async function handleRecurringPaymentFailed(pool, data, webhookEventId, logger) {
  const scheduleId = data.schedule_id || data.recurring_payment_id;
  const transactionId = data.transaction_id;
  const amount = data.amount;
  const failureReason = oePaymentStatus.formatDimeRecurringFailureReasonForStorage(data);

  logger.error(`Recurring Payment Failed: Schedule ${scheduleId}, Transaction ${transactionId}, Amount: $${amount}, Reason: ${failureReason}`);

  // Find the group associated with this schedule
  const groupResult = await pool.request()
    .input('scheduleId', sql.NVarChar(255), scheduleId)
    .query(`
      SELECT GroupId FROM oe.GroupRecurringPaymentPlans 
      WHERE DimeScheduleId = @scheduleId
    `);

  if (groupResult.recordset.length === 0) {
    throw new Error(`Group not found for schedule: ${scheduleId}`);
  }

  const groupId = groupResult.recordset[0].GroupId;

  // Insert failed payment record
  await pool.request()
    .input('paymentId', sql.UniqueIdentifier, sql.UniqueIdentifier())
    .input('transactionType', sql.NVarChar(50), 'Payment')
    .input('amount', sql.Decimal(10,2), amount)
    .input('status', sql.NVarChar(50), 'Failed')
    .input('processor', sql.NVarChar(50), 'DIME')
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .input('paymentMethod', sql.NVarChar(50), 'Recurring')
    .input('failureReason', sql.NVarChar(sql.MAX), failureReason)
    .input('webhookEventId', sql.Int, webhookEventId)
    .input('paymentDate', sql.DateTime2, new Date())
    .query(`
      INSERT INTO oe.Payments (
        PaymentId, TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, FailureReason, WebhookEventId, PaymentDate,
        CreatedDate, ModifiedDate
      ) VALUES (
        @paymentId, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @failureReason, @webhookEventId, @paymentDate,
        GETUTCDATE(), GETUTCDATE()
      )
    `);

  logger.error(`Recurring payment failure processed for group: ${groupId}`);
}
