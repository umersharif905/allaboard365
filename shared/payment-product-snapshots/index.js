/**
 * Single source for oe.Payments product snapshot JSON (ProductCommissions, ProductVendorAmounts, ProductOwnerAmounts),
 * fee bucket scalars (getHouseholdFeeBucketsAsOf / getGroupFeeBucketsForPeriod), and aligned group pricing windows.
 * PaymentAuditService delegates fee recomputation to the same helpers used by getPricingFields.
 *
 * Consumers: backend (paymentAudit, paymentDatabaseService, groupBilling), oe_payment_manager (vendored copy via deploy.sh).
 */
'use strict';

const path = require('path');
const fs = require('fs');

/**
 * Prefer backend / Functions app node_modules so `sql.*` types match the pool (see backend vs root mssql versions).
 */
function loadSql() {
  const directCandidates = [
    path.join(__dirname, '..', '..', 'backend', 'node_modules', 'mssql'),
    path.join(__dirname, '..', '..', 'node_modules', 'mssql'),
  ];
  for (const modPath of directCandidates) {
    try {
      if (fs.existsSync(modPath)) {
        return require(modPath);
      }
    } catch (_e) {
      /* next */
    }
  }
  return require('mssql');
}

const sql = loadSql();

const ZERO_GUID = '00000000-0000-0000-0000-000000000000';

function toUpperGuid(val) {
  if (!val) return null;
  try {
    return val.toString().toUpperCase();
  } catch (_e) {
    return null;
  }
}

function n2(val) {
  const num = Number(val);
  if (Number.isNaN(num) || !Number.isFinite(num)) return 0;
  return Math.round(num * 100) / 100;
}

/** For household (individual) recurring/payments: end of month after payment month (matches payment audit / enrollment flows). */
function householdAsOfDate(paymentDate) {
  if (!paymentDate) return null;
  const d = new Date(paymentDate);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return new Date(Date.UTC(y, m + 2, 0));
}

/** UTC calendar month bounds for paymentDate (fallback when invoice billing period is unknown). */
function resolveGroupPeriodFromPaymentDate(paymentDate) {
  const d = paymentDate ? new Date(paymentDate) : new Date();
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return {
    periodStart: new Date(Date.UTC(y, m, 1)),
    periodEnd: new Date(Date.UTC(y, m + 1, 0))
  };
}

async function resolveGroupPeriodFromInvoiceOrPaymentDate(pool, invoiceId, paymentDate, logger) {
  if (invoiceId) {
    try {
      const inv = await pool.request()
        .input('invoiceId', sql.UniqueIdentifier, invoiceId)
        .query(`
          SELECT BillingPeriodStart, BillingPeriodEnd
          FROM oe.Invoices
          WHERE InvoiceId = @invoiceId
        `);
      const row = inv.recordset && inv.recordset[0];
      if (row && row.BillingPeriodStart && row.BillingPeriodEnd) {
        return { periodStart: row.BillingPeriodStart, periodEnd: row.BillingPeriodEnd };
      }
    } catch (e) {
      if (logger && logger.warn) logger.warn(`resolveGroupPeriodFromInvoiceOrPaymentDate: ${e.message}`);
    }
  }
  return resolveGroupPeriodFromPaymentDate(paymentDate);
}

/**
 * Fee enrollment rows only (SystemFee / PaymentProcessingFee / SetupFee) — single source for audit + getPricingFields.
 * Matches PaymentAuditService.computeHouseholdFeeBuckets semantics.
 */
