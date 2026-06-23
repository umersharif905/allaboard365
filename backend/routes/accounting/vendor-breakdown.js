const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../config/database');
const requireTenantAccess = require('../../middleware/requireTenantAccess');
const { getUserRoles } = require('../../middleware/auth');
const { requireShared } = require('../../config/shared-modules');
const {
  householdAsOfDate,
  resolveGroupPeriodFromInvoiceOrPaymentDate
} = requireShared('payment-product-snapshots');
const clawbackBalances = require('../../services/clawbackBalances.service');
const PayoutClawbacks = require('../../services/payoutClawbacks.service');
const {
  PAID_PAYMENT_STATUSES_SQL,
  PAID_INVOICE_STATUS,
} = require('../../constants/paymentStatuses');
const {
  paymentInWindowSql,
  invoicePayoutWindowSql,
} = require('../../services/payoutFunding.service');

/**
 * Read the vendor payout basis from tenant AdvancedSettings.
 * Returns 'effectiveEnrollment' or 'paymentReceived'.
 */
async function getVendorPayoutBasis(tenantId) {
  try {
    const pool = await getPool();
    const req = pool.request();
    req.input('TenantId', sql.UniqueIdentifier, tenantId);
    const result = await req.query('SELECT AdvancedSettings FROM oe.Tenants WHERE TenantId = @TenantId');
    if (result.recordset.length) {
      const raw = result.recordset[0].AdvancedSettings;
      const adv = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
      return adv?.payouts?.vendorBasis || 'effectiveEnrollment';
    }
  } catch (e) { /* default */ }
  return 'effectiveEnrollment';
}

/**
 * Build the date-filter SQL fragment based on payout basis.
 * 'effectiveEnrollment' → filter by invoice BillingPeriod (fallback to PaymentDate).
 * 'paymentReceived' → fulfillment anchor when linked (matches NACHA), else PaymentDate.
 */
function buildDateFilter(basis, { startDate, endDate, invoiceAlias = 'inv', paymentAlias = 'p' } = {}) {
  if (basis === 'paymentReceived') {
    if (!startDate || !endDate) return '';
    const clause = paymentInWindowSql({
      invAlias: invoiceAlias,
      payAlias: paymentAlias,
      payoutBasis: 'paymentReceived',
    });
    return ` AND (${clause.replace(/\s+/g, ' ')})`;
  }
  if (!startDate && !endDate) return '';
  return ` AND (
    (${paymentAlias}.InvoiceId IS NOT NULL AND ${invoiceAlias}.BillingPeriodStart IS NOT NULL
      ${startDate ? `AND CAST(${invoiceAlias}.BillingPeriodStart AS DATE) <= CAST(@EndDate AS DATE)` : ''}
      ${endDate ? `AND CAST(${invoiceAlias}.BillingPeriodEnd AS DATE) >= CAST(@StartDate AS DATE)` : ''})
    OR (${paymentAlias}.InvoiceId IS NULL
      ${startDate ? `AND ${paymentAlias}.PaymentDate >= @StartDate` : ''}
      ${endDate ? `AND ${paymentAlias}.PaymentDate < DATEADD(day, 1, @EndDate)` : ''})
  )`;
}

// Authorization middleware consistent with backend/routes/accounting.js
const authorize = (allowedRoles) => {
  return (req, res, next) => {
    const userRoles = getUserRoles(req.user);
    if (!allowedRoles.some(role => userRoles.includes(role))) {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions',
        required: allowedRoles,
        current: userRoles
      });
    }
    next();
  };
};

function parseJsonSafe(value) {
  if (!value) return null;
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (e) {
    return null;
  }
}

function normalizeProductAmountsJson(parsed) {
  // Supports both formats:
  // 1) Object: { "<ProductId>": { vendorAmount, enrolledHouseholdsCount, ... } }
  // 2) Array:  [{ ProductId, VendorAmount/VendorAmount, EnrolledHouseholdsCount, ... }]
  if (!parsed) return null;
  if (Array.isArray(parsed)) {
    const obj = {};
    for (const item of parsed) {
      if (!item || !item.ProductId) continue;
      const key = String(item.ProductId).toUpperCase();
      obj[key] = {
        vendorAmount: Number(item.VendorAmount ?? item.vendorAmount ?? 0),
        overrideAmount: Number(item.OverrideAmount ?? item.overrideAmount ?? 0),
        enrolledHouseholdsCount: Number(item.EnrolledHouseholdsCount ?? item.enrolledHouseholdsCount ?? 0),
        enrollmentCount: Number(item.EnrollmentCount ?? item.enrollmentCount ?? 0),
      };
    }
    return obj;
  }
  if (typeof parsed === 'object') {
    // Ensure keys are normalized
    const obj = {};
    for (const [k, v] of Object.entries(parsed)) {
      obj[String(k).toUpperCase()] = v;
    }
    return obj;
  }
  return null;
}

/** Parse a single tier token (TierType, Member.Tier, or Label) to EE / ES / EC / EF, or null. */
function parseFamilyTierToken(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().toUpperCase();
  if (!s) return null;
  if (s.startsWith('EE')) return 'EE';
  if (s.startsWith('ES')) return 'ES';
  if (s.startsWith('E1')) return 'ES';
  if (s.startsWith('EC')) return 'EC';
  if (s.startsWith('EF')) return 'EF';
  if (s.includes('SPOUSE') && s.includes('CHILD')) return 'EF';
  if (s.includes('SPOUSE')) return 'ES';
  if (s.includes('CHILD')) return 'EC';
  return null;
}

/** Map structured tier fields + ProductPricing.Label to EE / ES / EC / EF (or Other) for vendor breakdown UI. */
function normalizeFamilyTierCode({ tierType, memberTier, label } = {}) {
  for (const candidate of [tierType, memberTier, label]) {
    const code = parseFamilyTierToken(candidate);
    if (code) return code;
  }
  return 'Other';
}

/** @param {Map<string, number>} countsMap */
function formatFamilyTierSummary(countsMap) {
  const order = ['EE', 'ES', 'EC', 'EF', 'Other'];
  const parts = [];
  for (const k of order) {
    const n = countsMap.get(k);
    if (n && n > 0) parts.push(`${k}: ${n}`);
  }
  return parts.length ? `(${parts.join(', ')})` : '';
}

/**
 * EXISTS clause: primary-member enrollments active for the same payment/invoice anchors
 * as the current vendor-breakdown snapshot (pending/paid filter).
 */
function buildSnapshotAnchorExistsSql(payoutBasis, { startDate, endDate, snapPaymentIds, snapInvoiceIds }, householdScope) {
  const dateFilter = buildDateFilter(payoutBasis, { startDate, endDate, invoiceAlias: 'inv2', paymentAlias: 'p' });
  const payList = snapPaymentIds.length
    ? `p.PaymentId IN (${snapPaymentIds.map(id => `'${String(id).replace(/'/g, "''")}'`).join(', ')})`
    : '0 = 1';
  const invList = snapInvoiceIds.length
    ? `inv2.InvoiceId IN (${snapInvoiceIds.map(id => `'${String(id).replace(/'/g, "''")}'`).join(', ')})`
    : '0 = 1';
  const groupOrHousehold =
    householdScope === 'individual'
      ? 'p.HouseholdId = m.HouseholdId AND p.GroupId IS NULL'
      : 'p.GroupId = m.GroupId';
  return `EXISTS (
      SELECT 1
      FROM oe.Payments p
      LEFT JOIN oe.Invoices inv2 ON p.InvoiceId = inv2.InvoiceId
      WHERE ${groupOrHousehold}
        AND p.TenantId = @TenantId
        AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
        AND (p.InvoiceId IS NULL OR inv2.Status = N'${PAID_INVOICE_STATUS}')
        ${dateFilter}
        AND (${payList} OR ${invList})
        AND e.EffectiveDate <= COALESCE(inv2.BillingPeriodEnd, p.PaymentDate)
        AND (e.TerminationDate IS NULL OR e.TerminationDate > COALESCE(inv2.BillingPeriodStart, p.PaymentDate))
    )`.replace(/\s+/g, ' ').trim();
}

async function fetchSnapshotGroupHouseholdTierAggregates(pool, opts) {
  const {
    tenantId,
    vendorId,
    startDate,
    endDate,
    payoutBasis,
    snapPaymentIds,
    snapInvoiceIds,
    groupId,
    householdId,
    enrollmentId,
    individuals,
  } = opts;
  const map = new Map();
  if (!snapPaymentIds.length && !snapInvoiceIds.length) return map;
  if (individuals && individuals === 'true') return map;
  if (householdId && householdId !== 'all') return map;

  const existsSql = buildSnapshotAnchorExistsSql(
    payoutBasis,
    { startDate, endDate, snapPaymentIds, snapInvoiceIds },
    'group'
  );
  const req = pool.request();
  req.input('TenantId', sql.UniqueIdentifier, tenantId);
  req.input('VendorId', sql.UniqueIdentifier, vendorId);
  if (startDate) req.input('StartDate', sql.Date, startDate);
  if (endDate) req.input('EndDate', sql.Date, endDate);
  if (groupId && groupId !== 'all') req.input('GroupId', sql.UniqueIdentifier, groupId);
  if (enrollmentId && enrollmentId !== 'all') req.input('EnrollmentId', sql.UniqueIdentifier, enrollmentId);

  const q = `
      SELECT m.GroupId, e.ProductId, pp.Label AS PricingTierLabel,
             pp.TierType AS PricingTierType, m.Tier AS MemberTier,
             COUNT(DISTINCT m.HouseholdId) AS HouseholdCount
      FROM oe.Enrollments e
      INNER JOIN oe.Members m ON e.MemberId = m.MemberId AND m.RelationshipType = 'P'
      LEFT JOIN oe.Products pr ON pr.ProductId = e.ProductId
      LEFT JOIN oe.ProductPricing pp ON pp.ProductPricingId = e.ProductPricingId
      WHERE (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
        AND e.ProductId IS NOT NULL
        AND e.ProductId != '00000000-0000-0000-0000-000000000000'
        AND e.ProductId NOT IN (
          SELECT DISTINCT BundleProductId FROM oe.ProductBundles WHERE BundleProductId IS NOT NULL
        )
        AND e.ProductPricingId IS NOT NULL
        AND m.GroupId IS NOT NULL
        AND m.TenantId = @TenantId
        AND pr.VendorId = @VendorId
        ${groupId && groupId !== 'all' ? 'AND m.GroupId = @GroupId' : ''}
        ${enrollmentId && enrollmentId !== 'all' ? 'AND e.EnrollmentId = @EnrollmentId' : ''}
        AND ${existsSql}
      GROUP BY m.GroupId, e.ProductId, pp.Label, pp.TierType, m.Tier, pp.MinAge, pp.MaxAge, pp.NetRate, pp.ProductPricingId
    `;

  const result = await req.query(q);
  for (const row of result.recordset || []) {
    if (!row.GroupId || !row.ProductId) continue;
    const key = `${String(row.GroupId).toUpperCase()}::${String(row.ProductId).toUpperCase()}`;
    const code = normalizeFamilyTierCode({
      tierType: row.PricingTierType,
      memberTier: row.MemberTier,
      label: row.PricingTierLabel,
    });
    const c = Number(row.HouseholdCount || 0);
    if (!map.has(key)) map.set(key, { counts: new Map(), total: 0 });
    const agg = map.get(key);
    agg.counts.set(code, (agg.counts.get(code) || 0) + c);
    agg.total += c;
  }
  return map;
}

async function fetchSnapshotIndividualHouseholdTierAggregates(pool, opts) {
  const {
    tenantId,
    vendorId,
    startDate,
    endDate,
    payoutBasis,
    snapPaymentIds,
    snapInvoiceIds,
    groupId,
    householdId,
    enrollmentId,
  } = opts;
  const map = new Map();
  if (!snapPaymentIds.length && !snapInvoiceIds.length) return map;
  if (groupId && groupId !== 'all') return map;

  const existsSql = buildSnapshotAnchorExistsSql(
    payoutBasis,
    { startDate, endDate, snapPaymentIds, snapInvoiceIds },
    'individual'
  );
  const req = pool.request();
  req.input('TenantId', sql.UniqueIdentifier, tenantId);
  req.input('VendorId', sql.UniqueIdentifier, vendorId);
  if (startDate) req.input('StartDate', sql.Date, startDate);
  if (endDate) req.input('EndDate', sql.Date, endDate);
  if (householdId && householdId !== 'all') req.input('HouseholdId', sql.UniqueIdentifier, householdId);
  if (enrollmentId && enrollmentId !== 'all') req.input('EnrollmentId', sql.UniqueIdentifier, enrollmentId);

  const q = `
      SELECT m.HouseholdId, e.ProductId, pp.Label AS PricingTierLabel,
             pp.TierType AS PricingTierType, m.Tier AS MemberTier,
             COUNT(DISTINCT m.HouseholdId) AS HouseholdCount
      FROM oe.Enrollments e
      INNER JOIN oe.Members m ON e.MemberId = m.MemberId AND m.RelationshipType = 'P'
      LEFT JOIN oe.Products pr ON pr.ProductId = e.ProductId
      LEFT JOIN oe.ProductPricing pp ON pp.ProductPricingId = e.ProductPricingId
      WHERE (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
        AND e.ProductId IS NOT NULL
        AND e.ProductId != '00000000-0000-0000-0000-000000000000'
        AND e.ProductId NOT IN (
          SELECT DISTINCT BundleProductId FROM oe.ProductBundles WHERE BundleProductId IS NOT NULL
        )
        AND e.ProductPricingId IS NOT NULL
        AND m.TenantId = @TenantId
        AND pr.VendorId = @VendorId
        ${householdId && householdId !== 'all' ? 'AND m.HouseholdId = @HouseholdId' : ''}
        ${enrollmentId && enrollmentId !== 'all' ? 'AND e.EnrollmentId = @EnrollmentId' : ''}
        AND ${existsSql}
      GROUP BY m.HouseholdId, e.ProductId, pp.Label, pp.TierType, m.Tier, pp.MinAge, pp.MaxAge, pp.NetRate, pp.ProductPricingId
    `;

  const result = await req.query(q);
  for (const row of result.recordset || []) {
    if (!row.HouseholdId || !row.ProductId) continue;
    const key = `${String(row.HouseholdId).toUpperCase()}::${String(row.ProductId).toUpperCase()}`;
    const code = normalizeFamilyTierCode({
      tierType: row.PricingTierType,
      memberTier: row.MemberTier,
      label: row.PricingTierLabel,
    });
    const c = Number(row.HouseholdCount || 0);
    if (!map.has(key)) map.set(key, { counts: new Map(), total: 0 });
    const agg = map.get(key);
    agg.counts.set(code, (agg.counts.get(code) || 0) + c);
    agg.total += c;
  }
  return map;
}

/**
 * GET /api/accounting/vendor-breakdown
 * Query params: startDate (YYYY-MM-DD), endDate (YYYY-MM-DD)
 *
 * Expected amounts mirror invoice-anchored Vendor NACHA: one full ProductVendorAmounts slice per Paid
 * invoice (not per oe.Payments row), so partial+top-up duplicates do not inflate the tab. Completed
 * payments with no InvoiceId are not added to expected/pending (NACHA does not pay those); their JSON
 * vendor slices are summed separately as orphanPaymentVendorExposure. Credit-funded invoices (no
 * Completed payment) add separately.
 * We return TWO different "paid" concepts:
 * - paidInRangeAmount: sum of Sent vendor NACHA details for payments whose PaymentDate is in the selected range.
 *   (This answers: "for these payments, how much has actually been paid out already?")
 * - paidOutAmount: sum of Sent vendor NACHA details for NACHA generations whose GeneratedDate is in the selected range.
 *   (This answers: "how much did we pay out in vendor NACHA files during this window?")
 */
