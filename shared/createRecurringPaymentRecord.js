/**
 * Single source of truth for creating an oe.Payments row from a recurring transaction.
 * Used by both DimeWebhookHandler (handleRecurringPaymentSuccess) and DimePaymentSync
 * so there is no duplicate logic — same pricing, same ProductCommissions/Vendor/Owner JSON, same INSERT.
 */
const { sql } = require('./db');

/**
 * Get pricing fields (netRate, commission, overrideRate, systemFees, processingFeeAmount) from enrollments.
 * Same logic as webhook: household vs group, EffectiveDate/TerminationDate only (no Status).
 */
async function getPricingFields(pool, groupId, householdId, logger) {
  let netRate = 0, commission = 0, overrideRate = 0, systemFees = 0, processingFeeAmount = 0;
  try {
    if (householdId) {
      const r = await pool.request().input('householdId', sql.UniqueIdentifier, householdId).query(`
        SELECT SUM(COALESCE(e.NetRate,0)) AS NetRate, SUM(COALESCE(e.Commission,0)) AS Commission,
          SUM(COALESCE(e.OverrideRate,0)) AS OverrideRate, SUM(COALESCE(e.SystemFees,0)) AS SystemFees
        FROM oe.Enrollments e
        WHERE e.HouseholdId = @householdId AND e.EffectiveDate <= GETUTCDATE()
          AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
      `);
      if (r.recordset.length) {
        netRate = r.recordset[0].NetRate || 0; commission = r.recordset[0].Commission || 0;
        overrideRate = r.recordset[0].OverrideRate || 0; systemFees = r.recordset[0].SystemFees || 0;
      }
      const ppf = await pool.request().input('householdId', sql.UniqueIdentifier, householdId).query(`
        SELECT ISNULL(SUM(e.PremiumAmount),0) AS ProcessingFee FROM oe.Enrollments e
        WHERE e.HouseholdId = @householdId AND e.EnrollmentType = 'PaymentProcessingFee'
          AND e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
      `);
      if (ppf.recordset.length) processingFeeAmount = parseFloat(ppf.recordset[0].ProcessingFee) || 0;
    } else if (groupId) {
      const r = await pool.request().input('groupId', sql.UniqueIdentifier, groupId).query(`
        SELECT SUM(COALESCE(e.NetRate,0)) AS NetRate, SUM(COALESCE(e.Commission,0)) AS Commission,
          SUM(COALESCE(e.OverrideRate,0)) AS OverrideRate, SUM(COALESCE(e.SystemFees,0)) AS SystemFees
        FROM oe.Enrollments e INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.GroupId = @groupId AND e.EffectiveDate <= GETUTCDATE()
          AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
      `);
      if (r.recordset.length) {
        netRate = r.recordset[0].NetRate || 0; commission = r.recordset[0].Commission || 0;
        overrideRate = r.recordset[0].OverrideRate || 0; systemFees = r.recordset[0].SystemFees || 0;
      }
      const ppf = await pool.request().input('groupId', sql.UniqueIdentifier, groupId).query(`
        SELECT ISNULL(SUM(e.PremiumAmount),0) AS ProcessingFee FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.GroupId = @groupId AND e.EnrollmentType = 'PaymentProcessingFee'
          AND e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
      `);
      if (ppf.recordset.length) processingFeeAmount = parseFloat(ppf.recordset[0].ProcessingFee) || 0;
    }
  } catch (err) {
    if (logger) logger.warn(`getPricingFields: ${err.message}`);
  }
  return { netRate, commission, overrideRate, systemFees, processingFeeAmount };
}

async function buildProductCommissionsJSON(pool, householdId, groupId, logger) {
  try {
    if (!householdId && !groupId) return null;
    const useGroup = groupId && !householdId;
    const req = pool.request();
    if (useGroup) {
      req.input('groupId', sql.UniqueIdentifier, groupId);
      const result = await req.query(`
        SELECT e.ProductId, COUNT(DISTINCT CASE WHEN m.RelationshipType = 'P' THEN m.HouseholdId END) AS HouseholdCount,
          SUM(COALESCE(e.Commission,0)) AS CommissionAmount
        FROM oe.Enrollments e INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.GroupId = @groupId AND e.Status = 'Active' AND e.EffectiveDate <= GETUTCDATE()
          AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
          AND e.ProductId IS NOT NULL AND e.ProductId != '00000000-0000-0000-0000-000000000000'
          AND e.ProductId NOT IN (SELECT DISTINCT BundleProductId FROM oe.ProductBundles WHERE BundleProductId IS NOT NULL)
        GROUP BY e.ProductId
      `);
      return buildCommissionMap(result.recordset);
    }
    req.input('householdId', sql.UniqueIdentifier, householdId);
    const result = await req.query(`
      SELECT e.ProductId, 1 AS HouseholdCount, SUM(COALESCE(e.Commission,0)) AS CommissionAmount
      FROM oe.Enrollments e WHERE e.HouseholdId = @householdId AND e.Status = 'Active'
        AND e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
        AND e.ProductId IS NOT NULL AND e.ProductId != '00000000-0000-0000-0000-000000000000'
        AND e.ProductId NOT IN (SELECT DISTINCT BundleProductId FROM oe.ProductBundles WHERE BundleProductId IS NOT NULL)
      GROUP BY e.ProductId
    `);
    return buildCommissionMap(result.recordset);
  } catch (err) {
    if (logger) logger.warn(`buildProductCommissionsJSON: ${err.message}`);
    return null;
  }
}
function buildCommissionMap(rows) {
  if (!rows || rows.length === 0) return null;
  const out = {};
  for (const row of rows) {
    const id = row.ProductId.toString().toUpperCase();
    out[id] = { enrolledHouseholdsCount: row.HouseholdCount || 0, commissionAmount: parseFloat(row.CommissionAmount) || 0 };
  }
  return JSON.stringify(out);
}

