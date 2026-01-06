const webhookHandler = require('../DimeWebhookHandler');
const crypto = require('crypto');
const { getPool, sql } = require('../shared/db');

/**
 * Test Webhook Endpoint
 * Simulates DIME webhook events for testing
 * 
 * NEW DIME WEBHOOK FORMAT:
 * The entire body IS the webhook data (not nested in 'data' field)
 *
 * Usage (NEW FORMAT):
 * POST /api/test-webhook
 * {
 *   "type": "recurring_payment_success",
 *   "transaction_number": "test-txn-123",
 *   "amount": "17039.16",
 *   "status_code": "00",
 *   "status_text": "Approved",
 *   "transaction_type": "Credit Card",
 *   "customer_uuid": "b2d454bd-0aba-4c2f-837c-f607cdd4ec5f",
 *   "schedule_id": "22"  // Optional - will look up by customer_uuid if not provided
 * }
 *
 * OR for failure:
 * {
 *   "type": "recurring_payment_failed",
 *   "transaction_number": "test-txn-123",
 *   "amount": "17039.16",
 *   "status_code": "05",
 *   "status_text": "Insufficient funds",
 *   "transaction_type": "Credit Card",
 *   "customer_uuid": "b2d454bd-0aba-4c2f-837c-f607cdd4ec5f"
 * }
 *
 * NOTE: Works with both dev and production databases.
 * A warning will be logged if using production database.
 * 
 * RECOMMENDED: Use customer_uuid from your database for realistic testing.
 * Query: SELECT TOP 1 ProcessorCustomerId FROM oe.Groups WHERE ProcessorCustomerId IS NOT NULL
 */