router.get('/vendor-breakdown', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant context missing' });
    }

    const { startDate, endDate, groupId, householdId, individuals } = req.query;
    const pool = await getPool();
    const payoutBasis = await getVendorPayoutBasis(tenantId);

    // 1) Applicable vendors from tenant subscribed products OR tenant-owned products
    const vendorsReq = pool.request();
    vendorsReq.input('TenantId', sql.UniqueIdentifier, tenantId);
    const vendorsResult = await vendorsReq.query(`
      SELECT DISTINCT
        v.VendorId,
        v.VendorName
      FROM oe.Products p
      INNER JOIN oe.Vendors v ON p.VendorId = v.VendorId
      WHERE v.VendorId IS NOT NULL
        AND (
          p.ProductOwnerId = @TenantId
          OR EXISTS (
            SELECT 1
            FROM oe.TenantProductSubscriptions tps
            WHERE tps.TenantId = @TenantId
              AND tps.ProductId = p.ProductId
          )
        )
      ORDER BY v.VendorName
    `);

    const vendors = vendorsResult.recordset || [];
    const vendorTotals = new Map(); // vendorId -> counters + expectedByAnchor / paidByAnchor / orphan exposure
    vendors.forEach(v => {
      vendorTotals.set(v.VendorId.toString(), {
        vendorId: v.VendorId.toString(),
        vendorName: v.VendorName,
        expectedAmount: 0,
        paidInRangeAmount: 0,
        paidOutAmount: 0,
        achActiveCount: 0,
        achTotalDistribution: 0,
        // Per-anchor maps keyed by invoice:<id>. Used to
        // compute pendingPayoutAmount with the same per-anchor floor that
        // NACHAService.calculatePayoutBreakdownInternal applies, so the
        // breakdown's "Unpaid" column matches the NACHA preview total.
        expectedByAnchor: new Map(),
        paidByAnchor: new Map(),
        orphanPaymentVendorExposure: 0
      });
    });

    // Early return with zero rows if no vendors
    if (vendors.length === 0) {
      return res.json({ success: true, data: [] });
    }

    // 2) Completed payments for tenant in date range
    const paymentsReq = pool.request();
    paymentsReq.input('TenantId', sql.UniqueIdentifier, tenantId);
    if (groupId && groupId !== 'all') paymentsReq.input('GroupId', sql.UniqueIdentifier, groupId);
    if (householdId && householdId !== 'all') paymentsReq.input('HouseholdId', sql.UniqueIdentifier, householdId);

    // Status + funding-gate aligned with NACHAService.getUnpaidPayments so
    // breakdown "expected" matches the set of rows NACHA can actually pay out.
    let paymentsWhere = `WHERE p.TenantId = @TenantId
      AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
      AND (p.InvoiceId IS NULL OR inv.Status = N'${PAID_INVOICE_STATUS}')`;
    if (startDate) paymentsReq.input('StartDate', sql.Date, startDate);
    if (endDate) paymentsReq.input('EndDate', sql.Date, endDate);
    paymentsWhere += buildDateFilter(payoutBasis, { startDate, endDate });
    if (groupId && groupId !== 'all') {
      paymentsWhere += ` AND p.GroupId = @GroupId`;
    }
    if (householdId && householdId !== 'all') {
      paymentsWhere += ` AND p.HouseholdId = @HouseholdId`;
    }
    if (individuals && individuals === 'true') {
      paymentsWhere += ` AND p.GroupId IS NULL`;
    }

    const paymentsResult = await paymentsReq.query(`
      SELECT
        p.PaymentId,
        p.InvoiceId,
        -- Invoice-sourced payouts: prefer invoice breakdowns with payment fallback
        COALESCE(inv.ProductVendorAmounts, p.ProductVendorAmounts) as ProductVendorAmounts
      FROM oe.Payments p
      LEFT JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
      ${paymentsWhere}
    `);

    const payments = paymentsResult.recordset || [];
    const paymentIds = payments.map(p => p.PaymentId?.toString()).filter(Boolean);

    // 2b) Credit-funded paid invoices in the window (no oe.Payments row).
    // These were silently dropped pre-shift because the spine started at oe.Payments.
    // Apply the same scope filters (group/household/individuals) as payments.
    const creditInvoicesReq = pool.request();
    creditInvoicesReq.input('TenantId', sql.UniqueIdentifier, tenantId);
    if (groupId && groupId !== 'all') creditInvoicesReq.input('GroupId', sql.UniqueIdentifier, groupId);
    if (householdId && householdId !== 'all') creditInvoicesReq.input('HouseholdId', sql.UniqueIdentifier, householdId);
    if (startDate) creditInvoicesReq.input('StartDate', sql.Date, startDate);
    if (endDate) creditInvoicesReq.input('EndDate', sql.Date, endDate);
    // NOT EXISTS mirrors NACHAService.getUnpaidPayments Branch 2: only treat the
    // invoice as credit-anchored when no SUCCESSFUL payment row points at it.
    // Stale "Failed" / "Success" / non-whitelisted rows must not block credit
    // anchoring or the breakdown drops invoices NACHA still picks up (the
    // ShareWELL $417 'Success'-status drift).
    let creditInvoicesWhere = `
      WHERE inv.TenantId = @TenantId
        AND inv.Status = N'${PAID_INVOICE_STATUS}'
        AND NOT EXISTS (
          SELECT 1 FROM oe.Payments p
          WHERE p.InvoiceId = inv.InvoiceId
            AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
        )
    `;
    if (startDate && endDate) {
      creditInvoicesWhere += ` AND (${invoicePayoutWindowSql({ invAlias: 'inv', payoutBasis }).replace(/\s+/g, ' ')})`;
    } else {
      if (startDate) {
        creditInvoicesWhere += ` AND COALESCE(inv.BillingPeriodEnd, DATEADD(DAY, -1, DATEADD(MONTH, 1, inv.BillingPeriodStart))) >= @StartDate`;
      }
      if (endDate) {
        creditInvoicesWhere += ` AND inv.BillingPeriodStart < DATEADD(day, 1, @EndDate)`;
      }
    }
    if (groupId && groupId !== 'all') creditInvoicesWhere += ` AND inv.GroupId = @GroupId`;
    if (householdId && householdId !== 'all') creditInvoicesWhere += ` AND inv.HouseholdId = @HouseholdId`;
    if (individuals && individuals === 'true') creditInvoicesWhere += ` AND inv.GroupId IS NULL`;
    const creditInvoicesResult = await creditInvoicesReq.query(`
      SELECT inv.InvoiceId, inv.ProductVendorAmounts
      FROM oe.Invoices inv
      ${creditInvoicesWhere}
    `);
    const creditInvoices = creditInvoicesResult.recordset || [];
    const invoiceIds = creditInvoices.map(r => r.InvoiceId?.toString()).filter(Boolean);

    // 3) Build productId -> vendorId map only for products in JSON payloads
    const productIds = new Set();
    const paymentVendorJsonByPaymentId = new Map(); // paymentId -> parsed json
    const invoiceVendorJsonByInvoiceId = new Map(); // invoiceId -> parsed json
    payments.forEach(p => {
      const parsed = parseJsonSafe(p.ProductVendorAmounts);
      if (!parsed || typeof parsed !== 'object') return;
      paymentVendorJsonByPaymentId.set(p.PaymentId.toString(), parsed);
      Object.keys(parsed).forEach(productId => productIds.add(productId));
    });
    creditInvoices.forEach(r => {
      const parsed = parseJsonSafe(r.ProductVendorAmounts);
      if (!parsed || typeof parsed !== 'object') return;
      invoiceVendorJsonByInvoiceId.set(r.InvoiceId.toString(), parsed);
      Object.keys(parsed).forEach(productId => productIds.add(productId));
    });

    const productIdToVendorId = new Map();
    if (productIds.size > 0) {
      const productIdsStr = Array.from(productIds)
        .map(id => `'${String(id).replace(/'/g, "''")}'`)
        .join(', ');

      const productReq = pool.request();
      const productResult = await productReq.query(`
        SELECT ProductId, VendorId
        FROM oe.Products
        WHERE ProductId IN (${productIdsStr})
      `);

      (productResult.recordset || []).forEach(r => {
        if (!r.ProductId || !r.VendorId) return;
        productIdToVendorId.set(r.ProductId.toString(), r.VendorId.toString());
      });
    }

    // 4) Expected: sum vendorAmount from ProductVendorAmounts JSON for invoice-anchored
    // sources (paid invoice once per anchor) plus credit-funded invoices. Bucket by
    // invoice:<id> so step 7 can compute pendingPayout as SUM(MAX(0, expected_anchor - paid_anchor))
    // — the same per-anchor floor NACHA applies. Without this the breakdown silently
    // absorbs prior overpayments into the global subtraction and drifts from
    // what NACHA preview will actually disburse.
    const accumulateExpected = (parsed, anchorKey) => {
      Object.entries(parsed).forEach(([productId, data]) => {
        const vendorAmount = Number(data?.vendorAmount || 0);
        if (!vendorAmount || vendorAmount === 0) return;
        const vendorId = productIdToVendorId.get(String(productId));
        if (!vendorId) return;
        const row = vendorTotals.get(vendorId);
        if (!row) return;
        row.expectedAmount += vendorAmount;
        const prev = row.expectedByAnchor.get(anchorKey) || 0;
        row.expectedByAnchor.set(anchorKey, prev + vendorAmount);
      });
    };
    const accumulateOrphanExposure = (parsed) => {
      Object.entries(parsed).forEach(([productId, data]) => {
        const vendorAmount = Number(data?.vendorAmount || 0);
        if (!vendorAmount || vendorAmount === 0) return;
        const vendorId = productIdToVendorId.get(String(productId));
        if (!vendorId) return;
        const row = vendorTotals.get(vendorId);
        if (!row) return;
        row.orphanPaymentVendorExposure += vendorAmount;
      });
    };
    const invoiceIdsFromPayments = [
      ...new Set(payments.map(p => p.InvoiceId?.toString()).filter(Boolean))
    ];
    const invoicesSeenForPaymentExpected = new Set();
    payments.forEach(p => {
      const pid = p.PaymentId?.toString();
      if (!pid) return;
      const parsed = paymentVendorJsonByPaymentId.get(pid);
      if (!parsed) return;
      if (p.InvoiceId) {
        const iid = String(p.InvoiceId).toUpperCase();
        if (invoicesSeenForPaymentExpected.has(iid)) return;
        invoicesSeenForPaymentExpected.add(iid);
        accumulateExpected(parsed, `invoice:${iid}`);
      } else {
        accumulateOrphanExposure(parsed);
      }
    });
    invoiceVendorJsonByInvoiceId.forEach((parsed, invoiceId) =>
      accumulateExpected(parsed, `invoice:${String(invoiceId).toUpperCase()}`));

    // 5) Paid (in-range): sum NACHAPaymentDetails for vendor recipients from Sent
    // Vendor NACHA files, limited to PaymentIds OR resolved InvoiceIds in the
    // selected window. Anchor keys use invoice:<id> when COALESCE(npd.InvoiceId,
    // p.InvoiceId) is set so legacy Sent rows (PaymentId only) still net against
    // invoice-keyed expected — matching getUnpaidPayments + NACHA after the pivot.
    const allInvoiceIdsForPaid = [...new Set([...invoiceIds, ...invoiceIdsFromPayments])];
    if (paymentIds.length > 0 || allInvoiceIdsForPaid.length > 0) {
      const paidReq = pool.request();
      const paidAnchorClauses = [];
      if (paymentIds.length > 0) {
        const paymentIdsStr = paymentIds.map(id => `'${String(id).replace(/'/g, "''")}'`).join(', ');
        paidAnchorClauses.push(`npd.PaymentId IN (${paymentIdsStr})`);
      }
      if (allInvoiceIdsForPaid.length > 0) {
        const invoiceIdsStr = allInvoiceIdsForPaid.map(id => `'${String(id).replace(/'/g, "''")}'`).join(', ');
        paidAnchorClauses.push(`COALESCE(npd.InvoiceId, payNpd.InvoiceId) IN (${invoiceIdsStr})`);
      }
      const paidResult = await paidReq.query(`
        SELECT
          npd.RecipientEntityId as VendorId,
          npd.PaymentId,
          npd.InvoiceId,
          payNpd.InvoiceId AS PaymentRowInvoiceId,
          SUM(COALESCE(npd.Amount, 0)) as PaidAmount
        FROM oe.NACHAPaymentDetails npd
        INNER JOIN oe.NACHAGenerations ng ON npd.NACHAId = ng.NACHAId
        LEFT JOIN oe.Payments payNpd ON payNpd.PaymentId = npd.PaymentId
        WHERE npd.RecipientEntityType = 'Vendor'
          AND ng.Status = 'Sent'
          AND ng.PayoutType = 'Vendor Payouts'
          AND (${paidAnchorClauses.join(' OR ')})
        GROUP BY npd.RecipientEntityId, npd.PaymentId, npd.InvoiceId, payNpd.InvoiceId
      `);

      (paidResult.recordset || []).forEach(r => {
        const vendorId = r.VendorId ? r.VendorId.toString() : null;
        if (!vendorId) return;
        const row = vendorTotals.get(vendorId);
        if (!row) return;
        const amt = Number(r.PaidAmount || 0);
        row.paidInRangeAmount += amt;
        const resolvedInv = r.InvoiceId || r.PaymentRowInvoiceId;
        const anchorKey = resolvedInv
          ? `invoice:${String(resolvedInv).toUpperCase()}`
          : (r.PaymentId ? `payment:${String(r.PaymentId).toUpperCase()}` : null);
        if (!anchorKey) return;
        const prev = row.paidByAnchor.get(anchorKey) || 0;
        row.paidByAnchor.set(anchorKey, prev + amt);
      });
    }

    // 5b) Paid out (by NACHA generated date): sum Sent Vendor NACHA details for NACHA generations
    // whose GeneratedDate falls in the selected range (independent of PaymentDate).
    {
      const paidOutReq = pool.request();
      paidOutReq.input('TenantId', sql.UniqueIdentifier, tenantId);
      let generatedWhere = `WHERE ng.TenantId = @TenantId AND ng.Status = 'Sent' AND ng.PayoutType = 'Vendor Payouts'`;
      if (startDate) {
        paidOutReq.input('StartDate', sql.Date, startDate);
        generatedWhere += ` AND ng.GeneratedDate >= @StartDate`;
      }
      if (endDate) {
        paidOutReq.input('EndDate', sql.Date, endDate);
        generatedWhere += ` AND ng.GeneratedDate < DATEADD(day, 1, @EndDate)`;
      }

      const paidOutResult = await paidOutReq.query(`
        SELECT
          npd.RecipientEntityId as VendorId,
          SUM(COALESCE(npd.Amount, 0)) as PaidOutAmount
        FROM oe.NACHAPaymentDetails npd
        INNER JOIN oe.NACHAGenerations ng ON npd.NACHAId = ng.NACHAId
        ${generatedWhere}
          AND npd.RecipientEntityType = 'Vendor'
        GROUP BY npd.RecipientEntityId
      `);

      (paidOutResult.recordset || []).forEach(r => {
        const vendorId = r.VendorId ? r.VendorId.toString() : null;
        if (!vendorId) return;
        const row = vendorTotals.get(vendorId);
        if (!row) return;
        row.paidOutAmount += Number(r.PaidOutAmount || 0);
      });
    }

    // 6) Build response rows including zeros
    // 6a) ACH health summary per vendor (active ACH accounts + total distribution %)
    const vendorIdsStr = vendors
      .map(v => `'${String(v.VendorId).replace(/'/g, "''")}'`)
      .join(', ');
    if (vendorIdsStr) {
      const achResult = await pool.request().query(`
        SELECT
          EntityId as VendorId,
          COUNT(CASE WHEN Status = 'Active' THEN 1 END) as ActiveCount,
          ISNULL(SUM(CASE WHEN Status = 'Active' THEN ISNULL(DistributionPercentage, 0) ELSE 0 END), 0) as TotalDistribution
        FROM oe.ACHAccounts
        WHERE EntityType = 'Vendor'
          AND EntityId IN (${vendorIdsStr})
        GROUP BY EntityId
      `);

      (achResult.recordset || []).forEach(r => {
        const vid = r.VendorId ? r.VendorId.toString() : null;
        if (!vid) return;
        const row = vendorTotals.get(vid);
        if (!row) return;
        row.achActiveCount = Number(r.ActiveCount || 0);
        row.achTotalDistribution = Number(r.TotalDistribution || 0);
      });
    }

    // Pending vendor payout clawbacks (oe.PayoutClawbacks). These drain
    // immediately at NACHA generation, so any RemainingAmount here is unspent
    // refund debit that will reduce this vendor's next NACHA payout.
    let clawbackMap = new Map();
    try {
      clawbackMap = await clawbackBalances.getPayoutClawbackBalances({
        tenantId,
        payoutType: PayoutClawbacks.PAYOUT_TYPES.VENDOR,
        recipientEntityIds: Array.from(vendorTotals.keys())
      });
    } catch (e) {
      console.warn('vendor-breakdown: clawback lookup failed', e.message);
    }

    const data = Array.from(vendorTotals.values()).map(v => {
      const expected = Math.round((v.expectedAmount || 0) * 100) / 100;
      const paidInRange = Math.round((v.paidInRangeAmount || 0) * 100) / 100;
      const paidOut = Math.round((v.paidOutAmount || 0) * 100) / 100;
      // Per-anchor floor: pendingPayout = SUM over anchors of MAX(0, expected_i - paid_i).
      // Mirrors NACHAService.calculatePayoutBreakdownInternal so the "Unpaid" column
      // matches what the NACHA preview will actually disburse. A global
      // MAX(0, expected - paid) silently absorbs prior overpayments on individual
      // anchors and drifts (the $970 vs $1,387 ShareWELL bug).
      const anchorKeys = new Set([
        ...v.expectedByAnchor.keys(),
        ...v.paidByAnchor.keys()
      ]);
      let pendingPayoutRaw = 0;
      anchorKeys.forEach(k => {
        const exp = Number(v.expectedByAnchor.get(k) || 0);
        const pd = Number(v.paidByAnchor.get(k) || 0);
        if (exp > pd) pendingPayoutRaw += (exp - pd);
      });
      const pendingPayout = Math.round(pendingPayoutRaw * 100) / 100;
      const cb = clawbackMap.get(v.vendorId);
      const pendingClawback = cb ? Math.round((cb.amount || 0) * 100) / 100 : 0;
      const netNextPayout = Math.round(Math.max(0, pendingPayout - pendingClawback) * 100) / 100;
      return {
        vendorId: v.vendorId,
        vendorName: v.vendorName,
        expectedAmount: expected,
        paidInRangeAmount: paidInRange,
        paidOutAmount: paidOut,
        pendingPayoutAmount: pendingPayout,
        pendingClawbackAmount: pendingClawback,
        pendingClawbackCount: cb ? Number(cb.count || 0) : 0,
        netNextPayoutAmount: netNextPayout,
        orphanPaymentVendorExposure: Math.round((v.orphanPaymentVendorExposure || 0) * 100) / 100,
        ach: {
          hasActiveAch: (v.achActiveCount || 0) > 0,
          activeAccountCount: Number(v.achActiveCount || 0),
          totalDistributionPercentage: Number(v.achTotalDistribution || 0)
        }
      };
    });

    res.json({ success: true, data });
  } catch (error) {
    console.error('Error building vendor breakdown:', error);
    res.status(500).json({ success: false, message: 'Failed to build vendor breakdown' });
  }
});

/**
 * GET /api/accounting/vendor-breakdown/nacha-preview-gap
 *
 * Sources in the vendor payout window for this vendor that are not included in the
 * current NACHA preview selection (paid invoices omitted from preview + legacy
 * Completed payments with no InvoiceId).
 *
 * Query: vendorId, startDate, endDate, includedInvoiceIds (comma UUIDs), includedPaymentIds (comma UUIDs)
 */
function parseIncludedUuidSets({ includedInvoiceIds = '', includedPaymentIds = '' }) {
  const norm = (s) => String(s || '').trim().toUpperCase().replace(/[{}]/g, '');
  const invoices = new Set(
    String(includedInvoiceIds || '').split(',').map(norm).filter(Boolean)
  );
  const payments = new Set(
    String(includedPaymentIds || '').split(',').map(norm).filter(Boolean)
  );
  return { invoices, payments };
}