async function getHouseholdFeeBucketsAsOf(pool, householdId, asOfDate, sqlTypes = sql) {
  const result = await pool.request()
    .input('householdId', sqlTypes.UniqueIdentifier, householdId)
    .input('asOfDate', sqlTypes.DateTime, asOfDate)
    .query(`
        SELECT
          ISNULL(SUM(CASE WHEN e.EnrollmentType = 'SystemFee' THEN COALESCE(e.PremiumAmount, 0) ELSE 0 END), 0) AS SystemFees,
          ISNULL(SUM(CASE WHEN e.EnrollmentType = 'PaymentProcessingFee' THEN COALESCE(e.PremiumAmount, 0) ELSE 0 END), 0) AS ProcessingFeeAmount,
          ISNULL(SUM(CASE WHEN e.EnrollmentType = 'SetupFee' THEN COALESCE(e.PremiumAmount, 0) ELSE 0 END), 0) AS SetupFee
        FROM oe.Enrollments e
        WHERE e.HouseholdId = @householdId
          AND e.EffectiveDate <= @asOfDate
          AND (e.TerminationDate IS NULL OR e.TerminationDate > @asOfDate)
          AND e.EnrollmentType IN ('SystemFee', 'PaymentProcessingFee', 'SetupFee')
      `);

  const row = result.recordset?.[0] || {};
  return {
    systemFees: n2(row.SystemFees),
    processingFeeAmount: n2(row.ProcessingFeeAmount),
    setupFee: n2(row.SetupFee)
  };
}

/**
 * Group-wide fee enrollment sums for a billing window — single source for audit + getPricingFields.
 * Matches PaymentAuditService.computeGroupFeeBucketsForPeriod semantics.
 */
async function getGroupFeeBucketsForPeriod(pool, groupId, periodStart, periodEnd, sqlTypes = sql) {
  const result = await pool.request()
    .input('groupId', sqlTypes.UniqueIdentifier, groupId)
    .input('periodStart', sqlTypes.Date, periodStart)
    .input('periodEnd', sqlTypes.Date, periodEnd)
    .query(`
        SELECT
          ISNULL(SUM(CASE WHEN e.EnrollmentType = 'SystemFee' THEN COALESCE(e.PremiumAmount, 0) ELSE 0 END), 0) AS SystemFees,
          ISNULL(SUM(CASE WHEN e.EnrollmentType = 'PaymentProcessingFee' THEN COALESCE(e.PremiumAmount, 0) ELSE 0 END), 0) AS ProcessingFeeAmount,
          ISNULL(SUM(CASE WHEN e.EnrollmentType = 'SetupFee' THEN COALESCE(e.PremiumAmount, 0) ELSE 0 END), 0) AS SetupFee
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.GroupId = @groupId
          AND CAST(e.EffectiveDate AS DATE) <= @periodEnd
          AND (e.TerminationDate IS NULL OR e.TerminationDate > @periodStart)
          AND e.EnrollmentType IN ('SystemFee', 'PaymentProcessingFee', 'SetupFee')
      `);

  const row = result.recordset?.[0] || {};
  return {
    systemFees: n2(row.SystemFees),
    processingFeeAmount: n2(row.ProcessingFeeAmount),
    setupFee: n2(row.SetupFee)
  };
}

/**
 * Aggregate scalar buckets on oe.Payments (NetRate, Commission, etc.).
 * Household: same as-of as product snapshots. Group: use invoice period when provided, else UTC month of paymentDate.
 * Fee buckets come from getHouseholdFeeBucketsAsOf / getGroupFeeBucketsForPeriod.
 */