module.exports = async function (context, req) {
  try {
    // Warn if using production database
    const dbName = process.env.DB_NAME;
    if (dbName === 'open-enroll') {
      context.log.warn('⚠️ WARNING: Testing against production database (open-enroll)');
    }

    // NEW FORMAT: Support both new format (type at root) and old format (event_type with data)
    const eventType = req.body.type || req.body.event_type;
    const customerUuid = req.body.customer_uuid;
    const scheduleId = req.body.schedule_id || req.body.recurring_payment_id;
    const transactionNumber = req.body.transaction_number || req.body.transaction_id || `test-txn-${Date.now()}`;
    const amount = req.body.amount || '0.00';
    const statusCode = req.body.status_code || (eventType?.includes('success') ? '00' : '05');
    const statusText = req.body.status_text || (eventType?.includes('success') ? 'Approved' : 'Failed');
    const transactionType = req.body.transaction_type || 'Credit Card';
    const failureReason = req.body.failure_reason || req.body.status_text || 'Test failure reason';

    if (!eventType && !req.body.type) {
      context.res = {
        status: 400,
        body: {
          success: false,
          error: 'type or event_type is required. Use "recurring_payment_success" or "recurring_payment_failed"'
        }
      };
      return;
    }

    // Get webhook secret from tenant settings (for signature generation)
    // Try by customer_uuid first (more reliable), then schedule_id
    let webhookSecret = null;
    let foundTenantId = null;
    
    if (customerUuid) {
      try {
        const pool = await getPool();
        const result = await pool.request()
          .input('customerUuid', sql.NVarChar(255), customerUuid)
          .query(`
            SELECT TOP 1 t.TenantId, t.PaymentProcessorSettings
            FROM oe.Groups g
            INNER JOIN oe.Tenants t ON g.TenantId = t.TenantId
            WHERE g.ProcessorCustomerId = @customerUuid
              AND g.Status = 'Active'
          `);
        
        if (result.recordset.length > 0) {
          foundTenantId = result.recordset[0].TenantId;
          const settings = JSON.parse(result.recordset[0].PaymentProcessorSettings);
          const dimeConfig = settings?.processors?.openenroll?.dime;
          if (dimeConfig?.webhookSecretEncrypted) {
            const encryptionService = require('../shared/encryptionService');
            webhookSecret = encryptionService.decrypt(dimeConfig.webhookSecretEncrypted);
          } else if (dimeConfig?.webhookSecret) {
            webhookSecret = dimeConfig.webhookSecret;
          }
          context.log.info(`Found webhook secret for tenant ${foundTenantId} via customer_uuid ${customerUuid}`);
        }
        await pool.close();
      } catch (error) {
        context.log.warn(`Could not get webhook secret by customer_uuid: ${error.message}`);
      }
    }
    
    // Fallback: Try by schedule_id if customer_uuid lookup didn't work
    if (!webhookSecret && scheduleId) {
      try {
        const pool = await getPool();
        const result = await pool.request()
          .input('scheduleId', sql.NVarChar(255), scheduleId)
          .query(`
            SELECT TOP 1 t.PaymentProcessorSettings
            FROM oe.GroupRecurringPaymentPlans grp
            INNER JOIN oe.Groups g ON grp.GroupId = g.GroupId
            INNER JOIN oe.Tenants t ON g.TenantId = t.TenantId
            WHERE grp.DimeScheduleId = @scheduleId
          `);
        
        if (result.recordset.length > 0) {
          const settings = JSON.parse(result.recordset[0].PaymentProcessorSettings);
          const dimeConfig = settings?.processors?.openenroll?.dime;
          if (dimeConfig?.webhookSecretEncrypted) {
            const encryptionService = require('../shared/encryptionService');
            webhookSecret = encryptionService.decrypt(dimeConfig.webhookSecretEncrypted);
          } else if (dimeConfig?.webhookSecret) {
            webhookSecret = dimeConfig.webhookSecret;
          }
        }
        await pool.close();
      } catch (error) {
        context.log.warn(`Could not get webhook secret by schedule_id: ${error.message}`);
      }
    }

    // Build webhook payload matching NEW DIME format (entire body is the data)
    const webhookData = {
      type: eventType?.replace('.', '_') || eventType, // Normalize to new format (recurring_payment_success)
      transaction_number: transactionNumber,
      amount: amount,
      status_code: statusCode,
      status_text: statusText,
      transaction_type: transactionType,
      customer_uuid: customerUuid,
      schedule_id: scheduleId,
      transaction_date: new Date().toISOString().replace('T', ' ').substring(0, 19),
      description: `Test ${eventType?.includes('success') ? 'successful' : 'failed'} payment`,
      ...(eventType?.includes('failed') && { failure_reason: failureReason })
    };

    // Generate signature using tenant's webhook secret (or fallback to test secret)
    const payloadString = JSON.stringify(webhookData);
    const secret = webhookSecret || process.env.DIME_DEMO_WEBHOOK_SECRET || 'test-secret';
    const signature = crypto.createHmac('sha256', secret).update(payloadString).digest('hex');

    // Create a mock request object that matches what the webhook handler expects
    const mockReq = {
      headers: {
        'x-dime-signature': `sha256=${signature}`
      },
      body: webhookData
    };

    context.log(`🧪 Testing webhook: ${eventType} for customer ${customerUuid || 'N/A'} (schedule: ${scheduleId || 'N/A'})`);

    // Call the webhook handler with our mock request
    await webhookHandler(context, mockReq);

    // The webhook handler sets context.res, so we're done
    // If it didn't set it, set a default response
    if (!context.res) {
      context.res = {
        status: 200,
        body: {
          success: true,
          message: 'Test webhook processed',
          event_type: eventType,
          customer_uuid: customerUuid,
          schedule_id: scheduleId,
          transaction_number: transactionNumber
        }
      };
    }

  } catch (error) {
    context.log.error('❌ Test webhook failed:', error);
    context.res = {
      status: 500,
      body: {
        success: false,
        error: error.message,
        stack: error.stack
      }
    };
  }
};

