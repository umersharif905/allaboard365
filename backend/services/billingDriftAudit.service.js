// File: backend/services/billingDriftAudit.service.js
//
// Read-only detector for "billing drift" — invoices whose TotalAmount no longer
// matches what the same billing period would generate today using the member's
// currently-active enrollments. Typical cause: an admin removes a plan after
// the invoice was created (paid or not) and never adjusts the invoice, so the
// invoice itself is over-billed. Whether the member has actually paid is a
// separate concern — issuing a credit zeroes out the BalanceDue regardless,
// and any surplus carries forward as account credit.
//
// This service performs NO writes. The companion route exposes a separate
// "issue credit" endpoint that uses the existing credit ledger to remediate
// flagged invoices, so the audit and the remediation are explicit, opt-in
// steps.
//
// Drift logic (per invoice):
//   recomputedTotal = SUM(PremiumAmount of currently-Active enrollments where
//     EffectiveDate <= BillingPeriodEnd
//     AND (TerminationDate IS NULL OR TerminationDate >= BillingPeriodStart)
//     AND EnrollmentType IN ('Product','SystemFee','PaymentProcessingFee'))
//   acknowledgedAmount = SUM(positive Amount of HouseholdCreditEntries where
//     EntryType IN ('ManualGoodwill','OverpaymentRecognized')
//     AND SourceInvoiceId = this invoice)
//   suggestedCredit = max(0, TotalAmount - recomputedTotal - CreditAmount - acknowledgedAmount)
//
// Surfaced when suggestedCredit >= minDriftDollars. Once an admin issues a
// drift credit through the auditor or the plan-change wizard, the goodwill
// entry is tagged with SourceInvoiceId so the row drops off automatically.

const sql = require('mssql');
const { getPool } = require('../config/database');

/**
 * Find invoices whose currently-active enrollments would total less than the
 * billed amount, indicating a mid-cycle plan change that left the member
 * overpaid. Returns the candidate list ready for admin review; no side effects.
 *
 * @param {object} opts
 * @param {string} [opts.tenantId] — restrict to one tenant (required unless sysAdmin)
 * @param {boolean} [opts.sysAdmin=false] — when true, scans across all tenants
 * @param {Date|string} [opts.sinceDate] — only check invoices billed on/after this date
 * @param {number} [opts.minDriftDollars=1] — ignore drift below this floor
 * @param {number} [opts.limit=200] — cap result size
 */