function vendorShareForTargetVendorJson(parsedNorm, targetVendorIdUpper, productIdToVendorId) {
  let sum = 0;
  if (!parsedNorm || typeof parsedNorm !== 'object') return 0;
  for (const [productId, data] of Object.entries(parsedNorm)) {
    const vid = productIdToVendorId.get(String(productId).toUpperCase());
    if (!vid || String(vid).toUpperCase() !== targetVendorIdUpper) continue;
    sum += Number(data?.vendorAmount || 0);
  }
  return sum;
}

const GAP_PAID_TOLERANCE = 0.01;

/**
 * Sent Vendor NACHA amounts by invoice / payment (legacy payment-anchored rows included).
 * Used to drop "not in this NACHA" gap rows that were already paid on a prior file.
 */
async function loadVendorSentPaidByAnchors(pool, vendorId, { invoiceIds = [], paymentIds = [] } = {}) {
  const byInvoice = new Map();
  const byPayment = new Map();
  const invU = [...new Set(invoiceIds.map((id) => String(id).trim().toUpperCase()).filter(Boolean))];
  const payU = [...new Set(paymentIds.map((id) => String(id).trim().toUpperCase()).filter(Boolean))];
  if (invU.length === 0 && payU.length === 0) return { byInvoice, byPayment };

  const orParts = [];
  if (invU.length) {
    const invList = invU.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
    orParts.push(`npd.InvoiceId IN (${invList})`, `p.InvoiceId IN (${invList})`);
  }
  if (payU.length) {
    const payList = payU.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
    orParts.push(`npd.PaymentId IN (${payList})`);
  }
  const vendorEsc = String(vendorId).replace(/'/g, "''");
  const result = await pool.request().query(`
    SELECT
      npd.InvoiceId,
      npd.PaymentId,
      p.InvoiceId AS PayInvoiceId,
      SUM(COALESCE(npd.Amount, 0)) AS PaidAmount
    FROM oe.NACHAPaymentDetails npd
    INNER JOIN oe.NACHAGenerations ng ON npd.NACHAId = ng.NACHAId
    LEFT JOIN oe.Payments p ON npd.PaymentId = p.PaymentId
    WHERE npd.RecipientEntityType = N'Vendor'
      AND npd.RecipientEntityId = '${vendorEsc}'
      AND ng.Status = N'Sent'
      AND ng.PayoutType = N'Vendor Payouts'
      AND (${orParts.join(' OR ')})
    GROUP BY npd.InvoiceId, npd.PaymentId, p.InvoiceId
  `);

  for (const row of result.recordset || []) {
    const amt = Number(row.PaidAmount) || 0;
    if (row.InvoiceId) {
      const k = String(row.InvoiceId).toUpperCase();
      byInvoice.set(k, (byInvoice.get(k) || 0) + amt);
    }
    if (row.PayInvoiceId) {
      const k = String(row.PayInvoiceId).toUpperCase();
      byInvoice.set(k, (byInvoice.get(k) || 0) + amt);
    }
    if (row.PaymentId) {
      const k = String(row.PaymentId).toUpperCase();
      byPayment.set(k, (byPayment.get(k) || 0) + amt);
    }
  }
  return { byInvoice, byPayment };
}

function vendorShareAlreadyPaidViaNacha({ paidLookup, invoiceId, paymentId, vendorShare }) {
  const share = Number(vendorShare) || 0;
  if (share <= 0) return false;
  if (invoiceId) {
    const paid = paidLookup.byInvoice.get(String(invoiceId).toUpperCase()) || 0;
    if (paid >= share - GAP_PAID_TOLERANCE) return true;
  }
  if (paymentId) {
    const paid = paidLookup.byPayment.get(String(paymentId).toUpperCase()) || 0;
    if (paid >= share - GAP_PAID_TOLERANCE) return true;
  }
  return false;
}

router.get(
  '/vendor-breakdown/nacha-preview-gap',
  authorize(['SysAdmin', 'TenantAdmin']),
  requireTenantAccess,
  async (req, res) => {
    try {
      const tenantId = req.tenantId || req.user?.TenantId;
      if (!tenantId) {
        return res.status(400).json({ success: false, message: 'Tenant context missing' });
      }
      const { vendorId, startDate, endDate, includedInvoiceIds = '', includedPaymentIds = '' } = req.query;
      if (!vendorId) {
        return res.status(400).json({ success: false, message: 'vendorId required' });
      }
      const targetVendorUpper = String(vendorId).trim().toUpperCase().replace(/[{}]/g, '');
      const { invoices: includedInv, payments: includedPay } = parseIncludedUuidSets({
        includedInvoiceIds,
        includedPaymentIds
      });

      const pool = await getPool();
      const payoutBasis = await getVendorPayoutBasis(tenantId);

      const paymentsReq = pool.request();
      paymentsReq.input('TenantId', sql.UniqueIdentifier, tenantId);
      if (startDate) paymentsReq.input('StartDate', sql.Date, startDate);
      if (endDate) paymentsReq.input('EndDate', sql.Date, endDate);

      let paymentsWhere = `WHERE p.TenantId = @TenantId
      AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
      AND (p.InvoiceId IS NULL OR inv.Status = N'${PAID_INVOICE_STATUS}')`;
      paymentsWhere += buildDateFilter(payoutBasis, { startDate, endDate });

      const paymentsResult = await paymentsReq.query(`
      SELECT
        p.PaymentId,
        p.InvoiceId,
        p.PaymentDate,
        p.GroupId,
        p.HouseholdId,
        COALESCE(inv.ProductVendorAmounts, p.ProductVendorAmounts) AS ProductVendorAmounts,
        inv.BillingPeriodStart,
        inv.BillingPeriodEnd,
        g.Name AS GroupName,
        hu.FirstName AS PrimaryFirstName,
        hu.LastName AS PrimaryLastName,
        hu.MemberId AS PrimaryMemberId
      FROM oe.Payments p
      LEFT JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
      LEFT JOIN oe.Groups g ON p.GroupId = g.GroupId
      OUTER APPLY (
        SELECT TOP 1 u.FirstName, u.LastName, mm.MemberId
        FROM oe.Members mm
        INNER JOIN oe.Users u ON u.UserId = mm.UserId
        WHERE p.HouseholdId IS NOT NULL
          AND mm.HouseholdId = p.HouseholdId
          AND mm.RelationshipType = 'P'
      ) hu
      ${paymentsWhere}
    `);

      const creditInvoicesReq = pool.request();
      creditInvoicesReq.input('TenantId', sql.UniqueIdentifier, tenantId);
      if (startDate) creditInvoicesReq.input('StartDate', sql.Date, startDate);
      if (endDate) creditInvoicesReq.input('EndDate', sql.Date, endDate);
      let creditInvoicesWhere = `
      WHERE inv.TenantId = @TenantId
        AND inv.Status = N'${PAID_INVOICE_STATUS}'
        AND NOT EXISTS (
          SELECT 1 FROM oe.Payments p
          WHERE p.InvoiceId = inv.InvoiceId
            AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
        )
    `;
      if (startDate && endDate) {
        creditInvoicesWhere += ` AND (${invoicePayoutWindowSql({ invAlias: 'inv', payoutBasis }).replace(/\s+/g, ' ')})`;
      } else {
        if (startDate) {
          creditInvoicesWhere += ` AND COALESCE(inv.BillingPeriodEnd, DATEADD(DAY, -1, DATEADD(MONTH, 1, inv.BillingPeriodStart))) >= @StartDate`;
        }
        if (endDate) {
          creditInvoicesWhere += ` AND inv.BillingPeriodStart < DATEADD(day, 1, @EndDate)`;
        }
      }
      const creditInvoicesResult = await creditInvoicesReq.query(`
      SELECT
        inv.InvoiceId,
        COALESCE(inv.PaymentReceivedDate, inv.BillingPeriodStart) AS PaymentDate,
        inv.ProductVendorAmounts,
        inv.BillingPeriodStart,
        inv.BillingPeriodEnd,
        inv.GroupId,
        inv.HouseholdId,
        g.Name AS GroupName,
        hu.FirstName AS PrimaryFirstName,
        hu.LastName AS PrimaryLastName,
        hu.MemberId AS PrimaryMemberId
      FROM oe.Invoices inv
      LEFT JOIN oe.Groups g ON inv.GroupId = g.GroupId
      OUTER APPLY (
        SELECT TOP 1 u.FirstName, u.LastName, mm.MemberId
        FROM oe.Members mm
        INNER JOIN oe.Users u ON u.UserId = mm.UserId
        WHERE inv.HouseholdId IS NOT NULL
          AND mm.HouseholdId = inv.HouseholdId
          AND mm.RelationshipType = 'P'
      ) hu
      ${creditInvoicesWhere}
    `);

      const payments = paymentsResult.recordset || [];
      const creditInvoices = creditInvoicesResult.recordset || [];
      const productIds = new Set();
      const noteParsed = (raw) => {
        const parsed = normalizeProductAmountsJson(parseJsonSafe(raw));
        if (!parsed) return;
        Object.keys(parsed).forEach(id => productIds.add(String(id).toUpperCase()));
      };
      payments.forEach(p => noteParsed(p.ProductVendorAmounts));
      creditInvoices.forEach(r => noteParsed(r.ProductVendorAmounts));

      const productIdToVendorId = new Map();
      if (productIds.size > 0) {
        const productIdsStr = Array.from(productIds)
          .map(id => `'${String(id).replace(/'/g, "''")}'`)
          .join(', ');
        const productResult = await pool.request().query(`
        SELECT ProductId, VendorId
        FROM oe.Products
        WHERE ProductId IN (${productIdsStr})
      `);
        (productResult.recordset || []).forEach(r => {
          if (!r.ProductId || !r.VendorId) return;
          productIdToVendorId.set(String(r.ProductId).toUpperCase(), String(r.VendorId).toUpperCase());
        });
      }

      const rows = [];
      const invoicesSeen = new Set();
      const gapInvoiceIds = [];
      const gapPaymentIds = [];

      const noteGapAnchor = (invoiceId, paymentId) => {
        if (invoiceId) gapInvoiceIds.push(String(invoiceId).toUpperCase());
        if (paymentId) gapPaymentIds.push(String(paymentId).toUpperCase());
      };

      for (const p of payments) {
        const parsed = normalizeProductAmountsJson(parseJsonSafe(p.ProductVendorAmounts));
        const share = vendorShareForTargetVendorJson(parsed, targetVendorUpper, productIdToVendorId);
        if (share <= 0) continue;

        const memberName = [p.PrimaryFirstName, p.PrimaryLastName].filter(Boolean).join(' ').trim() || '—';
        const pidStr = p.PaymentId ? String(p.PaymentId).toUpperCase() : '';

        if (p.InvoiceId) {
          const iid = String(p.InvoiceId).toUpperCase();
          if (invoicesSeen.has(iid)) continue;
          invoicesSeen.add(iid);
          if (includedInv.has(iid)) continue;
          noteGapAnchor(iid, pidStr || null);
          rows.push({
            anchorType: 'invoice',
            invoiceId: iid,
            paymentId: pidStr || null,
            vendorShare: Math.round(share * 100) / 100,
            reason: 'Paid invoice in this window is not included in the current NACHA preview selection.',
            billingPeriodStart: p.BillingPeriodStart || null,
            billingPeriodEnd: p.BillingPeriodEnd || null,
            paymentDate: p.PaymentDate || null,
            primaryMemberId: p.PrimaryMemberId ? String(p.PrimaryMemberId) : null,
            memberName,
            groupId: p.GroupId ? String(p.GroupId) : null,
            groupName: p.GroupName || null
          });
        } else {
          if (pidStr && includedPay.has(pidStr)) continue;
          noteGapAnchor(null, pidStr || null);
          rows.push({
            anchorType: 'orphan_payment',
            invoiceId: null,
            paymentId: pidStr || null,
            vendorShare: Math.round(share * 100) / 100,
            reason: 'Completed payment is not linked to an invoice (omitted from invoice-based vendor NACHA).',
            billingPeriodStart: null,
            billingPeriodEnd: null,
            paymentDate: p.PaymentDate || null,
            primaryMemberId: p.PrimaryMemberId ? String(p.PrimaryMemberId) : null,
            memberName,
            groupId: p.GroupId ? String(p.GroupId) : null,
            groupName: p.GroupName || null
          });
        }
      }

      for (const inv of creditInvoices) {
        const parsed = normalizeProductAmountsJson(parseJsonSafe(inv.ProductVendorAmounts));
        const share = vendorShareForTargetVendorJson(parsed, targetVendorUpper, productIdToVendorId);
        if (share <= 0) continue;
        const iid = String(inv.InvoiceId || '').toUpperCase();
        if (!iid || includedInv.has(iid)) continue;
        const memberName = [inv.PrimaryFirstName, inv.PrimaryLastName].filter(Boolean).join(' ').trim() || '—';
        noteGapAnchor(iid, null);
        rows.push({
          anchorType: 'invoice',
          invoiceId: iid,
          paymentId: null,
          vendorShare: Math.round(share * 100) / 100,
          reason: 'Credit-funded paid invoice in this window is not included in the current NACHA preview selection.',
          billingPeriodStart: inv.BillingPeriodStart || null,
          billingPeriodEnd: inv.BillingPeriodEnd || null,
          paymentDate: inv.PaymentDate || null,
          primaryMemberId: inv.PrimaryMemberId ? String(inv.PrimaryMemberId) : null,
          memberName,
          groupId: inv.GroupId ? String(inv.GroupId) : null,
          groupName: inv.GroupName || null
        });
      }

      const paidLookup = await loadVendorSentPaidByAnchors(pool, vendorId, {
        invoiceIds: gapInvoiceIds,
        paymentIds: gapPaymentIds
      });
      const beforePaidFilter = rows.length;
      const filteredRows = rows.filter(
        (r) =>
          !vendorShareAlreadyPaidViaNacha({
            paidLookup,
            invoiceId: r.invoiceId,
            paymentId: r.paymentId,
            vendorShare: r.vendorShare
          })
      );
      const excludedAlreadyPaidCount = beforePaidFilter - filteredRows.length;

      filteredRows.sort((a, b) => {
        const da = a.paymentDate ? new Date(a.paymentDate).getTime() : 0;
        const db = b.paymentDate ? new Date(b.paymentDate).getTime() : 0;
        return da - db;
      });

      const totalVendorShare = Math.round(
        filteredRows.reduce((s, r) => s + (Number(r.vendorShare) || 0), 0) * 100
      ) / 100;

      res.json({
        success: true,
        data: {
          rows: filteredRows,
          count: filteredRows.length,
          totalVendorShare,
          excludedAlreadyPaidCount
        }
      });
    } catch (error) {
      console.error('nacha-preview-gap:', error);
      res.status(500).json({ success: false, message: 'Failed to load NACHA preview gap' });
    }
  }
);

/**
 * GET /api/accounting/vendor-breakdown/filter-options
 * Query params: vendorId (optional), startDate, endDate
 *
 * Returns groups and members that have payments for the vendor (or all vendors if vendorId not provided) in the date range.
 */
router.get('/vendor-breakdown/filter-options', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant context missing' });
    }

    const { vendorId, startDate, endDate } = req.query;

    const pool = await getPool();
    const payoutBasis = await getVendorPayoutBasis(tenantId);
    const filterReq = pool.request();
    filterReq.input('TenantId', sql.UniqueIdentifier, tenantId);
    if (vendorId) filterReq.input('VendorId', sql.UniqueIdentifier, vendorId);
    if (startDate) filterReq.input('StartDate', sql.Date, startDate);
    if (endDate) filterReq.input('EndDate', sql.Date, endDate);

    const filterDateWhere = buildDateFilter(payoutBasis, { startDate, endDate });

    const filterWhere = `
      WHERE p.TenantId = @TenantId
        AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
        AND (p.InvoiceId IS NULL OR inv.Status = N'${PAID_INVOICE_STATUS}')
        ${filterDateWhere}
        ${vendorId ? 'AND pr.VendorId = @VendorId' : ''}
        AND e.ProductId IS NOT NULL
        AND e.ProductId != '00000000-0000-0000-0000-000000000000'
        AND e.ProductId NOT IN (
          SELECT DISTINCT BundleProductId
          FROM oe.ProductBundles
          WHERE BundleProductId IS NOT NULL
        )
    `;

    // Get groups with payments for this vendor
    const groupsResult = await filterReq.query(`
      SELECT DISTINCT
        p.GroupId as id,
        g.Name as label,
        'group' as type
      FROM oe.Payments p
      LEFT JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
      INNER JOIN oe.Members m ON m.GroupId = p.GroupId AND m.TenantId = p.TenantId
      INNER JOIN oe.Enrollments e ON e.MemberId = m.MemberId
        AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
        AND e.Status NOT IN ('Pending', 'Cancelled', 'Denied', 'Inactive')
        AND e.CreatedDate <= COALESCE(inv.BillingPeriodEnd, p.PaymentDate)
        AND e.EffectiveDate <= COALESCE(inv.BillingPeriodEnd, p.PaymentDate)
        AND (e.TerminationDate IS NULL OR e.TerminationDate > COALESCE(inv.BillingPeriodStart, p.PaymentDate))
        AND e.ProductId IS NOT NULL
        AND e.ProductPricingId IS NOT NULL
      LEFT JOIN oe.Products pr ON pr.ProductId = e.ProductId
      LEFT JOIN oe.Groups g ON p.GroupId = g.GroupId
      ${filterWhere}
        AND p.GroupId IS NOT NULL
        AND g.Name IS NOT NULL
      ORDER BY g.Name
    `);

    // Check if there are any individual (non-group) members with payments for this vendor
    const hasIndividualsResult = await filterReq.query(`
      SELECT TOP 1 1 as hasIndividuals
      FROM oe.Payments p
      LEFT JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
      INNER JOIN oe.Enrollments e ON e.HouseholdId = p.HouseholdId
        AND e.Status NOT IN ('Pending', 'Cancelled', 'Denied', 'Inactive')
        AND (
          (p.GroupId IS NULL
            AND e.EffectiveDate <= COALESCE(inv.BillingPeriodEnd, p.PaymentDate)
            AND (e.TerminationDate IS NULL OR e.TerminationDate > COALESCE(inv.BillingPeriodStart, p.PaymentDate)))
          OR
          (p.GroupId IS NOT NULL 
            AND e.EffectiveDate <= COALESCE(inv.BillingPeriodEnd, p.PaymentDate)
            AND (e.TerminationDate IS NULL OR e.TerminationDate > COALESCE(inv.BillingPeriodStart, p.PaymentDate)))
        )
        AND e.ProductId IS NOT NULL
        AND e.ProductId != '00000000-0000-0000-0000-000000000000'
        AND e.ProductId NOT IN (
          SELECT DISTINCT BundleProductId
          FROM oe.ProductBundles
          WHERE BundleProductId IS NOT NULL
        )
        AND e.ProductPricingId IS NOT NULL
      INNER JOIN oe.Members m ON m.HouseholdId = p.HouseholdId 
        AND m.RelationshipType = 'P'
      LEFT JOIN oe.Products pr ON pr.ProductId = e.ProductId
      ${filterWhere}
        AND p.HouseholdId IS NOT NULL
        AND p.GroupId IS NULL
    `);
    
    const hasIndividuals = hasIndividualsResult.recordset.length > 0;
    
    // Log for debugging
    console.log(`🔍 [Vendor Breakdown Filter] Has individuals: ${hasIndividuals}, Groups: ${groupsResult.recordset?.length || 0}`);

    const options = [
      { id: 'all', label: 'All Group & Member Payments', type: 'all', value: 'all' },
      ...(groupsResult.recordset || []).map(g => ({ ...g, value: `group_${g.id}` })),
      ...(hasIndividuals ? [{ id: 'individuals', label: 'Individuals', type: 'individuals', value: 'individuals' }] : [])
    ];

    res.json({ success: true, data: options });
  } catch (error) {
    console.error('Error getting filter options:', error);
    res.status(500).json({ success: false, message: 'Failed to get filter options' });
  }
});

