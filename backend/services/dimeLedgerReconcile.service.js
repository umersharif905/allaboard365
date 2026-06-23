'use strict';

/**
 * DIME LEDGER RECONCILE (report-only, Phase 1)
 * -------------------------------------------------
 * The nightly `dime_status` reconcile looks each payment up by its OWN transaction
 * id. That has two blind spots this auditor closes:
 *   1. It only re-checks Pending rows, so a Completed payment that later RETURNS is
 *      invisible (→ we OVERSTATE what a member paid).
 *   2. A single-txn lookup can't see a separate later RETRY that settled, so it can
 *      false-positive a rejected-then-retried payment as unpaid (the "Makala" trap),
 *      and conversely it never notices a settled retry we failed to record
 *      (→ we UNDERSTATE what a member paid).
 *
 * This service instead pulls each ACH household's FULL DIME customer ledger
 * (GET /api/transactions?filters.customer_uuid), NETS credits against
 * returns/rejects per transaction, and compares the true settled total against
 * what our DB records as Completed for the same window. Discrepancies in EITHER
 * direction are reported to oe.SystemIntegrationErrors (AI inspector watches the
 * 'billing' category) + Sentry. It NEVER writes payment/invoice rows in this phase.
 *
 * Cadence: heavy (one DIME API call per active ACH household) → run weekly via its
 * own scheduled job, not inside the nightly orchestrator.
 */

const axios = require('axios');
const Sentry = require('@sentry/node');
const { getPool, sql } = require('../config/database');
const DimeService = require('./dimeService');
const { recordIntegrationError } = require('./integrationErrorService');

const DEFAULTS = {
  lookbackDays: 45, // window of payments to audit; also covers the ~10d ACH return tail
  maxHouseholds: 300, // cap DIME API calls per tenant per run
  toleranceCents: 100, // ignore sub-$1 rounding noise
  paceMs: 150 // delay between DIME calls to stay under rate limits
};