async function findOverpaidInvoices({ tenantId, sysAdmin = false, sinceDate, minDriftDollars = 1, limit = 200 } = {}) {
  const pool = await getPool();
  const req = pool.request();

  let where = `i.TotalAmount > 0 AND i.InvoiceType = N'Individual' AND i.Status NOT IN (N'Cancelled', N'Voided')`;
  if (!sysAdmin) {
    if (!tenantId) throw new Error('tenantId required when not sysAdmin');
    req.input('tenantId', sql.UniqueIdentifier, tenantId);
    where += ` AND i.TenantId = @tenantId`;
  } else if (tenantId) {
    req.input('tenantId', sql.UniqueIdentifier, tenantId);
    where += ` AND i.TenantId = @tenantId`;
  }
  if (sinceDate) {
    req.input('sinceDate', sql.DateTime, new Date(sinceDate));
    where += ` AND i.BillingPeriodStart >= @sinceDate`;
  }
  req.input('limit', sql.Int, Math.max(1, Math.min(1000, limit)));
  req.input('floor', sql.Decimal(10, 2), Math.max(0.01, Number(minDriftDollars) || 1));

  // For each candidate invoice, compute:
  //   RecomputedTotal — sum of currently-Active enrollments effective for the
  //     billing period (what we'd bill today)
  //   AcknowledgedAmount — total positive goodwill / overpayment-recognized
  //     credit explicitly tagged with SourceInvoiceId = this invoice. Once an
  //     admin issues a drift credit through the auditor or the plan-change
  //     wizard, the goodwill row is tagged so the row drops off the next scan.
  //
  //   suggestedCredit = max(0, TotalAmount - RecomputedTotal - CreditAmount - AcknowledgedAmount)
  const result = await req.query(`
    WITH Candidates AS (
      SELECT
        i.InvoiceId, i.InvoiceNumber, i.TenantId, i.HouseholdId,
        i.BillingPeriodStart, i.BillingPeriodEnd, i.InvoiceDate,
        i.TotalAmount, i.PaidAmount, i.CreditAmount, i.Status
      FROM oe.Invoices i
      WHERE ${where}
    ),
    EnrollSums AS (
      SELECT c.InvoiceId,
             agg.PremiumSum - agg.PpfOnFeeRow
               + CASE
                   WHEN agg.IncludedOnProducts <= 0 THEN agg.PpfOnFeeRow
                   WHEN agg.IncludedOnProducts > agg.PpfOnFeeRow + 0.01
                     THEN agg.IncludedOnProducts + agg.PpfOnFeeRow
                   WHEN ABS(agg.PpfOnFeeRow - agg.IncludedOnProducts) <= 0.01 THEN agg.PpfOnFeeRow
                   WHEN agg.PpfOnFeeRow > agg.IncludedOnProducts + 0.01
                     AND agg.PpfOnFeeRow / NULLIF(agg.PpfOnFeeRow - agg.IncludedOnProducts, 0) <= 1.4
                     THEN agg.PpfOnFeeRow
                   ELSE agg.IncludedOnProducts + agg.PpfOnFeeRow
                 END AS RecomputedTotal,
             agg.ActiveEnrollmentCount
      FROM Candidates c
      OUTER APPLY (
        SELECT
          COALESCE(SUM(e.PremiumAmount), 0) AS PremiumSum,
          COALESCE(SUM(CASE
            WHEN e.EnrollmentType IN (N'Product') OR e.EnrollmentType IS NULL
            THEN COALESCE(e.IncludedPaymentProcessingFeeAmount, 0)
            ELSE 0
          END), 0) AS IncludedOnProducts,
          COALESCE(SUM(CASE
            WHEN e.EnrollmentType = N'PaymentProcessingFee'
            THEN COALESCE(e.PremiumAmount, 0)
            ELSE 0
          END), 0) AS PpfOnFeeRow,
          COUNT(e.EnrollmentId) AS ActiveEnrollmentCount
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON m.MemberId = e.MemberId
        WHERE m.HouseholdId = c.HouseholdId
          AND e.Status = N'Active'
          AND e.EffectiveDate <= c.BillingPeriodEnd
          AND (e.TerminationDate IS NULL OR e.TerminationDate >= c.BillingPeriodStart)
          AND e.EnrollmentType IN (N'Product', N'SystemFee', N'PaymentProcessingFee')
      ) agg
    ),
    Acknowledgments AS (
      SELECT c.InvoiceId,
             COALESCE(SUM(CASE WHEN g.Amount > 0 THEN g.Amount ELSE 0 END), 0) AS AcknowledgedAmount
      FROM Candidates c
      LEFT JOIN oe.HouseholdCreditEntries g
        ON g.SourceInvoiceId = c.InvoiceId
       AND g.EntryType IN (N'ManualGoodwill', N'OverpaymentRecognized')
      GROUP BY c.InvoiceId
    )
    SELECT TOP (@limit)
      c.InvoiceId, c.InvoiceNumber, c.TenantId, c.HouseholdId,
      c.BillingPeriodStart, c.BillingPeriodEnd, c.InvoiceDate,
      c.TotalAmount, c.PaidAmount, COALESCE(c.CreditAmount, 0) AS CreditAmount, c.Status,
      es.RecomputedTotal, es.ActiveEnrollmentCount,
      ack.AcknowledgedAmount,
      (c.TotalAmount - es.RecomputedTotal - COALESCE(c.CreditAmount, 0) - ack.AcknowledgedAmount) AS SuggestedCredit,
      pm.MemberId AS PrimaryMemberId,
      RTRIM(LTRIM(COALESCE(u.FirstName + ' ', '') + COALESCE(u.LastName, ''))) AS MemberName,
      u.Email AS MemberEmail
    FROM Candidates c
    INNER JOIN EnrollSums es ON es.InvoiceId = c.InvoiceId
    INNER JOIN Acknowledgments ack ON ack.InvoiceId = c.InvoiceId
    OUTER APPLY (
      SELECT TOP 1 m.MemberId, m.UserId
      FROM oe.Members m
      WHERE m.HouseholdId = c.HouseholdId AND m.RelationshipType = N'P'
      ORDER BY m.CreatedDate
    ) pm
    LEFT JOIN oe.Users u ON u.UserId = pm.UserId
    WHERE (c.TotalAmount - es.RecomputedTotal - COALESCE(c.CreditAmount, 0) - ack.AcknowledgedAmount) >= @floor
    ORDER BY (c.TotalAmount - es.RecomputedTotal - COALESCE(c.CreditAmount, 0) - ack.AcknowledgedAmount) DESC, c.BillingPeriodStart DESC
  `);

  const rows = result.recordset || [];

  // Per-row "dropped items" — currently-Inactive enrollments for the same
  // household that would have applied to that billing period. Cheap separate
  // pass keyed by household; usually < 200 candidate rows so this stays fast.
  if (rows.length === 0) {
    return { candidates: [], summary: { count: 0, totalSuggestedCredit: 0 } };
  }

  const householdIds = [...new Set(rows.map(r => String(r.HouseholdId)))];
  const droppedReq = pool.request();
  // SQL Server doesn't support array params; build a TVP-free IN clause via
  // dynamic SQL with inline param binding.
  const idParams = householdIds.map((_, i) => `@h${i}`).join(', ');
  householdIds.forEach((hid, i) => droppedReq.input(`h${i}`, sql.UniqueIdentifier, hid));
  const droppedRes = await droppedReq.query(`
    SELECT m.HouseholdId, e.EnrollmentId, e.ProductId, p.Name AS ProductName,
           e.PremiumAmount, e.EffectiveDate, e.TerminationDate, e.Status, e.EnrollmentType
    FROM oe.Enrollments e
    INNER JOIN oe.Members m ON m.MemberId = e.MemberId
    LEFT JOIN oe.Products p ON p.ProductId = e.ProductId
    WHERE m.HouseholdId IN (${idParams})
      AND e.Status = N'Inactive'
      AND e.EnrollmentType IN (N'Product', N'SystemFee', N'PaymentProcessingFee')
  `);
  const droppedByHousehold = {};
  for (const d of droppedRes.recordset || []) {
    const key = String(d.HouseholdId);
    (droppedByHousehold[key] ||= []).push({
      enrollmentId: d.EnrollmentId,
      productId: d.ProductId,
      productName: d.ProductName,
      premiumAmount: Number(d.PremiumAmount) || 0,
      effectiveDate: d.EffectiveDate,
      terminationDate: d.TerminationDate,
      status: d.Status,
      enrollmentType: d.EnrollmentType
    });
  }

  const candidates = rows.map(r => {
    const householdDropped = droppedByHousehold[String(r.HouseholdId)] || [];
    // Filter dropped to only items whose original effective range overlapped
    // this invoice's billing period — not every historic inactive enrollment.
    const periodStart = r.BillingPeriodStart ? new Date(r.BillingPeriodStart) : null;
    const periodEnd = r.BillingPeriodEnd ? new Date(r.BillingPeriodEnd) : null;
    const droppedItems = householdDropped.filter(d => {
      if (!periodStart || !periodEnd) return true;
      const eff = d.effectiveDate ? new Date(d.effectiveDate) : null;
      const term = d.terminationDate ? new Date(d.terminationDate) : null;
      if (eff && eff > periodEnd) return false;
      // term BEFORE periodStart means the enrollment was already over before
      // this period began — irrelevant unless the invoice was generated
      // before the termination, which is the Toniann pattern (eff=5/1, term=4/30).
      if (term && eff && term < eff) return true; // voided-style enrollment, keep
      if (term && term < periodStart) return false;
      return true;
    });
    return {
      invoiceId: r.InvoiceId,
      invoiceNumber: r.InvoiceNumber,
      tenantId: r.TenantId,
      householdId: r.HouseholdId,
      memberId: r.PrimaryMemberId,
      memberName: r.MemberName || null,
      memberEmail: r.MemberEmail || null,
      billingPeriodStart: r.BillingPeriodStart,
      billingPeriodEnd: r.BillingPeriodEnd,
      invoiceDate: r.InvoiceDate,
      totalAmount: Number(r.TotalAmount) || 0,
      paidAmount: Number(r.PaidAmount) || 0,
      creditAlreadyApplied: Number(r.CreditAmount) || 0,
      recomputedTotal: Math.round((Number(r.RecomputedTotal) || 0) * 100) / 100,
      suggestedCredit: Math.round((Number(r.SuggestedCredit) || 0) * 100) / 100,
      activeEnrollmentCount: Number(r.ActiveEnrollmentCount) || 0,
      status: r.Status,
      droppedItems
    };
  });

  const totalSuggestedCredit = candidates.reduce((acc, c) => acc + c.suggestedCredit, 0);

  return {
    candidates,
    summary: {
      count: candidates.length,
      totalSuggestedCredit: Math.round(totalSuggestedCredit * 100) / 100
    }
  };
}

