/**
 * DIME Webhook Processor - Simplified Single Table Approach
 * All payment events stored in oe.Payments table
 */

const crypto = require('crypto');
const { getPool, sql } = require('../shared/db');
const { createLogger } = require('../shared/logger');
const { createRecurringPaymentRecord, createFailedRecurringPaymentRecord } = require('../shared/createRecurringPaymentRecord');
const {
  buildProductSnapshotForPayment,
  getPricingFields,
  householdAsOfDate,
  getHouseholdFeeBucketsAsOf
} = require('../shared/payment-product-snapshots');
const oePaymentStatus = require('../shared/payment-status');
const { recordIntegrationError } = require('../shared/integrationErrors');

const INVOICE_API_BASE_URL = process.env.BACKEND_API_URL || process.env.OE_BACKEND_URL || '';
const INVOICE_API_KEY = process.env.SCHEDULED_JOB_API_KEY || '';

async function bestEffortResolveInvoice(logger, { paymentId, householdId, tenantId, paymentDate, paymentAmount }) {
  if (!INVOICE_API_BASE_URL || !householdId) return;
  try {
    const url = `${INVOICE_API_BASE_URL}/api/invoices/resolve-for-payment`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(INVOICE_API_KEY ? { 'x-api-key': INVOICE_API_KEY } : {})
      },
      body: JSON.stringify({ paymentId, householdId, tenantId, paymentDate, paymentAmount }),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
      logger.warn(`Invoice resolve HTTP ${res.status} (non-blocking)`);
    }
  } catch (err) {
    logger.warn(`Invoice resolve failed (non-blocking): ${err?.message || err}`);
  }
}
// const MessageQueueService = require('../../backend/services/messageQueue.service'); // TODO: Fix import path for Azure Functions

/**
 * DIME sometimes sends a JSON array; some payloads omit root `type` but include transaction_type (ACH/CC).
 */
function normalizeWebhookBody(raw) {
  if (Array.isArray(raw)) {
    return raw.length > 0 ? raw[0] : {};
  }
  return raw && typeof raw === 'object' ? raw : {};
}

function inferDimeEventType(webhookData) {
  const direct = webhookData.type || webhookData.event_type;
  if (direct) return direct;
  const tt = String(webhookData.transaction_type || '').toLowerCase();
  const ts = String(webhookData.transaction_status || '').toLowerCase();
  const tsd = String(webhookData.transaction_status_description || '').toLowerCase();
  // Recurring hints first — DIME often sends credit_card_charge-shaped payloads for monthly recurring without repeating "recurring" in transaction_type.
  if (webhookData.recurring_payment_id || webhookData.schedule_id) {
    return 'recurring_payment_success';
  }
  if (ts.includes('recurring') || tsd.includes('recurring')) {
    return 'recurring_payment_success';
  }
  if (tt.includes('ach')) return 'ach_charge';
  if (tt.includes('cc') || tt.includes('credit') || tt.includes('card')) return 'credit_card_charge';
  return null;
}

/**
 * Best-effort tenant for SystemIntegrationErrors when merchant_id / schedule lookups did not run.
 */
async function resolveTenantIdFromWebhookPayload(pool, webhookData) {
  const merchantId = webhookData.merchant_id || webhookData.sid;
  if (merchantId) {
    try {
      const tenantResult = await pool.request()
        .input('merchantId', sql.NVarChar(255), merchantId)
        .query(`
          SELECT TOP 1 t.TenantId
          FROM oe.Tenants t
          WHERE JSON_VALUE(t.PaymentProcessorSettings, '$.processors.openenroll.dime.sid') = @merchantId
        `);
      if (tenantResult.recordset.length > 0) return tenantResult.recordset[0].TenantId;
    } catch (_) { /* ignore */ }
  }
  const scheduleId = webhookData.schedule_id || webhookData.recurring_payment_id;
  if (scheduleId) {
    try {
      const r = await pool.request()
        .input('scheduleId', sql.NVarChar(255), String(scheduleId))
        .query(`
          SELECT TOP 1 g.TenantId
          FROM oe.GroupRecurringPaymentPlans grp
          INNER JOIN oe.Groups g ON grp.GroupId = g.GroupId
          WHERE grp.DimeScheduleId = @scheduleId AND grp.IsActive = 1
        `);
      if (r.recordset.length > 0) return r.recordset[0].TenantId;
    } catch (_) { /* ignore */ }
  }
  const cu = webhookData.customer_uuid;
  if (cu) {
    try {
      const g = await pool.request()
        .input('cu', sql.NVarChar(255), String(cu))
        .query(`
          SELECT TOP 1 TenantId FROM oe.Groups
          WHERE ProcessorCustomerId = @cu AND Status = N'Active'
        `);
      if (g.recordset.length > 0) return g.recordset[0].TenantId;
    } catch (_) { /* ignore */ }
    try {
      const m = await pool.request()
        .input('cu', sql.NVarChar(255), String(cu))
        .query(`
          SELECT TOP 1 u.TenantId
          FROM oe.MemberPaymentMethods mpm
          INNER JOIN oe.Members mem ON mem.MemberId = mpm.MemberId
          INNER JOIN oe.Users u ON u.UserId = mem.UserId
          WHERE mpm.ProcessorCustomerId = @cu AND mpm.Status = N'Active'
        `);
      if (m.recordset.length > 0) return m.recordset[0].TenantId;
    } catch (_) { /* ignore */ }
  }
  return null;
}