function clampInt(n, lo, hi, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(x)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Classify a DIME transaction_status into a settlement bucket.
 *
 * IMPORTANT ordering: a status like `ACH_PAYMENT_CREDIT_PENDING` contains BOTH
 * "CREDIT" and "PENDING" — it is money that has NOT settled yet, so PENDING must be
 * matched before the generic CREDIT bucket. (This was the bug in the throwaway probe.)
 *
 * @param {string} status
 * @returns {'failed'|'refund'|'fee'|'pending'|'credit'|'other'}
 */
function classifyDimeStatus(status) {
  const s = String(status || '').toUpperCase();
  if (s.includes('REJECT') || s.includes('RETURN') || s.includes('FAIL') || s.includes('DECLIN') || s.includes('VOID') || s.includes('CHARGEBACK')) {
    return 'failed';
  }
  if (s.includes('REFUND')) return 'refund';
  if (s.includes('FEE')) return 'fee';
  // Pending BEFORE credit so *_CREDIT_PENDING is treated as not-yet-settled.
  if (s.includes('PENDING') || s.includes('PROCESSING') || s.includes('INITIATED') || s.includes('SUBMITTED')) {
    return 'pending';
  }
  if (s.includes('CREDIT') || s.includes('APPROVED') || s.includes('SETTLED') || s.includes('SUCCESS') || s.includes('COMPLETE') || s.includes('CAPTURED') || s.includes('PAID')) {
    return 'credit';
  }
  return 'other';
}

function txnAmount(t) {
  return Number(t.amount ?? t.gross ?? t.gross_amount ?? 0) || 0;
}

function txnNumber(t) {
  return String(t.transaction_number || t.transaction_id || t.id || '');
}

function txnStatus(t) {
  return t.transaction_status || t.status || t.sub_type || t.type || '';
}

/**
 * Net a customer's DIME transactions per transaction_number into a settlement
 * verdict for each. Grouping by txn number lets a CREDIT clawed back by a later
 * RETURN/REJECT on the SAME txn net to bounced (provisional credit reversed).
 *
 * Returns a per-txn map (the unit of reconciliation — matched by id against our
 * Payments.ProcessorTransactionId, which is immune to settlement-date skew and
 * method-label mismatch) plus aggregate totals for logging.
 *
 * @param {Array<object>} transactions
 * @returns {{
 *   byTxn: Map<string, { settledCents:number, bouncedCents:number, pendingCents:number }>,
 *   settledCents:number, pendingCents:number, bouncedCents:number, settledTxns:string[], count:number
 * }}
 */
function netLedger(transactions) {
  const groups = new Map();
  for (const t of transactions || []) {
    const cls = classifyDimeStatus(txnStatus(t));
    const amount = txnAmount(t);
    const num = txnNumber(t);
    if (!num) continue;
    if (!groups.has(num)) groups.set(num, { num, credit: 0, pending: 0, failedLines: [] });
    const g = groups.get(num);
    if (cls === 'credit') g.credit = Math.max(g.credit, amount);
    else if (cls === 'pending') g.pending = Math.max(g.pending, amount);
    else if (cls === 'failed') g.failedLines.push(amount);
    // refund/fee/other are intentionally ignored for the principal settled total.
  }

  const byTxn = new Map();
  let settled = 0;
  let pending = 0;
  let bounced = 0;
  const settledTxns = [];
  for (const g of groups.values()) {
    // A return/reject line for an ACH carries the principal; if a txn has both a
    // credit and a failed line >= the credit, the principal bounced → net 0. A small
    // failed line below the credit (e.g. a $25 return fee) does NOT void the principal.
    const maxFailed = g.failedLines.length ? Math.max(...g.failedLines) : 0;
    const principalBounced = g.credit > 0 && maxFailed >= g.credit - 0.005;
    const verdict = { settledCents: 0, bouncedCents: 0, pendingCents: 0 };
    if (g.credit > 0 && !principalBounced) {
      verdict.settledCents = Math.round(g.credit * 100);
      settled += g.credit;
      settledTxns.push(`#${g.num} $${g.credit.toFixed(2)}`);
    } else if (g.credit > 0 && principalBounced) {
      verdict.bouncedCents = Math.round(g.credit * 100);
      bounced += g.credit;
    } else if (g.credit === 0 && maxFailed > 0) {
      // Outright rejected/returned attempt with no surviving credit line — the money
      // never stayed. Marking it bounced lets us flag a DB row we wrongly call Completed.
      verdict.bouncedCents = Math.round(maxFailed * 100);
      bounced += maxFailed;
    } else if (g.pending > 0) {
      verdict.pendingCents = Math.round(g.pending * 100);
      pending += g.pending;
    }
    byTxn.set(String(g.num), verdict);
  }

  return {
    byTxn,
    settledCents: Math.round(settled * 100),
    pendingCents: Math.round(pending * 100),
    bouncedCents: Math.round(bounced * 100),
    settledTxns,
    count: (transactions || []).length
  };
}

/**
 * Reconcile a household by TRANSACTION ID (not by window sums, which are noisy due
 * to settlement-date skew between our PaymentDate and DIME's credit date).
 *
 *  - overstated: a DB Completed payment whose DIME txn shows the principal
 *    bounced/returned → we kept it Completed but the money came back.
 *  - understated: a DIME *settled* txn id with no matching Completed payment in our
 *    DB → real money the member paid that our books don't credit.
 *
 * A DB Completed txn that DIME doesn't list (older than the ledger window, or a card
 * txn absent from this customer ledger) is deliberately NOT flagged overstated — we
 * only trust an EXPLICIT DIME bounce, to avoid crying wolf on incomplete windows.
 *
 * @param {Map<string,{amountCents:number}>} dbCompletedByTxn  Completed DIME payments keyed by ProcessorTransactionId
 * @param {Set<string>} dbAllTxnIds  ALL DIME payment txn ids we have for the household, under ANY status
 * @param {Map<string,{settledCents:number,bouncedCents:number,pendingCents:number}>} byTxn  netLedger().byTxn
 * @param {number} toleranceCents
 * @returns {{ status:'ok'|'overstated'|'understated'|'both', overstatedCents:number, understatedCents:number, overstatedTxns:string[], understatedTxns:string[] }}
 */
function reconcileByTxn(dbCompletedByTxn, dbAllTxnIds, byTxn, toleranceCents) {
  const tol = Number(toleranceCents) || 0;
  const allTxnIds = dbAllTxnIds instanceof Set ? dbAllTxnIds : new Set(dbAllTxnIds || []);
  let overstatedCents = 0;
  let understatedCents = 0;
  const overstatedTxns = [];
  const understatedTxns = [];

  // Overstated: we call it Completed, but DIME shows that exact txn bounced.
  for (const [txnId, dbRow] of dbCompletedByTxn.entries()) {
    const v = byTxn.get(String(txnId));
    if (v && v.bouncedCents > 0 && v.settledCents === 0) {
      overstatedCents += dbRow.amountCents;
      overstatedTxns.push(`#${txnId} $${(dbRow.amountCents / 100).toFixed(2)}`);
    }
  }

  // Understated: DIME settled a txn that is ENTIRELY absent from our books (no row
  // under any status). A txn we have as Refunded/Failed is intentionally NOT flagged —
  // we already know about it; refund/return reconciliation is a separate concern.
  for (const [txnId, v] of byTxn.entries()) {
    if (v.settledCents > 0 && !allTxnIds.has(String(txnId))) {
      understatedCents += v.settledCents;
      understatedTxns.push(`#${txnId} $${(v.settledCents / 100).toFixed(2)}`);
    }
  }

  const over = overstatedCents > tol;
  const under = understatedCents > tol;
  let status = 'ok';
  if (over && under) status = 'both';
  else if (over) status = 'overstated';
  else if (under) status = 'understated';

  return { status, overstatedCents, understatedCents, overstatedTxns, understatedTxns };
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

async function listCustomerTransactions(config, customerUuid, startDate, endDate) {
  const headers = DimeService.getHeaders(config, { silent: true });
  const body = {
    data: { sid: config.sid },
    filters: {
      customer_uuid: customerUuid,
      start_date: `${startDate} 00:00:00`,
      end_date: `${endDate} 23:59:59`
    }
  };
  const resp = await axios.request({
    method: 'GET',
    url: `${config.baseUrl}/api/transactions`,
    headers,
    data: body,
    timeout: 30000
  });
  const d = resp.data;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.data)) return d.data;
  if (Array.isArray(d?.data?.transactions)) return d.data.transactions;
  if (Array.isArray(d?.transactions)) return d.transactions;
  if (Array.isArray(d?.data?.data)) return d.data.data;
  return [];
}