/**
 * Project billing drift for a household *after* a plan change, before the
 * change is applied. Used by the plan-modifications wizard to show a "these
 * invoices will be over-billed" preview alongside the existing dry-run.
 *
 * @param {object} opts
 * @param {string} opts.tenantId
 * @param {string} opts.householdId
 * @param {string[]} [opts.terminatedEnrollmentIds=[]] — EnrollmentIds that the
 *   plan will mark Inactive (won't count toward future totals).
 * @param {Array<{enrollmentType:string, premiumAmount:number, effectiveDate:string|Date,
 *   terminationDate?:string|Date}>} [opts.addedEnrollments=[]] — net-new
 *   enrollments being created (rarely affects past invoices since their
 *   effectiveDate is usually future, but included for completeness).
 * @param {number} [opts.minDriftDollars=1]
 */
async function simulateDriftAfterPlanChange({
  tenantId,
  householdId,
  terminatedEnrollmentIds = [],
  addedEnrollments = [],
  minDriftDollars = 1
} = {}) {
  if (!householdId) return { candidates: [], summary: { count: 0, totalSuggestedCredit: 0 } };
  const pool = await getPool();

  const invReq = pool.request().input('householdId', sql.UniqueIdentifier, householdId);
  if (tenantId) invReq.input('tenantId', sql.UniqueIdentifier, tenantId);
  const invRes = await invReq.query(`
    SELECT i.InvoiceId, i.InvoiceNumber, i.TenantId, i.HouseholdId,
           i.BillingPeriodStart, i.BillingPeriodEnd, i.InvoiceDate,
           i.TotalAmount, i.PaidAmount, COALESCE(i.CreditAmount, 0) AS CreditAmount, i.Status
    FROM oe.Invoices i
    WHERE i.HouseholdId = @householdId
      AND i.InvoiceType = N'Individual'
      AND i.Status NOT IN (N'Cancelled', N'Voided')
      AND i.TotalAmount > 0
      ${tenantId ? 'AND i.TenantId = @tenantId' : ''}
    ORDER BY i.BillingPeriodStart DESC
  `);
  const invoices = invRes.recordset || [];
  if (invoices.length === 0) {
    return { candidates: [], summary: { count: 0, totalSuggestedCredit: 0 } };
  }

  // Per-invoice acknowledgment totals — drift credits already issued for these
  // invoices should not be re-suggested in the preview.
  const ackRes = await pool.request()
    .input('householdId', sql.UniqueIdentifier, householdId)
    .query(`
      SELECT g.SourceInvoiceId AS InvoiceId,
             SUM(CASE WHEN g.Amount > 0 THEN g.Amount ELSE 0 END) AS AcknowledgedAmount
      FROM oe.HouseholdCreditEntries g
      WHERE g.HouseholdId = @householdId
        AND g.SourceInvoiceId IS NOT NULL
        AND g.EntryType IN (N'ManualGoodwill', N'OverpaymentRecognized')
      GROUP BY g.SourceInvoiceId
    `);
  const ackByInvoice = {};
  for (const a of ackRes.recordset || []) {
    ackByInvoice[String(a.InvoiceId)] = Number(a.AcknowledgedAmount) || 0;
  }

  // All currently-Active enrollments for the household.
  const enrRes = await pool.request()
    .input('householdId', sql.UniqueIdentifier, householdId)
    .query(`
      SELECT e.EnrollmentId, e.PremiumAmount, e.EffectiveDate, e.TerminationDate, e.EnrollmentType, e.ProductId
      FROM oe.Enrollments e
      INNER JOIN oe.Members m ON m.MemberId = e.MemberId
      WHERE m.HouseholdId = @householdId
        AND e.Status = N'Active'
        AND e.EnrollmentType IN (N'Product', N'SystemFee', N'PaymentProcessingFee')
    `);
  const allActive = enrRes.recordset || [];
  const termSet = new Set((terminatedEnrollmentIds || []).map(s => String(s).toLowerCase()));
  const projected = [
    ...allActive.filter(e => !termSet.has(String(e.EnrollmentId).toLowerCase())),
    ...((addedEnrollments || []).map((e, idx) => ({
      EnrollmentId: `__planned__${idx}`,
      PremiumAmount: Number(e.premiumAmount) || 0,
      EffectiveDate: e.effectiveDate ? new Date(e.effectiveDate) : null,
      TerminationDate: e.terminationDate ? new Date(e.terminationDate) : null,
      EnrollmentType: e.enrollmentType || 'Product',
      ProductId: e.productId || null
    })))
  ];

  const candidates = [];
  let totalSuggestedCredit = 0;
  for (const inv of invoices) {
    const periodStart = inv.BillingPeriodStart ? new Date(inv.BillingPeriodStart) : null;
    const periodEnd = inv.BillingPeriodEnd ? new Date(inv.BillingPeriodEnd) : null;
    if (!periodStart || !periodEnd) continue;

    const recomputedTotal = projected.reduce((sum, e) => {
      const eff = e.EffectiveDate ? new Date(e.EffectiveDate) : null;
      const term = e.TerminationDate ? new Date(e.TerminationDate) : null;
      if (!eff) return sum;
      if (eff > periodEnd) return sum;
      if (term && term < periodStart) return sum;
      return sum + (Number(e.PremiumAmount) || 0)
        + ((e.EnrollmentType === 'Product' || e.EnrollmentType == null)
          ? (Number(e.IncludedPaymentProcessingFeeAmount) || 0)
          : 0);
    }, 0);

    const totalAmount = Number(inv.TotalAmount) || 0;
    const creditAlreadyApplied = Number(inv.CreditAmount) || 0;
    const acknowledged = Number(ackByInvoice[String(inv.InvoiceId)]) || 0;
    const drift = Math.round((totalAmount - recomputedTotal - creditAlreadyApplied - acknowledged) * 100) / 100;
    if (drift < minDriftDollars) continue;

    candidates.push({
      invoiceId: inv.InvoiceId,
      invoiceNumber: inv.InvoiceNumber,
      tenantId: inv.TenantId,
      householdId: inv.HouseholdId,
      billingPeriodStart: inv.BillingPeriodStart,
      billingPeriodEnd: inv.BillingPeriodEnd,
      totalAmount,
      paidAmount: Number(inv.PaidAmount) || 0,
      creditAlreadyApplied,
      recomputedTotal: Math.round(recomputedTotal * 100) / 100,
      suggestedCredit: drift,
      status: inv.Status
    });
    totalSuggestedCredit += drift;
  }

  return {
    candidates,
    summary: {
      count: candidates.length,
      totalSuggestedCredit: Math.round(totalSuggestedCredit * 100) / 100
    }
  };
}

module.exports = { findOverpaidInvoices, simulateDriftAfterPlanChange };
