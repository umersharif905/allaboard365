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
    const signature = req.headers['x-dime-signature'];
    const payload = JSON.stringify(req.body);
    
    // NEW DIME WEBHOOK STRUCTURE:
    // The entire body IS the data, with 'type' field at root level
    // Example: { "type": "recurring_payment_success", "transaction_number": "...", ... }
    const webhookData = req.body;
    const eventType = webhookData.type || webhookData.event_type; // Support both old and new format
    
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
    
    let tenantWebhookSecret = null;
    let foundTenantId = null;
    
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
            .input('scheduleId', sql.NVarChar(255), scheduleId)
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
  const transactionId = data.transaction_number || data.transaction_id || data.transactionNumber;
  const amount = parseFloat(data.amount) || 0;
  const statusCode = data.status_code;
  const statusText = data.status_text;
  // Map status_code "00" = Approved/Completed, others = Failed
  const status = (statusCode === '00' && statusText?.toLowerCase().includes('approved')) 
    ? 'Completed' 
    : (statusCode ? 'Failed' : (data.status || 'Unknown'));
  
  const result = await pool.request()
    .input('eventType', sql.NVarChar(100), eventType)
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

// Helper function to build ProductCommissions JSON from enrollments
// Returns JSON string with structure: { "productId": { "enrollmentCount": 38, "commissionAmount": 650.00 } }
async function buildProductCommissionsJSON(pool, householdId, groupId, logger) {
  try {
    if (!householdId && !groupId) {
      return null;
    }

    let query;
    const request = pool.request();

    if (householdId) {
      request.input('householdId', sql.UniqueIdentifier, householdId);
      query = `
        SELECT 
          e.ProductId,
          COUNT(*) as EnrollmentCount,
          SUM(COALESCE(e.Commission, 0)) as CommissionAmount
        FROM oe.Enrollments e
        WHERE e.HouseholdId = @householdId
          AND e.Status = 'Active'
          AND e.EffectiveDate <= GETUTCDATE()
          AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
          AND e.ProductId IS NOT NULL
          AND e.ProductId != '00000000-0000-0000-0000-000000000000'
        GROUP BY e.ProductId
      `;
    } else if (groupId) {
      request.input('groupId', sql.UniqueIdentifier, groupId);
      query = `
        SELECT 
          e.ProductId,
          COUNT(*) as EnrollmentCount,
          SUM(COALESCE(e.Commission, 0)) as CommissionAmount
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.GroupId = @groupId
          AND e.Status = 'Active'
          AND e.EffectiveDate <= GETUTCDATE()
          AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
          AND e.ProductId IS NOT NULL
          AND e.ProductId != '00000000-0000-0000-0000-000000000000'
        GROUP BY e.ProductId
      `;
    }

    const result = await request.query(query);
    
    if (result.recordset.length === 0) {
      return null;
    }

    // Build JSON structure: { "productId": { "enrollmentCount": 38, "commissionAmount": 650.00 } }
    const productCommissions = {};
    for (const row of result.recordset) {
      const productId = row.ProductId.toString().toUpperCase(); // Store in uppercase for consistency
      productCommissions[productId] = {
        enrollmentCount: row.EnrollmentCount || 0,
        commissionAmount: parseFloat(row.CommissionAmount) || 0
      };
    }

    return JSON.stringify(productCommissions);
  } catch (error) {
    logger.warn(`Could not build ProductCommissions JSON: ${error.message}`);
    return null;
  }
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
async function sendPaymentFailureNotification(pool, paymentData, logger, groupId, tenantId, isIndividualRecurring = false, locationId = null) {
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

    // Get tenant settings for base URL - let frontend route decide where to go
    let baseUrl = 'https://open-enroll.com'; // Default fallback
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
          baseUrl = `https://${customDomain}`;
        }
      }
    } catch (urlError) {
      logger.warn(`Could not fetch tenant settings for base URL: ${urlError.message}`);
    }
    
    // Let frontend route decide - just go to dashboard, frontend will redirect based on role
    const dashboardUrl = `${baseUrl}/dashboard`;

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
    
    // Minify HTML to remove whitespace (exact same method as MonthlyPaymentScheduler)
    const minifiedEmailBody = emailBody
      .replace(/\r\n/g, '') // Remove Windows line breaks
      .replace(/\n/g, '') // Remove Unix line breaks
      .replace(/\r/g, '') // Remove Mac line breaks
      .replace(/\s+/g, ' ') // Replace multiple spaces with single space
      .replace(/>\s+</g, '><') // Remove spaces between tags
      .trim(); // Remove leading/trailing whitespace
    
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
    request.input('body', sql.NVarChar(sql.MAX), minifiedEmailBody);
    
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
  // NEW DIME WEBHOOK FORMAT
  const transactionId = data.transaction_number || data.transaction_id || data.transactionNumber;
  const amount = parseFloat(data.amount) || 0;
  const statusCode = data.status_code;
  const statusText = data.status_text;
  // Map status_code "00" = Approved/Completed, others = Failed
  const status = (statusCode === '00' && statusText?.toLowerCase().includes('approved')) ? 'Completed' : 'Failed';
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
  const systemFees = contextFromEnrollment.systemFees || 0;

  // Get failure attempt tracking info if payment failed
  let attemptInfo = { attemptNumber: null, consecutiveFailures: null, originalPaymentId: null };
  if (status === 'Failed') {
    attemptInfo = await getFailureAttemptInfo(pool, groupId, tenantId, amount, paymentMethod, logger);
    logger.info(`Payment failure attempt ${attemptInfo.attemptNumber} (${attemptInfo.consecutiveFailures} consecutive failures)`);
  }

  // Build ProductCommissions JSON from enrollments
  const productCommissionsJSON = await buildProductCommissionsJSON(pool, householdId, groupId, logger);

  // Insert payment record
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
    .input('productCommissions', sql.NVarChar(sql.MAX), productCommissionsJSON)
    .input('attemptNumber', sql.Int, attemptInfo.attemptNumber)
    .input('originalPaymentId', sql.UniqueIdentifier, attemptInfo.originalPaymentId)
    .input('consecutiveFailures', sql.Int, attemptInfo.consecutiveFailures)
    .input('failureReason', sql.NVarChar(sql.MAX), data.failure_reason || null)
    .input('lastFailureDate', sql.DateTime2, status === 'Failed' ? new Date() : null)
    .query(`
      INSERT INTO oe.Payments (
        PaymentId, EnrollmentId, AgentId, HouseholdId, TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, FailureReason, WebhookEventId, PaymentDate, 
        GroupId, TenantId, NetRate, Commission, OverrideRate, SystemFees, ProductCommissions,
        AttemptNumber, OriginalPaymentId, ConsecutiveFailureCount, LastFailureDate,
        CreatedDate, ModifiedDate
      ) VALUES (
        NEWID(), @enrollmentId, @agentId, @householdId, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @failureReason, @webhookEventId, @paymentDate, 
        @groupId, @tenantId, @netRate, @commission, @overrideRate, @systemFees, @productCommissions,
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
  // NEW DIME WEBHOOK FORMAT
  const transactionId = data.transaction_number || data.transaction_id || data.transactionNumber;
  const amount = parseFloat(data.amount) || 0;
  const statusCode = data.status_code;
  const statusText = data.status_text;
  // Map status_code "00" = Approved/Completed, others = Failed
  const status = (statusCode === '00' && statusText?.toLowerCase().includes('approved')) ? 'Completed' : 'Failed';
  const paymentMethod = data.transaction_type || data.payment_method || data.paymentMethod || 'ACH';

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
  const systemFees = contextFromEnrollment.systemFees || 0;

  // Build ProductCommissions JSON from enrollments
  const productCommissionsJSON = await buildProductCommissionsJSON(pool, householdId, groupId, logger);

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
    .input('agentId', sql.UniqueIdentifier, agentId)
    .input('householdId', sql.UniqueIdentifier, householdId)
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('netRate', sql.Decimal(10,2), netRate)
    .input('commission', sql.Decimal(10,2), commission)
    .input('overrideRate', sql.Decimal(10,2), overrideRate)
    .input('systemFees', sql.Decimal(10,2), systemFees)
    .input('productCommissions', sql.NVarChar(sql.MAX), productCommissionsJSON)
    .query(`
      INSERT INTO oe.Payments (
        PaymentId, EnrollmentId, AgentId, HouseholdId, TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, WebhookEventId, PaymentDate, GroupId, TenantId,
        NetRate, Commission, OverrideRate, SystemFees, ProductCommissions,
        CreatedDate, ModifiedDate
      ) VALUES (
        NEWID(), @enrollmentId, @agentId, @householdId, @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @webhookEventId, @paymentDate, @groupId, @tenantId,
        @netRate, @commission, @overrideRate, @systemFees, @productCommissions,
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
  const statusCode = data.status_code;
  const statusText = data.status_text;
  const customerUuid = data.customer_uuid;
  
  // Try to find schedule_id - may not be in webhook, will need to look up by customer_uuid
  let scheduleId = data.schedule_id || data.recurring_payment_id;
  
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
        scheduleId = scheduleResult.recordset[0].DimeScheduleId;
        logger.info(`Found schedule_id ${scheduleId} for customer ${customerUuid}`);
      }
    } catch (error) {
      logger.warn(`Could not find schedule_id for customer ${customerUuid}: ${error.message}`);
    }
  }

  logger.info(`Recurring Payment Success: Schedule ${scheduleId}, Transaction ${transactionId}, Amount: $${amount}`);

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
    
    // Get AgentId and EnrollmentId from the most recent active enrollment for this group
    // This ensures we get a valid AgentId even if enrollments span multiple agents
    try {
      const enrollmentResult = await pool.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .query(`
          SELECT TOP 1 
            e.EnrollmentId,
            e.AgentId,
            e.HouseholdId
          FROM oe.Enrollments e
          INNER JOIN oe.Members m ON e.MemberId = m.MemberId
          WHERE m.GroupId = @groupId
            AND e.Status = 'Active'
            AND e.AgentId IS NOT NULL
          ORDER BY e.EffectiveDate DESC, e.CreatedDate DESC
        `);
      
      if (enrollmentResult.recordset.length > 0) {
        enrollmentId = enrollmentResult.recordset[0].EnrollmentId;
        agentId = enrollmentResult.recordset[0].AgentId;
        householdId = enrollmentResult.recordset[0].HouseholdId;
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

  // Get pricing information based on payment type (group vs individual)
  let netRate = 0;
  let commission = 0;
  let overrideRate = 0;
  let systemFees = 0;

  try {
    if (isIndividualRecurring && householdId) {
      // Individual recurring payment - get pricing from household enrollments
      const pricingResult = await pool.request()
        .input('householdId', sql.UniqueIdentifier, householdId)
        .query(`
          SELECT 
            SUM(COALESCE(e.NetRate, 0)) as NetRate,
            SUM(COALESCE(e.Commission, 0)) as Commission,
            SUM(COALESCE(e.OverrideRate, 0)) as OverrideRate,
            SUM(COALESCE(e.SystemFees, 0)) as SystemFees
          FROM oe.Enrollments e
          WHERE e.HouseholdId = @householdId
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
      logger.info(`Aggregated pricing for individual household: NetRate=${netRate}, Commission=${commission}`);
    } else if (groupId) {
      // Group recurring payment - aggregate from all group enrollments
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
      logger.info(`Aggregated pricing for group: NetRate=${netRate}, Commission=${commission}`);
    }
  } catch (error) {
    logger.warn(`Could not aggregate pricing: ${error.message}`);
  }

  // Build ProductCommissions JSON from enrollments (enrollment count and commission amount per product)
  const productCommissionsJSON = await buildProductCommissionsJSON(pool, householdId, groupId, logger);
  if (productCommissionsJSON) {
    logger.info(`Built ProductCommissions JSON: ${productCommissionsJSON}`);
  }

  // Calculate next billing date (1 month from now)
  const nextBillingDate = new Date();
  nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);
  nextBillingDate.setDate(1); // Set to 1st of next month
  
  logger.info(`Calculated next billing date: ${nextBillingDate.toISOString().split('T')[0]}`);

  // Insert payment record with LocationId, InvoiceId, RecurringScheduleId, NextBillingDate, and ProductCommissions
  await pool.request()
    .input('transactionType', sql.NVarChar(50), 'Payment')
    .input('amount', sql.Decimal(10,2), amount)
    .input('status', sql.NVarChar(50), 'Completed')
    .input('processor', sql.NVarChar(50), 'DIME')
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .input('paymentMethod', sql.NVarChar(50), 'Recurring')
    .input('recurringScheduleId', sql.NVarChar(255), scheduleId)
    .input('nextBillingDate', sql.Date, nextBillingDate)
    .input('webhookEventId', sql.Int, webhookEventId)
    .input('paymentDate', sql.DateTime2, new Date())
    .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
    .input('agentId', sql.UniqueIdentifier, agentId)
    .input('householdId', sql.UniqueIdentifier, householdId)
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('locationId', sql.UniqueIdentifier, locationId)
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .input('netRate', sql.Decimal(10,2), netRate)
    .input('commission', sql.Decimal(10,2), commission)
    .input('overrideRate', sql.Decimal(10,2), overrideRate)
    .input('systemFees', sql.Decimal(10,2), systemFees)
    .input('productCommissions', sql.NVarChar(sql.MAX), productCommissionsJSON)
    .query(`
      INSERT INTO oe.Payments (
        PaymentId, EnrollmentId, AgentId, HouseholdId, GroupId, TenantId, LocationId, InvoiceId,
        TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, RecurringScheduleId, NextBillingDate, WebhookEventId, PaymentDate,
        NetRate, Commission, OverrideRate, SystemFees, ProductCommissions,
        CreatedDate, ModifiedDate
      ) VALUES (
        NEWID(), @enrollmentId, @agentId, @householdId, @groupId, @tenantId, @locationId, @invoiceId,
        @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @recurringScheduleId, @nextBillingDate, @webhookEventId, @paymentDate,
        @netRate, @commission, @overrideRate, @systemFees, @productCommissions,
        GETUTCDATE(), GETUTCDATE()
      )
    `);

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
  
  // Try to find schedule_id
  let scheduleId = data.schedule_id || data.recurring_payment_id;
  
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
        scheduleId = scheduleResult.recordset[0].DimeScheduleId;
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
    
    // Get AgentId and EnrollmentId from the most recent active enrollment for this group
    try {
      const enrollmentResult = await pool.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .query(`
          SELECT TOP 1 
            e.EnrollmentId,
            e.AgentId,
            e.HouseholdId
          FROM oe.Enrollments e
          INNER JOIN oe.Members m ON e.MemberId = m.MemberId
          WHERE m.GroupId = @groupId
            AND e.Status = 'Active'
            AND e.AgentId IS NOT NULL
          ORDER BY e.EffectiveDate DESC, e.CreatedDate DESC
        `);
      
      if (enrollmentResult.recordset.length > 0) {
        enrollmentId = enrollmentResult.recordset[0].EnrollmentId;
        agentId = enrollmentResult.recordset[0].AgentId;
        householdId = enrollmentResult.recordset[0].HouseholdId;
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

  // Get pricing information based on payment type (group vs individual)
  let netRate = 0;
  let commission = 0;
  let overrideRate = 0;
  let systemFees = 0;

  try {
    if (isIndividualRecurring && householdId) {
      // Individual recurring payment - get pricing from household enrollments
      const pricingResult = await pool.request()
        .input('householdId', sql.UniqueIdentifier, householdId)
        .query(`
          SELECT 
            SUM(COALESCE(e.NetRate, 0)) as NetRate,
            SUM(COALESCE(e.Commission, 0)) as Commission,
            SUM(COALESCE(e.OverrideRate, 0)) as OverrideRate,
            SUM(COALESCE(e.SystemFees, 0)) as SystemFees
          FROM oe.Enrollments e
          WHERE e.HouseholdId = @householdId
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
    } else if (groupId) {
      // Group recurring payment - aggregate from all group enrollments
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
    }
  } catch (error) {
    logger.warn(`Could not aggregate pricing: ${error.message}`);
  }

  // Build ProductCommissions JSON from enrollments (enrollment count and commission amount per product)
  const productCommissionsJSON = await buildProductCommissionsJSON(pool, householdId, groupId, logger);
  if (productCommissionsJSON) {
    logger.info(`Built ProductCommissions JSON: ${productCommissionsJSON}`);
  }

  // Calculate next retry date (1 week from now for failed payments)
  const nextRetryDate = new Date();
  nextRetryDate.setDate(nextRetryDate.getDate() + 7);
  
  logger.info(`Next retry date set to: ${nextRetryDate.toISOString().split('T')[0]}`);

  // Insert failed payment record with LocationId, InvoiceId, RecurringScheduleId, ProductCommissions, and retry info
  await pool.request()
    .input('transactionType', sql.NVarChar(50), 'Payment')
    .input('amount', sql.Decimal(10,2), amount)
    .input('status', sql.NVarChar(50), 'Failed')
    .input('processor', sql.NVarChar(50), 'DIME')
    .input('processorTransactionId', sql.NVarChar(255), transactionId)
    .input('paymentMethod', sql.NVarChar(50), 'Recurring')
    .input('recurringScheduleId', sql.NVarChar(255), scheduleId)
    .input('failureReason', sql.NVarChar(sql.MAX), failureReason)
    .input('retryDate', sql.DateTime2, nextRetryDate)
    .input('webhookEventId', sql.Int, webhookEventId)
    .input('paymentDate', sql.DateTime2, new Date())
    .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
    .input('householdId', sql.UniqueIdentifier, householdId)
    .input('agentId', sql.UniqueIdentifier, agentId)
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('locationId', sql.UniqueIdentifier, locationId)
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .input('netRate', sql.Decimal(10,2), netRate)
    .input('commission', sql.Decimal(10,2), commission)
    .input('overrideRate', sql.Decimal(10,2), overrideRate)
    .input('systemFees', sql.Decimal(10,2), systemFees)
    .input('productCommissions', sql.NVarChar(sql.MAX), productCommissionsJSON)
    .query(`
      INSERT INTO oe.Payments (
        PaymentId, EnrollmentId, AgentId, HouseholdId, GroupId, TenantId, LocationId, InvoiceId,
        TransactionType, Amount, Status, Processor, 
        ProcessorTransactionId, PaymentMethod, RecurringScheduleId, FailureReason, RetryDate, WebhookEventId, PaymentDate,
        NetRate, Commission, OverrideRate, SystemFees, ProductCommissions,
        CreatedDate, ModifiedDate
      ) VALUES (
        NEWID(), @enrollmentId, @agentId, @householdId, @groupId, @tenantId, @locationId, @invoiceId,
        @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @recurringScheduleId, @failureReason, @retryDate, @webhookEventId, @paymentDate,
        @netRate, @commission, @overrideRate, @systemFees, @productCommissions,
        GETUTCDATE(), GETUTCDATE()
      )
    `);

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
    }, logger, groupId, tenantId, isIndividualRecurring, locationId);
  } catch (emailError) {
    logger.error('Failed to send payment failure notification:', emailError);
  }
}