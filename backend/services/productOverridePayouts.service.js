const { getPool, sql } = require('../config/database');

/**
 * Compute product override payout amounts per payment using the same logic as the
 * Product Overrides tab: enrollments (primary only) matched to oe.ProductOverrides
 * (ProductId + ProductPricingId, active, OverrideAmount > 0), ExpectedAmount = COUNT × po.OverrideAmount.
 *
 * @param {object} pool - SQL pool
 * @param {Array<{PaymentId, HouseholdId, GroupId, PaymentDate}>} payments - Payments with scope
 * @param {string} tenantId - Tenant ID (p.TenantId)
 * @returns {Promise<Map<string, Array>>} Map of paymentId -> override tenant payout entries for NACHA
 */
async function getProductOverridePayoutsByPayment(pool, payments, tenantId) {
  const byPayment = new Map();
  if (!payments.length || !tenantId) return byPayment;

  const paymentIds = payments.map((p) => p.PaymentId).filter(Boolean);
  if (!paymentIds.length) return byPayment;

  // Same enrollment/override logic as product-overrides tab (household + group): primary only, effective at PaymentDate
  const householdPayments = payments.filter((p) => p.HouseholdId != null);
  const groupPayments = payments.filter((p) => p.GroupId != null);

  const rows = [];

  if (householdPayments.length > 0) {
    const householdIds = householdPayments.map((p) => p.PaymentId.toString()).join(',');
    const req = pool.request();
    req.input('TenantId', sql.UniqueIdentifier, tenantId);
    req.input('PaymentIds', sql.VarChar, householdIds);
    const householdRows = await req.query(`
      SELECT
        p.PaymentId,
        po.OverrideId,
        po.OverrideACHId,
        po.TenantId as RecipientTenantId,
        po.ProductId,
        pr.Name as ProductName,
        po.OverrideName,
        po.OverrideAmount,
        COUNT(*) as EnrollmentCount,
        SUM(po.OverrideAmount) as ExpectedAmount
      FROM oe.Payments p
      INNER JOIN oe.Enrollments e ON e.HouseholdId = p.HouseholdId
        AND e.EffectiveDate <= p.PaymentDate
        AND (e.TerminationDate IS NULL OR e.TerminationDate > p.PaymentDate)
        AND e.ProductId IS NOT NULL
        AND e.ProductId != '00000000-0000-0000-0000-000000000000'
        AND e.ProductId NOT IN (
          SELECT DISTINCT BundleProductId
          FROM oe.ProductBundles
          WHERE BundleProductId IS NOT NULL
        )
        AND e.ProductPricingId IS NOT NULL
      INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        AND m.HouseholdId = p.HouseholdId
        AND m.RelationshipType = 'P'
      INNER JOIN oe.ProductOverrides po ON po.ProductId = e.ProductId
        AND po.ProductPricingId = e.ProductPricingId
        AND po.IsActive = 1
        AND po.EffectiveDate <= p.PaymentDate
        AND (po.ExpirationDate IS NULL OR po.ExpirationDate > p.PaymentDate)
        AND ISNULL(po.OverrideAmount, 0) > 0
      LEFT JOIN oe.Products pr ON pr.ProductId = po.ProductId
      WHERE p.TenantId = @TenantId
        AND p.HouseholdId IS NOT NULL
        AND p.PaymentId IN (SELECT TRY_CAST(value AS UNIQUEIDENTIFIER) FROM STRING_SPLIT(@PaymentIds, ',') WHERE LEN(RTRIM(value)) = 36)
      GROUP BY p.PaymentId, po.OverrideId, po.OverrideACHId, po.TenantId, po.ProductId, pr.Name, po.OverrideName, po.OverrideAmount
    `);
    rows.push(...(householdRows.recordset || []));
  }

  if (groupPayments.length > 0) {
    const groupIds = groupPayments.map((p) => p.PaymentId.toString()).join(',');
    const req = pool.request();
    req.input('TenantId', sql.UniqueIdentifier, tenantId);
    req.input('PaymentIds', sql.VarChar, groupIds);
    const groupResult = await req.query(`
      SELECT
        p.PaymentId,
        po.OverrideId,
        po.OverrideACHId,
        po.TenantId as RecipientTenantId,
        po.ProductId,
        pr.Name as ProductName,
        po.OverrideName,
        po.OverrideAmount,
        COUNT(*) as EnrollmentCount,
        SUM(po.OverrideAmount) as ExpectedAmount
      FROM oe.Payments p
      LEFT JOIN oe.Invoices inv ON inv.InvoiceId = p.InvoiceId
      INNER JOIN oe.Members m ON m.GroupId = p.GroupId
        AND m.TenantId = p.TenantId
        AND m.RelationshipType = 'P'
      INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
        AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
        -- Cohort-aware: prefer invoice billing period (supports 15th-14th periods);
        -- fall back to calendar-month derivation from PaymentDate for legacy payments.
        -- Lower bound on EffectiveDate intentionally dropped: group payments that span
        -- periods may include enrollments that pre-date this period; the upper bound +
        -- termination check are the load-bearing filters.
        AND e.EffectiveDate <= COALESCE(inv.BillingPeriodEnd, EOMONTH(p.PaymentDate))
        AND (e.TerminationDate IS NULL OR e.TerminationDate > COALESCE(inv.BillingPeriodStart, DATEADD(day, 1, EOMONTH(p.PaymentDate, -1))))
        AND e.ProductId IS NOT NULL
        AND e.ProductId != '00000000-0000-0000-0000-000000000000'
        AND e.ProductId NOT IN (
          SELECT DISTINCT BundleProductId
          FROM oe.ProductBundles
          WHERE BundleProductId IS NOT NULL
        )
        AND e.ProductPricingId IS NOT NULL
      INNER JOIN oe.ProductOverrides po ON po.ProductId = e.ProductId
        AND po.ProductPricingId = e.ProductPricingId
        AND po.IsActive = 1
        AND po.EffectiveDate <= p.PaymentDate
        AND (po.ExpirationDate IS NULL OR po.ExpirationDate > p.PaymentDate)
        AND ISNULL(po.OverrideAmount, 0) > 0
      LEFT JOIN oe.Products pr ON pr.ProductId = po.ProductId
      WHERE p.TenantId = @TenantId
        AND p.GroupId IS NOT NULL
        AND p.PaymentId IN (SELECT TRY_CAST(value AS UNIQUEIDENTIFIER) FROM STRING_SPLIT(@PaymentIds, ',') WHERE LEN(RTRIM(value)) = 36)
      GROUP BY p.PaymentId, po.OverrideId, po.OverrideACHId, po.TenantId, po.ProductId, pr.Name, po.OverrideName, po.OverrideAmount
    `);
    rows.push(...(groupResult.recordset || []));
  }

  // Aggregate by (PaymentId, TenantId, OverrideACHId) so one payout per recipient per payment (match tab aggregation)
  const key = (paymentId, tenantId, overrideACHId) =>
    `${paymentId}|${tenantId || ''}|${overrideACHId || ''}`;
  const agg = new Map();
  for (const r of rows) {
    const paymentId = r.PaymentId ? r.PaymentId.toString() : null;
    const tenantIdVal = r.RecipientTenantId ? r.RecipientTenantId.toString() : null;
    const overrideACHId = r.OverrideACHId ? r.OverrideACHId.toString() : null;
    const expectedAmount = Number(r.ExpectedAmount || 0);
    if (!paymentId || !tenantIdVal || expectedAmount <= 0) continue;
    const k = key(paymentId, tenantIdVal, overrideACHId);
    if (!agg.has(k)) {
      agg.set(k, {
        paymentId,
        tenantId: tenantIdVal,
        overrideId: r.OverrideId ? r.OverrideId.toString() : null,
        overrideACHId,
        amount: 0,
        ruleName: r.OverrideName ? `Override - ${r.OverrideName}` : 'Override',
        productId: r.ProductId ? r.ProductId.toString() : null,
        productName: r.ProductName || null
      });
    }
    agg.get(k).amount += expectedAmount;
  }

  for (const v of agg.values()) {
    v.amount = Math.round(v.amount * 100) / 100;
    if (!byPayment.has(v.paymentId)) byPayment.set(v.paymentId, []);
    byPayment.get(v.paymentId).push({
      tenantId: v.tenantId,
      tenantName: null,
      amount: v.amount,
      ruleId: v.overrideId,
      ruleName: v.ruleName,
      isOverride: true,
      productId: v.productId,
      productName: v.productName,
      overrideId: v.overrideId,
      overrideAchId: v.overrideACHId
    });
  }

  return byPayment;
}

module.exports = { getProductOverridePayoutsByPayment };
