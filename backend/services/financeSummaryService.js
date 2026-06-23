// services/financeSummaryService.js
//
// Computes Share Request finances from the source tables (bills + transactions)
// rather than the stored, potentially-stale totals on oe.ShareRequests. Powers:
//   - the Finances tab summary cards (per share request)
//   - the member workspace Finances tab (per member, across all their SRs)
//   - a stable, normalized JSON contract for future AI / reporting consumers
//
// All money is bucketed via services/financeCategory.js so legacy and current
// transaction-type strings roll up identically.

const { getPool, sql } = require('../config/database');
const { CATEGORY, categoryOf } = require('./financeCategory');

const CLEARED = 'Cleared';
const PENDING = 'Pending';
const EPSILON = 0.01;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Cache of "schema.table.column exists" lookups so we only hit
// INFORMATION_SCHEMA once per column per process. Lets us reference columns
// added by not-yet-applied migrations without breaking.
//
// Only DEFINITIVE results are cached. A transient query error returns false for
// this call but is NOT cached, so a one-off pool hiccup can't disable the column
// for the whole process lifetime. (A column added by a migration mid-process is
// still only re-detected on restart, which is acceptable — Azure deploys restart
// the process.)
const _columnCache = new Map();
async function columnExists(pool, table, column, schema = 'oe') {
  const key = `${schema}.${table}.${column}`;
  if (_columnCache.has(key)) return _columnCache.get(key);
  try {
    const r = await pool.request()
      .input('schema', sql.NVarChar, schema)
      .input('table', sql.NVarChar, table)
      .input('column', sql.NVarChar, column)
      .query(`
        SELECT 1 AS ok FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table AND COLUMN_NAME = @column
      `);
    const exists = r.recordset.length > 0;
    _columnCache.set(key, exists); // cache only on a successful lookup
    return exists;
  } catch (e) {
    console.warn(`[financeSummary] columnExists(${key}) check failed; assuming absent (not cached):`, e.message);
    return false;
  }
}

// Build an empty {cleared, pending, total, count} bucket per category.
function emptyByCategory() {
  const out = {};
  Object.values(CATEGORY).forEach((c) => {
    out[c] = { cleared: 0, pending: 0, total: 0, count: 0 };
  });
  return out;
}

/**
 * Aggregate a set of bill rows and transaction rows into the canonical summary
 * shape. Pure function — callers pass already-fetched rows.
 *
 * @param {Array} bills        rows with { BilledAmount, BillType, IsActive }
 * @param {Array} transactions rows with { TransactionType, TransactionStatus, Amount }
 */