/**
 * Load candidate ACH households for a tenant: those with at least one Completed
 * DIME ACH payment inside the lookback window AND a resolvable DIME customer uuid.
 * Ordered by recorded amount desc so the biggest exposure is checked first under the cap.
 */
async function loadCandidateHouseholds(pool, tenantId, lookbackDays, maxHouseholds) {
  const result = await pool
    .request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('lookbackDays', sql.Int, lookbackDays)
    .input('maxHouseholds', sql.Int, maxHouseholds)
    .query(`
      WITH hh AS (
        SELECT
          p.HouseholdId,
          -- Sum Completed across ALL DIME methods (ACH, Recurring, Card, ...). Recurring
          -- ACH pulls are labeled 'Recurring', not 'ACH', so a method-filtered sum would
          -- undercount and falsely read as "understated" vs DIME's full customer ledger.
          SUM(CASE WHEN p.Status = 'Completed' THEN p.Amount ELSE 0 END) AS DbCompletedAmount,
          SUM(CASE WHEN p.Status = 'Completed' THEN 1 ELSE 0 END) AS CompletedCount,
          COUNT(*) AS PaymentCount,
          -- Only scan households that actually transact via ACH-family methods.
          SUM(CASE
            WHEN p.Status = 'Completed'
             AND (LOWER(ISNULL(p.PaymentMethod, '')) LIKE '%ach%'
               OR LOWER(ISNULL(p.PaymentMethod, '')) LIKE '%bank%'
               OR LOWER(ISNULL(p.PaymentMethod, '')) LIKE '%recurring%')
            THEN 1 ELSE 0 END) AS AchCompletedCount
        FROM oe.Payments p
        WHERE p.TenantId = @tenantId
          AND LOWER(ISNULL(p.Processor, '')) LIKE '%dime%'
          AND (p.TransactionType IS NULL OR p.TransactionType = 'Payment')
          AND p.HouseholdId IS NOT NULL
          AND p.PaymentDate >= DATEADD(DAY, -@lookbackDays, SYSUTCDATETIME())
        GROUP BY p.HouseholdId
        HAVING SUM(CASE
            WHEN p.Status = 'Completed'
             AND (LOWER(ISNULL(p.PaymentMethod, '')) LIKE '%ach%'
               OR LOWER(ISNULL(p.PaymentMethod, '')) LIKE '%bank%'
               OR LOWER(ISNULL(p.PaymentMethod, '')) LIKE '%recurring%')
            THEN 1 ELSE 0 END) > 0
      )
      SELECT TOP (@maxHouseholds)
        CAST(hh.HouseholdId AS NVARCHAR(36)) AS HouseholdId,
        hh.DbCompletedAmount,
        hh.CompletedCount,
        hh.PaymentCount,
        cust.CustomerUuid,
        cust.PrimaryName
      FROM hh
      OUTER APPLY (
        SELECT TOP 1
          m.ProcessorCustomerId AS CustomerUuid,
          LTRIM(RTRIM(CONCAT(ISNULL(u.FirstName, N''), N' ', ISNULL(u.LastName, N'')))) AS PrimaryName
        FROM oe.Members m
        INNER JOIN oe.Users u ON m.UserId = u.UserId
        WHERE m.HouseholdId = hh.HouseholdId AND m.ProcessorCustomerId IS NOT NULL
        ORDER BY CASE WHEN m.RelationshipType = N'P' THEN 0 ELSE 1 END, m.CreatedDate
      ) cust
      WHERE cust.CustomerUuid IS NOT NULL
      ORDER BY hh.DbCompletedAmount DESC
    `);
  return result.recordset || [];
}

