/**
 * Single source for creating an oe.Payments row from a recurring transaction.
 * Product JSON + group pricing windows: shared/payment-product-snapshots (same as PaymentAudit / Tenant Billing).
 */
const { sql } = require('./db');
const {
  getPricingFields,
  householdAsOfDate,
  buildProductSnapshotForPayment,
  resolveGroupPeriodFromInvoiceOrPaymentDate
} = require('./payment-product-snapshots');

/**
 * @param {Object} pool
 * @param {string|null} invoiceId
 * @param {string|null} groupId
 * @param {Date|string|null} paymentDate
 * @param {Object} logger
 */
async function resolveGroupPeriodForPricing(pool, invoiceId, groupId, paymentDate, logger) {
  if (!groupId) return {};
  const { periodStart, periodEnd } = await resolveGroupPeriodFromInvoiceOrPaymentDate(pool, invoiceId, paymentDate, logger);
  return { periodStart, periodEnd };
}

async function createRecurringPaymentRecord(pool, options, logger) {
  const {
    groupId, tenantId, householdId, enrollmentId, agentId, locationId, invoiceId,
    scheduleId, amount, processorTransactionId, paymentDate, paymentStatus, paymentMethod,
    nextBillingDate = null, webhookEventId = null
  } = options;

  const periodOpts = await resolveGroupPeriodForPricing(pool, invoiceId, groupId, paymentDate, logger);
  const pricing = await getPricingFields(pool, groupId, householdId, logger, paymentDate, periodOpts);

  const snapshot = await buildProductSnapshotForPayment(
    pool,
    { householdId, groupId, paymentDate, invoiceId },
    logger
  );
  const productCommissionsJSON = snapshot ? snapshot.productCommissionsJSON : null;
  const productVendorAmountsJSON = snapshot ? snapshot.productVendorAmountsJSON : null;
  const productOwnerAmountsJSON = snapshot ? snapshot.productOwnerAmountsJSON : null;

  const nextBilling = nextBillingDate != null ? nextBillingDate : (() => { const d = new Date(); d.setMonth(d.getMonth() + 1); d.setDate(1); return d; })();

  await pool.request()
    .input('transactionType', sql.NVarChar(50), 'Payment')
    .input('amount', sql.Decimal(10,2), amount)
    .input('status', sql.NVarChar(50), paymentStatus)
    .input('processor', sql.NVarChar(50), 'DIME')
    .input('processorTransactionId', sql.NVarChar(255), processorTransactionId)
    .input('paymentMethod', sql.NVarChar(50), paymentMethod || 'Recurring')
    .input('recurringScheduleId', sql.NVarChar(255), scheduleId)
    .input('nextBillingDate', sql.Date, nextBilling)
    .input('webhookEventId', sql.Int, webhookEventId)
    .input('paymentDate', sql.DateTime2, paymentDate)
    .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
    .input('agentId', sql.UniqueIdentifier, agentId)
    .input('householdId', sql.UniqueIdentifier, householdId)
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('locationId', sql.UniqueIdentifier, locationId)
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .input('netRate', sql.Decimal(10,2), pricing.netRate)
    .input('commission', sql.Decimal(10,2), pricing.commission)
    .input('overrideRate', sql.Decimal(10,2), pricing.overrideRate)
    .input('systemFees', sql.Decimal(10,2), pricing.systemFees)
    .input('processingFeeAmount', sql.Decimal(10,2), pricing.processingFeeAmount)
    .input('productCommissions', sql.NVarChar(sql.MAX), productCommissionsJSON)
    .input('productVendorAmounts', sql.NVarChar(sql.MAX), productVendorAmountsJSON)
    .input('productOwnerAmounts', sql.NVarChar(sql.MAX), productOwnerAmountsJSON)
    .query(`
      INSERT INTO oe.Payments (
        PaymentId, EnrollmentId, AgentId, HouseholdId, GroupId, TenantId, LocationId, InvoiceId,
        TransactionType, Amount, Status, Processor,
        ProcessorTransactionId, PaymentMethod, RecurringScheduleId, NextBillingDate, WebhookEventId, PaymentDate,
        NetRate, Commission, OverrideRate, SystemFees, ProcessingFeeAmount, ProductCommissions,
        ProductVendorAmounts, ProductOwnerAmounts,
        CreatedDate, ModifiedDate
      ) VALUES (
        NEWID(), @enrollmentId, @agentId, @householdId, @groupId, @tenantId, @locationId, @invoiceId,
        @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @recurringScheduleId, @nextBillingDate, @webhookEventId, @paymentDate,
        @netRate, @commission, @overrideRate, @systemFees, @processingFeeAmount, @productCommissions,
        @productVendorAmounts, @productOwnerAmounts,
        GETUTCDATE(), GETUTCDATE()
      )
    `);

  return {};
}