/**
 * GET /api/accounting/vendor-breakdown/last-payout-date
 * Query params: vendorId
 *
 * Returns the most recent Sent vendor payout generation date for this vendor.
 */
router.get('/vendor-breakdown/last-payout-date', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const { vendorId } = req.query;
    if (!vendorId) {
      return res.status(400).json({ success: false, message: 'vendorId is required' });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input('VendorId', sql.UniqueIdentifier, vendorId);

    const result = await request.query(`
      SELECT
        CONVERT(varchar(10), MAX(ng.GeneratedDate), 23) as LastPayoutDate
      FROM oe.NACHAPaymentDetails npd
      INNER JOIN oe.NACHAGenerations ng ON npd.NACHAId = ng.NACHAId
      WHERE npd.RecipientEntityType = 'Vendor'
        AND npd.RecipientEntityId = @VendorId
        AND ng.Status = 'Sent'
        AND ng.PayoutType = 'Vendor Payouts'
    `);

    const lastPayoutDate = result.recordset?.[0]?.LastPayoutDate || null;
    return res.json({ success: true, data: { lastPayoutDate } });
  } catch (error) {
    console.error('Error getting vendor last payout date:', error);
    return res.status(500).json({ success: false, message: 'Failed to get vendor last payout date' });
  }
});

/**
 * GET /api/accounting/vendor-breakdown/breakdown
 * Query params: vendorId, startDate, endDate, groupId (optional), householdId (optional)
 *
 * Returns a detailed breakdown by product and pricing tier for a specific vendor.
 */