async function getPricingFields(pool, groupId, householdId, logger, paymentDate = null, options = {}) {
  const T = options.sqlTypes || sql;
  let netRate = 0;
  let commission = 0;
  let overrideRate = 0;
  let systemFees = 0;
  let processingFeeAmount = 0;
  try {
    if (householdId) {
      const asOf = householdAsOfDate(paymentDate) || new Date();
      const r = await pool.request()
        .input('householdId', T.UniqueIdentifier, householdId)
        .input('asOfDate', T.DateTime, asOf)
        .query(`
        SELECT SUM(COALESCE(e.NetRate,0)) AS NetRate, SUM(COALESCE(e.Commission,0)) AS Commission,
          SUM(COALESCE(e.OverrideRate,0)) AS OverrideRate
        FROM oe.Enrollments e
        WHERE e.HouseholdId = @householdId AND e.EffectiveDate <= @asOfDate
          AND (e.TerminationDate IS NULL OR e.TerminationDate > @asOfDate)
      `);
      if (r.recordset.length) {
        netRate = r.recordset[0].NetRate || 0;
        commission = r.recordset[0].Commission || 0;
        overrideRate = r.recordset[0].OverrideRate || 0;
      }
      const hhFees = await getHouseholdFeeBucketsAsOf(pool, householdId, asOf, T);
      systemFees = hhFees.systemFees;
      processingFeeAmount = hhFees.processingFeeAmount;
    } else if (groupId) {
      let periodStart = options.periodStart;
      let periodEnd = options.periodEnd;
      if (!periodStart || !periodEnd) {
        const r = resolveGroupPeriodFromPaymentDate(paymentDate || new Date());
        periodStart = r.periodStart;
        periodEnd = r.periodEnd;
      }
      const r = await pool.request()
        .input('groupId', T.UniqueIdentifier, groupId)
        .input('periodStart', T.Date, periodStart)
        .input('periodEnd', T.Date, periodEnd)
        .query(`
        SELECT SUM(COALESCE(e.NetRate,0)) AS NetRate, SUM(COALESCE(e.Commission,0)) AS Commission,
          SUM(COALESCE(e.OverrideRate,0)) AS OverrideRate
        FROM oe.Enrollments e INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.GroupId = @groupId
          AND CAST(e.EffectiveDate AS DATE) <= @periodEnd
          AND (e.TerminationDate IS NULL OR e.TerminationDate > @periodStart)
      `);
      if (r.recordset.length) {
        netRate = r.recordset[0].NetRate || 0;
        commission = r.recordset[0].Commission || 0;
        overrideRate = r.recordset[0].OverrideRate || 0;
      }
      const gFees = await getGroupFeeBucketsForPeriod(pool, groupId, periodStart, periodEnd, T);
      systemFees = gFees.systemFees;
      processingFeeAmount = gFees.processingFeeAmount;
    }
  } catch (err) {
    if (logger && logger.warn) logger.warn(`getPricingFields: ${err.message}`);
  }
  return { netRate, commission, overrideRate, systemFees, processingFeeAmount };
}

async function buildHouseholdProductSnapshots(pool, householdId, asOfDate, logger) {
  try {
    const result = await pool.request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .input('asOfDate', sql.DateTime, asOfDate)
      .query(`
        SELECT
          e.ProductId,
          1 AS HouseholdCount,
          SUM(COALESCE(e.Commission, 0)) AS CommissionAmount,
          SUM(COALESCE(e.NetRate, 0)) AS VendorAmount,
          SUM(COALESCE(e.OverrideRate, 0)) AS OverrideAmount
        FROM oe.Enrollments e
        WHERE e.HouseholdId = @householdId
          AND e.EffectiveDate <= @asOfDate
          AND (e.TerminationDate IS NULL OR e.TerminationDate > @asOfDate)
          AND e.ProductId IS NOT NULL
          AND e.ProductId != '${ZERO_GUID}'
          AND e.ProductId NOT IN (
            SELECT DISTINCT BundleProductId
            FROM oe.ProductBundles
            WHERE BundleProductId IS NOT NULL
          )
        GROUP BY e.ProductId
      `);

    const productCommissions = {};
    const productVendorAmounts = {};
    const productOwnerAmounts = {};

    for (const row of result.recordset || []) {
      const productId = toUpperGuid(row.ProductId);
      if (!productId) continue;
      productCommissions[productId] = {
        enrolledHouseholdsCount: row.HouseholdCount ?? 1,
        commissionAmount: n2(row.CommissionAmount)
      };
      productVendorAmounts[productId] = {
        enrolledHouseholdsCount: row.HouseholdCount ?? 1,
        vendorAmount: n2(row.VendorAmount)
      };
      productOwnerAmounts[productId] = {
        enrolledHouseholdsCount: row.HouseholdCount ?? 1,
        overrideAmount: n2(row.OverrideAmount)
      };
    }

    return {
      productCommissions,
      productVendorAmounts,
      productOwnerAmounts,
      productCommissionsJSON: JSON.stringify(productCommissions),
      productVendorAmountsJSON: JSON.stringify(productVendorAmounts),
      productOwnerAmountsJSON: JSON.stringify(productOwnerAmounts)
    };
  } catch (e) {
    if (logger && logger.warn) logger.warn(`buildHouseholdProductSnapshots: ${e.message}`);
    return null;
  }
}