function buildSummary(bills, transactions) {
  let billed = 0;
  let estimates = 0;
  let billPaid = 0;
  let billBalance = 0;
  for (const b of bills) {
    if (b.IsActive === false || b.IsActive === 0) continue;
    const amt = Number(b.BilledAmount) || 0;
    if (b.BillType === 'Estimate') estimates += amt;
    else billed += amt;
    billPaid += Number(b.PaidAmount) || 0;
    billBalance += Number(b.Balance) || 0;
  }

  const byCategory = emptyByCategory();
  for (const t of transactions) {
    const cat = categoryOf(t.TransactionType);
    const amt = Number(t.Amount) || 0;
    const bucket = byCategory[cat];
    bucket.total += amt;
    bucket.count += 1;
    if (t.TransactionStatus === CLEARED) bucket.cleared += amt;
    else if (t.TransactionStatus === PENDING) bucket.pending += amt;
  }

  const c = byCategory;
  const clearedPending = (cat) => c[cat].cleared + c[cat].pending;

  // Reductions in what is owed. Discounts and financial aid include pending
  // (they are negotiated/awarded reductions), matching prior dashboard behavior.
  const discount = clearedPending(CATEGORY.DISCOUNT);
  const financialAid = clearedPending(CATEGORY.FINANCIAL_AID);
  const saved = discount + financialAid;

  // Member out-of-pocket cash (cleared only).
  const uaPaymentCleared = c[CATEGORY.UA_PAYMENT].cleared;
  const memberPaymentCleared = c[CATEGORY.MEMBER_PAYMENT].cleared;
  const memberPaid = uaPaymentCleared + memberPaymentCleared;

  // Money paid out (reported separately as cards; reimbursement is a fund→member
  // outflow, not a reduction of the provider bill — see balance below).
  const paidToProvider = c[CATEGORY.PAYMENT_TO_PROVIDER].cleared;
  const reimbursed = c[CATEGORY.REIMBURSEMENT].cleared;

  // Balance = what is still owed on the bills. Only things that actually pay down
  // or reduce the PROVIDER bill count:
  //   discounts + financial aid (bill reduced), payments to provider, and the
  //   member/UA payments the member makes to the facility.
  // Deliberately EXCLUDED:
  //   • UA Reduction — reallocates who owes (member's share waived); no payment
  //     reaches the bill, so it must not reduce the balance.
  //   • Reimbursement — fund → member, a separate outflow; it does not settle
  //     the provider bill.
  const balance =
    billed
    - saved
    - clearedPending(CATEGORY.UA_PAYMENT)
    - paidToProvider
    - memberPaymentCleared;

  return {
    billed: round2(billed),
    estimates: round2(estimates),
    billPaid: round2(billPaid),
    billBalance: round2(billBalance),

    // Cards
    saved: round2(saved),
    memberPaid: round2(memberPaid),
    reimbursed: round2(reimbursed),
    balance: round2(balance),

    // Detail
    discount: round2(discount),
    financialAid: round2(financialAid),
    paidToProvider: round2(paidToProvider),
    uaPaid: round2(uaPaymentCleared),
    memberPayment: round2(memberPaymentCleared),

    byCategory: Object.fromEntries(
      Object.entries(byCategory).map(([k, v]) => [
        k,
        { cleared: round2(v.cleared), pending: round2(v.pending), total: round2(v.total), count: v.count },
      ])
    ),
    transactionCount: transactions.length,
    billCount: bills.filter((b) => b.IsActive !== false && b.IsActive !== 0).length,
  };
}

// Per-SR incident unshared amount for the "full UA paid" rule. Source order:
//   1. IncidentUAAmount — frozen at SR creation from the member's enrollment UA
//      tier (the authoritative, plan-change-proof value; 2026-05-30 migration).
//   2. TotalUAAmount — back-office-entered per-SR UA, if populated.
//   3. MemberStatedUA — the value the member typed on the public form.
// See docs/billing-rework/BLOCKERS.md #6.
function resolveIncidentUA(sr) {
  const snapshot = Number(sr.IncidentUAAmount);
  if (Number.isFinite(snapshot) && snapshot > 0) return snapshot;
  const total = Number(sr.TotalUAAmount) || 0;
  if (total > 0) return total;
  const stated = parseFloat(sr.MemberStatedUA);
  return Number.isFinite(stated) ? stated : 0;
}

class FinanceSummaryService {
  /**
   * Computed finances for a single share request. When vendorId is supplied the
   * SR must belong to that vendor (tenant isolation) — returns null otherwise.
   */
  static async getShareRequestSummary(shareRequestId, vendorId = null) {
    const pool = await getPool();

    if (vendorId) {
      const owner = await pool.request()
        .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .query(`
          SELECT 1 AS ok FROM oe.ShareRequests
          WHERE ShareRequestId = @shareRequestId AND VendorId = @vendorId
        `);
      if (owner.recordset.length === 0) return null;
    }

    const billsResult = await pool.request()
      .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
      .query(`
        SELECT BilledAmount, BillType, IsActive, PaidAmount, Balance
        FROM oe.ShareRequestBills
        WHERE ShareRequestId = @shareRequestId
      `);

    const txResult = await pool.request()
      .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
      .query(`
        SELECT TransactionType, TransactionStatus, Amount
        FROM oe.ShareRequestTransactions
        WHERE ShareRequestId = @shareRequestId
      `);

    const summary = buildSummary(billsResult.recordset, txResult.recordset);

    // Attach the owning member's trailing-12-month UA-coverage analysis so the
    // SR Finances tab can render the same "two unshared amounts paid in full"
    // banner the member workspace shows. Best-effort: a failure here must not
    // sink the per-SR summary, so we degrade to null.
    let uaAnalysis = null;
    try {
      const ownerRow = await pool.request()
        .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
        .query(`
          SELECT MemberId, VendorId FROM oe.ShareRequests
          WHERE ShareRequestId = @shareRequestId
        `);
      const owner = ownerRow.recordset[0];
      if (owner && owner.MemberId && owner.VendorId) {
        const member = await FinanceSummaryService.getMemberFinanceSummary(
          owner.MemberId, owner.VendorId
        );
        uaAnalysis = member.uaAnalysis;
      }
    } catch (e) {
      console.warn('[financeSummary] uaAnalysis attach failed (degrading to null):', e.message);
    }

    return { shareRequestId, ...summary, uaAnalysis };
  }