module.exports = async function (context, req) {
  const logger = createLogger(context);
  logger.info('Webhook received');

  let pool;

  try {
    let foundTenantId = null;
    let tenantWebhookSecret = null;

    const signature = req.headers['x-dime-signature'];
    const rawBody = req.body;
    if (Array.isArray(rawBody) && rawBody.length > 1) {
      logger.warn(`Webhook body is array of ${rawBody.length} events; processing first element only`);
    }
    const webhookData = normalizeWebhookBody(rawBody);
    const payload = JSON.stringify(webhookData);

    // NEW DIME WEBHOOK STRUCTURE:
    // Prefer type / event_type; else infer from transaction_type (DIME ACH/CC often omit root type)
    let eventType = inferDimeEventType(webhookData);
    if (!eventType) {
      eventType = 'unknown_webhook';
      logger.warn('Could not infer event type; using unknown_webhook (check DIME payload)');
    }

    logger.info(`Event type: ${eventType}`);
    logger.info(`Webhook payload keys: ${Object.keys(webhookData).join(', ')}`);

    // Connect to database first to look up tenant-specific webhook secret
    pool = await getPool();
    
    // SECURITY: Signature verification DISABLED for now (will re-enable later)
    // TODO: Re-enable signature verification once webhook secrets are properly configured
    logger.warn('⚠️ Signature verification is DISABLED - webhooks will be accepted without verification');
    
    // SECURITY MODEL:
    // 1. DIME sends webhook with x-dime-signature header
    // 2. DIME signs the webhook using the webhook secret configured in THEIR system for that merchant/tenant
    // 3. We identify which tenant this webhook is for (via merchant_id/SID or schedule_id)
    // 4. We get that tenant's webhook secret from our database
    // 5. We verify the signature matches - this proves:
    //    a) It's from DIME (only DIME has the secret)
    //    b) It's for that specific tenant (only that tenant's secret will match)
    //
    // The signature verification is what proves authenticity - not just that it's from DIME,
    // but that it's from DIME for that specific merchant/tenant.
    
    // Try to identify tenant from merchant_id/SID first (if DIME sends it)
    // In new format, these fields may not exist - try customer_uuid lookup instead
    const merchantId = webhookData.merchant_id || webhookData.sid;
    if (merchantId) {
      try {
        logger.info(`Looking up tenant by merchant_id/SID: ${merchantId}`);
        const tenantResult = await pool.request()
          .input('merchantId', sql.NVarChar(255), merchantId)
          .query(`
            SELECT TOP 1 t.TenantId, t.PaymentProcessorSettings
            FROM oe.Tenants t
            WHERE JSON_VALUE(t.PaymentProcessorSettings, '$.processors.openenroll.dime.sid') = @merchantId
          `);
        
        if (tenantResult.recordset.length > 0) {
          foundTenantId = tenantResult.recordset[0].TenantId;
          const settings = JSON.parse(tenantResult.recordset[0].PaymentProcessorSettings);
          const dimeConfig = settings?.processors?.openenroll?.dime;
          if (dimeConfig?.webhookSecretEncrypted) {
            const encryptionService = require('../shared/encryptionService');
            tenantWebhookSecret = encryptionService.decrypt(dimeConfig.webhookSecretEncrypted);
            logger.info(`Found tenant-specific webhook secret via merchant_id for tenant: ${foundTenantId}`);
          } else if (dimeConfig?.webhookSecret) {
            tenantWebhookSecret = dimeConfig.webhookSecret;
            logger.info(`Found tenant-specific webhook secret (unencrypted) via merchant_id for tenant: ${foundTenantId}`);
          }
        }
      } catch (error) {
        logger.warn(`Could not get tenant webhook secret by merchant_id: ${error.message}`);
      }
    }
    
    // For recurring payment events, also try to get tenant from schedule_id or customer_uuid
    // (This is a fallback if merchant_id lookup didn't work)
    if (!tenantWebhookSecret && eventType && (eventType.includes('recurring_payment') || eventType.includes('recurring'))) {
      // Try to get schedule_id from webhook (may not be present in new format)
      const scheduleId = webhookData.schedule_id || webhookData.recurring_payment_id;
      
      // If no schedule_id, try customer_uuid lookup
      if (!scheduleId && webhookData.customer_uuid) {
        try {
          logger.info(`Looking up tenant by customer_uuid: ${webhookData.customer_uuid}`);
          const tenantResult = await pool.request()
            .input('customerUuid', sql.NVarChar(255), webhookData.customer_uuid)
            .query(`
              SELECT TOP 1 t.TenantId, t.PaymentProcessorSettings
              FROM oe.Groups g
              INNER JOIN oe.Tenants t ON g.TenantId = t.TenantId
              WHERE g.ProcessorCustomerId = @customerUuid
                AND g.Status = 'Active'
            `);
          
          if (tenantResult.recordset.length > 0) {
            foundTenantId = tenantResult.recordset[0].TenantId;
            const settings = JSON.parse(tenantResult.recordset[0].PaymentProcessorSettings);
            const dimeConfig = settings?.processors?.openenroll?.dime;
            if (dimeConfig?.webhookSecretEncrypted) {
              const encryptionService = require('../shared/encryptionService');
              tenantWebhookSecret = encryptionService.decrypt(dimeConfig.webhookSecretEncrypted);
              logger.info(`Found tenant-specific webhook secret via customer_uuid for tenant: ${foundTenantId}`);
            } else if (dimeConfig?.webhookSecret) {
              tenantWebhookSecret = dimeConfig.webhookSecret;
              logger.info(`Found tenant-specific webhook secret (unencrypted) via customer_uuid for tenant: ${foundTenantId}`);
            }
          }
        } catch (error) {
          logger.warn(`Could not get tenant webhook secret by customer_uuid: ${error.message}`);
        }
      }
      if (scheduleId) {
        try {
          logger.info(`Looking up tenant webhook secret for schedule: ${scheduleId}`);
          const tenantResult = await pool.request()
            .input('scheduleId', sql.NVarChar(255), String(scheduleId))
            .query(`
              SELECT TOP 1 t.TenantId, t.PaymentProcessorSettings
              FROM oe.GroupRecurringPaymentPlans grp
              INNER JOIN oe.Groups g ON grp.GroupId = g.GroupId
              INNER JOIN oe.Tenants t ON g.TenantId = t.TenantId
              WHERE grp.DimeScheduleId = @scheduleId
                AND grp.IsActive = 1
            `);
          
          if (tenantResult.recordset.length > 0) {
            foundTenantId = tenantResult.recordset[0].TenantId;
            const settings = JSON.parse(tenantResult.recordset[0].PaymentProcessorSettings);
            const dimeConfig = settings?.processors?.openenroll?.dime;
            if (dimeConfig?.webhookSecretEncrypted) {
              const encryptionService = require('../shared/encryptionService');
              tenantWebhookSecret = encryptionService.decrypt(dimeConfig.webhookSecretEncrypted);
              logger.info(`Found tenant-specific webhook secret for tenant: ${foundTenantId}`);
            } else if (dimeConfig?.webhookSecret) {
              tenantWebhookSecret = dimeConfig.webhookSecret;
              logger.info(`Found tenant-specific webhook secret (unencrypted) for tenant: ${foundTenantId}`);
            } else {
              logger.warn(`⚠️ No webhook secret configured in database for tenant: ${foundTenantId} - will try environment secrets`);
            }
          } else {
            logger.warn(`⚠️ No active schedule found for schedule_id: ${scheduleId} - will try environment secrets`);
          }
        } catch (error) {
          logger.warn(`Could not get tenant webhook secret: ${error.message}`);
        }
      } else {
        logger.warn(`⚠️ No schedule_id in recurring payment webhook - will try environment secrets`);
      }
    }
    
    // SECURITY: Signature verification DISABLED for now
    // TODO: Re-enable signature verification once webhook secrets are properly configured
    logger.info('⏭️ Skipping signature verification - webhook will be processed');
    const signatureResult = { valid: true, environment: 'disabled' };
    
    logger.info(`Webhook verified from ${signatureResult.environment} environment`);
    let webhookEventId = null;

    try {
    // Store webhook event (pass entire webhookData as data)
      webhookEventId = await storeWebhookEvent(pool, eventType, webhookData, signatureResult.environment);
      logger.info(`Stored webhook event: ${webhookEventId} from ${signatureResult.environment} environment`);

    // Process based on event type
    // Map new format event types to handler functions
    // New format: "recurring_payment_success" -> handler expects "recurring_payment.success"
    const normalizedEventType = normalizeEventType(eventType);
    
    switch (normalizedEventType) {
        // Credit Card Events
        case 'credit_card_charge':
          await handleCreditCardCharge(pool, webhookData, webhookEventId, logger);
          break;
        case 'credit_card_refund':
          await handleCreditCardRefund(pool, webhookData, webhookEventId, logger);
          break;
        case 'credit_card_void':
          await handleCreditCardVoid(pool, webhookData, webhookEventId, logger);
          break;
        case 'credit_card_chargeback':
          await handleCreditCardChargeback(pool, webhookData, webhookEventId, logger);
          break;

        // ACH Events
        case 'ach_charge':
          await handleACHCharge(pool, webhookData, webhookEventId, logger);
          break;
        case 'ach_payment_return':
          await handleACHPaymentReturn(pool, webhookData, webhookEventId, logger);
          break;
        case 'ach_refund':
          await handleACHRefund(pool, webhookData, webhookEventId, logger);
          break;

        // Deposit Events
        case 'deposit_sent':
          await handleDepositSent(pool, webhookData, webhookEventId, logger);
          break;

        // Recurring Payment Events
      case 'recurring_payment.success':
        await handleRecurringPaymentSuccess(pool, webhookData, webhookEventId, logger);
        break;
      case 'recurring_payment.failed':
        await handleRecurringPaymentFailed(pool, webhookData, webhookEventId, logger);
        break;
      case 'recurring_payment.schedule_updated':
        logger.info('Schedule updated event received (informational only)');
        break;
        case 'recurring_payment.schedule_canceled':
          logger.info('Schedule canceled event received (informational only)');
          break;

      default:
        logger.warn(`Unknown event type: ${eventType} (normalized: ${normalizedEventType})`);
    }

      // Mark webhook as processed
      await markWebhookProcessed(pool, webhookEventId, true);

      context.res = { status: 200, body: { success: true, event_type: eventType, processed: true } };

    } catch (error) {
      logger.error(`Error processing webhook: ${error.message}`);
      let errTenantId = foundTenantId;
      if (!errTenantId && pool) {
        try {
          errTenantId = await resolveTenantIdFromWebhookPayload(pool, webhookData);
        } catch (_) { /* ignore */ }
      }
      await recordIntegrationError({
        category: 'payment_webhook',
        source: 'DimeWebhookHandler',
        tenantId: errTenantId,
        message: error.message || 'Webhook processing error',
        detail: {
          eventType: eventType || null,
          webhookEventId: webhookEventId || null,
          stack: error.stack ? String(error.stack).slice(0, 4000) : null
        }
      });
      if (webhookEventId) {
        await markWebhookProcessed(pool, webhookEventId, false, error.message);
      }
      
      context.res = { status: 200, body: { success: false, error: error.message } };
    }

  } catch (error) {
    logger.error(`Webhook processing failed: ${error.message}`);
    let errTenantIdOuter = foundTenantId;
    let wdForTenant = {};
    try {
      wdForTenant = normalizeWebhookBody(req.body);
    } catch (_) {
      wdForTenant = {};
    }
    if (!errTenantIdOuter && pool) {
      try {
        errTenantIdOuter = await resolveTenantIdFromWebhookPayload(pool, wdForTenant);
      } catch (_) { /* ignore */ }
    }
    const wh = wdForTenant && typeof wdForTenant === 'object' ? wdForTenant : {};
    await recordIntegrationError({
      category: 'payment_webhook',
      source: 'DimeWebhookHandler',
      tenantId: errTenantIdOuter,
      message: error.message || 'Webhook outer failure',
      detail: {
        eventType: wh.type || wh.event_type || inferDimeEventType(wh) || null,
        webhookEventId: null,
        transaction_number: wh.transaction_number != null ? String(wh.transaction_number) : null,
        transaction_id: wh.transaction_id != null ? String(wh.transaction_id) : null,
        schedule_id: wh.schedule_id != null ? String(wh.schedule_id) : null,
        recurring_payment_id: wh.recurring_payment_id != null ? String(wh.recurring_payment_id) : null,
        customer_uuid: wh.customer_uuid != null ? String(wh.customer_uuid) : null,
        stack: error.stack ? String(error.stack).slice(0, 4000) : null
      }
    });
    context.res = { status: 500, body: { error: 'Internal server error' } };
  } finally {
    if (pool) {
      await pool.close();
    }
  }
};

/**
 * Normalize event type from new DIME format to handler format
 * New format: "recurring_payment_success" -> "recurring_payment.success"
 * Also supports old format for backward compatibility
 */
function normalizeEventType(eventType) {
  if (!eventType) return eventType;
  
  // Map new format to old format
  const eventTypeMap = {
    'recurring_payment_success': 'recurring_payment.success',
    'recurring_payment_failed': 'recurring_payment.failed',
    'recurring_payment_schedule_updated': 'recurring_payment.schedule_updated',
    'recurring_payment_schedule_canceled': 'recurring_payment.schedule_canceled',
    'credit_card_charge': 'credit_card_charge',
    'credit_card_refund': 'credit_card_refund',
    'credit_card_void': 'credit_card_void',
    'credit_card_chargeback': 'credit_card_chargeback',
    'ach_charge': 'ach_charge',
    'ach_payment_return': 'ach_payment_return',
    'ach_refund': 'ach_refund',
    'deposit_sent': 'deposit_sent'
  };
  
  // If already in old format, return as-is
  if (eventType.includes('.')) {
    return eventType;
  }
  
  // Map new format to old format
  return eventTypeMap[eventType] || eventType;
}

function verifyWebhookSignature(signature, payload, tenantWebhookSecret = null) {
  // Debug logging
  console.log('🔍 Signature Verification Debug:');
  console.log('  Received signature:', signature);
  console.log('  Payload length:', payload.length);
  console.log('  Has tenant secret:', !!tenantWebhookSecret);
  
  // First, try tenant-specific webhook secret (for recurring payments)
  if (tenantWebhookSecret) {
    const expectedSignature = crypto
      .createHmac('sha256', tenantWebhookSecret)
      .update(payload)
      .digest('hex');
    
    console.log('  Tenant expected signature:', `sha256=${expectedSignature}`);
    
    if (signature === `sha256=${expectedSignature}`) {
      console.log('  ✅ Signature verified with TENANT-SPECIFIC secret');
      return { valid: true, environment: 'tenant-specific' };
    }
  }
  
  // Fall back to environment variables
  const demoSecret = process.env.DIME_DEMO_WEBHOOK_SECRET;
  const prodSecret = process.env.DIME_WEBHOOK_SECRET;
  
  console.log('  Has demo secret:', !!demoSecret);
  console.log('  Has prod secret:', !!prodSecret);
  
  // Try demo environment
  if (demoSecret) {
    const expectedSignature = crypto
      .createHmac('sha256', demoSecret)
      .update(payload)
      .digest('hex');
    
    console.log('  Demo expected signature:', `sha256=${expectedSignature}`);
    
    if (signature === `sha256=${expectedSignature}`) {
      console.log('  ✅ Signature verified with DEMO secret');
      return { valid: true, environment: 'demo' };
    }
  }
  
  // Try production environment
  if (prodSecret) {
    const expectedSignature = crypto
      .createHmac('sha256', prodSecret)
      .update(payload)
      .digest('hex');

    console.log('  Prod expected signature:', `sha256=${expectedSignature}`);
    
    if (signature === `sha256=${expectedSignature}`) {
      console.log('  ✅ Signature verified with PRODUCTION secret');
      return { valid: true, environment: 'production' };
    }
  }
  
  // No valid signature found
  if (!tenantWebhookSecret && !demoSecret && !prodSecret) {
    console.warn('⚠️ No DIME webhook secrets configured, skipping signature verification');
    return { valid: true, environment: 'development' };
  }
  
  console.error('  ❌ Signature verification failed - no match found');
  return { valid: false, environment: 'unknown' };
}

