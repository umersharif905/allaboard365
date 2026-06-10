'use strict';

/**
 * DIME → DB ledger audit. Complements dimePaymentStatusAudit (which audits DB → DIME
 * one transaction at a time) by walking each customer's FULL DIME transaction ledger.
 * This is the only way to catch two patterns the single-transaction audit cannot see:
 *
 *  1. SETTLED-THEN-RETURNED (clawbacks): a returned ACH still reports ACH_PAYMENT_CREDIT
 *     on the original txn; the return exists only as separate ledger lines under the same
 *     transaction_number (e.g. Willey #498, 2026-06). Auto-fixed: Completed → Failed with
 *     the same invoice adjustment path the status audit uses.
 *
 *  2. MISSING ROWS: DIME settled a payment but no oe.Payments row exists (webhook never
 *     delivered, e.g. Beckner #453 / Yurt #465, 2026-05). REPORT-ONLY — rows are never
 *     auto-inserted because pricing/commission fields can't be derived safely; surface
 *     them loudly so a human reconciles.
 *
 * Notes:
 *  - DIME's /api/transactions customer filter 400/500s for credit-card-only customers;
 *    those are skipped and counted (CC has no ACH-return mechanism, and their settled
 *    status is still covered by the single-transaction audit).
 */

const { getPool, sql } = require('./db');
const DimeService = require('./dimeService');
const {
  getPaymentStatusInvoiceAdjustmentPlan,
  applyPaymentStatusInvoiceAdjustmentInTxn
} = require('./paymentAdminPatch');
const { isSuccessfulPaymentRecordStatus } = require('./payment-status');

/** Classify a raw DIME ledger line status. Order matters: REJECTED_FEE is a fee, not the principal. */
function classifyLedgerStatus(status) {
  const s = String(status || '').toUpperCase();
  if (s.includes('FEE')) return 'fee';
  if (s.includes('REJECT') || s.includes('RETURN') || s.includes('FAIL') || s.includes('DECLIN') || s.includes('VOID')) return 'failed';
  if (s.includes('REFUND')) return 'refund';
  if (s.includes('CREDIT') || s.includes('APPROVED') || s.includes('SETTLED') || s.includes('SUCCESS') || s.includes('COMPLETE')) return 'credit';
  if (s.includes('PENDING') || s.includes('PROCESSING')) return 'pending';
  return 'other';
}

/**
 * Group raw DIME ledger lines by transaction_number and net credits against
 * returns/rejections on the same txn (a return line carries the principal amount).
 *
 * @param {Array<Object>} lines raw DIME transaction objects
 * @returns {Array<{ transactionNumber: string, credit: number, clawedBack: boolean,
 *                   settled: boolean, creditDate: string|null, description: string }>}
 */
function netLedgerByTransaction(lines) {
  const byNum = new Map();
  for (const t of lines || []) {
    const num = String(t.transaction_number || t.transaction_id || t.id || '').trim();
    if (!num) continue;
    const status = t.transaction_status || t.status || '';
    const amount = Number(t.amount ?? 0);
    const cls = classifyLedgerStatus(status);
    if (!byNum.has(num)) {
      byNum.set(num, {
        transactionNumber: num,
        credit: 0,
        clawedBack: false,
        settled: false,
        creditDate: null,
        description: '',
        lines: []
      });
    }
    const g = byNum.get(num);
    g.lines.push({ status, amount, cls });
    if (!g.description && t.description) g.description = String(t.description);
    if (cls === 'credit') {
      g.credit = Math.max(g.credit, amount);
      if (!g.creditDate) g.creditDate = String(t.transaction_date || t.created_at || '').slice(0, 10) || null;
    }
  }
  for (const g of byNum.values()) {
    // A failed line whose amount covers the credited principal = the settled money bounced.
    g.clawedBack = g.credit > 0 && g.lines.some((l) => l.cls === 'failed' && l.amount >= g.credit);
    g.settled = g.credit > 0 && !g.clawedBack;
    delete g.lines;
  }
  return [...byNum.values()];
}

async function listCustomerUuidsForTenant(pool, tenantId, daysBack) {
  const result = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('daysBack', sql.Int, daysBack)
    .query(`
      SELECT DISTINCT m.ProcessorCustomerId AS uuid
      FROM oe.Payments p
      INNER JOIN oe.Members m ON m.HouseholdId = p.HouseholdId AND m.ProcessorCustomerId IS NOT NULL
      WHERE p.TenantId = @tenantId
        AND LOWER(ISNULL(p.Processor, '')) LIKE '%dime%'
        AND p.PaymentDate >= DATEADD(DAY, -@daysBack, SYSUTCDATETIME())
      UNION
      SELECT DISTINCT g.ProcessorCustomerId
      FROM oe.Payments p
      INNER JOIN oe.Groups g ON g.GroupId = p.GroupId AND g.ProcessorCustomerId IS NOT NULL
      WHERE p.TenantId = @tenantId
        AND LOWER(ISNULL(p.Processor, '')) LIKE '%dime%'
        AND p.PaymentDate >= DATEADD(DAY, -@daysBack, SYSUTCDATETIME())
    `);
  return (result.recordset || []).map((r) => String(r.uuid));
}