async function buildProductVendorAmountsJSON(pool, householdId, groupId, logger) {
  try {
    if (!householdId && !groupId) return null;
    const useGroup = groupId && !householdId;
    const req = pool.request();
    if (useGroup) {
      req.input('groupId', sql.UniqueIdentifier, groupId);
      const result = await req.query(`
        SELECT e.ProductId, COUNT(DISTINCT CASE WHEN m.RelationshipType = 'P' THEN m.HouseholdId END) AS HouseholdCount,
          SUM(COALESCE(e.NetRate,0)) AS VendorAmount
        FROM oe.Enrollments e INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.GroupId = @groupId AND e.Status = 'Active' AND e.EffectiveDate <= GETUTCDATE()
          AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
          AND e.ProductId IS NOT NULL AND e.ProductId != '00000000-0000-0000-0000-000000000000'
          AND e.ProductId NOT IN (SELECT DISTINCT BundleProductId FROM oe.ProductBundles WHERE BundleProductId IS NOT NULL)
        GROUP BY e.ProductId
      `);
      return buildVendorMap(result.recordset);
    }
    req.input('householdId', sql.UniqueIdentifier, householdId);
    const result = await req.query(`
      SELECT e.ProductId, 1 AS HouseholdCount, SUM(COALESCE(e.NetRate,0)) AS VendorAmount
      FROM oe.Enrollments e WHERE e.HouseholdId = @householdId AND e.Status = 'Active'
        AND e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
        AND e.ProductId IS NOT NULL AND e.ProductId != '00000000-0000-0000-0000-000000000000'
        AND e.ProductId NOT IN (SELECT DISTINCT BundleProductId FROM oe.ProductBundles WHERE BundleProductId IS NOT NULL)
      GROUP BY e.ProductId
    `);
    return buildVendorMap(result.recordset);
  } catch (err) {
    if (logger) logger.warn(`buildProductVendorAmountsJSON: ${err.message}`);
    return null;
  }
}
function buildVendorMap(rows) {
  if (!rows || rows.length === 0) return null;
  const out = {};
  for (const row of rows) {
    const id = row.ProductId.toString().toUpperCase();
    out[id] = { enrolledHouseholdsCount: row.HouseholdCount || 0, vendorAmount: parseFloat(row.VendorAmount) || 0 };
  }
  return JSON.stringify(out);
}

async function buildProductOwnerAmountsJSON(pool, householdId, groupId, logger) {
  try {
    if (!householdId && !groupId) return null;
    const useGroup = groupId && !householdId;
    const req = pool.request();
    if (useGroup) {
      req.input('groupId', sql.UniqueIdentifier, groupId);
      const result = await req.query(`
        SELECT e.ProductId, COUNT(DISTINCT CASE WHEN m.RelationshipType = 'P' THEN m.HouseholdId END) AS HouseholdCount,
          SUM(COALESCE(e.OverrideRate,0)) AS OverrideAmount
        FROM oe.Enrollments e INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.GroupId = @groupId AND e.Status = 'Active' AND e.EffectiveDate <= GETUTCDATE()
          AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
          AND e.ProductId IS NOT NULL AND e.ProductId != '00000000-0000-0000-0000-000000000000'
          AND e.ProductId NOT IN (SELECT DISTINCT BundleProductId FROM oe.ProductBundles WHERE BundleProductId IS NOT NULL)
        GROUP BY e.ProductId
      `);
      return buildOwnerMap(result.recordset);
    }
    req.input('householdId', sql.UniqueIdentifier, householdId);
    const result = await req.query(`
      SELECT e.ProductId, 1 AS HouseholdCount, SUM(COALESCE(e.OverrideRate,0)) AS OverrideAmount
      FROM oe.Enrollments e WHERE e.HouseholdId = @householdId AND e.Status = 'Active'
        AND e.EffectiveDate <= GETUTCDATE() AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
        AND e.ProductId IS NOT NULL AND e.ProductId != '00000000-0000-0000-0000-000000000000'
        AND e.ProductId NOT IN (SELECT DISTINCT BundleProductId FROM oe.ProductBundles WHERE BundleProductId IS NOT NULL)
      GROUP BY e.ProductId
    `);
    return buildOwnerMap(result.recordset);
  } catch (err) {
    if (logger) logger.warn(`buildProductOwnerAmountsJSON: ${err.message}`);
    return null;
  }
}
function buildOwnerMap(rows) {
  if (!rows || rows.length === 0) return null;
  const out = {};
  for (const row of rows) {
    const id = row.ProductId.toString().toUpperCase();
    out[id] = { enrolledHouseholdsCount: row.HouseholdCount || 0, overrideAmount: parseFloat(row.OverrideAmount) || 0 };
  }
  return JSON.stringify(out);
}