router.get('/vendor-breakdown/breakdown', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant context missing' });
    }

    const { vendorId, startDate, endDate, groupId, householdId, enrollmentId, individuals, paidStatus } = req.query;
    
    if (!vendorId) {
      return res.status(400).json({ success: false, message: 'vendorId is required' });
    }

    const pool = await getPool();
    const payoutBasis = await getVendorPayoutBasis(tenantId);
    const breakdownReq = pool.request();
    breakdownReq.input('TenantId', sql.UniqueIdentifier, tenantId);
    breakdownReq.input('VendorId', sql.UniqueIdentifier, vendorId);
    if (startDate) breakdownReq.input('StartDate', sql.Date, startDate);
    if (endDate) breakdownReq.input('EndDate', sql.Date, endDate);
    if (groupId && groupId !== 'all') breakdownReq.input('GroupId', sql.UniqueIdentifier, groupId);
    if (householdId && householdId !== 'all') breakdownReq.input('HouseholdId', sql.UniqueIdentifier, householdId);
    if (enrollmentId && enrollmentId !== 'all') breakdownReq.input('EnrollmentId', sql.UniqueIdentifier, enrollmentId);

    const breakdownDateWhere = buildDateFilter(payoutBasis, { startDate, endDate });

    const breakdownWhere = `
      WHERE p.TenantId = @TenantId
        AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
        AND (p.InvoiceId IS NULL OR inv.Status = N'${PAID_INVOICE_STATUS}')
        ${breakdownDateWhere}
        ${groupId && groupId !== 'all' ? 'AND p.GroupId = @GroupId' : ''}
        ${householdId && householdId !== 'all' ? 'AND p.HouseholdId = @HouseholdId' : ''}
    `;

    // First, get all payments with their ProductVendorAmounts JSON (source of truth)
    // OUTER APPLY fetches the household primary member's name for individual (non-group) payments
    // so we can attribute snapshot-based pending/paid rows to a real person instead of "no tier".
    const paymentsResult = await breakdownReq.query(`
      SELECT
        p.PaymentId,
        p.InvoiceId,
        p.PaymentDate,
        -- Invoice-sourced payouts: prefer invoice breakdowns with payment fallback
        COALESCE(inv.ProductVendorAmounts, p.ProductVendorAmounts) as ProductVendorAmounts,
        p.GroupId,
        p.HouseholdId,
        g.Name as GroupName,
        hu.FirstName as PrimaryFirstName,
        hu.LastName as PrimaryLastName,
        hu.MemberId as PrimaryMemberId
      FROM oe.Payments p
      LEFT JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
      LEFT JOIN oe.Groups g ON p.GroupId = g.GroupId
      OUTER APPLY (
        SELECT TOP 1 u.FirstName, u.LastName, mm.MemberId
        FROM oe.Members mm
        INNER JOIN oe.Users u ON u.UserId = mm.UserId
        WHERE p.HouseholdId IS NOT NULL
          AND mm.HouseholdId = p.HouseholdId
          AND mm.RelationshipType = 'P'
      ) hu
      ${breakdownWhere}
    `);

    // Credit-anchored invoices: oe.Invoices.Status='Paid' with no successful
    // payment row. Without this, credit-funded households (e.g. invoices
    // settled via household credit) silently disappear from the per-member
    // breakdown even though they DO contribute to "Ready for payout" totals
    // and the NACHA preview. Mirrors the totals route + NACHA Branch 2.
    const creditInvoicesReq = pool.request();
    creditInvoicesReq.input('TenantId', sql.UniqueIdentifier, tenantId);
    if (groupId && groupId !== 'all') creditInvoicesReq.input('GroupId', sql.UniqueIdentifier, groupId);
    if (householdId && householdId !== 'all') creditInvoicesReq.input('HouseholdId', sql.UniqueIdentifier, householdId);
    if (startDate) creditInvoicesReq.input('StartDate', sql.Date, startDate);
    if (endDate) creditInvoicesReq.input('EndDate', sql.Date, endDate);
    let creditInvoicesWhere = `
      WHERE inv.TenantId = @TenantId
        AND inv.Status = N'${PAID_INVOICE_STATUS}'
        AND NOT EXISTS (
          SELECT 1 FROM oe.Payments p
          WHERE p.InvoiceId = inv.InvoiceId
            AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
        )
    `;
    if (startDate && endDate) {
      creditInvoicesWhere += ` AND (${invoicePayoutWindowSql({ invAlias: 'inv', payoutBasis }).replace(/\s+/g, ' ')})`;
    } else {
      if (startDate) {
        creditInvoicesWhere += ` AND COALESCE(inv.BillingPeriodEnd, DATEADD(DAY, -1, DATEADD(MONTH, 1, inv.BillingPeriodStart))) >= @StartDate`;
      }
      if (endDate) {
        creditInvoicesWhere += ` AND inv.BillingPeriodStart < DATEADD(day, 1, @EndDate)`;
      }
    }
    if (groupId && groupId !== 'all') creditInvoicesWhere += ` AND inv.GroupId = @GroupId`;
    if (householdId && householdId !== 'all') creditInvoicesWhere += ` AND inv.HouseholdId = @HouseholdId`;
    const creditInvoicesResult = await creditInvoicesReq.query(`
      SELECT
        CAST(NULL AS UNIQUEIDENTIFIER) AS PaymentId,
        inv.InvoiceId,
        COALESCE(inv.PaymentReceivedDate, inv.BillingPeriodStart) AS PaymentDate,
        inv.ProductVendorAmounts,
        inv.GroupId,
        inv.HouseholdId,
        g.Name AS GroupName,
        hu.FirstName AS PrimaryFirstName,
        hu.LastName AS PrimaryLastName,
        hu.MemberId AS PrimaryMemberId
      FROM oe.Invoices inv
      LEFT JOIN oe.Groups g ON inv.GroupId = g.GroupId
      OUTER APPLY (
        SELECT TOP 1 u.FirstName, u.LastName, mm.MemberId
        FROM oe.Members mm
        INNER JOIN oe.Users u ON u.UserId = mm.UserId
        WHERE inv.HouseholdId IS NOT NULL
          AND mm.HouseholdId = inv.HouseholdId
          AND mm.RelationshipType = 'P'
      ) hu
      ${creditInvoicesWhere}
    `);

    // Merge credit-anchored rows into the recordset so the rest of the
    // pipeline (paid lookup, bucketing, modal rendering) treats them as
    // additional sources without per-call special-casing.
    paymentsResult.recordset = (paymentsResult.recordset || [])
      .concat(creditInvoicesResult.recordset || []);

    // Anchor key helper: payment-anchored rows key by PaymentId, credit-anchored
    // rows key by InvoiceId. Both are UUIDs so namespaces don't collide.
    const getAnchorKey = (p) => String(p.PaymentId || p.InvoiceId || '');

    // Optional filter: All / Paid / Unpaid (based on whether this vendor has been fully paid for the payment)
    // We treat Partial as Unpaid when filtering.
    const paidStatusNorm = (paidStatus || 'all').toString().toLowerCase();

    // Extract vendor amounts from JSON and build product map
    const productVendorAmounts = new Map(); // productId -> total vendor amount
    const paymentProductMap = new Map(); // paymentId -> Set of productIds

    paymentsResult.recordset.forEach(p => {
      const parsedRaw = parseJsonSafe(p.ProductVendorAmounts);
      const parsed = normalizeProductAmountsJson(parsedRaw);
      if (!parsed || typeof parsed !== 'object') return;
      
      Object.entries(parsed).forEach(([productId, data]) => {
        const vendorAmount = Number(data?.vendorAmount || 0);
        if (!vendorAmount || vendorAmount === 0) return;
        
        // Verify this product belongs to the vendor
        const productIdStr = String(productId);
        const ak = getAnchorKey(p);
        if (!ak) return;
        if (!paymentProductMap.has(ak)) {
          paymentProductMap.set(ak, new Set());
        }
        paymentProductMap.get(ak).add(productIdStr);
      });
    });

    // Get product IDs and verify they belong to this vendor
    const allProductIds = new Set();
    paymentProductMap.forEach((productIds) => {
      productIds.forEach(id => allProductIds.add(id));
    });

    const productIdToVendorId = new Map();
    if (allProductIds.size > 0) {
      const productIdsStr = Array.from(allProductIds)
        .map(id => `'${String(id).replace(/'/g, "''")}'`)
        .join(', ');

      const productReq = pool.request();
      const productResult = await productReq.query(`
        SELECT ProductId, VendorId
        FROM oe.Products
        WHERE ProductId IN (${productIdsStr})
      `);

      (productResult.recordset || []).forEach(r => {
        if (!r.ProductId || !r.VendorId) return;
        productIdToVendorId.set(r.ProductId.toString(), r.VendorId.toString());
      });
    }

    // Now extract vendor amounts for this specific vendor
    const vendorIdStr = vendorId.toString();
    let includedPaymentIdSet = null;

    // Per-anchor vendor share of this vendor (for proration & paid-detection).
    // Anchor = PaymentId for payment-funded rows, InvoiceId for credit-funded rows.
    const paymentVendorAmountByPaymentId = new Map(); // anchorKey -> vendorAmount
    // Per-anchor NACHA already paid to this vendor.
    const paidMap = new Map(); // anchorKey -> paidAmount

    {
      for (const p of paymentsResult.recordset || []) {
        const parsedRaw = parseJsonSafe(p.ProductVendorAmounts);
        const parsed = normalizeProductAmountsJson(parsedRaw);
        if (!parsed) continue;

        let vendorAmount = 0;
        for (const [productId, data] of Object.entries(parsed)) {
          const productVendorId = productIdToVendorId.get(String(productId));
          if (productVendorId !== vendorIdStr) continue;
          vendorAmount += Number(data?.vendorAmount || 0);
        }
        vendorAmount = Math.round(vendorAmount * 100) / 100;
        if (vendorAmount > 0) {
          const ak = getAnchorKey(p);
          if (ak) paymentVendorAmountByPaymentId.set(ak, vendorAmount);
        }
      }

      // Build separate PaymentId / InvoiceId IN sets so the paid-lookup SQL
      // can match payment-anchored npd rows by PaymentId and credit-anchored
      // rows by InvoiceId. Walk the merged recordset so credit-funded
      // anchors (PaymentId NULL, InvoiceId set) participate too.
      const paymentIdsForPaidCheck = new Set();
      const invoiceIdsForPaidCheck = new Set();
      for (const p of paymentsResult.recordset || []) {
        const ak = getAnchorKey(p);
        if (!ak || !paymentVendorAmountByPaymentId.has(ak)) continue;
        if (p.PaymentId) {
          paymentIdsForPaidCheck.add(String(p.PaymentId));
          // Linked invoice may also have npd rows keyed by InvoiceId once
          // createPaymentDetails starts populating it. Include it too.
          if (p.InvoiceId) invoiceIdsForPaidCheck.add(String(p.InvoiceId));
        } else if (p.InvoiceId) {
          invoiceIdsForPaidCheck.add(String(p.InvoiceId));
        }
      }

      if (paymentIdsForPaidCheck.size > 0 || invoiceIdsForPaidCheck.size > 0) {
        const clauses = [];
        if (paymentIdsForPaidCheck.size > 0) {
          const ids = Array.from(paymentIdsForPaidCheck).map(id => `'${id.replace(/'/g, "''")}'`).join(', ');
          clauses.push(`npd.PaymentId IN (${ids})`);
        }
        if (invoiceIdsForPaidCheck.size > 0) {
          const ids = Array.from(invoiceIdsForPaidCheck).map(id => `'${id.replace(/'/g, "''")}'`).join(', ');
          clauses.push(`npd.InvoiceId IN (${ids})`);
        }
        const paidRes = await pool.request().query(`
          SELECT
            npd.PaymentId,
            npd.InvoiceId,
            SUM(COALESCE(npd.Amount, 0)) as PaidAmount
          FROM oe.NACHAPaymentDetails npd
          INNER JOIN oe.NACHAGenerations ng ON npd.NACHAId = ng.NACHAId
          WHERE npd.RecipientEntityType = 'Vendor'
            AND npd.RecipientEntityId = '${String(vendorId).replace(/'/g, "''")}'
            AND ng.Status = 'Sent'
            AND ng.PayoutType = 'Vendor Payouts'
            AND (${clauses.join(' OR ')})
          GROUP BY npd.PaymentId, npd.InvoiceId
        `);
        (paidRes.recordset || []).forEach(r => {
          // Attribute paid back to its anchor: PaymentId for payment-anchored
          // npd rows, InvoiceId for credit-anchored. Both keys live in the
          // same paymentVendorAmountByPaymentId map (anchorKey-based).
          const ak = r.PaymentId
            ? String(r.PaymentId)
            : (r.InvoiceId ? String(r.InvoiceId) : null);
          if (!ak || !paymentVendorAmountByPaymentId.has(ak)) return;
          paidMap.set(ak, (paidMap.get(ak) || 0) + Number(r.PaidAmount || 0));
        });
      }
    }

    // If filtering by paid status, compute which payments are Paid vs Unpaid for this vendor
    if (paidStatusNorm === 'paid' || paidStatusNorm === 'unpaid') {
      includedPaymentIdSet = new Set();
      for (const [pid, vendorAmount] of paymentVendorAmountByPaymentId.entries()) {
        const alreadyPaid = Math.round((paidMap.get(pid) || 0) * 100) / 100;
        const remaining = Math.round(Math.max(0, vendorAmount - alreadyPaid) * 100) / 100;
        const isPaid = remaining <= 0.01;
        if (paidStatusNorm === 'paid' && isPaid) includedPaymentIdSet.add(pid);
        if (paidStatusNorm === 'unpaid' && !isPaid) includedPaymentIdSet.add(pid);
      }
    }

    const paymentsForJsonTotals = includedPaymentIdSet
      ? (paymentsResult.recordset || []).filter(p => includedPaymentIdSet.has(getAnchorKey(p)))
      : (paymentsResult.recordset || []);

    paymentsForJsonTotals.forEach(p => {
      const parsedRaw = parseJsonSafe(p.ProductVendorAmounts);
      const parsed = normalizeProductAmountsJson(parsedRaw);
      if (!parsed || typeof parsed !== 'object') return;
      
      Object.entries(parsed).forEach(([productId, data]) => {
        const productVendorId = productIdToVendorId.get(String(productId));
        if (productVendorId !== vendorIdStr) return; // Only this vendor
        
        const vendorAmount = Number(data?.vendorAmount || 0);
        if (!vendorAmount || vendorAmount === 0) return;
        
        const productIdStr = String(productId);
        const current = productVendorAmounts.get(productIdStr) || 0;
        productVendorAmounts.set(productIdStr, current + vendorAmount);
        
        // Debug: Log payments for Essential ShareWELL to track the $194
        if (productIdStr === 'F165AF93-8268-448D-9DD6-F02FB338EEAE') {
          const anchorLabel = p.PaymentId ? `Payment ${p.PaymentId}` : `Invoice ${p.InvoiceId} (credit)`;
          console.log(`💰 [Vendor Breakdown] ${anchorLabel} (${p.PaymentDate?.toISOString().substring(0, 10)}): $${vendorAmount.toFixed(2)} for Essential ShareWELL (GroupId: ${p.GroupId || 'Individual'})`);
        }
      });
    });

    // If filtering by payout status (Paid out / Pending payout), return a JSON-snapshot based breakdown
    // so totals actually reflect the selected payment subset (especially under group/individual filters).
    // We bucket by payment source (Group name OR primary member name) so admins can see exactly
    // which group/member makes up each pending or paid amount — no more opaque "no tier" rows.
    if (paidStatusNorm === 'paid' || paidStatusNorm === 'unpaid') {
      // productId -> sourceKey -> { sourceLabel, sourceType, groupId, householdId, totalVendorAmount, enrollmentCount, paymentIds:Set, payments:[] }
      const byProductThenSource = new Map();

      // Treat payments whose PaymentDate is after the filter range end as "late"
      // (coverage was for the selected period, but the payment arrived afterwards).
      const rangeEndMs = endDate ? new Date(endDate).getTime() : null;

      for (const p of paymentsForJsonTotals) {
        const parsedRaw = parseJsonSafe(p.ProductVendorAmounts);
        const parsed = normalizeProductAmountsJson(parsedRaw);
        if (!parsed || typeof parsed !== 'object') continue;

        const groupIdStr = p.GroupId ? String(p.GroupId).toUpperCase() : null;
        const householdIdStr = p.HouseholdId ? String(p.HouseholdId).toUpperCase() : null;
        const sourceKey = groupIdStr
          ? `group_${groupIdStr}`
          : (householdIdStr ? `household_${householdIdStr}` : `anchor_${getAnchorKey(p) || 'unknown'}`);
        const sourceType = groupIdStr ? 'group' : (householdIdStr ? 'individual' : 'payment');
        const sourceLabel = p.GroupName
          || (p.PrimaryFirstName || p.PrimaryLastName
            ? `${p.PrimaryFirstName || ''} ${p.PrimaryLastName || ''}`.trim()
            : 'Individual');

        const paymentDateMs = p.PaymentDate ? new Date(p.PaymentDate).getTime() : null;
        const isLate = !!(rangeEndMs && paymentDateMs && paymentDateMs > rangeEndMs);

        // Pre-compute paid proration ratio for this anchor (Payment or Invoice).
        const paymentPid = getAnchorKey(p);
        const paymentVendorTotal = paymentVendorAmountByPaymentId.get(paymentPid) || 0;
        const paymentAlreadyPaid = paidMap.get(paymentPid) || 0;
        const isCreditFunded = !p.PaymentId && !!p.InvoiceId;

        for (const [productId, data] of Object.entries(parsed)) {
          const productVendorId = productIdToVendorId.get(String(productId));
          if (productVendorId !== vendorIdStr) continue;
          const vendorAmount = Number(data?.vendorAmount || 0);
          if (!vendorAmount || vendorAmount === 0) continue;

          // Subtract this product's pro-rata share of any prior NACHA already sent to this vendor
          // for the underlying payment/invoice. Keeps modal sum aligned with parent's "Unpaid" math.
          const proRatedPaid = paymentVendorTotal > 0
            ? (vendorAmount / paymentVendorTotal) * paymentAlreadyPaid
            : 0;
          const remainingForRow = paidStatusNorm === 'unpaid'
            ? Math.max(0, vendorAmount - proRatedPaid)
            : vendorAmount;

          const count = Number(
            data?.enrolledHouseholdsCount !== undefined
              ? data.enrolledHouseholdsCount
              : (data?.enrollmentCount !== undefined ? data.enrollmentCount : 0)
          );

          const pkey = String(productId);
          if (!byProductThenSource.has(pkey)) byProductThenSource.set(pkey, new Map());
          const sourceMap = byProductThenSource.get(pkey);
          if (!sourceMap.has(sourceKey)) {
            sourceMap.set(sourceKey, {
              sourceLabel,
              sourceType,
              groupId: groupIdStr,
              householdId: householdIdStr,
              primaryMemberId: p.PrimaryMemberId ? String(p.PrimaryMemberId).toUpperCase() : null,
              totalVendorAmount: 0,
              _jsonHouseholdOrEnrollmentFallback: 0,
              paymentIds: new Set(),
              payments: []
            });
          }
          const entry = sourceMap.get(sourceKey);
          entry.totalVendorAmount += remainingForRow;
          if (count > 0) {
            entry._jsonHouseholdOrEnrollmentFallback =
              (entry._jsonHouseholdOrEnrollmentFallback || 0) + count;
          }
          // Anchor key dedupes both PaymentId-funded and credit-funded sources.
          const anchorKeyForRow = getAnchorKey(p);
          if (anchorKeyForRow && !entry.paymentIds.has(anchorKeyForRow)) {
            entry.paymentIds.add(anchorKeyForRow);
            entry.payments.push({
              paymentId: p.PaymentId ? String(p.PaymentId) : null,
              invoiceId: p.InvoiceId ? String(p.InvoiceId) : null,
              fundingSource: isCreditFunded ? 'Credit' : 'Payment',
              paymentDate: p.PaymentDate || null,
              isLate
            });
          }
        }
      }

      const snapPaymentIds = [
        ...new Set(
          (paymentsForJsonTotals || []).filter(p => p.PaymentId).map(p => String(p.PaymentId))
        ),
      ];
      const snapInvoiceIds = [
        ...new Set(
          (paymentsForJsonTotals || []).filter(p => p.InvoiceId).map(p => String(p.InvoiceId))
        ),
      ];
      const tierOpts = {
        tenantId,
        vendorId,
        startDate,
        endDate,
        payoutBasis,
        snapPaymentIds,
        snapInvoiceIds,
        groupId,
        householdId,
        enrollmentId,
        individuals,
      };
      const [groupTierMap, individualTierMap] = await Promise.all([
        fetchSnapshotGroupHouseholdTierAggregates(pool, tierOpts),
        fetchSnapshotIndividualHouseholdTierAggregates(pool, tierOpts),
      ]);

      // Fetch product names for products in snapshot (reuse existing lookup logic)
      const productNames = new Map();
      if (byProductThenSource.size > 0) {
        const productIdsStr = Array.from(byProductThenSource.keys())
          .map(id => `'${String(id).replace(/'/g, "''")}'`)
          .join(', ');
        const productNameReq = pool.request();
        productNameReq.input('VendorId', sql.UniqueIdentifier, vendorId);
        const productNameResult = await productNameReq.query(`
          SELECT ProductId, Name, VendorId
          FROM oe.Products
          WHERE ProductId IN (${productIdsStr})
            AND VendorId = @VendorId
        `);
        (productNameResult.recordset || []).forEach(r => {
          if (!r.ProductId) return;
          productNames.set(r.ProductId.toString(), r.Name || 'Unknown Product');
        });
      }

      const data = Array.from(byProductThenSource.entries())
        .map(([productId, sourceMap]) => {
          const tiers = Array.from(sourceMap.values())
            .map(entry => {
              const payments = (entry.payments || []).slice().sort((a, b) => {
                const ad = a.paymentDate ? new Date(a.paymentDate).getTime() : 0;
                const bd = b.paymentDate ? new Date(b.paymentDate).getTime() : 0;
                return ad - bd;
              });
              const lateCount = payments.filter(pp => pp.isLate).length;
              const earliest = payments.length ? payments[0].paymentDate : null;
              const latest = payments.length ? payments[payments.length - 1].paymentDate : null;
              const productIdUpper = String(productId).toUpperCase();
              let householdCount = entry._jsonHouseholdOrEnrollmentFallback || 0;
              let familyTierCounts = null;
              let familyTierSummary = null;
              if (entry.sourceType === 'group' && entry.groupId) {
                const agg = groupTierMap.get(`${entry.groupId}::${productIdUpper}`);
                if (agg && agg.total > 0) {
                  householdCount = agg.total;
                  familyTierCounts = Object.fromEntries(agg.counts);
                  familyTierSummary = formatFamilyTierSummary(agg.counts);
                }
              } else if (entry.sourceType === 'individual' && entry.householdId) {
                const agg = individualTierMap.get(`${entry.householdId}::${productIdUpper}`);
                if (agg && agg.total > 0) {
                  householdCount = agg.total;
                  familyTierCounts = Object.fromEntries(agg.counts);
                  familyTierSummary = formatFamilyTierSummary(agg.counts);
                }
              }
              return {
                productPricingId: null,
                pricingTier: entry.sourceLabel || 'Unknown',
                sourceType: entry.sourceType,
                groupId: entry.groupId,
                householdId: entry.householdId,
                primaryMemberId: entry.primaryMemberId,
                householdCount,
                enrollmentCount: householdCount,
                familyTierCounts,
                familyTierSummary,
                paymentCount: entry.paymentIds.size,
                lateCount,
                earliestPaymentDate: earliest,
                latestPaymentDate: latest,
                payments,
                vendorAmount: Math.round(entry.totalVendorAmount * 100) / 100,
                totalVendorAmount: Math.round(entry.totalVendorAmount * 100) / 100
              };
            })
            .sort((a, b) => (b.totalVendorAmount || 0) - (a.totalVendorAmount || 0));

          const totalVendorAmount = Math.round(
            tiers.reduce((s, t) => s + (t.totalVendorAmount || 0), 0) * 100
          ) / 100;

          const productLateCount = tiers.reduce((s, t) => s + (t.lateCount || 0), 0);

          return {
            productId,
            productName: productNames.get(productId) || 'Unknown Product',
            breakdownType: 'snapshot',
            lateCount: productLateCount,
            tiers,
            totalVendorAmount
          };
        })
        .sort((a, b) => (a.productName || '').localeCompare(b.productName || ''));

      return res.json({ success: true, data, vendorPayoutBasis: payoutBasis });
    }

    // If we filtered, we need a paymentId IN (...) clause for the enrollment EXISTS logic below
    const paymentIdInClause = includedPaymentIdSet && includedPaymentIdSet.size > 0
      ? `AND p.PaymentId IN (${Array.from(includedPaymentIdSet).map(id => `'${String(id).replace(/'/g, "''")}'`).join(', ')})`
      : '';

    // Get breakdown for household payments with enrollment details
    // CRITICAL: Only count PRIMARY MEMBER enrollments (RelationshipType = 'P')
    // Only primary members have PremiumAmount, NetRate, OverrideRate, etc.
    // CRITICAL: Start from Enrollments, not Payments, to avoid counting duplicates
    // Count each enrollment only ONCE, even if there are multiple payments in the date range
    // Intentionally skip enrollment matching for individual/non-group payments.
    // Individual rows use payment snapshot JSON as source of truth and mismatch visibility.
    const householdBreakdownResult = { recordset: [] };
    
    // Log household breakdown details
    if (householdBreakdownResult.recordset?.length > 0) {
      let totalHouseholdEnrollments = 0;
      let totalHouseholdHouseholds = 0;
      householdBreakdownResult.recordset.forEach(r => {
        totalHouseholdEnrollments += Number(r.EnrollmentCount || 0);
        totalHouseholdHouseholds += Number(r.HouseholdCount || 0);
      });
      console.log(`📊 [Vendor Breakdown] Household payments: ${totalHouseholdEnrollments} enrollments across ${totalHouseholdHouseholds} households`);
    }

    // Get breakdown for group payments with enrollment details
    // CRITICAL: Only count PRIMARY MEMBER enrollments (RelationshipType = 'P')
    // Only primary members have PremiumAmount, NetRate, OverrideRate, etc.
    // CRITICAL: Start from Enrollments, not Payments, to avoid counting duplicates
    // Count each enrollment only ONCE, even if there are multiple payments in the date range
    const groupBreakdownResult = await breakdownReq.query(`
      SELECT
        e.ProductId,
        pr.Name as ProductName,
        e.ProductPricingId,
        pp.Label as PricingTier,
        pp.MinAge,
        pp.MaxAge,
        pp.NetRate,
        COUNT(DISTINCT e.EnrollmentId) as EnrollmentCount,
        COUNT(DISTINCT m.HouseholdId) as HouseholdCount,
        SUM(DISTINCT pp.NetRate) * COUNT(DISTINCT e.EnrollmentId) as TotalVendorAmount
      FROM oe.Enrollments e
      -- CRITICAL: Join to Members to filter to PRIMARY MEMBERS only
      INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        AND m.RelationshipType = 'P' -- Only primary members have premium amounts
      LEFT JOIN oe.Products pr ON pr.ProductId = e.ProductId
      LEFT JOIN oe.ProductPricing pp ON pp.ProductPricingId = e.ProductPricingId
      WHERE (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
        -- Date-based active logic only. Do not rely on enrollment Status for active coverage checks.
        AND e.ProductId IS NOT NULL
        AND e.ProductId != '00000000-0000-0000-0000-000000000000'
        AND e.ProductId NOT IN (
          SELECT DISTINCT BundleProductId
          FROM oe.ProductBundles
          WHERE BundleProductId IS NOT NULL
        )
        AND e.ProductPricingId IS NOT NULL
        AND m.GroupId IS NOT NULL
        AND m.TenantId = @TenantId
        AND pr.VendorId = @VendorId
        ${groupId && groupId !== 'all' ? 'AND m.GroupId = @GroupId' : ''}
        ${enrollmentId && enrollmentId !== 'all' ? 'AND e.EnrollmentId = @EnrollmentId' : ''}
        ${individuals && individuals === 'true' ? 'AND 1=0' : ''} -- Exclude group payments when filtering for individuals
        -- Enrollment must be active during ANY payment in the date range
        -- For GROUP payments: EffectiveDate must be within payment month, TerminationDate must be NULL or after month end
        -- NOTE: If TerminationDate = EOMONTH(p.PaymentDate), the enrollment is excluded because we use > (not >=)
        -- This means enrollments terminating on the last day of the payment month are NOT included
        AND EXISTS (
          SELECT 1
          FROM oe.Payments p
          LEFT JOIN oe.Invoices inv2 ON p.InvoiceId = inv2.InvoiceId
          WHERE p.GroupId = m.GroupId
            AND p.TenantId = @TenantId
            AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
            AND (p.InvoiceId IS NULL OR inv2.Status = N'${PAID_INVOICE_STATUS}')
            ${buildDateFilter(payoutBasis, { startDate, endDate, invoiceAlias: 'inv2' })}
            ${paymentIdInClause}
            ${groupId && groupId !== 'all' ? 'AND p.GroupId = @GroupId' : ''}
            AND e.EffectiveDate <= COALESCE(inv2.BillingPeriodEnd, p.PaymentDate)
            AND (e.TerminationDate IS NULL OR e.TerminationDate > COALESCE(inv2.BillingPeriodStart, p.PaymentDate))
            AND NOT EXISTS (
              SELECT 1 FROM oe.Invoices ind
              WHERE ind.HouseholdId = m.HouseholdId
                AND ind.InvoiceType = N'Individual'
                AND ind.BillingPeriodStart = inv2.BillingPeriodStart
                AND ind.BillingPeriodEnd = inv2.BillingPeriodEnd
                AND ind.Status IN (N'Paid', N'Partial', N'Unpaid')
            )
        )
      GROUP BY e.ProductId, pr.Name, e.ProductPricingId, pp.Label, pp.MinAge, pp.MaxAge, pp.NetRate
    `);

    // Group-level enrollment totals (for discrepancy attribution by group)
    const groupEnrollmentTotalsResult = await breakdownReq.query(`
      SELECT
        e.ProductId,
        m.GroupId,
        g.Name as GroupName,
        SUM(COALESCE(pp.NetRate, 0)) as EnrollmentVendorAmount
      FROM oe.Enrollments e
      INNER JOIN oe.Members m ON e.MemberId = m.MemberId
        AND m.RelationshipType = 'P'
      LEFT JOIN oe.Products pr ON pr.ProductId = e.ProductId
      LEFT JOIN oe.ProductPricing pp ON pp.ProductPricingId = e.ProductPricingId
      LEFT JOIN oe.Groups g ON g.GroupId = m.GroupId
      WHERE (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
        AND e.ProductId IS NOT NULL
        AND e.ProductId != '00000000-0000-0000-0000-000000000000'
        AND e.ProductId NOT IN (
          SELECT DISTINCT BundleProductId
          FROM oe.ProductBundles
          WHERE BundleProductId IS NOT NULL
        )
        AND e.ProductPricingId IS NOT NULL
        AND m.GroupId IS NOT NULL
        AND m.TenantId = @TenantId
        AND pr.VendorId = @VendorId
        ${groupId && groupId !== 'all' ? 'AND m.GroupId = @GroupId' : ''}
        ${enrollmentId && enrollmentId !== 'all' ? 'AND e.EnrollmentId = @EnrollmentId' : ''}
        ${individuals && individuals === 'true' ? 'AND 1=0' : ''}
        AND EXISTS (
          SELECT 1
          FROM oe.Payments p
          LEFT JOIN oe.Invoices inv2 ON p.InvoiceId = inv2.InvoiceId
          WHERE p.GroupId = m.GroupId
            AND p.TenantId = @TenantId
            AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
            AND (p.InvoiceId IS NULL OR inv2.Status = N'${PAID_INVOICE_STATUS}')
            ${buildDateFilter(payoutBasis, { startDate, endDate, invoiceAlias: 'inv2' })}
            ${paymentIdInClause}
            ${groupId && groupId !== 'all' ? 'AND p.GroupId = @GroupId' : ''}
            AND e.EffectiveDate <= COALESCE(inv2.BillingPeriodEnd, p.PaymentDate)
            AND (e.TerminationDate IS NULL OR e.TerminationDate > COALESCE(inv2.BillingPeriodStart, p.PaymentDate))
            AND NOT EXISTS (
              SELECT 1 FROM oe.Invoices ind
              WHERE ind.HouseholdId = m.HouseholdId
                AND ind.InvoiceType = N'Individual'
                AND ind.BillingPeriodStart = inv2.BillingPeriodStart
                AND ind.BillingPeriodEnd = inv2.BillingPeriodEnd
                AND ind.Status IN (N'Paid', N'Partial', N'Unpaid')
            )
        )
      GROUP BY e.ProductId, m.GroupId, g.Name
    `);
    
    // Log group breakdown details
    if (groupBreakdownResult.recordset?.length > 0) {
      let totalGroupEnrollments = 0;
      let totalGroupHouseholds = 0;
      groupBreakdownResult.recordset.forEach(r => {
        totalGroupEnrollments += Number(r.EnrollmentCount || 0);
        totalGroupHouseholds += Number(r.HouseholdCount || 0);
      });
      console.log(`📊 [Vendor Breakdown] Group payments: ${totalGroupEnrollments} enrollments across ${totalGroupHouseholds} households`);
    }

    // Get product names for products in JSON
    const productNames = new Map();
    if (allProductIds.size > 0) {
      const productIdsStr = Array.from(allProductIds)
        .map(id => `'${String(id).replace(/'/g, "''")}'`)
        .join(', ');

      const productNameReq = pool.request();
      productNameReq.input('VendorId', sql.UniqueIdentifier, vendorId);
      const productNameResult = await productNameReq.query(`
        SELECT ProductId, Name, VendorId
        FROM oe.Products
        WHERE ProductId IN (${productIdsStr})
          AND VendorId = @VendorId
      `);

      (productNameResult.recordset || []).forEach(r => {
        if (!r.ProductId) return;
        productNames.set(r.ProductId.toString(), r.Name || 'Unknown Product');
      });
    }

    // Combine and aggregate by product and tier
    const productMap = new Map();
    
    // Log enrollment details for debugging
    console.log(`🔍 [Vendor Breakdown] Processing breakdown for vendor ${vendorId}`);
    console.log(`📊 [Vendor Breakdown] Household payments: ${householdBreakdownResult.recordset?.length || 0} tier groups`);
    console.log(`📊 [Vendor Breakdown] Group payments: ${groupBreakdownResult.recordset?.length || 0} tier groups`);
    
    // Calculate totals for debugging
    let totalEnrollmentCount = 0;
    let totalHouseholdCount = 0;
    
    // First, add enrollment-based breakdown (with tier details)
    [...(householdBreakdownResult.recordset || []), ...(groupBreakdownResult.recordset || [])].forEach(r => {
      totalEnrollmentCount += Number(r.EnrollmentCount || 0);
      totalHouseholdCount += Number(r.HouseholdCount || 0);
      // Log each tier group for debugging
      console.log(`✅ [Vendor Breakdown] ${r.ProductName} - ${r.PricingTier}: ${r.EnrollmentCount} enrollments (${r.HouseholdCount || 'N/A'} households), $${r.TotalVendorAmount.toFixed(2)} total`);
      
      const productId = r.ProductId ? r.ProductId.toString() : null;
      const productPricingId = r.ProductPricingId ? r.ProductPricingId.toString() : null;
      if (!productId || !productPricingId) return;

      const productKey = productId;
      const tierKey = `${productId}_${productPricingId}`;

      if (!productMap.has(productKey)) {
        productMap.set(productKey, {
          productId: productId,
          productName: r.ProductName || productNames.get(productId) || 'Unknown Product',
          tiers: new Map(),
          totalVendorAmount: 0,
          hasEnrollmentDetails: true
        });
      }

      const product = productMap.get(productKey);
      
      if (!product.tiers.has(tierKey)) {
        // Format tier label with age band if available
        let tierLabel = r.PricingTier || 'Unknown Tier';
        if (r.MinAge !== null && r.MinAge !== undefined && r.MaxAge !== null && r.MaxAge !== undefined) {
          tierLabel = `${tierLabel} (Age ${r.MinAge}-${r.MaxAge})`;
        } else if (r.MinAge !== null && r.MinAge !== undefined) {
          tierLabel = `${tierLabel} (Age ${r.MinAge}+)`;
        }
        
        product.tiers.set(tierKey, {
          productPricingId: productPricingId,
          pricingTier: tierLabel,
          householdCount: 0,
          enrollmentCount: 0,
          vendorAmount: Number(r.NetRate || 0),
          totalVendorAmount: 0
        });
      }

      const tier = product.tiers.get(tierKey);
      const hh = Number(r.HouseholdCount || 0);
      tier.householdCount += hh;
      tier.enrollmentCount = tier.householdCount;
      tier.totalVendorAmount += Number(r.TotalVendorAmount || 0);
      product.totalVendorAmount += Number(r.TotalVendorAmount || 0);
    });

    // Then, add products from JSON that don't have enrollment matches
    // This handles cases where enrollments are missing/terminated but payments exist
    // Only show unmatched amounts when viewing "All Group & Member Payments" (no specific filter)
    const isTargetedFilter = (groupId && groupId !== 'all') || (householdId && householdId !== 'all') || (enrollmentId && enrollmentId !== 'all');
    // Reconciliation discrepancies are actionable only for pending vendor payouts.
    // In "all" view, historical paid cycles can create expected structural drift.
    const shouldShowDiscrepancy = paidStatusNorm === 'unpaid' && !isTargetedFilter;

    // Build snapshot-attribution maps used for discrepancy details:
    // - individualSnapshotByProduct: dollars from individual payments (GroupId is NULL)
    // - groupSnapshotByProductGroup: dollars by product/group from payment snapshots
    const individualSnapshotByProduct = new Map();
    const groupSnapshotByProductGroup = new Map();
    const groupNameByGroupId = new Map();
    for (const p of paymentsForJsonTotals) {
      const parsed = normalizeProductAmountsJson(parseJsonSafe(p.ProductVendorAmounts));
      if (!parsed || typeof parsed !== 'object') continue;
      const paymentGroupId = p.GroupId ? String(p.GroupId) : null;
      if (paymentGroupId && p.GroupName) {
        groupNameByGroupId.set(paymentGroupId, p.GroupName);
      }

      for (const [productId, data] of Object.entries(parsed)) {
        const productVendorId = productIdToVendorId.get(String(productId));
        if (productVendorId !== vendorIdStr) continue;
        const vendorAmount = Number(data?.vendorAmount || 0);
        if (!vendorAmount || vendorAmount === 0) continue;

        const productIdStr = String(productId);
        if (!paymentGroupId) {
          const current = Number(individualSnapshotByProduct.get(productIdStr) || 0);
          individualSnapshotByProduct.set(productIdStr, current + vendorAmount);
        } else {
          const key = `${productIdStr}::${paymentGroupId}`;
          const current = Number(groupSnapshotByProductGroup.get(key) || 0);
          groupSnapshotByProductGroup.set(key, current + vendorAmount);
        }
      }
    }

    const groupEnrollmentByProductGroup = new Map();
    (groupEnrollmentTotalsResult.recordset || []).forEach((r) => {
      if (!r.ProductId || !r.GroupId) return;
      const key = `${String(r.ProductId)}::${String(r.GroupId)}`;
      groupEnrollmentByProductGroup.set(key, Number(r.EnrollmentVendorAmount || 0));
      if (r.GroupName) groupNameByGroupId.set(String(r.GroupId), r.GroupName);
    });
    
    productVendorAmounts.forEach((totalAmount, productId) => {
      const productVendorId = productIdToVendorId.get(productId);
      if (productVendorId !== vendorIdStr) return; // Only this vendor

      if (!productMap.has(productId)) {
        // Product exists in payments but no matching enrollments found
        // Only show this if we're viewing all payments (not filtered)
        if (!isTargetedFilter) {
          productMap.set(productId, {
            productId: productId,
            productName: productNames.get(productId) || 'Unknown Product',
            tiers: new Map(),
            totalVendorAmount: totalAmount,
            hasEnrollmentDetails: false
          });
          
          // Add a single tier entry showing the total amount without tier details
          const product = productMap.get(productId);
          product.tiers.set(`${productId}_unknown`, {
            productPricingId: null,
            pricingTier: 'No enrollment details available',
            enrollmentCount: 0,
            vendorAmount: 0,
            totalVendorAmount: totalAmount
          });
        }
      } else {
        // Product has enrollment details, but check if JSON total matches
        // Only show discrepancies when viewing all payments (not filtered)
        const product = productMap.get(productId);
        const enrollmentTotal = product.totalVendorAmount;
        const jsonTotal = totalAmount;
        const difference = Math.abs(jsonTotal - enrollmentTotal);
        const tolerance = 0.01; // Allow for small rounding differences
        
        if (shouldShowDiscrepancy && difference > tolerance) {
          if (jsonTotal > enrollmentTotal) {
            // JSON has more than enrollments - missing enrollment details
            console.log(`⚠️ [Vendor Breakdown] Unmatched amount for ${product.productName}: JSON total $${jsonTotal.toFixed(2)}, Enrollment total $${enrollmentTotal.toFixed(2)}, Difference $${difference.toFixed(2)}`);
            
            // Find which payments have this product
            paymentsResult.recordset.forEach(p => {
              const parsed = normalizeProductAmountsJson(parseJsonSafe(p.ProductVendorAmounts));
              if (!parsed || typeof parsed !== 'object') return;
              const productData = parsed[String(productId).toUpperCase()];
              if (productData && Number(productData.vendorAmount || 0) > 0) {
                const productVendorId = productIdToVendorId.get(productId);
                if (productVendorId === vendorIdStr) {
                  const anchorLabel = p.PaymentId ? `Payment ${p.PaymentId}` : `Invoice ${p.InvoiceId} (credit)`;
                  console.log(`  💰 ${anchorLabel} (${p.PaymentDate?.toISOString().substring(0, 10)}): $${Number(productData.vendorAmount || 0).toFixed(2)} for ${product.productName} (GroupId: ${p.GroupId || 'Individual'})`);
                }
              }
            });

            // Split discrepancy into actionable buckets:
            // 1) Individuals (snapshot-only by design)
            // 2) Group-level mismatches (snapshot vs enrollment) per group
            let detailedDiffTotal = 0;
            const productIdStr = String(productId);

            const individualAmount = Number(individualSnapshotByProduct.get(productIdStr) || 0);
            if (individualAmount > tolerance) {
              detailedDiffTotal += individualAmount;
              product.tiers.set(`${productId}_individual_snapshot_only`, {
                productPricingId: null,
                pricingTier: 'Individual snapshot-only amount (not enrollment-validated)',
                enrollmentCount: 0,
                vendorAmount: 0,
                totalVendorAmount: Math.round(individualAmount * 100) / 100
              });
            }

            for (const [key, snapshotAmountRaw] of groupSnapshotByProductGroup.entries()) {
              const [pid, gid] = key.split('::');
              if (pid !== productIdStr) continue;
              const snapshotAmount = Number(snapshotAmountRaw || 0);
              const enrollmentAmount = Number(groupEnrollmentByProductGroup.get(key) || 0);
              const groupDiff = Math.round((snapshotAmount - enrollmentAmount) * 100) / 100;
              if (Math.abs(groupDiff) <= tolerance) continue;

              const groupName = groupNameByGroupId.get(gid) || `Group ${gid}`;
              detailedDiffTotal += groupDiff;
              product.tiers.set(`${productId}_group_mismatch_${gid}`, {
                productPricingId: null,
                pricingTier: `Group mismatch - ${groupName}`,
                enrollmentCount: 0,
                vendorAmount: 0,
                totalVendorAmount: groupDiff
              });
            }

            const residual = Math.round((difference - detailedDiffTotal) * 100) / 100;
            if (Math.abs(residual) > tolerance) {
              product.tiers.set(`${productId}_unmatched`, {
                productPricingId: null,
                pricingTier: 'Unmatched amount (no enrollment details)',
                enrollmentCount: 0,
                vendorAmount: 0,
                totalVendorAmount: residual
              });
            }
            product.totalVendorAmount = jsonTotal; // Use JSON total as source of truth
          } else if (enrollmentTotal > jsonTotal) {
            // Enrollments show more than JSON - excess enrollment amount
            product.tiers.set(`${productId}_excess`, {
              productPricingId: null,
              pricingTier: 'Excess enrollment amount (not in payment JSON)',
              enrollmentCount: 0,
              vendorAmount: 0,
              totalVendorAmount: -difference // Negative to show it's excess
            });
            // Keep enrollment total but note the discrepancy
            // The product total will show enrollment total, which is higher than JSON
          }
        } else if (isTargetedFilter) {
          // When filtered, use enrollment total (don't show discrepancies)
          // This is because we can't attribute unmatched/excess amounts to the specific filter
        } else {
          // Totals match (within tolerance) - use JSON as source of truth
          product.totalVendorAmount = jsonTotal;
        }
      }
    });

    // Convert to array format
    const data = Array.from(productMap.values()).map(product => ({
      productId: product.productId,
      productName: product.productName,
      tiers: Array.from(product.tiers.values()).sort((a, b) => 
        (a.pricingTier || '').localeCompare(b.pricingTier || '')
      ),
      totalVendorAmount: Math.round(product.totalVendorAmount * 100) / 100
    })).sort((a, b) => (a.productName || '').localeCompare(b.productName || ''));

    res.json({ success: true, data, vendorPayoutBasis: payoutBasis });
  } catch (error) {
    console.error('Error building vendor breakdown:', error);
    res.status(500).json({ success: false, message: 'Failed to build vendor breakdown' });
  }
});