/**
 * DIME payments for a household keyed by ProcessorTransactionId. Returns both the
 * Completed subset (with summed amounts) and the set of ALL txn ids under ANY status.
 * NOT window-limited: we match DIME's in-window txns against the household's full
 * history so settlement-date skew can never drop a legitimate match (e.g. a txn dated
 * Mar 31 in our DB but credited May 29 in DIME).
 *
 * @returns {{ completed: Map<string,{amountCents:number}>, allTxnIds: Set<string> }}
 */
async function loadHouseholdTxns(pool, tenantId, householdId) {
  const result = await pool
    .request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('householdId', sql.UniqueIdentifier, householdId)
    .query(`
      SELECT
        LTRIM(RTRIM(CAST(p.ProcessorTransactionId AS NVARCHAR(128)))) AS TxnId,
        SUM(CASE WHEN p.Status = 'Completed' THEN p.Amount ELSE 0 END) AS CompletedAmount,
        SUM(CASE WHEN p.Status = 'Completed' THEN 1 ELSE 0 END) AS CompletedCount
      FROM oe.Payments p
      WHERE p.TenantId = @tenantId
        AND p.HouseholdId = @householdId
        AND LOWER(ISNULL(p.Processor, '')) LIKE '%dime%'
        AND (p.TransactionType IS NULL OR p.TransactionType = 'Payment')
        AND p.ProcessorTransactionId IS NOT NULL
        AND LTRIM(RTRIM(CAST(p.ProcessorTransactionId AS NVARCHAR(128)))) <> ''
      GROUP BY LTRIM(RTRIM(CAST(p.ProcessorTransactionId AS NVARCHAR(128))))
    `);
  const completed = new Map();
  const allTxnIds = new Set();
  for (const r of result.recordset || []) {
    const txnId = String(r.TxnId);
    allTxnIds.add(txnId);
    if (Number(r.CompletedCount || 0) > 0) {
      completed.set(txnId, { amountCents: Math.round(Number(r.CompletedAmount || 0) * 100) });
    }
  }
  return { completed, allTxnIds };
}