/**
 * Product JSON for a single enrollment (same filters as buildHouseholdProductSnapshots, one row).
 * Use for ACH/CC rows where oe.Payments scalars come from getEnrollmentContext (one enrollment)
 * but HouseholdId is set — avoids summing the whole household in JSON vs payment row.
 */
async function buildEnrollmentProductSnapshots(pool, enrollmentId, asOfDate, logger) {
  try {
    const result = await pool.request()
      .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
      .input('asOfDate', sql.DateTime, asOfDate)
      .query(`
        SELECT
          e.ProductId,
          1 AS HouseholdCount,
          SUM(COALESCE(e.Commission, 0)) AS CommissionAmount,
          SUM(COALESCE(e.NetRate, 0)) AS VendorAmount,
          SUM(COALESCE(e.OverrideRate, 0)) AS OverrideAmount
        FROM oe.Enrollments e
        WHERE e.EnrollmentId = @enrollmentId
          AND e.EffectiveDate <= @asOfDate
          AND (e.TerminationDate IS NULL OR e.TerminationDate > @asOfDate)
          AND e.ProductId IS NOT NULL
          AND e.ProductId != '${ZERO_GUID}'
          AND e.ProductId NOT IN (
            SELECT DISTINCT BundleProductId
            FROM oe.ProductBundles
            WHERE BundleProductId IS NOT NULL
          )
        GROUP BY e.ProductId
      `);

    const productCommissions = {};
    const productVendorAmounts = {};
    const productOwnerAmounts = {};

    for (const row of result.recordset || []) {
      const productId = toUpperGuid(row.ProductId);
      if (!productId) continue;
      productCommissions[productId] = {
        enrolledHouseholdsCount: row.HouseholdCount ?? 1,
        commissionAmount: n2(row.CommissionAmount)
      };
      productVendorAmounts[productId] = {
        enrolledHouseholdsCount: row.HouseholdCount ?? 1,
        vendorAmount: n2(row.VendorAmount)
      };
      productOwnerAmounts[productId] = {
        enrolledHouseholdsCount: row.HouseholdCount ?? 1,
        overrideAmount: n2(row.OverrideAmount)
      };
    }

    return {
      productCommissions,
      productVendorAmounts,
      productOwnerAmounts,
      productCommissionsJSON: JSON.stringify(productCommissions),
      productVendorAmountsJSON: JSON.stringify(productVendorAmounts),
      productOwnerAmountsJSON: JSON.stringify(productOwnerAmounts)
    };
  } catch (e) {
    if (logger && logger.warn) logger.warn(`buildEnrollmentProductSnapshots: ${e.message}`);
    return null;
  }
}