/**
 * GET /api/accounting/vendor-breakdown/payments
 * Query params: vendorId, startDate, endDate, groupId (optional), householdId (optional), individuals (optional)
 *
 * Returns payment-level rows for the vendor within the selected PaymentDate range, including:
 * - How much of each payment goes to the vendor (from oe.Payments.ProductVendorAmounts snapshot)
 * - How much has already been paid to the vendor (from oe.NACHAPaymentDetails linked to Sent Vendor Payouts)
 */
router.get('/vendor-breakdown/payments', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant context missing' });
    }

    const { vendorId, startDate, endDate, groupId, householdId, individuals, paidStatus } = req.query;
    if (!vendorId) {
      return res.status(400).json({ success: false, message: 'vendorId is required' });
    }

    const pool = await getPool();
    const payoutBasis = await getVendorPayoutBasis(tenantId);
    const req1 = pool.request();
    req1.input('TenantId', sql.UniqueIdentifier, tenantId);
    req1.input('VendorId', sql.UniqueIdentifier, vendorId);
    if (startDate) req1.input('StartDate', sql.Date, startDate);
    if (endDate) req1.input('EndDate', sql.Date, endDate);
    if (groupId && groupId !== 'all') req1.input('GroupId', sql.UniqueIdentifier, groupId);
    if (householdId && householdId !== 'all') req1.input('HouseholdId', sql.UniqueIdentifier, householdId);

    let whereClause = `
      WHERE p.TenantId = @TenantId
        AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
        AND (p.InvoiceId IS NULL OR inv.Status = N'${PAID_INVOICE_STATUS}')
        ${buildDateFilter(payoutBasis, { startDate, endDate })}
        ${groupId && groupId !== 'all' ? 'AND p.GroupId = @GroupId' : ''}
        ${householdId && householdId !== 'all' ? 'AND p.HouseholdId = @HouseholdId' : ''}
    `;
    if (individuals && individuals === 'true') {
      whereClause += ` AND p.GroupId IS NULL`;
    }

    const paymentsResult = await req1.query(`
      SELECT
        p.PaymentId,
        p.PaymentDate,
        p.Amount as PaymentAmount,
        -- Invoice-sourced payouts: prefer invoice breakdowns with payment fallback
        COALESCE(inv.ProductVendorAmounts, p.ProductVendorAmounts) as ProductVendorAmounts,
        p.GroupId,
        p.HouseholdId,
        g.Name as GroupName,
        hu.FirstName,
        hu.LastName,
        hu.MemberId as PrimaryMemberId
      FROM oe.Payments p
      LEFT JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
      LEFT JOIN oe.Groups g ON p.GroupId = g.GroupId
      OUTER APPLY (
        SELECT TOP 1 u.FirstName, u.LastName, mm.MemberId
        FROM oe.Members mm
        INNER JOIN oe.Users u ON u.UserId = mm.UserId
        WHERE p.HouseholdId IS NOT NULL
          AND mm.HouseholdId = p.HouseholdId
          AND mm.RelationshipType = 'P'
      ) hu
      ${whereClause}
      ORDER BY p.PaymentDate DESC, p.Amount DESC
    `);

    const payments = paymentsResult.recordset || [];
    if (payments.length === 0) {
      return res.json({ success: true, data: [] });
    }

    // Build productId set across payments, then load which of those belong to this vendor
    const productIds = new Set();
    const parsedByPaymentId = new Map();
    for (const p of payments) {
      const parsedRaw = parseJsonSafe(p.ProductVendorAmounts);
      const parsed = normalizeProductAmountsJson(parsedRaw);
      if (!parsed) continue;
      parsedByPaymentId.set(String(p.PaymentId), parsed);
      Object.keys(parsed).forEach((pid) => productIds.add(pid.toUpperCase()));
    }

    const vendorProductIds = new Set();
    if (productIds.size > 0) {
      const productIdsStr = Array.from(productIds)
        .map(id => `'${String(id).replace(/'/g, "''")}'`)
        .join(', ');
      const prRes = await pool.request().query(`
        SELECT ProductId
        FROM oe.Products
        WHERE VendorId = '${String(vendorId).replace(/'/g, "''")}'
          AND ProductId IN (${productIdsStr})
      `);
      (prRes.recordset || []).forEach(r => {
        if (r.ProductId) vendorProductIds.add(String(r.ProductId).toUpperCase());
      });
    }

    // Compute vendor amount per payment
    const rows = [];
    const paymentIds = [];
    for (const p of payments) {
      const paymentId = String(p.PaymentId);
      const parsed = parsedByPaymentId.get(paymentId);
      if (!parsed) continue;
      let vendorAmount = 0;
      for (const [productId, data] of Object.entries(parsed)) {
        if (!vendorProductIds.has(String(productId).toUpperCase())) continue;
        vendorAmount += Number(data?.vendorAmount || 0);
      }
      vendorAmount = Math.round(vendorAmount * 100) / 100;
      if (vendorAmount <= 0) continue;

      const sourceName = p.GroupName
        ? p.GroupName
        : ((p.FirstName || p.LastName) ? `${p.FirstName || ''} ${p.LastName || ''}`.trim() : 'Unknown');

      rows.push({
        paymentId,
        paymentDate: p.PaymentDate,
        paymentAmount: Number(p.PaymentAmount || 0),
        sourceName,
        sourceType: p.GroupId ? 'group' : (p.HouseholdId ? 'individual' : 'payment'),
        groupId: p.GroupId ? String(p.GroupId) : null,
        groupName: p.GroupName || null,
        householdId: p.HouseholdId ? String(p.HouseholdId) : null,
        primaryMemberId: p.PrimaryMemberId ? String(p.PrimaryMemberId) : null,
        vendorAmount
      });
      paymentIds.push(paymentId);
    }

    if (rows.length === 0) {
      return res.json({ success: true, data: [] });
    }

    // Paid-to-vendor amounts (Sent vendor NACHA payments) for these paymentIds.
    // We also match by InvoiceId because invoice-anchored NACHA details (credit-
    // funded payouts) carry npd.PaymentId only when there's a backing payment;
    // pre-shift those rows were dropped silently.
    const paidMap = new Map(); // paymentId -> paidAmount
    {
      const paymentIdsStr = paymentIds.map(id => `'${String(id).replace(/'/g, "''")}'`).join(', ');
      // Also collect the invoice ids backing these payments so npd rows that are
      // stamped only by InvoiceId still get attributed back to the right payment.
      const invoiceIdsForPaymentsRes = await pool.request().query(`
        SELECT p.PaymentId, p.InvoiceId
        FROM oe.Payments p
        WHERE p.PaymentId IN (${paymentIdsStr}) AND p.InvoiceId IS NOT NULL
      `);
      const invoiceIdToPaymentId = new Map();
      const allInvoiceIds = [];
      (invoiceIdsForPaymentsRes.recordset || []).forEach((r) => {
        if (r.InvoiceId && r.PaymentId) {
          const invKey = String(r.InvoiceId).toUpperCase();
          invoiceIdToPaymentId.set(invKey, String(r.PaymentId));
          allInvoiceIds.push(invKey);
        }
      });
      const anchorClauses = [`npd.PaymentId IN (${paymentIdsStr})`];
      if (allInvoiceIds.length > 0) {
        const invoiceIdsStr = allInvoiceIds.map(id => `'${id.replace(/'/g, "''")}'`).join(', ');
        anchorClauses.push(`npd.InvoiceId IN (${invoiceIdsStr})`);
      }
      const paidRes = await pool.request().query(`
        SELECT
          npd.PaymentId,
          npd.InvoiceId,
          SUM(COALESCE(npd.Amount, 0)) as PaidAmount
        FROM oe.NACHAPaymentDetails npd
        INNER JOIN oe.NACHAGenerations ng ON npd.NACHAId = ng.NACHAId
        WHERE npd.RecipientEntityType = 'Vendor'
          AND npd.RecipientEntityId = '${String(vendorId).replace(/'/g, "''")}'
          AND ng.Status = 'Sent'
          AND ng.PayoutType = 'Vendor Payouts'
          AND (${anchorClauses.join(' OR ')})
        GROUP BY npd.PaymentId, npd.InvoiceId
      `);
      (paidRes.recordset || []).forEach(r => {
        const pid = r.PaymentId
          ? String(r.PaymentId)
          : (r.InvoiceId ? invoiceIdToPaymentId.get(String(r.InvoiceId).toUpperCase()) : null);
        if (!pid) return;
        paidMap.set(pid, (paidMap.get(pid) || 0) + Number(r.PaidAmount || 0));
      });
    }

    const data = rows.map(r => {
      const alreadyPaid = Math.round((paidMap.get(r.paymentId) || 0) * 100) / 100;
      const remaining = Math.round(Math.max(0, (r.vendorAmount || 0) - alreadyPaid) * 100) / 100;
      const status =
        alreadyPaid >= (r.vendorAmount || 0) - 0.01 ? 'Paid' :
        alreadyPaid > 0 ? 'Partial' : 'Unpaid';

      return {
        ...r,
        vendorAlreadyPaid: alreadyPaid,
        vendorRemaining: remaining,
        payoutStatus: status
      };
    });

    const paidStatusNorm = (paidStatus || 'all').toString().toLowerCase();
    const filtered = paidStatusNorm === 'paid'
      ? data.filter(d => d.vendorRemaining <= 0.01)
      : paidStatusNorm === 'unpaid'
        ? data.filter(d => d.vendorRemaining > 0.01)
        : data;

    return res.json({ success: true, data: filtered });
  } catch (error) {
    console.error('Error getting vendor payment list:', error);
    return res.status(500).json({ success: false, message: 'Failed to load vendor payments' });
  }
});