/**
 * Create one oe.Payments row for a recurring transaction. Single function used by webhook and sync.
 * @param {Object} pool - SQL pool
 * @param {Object} options - { groupId, tenantId, householdId?, enrollmentId?, agentId?, locationId?, invoiceId?, scheduleId, amount, processorTransactionId, paymentDate, paymentStatus, paymentMethod, nextBillingDate?, webhookEventId? }
 * @param {Object} logger - logger
 * @returns {Promise<{ paymentId?: string }>}
 */
async function createRecurringPaymentRecord(pool, options, logger) {
  const {
    groupId, tenantId, householdId, enrollmentId, agentId, locationId, invoiceId,
    scheduleId, amount, processorTransactionId, paymentDate, paymentStatus, paymentMethod,
    nextBillingDate = null, webhookEventId = null
  } = options;

  const pricing = await getPricingFields(pool, groupId, householdId, logger);
  const productCommissionsJSON = await buildProductCommissionsJSON(pool, householdId, groupId, logger);
  const productVendorAmountsJSON = await buildProductVendorAmountsJSON(pool, householdId, groupId, logger);
  const productOwnerAmountsJSON = await buildProductOwnerAmountsJSON(pool, householdId, groupId, logger);

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

/**
 * Create one oe.Payments row for a failed recurring payment. Same shape as webhook handleRecurringPaymentFailure.
 * Used by DimeWebhookHandler (failure path) and DimePaymentSync (failed-from-recurring-list backfill).
 * @param {Object} pool - SQL pool
 * @param {Object} options - { groupId, tenantId, householdId?, enrollmentId?, agentId?, locationId?, invoiceId?, scheduleId, amount, processorTransactionId, paymentDate, failureReason, retryDate?, webhookEventId? }
 * @param {Object} logger - logger
 */
async function createFailedRecurringPaymentRecord(pool, options, logger) {
  const {
    groupId, tenantId, householdId, enrollmentId, agentId, locationId, invoiceId,
    scheduleId, amount, processorTransactionId, paymentDate, failureReason,
    retryDate = null, webhookEventId = null
  } = options;

  const pricing = await getPricingFields(pool, groupId, householdId, logger);
  const productCommissionsJSON = await buildProductCommissionsJSON(pool, householdId, groupId, logger);
  const productVendorAmountsJSON = await buildProductVendorAmountsJSON(pool, householdId, groupId, logger);
  const productOwnerAmountsJSON = await buildProductOwnerAmountsJSON(pool, householdId, groupId, logger);

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
    .query(`
      INSERT INTO oe.Payments (
        PaymentId, EnrollmentId, AgentId, HouseholdId, GroupId, TenantId, LocationId, InvoiceId,
        TransactionType, Amount, Status, Processor,
        ProcessorTransactionId, PaymentMethod, RecurringScheduleId, FailureReason, RetryDate, WebhookEventId, PaymentDate,
        NetRate, Commission, OverrideRate, SystemFees, ProcessingFeeAmount, ProductCommissions,
        ProductVendorAmounts, ProductOwnerAmounts,
        CreatedDate, ModifiedDate
      ) VALUES (
        NEWID(), @enrollmentId, @agentId, @householdId, @groupId, @tenantId, @locationId, @invoiceId,
        @transactionType, @amount, @status, @processor,
        @processorTransactionId, @paymentMethod, @recurringScheduleId, @failureReason, @retryDate, @webhookEventId, @paymentDate,
        @netRate, @commission, @overrideRate, @systemFees, @processingFeeAmount, @productCommissions,
        @productVendorAmounts, @productOwnerAmounts,
        GETUTCDATE(), GETUTCDATE()
      )
    `);

  return {};
}

module.exports = {
  createRecurringPaymentRecord,
  createFailedRecurringPaymentRecord,
  getPricingFields,
  buildProductCommissionsJSON,
  buildProductVendorAmountsJSON,
  buildProductOwnerAmountsJSON
};
