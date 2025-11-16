const webhookHandler = require('../DimeWebhookHandler');
const crypto = require('crypto');
const { getPool, sql } = require('../shared/db');

/**
 * Test Webhook Endpoint
 * Simulates DIME webhook events for testing
 *
 * IMPORTANT SAFETY:
 * - This endpoint is **never** allowed to run against the production database.
 * - If DB_NAME is 'open-enroll', the function returns 403 and does nothing.
 *
 * Usage:
 * POST /api/test-webhook
 * {
 *   "event_type": "recurring_payment.success",
 *   "schedule_id": "172",
 *   "transaction_id": "test-txn-123",
 *   "amount": 1378.66
 * }
 *
 * OR for failure:
 * {
 *   "event_type": "recurring_payment.failed",
 *   "schedule_id": "172",
 *   "transaction_id": "test-txn-123",
 *   "amount": 1378.66,
 *   "failure_reason": "Insufficient funds"
 * }
 */
module.exports = async function (context, req) {
  try {
    // Absolute safety: never allow this test endpoint to operate against the production DB
    const dbName = process.env.DB_NAME;
    if (dbName === 'open-enroll') {
      context.log.warn('🛑 DimeWebhookTest blocked: DB_NAME is open-enroll (production).');
      context.res = {
        status: 403,
        body: {
          success: false,
          error: 'Test webhook endpoint is disabled against the production database.'
        }
      };
      return;
    }

    const { event_type, schedule_id, transaction_id, amount, failure_reason } = req.body;

    if (!event_type) {
      context.res = {
        status: 400,
        body: {
          success: false,
          error: 'event_type is required. Use "recurring_payment.success" or "recurring_payment.failed"'
        }
      };
      return;
    }

    // Get webhook secret from tenant settings (for signature generation)
    let webhookSecret = null;
    if (schedule_id) {
      try {
        const pool = await getPool();
        const result = await pool.request()
          .input('scheduleId', sql.NVarChar(255), schedule_id)
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
        context.log.warn(`Could not get webhook secret: ${error.message}`);
      }
    }

    // Build webhook payload matching DIME format
    const webhookData = {
      event_type,
      data: {
        schedule_id: schedule_id || req.body.schedule_id,
        recurring_payment_id: schedule_id || req.body.schedule_id,
        transaction_id: transaction_id || req.body.transaction_id || `test-txn-${Date.now()}`,
        amount: amount || req.body.amount || 0,
        failure_reason: failure_reason || req.body.failure_reason || 'Test failure reason',
        status: event_type.includes('success') ? 'success' : 'failed'
      }
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

    context.log(`🧪 Testing webhook: ${event_type} for schedule ${schedule_id || 'N/A'}`);

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
          event_type,
          data: webhookData.data
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