async function storeWebhookEvent(pool, eventType, data, environment = 'unknown') {
  // NEW DIME WEBHOOK FORMAT - map fields correctly
  const safeEventType =
    eventType && String(eventType).trim() ? String(eventType).trim() : 'unknown_webhook';
  const transactionId = data.transaction_number || data.transaction_id || data.transactionNumber;
  const amount = parseFloat(data.amount) || 0;
  const status = oePaymentStatus.mapDimePayloadToPaymentRecordStatus(data);
  
  const result = await pool.request()
    .input('eventType', sql.NVarChar(100), safeEventType || 'unknown_webhook')
    .input('eventId', sql.NVarChar(255), data.transaction_info_id || data.event_id || data.id || `webhook_${Date.now()}`)
    .input('processor', sql.NVarChar(50), 'DIME')
    .input('processorEventId', sql.NVarChar(255), data.transaction_info_id || data.event_id || data.id)
    .input('merchantId', sql.NVarChar(100), data.merchant_id || data.sid || 'unknown')
    .input('payload', sql.NVarChar(sql.MAX), JSON.stringify(data))
    .input('transactionId', sql.NVarChar(255), transactionId)
    .input('amount', sql.Decimal(10,2), amount)
    .input('status', sql.NVarChar(50), status)
    .query(`
      INSERT INTO oe.PaymentWebhookEvents (
        EventId, EventType, Processor, ProcessorEventId, MerchantId, Payload, 
        TransactionId, Amount, Status, Processed, CreatedDate, ModifiedDate
      )
      OUTPUT inserted.WebhookEventId
      VALUES (
        NEWID(), COALESCE(@eventType, N'unknown_webhook'), @processor, @processorEventId, @merchantId, @payload,
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
async function getFailureAttemptInfo(pool, groupId, tenantId, amount, paymentMethod, logger, householdId = null) {
  try {
    if (!tenantId || (!groupId && !householdId)) {
      return { attemptNumber: 1, consecutiveFailures: 0, originalPaymentId: null };
    }

    // Find the most recent failed payment for this group or household with same amount/method
    const failureResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('householdId', sql.UniqueIdentifier, householdId)
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
        WHERE TenantId = @tenantId
          AND Amount = @amount
          AND PaymentMethod = @paymentMethod
          AND Status = 'Failed'
          AND TransactionType = 'Payment'
          AND (
            (@groupId IS NOT NULL AND GroupId = @groupId)
            OR (@groupId IS NULL AND @householdId IS NOT NULL AND HouseholdId = @householdId)
          )
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

/**
 * When DIME issues a new transaction id on settlement, find the single open row we already have for this charge
 * (Pending/Failed) so we update it instead of inserting a duplicate.
 */
async function findOpenCreditCardPaymentRow(pool, { tenantId, groupId, householdId, amount, enrollmentId, invoiceId }) {
  if (!tenantId || !amount) return null;
  try {
    const req = pool.request();
    req.input('tenantId', sql.UniqueIdentifier, tenantId);
    req.input('amount', sql.Decimal(10, 2), amount);
    let where = `
      WHERE p.TenantId = @tenantId
        AND p.TransactionType = N'Payment'
        AND p.Status IN (N'Pending', N'Failed')
        AND p.Amount = @amount
        AND LOWER(ISNULL(p.Processor, N'')) LIKE N'%dime%'`;
    if (invoiceId) {
      req.input('invoiceId', sql.UniqueIdentifier, invoiceId);
      where += ` AND p.InvoiceId = @invoiceId`;
    } else if (enrollmentId) {
      req.input('enrollmentId', sql.UniqueIdentifier, enrollmentId);
      where += ` AND p.EnrollmentId = @enrollmentId`;
    } else if (groupId) {
      req.input('groupId', sql.UniqueIdentifier, groupId);
      where += ` AND p.GroupId = @groupId`;
    } else if (householdId) {
      req.input('householdId', sql.UniqueIdentifier, householdId);
      where += ` AND p.HouseholdId = @householdId`;
    } else {
      return null;
    }
    const result = await req.query(`
      SELECT TOP 1
        p.PaymentId, p.GroupId, p.HouseholdId, p.InvoiceId, p.PaymentDate, p.EnrollmentId, p.RecurringScheduleId, p.AgentId,
        p.SystemFees, p.ProcessingFeeAmount
      FROM oe.Payments p
      ${where}
      ORDER BY p.ModifiedDate DESC
    `);
    return result.recordset[0] || null;
  } catch (e) {
    return null;
  }
}

/**
 * Best-effort AgentId for group-level payments (no enrollment on webhook).
 */
async function lookupAgentIdForGroup(pool, groupId, logger) {
  if (!groupId) return null;
  try {
    const enrollmentResult = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`
        SELECT TOP 1 e.AgentId
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.GroupId = @groupId
          AND e.Status = N'Active'
          AND e.AgentId IS NOT NULL
        ORDER BY e.EffectiveDate DESC, e.CreatedDate DESC
      `);
    if (enrollmentResult.recordset.length > 0) {
      const aid = enrollmentResult.recordset[0].AgentId;
      logger.info(`lookupAgentIdForGroup: ${aid} for group ${groupId}`);
      return aid || null;
    }
  } catch (e) {
    logger.warn(`lookupAgentIdForGroup: ${e.message}`);
  }
  return null;
}

async function fetchAgentUserForPaymentEmail(pool, agentId, tenantId, logger) {
  if (!agentId || !tenantId) return null;
  try {
    const r = await pool.request()
      .input('agentId', sql.UniqueIdentifier, agentId)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT u.UserId, u.Email, u.FirstName
        FROM oe.Agents a
        INNER JOIN oe.Users u ON u.UserId = a.UserId
        WHERE a.AgentId = @agentId
          AND a.TenantId = @tenantId
      `);
    if (r.recordset.length === 0) {
      const r2 = await pool.request()
        .input('agentId', sql.UniqueIdentifier, agentId)
        .query(`
          SELECT u.UserId, u.Email, u.FirstName
          FROM oe.Agents a
          INNER JOIN oe.Users u ON u.UserId = a.UserId
          WHERE a.AgentId = @agentId
        `);
      if (r2.recordset.length === 0) return null;
      r.recordset = r2.recordset;
    }
    const row = r.recordset[0];
    const email = row.Email ? String(row.Email).trim() : '';
    if (!email) return null;
    return {
      userId: row.UserId,
      email,
      firstName: row.FirstName ? String(row.FirstName).trim() : 'there'
    };
  } catch (e) {
    logger.warn(`fetchAgentUserForPaymentEmail: ${e.message}`);
    return null;
  }
}