async function buildGroupProductSnapshotsForPeriod(pool, groupId, periodStart, periodEnd, logger) {
  try {
    const result = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('periodStart', sql.Date, periodStart)
      .input('periodEnd', sql.Date, periodEnd)
      .query(`
        SELECT
          e.ProductId,
          COUNT(DISTINCT m.HouseholdId) AS EnrollmentCount,
          SUM(COALESCE(e.Commission, 0)) AS CommissionAmount,
          SUM(COALESCE(e.NetRate, 0)) AS VendorAmount,
          SUM(COALESCE(e.OverrideRate, 0)) AS OverrideAmount
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.GroupId = @groupId
          AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
          AND CAST(e.EffectiveDate AS DATE) <= @periodEnd
          AND (e.TerminationDate IS NULL OR e.TerminationDate > @periodStart)
          AND e.ProductId IS NOT NULL
          AND e.ProductId != '${ZERO_GUID}'
          AND e.ProductId NOT IN (
            SELECT DISTINCT BundleProductId
            FROM oe.ProductBundles
            WHERE BundleProductId IS NOT NULL
          )
        GROUP BY e.ProductId
      `);

    const productCommissions = {};
    const productVendorAmounts = {};
    const productOwnerAmounts = {};

    for (const row of result.recordset || []) {
      const productId = toUpperGuid(row.ProductId);
      if (!productId) continue;
      productCommissions[productId] = {
        enrolledHouseholdsCount: row.EnrollmentCount ?? 0,
        commissionAmount: n2(row.CommissionAmount)
      };
      productVendorAmounts[productId] = {
        enrolledHouseholdsCount: row.EnrollmentCount ?? 0,
        vendorAmount: n2(row.VendorAmount)
      };
      productOwnerAmounts[productId] = {
        enrolledHouseholdsCount: row.EnrollmentCount ?? 0,
        overrideAmount: n2(row.OverrideAmount)
      };
    }

    return {
      productCommissions,
      productVendorAmounts,
      productOwnerAmounts,
      productCommissionsJSON: JSON.stringify(productCommissions),
      productVendorAmountsJSON: JSON.stringify(productVendorAmounts),
      productOwnerAmountsJSON: JSON.stringify(productOwnerAmounts)
    };
  } catch (e) {
    if (logger && logger.warn) logger.warn(`buildGroupProductSnapshotsForPeriod: ${e.message}`);
    return null;
  }
}

/**
 * One call for household or group — same rules as Tenant Billing payment audit.
 * @param {object} ctx - { householdId, groupId, paymentDate, invoiceId? }
 *
 * When both householdId and groupId are set (typical group-member enrollment), use the
 * household snapshot unless productSnapshotScope is 'enrollment' (one-off ACH/CC: scalars
 * are from a single enrollment via getEnrollmentContext).
 */
async function buildProductSnapshotForPayment(pool, ctx, logger) {
  const { householdId, groupId, paymentDate, invoiceId, enrollmentId, productSnapshotScope } = ctx;
  const useEnrollmentSnapshot =
    productSnapshotScope === 'enrollment' && enrollmentId && householdId;
  if (useEnrollmentSnapshot) {
    const asOf = householdAsOfDate(paymentDate) || new Date();
    return buildEnrollmentProductSnapshots(pool, enrollmentId, asOf, logger);
  }
  // Group invoice payments (manual charge / realistic webhook test): use billing period, not household aggregate.
  if (invoiceId && groupId) {
    const { periodStart, periodEnd } = await resolveGroupPeriodFromInvoiceOrPaymentDate(pool, invoiceId, paymentDate, logger);
    return buildGroupProductSnapshotsForPeriod(pool, groupId, periodStart, periodEnd, logger);
  }
  if (householdId) {
    const asOf = householdAsOfDate(paymentDate) || new Date();
    return buildHouseholdProductSnapshots(pool, householdId, asOf, logger);
  }
  if (groupId) {
    const { periodStart, periodEnd } = await resolveGroupPeriodFromInvoiceOrPaymentDate(pool, invoiceId, paymentDate, logger);
    return buildGroupProductSnapshotsForPeriod(pool, groupId, periodStart, periodEnd, logger);
  }
  return null;
}

module.exports = {
  ZERO_GUID,
  toUpperGuid,
  n2,
  householdAsOfDate,
  resolveGroupPeriodFromPaymentDate,
  resolveGroupPeriodFromInvoiceOrPaymentDate,
  getHouseholdFeeBucketsAsOf,
  getGroupFeeBucketsForPeriod,
  getPricingFields,
  buildHouseholdProductSnapshots,
  buildEnrollmentProductSnapshots,
  buildGroupProductSnapshotsForPeriod,
  buildProductSnapshotForPayment
};
