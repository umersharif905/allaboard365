const { getPool, rawSql } = require('../config/database');
// IMPORTANT: ../config/database exports `sql` as a limited SqlTypes helper object.
// For Request.input() parameter typing we need the raw `mssql` module (rawSql).
const sql = rawSql;
const { requireShared } = require('../config/shared-modules');
const {
  buildHouseholdProductSnapshots,
  buildEnrollmentProductSnapshots,
  buildGroupProductSnapshotsForPeriod,
  getHouseholdFeeBucketsAsOf,
  getGroupFeeBucketsForPeriod
} = requireShared('payment-product-snapshots');

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

/**
 * Payment Audit Service
 *
 * Recomputes bucket allocations and product JSON breakdowns using the same rules
 * used when generating/storing payments:
 * - Use EffectiveDate/TerminationDate windows (not Status) as-of a date
 * - Product buckets come from oe.Enrollments NetRate/OverrideRate/Commission
 * - Fee buckets come from dedicated enrollment records by EnrollmentType
 * - JSON breakdowns are sums grouped by ProductId (excluding bundle ProductIds)
 *
 * IMPORTANT: This service never changes oe.Payments.Amount.
 */
class PaymentAuditService {
  static async getPaymentForTenant(paymentId, tenantId) {
    const pool = await getPool();
    const result = await pool.request()
      .input('paymentId', sql.UniqueIdentifier, paymentId)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT TOP 1
          p.PaymentId,
          p.TenantId,
          p.GroupId,
          p.HouseholdId,
          p.EnrollmentId,
          p.InvoiceId,
          p.LocationId,
          p.Amount,
          p.Status,
          p.PaymentDate,
          p.CreatedDate,
          p.ModifiedDate,
          p.Processor,
          p.ProcessorTransactionId,
          p.PaymentMethod,
          p.RecurringScheduleId,
          -- Invoice-sourced payouts: canonical values come from oe.Invoices when linked,
          -- with oe.Payments retained as a backward-compatible fallback.
          COALESCE(inv.NetRate, p.NetRate) AS NetRate,
          COALESCE(inv.OverrideRate, p.OverrideRate) AS OverrideRate,
          COALESCE(inv.Commission, p.Commission) AS Commission,
          COALESCE(inv.SystemFees, p.SystemFees) AS SystemFees,
          COALESCE(inv.ProcessingFeeAmount, p.ProcessingFeeAmount) AS ProcessingFeeAmount,
          COALESCE(inv.SetupFee, p.SetupFee) AS SetupFee,
          COALESCE(inv.ProductCommissions, p.ProductCommissions) AS ProductCommissions,
          COALESCE(inv.ProductVendorAmounts, p.ProductVendorAmounts) AS ProductVendorAmounts,
          COALESCE(inv.ProductOwnerAmounts, p.ProductOwnerAmounts) AS ProductOwnerAmounts,
          -- Raw Payments-stored values retained for drift detection between the two sources
          p.NetRate AS RawPaymentNetRate,
          p.OverrideRate AS RawPaymentOverrideRate,
          p.Commission AS RawPaymentCommission,
          p.SystemFees AS RawPaymentSystemFees,
          p.ProcessingFeeAmount AS RawPaymentProcessingFeeAmount,
          p.SetupFee AS RawPaymentSetupFee,
          p.ProductCommissions AS RawPaymentProductCommissions,
          p.ProductVendorAmounts AS RawPaymentProductVendorAmounts,
          p.ProductOwnerAmounts AS RawPaymentProductOwnerAmounts
        FROM oe.Payments p
        LEFT JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
        WHERE p.PaymentId = @paymentId
          AND p.TenantId = @tenantId
      `);

    return result.recordset?.[0] || null;
  }

  static async getInvoicePeriod(invoiceId) {
    if (!invoiceId) return null;
    const pool = await getPool();
    const result = await pool.request()
      .input('invoiceId', sql.UniqueIdentifier, invoiceId)
      .query(`
        SELECT TOP 1
          i.InvoiceId,
          i.BillingPeriodStart,
          i.BillingPeriodEnd,
          i.InvoiceDate,
          i.DueDate
        FROM oe.Invoices i
        WHERE i.InvoiceId = @invoiceId
      `);

    const row = result.recordset?.[0] || null;
    if (!row) return null;
    return {
      invoiceId: row.InvoiceId,
      billingPeriodStart: row.BillingPeriodStart,
      billingPeriodEnd: row.BillingPeriodEnd,
      invoiceDate: row.InvoiceDate,
      dueDate: row.DueDate
    };
  }

  static async resolveContextFromEnrollment(enrollmentId) {
    const pool = await getPool();
    const result = await pool.request()
      .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
      .query(`
        SELECT TOP 1
          m.GroupId,
          m.HouseholdId
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE e.EnrollmentId = @enrollmentId
      `);

    const row = result.recordset?.[0] || {};
    return {
      groupId: row.GroupId || null,
      householdId: row.HouseholdId || null
    };
  }

  static async computeHouseholdProductBuckets(householdId, asOfDate) {
    const pool = await getPool();
    const result = await pool.request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .input('asOfDate', sql.DateTime, asOfDate)
      .query(`
        SELECT
          SUM(COALESCE(e.NetRate, 0)) AS NetRate,
          SUM(COALESCE(e.OverrideRate, 0)) AS OverrideRate,
          SUM(COALESCE(e.Commission, 0)) AS Commission
        FROM oe.Enrollments e
        WHERE e.HouseholdId = @householdId
          AND e.EffectiveDate <= @asOfDate
          AND (e.TerminationDate IS NULL OR e.TerminationDate > @asOfDate)
          AND e.Commission IS NOT NULL
      `);

    const row = result.recordset?.[0] || {};
    return {
      netRate: n2(row.NetRate),
      overrideRate: n2(row.OverrideRate),
      commission: n2(row.Commission)
    };
  }

  /** One enrollment row — matches getEnrollmentContext / one-off ACH & CC oe.Payments scalars. */
  static async computeEnrollmentProductBuckets(enrollmentId, asOfDate) {
    const pool = await getPool();
    const result = await pool.request()
      .input('enrollmentId', sql.UniqueIdentifier, enrollmentId)
      .input('asOfDate', sql.DateTime, asOfDate)
      .query(`
        SELECT
          SUM(COALESCE(e.NetRate, 0)) AS NetRate,
          SUM(COALESCE(e.OverrideRate, 0)) AS OverrideRate,
          SUM(COALESCE(e.Commission, 0)) AS Commission
        FROM oe.Enrollments e
        WHERE e.EnrollmentId = @enrollmentId
          AND e.EffectiveDate <= @asOfDate
          AND (e.TerminationDate IS NULL OR e.TerminationDate > @asOfDate)
          AND e.Commission IS NOT NULL
      `);

    const row = result.recordset?.[0] || {};
    return {
      netRate: n2(row.NetRate),
      overrideRate: n2(row.OverrideRate),
      commission: n2(row.Commission)
    };
  }

  static async computeGroupEnrollmentPremiumMismatchesForPeriod(groupId, periodStart, periodEnd, limit = 200) {
    const pool = await getPool();
    const result = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('periodStart', sql.Date, periodStart)
      .input('periodEnd', sql.Date, periodEnd)
      .input('limit', sql.Int, Math.max(1, Math.min(500, Number(limit) || 200)))
      .query(`
        SELECT TOP (@limit)
          e.EnrollmentId,
          e.MemberId,
          e.HouseholdId,
          e.ProductId,
          p.Name AS ProductName,
          e.EffectiveDate,
          e.TerminationDate,
          COALESCE(e.PremiumAmount, 0) AS PremiumAmount,
          COALESCE(e.NetRate, 0) AS NetRate,
          COALESCE(e.OverrideRate, 0) AS OverrideRate,
          COALESCE(e.Commission, 0) AS Commission,
          (COALESCE(e.NetRate,0) + COALESCE(e.OverrideRate,0) + COALESCE(e.Commission,0)) AS ComponentSum,
          (COALESCE(e.PremiumAmount,0) - (COALESCE(e.NetRate,0) + COALESCE(e.OverrideRate,0) + COALESCE(e.Commission,0))) AS Diff
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        LEFT JOIN oe.Products p ON e.ProductId = p.ProductId
        WHERE m.GroupId = @groupId
          AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
          AND CAST(e.EffectiveDate AS DATE) <= @periodEnd
          AND (e.TerminationDate IS NULL OR e.TerminationDate > @periodStart)
          AND ABS(COALESCE(e.PremiumAmount,0) - (COALESCE(e.NetRate,0) + COALESCE(e.OverrideRate,0) + COALESCE(e.Commission,0))) > 0.01
        ORDER BY ABS(COALESCE(e.PremiumAmount,0) - (COALESCE(e.NetRate,0) + COALESCE(e.OverrideRate,0) + COALESCE(e.Commission,0))) DESC
      `);

    return (result.recordset || []).map((r) => ({
      enrollmentId: r.EnrollmentId,
      memberId: r.MemberId,
      householdId: r.HouseholdId,
      productId: r.ProductId,
      productName: r.ProductName || null,
      effectiveDate: r.EffectiveDate || null,
      terminationDate: r.TerminationDate || null,
      premiumAmount: n2(r.PremiumAmount),
      netRate: n2(r.NetRate),
      overrideRate: n2(r.OverrideRate),
      commission: n2(r.Commission),
      componentSum: n2(r.ComponentSum),
      diff: n2(r.Diff)
    }));
  }

  static async computeHouseholdEnrollmentPremiumMismatchesAsOf(householdId, asOfDate, limit = 200) {
    const pool = await getPool();
    const result = await pool.request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .input('asOfDate', sql.DateTime, asOfDate)
      .input('limit', sql.Int, Math.max(1, Math.min(500, Number(limit) || 200)))
      .query(`
        SELECT TOP (@limit)
          e.EnrollmentId,
          e.MemberId,
          e.HouseholdId,
          e.ProductId,
          p.Name AS ProductName,
          e.EffectiveDate,
          e.TerminationDate,
          COALESCE(e.PremiumAmount, 0) AS PremiumAmount,
          COALESCE(e.NetRate, 0) AS NetRate,
          COALESCE(e.OverrideRate, 0) AS OverrideRate,
          COALESCE(e.Commission, 0) AS Commission,
          (COALESCE(e.NetRate,0) + COALESCE(e.OverrideRate,0) + COALESCE(e.Commission,0)) AS ComponentSum,
          (COALESCE(e.PremiumAmount,0) - (COALESCE(e.NetRate,0) + COALESCE(e.OverrideRate,0) + COALESCE(e.Commission,0))) AS Diff
        FROM oe.Enrollments e
        LEFT JOIN oe.Products p ON e.ProductId = p.ProductId
        WHERE e.HouseholdId = @householdId
          AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
          AND e.EffectiveDate <= @asOfDate
          AND (e.TerminationDate IS NULL OR e.TerminationDate > @asOfDate)
          AND ABS(COALESCE(e.PremiumAmount,0) - (COALESCE(e.NetRate,0) + COALESCE(e.OverrideRate,0) + COALESCE(e.Commission,0))) > 0.01
        ORDER BY ABS(COALESCE(e.PremiumAmount,0) - (COALESCE(e.NetRate,0) + COALESCE(e.OverrideRate,0) + COALESCE(e.Commission,0))) DESC
      `);

    return (result.recordset || []).map((r) => ({
      enrollmentId: r.EnrollmentId,
      memberId: r.MemberId,
      householdId: r.HouseholdId,
      productId: r.ProductId,
      productName: r.ProductName || null,
      effectiveDate: r.EffectiveDate || null,
      terminationDate: r.TerminationDate || null,
      premiumAmount: n2(r.PremiumAmount),
      netRate: n2(r.NetRate),
      overrideRate: n2(r.OverrideRate),
      commission: n2(r.Commission),
      componentSum: n2(r.ComponentSum),
      diff: n2(r.Diff)
    }));
  }

  static async computeGroupProductBucketsForPeriod(groupId, periodStart, periodEnd) {
    const pool = await getPool();
    const result = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('periodStart', sql.Date, periodStart)
      .input('periodEnd', sql.Date, periodEnd)
      .query(`
        SELECT
          SUM(COALESCE(e.NetRate, 0)) AS NetRate,
          SUM(COALESCE(e.OverrideRate, 0)) AS OverrideRate,
          SUM(COALESCE(e.Commission, 0)) AS Commission
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.GroupId = @groupId
          AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
          AND CAST(e.EffectiveDate AS DATE) <= @periodEnd
          AND (e.TerminationDate IS NULL OR e.TerminationDate > @periodStart)
          AND e.Commission IS NOT NULL
      `);

    const row = result.recordset?.[0] || {};
    return {
      netRate: n2(row.NetRate),
      overrideRate: n2(row.OverrideRate),
      commission: n2(row.Commission)
    };
  }

  static async computeGroupEnrolledHouseholdsCountForPeriod(groupId, periodStart, periodEnd) {
    const pool = await getPool();
    const result = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('periodStart', sql.Date, periodStart)
      .input('periodEnd', sql.Date, periodEnd)
      .query(`
        SELECT
          COUNT(DISTINCT e.HouseholdId) AS EnrolledHouseholdsCount
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        WHERE m.GroupId = @groupId
          AND e.HouseholdId IS NOT NULL
          AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
          AND CAST(e.EffectiveDate AS DATE) <= @periodEnd
          AND (e.TerminationDate IS NULL OR e.TerminationDate > @periodStart)
      `);

    const row = result.recordset?.[0] || {};
    return Number(row.EnrolledHouseholdsCount) || 0;
  }

  static async computeHouseholdEnrolledHouseholdsCountAsOf(householdId, asOfDate) {
    const pool = await getPool();
    const result = await pool.request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .input('asOfDate', sql.DateTime, asOfDate)
      .query(`
        SELECT
          COUNT(DISTINCT e.HouseholdId) AS EnrolledHouseholdsCount
        FROM oe.Enrollments e
        WHERE e.HouseholdId = @householdId
          AND e.HouseholdId IS NOT NULL
          AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
          AND e.EffectiveDate <= @asOfDate
          AND (e.TerminationDate IS NULL OR e.TerminationDate > @asOfDate)
      `);

    const row = result.recordset?.[0] || {};
    return Number(row.EnrolledHouseholdsCount) || 0;
  }

  static async computeHouseholdFeeBuckets(householdId, asOfDate) {
    const pool = await getPool();
    return getHouseholdFeeBucketsAsOf(pool, householdId, asOfDate, sql);
  }

  static async computeGroupHouseholdProductBreakdownForPeriod(groupId, periodStart, periodEnd, limitHouseholds = 5000) {
    const pool = await getPool();
    const result = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('periodStart', sql.Date, periodStart)
      .input('periodEnd', sql.Date, periodEnd)
      .input('limitHouseholds', sql.Int, Math.max(1, Math.min(20000, Number(limitHouseholds) || 5000)))
      .query(`
        ;WITH PrimaryMembers AS (
          SELECT TOP (@limitHouseholds)
            pm.HouseholdId,
            pm.MemberId AS PrimaryMemberId,
            u.UserId AS PrimaryUserId,
            ISNULL(u.FirstName + ' ' + u.LastName, '') AS PrimaryMemberName,
            u.Email AS PrimaryMemberEmail
          FROM oe.Members pm
          INNER JOIN oe.Users u ON pm.UserId = u.UserId
          WHERE pm.GroupId = @groupId
            AND pm.MemberSequence = 1
            AND pm.Status != 'Terminated'
            AND pm.HouseholdId IS NOT NULL
          ORDER BY u.LastName, u.FirstName
        ),
        HouseholdFeeAgg AS (
          SELECT
            pm.HouseholdId,
            SUM(CASE WHEN e.EnrollmentType = 'SystemFee' THEN COALESCE(e.PremiumAmount, 0) ELSE 0 END) AS SystemFeeAmount,
            SUM(CASE WHEN e.EnrollmentType = 'SystemFee' AND COALESCE(e.PremiumAmount, 0) <> 0 THEN 1 ELSE 0 END) AS SystemFeeCount,
            SUM(CASE WHEN e.EnrollmentType = 'PaymentProcessingFee' THEN COALESCE(e.PremiumAmount, 0) ELSE 0 END)
            + SUM(CASE WHEN (e.EnrollmentType IS NULL OR e.EnrollmentType = 'Product')
              AND e.ProductId IS NOT NULL AND e.ProductId != '${ZERO_GUID}'
              THEN COALESCE(e.IncludedPaymentProcessingFeeAmount, 0) ELSE 0 END) AS ProcessingFeeAmount,
            SUM(CASE WHEN e.EnrollmentType = 'PaymentProcessingFee' AND COALESCE(e.PremiumAmount, 0) <> 0 THEN 1 ELSE 0 END) AS ProcessingFeeCount
          FROM PrimaryMembers pm
          INNER JOIN oe.Enrollments e ON e.HouseholdId = pm.HouseholdId
          WHERE (
            e.EnrollmentType IN ('SystemFee', 'PaymentProcessingFee')
            OR ((e.EnrollmentType IS NULL OR e.EnrollmentType = 'Product')
              AND e.ProductId IS NOT NULL AND e.ProductId != '${ZERO_GUID}')
          )
            AND CAST(e.EffectiveDate AS DATE) <= @periodEnd
            AND (e.TerminationDate IS NULL OR e.TerminationDate > @periodStart)
          GROUP BY pm.HouseholdId
        ),
        HouseholdFlags AS (
          SELECT
            pm.HouseholdId,
            MAX(CASE WHEN CAST(e.CreatedDate AS DATE) > CAST(e.EffectiveDate AS DATE) THEN 1 ELSE 0 END) AS HasCreatedAfterEffective,
            SUM(CASE WHEN CAST(e.CreatedDate AS DATE) > CAST(e.EffectiveDate AS DATE) THEN 1 ELSE 0 END) AS CreatedAfterEffectiveCount
          FROM PrimaryMembers pm
          INNER JOIN oe.Enrollments e ON e.HouseholdId = pm.HouseholdId
          WHERE (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
            AND e.ProductId IS NOT NULL
            AND e.ProductId != '${ZERO_GUID}'
            AND CAST(e.EffectiveDate AS DATE) <= @periodEnd
            AND (e.TerminationDate IS NULL OR e.TerminationDate > @periodStart)
            AND e.CreatedDate IS NOT NULL
          GROUP BY pm.HouseholdId
        )
        SELECT
          pm.HouseholdId,
          pm.PrimaryMemberId,
          pm.PrimaryUserId,
          pm.PrimaryMemberName,
          pm.PrimaryMemberEmail,
          ISNULL(hf.HasCreatedAfterEffective, 0) AS HasCreatedAfterEffective,
          ISNULL(hf.CreatedAfterEffectiveCount, 0) AS CreatedAfterEffectiveCount,
          ISNULL(hfa.SystemFeeAmount, 0) AS SystemFeeAmount,
          ISNULL(hfa.SystemFeeCount, 0) AS SystemFeeCount,
          ISNULL(hfa.ProcessingFeeAmount, 0) AS ProcessingFeeAmount,
          ISNULL(hfa.ProcessingFeeCount, 0) AS ProcessingFeeCount,
          e.ProductId,
          pr.Name AS ProductName,
          CASE WHEN EXISTS (SELECT 1 FROM oe.ProductBundles b WHERE b.BundleProductId = e.ProductId AND b.BundleProductId IS NOT NULL) THEN 1 ELSE 0 END AS IsBundleProduct,
          COUNT(*) AS EnrollmentCount,
          SUM(COALESCE(e.PremiumAmount, 0)) AS PremiumAmount,
          SUM(COALESCE(e.NetRate, 0)) AS NetRate,
          SUM(COALESCE(e.OverrideRate, 0)) AS OverrideRate,
          SUM(COALESCE(e.Commission, 0)) AS Commission
        FROM PrimaryMembers pm
        LEFT JOIN HouseholdFlags hf ON pm.HouseholdId = hf.HouseholdId
        LEFT JOIN HouseholdFeeAgg hfa ON pm.HouseholdId = hfa.HouseholdId
        INNER JOIN oe.Enrollments e ON e.HouseholdId = pm.HouseholdId
        LEFT JOIN oe.Products pr ON e.ProductId = pr.ProductId
        WHERE (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
          AND e.ProductId IS NOT NULL
          AND e.ProductId != '${ZERO_GUID}'
          AND CAST(e.EffectiveDate AS DATE) <= @periodEnd
          AND (e.TerminationDate IS NULL OR e.TerminationDate > @periodStart)
        GROUP BY
          pm.HouseholdId,
          pm.PrimaryMemberId,
          pm.PrimaryUserId,
          pm.PrimaryMemberName,
          pm.PrimaryMemberEmail,
          hf.HasCreatedAfterEffective,
          hf.CreatedAfterEffectiveCount,
          hfa.SystemFeeAmount,
          hfa.SystemFeeCount,
          hfa.ProcessingFeeAmount,
          hfa.ProcessingFeeCount,
          e.ProductId,
          pr.Name
        HAVING SUM(COALESCE(e.PremiumAmount, 0)) > 0
        ORDER BY pm.PrimaryMemberName, pr.Name
      `);

    const householdsById = new Map();

    for (const row of result.recordset || []) {
      const householdId = row.HouseholdId?.toString();
      if (!householdId) continue;

      if (!householdsById.has(householdId)) {
        householdsById.set(householdId, {
          householdId,
          primaryMember: {
            memberId: row.PrimaryMemberId?.toString() || null,
            userId: row.PrimaryUserId?.toString() || null,
            name: row.PrimaryMemberName || null,
            email: row.PrimaryMemberEmail || null
          },
          flags: {
            hasCreatedAfterEffective: row.HasCreatedAfterEffective === 1,
            createdAfterEffectiveCount: Number(row.CreatedAfterEffectiveCount) || 0,
            hasMultipleSystemFees: Number(row.SystemFeeCount) > 1,
            hasMultipleProcessingFees: Number(row.ProcessingFeeCount) > 1
          },
          fees: {
            systemFee: {
              count: Number(row.SystemFeeCount) || 0,
              amount: n2(row.SystemFeeAmount)
            },
            processingFee: {
              count: Number(row.ProcessingFeeCount) || 0,
              amount: n2(row.ProcessingFeeAmount)
            }
          },
          products: []
        });
      }

      const premiumAmount = n2(row.PremiumAmount);
      const netRate = n2(row.NetRate);
      const overrideRate = n2(row.OverrideRate);
      const commission = n2(row.Commission);
      const componentSum = n2(netRate + overrideRate + commission);
      const diff = n2(premiumAmount - componentSum);

      householdsById.get(householdId).products.push({
        productId: row.ProductId?.toString()?.toUpperCase() || null,
        productName: row.ProductName || null,
        isBundleProduct: row.IsBundleProduct === 1,
        enrollmentCount: Number(row.EnrollmentCount) || 0,
        premiumAmount,
        netRate,
        overrideRate,
        commission,
        componentSum,
        diff
      });
    }

    return Array.from(householdsById.values());
  }

  static async computeHouseholdProductBreakdownAsOf(householdId, asOfDate) {
    const pool = await getPool();
    const result = await pool.request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .input('asOfDate', sql.DateTime, asOfDate)
      .query(`
        SELECT
          e.ProductId,
          pr.Name AS ProductName,
          CASE WHEN EXISTS (SELECT 1 FROM oe.ProductBundles b WHERE b.BundleProductId = e.ProductId AND b.BundleProductId IS NOT NULL) THEN 1 ELSE 0 END AS IsBundleProduct,
          COUNT(*) AS EnrollmentCount,
          SUM(COALESCE(e.PremiumAmount, 0)) AS PremiumAmount,
          SUM(COALESCE(e.NetRate, 0)) AS NetRate,
          SUM(COALESCE(e.OverrideRate, 0)) AS OverrideRate,
          SUM(COALESCE(e.Commission, 0)) AS Commission
        FROM oe.Enrollments e
        LEFT JOIN oe.Products pr ON e.ProductId = pr.ProductId
        WHERE e.HouseholdId = @householdId
          AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
          AND e.ProductId IS NOT NULL
          AND e.ProductId != '${ZERO_GUID}'
          AND e.EffectiveDate <= @asOfDate
          AND (e.TerminationDate IS NULL OR e.TerminationDate > @asOfDate)
        GROUP BY e.ProductId, pr.Name
        HAVING SUM(COALESCE(e.PremiumAmount, 0)) > 0
        ORDER BY pr.Name
      `);

    return (result.recordset || []).map((row) => {
      const premiumAmount = n2(row.PremiumAmount);
      const netRate = n2(row.NetRate);
      const overrideRate = n2(row.OverrideRate);
      const commission = n2(row.Commission);
      const componentSum = n2(netRate + overrideRate + commission);
      const diff = n2(premiumAmount - componentSum);
      return {
        productId: row.ProductId?.toString()?.toUpperCase() || null,
        productName: row.ProductName || null,
        isBundleProduct: row.IsBundleProduct === 1,
        enrollmentCount: Number(row.EnrollmentCount) || 0,
        premiumAmount,
        netRate,
        overrideRate,
        commission,
        componentSum,
        diff
      };
    });
  }

  static async computeGroupFeeBucketsForPeriod(groupId, periodStart, periodEnd) {
    const pool = await getPool();
    return getGroupFeeBucketsForPeriod(pool, groupId, periodStart, periodEnd, sql);
  }

  static async computeHouseholdProductJson(householdId, asOfDate) {
    const pool = await getPool();
    const result = await buildHouseholdProductSnapshots(pool, householdId, asOfDate, null);
    if (!result) {
      return {
        productCommissions: {},
        productVendorAmounts: {},
        productOwnerAmounts: {},
        productCommissionsJSON: '{}',
        productVendorAmountsJSON: '{}',
        productOwnerAmountsJSON: '{}'
      };
    }
    return result;
  }

  static async computeEnrollmentProductJson(enrollmentId, asOfDate) {
    const pool = await getPool();
    const result = await buildEnrollmentProductSnapshots(pool, enrollmentId, asOfDate, null);
    if (!result) {
      return {
        productCommissions: {},
        productVendorAmounts: {},
        productOwnerAmounts: {},
        productCommissionsJSON: '{}',
        productVendorAmountsJSON: '{}',
        productOwnerAmountsJSON: '{}'
      };
    }
    return result;
  }

  static async computeHouseholdFeeSummaryAsOf(householdId, asOfDate) {
    const pool = await getPool();
    const result = await pool.request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .input('asOfDate', sql.DateTime, asOfDate)
      .query(`
        SELECT
          SUM(CASE WHEN e.EnrollmentType = 'SystemFee' THEN COALESCE(e.PremiumAmount, 0) ELSE 0 END) AS SystemFeeAmount,
          SUM(CASE WHEN e.EnrollmentType = 'SystemFee' AND COALESCE(e.PremiumAmount, 0) <> 0 THEN 1 ELSE 0 END) AS SystemFeeCount,
          SUM(CASE WHEN e.EnrollmentType = 'PaymentProcessingFee' THEN COALESCE(e.PremiumAmount, 0) ELSE 0 END)
          + SUM(CASE WHEN (e.EnrollmentType IS NULL OR e.EnrollmentType = 'Product')
            AND e.ProductId IS NOT NULL AND e.ProductId != '${ZERO_GUID}'
            THEN COALESCE(e.IncludedPaymentProcessingFeeAmount, 0) ELSE 0 END) AS ProcessingFeeAmount,
          SUM(CASE WHEN e.EnrollmentType = 'PaymentProcessingFee' AND COALESCE(e.PremiumAmount, 0) <> 0 THEN 1 ELSE 0 END) AS ProcessingFeeCount
        FROM oe.Enrollments e
        WHERE e.HouseholdId = @householdId
          AND e.EffectiveDate <= @asOfDate
          AND (e.TerminationDate IS NULL OR e.TerminationDate > @asOfDate)
          AND (
            e.EnrollmentType IN ('SystemFee', 'PaymentProcessingFee')
            OR ((e.EnrollmentType IS NULL OR e.EnrollmentType = 'Product')
              AND e.ProductId IS NOT NULL AND e.ProductId != '${ZERO_GUID}')
          )
      `);

    const row = result.recordset?.[0] || {};
    return {
      systemFee: {
        count: Number(row.SystemFeeCount) || 0,
        amount: n2(row.SystemFeeAmount)
      },
      processingFee: {
        count: Number(row.ProcessingFeeCount) || 0,
        amount: n2(row.ProcessingFeeAmount)
      }
    };
  }

  static async computeGroupHouseholdEnrollmentsLineItemsForPeriod(groupId, householdId, periodStart, periodEnd, limit = 2000) {
    const pool = await getPool();
    const result = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('householdId', sql.UniqueIdentifier, householdId)
      .input('periodStart', sql.Date, periodStart)
      .input('periodEnd', sql.Date, periodEnd)
      .input('limit', sql.Int, Math.max(1, Math.min(20000, Number(limit) || 2000)))
      .query(`
        SELECT TOP (@limit)
          e.EnrollmentId,
          e.MemberId,
          m.RelationshipType,
          m.MemberSequence,
          ISNULL(u.FirstName + ' ' + u.LastName, '') AS MemberName,
          e.HouseholdId,
          e.GroupId,
          e.EnrollmentType,
          e.ProductId,
          p.Name AS ProductName,
          e.Status,
          e.EffectiveDate,
          e.TerminationDate,
          e.CreatedDate,
          e.ModifiedDate,
          COALESCE(e.PremiumAmount, 0) AS PremiumAmount,
          COALESCE(e.NetRate, 0) AS NetRate,
          COALESCE(e.OverrideRate, 0) AS OverrideRate,
          COALESCE(e.Commission, 0) AS Commission,
          (COALESCE(e.NetRate,0) + COALESCE(e.OverrideRate,0) + COALESCE(e.Commission,0)) AS ComponentSum,
          (COALESCE(e.PremiumAmount,0) - (COALESCE(e.NetRate,0) + COALESCE(e.OverrideRate,0) + COALESCE(e.Commission,0))) AS Diff
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        INNER JOIN oe.Users u ON m.UserId = u.UserId
        LEFT JOIN oe.Products p ON e.ProductId = p.ProductId
        WHERE m.GroupId = @groupId
          AND e.HouseholdId = @householdId
          AND CAST(e.EffectiveDate AS DATE) <= @periodEnd
          AND (e.TerminationDate IS NULL OR e.TerminationDate > @periodStart)
        ORDER BY
          CASE
            WHEN e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL THEN 0
            WHEN e.EnrollmentType = 'SystemFee' THEN 1
            WHEN e.EnrollmentType = 'PaymentProcessingFee' THEN 2
            WHEN e.EnrollmentType = 'SetupFee' THEN 3
            ELSE 9
          END,
          p.Name,
          m.MemberSequence,
          u.LastName,
          u.FirstName
      `);

    return (result.recordset || []).map((r) => ({
      enrollmentId: r.EnrollmentId,
      memberId: r.MemberId,
      relationshipType: r.RelationshipType || null,
      memberSequence: Number(r.MemberSequence) || null,
      memberName: r.MemberName || null,
      householdId: r.HouseholdId,
      groupId: r.GroupId || null,
      enrollmentType: r.EnrollmentType || null,
      productId: r.ProductId || null,
      productName: r.ProductName || null,
      status: r.Status || null,
      effectiveDate: r.EffectiveDate || null,
      terminationDate: r.TerminationDate || null,
      createdDate: r.CreatedDate || null,
      modifiedDate: r.ModifiedDate || null,
      premiumAmount: n2(r.PremiumAmount),
      netRate: n2(r.NetRate),
      overrideRate: n2(r.OverrideRate),
      commission: n2(r.Commission),
      componentSum: n2(r.ComponentSum),
      diff: n2(r.Diff)
    }));
  }

  static async computeHouseholdEnrollmentsLineItemsAsOf(householdId, asOfDate, limit = 2000) {
    const pool = await getPool();
    const result = await pool.request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .input('asOfDate', sql.DateTime, asOfDate)
      .input('limit', sql.Int, Math.max(1, Math.min(20000, Number(limit) || 2000)))
      .query(`
        SELECT TOP (@limit)
          e.EnrollmentId,
          e.MemberId,
          m.RelationshipType,
          m.MemberSequence,
          ISNULL(u.FirstName + ' ' + u.LastName, '') AS MemberName,
          e.HouseholdId,
          e.GroupId,
          e.EnrollmentType,
          e.ProductId,
          p.Name AS ProductName,
          e.Status,
          e.EffectiveDate,
          e.TerminationDate,
          e.CreatedDate,
          e.ModifiedDate,
          COALESCE(e.PremiumAmount, 0) AS PremiumAmount,
          COALESCE(e.NetRate, 0) AS NetRate,
          COALESCE(e.OverrideRate, 0) AS OverrideRate,
          COALESCE(e.Commission, 0) AS Commission,
          (COALESCE(e.NetRate,0) + COALESCE(e.OverrideRate,0) + COALESCE(e.Commission,0)) AS ComponentSum,
          (COALESCE(e.PremiumAmount,0) - (COALESCE(e.NetRate,0) + COALESCE(e.OverrideRate,0) + COALESCE(e.Commission,0))) AS Diff
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        INNER JOIN oe.Users u ON m.UserId = u.UserId
        LEFT JOIN oe.Products p ON e.ProductId = p.ProductId
        WHERE e.HouseholdId = @householdId
          AND e.EffectiveDate <= @asOfDate
          AND (e.TerminationDate IS NULL OR e.TerminationDate > @asOfDate)
        ORDER BY
          CASE
            WHEN e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL THEN 0
            WHEN e.EnrollmentType = 'SystemFee' THEN 1
            WHEN e.EnrollmentType = 'PaymentProcessingFee' THEN 2
            WHEN e.EnrollmentType = 'SetupFee' THEN 3
            ELSE 9
          END,
          p.Name,
          m.MemberSequence,
          u.LastName,
          u.FirstName
      `);

    return (result.recordset || []).map((r) => ({
      enrollmentId: r.EnrollmentId,
      memberId: r.MemberId,
      relationshipType: r.RelationshipType || null,
      memberSequence: Number(r.MemberSequence) || null,
      memberName: r.MemberName || null,
      householdId: r.HouseholdId,
      groupId: r.GroupId || null,
      enrollmentType: r.EnrollmentType || null,
      productId: r.ProductId || null,
      productName: r.ProductName || null,
      status: r.Status || null,
      effectiveDate: r.EffectiveDate || null,
      terminationDate: r.TerminationDate || null,
      createdDate: r.CreatedDate || null,
      modifiedDate: r.ModifiedDate || null,
      premiumAmount: n2(r.PremiumAmount),
      netRate: n2(r.NetRate),
      overrideRate: n2(r.OverrideRate),
      commission: n2(r.Commission),
      componentSum: n2(r.ComponentSum),
      diff: n2(r.Diff)
    }));
  }

  static async computeGroupProductJsonForPeriod(groupId, periodStart, periodEnd) {
    const pool = await getPool();
    const result = await buildGroupProductSnapshotsForPeriod(pool, groupId, periodStart, periodEnd, null);
    if (!result) {
      return {
        productCommissions: {},
        productVendorAmounts: {},
        productOwnerAmounts: {},
        productCommissionsJSON: '{}',
        productVendorAmountsJSON: '{}',
        productOwnerAmountsJSON: '{}'
      };
    }
    return result;
  }

  static async computePaymentAllocation({ paymentId, tenantId }) {
    const payment = await PaymentAuditService.getPaymentForTenant(paymentId, tenantId);
    if (!payment) return null;

    let asOfDate = payment.PaymentDate || payment.CreatedDate || new Date();

    let groupId = payment.GroupId || null;
    let householdId = payment.HouseholdId || null;

    if (!groupId && !householdId && payment.EnrollmentId) {
      const ctx = await PaymentAuditService.resolveContextFromEnrollment(payment.EnrollmentId);
      groupId = ctx.groupId;
      householdId = ctx.householdId;
    }

    // ACH/CC and other enrollment-scoped rows often have GroupId + HouseholdId + EnrollmentId.
    // Those must audit against one household's enrollments, not the entire group (same shared bucket helpers;
    // context chooses group-wide vs household aggregation).
    const memberScopedHousehold =
      !!householdId && !!payment.EnrollmentId && !payment.InvoiceId;
    // Individual payments can be enrollment-linked while still charging the full household bundle.
    // Audit should reflect household-level allocation for consistency with stored payment buckets.
    const context = memberScopedHousehold ? 'household' : groupId ? 'group' : 'household';

    // For household (individual) payments without an invoice, the payment is typically for coverage
    // starting the next month. Use end of the month following the payment date so enrollments
    // with EffectiveDate = first of next month are included (e.g. payment Feb 23 for March 1 coverage).
    if (context === 'household' && householdId && !payment.InvoiceId) {
      const d = asOfDate instanceof Date ? new Date(asOfDate.getTime()) : new Date(asOfDate);
      const y = d.getUTCFullYear();
      const m = d.getUTCMonth();
      asOfDate = new Date(Date.UTC(y, m + 2, 0)); // last day of next month
    }

    // For group payments, use the invoice billing period when available (matches existing group billing logic).
    // Fallback is the payment's month (start/end) if InvoiceId is missing.
    let billingPeriodStart = null;
    let billingPeriodEnd = null;
    if (context === 'group' && groupId) {
      const invoicePeriod = await PaymentAuditService.getInvoicePeriod(payment.InvoiceId);
      if (invoicePeriod?.billingPeriodStart && invoicePeriod?.billingPeriodEnd) {
        billingPeriodStart = invoicePeriod.billingPeriodStart;
        billingPeriodEnd = invoicePeriod.billingPeriodEnd;
      } else {
        // Month fallback derived from payment date (UTC)
        const d = asOfDate instanceof Date ? asOfDate : new Date(asOfDate);
        const y = d.getUTCFullYear();
        const m = d.getUTCMonth();
        billingPeriodStart = new Date(Date.UTC(y, m, 1));
        billingPeriodEnd = new Date(Date.UTC(y, m + 1, 0));
      }
    }

    const enrolledHouseholdsCount =
      context === 'group'
        ? await PaymentAuditService.computeGroupEnrolledHouseholdsCountForPeriod(groupId, billingPeriodStart, billingPeriodEnd)
        : householdId
          ? await PaymentAuditService.computeHouseholdEnrolledHouseholdsCountAsOf(householdId, asOfDate)
          : 0;

    const enrollmentPremiumMismatches =
      context === 'group'
        ? await PaymentAuditService.computeGroupEnrollmentPremiumMismatchesForPeriod(groupId, billingPeriodStart, billingPeriodEnd)
        : householdId
          ? await PaymentAuditService.computeHouseholdEnrollmentPremiumMismatchesAsOf(householdId, asOfDate)
          : [];

    const productBuckets =
      context === 'group'
        ? await PaymentAuditService.computeGroupProductBucketsForPeriod(groupId, billingPeriodStart, billingPeriodEnd)
        : householdId
          ? await PaymentAuditService.computeHouseholdProductBuckets(householdId, asOfDate)
          : payment.EnrollmentId
            ? await PaymentAuditService.computeEnrollmentProductBuckets(payment.EnrollmentId, asOfDate)
            : { netRate: 0, overrideRate: 0, commission: 0 };

    const feeBuckets =
      context === 'group'
        ? await PaymentAuditService.computeGroupFeeBucketsForPeriod(groupId, billingPeriodStart, billingPeriodEnd)
        : householdId
          ? await PaymentAuditService.computeHouseholdFeeBuckets(householdId, asOfDate)
          : { systemFees: 0, processingFeeAmount: 0, setupFee: 0 };

    const productJson =
      context === 'group'
        ? await PaymentAuditService.computeGroupProductJsonForPeriod(groupId, billingPeriodStart, billingPeriodEnd)
        : householdId
          ? await PaymentAuditService.computeHouseholdProductJson(householdId, asOfDate)
          : payment.EnrollmentId
            ? await PaymentAuditService.computeEnrollmentProductJson(payment.EnrollmentId, asOfDate)
            : {
        productCommissions: {},
        productVendorAmounts: {},
        productOwnerAmounts: {},
        productCommissionsJSON: '{}',
        productVendorAmountsJSON: '{}',
        productOwnerAmountsJSON: '{}'
      };

    const computed = {
      netRate: productBuckets.netRate,
      overrideRate: productBuckets.overrideRate,
      commission: productBuckets.commission,
      systemFees: feeBuckets.systemFees,
      processingFeeAmount: feeBuckets.processingFeeAmount,
      setupFee: feeBuckets.setupFee,
      productCommissionsJSON: productJson.productCommissionsJSON,
      productVendorAmountsJSON: productJson.productVendorAmountsJSON,
      productOwnerAmountsJSON: productJson.productOwnerAmountsJSON
    };

    const computedSum = n2(
      computed.netRate +
      computed.overrideRate +
      computed.commission +
      computed.systemFees +
      computed.processingFeeAmount +
      computed.setupFee
    );

    const amount = n2(payment.Amount);
    const amountDiff = n2(amount - computedSum);

    // Use resolved groupId/householdId in the returned payment so audit/households and
    // audit/households/:householdId/enrollments work for individual payments that only have EnrollmentId.
    const effectiveGroupId = groupId || payment.GroupId || null;
    const effectiveHouseholdId = householdId || payment.HouseholdId || null;

    return {
      context,
      asOfDate,
      billingPeriod: context === 'group' ? { startDate: billingPeriodStart, endDate: billingPeriodEnd } : null,
      identified: {
        enrolledHouseholdsCount
      },
      warnings: {
        enrollmentPremiumMismatches: {
          count: enrollmentPremiumMismatches.length,
          rows: enrollmentPremiumMismatches
        }
      },
      payment: {
        PaymentId: payment.PaymentId,
        TenantId: payment.TenantId,
        GroupId: effectiveGroupId,
        HouseholdId: effectiveHouseholdId,
        EnrollmentId: payment.EnrollmentId,
        InvoiceId: payment.InvoiceId || null,
        LocationId: payment.LocationId || null,
        Amount: n2(payment.Amount),
        Status: payment.Status,
        PaymentDate: payment.PaymentDate,
        CreatedDate: payment.CreatedDate,
        ModifiedDate: payment.ModifiedDate,
        Processor: payment.Processor || null,
        ProcessorTransactionId: payment.ProcessorTransactionId
          ? String(payment.ProcessorTransactionId).trim()
          : null,
        PaymentMethod: payment.PaymentMethod || null,
        RecurringScheduleId: payment.RecurringScheduleId || null,
        NetRate: n2(payment.NetRate),
        OverrideRate: n2(payment.OverrideRate),
        Commission: n2(payment.Commission),
        SystemFees: n2(payment.SystemFees),
        ProcessingFeeAmount: n2(payment.ProcessingFeeAmount),
        SetupFee: n2(payment.SetupFee),
        ProductCommissions: payment.ProductCommissions,
        ProductVendorAmounts: payment.ProductVendorAmounts,
        ProductOwnerAmounts: payment.ProductOwnerAmounts
      },
      computed,
      totals: {
        computedSum,
        amount,
        amountDiff
      }
    };
  }

  static async applyCorrection({ paymentId, tenantId, computed, transaction }) {
    const pool = await getPool();
    const req = transaction ? transaction.request() : pool.request();

    const result = await req
      .input('paymentId', sql.UniqueIdentifier, paymentId)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('netRate', sql.Decimal(18, 2), computed.netRate)
      .input('overrideRate', sql.Decimal(18, 2), computed.overrideRate)
      .input('commission', sql.Decimal(18, 2), computed.commission)
      .input('systemFees', sql.Decimal(18, 2), computed.systemFees)
      .input('processingFeeAmount', sql.Decimal(10, 2), computed.processingFeeAmount)
      .input('setupFee', sql.Decimal(18, 2), computed.setupFee)
      .input('productCommissions', sql.NVarChar(sql.MAX), computed.productCommissionsJSON)
      .input('productVendorAmounts', sql.NVarChar(sql.MAX), computed.productVendorAmountsJSON)
      .input('productOwnerAmounts', sql.NVarChar(sql.MAX), computed.productOwnerAmountsJSON)
      .query(`
        UPDATE oe.Payments
        SET
          NetRate = @netRate,
          OverrideRate = @overrideRate,
          Commission = @commission,
          SystemFees = @systemFees,
          ProcessingFeeAmount = @processingFeeAmount,
          SetupFee = @setupFee,
          ProductCommissions = @productCommissions,
          ProductVendorAmounts = @productVendorAmounts,
          ProductOwnerAmounts = @productOwnerAmounts,
          ModifiedDate = GETUTCDATE()
        WHERE PaymentId = @paymentId
          AND TenantId = @tenantId
      `);

    return result?.rowsAffected?.[0] || 0;
  }

  // =========================================================================
  // Invoice Audit – mirrors computePaymentAllocation but reads oe.Invoices
  // =========================================================================

  static async getInvoiceForTenant(invoiceId, tenantId) {
    const pool = await getPool();
    const result = await pool.request()
      .input('invoiceId', sql.UniqueIdentifier, invoiceId)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT InvoiceId, TenantId, GroupId, HouseholdId, InvoiceType,
               TotalAmount, PaidAmount, Status, InvoiceNumber,
               BillingPeriodStart, BillingPeriodEnd, DueDate,
               NetRate, OverrideRate, Commission, SystemFees, ProcessingFeeAmount, SetupFee,
               ProductCommissions, ProductVendorAmounts, ProductOwnerAmounts,
               CreatedDate, ModifiedDate
        FROM oe.Invoices
        WHERE InvoiceId = @invoiceId AND TenantId = @tenantId
      `);
    return result.recordset[0] || null;
  }

  static async computeInvoiceAllocation({ invoiceId, tenantId }) {
    const invoice = await PaymentAuditService.getInvoiceForTenant(invoiceId, tenantId);
    if (!invoice) return null;

    const groupId = invoice.GroupId || null;
    const householdId = invoice.HouseholdId || null;
    const context = groupId ? 'group' : 'household';

    const billingPeriodStart = invoice.BillingPeriodStart;
    const billingPeriodEnd = invoice.BillingPeriodEnd;

    let productBuckets, feeBuckets, productJson;

    if (context === 'group' && groupId) {
      productBuckets = await PaymentAuditService.computeGroupProductBucketsForPeriod(groupId, billingPeriodStart, billingPeriodEnd);
      feeBuckets = await PaymentAuditService.computeGroupFeeBucketsForPeriod(groupId, billingPeriodStart, billingPeriodEnd);
      productJson = await PaymentAuditService.computeGroupProductJsonForPeriod(groupId, billingPeriodStart, billingPeriodEnd);
    } else if (householdId) {
      const asOf = billingPeriodEnd || new Date();
      productBuckets = await PaymentAuditService.computeHouseholdProductBuckets(householdId, asOf);
      feeBuckets = await PaymentAuditService.computeHouseholdFeeBuckets(householdId, asOf);
      productJson = await PaymentAuditService.computeHouseholdProductJson(householdId, asOf);
    } else {
      productBuckets = { netRate: 0, overrideRate: 0, commission: 0 };
      feeBuckets = { systemFees: 0, processingFeeAmount: 0, setupFee: 0 };
      productJson = { productCommissionsJSON: '{}', productVendorAmountsJSON: '{}', productOwnerAmountsJSON: '{}' };
    }

    const computed = {
      netRate: productBuckets.netRate,
      overrideRate: productBuckets.overrideRate,
      commission: productBuckets.commission,
      systemFees: feeBuckets.systemFees,
      processingFeeAmount: feeBuckets.processingFeeAmount,
      setupFee: feeBuckets.setupFee,
      productCommissionsJSON: productJson.productCommissionsJSON,
      productVendorAmountsJSON: productJson.productVendorAmountsJSON,
      productOwnerAmountsJSON: productJson.productOwnerAmountsJSON
    };

    const computedSum = n2(
      computed.netRate + computed.overrideRate + computed.commission +
      computed.systemFees + computed.processingFeeAmount + computed.setupFee
    );

    const totalAmount = n2(invoice.TotalAmount);
    const storedSum = n2(
      (Number(invoice.NetRate) || 0) + (Number(invoice.OverrideRate) || 0) + (Number(invoice.Commission) || 0) +
      (Number(invoice.SystemFees) || 0) + (Number(invoice.ProcessingFeeAmount) || 0) + (Number(invoice.SetupFee) || 0)
    );

    return {
      context,
      billingPeriod: { startDate: billingPeriodStart, endDate: billingPeriodEnd },
      invoice: {
        InvoiceId: invoice.InvoiceId,
        TenantId: invoice.TenantId,
        GroupId: groupId,
        HouseholdId: householdId,
        InvoiceType: invoice.InvoiceType,
        InvoiceNumber: invoice.InvoiceNumber,
        TotalAmount: totalAmount,
        PaidAmount: n2(invoice.PaidAmount),
        Status: invoice.Status,
        DueDate: invoice.DueDate,
        CreatedDate: invoice.CreatedDate,
        ModifiedDate: invoice.ModifiedDate,
        NetRate: n2(invoice.NetRate),
        OverrideRate: n2(invoice.OverrideRate),
        Commission: n2(invoice.Commission),
        SystemFees: n2(invoice.SystemFees),
        ProcessingFeeAmount: n2(invoice.ProcessingFeeAmount),
        SetupFee: n2(invoice.SetupFee),
        ProductCommissions: invoice.ProductCommissions,
        ProductVendorAmounts: invoice.ProductVendorAmounts,
        ProductOwnerAmounts: invoice.ProductOwnerAmounts
      },
      computed,
      totals: {
        computedSum,
        storedSum,
        totalAmount,
        computedVsTotalDiff: n2(totalAmount - computedSum),
        storedVsComputedDiff: n2(storedSum - computedSum)
      }
    };
  }

  static async applyInvoiceCorrection({ invoiceId, tenantId, computed }) {
    const pool = await getPool();
    const result = await pool.request()
      .input('invoiceId', sql.UniqueIdentifier, invoiceId)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('netRate', sql.Decimal(18, 6), computed.netRate)
      .input('overrideRate', sql.Decimal(18, 6), computed.overrideRate)
      .input('commission', sql.Decimal(18, 6), computed.commission)
      .input('systemFees', sql.Decimal(18, 6), computed.systemFees)
      .input('processingFeeAmount', sql.Decimal(18, 6), computed.processingFeeAmount)
      .input('setupFee', sql.Decimal(18, 6), computed.setupFee)
      .input('productCommissions', sql.NVarChar(sql.MAX), computed.productCommissionsJSON)
      .input('productVendorAmounts', sql.NVarChar(sql.MAX), computed.productVendorAmountsJSON)
      .input('productOwnerAmounts', sql.NVarChar(sql.MAX), computed.productOwnerAmountsJSON)
      .query(`
        UPDATE oe.Invoices
        SET NetRate = @netRate,
            OverrideRate = @overrideRate,
            Commission = @commission,
            SystemFees = @systemFees,
            ProcessingFeeAmount = @processingFeeAmount,
            SetupFee = @setupFee,
            ProductCommissions = @productCommissions,
            ProductVendorAmounts = @productVendorAmounts,
            ProductOwnerAmounts = @productOwnerAmounts,
            ModifiedDate = GETUTCDATE()
        WHERE InvoiceId = @invoiceId
          AND TenantId = @tenantId
      `);
    return result?.rowsAffected?.[0] || 0;
  }

  /**
   * Zero out NetRate, OverrideRate, Commission, fee buckets, and JSON fields on the
   * oe.Payments row for this payment only. Amount is never changed.
   * @returns {{ updated: number }} (0 or 1)
   */
  static async zeroPaymentSnapshotBuckets({ paymentId, tenantId }) {
    const pool = await getPool();
    const result = await pool.request()
      .input('paymentId', sql.UniqueIdentifier, paymentId)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        UPDATE oe.Payments
        SET NetRate = 0,
            OverrideRate = 0,
            Commission = 0,
            SystemFees = 0,
            ProcessingFeeAmount = 0,
            SetupFee = 0,
            ProductCommissions = NULL,
            ProductVendorAmounts = NULL,
            ProductOwnerAmounts = NULL,
            ModifiedDate = GETUTCDATE()
        WHERE PaymentId = @paymentId
          AND TenantId = @tenantId
      `);
    const updated = result?.rowsAffected?.[0] ?? 0;
    return { updated };
  }
}

module.exports = PaymentAuditService;