  /**
   * Computed finances for a single case. When vendorId is supplied the case
   * must belong to that vendor (tenant isolation) — returns null otherwise.
   *
   * Cases reuse the same source-table aggregation as share requests (via the
   * shared buildSummary), reading oe.CaseBills / oe.CaseTransactions. The UA
   * transaction categories simply aggregate to zero because the Case ledger
   * never offers UA Payment / UA Reduction types.
   */
  static async getCaseSummary(caseId, vendorId = null) {
    const pool = await getPool();

    if (vendorId) {
      const owner = await pool.request()
        .input('caseId', sql.UniqueIdentifier, caseId)
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .query(`
          SELECT 1 AS ok FROM oe.Cases
          WHERE CaseId = @caseId AND VendorId = @vendorId
        `);
      if (owner.recordset.length === 0) return null;
    }

    const billsResult = await pool.request()
      .input('caseId', sql.UniqueIdentifier, caseId)
      .query(`
        SELECT BilledAmount, BillType, IsActive, PaidAmount, Balance
        FROM oe.CaseBills
        WHERE CaseId = @caseId
      `);

    const txResult = await pool.request()
      .input('caseId', sql.UniqueIdentifier, caseId)
      .query(`
        SELECT TransactionType, TransactionStatus, Amount
        FROM oe.CaseTransactions
        WHERE CaseId = @caseId
      `);

    const summary = buildSummary(billsResult.recordset, txResult.recordset);
    return { caseId, ...summary };
  }