async function insertPaymentFailureEmailToQueue(pool, {
  cleanTenantId,
  recipientUserId,
  recipientAddress,
  subject,
  htmlBody,
  logger
}) {
  const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const escapeSqlString = (str) => String(str).replace(/'/g, "''");
  const cleanRecipientId = recipientUserId ? String(recipientUserId).trim() : null;
  if (cleanRecipientId && !guidPattern.test(cleanRecipientId)) {
    logger.error(`Invalid RecipientId for queue: ${cleanRecipientId}`);
    return;
  }
  const recipientIdValue = cleanRecipientId ? `'${escapeSqlString(cleanRecipientId)}'` : 'NULL';
  const minifiedEmailBody = htmlBody
    .replace(/\r\n/g, '')
    .replace(/\n/g, '')
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
    .trim();
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
  const req = pool.request();
  req.input('messageType', sql.NVarChar, 'Email');
  req.input('recipientAddress', sql.NVarChar, recipientAddress);
  req.input('subject', sql.NVarChar, subject);
  req.input('body', sql.NVarChar(sql.MAX), minifiedEmailBody);
  await req.query(query);
}

// Helper function to send payment failure notification email
async function sendPaymentFailureNotification(pool, paymentData, logger, groupId, tenantId, isIndividualRecurring = false, locationId = null, agentId = null) {
  let finalTenantId;
  let groupContactEmail = null;
  try {
    logger.info(`sendPaymentFailureNotification called - GroupId: ${groupId}, TenantId: ${tenantId}, EnrollmentId: ${paymentData.enrollment_id}, AgentId: ${agentId}`);
    
    // Try to get group contact email if no enrollment_id
    let memberResult = null;
    let groupName = null;
    let userId = null;
    let resolvedAgentId = agentId || null;
    
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
      if (!resolvedAgentId) {
        resolvedAgentId = await lookupAgentIdForGroup(pool, groupId, logger);
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
            g.Name as GroupName,
            e.AgentId AS EnrollmentAgentId
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
        if (!resolvedAgentId && member.EnrollmentAgentId) {
          resolvedAgentId = member.EnrollmentAgentId;
        }
      }
    }

    if (!groupContactEmail && !resolvedAgentId) {
      logger.warn('No contact email and no agent for payment failure notification');
      return;
    }

    // Fetch payment method details (last 4 digits) from the actual payment method used
    let paymentMethodLast4 = null;
    let paymentMethodType = paymentData.payment_method || 'Unknown';
    let paymentMethodDisplay = paymentMethodType;
    
    if (groupId && !isIndividualRecurring) {
      try {
        // For group payments, look for payment method by location (if locationId provided) or default
        const paymentMethodResult = await pool.request()
          .input('groupId', sql.UniqueIdentifier, groupId)
          .input('locationId', sql.UniqueIdentifier, locationId)
          .query(`
            SELECT TOP 1 
              CardLast4, 
              AccountNumberLast4,
              Type,
              CardBrand
            FROM oe.GroupPaymentMethods
            WHERE GroupId = @groupId
              AND Status = 'Active'
              AND (LocationId = @locationId OR (@locationId IS NULL AND IsDefault = 1))
            ORDER BY 
              CASE WHEN LocationId = @locationId THEN 1 ELSE 2 END,
              IsDefault DESC, 
              CreatedDate DESC
          `);
        
        if (paymentMethodResult.recordset.length > 0) {
          const pm = paymentMethodResult.recordset[0];
          paymentMethodLast4 = pm.CardLast4 || pm.AccountNumberLast4 || null;
          paymentMethodType = pm.Type || paymentMethodType;
          
          // Format payment method display with last 4 digits
          if (paymentMethodLast4) {
            if (pm.Type === 'Card' || pm.Type === 'CreditCard') {
              paymentMethodDisplay = `${pm.CardBrand || 'Card'} ending in ${paymentMethodLast4}`;
            } else if (pm.Type === 'ACH') {
              paymentMethodDisplay = `Bank Account ending in ${paymentMethodLast4}`;
            } else {
              paymentMethodDisplay = `${paymentMethodType} ending in ${paymentMethodLast4}`;
            }
          } else {
            paymentMethodDisplay = paymentMethodType;
          }
        }
      } catch (pmError) {
        logger.warn(`Could not fetch payment method details: ${pmError.message}`);
      }
    } else if (isIndividualRecurring && paymentData.enrollment_id) {
      // For individual payments, try to get payment method from enrollment/household
      try {
        const individualPaymentMethodResult = await pool.request()
          .input('enrollmentId', sql.UniqueIdentifier, paymentData.enrollment_id)
          .query(`
            SELECT TOP 1 
              hpm.CardLast4,
              hpm.AccountNumberLast4,
              hpm.Type,
              hpm.CardBrand
            FROM oe.Enrollments e
            INNER JOIN oe.Members m ON e.MemberId = m.MemberId
            LEFT JOIN oe.HouseholdPaymentMethods hpm ON m.HouseholdId = hpm.HouseholdId
              AND hpm.IsDefault = 1
              AND hpm.Status = 'Active'
            WHERE e.EnrollmentId = @enrollmentId
          `);
        
        if (individualPaymentMethodResult.recordset.length > 0) {
          const pm = individualPaymentMethodResult.recordset[0];
          paymentMethodLast4 = pm.CardLast4 || pm.AccountNumberLast4 || null;
          paymentMethodType = pm.Type || paymentMethodType;
          
          if (paymentMethodLast4) {
            if (pm.Type === 'Card' || pm.Type === 'CreditCard') {
              paymentMethodDisplay = `${pm.CardBrand || 'Card'} ending in ${paymentMethodLast4}`;
            } else if (pm.Type === 'ACH') {
              paymentMethodDisplay = `Bank Account ending in ${paymentMethodLast4}`;
            } else {
              paymentMethodDisplay = `${paymentMethodType} ending in ${paymentMethodLast4}`;
            }
          }
        }
      } catch (pmError) {
        logger.warn(`Could not fetch individual payment method details: ${pmError.message}`);
      }
    }

    // For group payments, RecipientId can be NULL
    let recipientId = userId || null;
    finalTenantId = tenantId;
    
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

    // Get tenant settings for base URL (after finalTenantId is known)
    let baseUrl = 'https://app.allaboard365.com'; // Default fallback
    try {
      const tenantResult = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, finalTenantId)
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
          baseUrl = `https://${customDomain}`;
        }
      }
    } catch (urlError) {
      logger.warn(`Could not fetch tenant settings for base URL: ${urlError.message}`);
    }
    
    const dashboardUrl = `${baseUrl}/dashboard`;
    
    // Format attempt number display
    const attemptDisplay = paymentData.attempt_number 
      ? ` (Attempt ${paymentData.attempt_number})`
      : '';

    const memberDisplayName =
      memberResult && memberResult.recordset.length > 0
        ? `${memberResult.recordset[0].FirstName || ''} ${memberResult.recordset[0].LastName || ''}`.trim() || '—'
        : '—';
    const groupOrIndividualLabel = isIndividualRecurring
      ? 'Individual (household)'
      : (groupName || '—');

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
    
    const cleanTenantId = String(finalTenantId).trim();

    if (groupContactEmail) {
      logger.info(`Queuing member/contact email - TenantId: ${cleanTenantId}, Recipient: ${groupContactEmail}`);
      await insertPaymentFailureEmailToQueue(pool, {
        cleanTenantId,
        recipientUserId: recipientId || null,
        recipientAddress: groupContactEmail,
        subject,
        htmlBody: emailBody,
        logger
      });
      logger.info(`✅ Payment failure notification queued for ${groupContactEmail}`);
    }

    if (resolvedAgentId) {
      const agentUser = await fetchAgentUserForPaymentEmail(pool, resolvedAgentId, cleanTenantId, logger);
      if (agentUser) {
        const dup =
          groupContactEmail &&
          agentUser.email.toLowerCase() === String(groupContactEmail).trim().toLowerCase();
        if (dup) {
          logger.info('Skipping agent payment-failure email (same address as member/contact)');
        } else {
          const htmlEsc = (v) =>
            String(v ?? '')
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;');
          const agentGreeting = htmlEsc(agentUser.firstName || 'there');
          const memberLine = htmlEsc(memberDisplayName);
          const groupLine = htmlEsc(groupOrIndividualLabel);
          const methodLine = htmlEsc(paymentMethodDisplay);
          const agentSubject = `Payment failed — member account — $${paymentData.amount}${attemptDisplay}`;
          const safeReason = String(failureReason).replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const agentEmailBody = `
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Payment failed (member)</title>
</head>
<body style="margin:0;padding:0;background-color:#f8f9fa;font-family:Arial,Helvetica,sans-serif;color:#333333;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f8f9fa;">
<tr>
<td align="center" style="padding:20px 0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1);">
<tr>
<td style="padding:30px 30px 20px 30px;text-align:center;border-bottom:2px solid #b45309;">
<h1 style="margin:0;font-size:24px;font-weight:600;color:#b45309;font-family:Arial,Helvetica,sans-serif;">Payment failed (member account)</h1>
</td>
</tr>
<tr>
<td style="padding:30px 30px;">
<p style="margin:0 0 16px 0;font-size:16px;line-height:24px;color:#555555;font-family:Arial,Helvetica,sans-serif;">Hi ${agentGreeting},</p>
<p style="margin:0 0 16px 0;font-size:16px;line-height:24px;color:#555555;font-family:Arial,Helvetica,sans-serif;">A payment <strong>did not go through</strong> for an enrollment you are associated with. The member or group contact may receive a separate notice with instructions to update their payment method.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f8f9fa;border-radius:6px;margin:16px 0;">
<tr>
<td style="padding:20px;">
<p style="margin:5px 0;font-size:14px;color:#666666;font-family:Arial,Helvetica,sans-serif;"><strong>Amount:</strong> $${paymentData.amount}</p>
<p style="margin:5px 0;font-size:14px;color:#666666;font-family:Arial,Helvetica,sans-serif;"><strong>Member:</strong> ${memberLine}</p>
<p style="margin:5px 0;font-size:14px;color:#666666;font-family:Arial,Helvetica,sans-serif;"><strong>Group / context:</strong> ${groupLine}</p>
<p style="margin:5px 0;font-size:14px;color:#666666;font-family:Arial,Helvetica,sans-serif;"><strong>Payment method:</strong> ${methodLine}</p>
${paymentData.attempt_number ? `<p style="margin:5px 0;font-size:14px;color:#666666;font-family:Arial,Helvetica,sans-serif;"><strong>Attempt:</strong> ${paymentData.attempt_number}</p>` : ''}
<p style="margin:5px 0;font-size:14px;color:#666666;font-family:Arial,Helvetica,sans-serif;"><strong>Failure reason:</strong> ${safeReason}</p>
</td>
</tr>
</table>
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:24px 0;">
<tr>
<td align="center">
<a href="${dashboardUrl}" style="display:inline-block;background-color:#1f8dbf;color:#ffffff;text-decoration:none;padding:15px 30px;border-radius:4px;font-size:16px;font-weight:600;font-family:Arial,Helvetica,sans-serif;">Open dashboard</a>
</td>
</tr>
</table>
<p style="margin:16px 0 0 0;font-size:14px;color:#666666;font-family:Arial,Helvetica,sans-serif;">Ask the member to sign in at your tenant portal and update their payment method, or contact support if they need help.</p>
</td>
</tr>
<tr>
<td style="padding:25px 30px;background-color:#f8f9fa;border-top:1px solid #e9ecef;text-align:center;border-radius:0 0 8px 8px;">
<p style="margin:0;font-size:13px;color:#666666;font-family:Arial,Helvetica,sans-serif;">Automated notice for agents. Sign in uses your tenant portal (custom domain when configured).</p>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>
          `;
          await insertPaymentFailureEmailToQueue(pool, {
            cleanTenantId,
            recipientUserId: agentUser.userId,
            recipientAddress: agentUser.email,
            subject: agentSubject,
            htmlBody: agentEmailBody,
            logger
          });
          logger.info(`✅ Agent payment failure notification queued for ${agentUser.email}`);
        }
      } else {
        logger.warn(`No agent user email for AgentId ${resolvedAgentId}`);
      }
    }
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
  // NEW DIME WEBHOOK FORMAT
  const transactionId = data.transaction_number || data.transaction_id || data.transactionNumber;
  const amount = parseFloat(data.amount) || 0;
  const mapped = oePaymentStatus.mapDimePayloadToPaymentRecordStatus(data);
  const status = oePaymentStatus.mapChargeWebhookMappedStatusToDbStatus(mapped);
  const paymentMethod = data.transaction_type || data.payment_method || data.paymentMethod || 'Credit Card';

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
  let systemFees = contextFromEnrollment.systemFees || 0;
  let processingFeeAmount = 0;

  // Check for existing payment (e.g. retry flow already updated this row by ProcessorTransactionId)
  const existingResult = await pool.request()
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .query(`
      SELECT PaymentId, GroupId, HouseholdId, InvoiceId, PaymentDate, EnrollmentId, RecurringScheduleId, AgentId, SystemFees, ProcessingFeeAmount
      FROM oe.Payments
      WHERE ProcessorTransactionId = @processorTransactionId AND TransactionType = 'Payment'
    `);
  let targetPayment = existingResult.recordset[0];
  const invoiceIdFromWebhook = data.invoice_id || data.invoiceId || null;
  if (
    !targetPayment &&
    (status === 'Completed' || status === 'Pending')
  ) {
    targetPayment = await findOpenCreditCardPaymentRow(pool, {
      tenantId,
      groupId,
      householdId,
      amount,
      enrollmentId,
      invoiceId: invoiceIdFromWebhook
    });
    if (targetPayment) {
      logger.info(
        `Credit card charge: mapping new transaction id ${transactionId} to existing open payment ${targetPayment.PaymentId}`
      );
    }
  }

  if (targetPayment) {
    // Update existing payment (same ProcessorTransactionId, or open row matched for new settlement id)
    const existingPayment = targetPayment;
    const existingGroupId = existingPayment.GroupId || groupId;
    const existingHouseholdId = existingPayment.HouseholdId || householdId;
    const paymentDateForJson = existingPayment.PaymentDate || new Date();
    const existingEnrId = existingPayment.EnrollmentId || enrollmentId;
    const snapExisting = await buildProductSnapshotForPayment(
      pool,
      {
        householdId: existingHouseholdId,
        groupId: existingGroupId,
        paymentDate: paymentDateForJson,
        invoiceId: existingPayment.InvoiceId || null,
        enrollmentId: existingEnrId || null,
        productSnapshotScope:
          !existingPayment.InvoiceId && existingEnrId && !existingPayment.RecurringScheduleId
            ? 'enrollment'
            : undefined
      },
      logger
    );
    const productCommissionsJSON = snapExisting ? snapExisting.productCommissionsJSON : null;
    const productVendorAmountsJSON = snapExisting ? snapExisting.productVendorAmountsJSON : null;
    const productOwnerAmountsJSON = snapExisting ? snapExisting.productOwnerAmountsJSON : null;
    let updatedSystemFees = existingPayment.SystemFees || 0;
    let updatedProcessingFeeAmount = existingPayment.ProcessingFeeAmount || 0;
    try {
      if (existingHouseholdId) {
        const asOf = householdAsOfDate(paymentDateForJson) || paymentDateForJson;
        const feeBuckets = await getHouseholdFeeBucketsAsOf(pool, existingHouseholdId, asOf, sql);
        updatedSystemFees = feeBuckets.systemFees;
        updatedProcessingFeeAmount = feeBuckets.processingFeeAmount;
      }
    } catch (feeErr) {
      logger.warn(`Household fee buckets for credit card update: ${feeErr.message}`);
    }

    await pool.request()
      .input('paymentId', sql.UniqueIdentifier, existingPayment.PaymentId)
      .input('processorTransactionId', sql.NVarChar(255), transactionId)
      .input('status', sql.NVarChar(50), status)
      .input('webhookEventId', sql.Int, webhookEventId)
      .input('systemFees', sql.Decimal(10,2), updatedSystemFees)
      .input('processingFeeAmount', sql.Decimal(10,2), updatedProcessingFeeAmount)
      .input('productCommissions', sql.NVarChar(sql.MAX), productCommissionsJSON)
      .input('productVendorAmounts', sql.NVarChar(sql.MAX), productVendorAmountsJSON)
      .input('productOwnerAmounts', sql.NVarChar(sql.MAX), productOwnerAmountsJSON)
      .input('failureReason', sql.NVarChar(sql.MAX), status === 'Completed' ? null : (data.failure_reason || null))
      .query(`
        UPDATE oe.Payments
        SET ProcessorTransactionId = @processorTransactionId,
            Status = @status, WebhookEventId = @webhookEventId,
            SystemFees = @systemFees, ProcessingFeeAmount = @processingFeeAmount,
            ProductCommissions = @productCommissions, ProductVendorAmounts = @productVendorAmounts, ProductOwnerAmounts = @productOwnerAmounts,
            FailureReason = @failureReason, ModifiedDate = GETUTCDATE()
        WHERE PaymentId = @paymentId
      `);

    if (status === 'Completed' && existingPayment.InvoiceId) {
      try {
        await pool.request()
          .input('invoiceId', sql.UniqueIdentifier, existingPayment.InvoiceId)
          .input('amount', sql.Decimal(12,2), amount)
          .query(`
            UPDATE oe.Invoices
            SET Status = 'Paid', PaidAmount = @amount, PaymentReceivedDate = GETUTCDATE(), ModifiedDate = GETUTCDATE()
            WHERE InvoiceId = @invoiceId
          `);
        logger.info(`  Invoice ${existingPayment.InvoiceId} marked as Paid`);
      } catch (invoiceError) {
        logger.warn(`  Failed to update invoice status: ${invoiceError.message}`);
      }
    }
    logger.success(`Credit card charge webhook applied to existing payment: ${transactionId}`);
    if (status === 'Failed') {
      try {
        const failureAgentId = existingPayment.AgentId || agentId;
        await sendPaymentFailureNotification(
          pool,
          {
            enrollment_id: data.enrollment_id || existingPayment.EnrollmentId,
            amount: amount,
            payment_method: paymentMethod,
            transaction_id: transactionId,
            failure_reason: data.failure_reason
          },
          logger,
          existingGroupId,
          tenantId,
          false,
          null,
          failureAgentId
        );
      } catch (emailError) {
        logger.error('Failed to send payment failure notification:', emailError);
      }
    }
  } else {
    // New ProcessorTransactionId: insert a row. Distinct DIME transaction ids => distinct rows.
    // Same transaction id is handled above (targetPayment). Per-row: AttemptNumber, OriginalPaymentId, LastFailureDate;
    // full webhook payloads: oe.PaymentWebhookEvents (see storeWebhookEvent).
    let attemptInfo = { attemptNumber: null, consecutiveFailures: null, originalPaymentId: null };
    if (status === 'Failed') {
      attemptInfo = await getFailureAttemptInfo(pool, groupId, tenantId, amount, paymentMethod, logger, householdId);
      logger.info(`Payment failure attempt ${attemptInfo.attemptNumber} (${attemptInfo.consecutiveFailures} consecutive failures)`);
    }

    const paymentDateForNew = new Date();
    try {
      if (householdId) {
        const asOf = householdAsOfDate(paymentDateForNew) || paymentDateForNew;
        const feeBuckets = await getHouseholdFeeBucketsAsOf(pool, householdId, asOf, sql);
        systemFees = feeBuckets.systemFees;
        processingFeeAmount = feeBuckets.processingFeeAmount;
      }
    } catch (feeErr) {
      logger.warn(`Household fee buckets for credit card insert: ${feeErr.message}`);
    }
    const snapNew = await buildProductSnapshotForPayment(
      pool,
      { householdId, groupId, paymentDate: paymentDateForNew, invoiceId: null },
      logger
    );
    const productCommissionsJSON = snapNew ? snapNew.productCommissionsJSON : null;
    const productVendorAmountsJSON = snapNew ? snapNew.productVendorAmountsJSON : null;
    const productOwnerAmountsJSON = snapNew ? snapNew.productOwnerAmountsJSON : null;

    const paymentRequest = pool.request();
    paymentRequest
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
      .input('processingFeeAmount', sql.Decimal(10,2), processingFeeAmount)
      .input('productCommissions', sql.NVarChar(sql.MAX), productCommissionsJSON)
      .input('productVendorAmounts', sql.NVarChar(sql.MAX), productVendorAmountsJSON)
      .input('productOwnerAmounts', sql.NVarChar(sql.MAX), productOwnerAmountsJSON)
      .input('attemptNumber', sql.Int, attemptInfo.attemptNumber)
      .input('originalPaymentId', sql.UniqueIdentifier, attemptInfo.originalPaymentId)
      .input('consecutiveFailures', sql.Int, attemptInfo.consecutiveFailures)
      .input('failureReason', sql.NVarChar(sql.MAX), data.failure_reason || null)
      .input('lastFailureDate', sql.DateTime2, status === 'Failed' ? new Date() : null)
      .query(`
        INSERT INTO oe.Payments (
          PaymentId, EnrollmentId, AgentId, HouseholdId, TransactionType, Amount, Status, Processor, 
          ProcessorTransactionId, PaymentMethod, FailureReason, WebhookEventId, PaymentDate, 
          GroupId, TenantId, NetRate, Commission, OverrideRate, SystemFees, ProcessingFeeAmount, ProductCommissions,
          ProductVendorAmounts, ProductOwnerAmounts,
          AttemptNumber, OriginalPaymentId, ConsecutiveFailureCount, LastFailureDate,
          CreatedDate, ModifiedDate
        ) VALUES (
          NEWID(), @enrollmentId, @agentId, @householdId, @transactionType, @amount, @status, @processor,
          @processorTransactionId, @paymentMethod, @failureReason, @webhookEventId, @paymentDate, 
          @groupId, @tenantId, @netRate, @commission, @overrideRate, @systemFees, @processingFeeAmount, @productCommissions,
          @productVendorAmounts, @productOwnerAmounts,
          @attemptNumber, @originalPaymentId, @consecutiveFailures, @lastFailureDate,
          GETUTCDATE(), GETUTCDATE()
        )
      `);

    logger.success(`Credit card charge processed: ${transactionId}${attemptInfo.attemptNumber ? ` (Attempt ${attemptInfo.attemptNumber})` : ''}`);

    if (status !== 'Failed' && householdId && !groupId) {
      bestEffortResolveInvoice(logger, { paymentId: null, householdId, tenantId, paymentDate: new Date(), paymentAmount: amount });
    }

    // Send email notification if payment failed (only for newly inserted payments)
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
        }, logger, groupId, tenantId, false, null, agentId);
      } catch (emailError) {
        logger.error('Failed to send payment failure notification:', emailError);
      }
    }
  }
}