/**
 * GET /api/accounting/vendor-breakdown/invoices
 * Query params: vendorId, startDate, endDate, groupId (optional), householdId (optional), individuals (optional), paidStatus (optional)
 *
 * Invoice-anchored counterpart to `/payments`. Returns paid invoices whose
 * billing period overlaps the selected window. Each row carries the vendor's
 * share (from inv.ProductVendorAmounts), the amount already disbursed to this
 * vendor in prior NACHA runs (linked by InvoiceId or by the invoice's settling
 * payment), the remaining payable, and the funding source ('Payment' for
 * invoices settled via oe.Payments, 'Credit' for credit-funded invoices that
 * have no payment row).
 */
router.get('/vendor-breakdown/invoices', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant context missing' });
    }

    const { vendorId, startDate, endDate, groupId, householdId, individuals, paidStatus } = req.query;
    if (!vendorId) {
      return res.status(400).json({ success: false, message: 'vendorId is required' });
    }
    if (!startDate || !endDate) {
      return res.json({ success: true, data: [] });
    }

    const pool = await getPool();
    const r = pool.request();
    r.input('TenantId', sql.UniqueIdentifier, tenantId);
    r.input('VendorId', sql.UniqueIdentifier, vendorId);
    r.input('StartDate', sql.Date, startDate);
    r.input('EndDate', sql.Date, endDate);
    if (groupId && groupId !== 'all') r.input('GroupId', sql.UniqueIdentifier, groupId);
    if (householdId && householdId !== 'all') r.input('HouseholdId', sql.UniqueIdentifier, householdId);

    let whereClause = `
      WHERE inv.TenantId = @TenantId
        AND inv.Status = N'Paid'
        AND inv.BillingPeriodStart IS NOT NULL
        AND CAST(inv.BillingPeriodStart AS DATE) <= CAST(@EndDate AS DATE)
        AND CAST(inv.BillingPeriodEnd AS DATE) >= CAST(@StartDate AS DATE)
        ${groupId && groupId !== 'all' ? 'AND inv.GroupId = @GroupId' : ''}
        ${householdId && householdId !== 'all' ? 'AND inv.HouseholdId = @HouseholdId' : ''}
    `;
    if (individuals && individuals === 'true') {
      whereClause += ` AND inv.GroupId IS NULL`;
    }

    const invoicesResult = await r.query(`
      SELECT
        inv.InvoiceId,
        inv.InvoiceNumber,
        inv.InvoiceDate,
        inv.BillingPeriodStart,
        inv.BillingPeriodEnd,
        inv.TotalAmount as InvoiceAmount,
        inv.ProductVendorAmounts,
        inv.GroupId,
        inv.HouseholdId,
        inv.ModifiedDate,
        g.Name as GroupName,
        hu.FirstName,
        hu.LastName,
        hu.MemberId as PrimaryMemberId,
        pInfo.LatestPaymentId,
        pInfo.LatestPaymentDate,
        CASE WHEN pInfo.LatestPaymentId IS NOT NULL THEN 'Payment' ELSE 'Credit' END as FundingSource
      FROM oe.Invoices inv
      LEFT JOIN oe.Groups g ON inv.GroupId = g.GroupId
      OUTER APPLY (
        SELECT TOP 1 p.PaymentId AS LatestPaymentId, p.PaymentDate AS LatestPaymentDate
        FROM oe.Payments p
        WHERE p.InvoiceId = inv.InvoiceId
          AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
        ORDER BY p.PaymentDate DESC
      ) pInfo
      OUTER APPLY (
        SELECT TOP 1 u.FirstName, u.LastName, mm.MemberId
        FROM oe.Members mm
        INNER JOIN oe.Users u ON u.UserId = mm.UserId
        WHERE inv.HouseholdId IS NOT NULL
          AND mm.HouseholdId = inv.HouseholdId
          AND mm.RelationshipType = 'P'
      ) hu
      ${whereClause}
      ORDER BY COALESCE(pInfo.LatestPaymentDate, inv.ModifiedDate) DESC, inv.InvoiceDate DESC
    `);

    const invoices = invoicesResult.recordset || [];
    if (invoices.length === 0) {
      return res.json({ success: true, data: [] });
    }

    // Restrict to invoices with at least one product owned by @VendorId.
    const productIds = new Set();
    const parsedByInvoiceId = new Map();
    for (const inv of invoices) {
      const parsedRaw = parseJsonSafe(inv.ProductVendorAmounts);
      const parsed = normalizeProductAmountsJson(parsedRaw);
      if (!parsed) continue;
      parsedByInvoiceId.set(String(inv.InvoiceId), parsed);
      Object.keys(parsed).forEach((pid) => productIds.add(pid.toUpperCase()));
    }

    const vendorProductIds = new Set();
    if (productIds.size > 0) {
      const productIdsStr = Array.from(productIds)
        .map(id => `'${String(id).replace(/'/g, "''")}'`)
        .join(', ');
      const prRes = await pool.request().query(`
        SELECT ProductId
        FROM oe.Products
        WHERE VendorId = '${String(vendorId).replace(/'/g, "''")}'
          AND ProductId IN (${productIdsStr})
      `);
      (prRes.recordset || []).forEach(row => {
        if (row.ProductId) vendorProductIds.add(String(row.ProductId).toUpperCase());
      });
    }

    const rows = [];
    const invoiceIds = [];
    const paymentIds = [];
    for (const inv of invoices) {
      const invoiceId = String(inv.InvoiceId);
      const parsed = parsedByInvoiceId.get(invoiceId);
      if (!parsed) continue;

      let vendorAmount = 0;
      for (const [productId, data] of Object.entries(parsed)) {
        if (!vendorProductIds.has(String(productId).toUpperCase())) continue;
        vendorAmount += Number(data?.vendorAmount || 0);
      }
      vendorAmount = Math.round(vendorAmount * 100) / 100;
      if (vendorAmount <= 0) continue;

      const sourceName = inv.GroupName
        ? inv.GroupName
        : ((inv.FirstName || inv.LastName) ? `${inv.FirstName || ''} ${inv.LastName || ''}`.trim() : 'Unknown');

      // For credit-funded invoices, fall back to ModifiedDate as the "paid date"
      // (closest proxy to when the household credit cleared the invoice).
      const paidDate = inv.LatestPaymentDate || inv.ModifiedDate || inv.InvoiceDate;

      rows.push({
        invoiceId,
        invoiceNumber: inv.InvoiceNumber || null,
        invoiceDate: inv.InvoiceDate,
        billingPeriodStart: inv.BillingPeriodStart,
        billingPeriodEnd: inv.BillingPeriodEnd,
        paidDate,
        invoiceAmount: Number(inv.InvoiceAmount || 0),
        sourceName,
        sourceType: inv.GroupId ? 'group' : (inv.HouseholdId ? 'individual' : 'invoice'),
        groupId: inv.GroupId ? String(inv.GroupId) : null,
        groupName: inv.GroupName || null,
        householdId: inv.HouseholdId ? String(inv.HouseholdId) : null,
        primaryMemberId: inv.PrimaryMemberId ? String(inv.PrimaryMemberId) : null,
        paymentId: inv.LatestPaymentId ? String(inv.LatestPaymentId) : null,
        fundingSource: inv.FundingSource || 'Payment',
        vendorAmount
      });
      invoiceIds.push(invoiceId);
      if (inv.LatestPaymentId) paymentIds.push(String(inv.LatestPaymentId));
    }

    if (rows.length === 0) {
      return res.json({ success: true, data: [] });
    }

    // Already-paid lookup: NACHAPaymentDetails rows linked either by InvoiceId
    // (invoice-anchored payouts) or by the invoice's settling PaymentId
    // (legacy payment-anchored payouts).
    const paidMap = new Map(); // invoiceId -> already paid amount
    {
      const invoiceIdsStr = invoiceIds.map(id => `'${String(id).replace(/'/g, "''")}'`).join(', ');
      const paymentIdsStr = paymentIds.length > 0
        ? paymentIds.map(id => `'${String(id).replace(/'/g, "''")}'`).join(', ')
        : null;

      const paidRes = await pool.request().query(`
        SELECT
          COALESCE(npd.InvoiceId, p.InvoiceId) as InvoiceId,
          SUM(COALESCE(npd.Amount, 0)) as PaidAmount
        FROM oe.NACHAPaymentDetails npd
        INNER JOIN oe.NACHAGenerations ng ON npd.NACHAId = ng.NACHAId
        LEFT JOIN oe.Payments p ON p.PaymentId = npd.PaymentId
        WHERE npd.RecipientEntityType = 'Vendor'
          AND npd.RecipientEntityId = '${String(vendorId).replace(/'/g, "''")}'
          AND ng.Status = 'Sent'
          AND ng.PayoutType = 'Vendor Payouts'
          AND (
            npd.InvoiceId IN (${invoiceIdsStr})
            ${paymentIdsStr ? `OR p.InvoiceId IN (${invoiceIdsStr})` : ''}
          )
        GROUP BY COALESCE(npd.InvoiceId, p.InvoiceId)
      `);
      (paidRes.recordset || []).forEach(row => {
        if (!row.InvoiceId) return;
        paidMap.set(String(row.InvoiceId), Number(row.PaidAmount || 0));
      });
    }

    const data = rows.map(row => {
      const alreadyPaid = Math.round((paidMap.get(row.invoiceId) || 0) * 100) / 100;
      const remaining = Math.round(Math.max(0, (row.vendorAmount || 0) - alreadyPaid) * 100) / 100;
      const status =
        alreadyPaid >= (row.vendorAmount || 0) - 0.01 ? 'Paid' :
        alreadyPaid > 0 ? 'Partial' : 'Unpaid';

      return {
        ...row,
        vendorAlreadyPaid: alreadyPaid,
        vendorRemaining: remaining,
        payoutStatus: status
      };
    });

    const paidStatusNorm = (paidStatus || 'all').toString().toLowerCase();
    const filtered = paidStatusNorm === 'paid'
      ? data.filter(d => d.vendorRemaining <= 0.01)
      : paidStatusNorm === 'unpaid'
        ? data.filter(d => d.vendorRemaining > 0.01)
        : data;

    return res.json({ success: true, data: filtered });
  } catch (error) {
    console.error('Error getting vendor invoice list:', error);
    return res.status(500).json({ success: false, message: 'Failed to load vendor invoices' });
  }
});

/**
 * GET /api/accounting/vendor-breakdown/covered-unpaid
 * Query params: vendorId, startDate, endDate, groupId (optional), householdId (optional), individuals (optional)
 *
 * Returns primary members who have active enrollments in this vendor's products during the selected
 * coverage month but whose group/household has NO Completed payment with an invoice covering that month.
 *
 * These enrollments are "covered" but the vendor will NOT be paid for them on the next NACHA because
 * no payment has been received yet. This is display-only context — it does NOT inflate the Expected total.
 */