async function findDbPaymentByTxn(pool, tenantId, transactionNumber) {
  const result = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('txn', sql.NVarChar(128), transactionNumber)
    .query(`
      SELECT TOP 1 p.PaymentId, p.Status, p.Amount, p.InvoiceId, p.TransactionType,
             p.OriginalPaymentId, p.FailureReason
      FROM oe.Payments p
      WHERE p.TenantId = @tenantId
        AND CAST(p.ProcessorTransactionId AS NVARCHAR(128)) = @txn
        AND (p.TransactionType IS NULL OR p.TransactionType = 'Payment')
      ORDER BY p.CreatedDate DESC
    `);
  return result.recordset[0] || null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run the DIME → DB ledger audit for one tenant.
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {number} [params.daysBack=35] ledger window (returns can land ~6 days after settle)
 * @param {boolean} [params.dryRun=true] when false, clawbacks on Completed rows are auto-fixed
 * @param {number} [params.requestDelayMs=120] pause between per-customer DIME calls
 * @returns {Promise<Object>} summary
 */
async function runLedgerAudit(params) {
  const tenantId = params.tenantId;
  const dryRun = params.dryRun !== false;
  const daysBack = Math.min(92, Math.max(7, Number(params.daysBack) || 35));
  const requestDelayMs = Math.min(2000, Math.max(0, Number(params.requestDelayMs) || 120));
  if (!tenantId) throw new Error('tenantId is required');

  const pool = await getPool();
  const customerUuids = await listCustomerUuidsForTenant(pool, tenantId, daysBack);

  const end = new Date();
  const start = new Date(end.getTime() - daysBack * 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const startDate = `${fmt(start)} 00:00:00`;
  const endDate = `${fmt(end)} 23:59:59`;

  const summary = {
    dryRun,
    tenantId,
    daysBack,
    customersTotal: customerUuids.length,
    customersChecked: 0,
    customerLookupFailures: 0,
    ledgerLines: 0,
    settledTransactions: 0,
    clawbacksFound: 0,
    clawbacksFixed: 0,
    clawbacks: [],
    missingRows: [],
    errors: 0
  };

  const allNetted = [];
  for (const uuid of customerUuids) {
    if (requestDelayMs) await sleep(requestDelayMs);
    const res = await DimeService.listTransactions(
      { customer_uuid: uuid, start_date: startDate, end_date: endDate },
      tenantId
    );
    if (!res.success) {
      // CC-only customers consistently 400/500 on this endpoint — skip, the
      // single-transaction audit still covers their rows.
      summary.customerLookupFailures += 1;
      continue;
    }
    summary.customersChecked += 1;
    summary.ledgerLines += res.transactions.length;
    allNetted.push(...netLedgerByTransaction(res.transactions));
  }

  for (const txn of allNetted) {
    if (txn.settled) {
      summary.settledTransactions += 1;
      const row = await findDbPaymentByTxn(pool, tenantId, txn.transactionNumber);
      if (!row) {
        summary.missingRows.push({
          transactionNumber: txn.transactionNumber,
          amount: txn.credit,
          settledDate: txn.creditDate,
          description: txn.description
        });
      }
      continue;
    }

    if (!txn.clawedBack) continue;

    const row = await findDbPaymentByTxn(pool, tenantId, txn.transactionNumber);
    // No row, or DB already reflects the failure → nothing to fix.
    if (!row || !isSuccessfulPaymentRecordStatus(String(row.Status))) continue;

    summary.clawbacksFound += 1;
    const detail = {
      transactionNumber: txn.transactionNumber,
      paymentId: String(row.PaymentId),
      amount: txn.credit,
      dbStatus: String(row.Status),
      description: txn.description,
      fixed: false
    };
    summary.clawbacks.push(detail);

    if (dryRun) continue;

    const paymentRow = {
      InvoiceId: row.InvoiceId,
      TransactionType: row.TransactionType,
      OriginalPaymentId: row.OriginalPaymentId,
      Amount: row.Amount,
      Status: row.Status
    };

    try {
      const plan = await getPaymentStatusInvoiceAdjustmentPlan(
        pool,
        sql,
        String(row.PaymentId),
        paymentRow,
        'Failed',
        true
      );

      const transaction = new sql.Transaction(pool);
      try {
        await transaction.begin();
        await transaction
          .request()
          .input('paymentId', sql.UniqueIdentifier, row.PaymentId)
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .query(`
            UPDATE oe.Payments
            SET Status = N'Failed',
                FailureReason = N'Settled at DIME then principal RETURNED (post-settlement clawback) — detected by DIME ledger audit.',
                LastFailureDate = GETUTCDATE(),
                ModifiedDate = GETUTCDATE()
            WHERE PaymentId = @paymentId AND TenantId = @tenantId
          `);

        if (plan.kind) {
          await applyPaymentStatusInvoiceAdjustmentInTxn(transaction, sql, plan.kind, paymentRow, 'Failed');
        }

        await transaction.commit();
        detail.fixed = true;
        summary.clawbacksFixed += 1;
      } catch (txnErr) {
        try {
          await transaction.rollback();
        } catch (_rbErr) {
          /* ignore */
        }
        throw txnErr;
      }
    } catch (e) {
      summary.errors += 1;
      detail.error = e.message || String(e);
    }
  }

  return summary;
}

module.exports = {
  runLedgerAudit,
  netLedgerByTransaction,
  classifyLedgerStatus,
  listCustomerUuidsForTenant
};