/**
 * Reconcile one tenant. Report-only: returns per-household findings and emits an
 * integration error per discrepancy (over/understated). Never writes billing rows.
 */
async function reconcileTenant(pool, config, tenantId, opts) {
  const { lookbackDays, toleranceCents, paceMs, dryRun } = opts;
  const end = new Date();
  const start = new Date(end.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const startStr = ymd(start);
  const endStr = ymd(end);

  const households = await loadCandidateHouseholds(pool, tenantId, lookbackDays, opts.maxHouseholds);

  const findings = [];
  const discrepancies = [];
  let scanned = 0;
  let apiErrors = 0;

  for (const hh of households) {
    if (paceMs > 0 && scanned > 0) await sleep(paceMs);
    scanned += 1;

    let txns;
    try {
      txns = await listCustomerTransactions(config, hh.CustomerUuid, startStr, endStr);
    } catch (e) {
      apiErrors += 1;
      findings.push({
        householdId: hh.HouseholdId,
        name: hh.PrimaryName || null,
        error: `ledger fetch failed: ${e.response?.status || ''} ${e.response?.data?.message || e.message}`.trim()
      });
      continue;
    }

    const net = netLedger(txns);
    const { completed: dbCompletedByTxn, allTxnIds: dbAllTxnIds } = await loadHouseholdTxns(pool, tenantId, hh.HouseholdId);
    const verdict = reconcileByTxn(dbCompletedByTxn, dbAllTxnIds, net.byTxn, toleranceCents);

    const finding = {
      householdId: hh.HouseholdId,
      name: hh.PrimaryName || null,
      customerUuid: hh.CustomerUuid,
      dbCompletedCents: Math.round(Number(hh.DbCompletedAmount || 0) * 100),
      dimeSettledCents: net.settledCents,
      dimePendingCents: net.pendingCents,
      dimeBouncedCents: net.bouncedCents,
      txnCount: net.count,
      status: verdict.status,
      overstatedCents: verdict.overstatedCents,
      understatedCents: verdict.understatedCents,
      overstatedTxns: verdict.overstatedTxns,
      understatedTxns: verdict.understatedTxns
    };
    findings.push(finding);

    if (verdict.status !== 'ok') {
      discrepancies.push(finding);
    }
  }

  // Report each discrepancy individually so the AI inspector / digest surfaces a
  // specific, actionable row per member. Best-effort; reporting never throws.
  if (!dryRun) {
    for (const d of discrepancies) {
      const over = d.overstatedCents > 0;
      try {
        await recordIntegrationError({
          category: 'billing',
          source: 'dimeLedgerReconcile',
          severity: over ? 'error' : 'warning',
          priority: over ? 'critical' : 'high',
          tenantId,
          message:
            `Payment ${d.status} for ${d.name || 'household'} (${d.householdId}): ` +
            (over ? `overstated $${(d.overstatedCents / 100).toFixed(2)} [${d.overstatedTxns.join(', ')}] ` : '') +
            (d.understatedCents > 0 ? `understated $${(d.understatedCents / 100).toFixed(2)} [${d.understatedTxns.join(', ')}]` : ''),
          detail: { ...d, window: { startStr, endStr } }
        });
      } catch (_) {}
    }
  }

  return {
    tenantId,
    tenantName: config.tenantName || null,
    window: { startDate: startStr, endDate: endStr },
    candidateCount: households.length,
    scanned,
    apiErrors,
    overstatedCount: discrepancies.filter((d) => d.overstatedCents > 0).length,
    understatedCount: discrepancies.filter((d) => d.understatedCents > 0).length,
    discrepancies,
    findings
  };
}

/**
 * Entry point. Runs the ledger reconcile for one tenant (if tenantId given) or all
 * DIME-configured tenants. Per-tenant isolated: one tenant's failure never aborts
 * the rest. Report-only — set dryRun:true to also suppress the integration-error rows.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.tenantId]
 * @param {number} [opts.lookbackDays]
 * @param {number} [opts.maxHouseholds]
 * @param {number} [opts.toleranceCents]
 * @param {number} [opts.paceMs]
 * @param {boolean} [opts.dryRun] — when true, compute + return findings but write no integration errors
 */
async function runDimeLedgerReconcile(opts = {}) {
  const lookbackDays = clampInt(opts.lookbackDays ?? process.env.LEDGER_RECONCILE_LOOKBACK_DAYS, 1, 366, DEFAULTS.lookbackDays);
  const maxHouseholds = clampInt(opts.maxHouseholds ?? process.env.LEDGER_RECONCILE_MAX_HOUSEHOLDS, 1, 5000, DEFAULTS.maxHouseholds);
  const toleranceCents = clampInt(opts.toleranceCents ?? process.env.LEDGER_RECONCILE_TOLERANCE_CENTS, 0, 1000000, DEFAULTS.toleranceCents);
  const paceMs = clampInt(opts.paceMs ?? process.env.LEDGER_RECONCILE_PACE_MS, 0, 5000, DEFAULTS.paceMs);
  const dryRun = opts.dryRun === true;

  const runOpts = { lookbackDays, maxHouseholds, toleranceCents, paceMs, dryRun };

  const out = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    options: runOpts,
    tenants: [],
    totals: { candidateCount: 0, scanned: 0, overstatedCount: 0, understatedCount: 0, apiErrors: 0, tenantErrors: 0 }
  };

  const pool = await getPool();

  let tenantIds;
  if (opts.tenantId) {
    tenantIds = [String(opts.tenantId)];
  } else {
    const tr = await pool.request().query(`
      SELECT CAST(TenantId AS NVARCHAR(36)) AS TenantId
      FROM oe.Tenants
      ORDER BY Name
    `);
    tenantIds = (tr.recordset || []).map((r) => String(r.TenantId));
  }

  for (const tenantId of tenantIds) {
    let config;
    try {
      config = await DimeService.getConfigForTenant(tenantId);
    } catch (e) {
      // Tenant isn't on DIME (or misconfigured) — skip quietly, not an error.
      out.tenants.push({ tenantId, skipped: true, reason: e.message });
      continue;
    }

    try {
      const tenantResult = await reconcileTenant(pool, config, tenantId, runOpts);
      out.tenants.push(tenantResult);
      out.totals.candidateCount += tenantResult.candidateCount;
      out.totals.scanned += tenantResult.scanned;
      out.totals.overstatedCount += tenantResult.overstatedCount;
      out.totals.understatedCount += tenantResult.understatedCount;
      out.totals.apiErrors += tenantResult.apiErrors;
    } catch (e) {
      out.totals.tenantErrors += 1;
      out.tenants.push({ tenantId, ok: false, error: e.message });
      try {
        await recordIntegrationError({
          category: 'billing',
          source: 'dimeLedgerReconcile',
          severity: 'error',
          priority: 'critical',
          tenantId,
          message: `Ledger reconcile failed for tenant: ${e.message}`,
          detail: { stack: e.stack }
        });
      } catch (_) {}
      try {
        Sentry.captureException(e, { tags: { job: 'ledger-reconcile' }, extra: { tenantId } });
      } catch (_) {}
    }
  }

  out.finishedAt = new Date().toISOString();
  return out;
}

module.exports = {
  runDimeLedgerReconcile,
  // Exported for unit tests:
  classifyDimeStatus,
  netLedger,
  reconcileByTxn
};