async function handleCreditCardRefund(pool, data, webhookEventId, logger) {
  // NEW DIME WEBHOOK FORMAT
  const transactionId = data.transaction_number || data.transaction_id || data.transactionNumber;
  const amount = parseFloat(data.amount) || 0;
  const originalTransactionId = data.parent_transaction_info_id || data.original_transaction_id;

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
  // NEW DIME WEBHOOK FORMAT
  const transactionId = data.transaction_number || data.transaction_id || data.transactionNumber;

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
  // NEW DIME WEBHOOK FORMAT
  const transactionId = data.transaction_number || data.transaction_id || data.transactionNumber;
  const amount = parseFloat(data.amount) || 0;
  const reason = data.status_text || data.chargeback_reason || data.reason || 'Unknown';

  logger.error(`Credit Card Chargeback: Transaction ${transactionId}, Amount: $${amount}, Reason: ${reason}`);

  // Find original payment (including pricing fields)
  const originalPayment = await pool.request()
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .query(`
      SELECT PaymentId, GroupId, TenantId, AgentId, NetRate, Commission, OverrideRate, SystemFees
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
  const chargebackAgentId = originalPaymentData.AgentId || null;
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
    }, logger, groupId, tenantId, false, null, chargebackAgentId);
  } catch (emailError) {
    logger.error('Failed to send chargeback notification:', emailError);
  }
}

/**
 * Group invoice ACH (local test): same pricing + product JSON as POST .../invoices/:id/charge (groupBilling.js).
 * Payload may include invoice_id + amount matching a real invoice TotalAmount.
 */
async function handleACHChargeWithInvoice(pool, data, webhookEventId, logger, transactionId, amount, invoiceIdRaw) {
  const mapped = oePaymentStatus.mapDimePayloadToPaymentRecordStatus(data);
  const status = oePaymentStatus.mapChargeWebhookMappedStatusToDbStatus(mapped);
  const paymentMethod = data.transaction_type || data.payment_method || data.paymentMethod || 'ACH';

  const invResult = await pool.request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceIdRaw)
    .query(`
      SELECT TOP 1
        i.InvoiceId,
        i.GroupId,
        i.LocationId,
        i.TotalAmount,
        i.BillingPeriodStart,
        i.BillingPeriodEnd,
        g.TenantId,
        g.AgentId
      FROM oe.Invoices i
      INNER JOIN oe.Groups g ON g.GroupId = i.GroupId
      WHERE i.InvoiceId = @invoiceId
    `);
  const invoice = invResult.recordset?.[0];
  if (!invoice) {
    logger.error(`ACH invoice test: InvoiceId not found: ${invoiceIdRaw}`);
    throw new Error('invoice_id not found');
  }

  const paymentDateAch = new Date();
  const periodOpts = {};
  if (invoice.BillingPeriodStart && invoice.BillingPeriodEnd) {
    periodOpts.periodStart = invoice.BillingPeriodStart;
    periodOpts.periodEnd = invoice.BillingPeriodEnd;
  }
  const pricing = await getPricingFields(
    pool,
    invoice.GroupId,
    null,
    logger,
    paymentDateAch,
    periodOpts
  );
  const snapAch = await buildProductSnapshotForPayment(
    pool,
    {
      groupId: invoice.GroupId,
      householdId: null,
      paymentDate: paymentDateAch,
      invoiceId: invoice.InvoiceId,
      enrollmentId: null,
      productSnapshotScope: undefined
    },
    logger
  );
  const productCommissionsJSON = snapAch ? snapAch.productCommissionsJSON : null;
  const productVendorAmountsJSON = snapAch ? snapAch.productVendorAmountsJSON : null;
  const productOwnerAmountsJSON = snapAch ? snapAch.productOwnerAmountsJSON : null;

  const enrollmentIdOptional = data.enrollment_id || null;

  logger.info(
    `ACH Charge (invoice): Transaction ${transactionId}, Amount: $${amount}, InvoiceId: ${invoice.InvoiceId}, GroupId: ${invoice.GroupId}`
  );

  const existingOpen = await pool.request()
    .input('invoiceId', sql.UniqueIdentifier, invoice.InvoiceId)
    .input('amount', sql.Decimal(10, 2), amount)
    .query(`
      SELECT TOP 1 PaymentId
      FROM oe.Payments
      WHERE InvoiceId = @invoiceId
        AND TransactionType = N'Payment'
        AND Status IN (N'Pending', N'Failed')
        AND LOWER(ISNULL(Processor, N'')) LIKE N'%dime%'
        AND ABS(Amount - @amount) < 0.01
      ORDER BY ModifiedDate DESC
    `);
  const reusePaymentId = existingOpen.recordset[0]?.PaymentId;

  if (reusePaymentId) {
    await pool.request()
      .input('paymentId', sql.UniqueIdentifier, reusePaymentId)
      .input('processorTransactionId', sql.NVarChar(255), transactionId)
      .input('status', sql.NVarChar(50), status)
      .input('webhookEventId', sql.Int, webhookEventId)
      .input('paymentDate', sql.DateTime2, paymentDateAch)
      .input('systemFees', sql.Decimal(10, 2), pricing.systemFees || 0)
      .input('processingFeeAmount', sql.Decimal(10, 2), pricing.processingFeeAmount || 0)
      .input('productCommissions', sql.NVarChar(sql.MAX), productCommissionsJSON)
      .input('productVendorAmounts', sql.NVarChar(sql.MAX), productVendorAmountsJSON)
      .input('productOwnerAmounts', sql.NVarChar(sql.MAX), productOwnerAmountsJSON)
      .input('failureReason', sql.NVarChar(sql.MAX), status === 'Completed' ? null : (data.failure_reason || null))
      .query(`
        UPDATE oe.Payments
        SET ProcessorTransactionId = @processorTransactionId,
            Status = @status,
            WebhookEventId = @webhookEventId,
            PaymentDate = @paymentDate,
            SystemFees = @systemFees,
            ProcessingFeeAmount = @processingFeeAmount,
            ProductCommissions = @productCommissions,
            ProductVendorAmounts = @productVendorAmounts,
            ProductOwnerAmounts = @productOwnerAmounts,
            FailureReason = @failureReason,
            ModifiedDate = GETUTCDATE()
        WHERE PaymentId = @paymentId
      `);
    logger.success(`ACH charge (invoice) updated existing open payment ${reusePaymentId}: ${transactionId}`);
    if (status === 'Failed') {
      try {
        await sendPaymentFailureNotification(
          pool,
          {
            enrollment_id: enrollmentIdOptional,
            amount,
            payment_method: paymentMethod,
            transaction_id: transactionId,
            failure_reason: data.failure_reason
          },
          logger,
          invoice.GroupId,
          invoice.TenantId,
          false,
          invoice.LocationId || null,
          invoice.AgentId || null
        );
      } catch (emailError) {
        logger.error('Failed to send payment failure notification (ACH invoice, update):', emailError);
      }
    }
    return;
  }

  await pool.request()
    .input('transactionType', sql.NVarChar(50), 'Payment')
    .input('amount', sql.Decimal(10, 2), amount)
    .input('status', sql.NVarChar(50), status)
    .input('processor', sql.NVarChar(50), 'DIME')
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .input('paymentMethod', sql.NVarChar(50), paymentMethod)
    .input('webhookEventId', sql.Int, webhookEventId)
    .input('paymentDate', sql.DateTime2, paymentDateAch)
    .input('enrollmentId', sql.UniqueIdentifier, enrollmentIdOptional)
    .input('agentId', sql.UniqueIdentifier, invoice.AgentId || null)
    .input('householdId', sql.UniqueIdentifier, null)
    .input('groupId', sql.UniqueIdentifier, invoice.GroupId)
    .input('tenantId', sql.UniqueIdentifier, invoice.TenantId)
    .input('locationId', sql.UniqueIdentifier, invoice.LocationId || null)
    .input('invoiceId', sql.UniqueIdentifier, invoice.InvoiceId)
    .input('netRate', sql.Decimal(10, 2), pricing.netRate || 0)
    .input('commission', sql.Decimal(10, 2), pricing.commission || 0)
    .input('overrideRate', sql.Decimal(10, 2), pricing.overrideRate || 0)
    .input('systemFees', sql.Decimal(10, 2), pricing.systemFees || 0)
    .input('processingFeeAmount', sql.Decimal(10, 2), pricing.processingFeeAmount || 0)
    .input('productCommissions', sql.NVarChar(sql.MAX), productCommissionsJSON)
    .input('productVendorAmounts', sql.NVarChar(sql.MAX), productVendorAmountsJSON)
    .input('productOwnerAmounts', sql.NVarChar(sql.MAX), productOwnerAmountsJSON)
    .query(`
      INSERT INTO oe.Payments (
        PaymentId, EnrollmentId, AgentId, HouseholdId, TransactionType, Amount, Status, Processor,
        ProcessorTransactionId, PaymentMethod, WebhookEventId, PaymentDate, GroupId, TenantId,
        LocationId, InvoiceId,
        NetRate, Commission, OverrideRate, SystemFees, ProcessingFeeAmount,
        ProductCommissions, ProductVendorAmounts, ProductOwnerAmounts,
        CreatedDate, ModifiedDate
      ) VALUES (
        NEWID(), @enrollmentId, @agentId, @householdId, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @webhookEventId, @paymentDate, @groupId, @tenantId,
        @locationId, @invoiceId,
        @netRate, @commission, @overrideRate, @systemFees, @processingFeeAmount,
        @productCommissions, @productVendorAmounts, @productOwnerAmounts,
        GETUTCDATE(), GETUTCDATE()
      )
    `);

  logger.success(`ACH charge processed (invoice): ${transactionId}`);
  if (status === 'Failed') {
    try {
      await sendPaymentFailureNotification(
        pool,
        {
          enrollment_id: enrollmentIdOptional,
          amount,
          payment_method: paymentMethod,
          transaction_id: transactionId,
          failure_reason: data.failure_reason
        },
        logger,
        invoice.GroupId,
        invoice.TenantId,
        false,
        invoice.LocationId || null,
        invoice.AgentId || null
      );
    } catch (emailError) {
      logger.error('Failed to send payment failure notification (ACH invoice, insert):', emailError);
    }
  }
}

async function handleACHCharge(pool, data, webhookEventId, logger) {
  // NEW DIME WEBHOOK FORMAT
  const transactionId = data.transaction_number || data.transaction_id || data.transactionNumber;
  const amount = parseFloat(data.amount) || 0;
  const mapped = oePaymentStatus.mapDimePayloadToPaymentRecordStatus(data);
  const status = oePaymentStatus.mapChargeWebhookMappedStatusToDbStatus(mapped);
  const paymentMethod = data.transaction_type || data.payment_method || data.paymentMethod || 'ACH';

  const rawInvoiceId = data.invoice_id || data.invoiceId || null;
  if (rawInvoiceId) {
    return handleACHChargeWithInvoice(pool, data, webhookEventId, logger, transactionId, amount, rawInvoiceId);
  }

  logger.info(`ACH Charge: Transaction ${transactionId}, Amount: $${amount}, Status: ${status}, Method: ${paymentMethod}`);

  // Get GroupId, TenantId, AgentId, HouseholdId and pricing fields from enrollment context
  const contextFromEnrollment = await getEnrollmentContext(pool, data.enrollment_id, logger);
  const groupId = contextFromEnrollment.groupId || null;
  const tenantId = contextFromEnrollment.tenantId || null;
  const agentId = contextFromEnrollment.agentId || null;
  const householdId = contextFromEnrollment.householdId || null;
  const netRate = contextFromEnrollment.netRate || 0;
  const commission = contextFromEnrollment.commission || 0;
  const overrideRate = contextFromEnrollment.overrideRate || 0;

  // Same as credit_card_charge: enrollment / initial charge often creates oe.Payments first (Pending); settlement webhook must UPDATE.
  const existingAchResult = await pool.request()
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .query(`
      SELECT PaymentId, GroupId, HouseholdId, InvoiceId, PaymentDate, EnrollmentId, RecurringScheduleId, SystemFees, ProcessingFeeAmount
      FROM oe.Payments
      WHERE ProcessorTransactionId = @processorTransactionId AND TransactionType = 'Payment'
    `);
  const existingAchPayment = existingAchResult.recordset[0];

  if (existingAchPayment) {
    const existingGroupId = existingAchPayment.GroupId || groupId;
    const existingHouseholdId = existingAchPayment.HouseholdId || householdId;
    const paymentDateForJson = existingAchPayment.PaymentDate || new Date();
    const existingEnrId = existingAchPayment.EnrollmentId || data.enrollment_id || null;
    const snapExistingAch = await buildProductSnapshotForPayment(
      pool,
      {
        householdId: existingHouseholdId,
        groupId: existingGroupId,
        paymentDate: paymentDateForJson,
        invoiceId: existingAchPayment.InvoiceId || null,
        enrollmentId: existingEnrId || null,
        productSnapshotScope:
          !existingAchPayment.InvoiceId && existingEnrId && !existingAchPayment.RecurringScheduleId
            ? 'enrollment'
            : undefined
      },
      logger
    );
    const pcJson = snapExistingAch ? snapExistingAch.productCommissionsJSON : null;
    const pvJson = snapExistingAch ? snapExistingAch.productVendorAmountsJSON : null;
    const poJson = snapExistingAch ? snapExistingAch.productOwnerAmountsJSON : null;
    let updatedSystemFees = existingAchPayment.SystemFees || 0;
    let updatedProcessingFeeAmount = existingAchPayment.ProcessingFeeAmount || 0;
    try {
      if (existingHouseholdId) {
        const asOf = householdAsOfDate(paymentDateForJson) || paymentDateForJson;
        const feeBuckets = await getHouseholdFeeBucketsAsOf(pool, existingHouseholdId, asOf, sql);
        updatedSystemFees = feeBuckets.systemFees;
        updatedProcessingFeeAmount = feeBuckets.processingFeeAmount;
      }
    } catch (feeErr) {
      logger.warn(`Household fee buckets for ACH update: ${feeErr.message}`);
    }

    await pool.request()
      .input('paymentId', sql.UniqueIdentifier, existingAchPayment.PaymentId)
      .input('processorTransactionId', sql.NVarChar(255), transactionId)
      .input('status', sql.NVarChar(50), status)
      .input('webhookEventId', sql.Int, webhookEventId)
      .input('systemFees', sql.Decimal(10,2), updatedSystemFees)
      .input('processingFeeAmount', sql.Decimal(10,2), updatedProcessingFeeAmount)
      .input('productCommissions', sql.NVarChar(sql.MAX), pcJson)
      .input('productVendorAmounts', sql.NVarChar(sql.MAX), pvJson)
      .input('productOwnerAmounts', sql.NVarChar(sql.MAX), poJson)
      .input('failureReason', sql.NVarChar(sql.MAX), status === 'Completed' ? null : (data.failure_reason || null))
      .query(`
        UPDATE oe.Payments
        SET ProcessorTransactionId = @processorTransactionId,
            Status = @status, WebhookEventId = @webhookEventId,
            SystemFees = @systemFees, ProcessingFeeAmount = @processingFeeAmount,
            ProductCommissions = @productCommissions, ProductVendorAmounts = @productVendorAmounts, ProductOwnerAmounts = @productOwnerAmounts,
            FailureReason = @failureReason, ModifiedDate = GETUTCDATE()
        WHERE PaymentId = @paymentId
      `);

    if (status === 'Completed' && existingAchPayment.InvoiceId) {
      try {
        await pool.request()
          .input('invoiceId', sql.UniqueIdentifier, existingAchPayment.InvoiceId)
          .input('amount', sql.Decimal(12, 2), amount)
          .query(`
            UPDATE oe.Invoices
            SET Status = 'Paid', PaidAmount = @amount, PaymentReceivedDate = GETUTCDATE(), ModifiedDate = GETUTCDATE()
            WHERE InvoiceId = @invoiceId
          `);
        logger.info(`  Invoice ${existingAchPayment.InvoiceId} marked as Paid`);
      } catch (invoiceError) {
        logger.warn(`  Failed to update invoice status: ${invoiceError.message}`);
      }
    }
    logger.success(`ACH charge webhook applied to existing payment: ${transactionId}`);
    if (status === 'Failed') {
      try {
        await sendPaymentFailureNotification(pool, {
          enrollment_id: data.enrollment_id,
          amount: amount,
          payment_method: paymentMethod,
          transaction_id: transactionId,
          failure_reason: data.failure_reason
        }, logger, existingGroupId, tenantId, false, null, agentId);
      } catch (emailError) {
        logger.error('Failed to send payment failure notification:', emailError);
      }
    }
    return;
  }

  const paymentDateAch = new Date();
  // Product row scalars (single enrollment); fee rows are separate enrollments — align with PaymentAuditService / getPricingFields.
  let systemFees = contextFromEnrollment.systemFees || 0;
  let processingFeeAmount = 0;
  try {
    if (householdId) {
      const asOf = householdAsOfDate(paymentDateAch) || paymentDateAch;
      const feeBuckets = await getHouseholdFeeBucketsAsOf(pool, householdId, asOf, sql);
      systemFees = feeBuckets.systemFees;
      processingFeeAmount = feeBuckets.processingFeeAmount;
    }
  } catch (feeErr) {
    logger.warn(`Household fee buckets for ACH insert: ${feeErr.message}`);
  }

  const snapAch = await buildProductSnapshotForPayment(
    pool,
    {
      householdId,
      groupId,
      paymentDate: paymentDateAch,
      invoiceId: null,
      enrollmentId: data.enrollment_id || null,
      productSnapshotScope: data.enrollment_id && householdId ? 'enrollment' : undefined
    },
    logger
  );
  const productCommissionsJSON = snapAch ? snapAch.productCommissionsJSON : null;
  const productVendorAmountsJSON = snapAch ? snapAch.productVendorAmountsJSON : null;
  const productOwnerAmountsJSON = snapAch ? snapAch.productOwnerAmountsJSON : null;

  // Insert payment record
  await pool.request()
    .input('transactionType', sql.NVarChar(50), 'Payment')
      .input('amount', sql.Decimal(10,2), amount)
    .input('status', sql.NVarChar(50), status)
    .input('processor', sql.NVarChar(50), 'DIME')
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .input('paymentMethod', sql.NVarChar(50), paymentMethod)
    .input('webhookEventId', sql.Int, webhookEventId)
    .input('paymentDate', sql.DateTime2, paymentDateAch)
    .input('enrollmentId', sql.UniqueIdentifier, data.enrollment_id || null)
    .input('agentId', sql.UniqueIdentifier, agentId)
    .input('householdId', sql.UniqueIdentifier, householdId)
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('netRate', sql.Decimal(10,2), netRate)
    .input('commission', sql.Decimal(10,2), commission)
    .input('overrideRate', sql.Decimal(10,2), overrideRate)
    .input('systemFees', sql.Decimal(10,2), systemFees)
    .input('processingFeeAmount', sql.Decimal(10,2), processingFeeAmount)
    .input('productCommissions', sql.NVarChar(sql.MAX), productCommissionsJSON)
    .input('productVendorAmounts', sql.NVarChar(sql.MAX), productVendorAmountsJSON)
    .input('productOwnerAmounts', sql.NVarChar(sql.MAX), productOwnerAmountsJSON)
    .query(`
      INSERT INTO oe.Payments (
        PaymentId, EnrollmentId, AgentId, HouseholdId, TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, WebhookEventId, PaymentDate, GroupId, TenantId,
        NetRate, Commission, OverrideRate, SystemFees, ProcessingFeeAmount, ProductCommissions,
        ProductVendorAmounts, ProductOwnerAmounts,
        CreatedDate, ModifiedDate
      ) VALUES (
        NEWID(), @enrollmentId, @agentId, @householdId, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @webhookEventId, @paymentDate, @groupId, @tenantId,
        @netRate, @commission, @overrideRate, @systemFees, @processingFeeAmount, @productCommissions,
        @productVendorAmounts, @productOwnerAmounts,
        GETUTCDATE(), GETUTCDATE()
      )
    `);

  logger.success(`ACH charge processed: ${transactionId}`);

  if (status !== 'Failed' && householdId && !groupId) {
    bestEffortResolveInvoice(logger, { paymentId: null, householdId, tenantId, paymentDate: new Date(), paymentAmount: amount });
  }

  // Send email notification if payment failed
  if (status === 'Failed') {
    try {
      await sendPaymentFailureNotification(pool, {
        enrollment_id: data.enrollment_id,
        amount: amount,
        payment_method: paymentMethod,
        transaction_id: transactionId,
        failure_reason: data.failure_reason
      }, logger, groupId, tenantId, false, null, agentId);
    } catch (emailError) {
      logger.error('Failed to send payment failure notification:', emailError);
    }
  }
}

async function handleACHPaymentReturn(pool, data, webhookEventId, logger) {
  // NEW DIME WEBHOOK FORMAT
  const transactionId = data.transaction_number || data.transaction_id || data.transactionNumber;
  const amount = parseFloat(data.amount) || 0;
  const returnCode = data.status_code || data.return_code || data.code;
  const returnReason = data.status_text || data.return_reason || data.reason || 'Unknown';
  const paymentMethod = data.transaction_type || data.payment_method || data.paymentMethod || 'ACH';

  logger.error(`ACH Payment Return: Transaction ${transactionId}, Amount: $${amount}, Code: ${returnCode}, Method: ${paymentMethod}`);

  // Find original payment (including pricing fields)
  const originalPayment = await pool.request()
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .query(`
      SELECT PaymentId, GroupId, TenantId, AgentId, NetRate, Commission, OverrideRate, SystemFees
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
  const achReturnAgentId = originalPaymentData.AgentId || null;
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
  // NEW DIME WEBHOOK FORMAT
  const transactionId = data.transaction_number || data.transaction_id || data.transactionNumber;
  const amount = parseFloat(data.amount) || 0;
  const originalTransactionId = data.parent_transaction_info_id || data.original_transaction_id;

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
  // NEW DIME WEBHOOK FORMAT
  const depositId = data.transaction_number || data.deposit_id || data.transaction_id;
  const amount = parseFloat(data.amount) || 0;
  const depositDate = data.settle_date || data.fund_date || data.deposit_date || data.transaction_date || new Date();

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
  // NEW DIME WEBHOOK FORMAT:
  // - transaction_number instead of transaction_id
  // - amount is a string, needs parsing
  // - status_code and status_text instead of status
  // - transaction_type instead of payment_method
  // - customer_uuid at root level
  // - schedule_id may not be present, need to look up by customer_uuid
  
  const transactionId = data.transaction_number || data.transaction_id || data.transactionNumber;
  const amount = parseFloat(data.amount) || 0;
  const transactionType = data.transaction_type || data.payment_method || 'Recurring';
  const customerUuid = data.customer_uuid;
  
  // Try to find schedule_id - may not be in webhook, will need to look up by customer_uuid
  let scheduleId = data.schedule_id ?? data.recurring_payment_id;
  if (scheduleId != null && scheduleId !== '') {
    scheduleId = String(scheduleId).trim();
  } else {
    scheduleId = null;
  }

  // If no schedule_id, try to find it by customer_uuid and transaction_number
  if (!scheduleId && customerUuid) {
    try {
      const scheduleResult = await pool.request()
        .input('customerUuid', sql.NVarChar(255), customerUuid)
        .input('transactionNumber', sql.NVarChar(255), transactionId)
        .query(`
          SELECT TOP 1 grp.DimeScheduleId
          FROM oe.GroupRecurringPaymentPlans grp
          INNER JOIN oe.Groups g ON grp.GroupId = g.GroupId
          WHERE g.ProcessorCustomerId = @customerUuid
            AND grp.IsActive = 1
          ORDER BY grp.CreatedDate DESC
        `);
      
      if (scheduleResult.recordset.length > 0) {
        scheduleId = String(scheduleResult.recordset[0].DimeScheduleId).trim();
        logger.info(`Found schedule_id ${scheduleId} for customer ${customerUuid}`);
      }
    } catch (error) {
      logger.warn(`Could not find schedule_id for customer ${customerUuid}: ${error.message}`);
    }
  }

  // Individual households: DIME often omits schedule_id — resolve from IndividualRecurringSchedules or oe.Payments + MemberPaymentMethods
  if (!scheduleId && customerUuid) {
    try {
      const indSched = await pool.request()
        .input('customerUuid', sql.NVarChar(255), customerUuid)
        .query(`
          SELECT TOP 1 irs.DimeScheduleId
          FROM oe.IndividualRecurringSchedules irs
          INNER JOIN oe.Members m ON m.HouseholdId = irs.HouseholdId AND m.RelationshipType = N'P'
          INNER JOIN oe.MemberPaymentMethods mpm ON mpm.MemberId = m.MemberId
            AND mpm.ProcessorCustomerId = @customerUuid
            AND mpm.Status = N'Active'
          WHERE irs.IsActive = 1
          ORDER BY irs.ModifiedDate DESC, irs.CreatedDate DESC
        `);
      if (indSched.recordset.length > 0) {
        scheduleId = String(indSched.recordset[0].DimeScheduleId).trim();
        logger.info(`Resolved individual schedule_id ${scheduleId} from IndividualRecurringSchedules for customer ${customerUuid}`);
      }
    } catch (err) {
      const msg = String(err.message || '');
      if (!msg.includes('Invalid object name') && !msg.includes('IndividualRecurringSchedules')) {
        logger.warn(`IndividualRecurringSchedules schedule lookup: ${msg}`);
      }
    }
  }
  if (!scheduleId && customerUuid) {
    try {
      const paySched = await pool.request()
        .input('customerUuid', sql.NVarChar(255), customerUuid)
        .query(`
          SELECT TOP 1 p.RecurringScheduleId
          FROM oe.Payments p
          INNER JOIN oe.Members m ON m.HouseholdId = p.HouseholdId AND m.RelationshipType = N'P'
          INNER JOIN oe.MemberPaymentMethods mpm ON mpm.MemberId = m.MemberId
            AND mpm.ProcessorCustomerId = @customerUuid
            AND mpm.Status = N'Active'
          WHERE p.RecurringScheduleId IS NOT NULL AND LTRIM(RTRIM(CAST(p.RecurringScheduleId AS NVARCHAR(255)))) <> N''
          ORDER BY p.ModifiedDate DESC, p.PaymentDate DESC
        `);
      if (paySched.recordset.length > 0) {
        scheduleId = String(paySched.recordset[0].RecurringScheduleId).trim();
        logger.info(`Resolved schedule_id ${scheduleId} from oe.Payments for customer ${customerUuid}`);
      }
    } catch (err) {
      logger.warn(`oe.Payments schedule lookup: ${err.message}`);
    }
  }

  if (!scheduleId) {
    throw new Error(
      'recurring_payment_success: missing schedule_id / recurring_payment_id and could not resolve DimeScheduleId from customer_uuid'
    );
  }

  logger.info(`Recurring Payment Success: Schedule ${scheduleId}, Transaction ${transactionId}, Amount: $${amount}`);

  if (oePaymentStatus.shouldTreatRecurringSuccessWebhookAsDeclined(data)) {
    logger.warn('recurring_payment_success payload includes non-approved status fields; recording as failure instead of completed');
    await handleRecurringPaymentFailed(pool, data, webhookEventId, logger);
    return;
  }

  // First, try to find if this is a GROUP recurring payment (with invoice linkage)
  const groupResult = await pool.request()
    .input('scheduleId', sql.NVarChar(255), scheduleId)
    .query(`
      SELECT 
        g.GroupId, 
        g.TenantId,
        grp.LocationId,
        grp.InvoiceId
      FROM oe.GroupRecurringPaymentPlans grp
      INNER JOIN oe.Groups g ON grp.GroupId = g.GroupId
      WHERE grp.DimeScheduleId = @scheduleId
    `);

  let groupId = null;
  let tenantId = null;
  let locationId = null;
  let invoiceId = null;
  let enrollmentId = null;
  let agentId = null;
  let householdId = null;
  let isIndividualRecurring = false;

  if (groupResult.recordset.length > 0) {
    // GROUP recurring payment
    const groupData = groupResult.recordset[0];
    groupId = groupData.GroupId;
    tenantId = groupData.TenantId;
    locationId = groupData.LocationId || null;
    invoiceId = groupData.InvoiceId || null;
    
    // Get AgentId from the most recent active enrollment for this group
    // For group payments, we only need AgentId - EnrollmentId and HouseholdId should be NULL
    // This ensures we get a valid AgentId even if enrollments span multiple agents
    try {
      const enrollmentResult = await pool.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .query(`
          SELECT TOP 1 
            e.AgentId
          FROM oe.Enrollments e
          INNER JOIN oe.Members m ON e.MemberId = m.MemberId
          WHERE m.GroupId = @groupId
            AND e.Status = 'Active'
            AND e.AgentId IS NOT NULL
          ORDER BY e.EffectiveDate DESC, e.CreatedDate DESC
        `);
      
      if (enrollmentResult.recordset.length > 0) {
        agentId = enrollmentResult.recordset[0].AgentId;
        // For group payments, EnrollmentId and HouseholdId should remain NULL
        enrollmentId = null;
        householdId = null;
        logger.info(`Found AgentId ${agentId} from enrollment for group ${groupId}`);
      } else {
        logger.warn(`No active enrollment with AgentId found for group ${groupId}`);
      }
    } catch (error) {
      logger.warn(`Could not get AgentId for group ${groupId}: ${error.message}`);
    }
    
    logger.info(`Found GROUP recurring payment for GroupId: ${groupId}, LocationId: ${locationId}, InvoiceId: ${invoiceId}, AgentId: ${agentId}`);
  } else {
    // Not a group payment - check if it's an INDIVIDUAL recurring payment
    // Look for existing payment record with this RecurringScheduleId
    const individualResult = await pool.request()
      .input('scheduleId', sql.NVarChar(255), scheduleId)
      .query(`
        SELECT TOP 1 
          p.HouseholdId,
          p.EnrollmentId,
          p.GroupId,
          p.TenantId,
          p.AgentId
        FROM oe.Payments p
        WHERE p.RecurringScheduleId = @scheduleId
        ORDER BY p.CreatedDate DESC
      `);

    if (individualResult.recordset.length === 0) {
      throw new Error(`No group or individual payment found for recurring schedule: ${scheduleId}`);
    }

    const individualData = individualResult.recordset[0];
    householdId = individualData.HouseholdId;
    enrollmentId = individualData.EnrollmentId;
    groupId = individualData.GroupId;
    tenantId = individualData.TenantId;
    agentId = individualData.AgentId;
    isIndividualRecurring = true;
    logger.info(`Found INDIVIDUAL recurring payment for HouseholdId: ${householdId}`);
  }

  // Single source of truth: create oe.Payments row (same function used by DimePaymentSync)
  const nextBillingDate = new Date();
  nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);
  nextBillingDate.setDate(1); // Set to 1st of next month
  logger.info(`Calculated next billing date: ${nextBillingDate.toISOString().split('T')[0]}`);

  await createRecurringPaymentRecord(pool, {
    groupId, tenantId, householdId, enrollmentId, agentId, locationId, invoiceId,
    scheduleId, amount, processorTransactionId: transactionId, paymentDate: new Date(),
    paymentStatus: 'Completed', paymentMethod: 'Recurring',
    nextBillingDate, webhookEventId
  }, logger);

  logger.success(`Recurring payment success processed for ${isIndividualRecurring ? 'household' : 'group'}: ${isIndividualRecurring ? householdId : groupId}, next billing: ${nextBillingDate.toISOString().split('T')[0]}`);
  
  // Update invoice status to Paid (for group payments with invoices)
  if (invoiceId) {
    try {
      await pool.request()
        .input('invoiceId', sql.UniqueIdentifier, invoiceId)
        .input('amount', sql.Decimal(12,2), amount)
        .query(`
          UPDATE oe.Invoices
          SET Status = 'Paid',
              PaidAmount = @amount,
              PaymentReceivedDate = GETUTCDATE(),
              ModifiedDate = GETUTCDATE()
          WHERE InvoiceId = @invoiceId
        `);
      logger.success(`  Invoice ${invoiceId} marked as Paid`);
    } catch (invoiceError) {
      logger.error(`  Failed to update invoice status: ${invoiceError.message}`);
    }
  }
  
  // Mark setup fees as paid in SetupFee enrollment records
  try {
    if (isIndividualRecurring && householdId) {
      // Individual recurring payment - mark SetupFee enrollment records as paid
      const setupFeeResult = await pool.request()
        .input('householdId', sql.UniqueIdentifier, householdId)
        .query(`
          UPDATE oe.Enrollments
          SET Status = 'Paid',
              ModifiedDate = GETUTCDATE()
          WHERE HouseholdId = @householdId
            AND EnrollmentType = 'SetupFee'
            AND Status = 'Active'
        `);
      logger.info(`  Marked setup fees as paid for ${setupFeeResult.rowsAffected[0]} SetupFee enrollment(s) in household ${householdId}`);
    } else if (groupId) {
      // Group recurring payment - mark SetupFee enrollment records as paid for all group enrollments
      const setupFeeResult = await pool.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .query(`
          UPDATE oe.Enrollments
          SET Status = 'Paid',
              ModifiedDate = GETUTCDATE()
          WHERE GroupId = @groupId
            AND EnrollmentType = 'SetupFee'
            AND Status = 'Active'
        `);
      logger.info(`  Marked setup fees as paid for ${setupFeeResult.rowsAffected[0]} SetupFee enrollment(s) in group ${groupId}`);
    }
  } catch (setupFeeError) {
    logger.error(`  Failed to mark setup fees as paid: ${setupFeeError.message}`);
  }
}

