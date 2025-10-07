const crypto = require('crypto');
const { getPool, sql } = require('../shared/db');
const { createLogger } = require('../shared/logger');

/**
 * Webhook Processor
 * Handles DIME payment success/failure webhooks
 */
module.exports = async function (context, req) {
  const logger = createLogger(context);
  logger.info('Webhook received');

  let pool;

  try {
    // Verify webhook signature
    const signature = req.headers['x-dime-signature'];
    const payload = JSON.stringify(req.body);
    
    if (!verifyWebhookSignature(signature, payload)) {
      logger.error('Invalid webhook signature');
      context.res = { status: 401, body: { error: 'Invalid signature' } };
      return;
    }

    const { event_type, data } = req.body;
    logger.info(`Event type: ${event_type}`);

    // Connect to database
    pool = await getPool();

    // Store webhook event
    const webhookEventId = await storeWebhookEvent(pool, event_type, data);
    logger.info(`Stored webhook event: ${webhookEventId}`);

    // Process based on event type
    switch (event_type) {
      case 'recurring_payment.success':
        await handleRecurringPaymentSuccess(pool, data, webhookEventId, logger);
        break;
      case 'recurring_payment.failed':
        await handleRecurringPaymentFailed(pool, data, webhookEventId, logger);
        break;
      case 'recurring_payment.schedule_updated':
        logger.info('Schedule updated event received (informational only)');
        break;
      default:
        logger.warn(`Unknown event type: ${event_type}`);
    }

    context.res = { status: 200, body: { success: true } };

  } catch (error) {
    logger.error(`Webhook processing error: ${error.message}`);
    context.res = { status: 500, body: { success: false, error: error.message } };
  } finally {
    if (pool) {
      await pool.close();
    }
  }
};

function verifyWebhookSignature(signature, payload) {
  if (!process.env.DIME_WEBHOOK_SECRET) {
    console.warn('DIME_WEBHOOK_SECRET not set, skipping signature verification');
    return true; // Allow in development
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
    .input('payload', sql.NVarChar(sql.MAX), JSON.stringify(data))
    .query(`
      INSERT INTO oe.WebhookEvents (EventId, EventType, Payload, ReceivedDate, Status)
      OUTPUT inserted.EventId
      VALUES (NEWID(), @eventType, @payload, GETUTCDATE(), 'Pending')
    `);

  return result.recordset[0].EventId;
}

async function handleRecurringPaymentSuccess(pool, data, webhookEventId, logger) {
  try {
    const scheduleId = data.schedule_id || data.recurring_payment_id;
    const transactionId = data.transaction_id;
    const amount = data.amount;

    logger.info(`Payment success: Schedule ${scheduleId}, Transaction ${transactionId}`);

    // Find group by schedule ID
    const groupResult = await pool.request()
      .input('scheduleId', sql.NVarChar(255), scheduleId)
      .query(`
        SELECT GroupId FROM oe.GroupRecurringPaymentPlans
        WHERE DimeScheduleId = @scheduleId AND IsActive = 1
      `);

    if (groupResult.recordset.length === 0) {
      logger.warn(`Group not found for schedule: ${scheduleId}`);
      return;
    }

    const groupId = groupResult.recordset[0].GroupId;

    // Update group payment status
    await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('transactionId', sql.NVarChar(255), transactionId)
      .input('amount', sql.Decimal(10,2), amount)
      .input('webhookEventId', sql.UniqueIdentifier, webhookEventId)
      .query(`
        UPDATE oe.GroupPayments
        SET Status = 'Completed',
            WebhookEventId = @webhookEventId,
            LastSuccessfulPaymentDate = GETUTCDATE(),
            PaymentFailureCount = 0,
            ModifiedDate = GETUTCDATE()
        WHERE GroupId = @groupId
          AND ProcessorTransactionId = @transactionId
      `);

    // Mark webhook as processed
    await pool.request()
      .input('eventId', sql.UniqueIdentifier, webhookEventId)
      .query(`
        UPDATE oe.WebhookEvents
        SET Status = 'Processed', ProcessedDate = GETUTCDATE()
        WHERE EventId = @eventId
      `);

    logger.success(`Payment success processed for group: ${groupId}`);

  } catch (error) {
    logger.error(`Error handling payment success: ${error.message}`);
    throw error;
  }
}

async function handleRecurringPaymentFailed(pool, data, webhookEventId, logger) {
  try {
    const scheduleId = data.schedule_id || data.recurring_payment_id;
    const transactionId = data.transaction_id;
    const failureReason = data.failure_reason || data.error_message || 'Unknown error';

    logger.error(`Payment failed: Schedule ${scheduleId}, Reason: ${failureReason}`);

    // Find group by schedule ID
    const groupResult = await pool.request()
      .input('scheduleId', sql.NVarChar(255), scheduleId)
      .query(`
        SELECT GroupId FROM oe.GroupRecurringPaymentPlans
        WHERE DimeScheduleId = @scheduleId AND IsActive = 1
      `);

    if (groupResult.recordset.length === 0) {
      logger.warn(`Group not found for schedule: ${scheduleId}`);
      return;
    }

    const groupId = groupResult.recordset[0].GroupId;

    // Update group payment status with failure
    await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('transactionId', sql.NVarChar(255), transactionId || '')
      .input('failureReason', sql.NVarChar(sql.MAX), failureReason)
      .input('webhookEventId', sql.UniqueIdentifier, webhookEventId)
      .query(`
        UPDATE oe.GroupPayments
        SET Status = 'Failed',
            FailureReason = @failureReason,
            WebhookEventId = @webhookEventId,
            PaymentFailureCount = PaymentFailureCount + 1,
            ModifiedDate = GETUTCDATE()
        WHERE GroupId = @groupId
      `);

    // Mark webhook as processed
    await pool.request()
      .input('eventId', sql.UniqueIdentifier, webhookEventId)
      .query(`
        UPDATE oe.WebhookEvents
        SET Status = 'Processed', ProcessedDate = GETUTCDATE()
        WHERE EventId = @eventId
      `);

    logger.error(`Payment failure processed for group: ${groupId}`);

  } catch (error) {
    logger.error(`Error handling payment failure: ${error.message}`);
    throw error;
  }
}