router.get('/vendor-breakdown/covered-unpaid', authorize(['SysAdmin', 'TenantAdmin']), requireTenantAccess, async (req, res) => {
  try {
    const tenantId = req.tenantId || req.user?.TenantId;
    if (!tenantId) {
      return res.status(400).json({ success: false, message: 'Tenant context missing' });
    }

    const { vendorId, startDate, endDate, groupId, householdId, individuals } = req.query;
    if (!vendorId) {
      return res.status(400).json({ success: false, message: 'vendorId is required' });
    }
    if (!startDate || !endDate) {
      return res.json({ success: true, data: [] });
    }

    const pool = await getPool();
    const r = pool.request();
    r.input('TenantId', sql.UniqueIdentifier, tenantId);
    r.input('VendorId', sql.UniqueIdentifier, vendorId);
    r.input('StartDate', sql.Date, startDate);
    r.input('EndDate', sql.Date, endDate);
    if (groupId && groupId !== 'all') r.input('GroupId', sql.UniqueIdentifier, groupId);
    if (householdId && householdId !== 'all') r.input('HouseholdId', sql.UniqueIdentifier, householdId);

    // Find primary-member enrollments active during the coverage window for this vendor's products,
    // where NO Completed payment exists (for the group or household) whose invoice billing period
    // overlaps the selected window. Enrollments on products bundled as children are excluded.
    const result = await r.query(`
      WITH VendorProducts AS (
        SELECT ProductId, Name AS ProductName
        FROM oe.Products
        WHERE VendorId = @VendorId
          AND ProductId NOT IN (
            SELECT DISTINCT BundleProductId FROM oe.ProductBundles WHERE BundleProductId IS NOT NULL
          )
      ),
      ActiveEnrollments AS (
        SELECT
          e.EnrollmentId,
          e.MemberId,
          e.ProductId,
          e.ProductPricingId,
          e.EffectiveDate,
          e.TerminationDate,
          m.HouseholdId,
          m.GroupId,
          u.FirstName,
          u.LastName,
          u.Email,
          g.Name AS GroupName,
          vp.ProductName,
          pp.Label AS PricingTier,
          COALESCE(pp.NetRate, 0) AS NetRate
        FROM oe.Enrollments e
        INNER JOIN oe.Members m
          ON e.MemberId = m.MemberId
          AND m.RelationshipType = 'P'
        INNER JOIN oe.Users u ON u.UserId = m.UserId
        INNER JOIN VendorProducts vp ON vp.ProductId = e.ProductId
        LEFT JOIN oe.Groups g ON g.GroupId = m.GroupId
        LEFT JOIN oe.ProductPricing pp ON pp.ProductPricingId = e.ProductPricingId
        WHERE (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
          AND e.ProductPricingId IS NOT NULL
          AND m.TenantId = @TenantId
          AND e.EffectiveDate <= @EndDate
          AND (e.TerminationDate IS NULL OR e.TerminationDate > @StartDate)
          ${groupId && groupId !== 'all' ? 'AND m.GroupId = @GroupId' : ''}
          ${householdId && householdId !== 'all' ? 'AND m.HouseholdId = @HouseholdId' : ''}
          ${individuals && individuals === 'true' ? 'AND m.GroupId IS NULL' : ''}
      )
      SELECT
        ae.EnrollmentId,
        ae.MemberId,
        ae.ProductId,
        ae.ProductName,
        ae.ProductPricingId,
        ae.PricingTier,
        ae.NetRate,
        ae.EffectiveDate,
        ae.TerminationDate,
        ae.HouseholdId,
        ae.GroupId,
        ae.GroupName,
        ae.FirstName,
        ae.LastName,
        ae.Email,
        -- Bucket classification:
        --   'covered-invoice-unpaid' : an invoice covers this enrollment's period but Status in (Unpaid/Partial/Overdue)
        --   'covered-no-invoice'     : NO invoice covers this enrollment's period at all
        CASE WHEN EXISTS (
          SELECT 1
          FROM oe.Invoices inv
          WHERE inv.TenantId = @TenantId
            AND inv.Status IN ('Unpaid', 'Partial', 'Overdue')
            AND (
              (ae.GroupId IS NOT NULL AND inv.GroupId = ae.GroupId)
              OR (ae.GroupId IS NULL AND inv.HouseholdId = ae.HouseholdId)
            )
            AND inv.BillingPeriodStart IS NOT NULL
            AND CAST(inv.BillingPeriodStart AS DATE) <= CAST(@EndDate AS DATE)
            AND CAST(inv.BillingPeriodEnd AS DATE) >= CAST(@StartDate AS DATE)
        )
        THEN 'covered-invoice-unpaid'
        ELSE 'covered-no-invoice'
        END AS Bucket
      FROM ActiveEnrollments ae
      WHERE NOT EXISTS (
        -- (a) Any successful payment (per PAID_PAYMENT_STATUSES) for this
        -- member's group or household whose invoice covers the window.
        SELECT 1
        FROM oe.Payments p
        LEFT JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
        WHERE p.TenantId = @TenantId
          AND p.Status IN ${PAID_PAYMENT_STATUSES_SQL}
          AND (
            (ae.GroupId IS NOT NULL AND p.GroupId = ae.GroupId)
            OR (ae.GroupId IS NULL AND p.HouseholdId = ae.HouseholdId)
          )
          AND (
            (p.InvoiceId IS NOT NULL AND inv.BillingPeriodStart IS NOT NULL
              AND CAST(inv.BillingPeriodStart AS DATE) <= CAST(@EndDate AS DATE)
              AND CAST(inv.BillingPeriodEnd AS DATE) >= CAST(@StartDate AS DATE))
            OR (p.InvoiceId IS NULL
              AND p.PaymentDate >= @StartDate
              AND p.PaymentDate < DATEADD(day, 1, @EndDate))
          )
      )
      AND NOT EXISTS (
        -- (b) Credit-paid: invoice Status='Paid' covering the window with no
        -- linked payment row (settled via household credit). The vendor IS owed
        -- for these via NACHA's invoice-anchored branch, so they're not unpaid
        -- from the Covered-Unpaid screen's perspective.
        SELECT 1
        FROM oe.Invoices inv
        WHERE inv.TenantId = @TenantId
          AND inv.Status = N'Paid'
          AND (
            (ae.GroupId IS NOT NULL AND inv.GroupId = ae.GroupId)
            OR (ae.GroupId IS NULL AND inv.HouseholdId = ae.HouseholdId)
          )
          AND inv.BillingPeriodStart IS NOT NULL
          AND CAST(inv.BillingPeriodStart AS DATE) <= CAST(@EndDate AS DATE)
          AND CAST(inv.BillingPeriodEnd AS DATE) >= CAST(@StartDate AS DATE)
      )
      ORDER BY ae.GroupName, ae.LastName, ae.FirstName, ae.ProductName
    `);

    const allRows = (result.recordset || []).map(row => ({
      enrollmentId: row.EnrollmentId,
      memberId: row.MemberId,
      primaryMemberName: `${row.FirstName || ''} ${row.LastName || ''}`.trim() || 'Unknown',
      email: row.Email || null,
      groupId: row.GroupId || null,
      groupName: row.GroupName || null,
      householdId: row.HouseholdId || null,
      productId: row.ProductId,
      productName: row.ProductName,
      productPricingId: row.ProductPricingId,
      pricingTier: row.PricingTier || null,
      netRate: Number(row.NetRate || 0),
      effectiveDate: row.EffectiveDate,
      terminationDate: row.TerminationDate,
      sourceType: row.GroupId ? 'group' : 'individual',
      bucket: row.Bucket // 'covered-invoice-unpaid' | 'covered-no-invoice'
    }));

    const coveredInvoiceUnpaid = allRows.filter(r => r.bucket === 'covered-invoice-unpaid');
    const coveredNoInvoice = allRows.filter(r => r.bucket === 'covered-no-invoice');

    // Backward-compatible: existing UI still reads `data` as the combined list,
    // and the split categories are surfaced in the new fields below.
    return res.json({
      success: true,
      data: allRows,
      coveredInvoiceUnpaid,
      coveredNoInvoice
    });
  } catch (error) {
    console.error('Error getting covered-but-unpaid enrollments:', error);
    return res.status(500).json({ success: false, message: 'Failed to load covered-but-unpaid enrollments' });
  }
});

/**
 * GET /api/accounting/vendor-breakdown/payment/:paymentId/breakdown?vendorId=xxx
 *
 * Returns a per-product vendor payout breakdown for a single payment.
 * Mirrors the commission "Details" modal, but shows what each vendor gets.
 *
 * Response shape:
 * {
 *   paymentId, paymentDate, paymentAmount,
 *   sourceType: 'group' | 'individual',
 *   sourceName, groupId, groupName, householdId, primaryMemberId,
 *   vendorId, vendorName,
 *   vendorTotal, alreadyPaid, remaining,
 *   products: [{
 *     productId, productName, productType, vendorId, vendorName,
 *     vendorAmount, enrolledCount,
 *     enrollments: [{ enrollmentId, memberId, memberName, relationshipType, pricingTier, netRate, effectiveDate, terminationDate }]
 *   }]
 * }
 */
router.get(
  '/vendor-breakdown/payment/:paymentId/breakdown',
  authorize(['SysAdmin', 'TenantAdmin']),
  requireTenantAccess,
  async (req, res) => {
    try {
      const tenantId = req.tenantId || req.user?.TenantId;
      const { paymentId } = req.params;
      const vendorIdFilter = req.query.vendorId ? String(req.query.vendorId).toUpperCase() : null;
      if (!tenantId) {
        return res.status(400).json({ success: false, message: 'Tenant context missing' });
      }

      const pool = await getPool();

      // Load payment + source identifiers
      const paymentResult = await pool.request()
        .input('PaymentId', sql.UniqueIdentifier, paymentId)
        .input('TenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT
            p.PaymentId, p.PaymentDate, p.Amount, p.Status, p.TenantId,
            p.GroupId, p.HouseholdId, p.InvoiceId,
            -- Invoice-sourced payouts: prefer invoice breakdowns with payment fallback
            COALESCE(inv.ProductVendorAmounts, p.ProductVendorAmounts) AS ProductVendorAmounts,
            g.Name AS GroupName,
            hu.MemberId AS PrimaryMemberId,
            hu.FirstName AS PrimaryFirstName,
            hu.LastName AS PrimaryLastName
          FROM oe.Payments p
          LEFT JOIN oe.Groups g ON p.GroupId = g.GroupId
          LEFT JOIN oe.Invoices inv ON p.InvoiceId = inv.InvoiceId
          OUTER APPLY (
            SELECT TOP 1 u.FirstName, u.LastName, mm.MemberId
            FROM oe.Members mm
            INNER JOIN oe.Users u ON u.UserId = mm.UserId
            WHERE p.HouseholdId IS NOT NULL
              AND mm.HouseholdId = p.HouseholdId
              AND mm.RelationshipType = 'P'
          ) hu
          WHERE p.PaymentId = @PaymentId AND p.TenantId = @TenantId
        `);

      if (!paymentResult.recordset.length) {
        return res.status(404).json({ success: false, message: 'Payment not found' });
      }
      const payment = paymentResult.recordset[0];

      const productAmounts = normalizeProductAmountsJson(parseJsonSafe(payment.ProductVendorAmounts)) || {};
      const productIds = Object.keys(productAmounts);

      // Load product metadata (product + vendor names) for all products on the payment
      let productMeta = {};
      if (productIds.length > 0) {
        const productRequest = pool.request();
        const placeholders = productIds.map((id, i) => {
          productRequest.input(`pid${i}`, sql.UniqueIdentifier, id);
          return `@pid${i}`;
        });
        const productsRes = await productRequest.query(`
          SELECT p.ProductId, p.Name AS ProductName, p.ProductType,
                 p.VendorId, v.VendorName AS VendorName
          FROM oe.Products p
          LEFT JOIN oe.Vendors v ON p.VendorId = v.VendorId
          WHERE p.ProductId IN (${placeholders.join(',')})
        `);
        productMeta = (productsRes.recordset || []).reduce((acc, row) => {
          acc[String(row.ProductId).toUpperCase()] = row;
          return acc;
        }, {});
      }

      // Resolve as-of window for enrollment detail rows (matches payment-product-snapshots semantics)
      let asOfDate = null;
      let periodStart = null;
      let periodEnd = null;
      if (payment.HouseholdId) {
        asOfDate = householdAsOfDate(payment.PaymentDate) || new Date();
      } else if (payment.GroupId) {
        const window = await resolveGroupPeriodFromInvoiceOrPaymentDate(
          pool,
          payment.InvoiceId,
          payment.PaymentDate,
          console
        );
        periodStart = window.periodStart;
        periodEnd = window.periodEnd;
      }

      // Load enrollments contributing to this snapshot, grouped by ProductId
      const enrollmentsByProduct = new Map();
      if (productIds.length > 0 && (payment.HouseholdId || payment.GroupId)) {
        const enrollRequest = pool.request();
        const productPlaceholders = productIds.map((id, i) => {
          enrollRequest.input(`epid${i}`, sql.UniqueIdentifier, id);
          return `@epid${i}`;
        });

        let enrollQuery;
        if (payment.HouseholdId) {
          enrollRequest.input('HouseholdId', sql.UniqueIdentifier, payment.HouseholdId);
          enrollRequest.input('AsOfDate', sql.DateTime2, asOfDate);
          enrollQuery = `
            SELECT
              e.EnrollmentId, e.ProductId, e.EffectiveDate, e.TerminationDate,
              e.NetRate, e.MemberId,
              m.RelationshipType,
              u.FirstName, u.LastName,
              COALESCE(pp.Label, m.Tier) AS PricingTier
            FROM oe.Enrollments e
            LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
            LEFT JOIN oe.Users u ON m.UserId = u.UserId
            LEFT JOIN oe.ProductPricing pp ON e.ProductPricingId = pp.ProductPricingId
            WHERE e.HouseholdId = @HouseholdId
              AND e.EffectiveDate <= @AsOfDate
              AND (e.TerminationDate IS NULL OR e.TerminationDate > @AsOfDate)
              AND e.ProductId IN (${productPlaceholders.join(',')})
              AND m.RelationshipType = 'P'
          `;
        } else {
          enrollRequest.input('GroupId', sql.UniqueIdentifier, payment.GroupId);
          enrollRequest.input('PeriodStart', sql.Date, periodStart);
          enrollRequest.input('PeriodEnd', sql.Date, periodEnd);
          enrollQuery = `
            SELECT
              e.EnrollmentId, e.ProductId, e.EffectiveDate, e.TerminationDate,
              e.NetRate, e.MemberId,
              m.RelationshipType,
              u.FirstName, u.LastName,
              COALESCE(pp.Label, m.Tier) AS PricingTier
            FROM oe.Enrollments e
            INNER JOIN oe.Members m ON e.MemberId = m.MemberId
            LEFT JOIN oe.Users u ON m.UserId = u.UserId
            LEFT JOIN oe.ProductPricing pp ON e.ProductPricingId = pp.ProductPricingId
            WHERE m.GroupId = @GroupId
              AND CAST(e.EffectiveDate AS DATE) <= @PeriodEnd
              AND (e.TerminationDate IS NULL OR e.TerminationDate > @PeriodStart)
              AND e.ProductId IN (${productPlaceholders.join(',')})
              AND m.RelationshipType = 'P'
          `;
        }

        const enrollRes = await enrollRequest.query(enrollQuery);
        for (const row of enrollRes.recordset || []) {
          const key = String(row.ProductId).toUpperCase();
          if (!enrollmentsByProduct.has(key)) enrollmentsByProduct.set(key, []);
          enrollmentsByProduct.get(key).push({
            enrollmentId: row.EnrollmentId,
            memberId: row.MemberId,
            memberName: `${row.FirstName || ''} ${row.LastName || ''}`.trim() || 'Unknown',
            relationshipType: row.RelationshipType || null,
            pricingTier: row.PricingTier || null,
            netRate: Number(row.NetRate || 0),
            effectiveDate: row.EffectiveDate,
            terminationDate: row.TerminationDate
          });
        }
      }

      // Build per-product payout rows (optionally filtered by vendorId)
      const products = [];
      let vendorTotal = 0;
      let activeVendorId = vendorIdFilter;
      let activeVendorName = null;

      for (const pid of productIds) {
        const meta = productMeta[pid];
        if (!meta) continue;
        const productVendorId = meta.VendorId ? String(meta.VendorId).toUpperCase() : null;
        if (vendorIdFilter && productVendorId !== vendorIdFilter) continue;

        const amounts = productAmounts[pid] || {};
        const vendorAmount = Number(amounts.vendorAmount || 0);
        const enrolledCount =
          Number(amounts.enrolledHouseholdsCount || amounts.enrollmentCount || 0) ||
          (enrollmentsByProduct.get(pid)?.length ?? 0);

        vendorTotal += vendorAmount;
        if (!activeVendorId) activeVendorId = productVendorId;
        if (!activeVendorName) activeVendorName = meta.VendorName || null;
        if (productVendorId === activeVendorId && meta.VendorName) {
          activeVendorName = meta.VendorName;
        }

        products.push({
          productId: pid,
          productName: meta.ProductName || 'Unknown Product',
          productType: meta.ProductType || null,
          vendorId: productVendorId,
          vendorName: meta.VendorName || null,
          vendorAmount,
          enrolledCount,
          enrollments: enrollmentsByProduct.get(pid) || []
        });
      }

      // Already paid to this vendor via NACHA for this specific payment
      let alreadyPaid = 0;
      if (activeVendorId) {
        const paidRes = await pool.request()
          .input('PaymentId', sql.UniqueIdentifier, paymentId)
          .input('VendorId', sql.UniqueIdentifier, activeVendorId)
          .query(`
            SELECT ISNULL(SUM(npd.Amount), 0) AS AmountPaid
            FROM oe.NACHAPaymentDetails npd
            INNER JOIN oe.NACHAGenerations ng ON npd.NACHAId = ng.NACHAId
            LEFT JOIN oe.Payments anchorPay ON anchorPay.PaymentId = @PaymentId
            WHERE (npd.PaymentId = @PaymentId
                   OR (anchorPay.InvoiceId IS NOT NULL AND npd.InvoiceId = anchorPay.InvoiceId))
              AND npd.RecipientEntityType = 'Vendor'
              AND npd.RecipientEntityId = @VendorId
              AND ng.Status IN ('Sent', 'Generated')
          `);
        alreadyPaid = Number(paidRes.recordset?.[0]?.AmountPaid || 0);
      }

      const sourceType = payment.GroupId ? 'group' : 'individual';
      const primaryName = `${payment.PrimaryFirstName || ''} ${payment.PrimaryLastName || ''}`.trim();
      const sourceName = sourceType === 'group'
        ? (payment.GroupName || 'Group')
        : (primaryName || 'Individual');

      return res.json({
        success: true,
        data: {
          paymentId: payment.PaymentId,
          paymentDate: payment.PaymentDate,
          paymentAmount: Number(payment.Amount || 0),
          paymentStatus: payment.Status,
          sourceType,
          sourceName,
          groupId: payment.GroupId,
          groupName: payment.GroupName,
          householdId: payment.HouseholdId,
          primaryMemberId: payment.PrimaryMemberId,
          vendorId: activeVendorId,
          vendorName: activeVendorName,
          vendorTotal,
          alreadyPaid,
          remaining: Math.max(0, vendorTotal - alreadyPaid),
          products
        }
      });
    } catch (error) {
      console.error('Error getting vendor payment breakdown:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to load vendor payment breakdown'
      });
    }
  }
);

module.exports = router;
module.exports.parseFamilyTierToken = parseFamilyTierToken;
module.exports.normalizeFamilyTierCode = normalizeFamilyTierCode;