  /**
   * Aggregate finances for a member across all their share requests (scoped to
   * the vendor), plus the trailing-12-month "two UA paid in full" analysis.
   */
  static async getMemberFinanceSummary(memberId, vendorId) {
    const pool = await getPool();

    // IncidentUAAmount arrives with the 2026-05-30 migration. Select it only if
    // present so this works before the migration is applied.
    const hasIncidentUA = await columnExists(pool, 'ShareRequests', 'IncidentUAAmount');
    const incidentUASelect = hasIncidentUA ? 'IncidentUAAmount,' : 'CAST(NULL AS DECIMAL(18,2)) AS IncidentUAAmount,';

    const srResult = await pool.request()
      .input('memberId', sql.UniqueIdentifier, memberId)
      .input('vendorId', sql.UniqueIdentifier, vendorId)
      .query(`
        SELECT ShareRequestId, RequestNumber, Status, Determination,
               ${incidentUASelect}
               TotalUAAmount, MemberStatedUA, DateOfService, SubmittedDate
        FROM oe.ShareRequests
        WHERE MemberId = @memberId AND VendorId = @vendorId
        ORDER BY COALESCE(DateOfService, SubmittedDate) DESC
      `);
    const shareRequests = srResult.recordset;

    if (shareRequests.length === 0) {
      return {
        memberId,
        shareRequestCount: 0,
        totals: buildSummary([], []),
        shareRequests: [],
        uaAnalysis: { windowMonths: 12, uaPaidInFullCount: 0, fullyCovered: false, events: [] },
      };
    }

    // Pull all bills + transactions for the member's SRs in two scoped queries.
    const billsResult = await pool.request()
      .input('memberId', sql.UniqueIdentifier, memberId)
      .input('vendorId', sql.UniqueIdentifier, vendorId)
      .query(`
        SELECT b.ShareRequestId, b.BilledAmount, b.BillType, b.IsActive, b.PaidAmount, b.Balance
        FROM oe.ShareRequestBills b
        INNER JOIN oe.ShareRequests sr ON b.ShareRequestId = sr.ShareRequestId
        WHERE sr.MemberId = @memberId AND sr.VendorId = @vendorId
      `);

    const txResult = await pool.request()
      .input('memberId', sql.UniqueIdentifier, memberId)
      .input('vendorId', sql.UniqueIdentifier, vendorId)
      .query(`
        SELECT t.ShareRequestId, t.TransactionType, t.TransactionStatus, t.Amount
        FROM oe.ShareRequestTransactions t
        INNER JOIN oe.ShareRequests sr ON t.ShareRequestId = sr.ShareRequestId
        WHERE sr.MemberId = @memberId AND sr.VendorId = @vendorId
      `);

    // Group rows by ShareRequestId.
    const billsBySr = new Map();
    const txBySr = new Map();
    for (const b of billsResult.recordset) {
      if (!billsBySr.has(b.ShareRequestId)) billsBySr.set(b.ShareRequestId, []);
      billsBySr.get(b.ShareRequestId).push(b);
    }
    for (const t of txResult.recordset) {
      if (!txBySr.has(t.ShareRequestId)) txBySr.set(t.ShareRequestId, []);
      txBySr.get(t.ShareRequestId).push(t);
    }

    // Trailing 12-month window for the UA-paid-in-full rule.
    const now = new Date();
    const windowStart = new Date(now);
    windowStart.setMonth(windowStart.getMonth() - 12);

    const perSr = [];
    const uaEvents = [];
    let uaPaidInFullCount = 0;

    for (const sr of shareRequests) {
      const bills = billsBySr.get(sr.ShareRequestId) || [];
      const txs = txBySr.get(sr.ShareRequestId) || [];
      const summary = buildSummary(bills, txs);

      const incidentUA = resolveIncidentUA(sr);
      const uaPaid = summary.uaPaid; // cleared UA Payments for this SR
      const eventDate = sr.DateOfService || sr.SubmittedDate;
      const inWindow = eventDate ? new Date(eventDate) >= windowStart : false;
      const paidInFull = incidentUA > 0 && uaPaid >= incidentUA - EPSILON;
      const qualifies = inWindow && paidInFull;
      if (qualifies) uaPaidInFullCount += 1;

      perSr.push({
        shareRequestId: sr.ShareRequestId,
        requestNumber: sr.RequestNumber,
        status: sr.Status,
        determination: sr.Determination,
        serviceDate: sr.DateOfService || null,
        submittedDate: sr.SubmittedDate || null,
        incidentUA: round2(incidentUA),
        uaPaid: round2(uaPaid),
        uaPaidInFull: paidInFull,
        ...summary,
      });

      uaEvents.push({
        shareRequestId: sr.ShareRequestId,
        requestNumber: sr.RequestNumber,
        eventDate: eventDate || null,
        inWindow,
        incidentUA: round2(incidentUA),
        uaPaid: round2(uaPaid),
        qualifies,
      });
    }

    const totals = buildSummary(billsResult.recordset, txResult.recordset);

    return {
      memberId,
      shareRequestCount: shareRequests.length,
      totals,
      shareRequests: perSr,
      uaAnalysis: {
        windowMonths: 12,
        windowStart: windowStart.toISOString(),
        uaPaidInFullCount,
        // Business rule: two unshared amounts paid in full within 12 months means
        // everything else is covered. See docs/billing-rework/BLOCKERS.md #6.
        fullyCovered: uaPaidInFullCount >= 2,
        events: uaEvents,
      },
    };
  }
}

module.exports = FinanceSummaryService;
module.exports.buildSummary = buildSummary;
module.exports.resolveIncidentUA = resolveIncidentUA;