async function getRecurringFailureAttemptInfo(pool, { groupId, tenantId, householdId, amount }, logger) {
  const paymentMethod = 'Recurring';
  try {
    if (!tenantId || amount == null) {
      return { attemptNumber: 1, consecutiveFailures: 0, originalPaymentId: null };
    }

    if (groupId) {
      const failureResult = await pool.request()
        .input('groupId', sql.UniqueIdentifier, groupId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('amount', sql.Decimal(10, 2), amount)
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
        return { attemptNumber: 1, consecutiveFailures: 0, originalPaymentId: null };
      }
      const lastFailure = failureResult.recordset[0];
      const lastAttempt = lastFailure.AttemptNumber || 1;
      const lastConsecutiveFailures = lastFailure.ConsecutiveFailureCount || 0;
      const originalPaymentId = lastFailure.OriginalPaymentId || lastFailure.PaymentId;
      return {
        attemptNumber: lastAttempt + 1,
        consecutiveFailures: lastConsecutiveFailures + 1,
        originalPaymentId
      };
    }

    if (householdId) {
      const failureResult = await pool.request()
        .input('householdId', sql.UniqueIdentifier, householdId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('amount', sql.Decimal(10, 2), amount)
        .input('paymentMethod', sql.NVarChar(50), paymentMethod)
        .query(`
        SELECT TOP 1
          PaymentId,
          AttemptNumber,
          ConsecutiveFailureCount,
          OriginalPaymentId
        FROM oe.Payments
        WHERE HouseholdId = @householdId
          AND TenantId = @tenantId
          AND Amount = @amount
          AND PaymentMethod = @paymentMethod
          AND Status = 'Failed'
          AND TransactionType = 'Payment'
        ORDER BY CreatedDate DESC
      `);
      if (failureResult.recordset.length === 0) {
        return { attemptNumber: 1, consecutiveFailures: 0, originalPaymentId: null };
      }
      const lastFailure = failureResult.recordset[0];
      const lastAttempt = lastFailure.AttemptNumber || 1;
      const lastConsecutiveFailures = lastFailure.ConsecutiveFailureCount || 0;
      const originalPaymentId = lastFailure.OriginalPaymentId || lastFailure.PaymentId;
      return {
        attemptNumber: lastAttempt + 1,
        consecutiveFailures: lastConsecutiveFailures + 1,
        originalPaymentId
      };
    }

    return { attemptNumber: 1, consecutiveFailures: 0, originalPaymentId: null };
  } catch (e) {
    if (logger) logger.warn(`getRecurringFailureAttemptInfo: ${e.message}`);
    return { attemptNumber: 1, consecutiveFailures: 0, originalPaymentId: null };
  }
}

async function createFailedRecurringPaymentRecord(pool, options, logger) {
  const {
    groupId, tenantId, householdId, enrollmentId, agentId, locationId, invoiceId,
    scheduleId, amount, processorTransactionId, paymentDate, failureReason,
    retryDate = null, webhookEventId = null
  } = options;

  const periodOpts = await resolveGroupPeriodForPricing(pool, invoiceId, groupId, paymentDate, logger);
  const pricing = await getPricingFields(pool, groupId, householdId, logger, paymentDate, periodOpts);

  const snapshot = await buildProductSnapshotForPayment(
    pool,
    { householdId, groupId, paymentDate, invoiceId },
    logger
  );
  const productCommissionsJSON = snapshot ? snapshot.productCommissionsJSON : null;
  const productVendorAmountsJSON = snapshot ? snapshot.productVendorAmountsJSON : null;
  const productOwnerAmountsJSON = snapshot ? snapshot.productOwnerAmountsJSON : null;

  const attemptInfo = await getRecurringFailureAttemptInfo(pool, { groupId, tenantId, householdId, amount }, logger);
  const lastFailureDate = new Date();

  const nextRetry = retryDate != null ? retryDate : (() => { const d = new Date(); d.setDate(d.getDate() + 7); return d; })();

  await pool.request()
    .input('transactionType', sql.NVarChar(50), 'Payment')
    .input('amount', sql.Decimal(10,2), amount)
    .input('status', sql.NVarChar(50), 'Failed')
    .input('processor', sql.NVarChar(50), 'DIME')
    .input('processorTransactionId', sql.NVarChar(255), processorTransactionId)
    .input('paymentMethod', sql.NVarChar(50), 'Recurring')
    .input('recurringScheduleId', sql.NVarChar(255), scheduleId)
    .input('failureReason', sql.NVarChar(sql.MAX), failureReason || null)
    .input('retryDate', sql.DateTime2, nextRetry)
    .input('webhookEventId', sql.Int, webhookEventId)
    .input('paymentDate', sql.DateTime2, paymentDate)
    .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
    .input('agentId', sql.UniqueIdentifier, agentId)
    .input('householdId', sql.UniqueIdentifier, householdId)
    .input('groupId', sql.UniqueIdentifier, groupId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('locationId', sql.UniqueIdentifier, locationId)
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .input('netRate', sql.Decimal(10,2), pricing.netRate)
    .input('commission', sql.Decimal(10,2), pricing.commission)
    .input('overrideRate', sql.Decimal(10,2), pricing.overrideRate)
    .input('systemFees', sql.Decimal(10,2), pricing.systemFees)
    .input('processingFeeAmount', sql.Decimal(10,2), pricing.processingFeeAmount)
    .input('productCommissions', sql.NVarChar(sql.MAX), productCommissionsJSON)
    .input('productVendorAmounts', sql.NVarChar(sql.MAX), productVendorAmountsJSON)
    .input('productOwnerAmounts', sql.NVarChar(sql.MAX), productOwnerAmountsJSON)
    .input('attemptNumber', sql.Int, attemptInfo.attemptNumber)
    .input('originalPaymentId', sql.UniqueIdentifier, attemptInfo.originalPaymentId)
    .input('consecutiveFailures', sql.Int, attemptInfo.consecutiveFailures)
    .input('lastFailureDate', sql.DateTime2, lastFailureDate)
    .query(`
      INSERT INTO oe.Payments (
        PaymentId, EnrollmentId, AgentId, HouseholdId, GroupId, TenantId, LocationId, InvoiceId,
        TransactionType, Amount, Status, Processor,
        ProcessorTransactionId, PaymentMethod, RecurringScheduleId, FailureReason, RetryDate, WebhookEventId, PaymentDate,
        NetRate, Commission, OverrideRate, SystemFees, ProcessingFeeAmount, ProductCommissions,
        ProductVendorAmounts, ProductOwnerAmounts,
        AttemptNumber, OriginalPaymentId, ConsecutiveFailureCount, LastFailureDate,
        CreatedDate, ModifiedDate
      ) VALUES (
        NEWID(), @enrollmentId, @agentId, @householdId, @groupId, @tenantId, @locationId, @invoiceId,
        @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @recurringScheduleId, @failureReason, @retryDate, @webhookEventId, @paymentDate,
        @netRate, @commission, @overrideRate, @systemFees, @processingFeeAmount, @productCommissions,
        @productVendorAmounts, @productOwnerAmounts,
        @attemptNumber, @originalPaymentId, @consecutiveFailures, @lastFailureDate,
        GETUTCDATE(), GETUTCDATE()
      )
    `);

  return {};
}

/** Backward-compatible thin wrappers (same signatures as before; optional 6th arg invoiceId). */
async function buildProductCommissionsJSON(pool, householdId, groupId, logger, paymentDate = null, invoiceId = null) {
  const s = await buildProductSnapshotForPayment(pool, { householdId, groupId, paymentDate, invoiceId }, logger);
  return s ? s.productCommissionsJSON : null;
}
async function buildProductVendorAmountsJSON(pool, householdId, groupId, logger, paymentDate = null, invoiceId = null) {
  const s = await buildProductSnapshotForPayment(pool, { householdId, groupId, paymentDate, invoiceId }, logger);
  return s ? s.productVendorAmountsJSON : null;
}
async function buildProductOwnerAmountsJSON(pool, householdId, groupId, logger, paymentDate = null, invoiceId = null) {
  const s = await buildProductSnapshotForPayment(pool, { householdId, groupId, paymentDate, invoiceId }, logger);
  return s ? s.productOwnerAmountsJSON : null;
}

module.exports = {
  createRecurringPaymentRecord,
  createFailedRecurringPaymentRecord,
  getPricingFields,
  householdAsOfDate,
  buildProductSnapshotForPayment,
  buildProductCommissionsJSON,
  buildProductVendorAmountsJSON,
  buildProductOwnerAmountsJSON
};