async function handleRecurringPaymentFailed(pool, data, webhookEventId, logger) {
  // NEW DIME WEBHOOK FORMAT - same field mapping as success handler
  const transactionId = data.transaction_number || data.transaction_id || data.transactionNumber;
  const amount = parseFloat(data.amount) || 0;
  const customerUuid = data.customer_uuid;
  const statusText = data.status_text;
  const failureReason = data.status_text || data.failure_reason || data.status_code || 'Unknown';
  
  // Try to find schedule_id (DIME JSON may send numeric schedule_id; Tedious NVarChar requires a string)
  let scheduleId = data.schedule_id ?? data.recurring_payment_id;
  if (scheduleId != null && scheduleId !== '') {
    scheduleId = String(scheduleId).trim();
  } else {
    scheduleId = null;
  }

  // If no schedule_id, try to find it by customer_uuid
  if (!scheduleId && customerUuid) {
    try {
      const scheduleResult = await pool.request()
        .input('customerUuid', sql.NVarChar(255), customerUuid)
        .query(`
          SELECT TOP 1 grp.DimeScheduleId
          FROM oe.GroupRecurringPaymentPlans grp
          INNER JOIN oe.Groups g ON grp.GroupId = g.GroupId
          WHERE g.ProcessorCustomerId = @customerUuid
            AND grp.IsActive = 1
          ORDER BY grp.CreatedDate DESC
        `);
      
      if (scheduleResult.recordset.length > 0) {
        scheduleId = String(scheduleResult.recordset[0].DimeScheduleId).trim();
        logger.info(`Found schedule_id ${scheduleId} for customer ${customerUuid}`);
      }
    } catch (error) {
      logger.warn(`Could not find schedule_id for customer ${customerUuid}: ${error.message}`);
    }
  }

  logger.error(`Recurring Payment Failed: Schedule ${scheduleId}, Transaction ${transactionId}, Amount: $${amount}, Reason: ${failureReason}`);

  // First, try to find if this is a GROUP recurring payment (with invoice linkage)
  const groupResult = await pool.request()
    .input('scheduleId', sql.NVarChar(255), scheduleId)
    .query(`
      SELECT 
        g.GroupId, 
        g.TenantId,
        grp.LocationId,
        grp.InvoiceId
      FROM oe.GroupRecurringPaymentPlans grp
      INNER JOIN oe.Groups g ON grp.GroupId = g.GroupId
      WHERE grp.DimeScheduleId = @scheduleId
    `);

  let groupId = null;
  let tenantId = null;
  let locationId = null;
  let invoiceId = null;
  let enrollmentId = null;
  let householdId = null;
  let agentId = null;
  let isIndividualRecurring = false;

  if (groupResult.recordset.length > 0) {
    // GROUP recurring payment
    const groupData = groupResult.recordset[0];
    groupId = groupData.GroupId;
    tenantId = groupData.TenantId;
    locationId = groupData.LocationId || null;
    invoiceId = groupData.InvoiceId || null;
    
    // Get AgentId from the most recent active enrollment for this group
    // For group payments, we only need AgentId - EnrollmentId and HouseholdId should be NULL
    try {
      const enrollmentResult = await pool.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .query(`
          SELECT TOP 1 
            e.AgentId
          FROM oe.Enrollments e
          INNER JOIN oe.Members m ON e.MemberId = m.MemberId
          WHERE m.GroupId = @groupId
            AND e.Status = 'Active'
            AND e.AgentId IS NOT NULL
          ORDER BY e.EffectiveDate DESC, e.CreatedDate DESC
        `);
      
      if (enrollmentResult.recordset.length > 0) {
        agentId = enrollmentResult.recordset[0].AgentId;
        // For group payments, EnrollmentId and HouseholdId should remain NULL
        enrollmentId = null;
        householdId = null;
        logger.info(`Found AgentId ${agentId} from enrollment for group ${groupId}`);
      } else {
        logger.warn(`No active enrollment with AgentId found for group ${groupId}`);
      }
    } catch (error) {
      logger.warn(`Could not get AgentId for group ${groupId}: ${error.message}`);
    }
    
    logger.info(`Found GROUP recurring payment failure for GroupId: ${groupId}, LocationId: ${locationId}, InvoiceId: ${invoiceId}, AgentId: ${agentId}`);
  } else {
    // Not a group payment - check if it's an INDIVIDUAL recurring payment
    const individualResult = await pool.request()
      .input('scheduleId', sql.NVarChar(255), scheduleId)
      .query(`
        SELECT TOP 1 
          p.HouseholdId,
          p.EnrollmentId,
          p.GroupId,
          p.TenantId,
          p.AgentId
        FROM oe.Payments p
        WHERE p.RecurringScheduleId = @scheduleId
        ORDER BY p.CreatedDate DESC
      `);

    if (individualResult.recordset.length === 0) {
      throw new Error(`No group or individual payment found for recurring schedule: ${scheduleId}`);
    }

    const individualData = individualResult.recordset[0];
    householdId = individualData.HouseholdId;
    enrollmentId = individualData.EnrollmentId;
    groupId = individualData.GroupId;
    tenantId = individualData.TenantId;
    agentId = individualData.AgentId;
    isIndividualRecurring = true;
    logger.info(`Found INDIVIDUAL recurring payment failure for HouseholdId: ${householdId}`);
  }

  // Single source of truth: create failed oe.Payments row (same as DimePaymentSync failed-from-list)
  const nextRetryDate = new Date();
  nextRetryDate.setDate(nextRetryDate.getDate() + 7);
  logger.info(`Next retry date set to: ${nextRetryDate.toISOString().split('T')[0]}`);

  await createFailedRecurringPaymentRecord(pool, {
    groupId, tenantId, householdId, enrollmentId, agentId, locationId, invoiceId,
    scheduleId, amount, processorTransactionId: transactionId, paymentDate: new Date(),
    failureReason, retryDate: nextRetryDate, webhookEventId
  }, logger);

  logger.error(`Recurring payment failure processed for ${isIndividualRecurring ? 'household' : 'group'}: ${isIndividualRecurring ? householdId : groupId}, retry scheduled for: ${nextRetryDate.toISOString().split('T')[0]}`);
  
  // Update invoice status to Unpaid (for group payments with invoices)
  if (invoiceId) {
    try {
      await pool.request()
        .input('invoiceId', sql.UniqueIdentifier, invoiceId)
        .query(`
          UPDATE oe.Invoices
          SET Status = 'Unpaid',
              ModifiedDate = GETUTCDATE()
          WHERE InvoiceId = @invoiceId
        `);
      logger.error(`  Invoice ${invoiceId} marked as Unpaid`);
    } catch (invoiceError) {
      logger.error(`  Failed to update invoice status: ${invoiceError.message}`);
    }
  }
  
  // Send email notification for payment failure
  try {
    await sendPaymentFailureNotification(pool, {
      enrollment_id: enrollmentId,
      amount: amount,
      payment_method: 'Recurring',
      transaction_id: transactionId,
      failure_reason: failureReason
    }, logger, groupId, tenantId, isIndividualRecurring, locationId, agentId);
  } catch (emailError) {
    logger.error('Failed to send payment failure notification:', emailError);
  }
}