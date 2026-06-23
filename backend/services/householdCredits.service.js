'use strict';

/**
 * Household Credit Ledger Service (Phase 1 of credits & clawback ledger).
 *
 * Single append-only table oe.HouseholdCreditEntries. Available balance is
 * SUM(Amount) per household — positive entry types add, negative consume.
 *
 * Entry types (CHECK-constrained):
 *   - 'OverpaymentRecognized' : positive, paired with SourcePaymentId+SourceInvoiceId, idempotent via filtered unique index
 *   - 'AppliedToInvoice'      : negative, paired with TargetInvoiceId; RelatedEntryId points to the originating OverpaymentRecognized/ManualGoodwill
 *   - 'ReversedApplication'   : positive, paired with RelatedEntryId pointing to the AppliedToInvoice it cancels
 *   - 'ManualGoodwill'        : positive, sysadmin-issued
 *   - 'Voided'                : negative, RelatedEntryId points to the goodwill/recognized entry it cancels
 *
 * Application strategy (applyAvailableCredits):
 *   - Walk households with positive balance
 *   - For each, walk their unpaid/partial invoices oldest first
 *   - For each invoice, allocate `min(remainingBalance, BalanceDue)` from the oldest available
 *     OverpaymentRecognized/ManualGoodwill source entry (FIFO)
 *   - Insert one AppliedToInvoice ledger row per allocation, with RelatedEntryId = source entry id
 *   - Increment oe.Invoices.CreditAmount by the allocation amount (NEVER mutates PaidAmount)
 *   - Recompute invoice Status using PaidAmount + CreditAmount vs TotalAmount
 *
 * Reversal (reverseEntriesForPayment):
 *   - Used when a refund unwinds an original payment whose surplus became a credit
 *   - Insert ReversedApplication entries for every AppliedToInvoice descended from that payment
 *   - Decrement target invoice CreditAmount, recompute status
 *   - Returns [{ destinationInvoiceId, amountReversed }] so the caller can cascade commission clawback
 */

const sql = require('mssql');
const crypto = require('crypto');
const { getPool } = require('../config/database');

// Lazy-load commission service to avoid circular requires at module load time.
let _commissionService = null;
function _getCommissionService() {
  if (_commissionService === null) {
    try {
      _commissionService = require('./commissionService.advances');
    } catch (_e) {
      _commissionService = false;
    }
  }
  return _commissionService || null;
}

/**
 * After a credit-driven invoice flip commits, kick off commission creation for
 * any invoice that just became Status='Paid'. This is the credit-funded
 * (invoice-anchored) commission entry-point — getEligibleCommissions' UNION ALL
 * branch reads them by InvoiceId.
 *
 * Best-effort: failures are logged but never propagate so a downstream
 * commission glitch doesn't roll back a successful credit application.
 */
async function _fireCommissionsForNewlyPaidInvoices(applied) {
  if (!Array.isArray(applied) || applied.length === 0) return;
  const newlyPaid = applied.filter(a => a && a.newStatus === 'Paid' && a.invoiceId);
  if (newlyPaid.length === 0) return;
  const Commissions = _getCommissionService();
  if (!Commissions || typeof Commissions.createCommissionsForInvoice !== 'function') return;
  for (const a of newlyPaid) {
    try {
      await Commissions.createCommissionsForInvoice({ invoiceId: a.invoiceId });
    } catch (err) {
      // Non-blocking: log but never bubble.
      // eslint-disable-next-line no-console
      console.warn('[householdCredits] createCommissionsForInvoice failed (non-blocking)', {
        invoiceId: a.invoiceId,
        error: err && err.message
      });
    }
  }
}

const ENTRY_TYPES = Object.freeze({
  OVERPAYMENT: 'OverpaymentRecognized',
  APPLIED: 'AppliedToInvoice',
  REVERSED: 'ReversedApplication',
  GOODWILL: 'ManualGoodwill',
  VOIDED: 'Voided'
});

// ---------------------------------------------------------------------------
// Read-only queries
// ---------------------------------------------------------------------------

async function getAvailableBalance(householdId, options = {}) {
  if (!householdId) return { availableCredit: 0, byEntry: [] };
  const pool = await getPool();
  const balRes = await pool.request()
    .input('householdId', sql.UniqueIdentifier, householdId)
    .query(`
      SELECT COALESCE(SUM(Amount), 0) AS Balance, COUNT(*) AS EntryCount
      FROM oe.HouseholdCreditEntries
      WHERE HouseholdId = @householdId
    `);
  const availableCredit = Number(balRes.recordset?.[0]?.Balance || 0);
  const entryCount = Number(balRes.recordset?.[0]?.EntryCount || 0);

  let byEntry = [];
  if (options.includeEntries !== false) {
    const limit = Number.isFinite(options.entryLimit) ? options.entryLimit : 50;
    const entRes = await pool.request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .input('limit', sql.Int, limit)
      .query(`
        SELECT TOP (@limit) EntryId, EntryType, Amount, SourcePaymentId, SourceInvoiceId,
               TargetInvoiceId, RelatedEntryId, Notes, CreatedBy, CreatedDate
        FROM oe.HouseholdCreditEntries
        WHERE HouseholdId = @householdId
        ORDER BY CreatedDate DESC, EntryId
      `);
    byEntry = entRes.recordset || [];
  }

  return { availableCredit, entryCount, byEntry };
}

/**
 * Group-scoped twin of `getAvailableBalance`. Returns the available credit
 * balance and ledger entries for a given GroupId. Group entries apply to
 * invoices where InvoiceType='Group'.
 */
async function getGroupAvailableBalance(groupId, options = {}) {
  if (!groupId) return { availableCredit: 0, byEntry: [] };
  const pool = await getPool();
  const balRes = await pool.request()
    .input('groupId', sql.UniqueIdentifier, groupId)
    .query(`
      SELECT COALESCE(SUM(Amount), 0) AS Balance, COUNT(*) AS EntryCount
      FROM oe.HouseholdCreditEntries
      WHERE GroupId = @groupId
    `);
  const availableCredit = Number(balRes.recordset?.[0]?.Balance || 0);
  const entryCount = Number(balRes.recordset?.[0]?.EntryCount || 0);

  let byEntry = [];
  if (options.includeEntries !== false) {
    const limit = Number.isFinite(options.entryLimit) ? options.entryLimit : 50;
    const entRes = await pool.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .input('limit', sql.Int, limit)
      .query(`
        SELECT TOP (@limit) EntryId, EntryType, Amount, SourcePaymentId, SourceInvoiceId,
               TargetInvoiceId, RelatedEntryId, Notes, CreatedBy, CreatedDate
        FROM oe.HouseholdCreditEntries
        WHERE GroupId = @groupId
        ORDER BY CreatedDate DESC, EntryId
      `);
    byEntry = entRes.recordset || [];
  }

  return { availableCredit, entryCount, byEntry };
}

/**
 * List all households with non-zero credit balance, scoped to a tenant when provided.
 * Powers the new TenantBilling Credits tab and the BillingIntegrity panel.
 */
async function listHouseholdBalances({ tenantId, search, householdType, groupId, includeApplied = false, sysAdmin = false } = {}) {
  const pool = await getPool();
  const req = pool.request();

  let where = '1=1';
  if (!sysAdmin && tenantId) {
    req.input('tenantId', sql.UniqueIdentifier, tenantId);
    where += ' AND e.TenantId = @tenantId';
  } else if (tenantId) {
    req.input('tenantId', sql.UniqueIdentifier, tenantId);
    where += ' AND e.TenantId = @tenantId';
  }

  if (groupId) {
    req.input('groupId', sql.UniqueIdentifier, groupId);
    // Group-scope filter: either a group-scoped entry on @groupId, OR a
    // household-scoped entry whose household has a member in @groupId.
    where += ` AND (
      e.GroupId = @groupId
      OR EXISTS (SELECT 1 FROM oe.Members mg WHERE mg.HouseholdId = e.HouseholdId AND mg.GroupId = @groupId)
    )`;
  }

  if (typeof search === 'string' && search.trim()) {
    req.input('search', sql.NVarChar(255), `%${search.trim()}%`);
    // joins below provide names; filter applied after
  }

  // Aggregate balances; join households + groups for display names + type.
  // Two cohorts UNIONed:
  //   1) Household-scoped sums (e.HouseholdId IS NOT NULL) — Individuals or
  //      household-credits attached to a member that happens to be in a group.
  //   2) Group-scoped sums (e.GroupId IS NOT NULL) — credits issued directly
  //      against a group that apply to its monthly Group invoice.
  // Schema notes:
  //   - oe.Members has no IsPrimary; primary member uses RelationshipType='P'
  //   - FirstName/LastName live on oe.Users, joined via m.UserId
  //   - oe.Groups uses `Name` not `GroupName`
  // When includeApplied=true we drop the HAVING filter so accounts whose
  // credit has been fully applied or voided still appear (Balance = 0). We
  // also surface TotalIssued (sum of positive entries) and TotalApplied
  // (|sum of AppliedToInvoice + Voided|) so the UI can show history alongside
  // the live balance.
  const havingClause = includeApplied
    ? `HAVING SUM(CASE WHEN e.Amount > 0 THEN e.Amount ELSE 0 END) > 0.005`
    : `HAVING SUM(e.Amount) > 0.005`;

  const result = await req.query(`
    WITH HouseholdSums AS (
      SELECT e.HouseholdId, e.TenantId,
             SUM(e.Amount) AS Balance,
             SUM(CASE WHEN e.Amount > 0 THEN e.Amount ELSE 0 END) AS TotalIssued,
             SUM(CASE WHEN e.Amount < 0 THEN -e.Amount ELSE 0 END) AS TotalApplied,
             COUNT(*) AS EntryCount,
             MAX(e.CreatedDate) AS LastActivity
      FROM oe.HouseholdCreditEntries e
      WHERE ${where} AND e.HouseholdId IS NOT NULL
      GROUP BY e.HouseholdId, e.TenantId
      ${havingClause}
    ),
    GroupSums AS (
      SELECT e.GroupId, e.TenantId,
             SUM(e.Amount) AS Balance,
             SUM(CASE WHEN e.Amount > 0 THEN e.Amount ELSE 0 END) AS TotalIssued,
             SUM(CASE WHEN e.Amount < 0 THEN -e.Amount ELSE 0 END) AS TotalApplied,
             COUNT(*) AS EntryCount,
             MAX(e.CreatedDate) AS LastActivity
      FROM oe.HouseholdCreditEntries e
      WHERE ${where} AND e.GroupId IS NOT NULL
      GROUP BY e.GroupId, e.TenantId
      ${havingClause}
    )
    SELECT
      hs.HouseholdId,
      hs.TenantId,
      hs.Balance,
      hs.TotalIssued,
      hs.TotalApplied,
      hs.EntryCount,
      hs.LastActivity,
      m.MemberId AS PrimaryMemberId,
      CASE WHEN m.MemberId IS NOT NULL THEN m.GroupId ELSE NULL END AS GroupId,
      RTRIM(LTRIM(COALESCE(u.FirstName + ' ', '') + COALESCE(u.LastName, ''))) AS PrimaryName,
      g.Name AS GroupName,
      CASE WHEN m.GroupId IS NULL THEN 'Individual' ELSE 'Group' END AS HouseholdType
    FROM HouseholdSums hs
    OUTER APPLY (
      SELECT TOP 1 m.MemberId, m.GroupId, m.UserId, m.CreatedDate
      FROM oe.Members m
      WHERE m.HouseholdId = hs.HouseholdId AND m.RelationshipType = 'P'
      ORDER BY m.CreatedDate
    ) m
    LEFT JOIN oe.Users u ON u.UserId = m.UserId
    LEFT JOIN oe.Groups g ON g.GroupId = m.GroupId

    UNION ALL

    SELECT
      CAST(NULL AS UNIQUEIDENTIFIER) AS HouseholdId,
      gs.TenantId,
      gs.Balance,
      gs.TotalIssued,
      gs.TotalApplied,
      gs.EntryCount,
      gs.LastActivity,
      CAST(NULL AS UNIQUEIDENTIFIER) AS PrimaryMemberId,
      gs.GroupId AS GroupId,
      CAST(NULL AS NVARCHAR(255)) AS PrimaryName,
      g2.Name AS GroupName,
      'Group' AS HouseholdType
    FROM GroupSums gs
    LEFT JOIN oe.Groups g2 ON g2.GroupId = gs.GroupId

    ORDER BY LastActivity DESC
  `);

  let rows = result.recordset || [];

  if (typeof search === 'string' && search.trim()) {
    const needle = search.trim().toLowerCase();
    rows = rows.filter(r =>
      String(r.PrimaryName || '').toLowerCase().includes(needle)
      || String(r.GroupName || '').toLowerCase().includes(needle)
    );
  }
  if (householdType === 'Individual' || householdType === 'Group') {
    rows = rows.filter(r => r.HouseholdType === householdType);
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect overpayments and insert OverpaymentRecognized ledger entries.
 * Mirrors backfill SQL filters; idempotent via filtered unique index.
 */
async function detectOverpayments({ tenantId, householdId } = {}) {
  const pool = await getPool();
  const req = pool.request();
  let tenantClause = '';
  let householdClause = '';
  if (tenantId) {
    req.input('tenantId', sql.UniqueIdentifier, tenantId);
    tenantClause = 'AND p.TenantId = @tenantId';
  }
  if (householdId) {
    req.input('householdId', sql.UniqueIdentifier, householdId);
    householdClause = 'AND p.HouseholdId = @householdId';
  }
  const result = await req.query(`
    INSERT INTO oe.HouseholdCreditEntries (
      EntryId, TenantId, HouseholdId, EntryType, Amount,
      SourcePaymentId, SourceInvoiceId, Notes, CreatedDate
    )
    SELECT
      NEWID(),
      p.TenantId,
      p.HouseholdId,
      N'OverpaymentRecognized',
      CONVERT(DECIMAL(10, 2), p.Amount - i.TotalAmount),
      p.PaymentId,
      p.InvoiceId,
      N'Detected by nightly credits detector',
      GETUTCDATE()
    FROM oe.Payments p
    INNER JOIN oe.Invoices i ON i.InvoiceId = p.InvoiceId
    WHERE p.HouseholdId IS NOT NULL
      AND p.Amount > i.TotalAmount
      AND COALESCE(p.Status, '') NOT IN ('Refunded', 'Voided', 'Failed', 'Cancelled')
      AND COALESCE(p.TransactionType, 'Payment') NOT IN ('Refund', 'Chargeback', 'Reversal', 'ACH_Return')
      AND NOT EXISTS (
        SELECT 1 FROM oe.Payments r
        WHERE r.OriginalPaymentId = p.PaymentId
          AND r.TransactionType IN ('Refund', 'Reversal')
      )
      AND NOT EXISTS (
        SELECT 1 FROM oe.HouseholdCreditEntries e
        WHERE e.SourcePaymentId = p.PaymentId
          AND e.SourceInvoiceId = p.InvoiceId
          AND e.EntryType = N'OverpaymentRecognized'
      )
      ${tenantClause}
      ${householdClause}
  `);
  return { recognized: result.rowsAffected[0] || 0 };
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

function recalcStatusFromAmounts(totalAmount, paidAmount, creditAmount, currentStatus) {
  const total = Number(totalAmount) || 0;
  const paid = Number(paidAmount) || 0;
  const credit = Number(creditAmount) || 0;
  const covered = paid + credit;
  if (covered >= total - 0.005) return 'Paid';
  // Preserve Overdue set by the nightly due-date sweep: amount-driven recalcs
  // must not flip a past-due invoice back to Unpaid/Partial (the sweep's reset
  // pass handles due dates moving into the future).
  if (String(currentStatus || '') === 'Overdue') return 'Overdue';
  if (covered > 0.005) return 'Partial';
  return 'Unpaid';
}

/**
 * Apply available credit to oldest unpaid/partial invoices, FIFO from oldest
 * positive ledger entry. Inserts AppliedToInvoice rows and increments
 * oe.Invoices.CreditAmount (NEVER PaidAmount).
 *
 * Optional `householdId` to scope. Returns { householdsTouched, applications: [...] }.
 *
 * When `dryRun: true` is passed we walk the same allocation logic but return
 * `{ householdsTouched: 0, dryRun: true, simulations: [...] }` without inserting
 * any rows or mutating invoices. Use this to preview what the applier would do
 * for a single household before committing — handy for staging tests or
 * production "is Brian's $263.51 going where I think it is?" sanity checks.
 */
async function applyAvailableCredits({ householdId, groupId, dryRun = false } = {}) {
  if (dryRun) {
    return simulateApplyAvailableCredits({ householdId });
  }
  const pool = await getPool();

  // 1. Households with positive balance + unpaid/partial invoices
  const householdsReq = pool.request();
  let scope = '';
  if (householdId) {
    householdsReq.input('householdId', sql.UniqueIdentifier, householdId);
    scope = 'AND b.HouseholdId = @householdId';
  }
  const eligibleHouseholds = await householdsReq.query(`
    SELECT b.HouseholdId, b.TenantId, b.Balance
    FROM (
      SELECT HouseholdId, TenantId, SUM(Amount) AS Balance
      FROM oe.HouseholdCreditEntries
      WHERE HouseholdId IS NOT NULL
      GROUP BY HouseholdId, TenantId
    ) b
    WHERE b.Balance > 0.005 ${scope}
      AND EXISTS (
        SELECT 1 FROM oe.Invoices i
        WHERE i.HouseholdId = b.HouseholdId
          AND i.Status NOT IN (N'Cancelled', N'Voided')
          AND COALESCE(i.PaidAmount, 0) + COALESCE(i.CreditAmount, 0) < COALESCE(i.TotalAmount, 0) - 0.005
      )
  `);

  let householdsTouched = 0;
  const applications = [];

  for (const row of eligibleHouseholds.recordset || []) {
    const result = await applyForHousehold(pool, row.HouseholdId);
    if (result.applied.length > 0) {
      householdsTouched += 1;
      applications.push({ householdId: row.HouseholdId, applied: result.applied });
    }
  }

  // 2. Groups with positive GROUP-scoped balance + unpaid/partial Group invoices.
  const groupsReq = pool.request();
  let groupScope = '';
  if (groupId) {
    groupsReq.input('groupId', sql.UniqueIdentifier, groupId);
    groupScope = 'AND b.GroupId = @groupId';
  }
  const eligibleGroups = await groupsReq.query(`
    SELECT b.GroupId, b.TenantId, b.Balance
    FROM (
      SELECT GroupId, TenantId, SUM(Amount) AS Balance
      FROM oe.HouseholdCreditEntries
      WHERE GroupId IS NOT NULL
      GROUP BY GroupId, TenantId
    ) b
    WHERE b.Balance > 0.005 ${groupScope}
      AND EXISTS (
        SELECT 1 FROM oe.Invoices i
        WHERE i.GroupId = b.GroupId
          AND i.InvoiceType = N'Group'
          AND i.Status NOT IN (N'Cancelled', N'Voided')
          AND COALESCE(i.PaidAmount, 0) + COALESCE(i.CreditAmount, 0) < COALESCE(i.TotalAmount, 0) - 0.005
      )
  `);

  let groupsTouched = 0;

  for (const row of eligibleGroups.recordset || []) {
    const result = await applyForGroup(pool, row.GroupId);
    if (result.applied.length > 0) {
      groupsTouched += 1;
      applications.push({ groupId: row.GroupId, applied: result.applied });
    }
  }

  return { householdsTouched, groupsTouched, applications };
}

/**
 * Read-only preview of what `applyAvailableCredits` would do. No inserts, no
 * invoice updates. Walks the same FIFO source -> oldest invoice allocation
 * logic and returns a per-household, per-invoice projection.
 */
async function simulateApplyAvailableCredits({ householdId } = {}) {
  const pool = await getPool();
  const req = pool.request();
  let scope = '';
  if (householdId) {
    req.input('householdId', sql.UniqueIdentifier, householdId);
    scope = 'AND b.HouseholdId = @householdId';
  }
  const eligibleHouseholds = await req.query(`
    SELECT b.HouseholdId, b.TenantId, b.Balance
    FROM (
      SELECT HouseholdId, TenantId, SUM(Amount) AS Balance
      FROM oe.HouseholdCreditEntries
      GROUP BY HouseholdId, TenantId
    ) b
    WHERE b.Balance > 0.005 ${scope}
      AND EXISTS (
        SELECT 1 FROM oe.Invoices i
        WHERE i.HouseholdId = b.HouseholdId
          AND i.Status NOT IN (N'Cancelled', N'Voided')
          AND COALESCE(i.PaidAmount, 0) + COALESCE(i.CreditAmount, 0) < COALESCE(i.TotalAmount, 0) - 0.005
      )
  `);

  const simulations = [];

  for (const hh of eligibleHouseholds.recordset || []) {
    let remaining = Number(hh.Balance) || 0;

    const sourcesRes = await pool.request()
      .input('householdId', sql.UniqueIdentifier, hh.HouseholdId)
      .query(`
        SELECT s.EntryId, s.Amount,
          s.Amount + COALESCE((
            SELECT SUM(Amount) FROM oe.HouseholdCreditEntries c
            WHERE c.RelatedEntryId = s.EntryId
              AND c.EntryType IN (N'AppliedToInvoice', N'Voided')
          ), 0) AS RemainingFromSource,
          s.CreatedDate, s.SourcePaymentId
        FROM oe.HouseholdCreditEntries s
        WHERE s.HouseholdId = @householdId
          AND s.EntryType IN (N'OverpaymentRecognized', N'ManualGoodwill', N'ReversedApplication')
          AND s.Amount > 0
        ORDER BY s.CreatedDate, s.EntryId
      `);
    const sources = (sourcesRes.recordset || [])
      .map(s => ({
        entryId: s.EntryId,
        sourcePaymentId: s.SourcePaymentId,
        remaining: Math.max(0, Number(s.RemainingFromSource) || 0)
      }))
      .filter(s => s.remaining > 0.005);

    const invoicesRes = await pool.request()
      .input('householdId', sql.UniqueIdentifier, hh.HouseholdId)
      .query(`
        SELECT InvoiceId, InvoiceNumber, TotalAmount,
               COALESCE(PaidAmount, 0) AS PaidAmount,
               COALESCE(CreditAmount, 0) AS CreditAmount,
               BillingPeriodStart, Status
        FROM oe.Invoices
        WHERE HouseholdId = @householdId
          AND Status NOT IN (N'Cancelled', N'Voided')
          AND COALESCE(PaidAmount, 0) + COALESCE(CreditAmount, 0) < COALESCE(TotalAmount, 0) - 0.005
        ORDER BY BillingPeriodStart ASC, InvoiceDate ASC
      `);

    const invoiceProjections = [];
    let sourceIdx = 0;

    for (const inv of invoicesRes.recordset || []) {
      if (remaining < 0.005) break;
      const total = Number(inv.TotalAmount) || 0;
      const paid = Number(inv.PaidAmount) || 0;
      const creditOnInvoice = Number(inv.CreditAmount) || 0;
      let invoiceBalance = total - paid - creditOnInvoice;
      if (invoiceBalance < 0.005) continue;

      let appliedToThisInvoice = 0;
      const allocations = [];

      while (invoiceBalance > 0.005 && sourceIdx < sources.length) {
        const src = sources[sourceIdx];
        if (src.remaining < 0.005) { sourceIdx += 1; continue; }
        const take = Math.min(src.remaining, invoiceBalance, remaining);
        const amt = Math.round(take * 100) / 100;
        if (amt < 0.005) break;

        allocations.push({
          fromEntryId: src.entryId,
          fromSourcePaymentId: src.sourcePaymentId,
          amount: amt
        });
        src.remaining -= amt;
        invoiceBalance -= amt;
        remaining -= amt;
        appliedToThisInvoice += amt;
      }

      if (appliedToThisInvoice > 0) {
        const newCredit = creditOnInvoice + appliedToThisInvoice;
        invoiceProjections.push({
          invoiceId: inv.InvoiceId,
          invoiceNumber: inv.InvoiceNumber,
          billingPeriodStart: inv.BillingPeriodStart,
          totalAmount: total,
          currentPaid: paid,
          currentCredit: creditOnInvoice,
          currentBalance: Math.round((total - paid - creditOnInvoice) * 100) / 100,
          wouldApplyCredit: Math.round(appliedToThisInvoice * 100) / 100,
          projectedCreditAmount: Math.round(newCredit * 100) / 100,
          projectedBalance: Math.round(Math.max(0, total - paid - newCredit) * 100) / 100,
          projectedStatus: recalcStatusFromAmounts(total, paid, newCredit),
          allocations
        });
      }
    }

    simulations.push({
      householdId: hh.HouseholdId,
      tenantId: hh.TenantId,
      availableBalance: Number(hh.Balance) || 0,
      remainingAfterSimulation: Math.round(remaining * 100) / 100,
      invoicesAffected: invoiceProjections.length,
      invoices: invoiceProjections
    });
  }

  return { dryRun: true, householdsTouched: 0, simulations };
}

/**
 * Apply credits for a single household. Used by the nightly applier and by
 * group MonthlyPaymentScheduler (Phase 1d.1) for inline application before
 * setting up DIME recurring.
 *
 * Optional `transaction` parameter: when provided, runs inside that transaction
 * (atomic with caller). When omitted, opens its own transaction.
 */
async function applyForHousehold(poolOrTxn, householdId, options = {}) {
  if (!householdId) return { applied: [] };

  // Allow either a pool or a transaction. When passed a transaction, do not
  // open a nested one; trust the caller to commit.
  const isTxn = poolOrTxn && typeof poolOrTxn.request === 'function' && typeof poolOrTxn.commit !== 'function';
  // Note: pool also has request(). The reliable signal is: pool has `.transaction()` whereas mssql.Transaction does not.
  // Since both have .request(), check for hasOwnProperty 'transaction' method.
  const looksLikePool = poolOrTxn && typeof poolOrTxn.transaction === 'function';
  const ownTxn = !options.transaction && looksLikePool;
  let txn;
  if (options.transaction) {
    txn = options.transaction;
  } else if (looksLikePool) {
    txn = poolOrTxn.transaction();
    await txn.begin();
  } else {
    // poolOrTxn is already a transaction
    txn = poolOrTxn;
  }

  const applied = [];

  try {
    // Available balance
    const balRes = await txn.request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .query(`SELECT COALESCE(SUM(Amount), 0) AS Balance FROM oe.HouseholdCreditEntries WHERE HouseholdId = @householdId`);
    let remaining = Number(balRes.recordset?.[0]?.Balance || 0);
    if (remaining < 0.005) {
      if (ownTxn) await txn.commit();
      return { applied: [] };
    }

    // Source pool: positive entries (OverpaymentRecognized/ManualGoodwill/ReversedApplication)
    // minus their consumed portion, ordered FIFO. We track per-source remaining via SUM(child) math.
    const sourcesRes = await txn.request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .query(`
        SELECT s.EntryId, s.Amount,
          s.Amount + COALESCE((
            SELECT SUM(Amount) FROM oe.HouseholdCreditEntries c
            WHERE c.RelatedEntryId = s.EntryId
              AND c.EntryType IN (N'AppliedToInvoice', N'Voided')
          ), 0) AS RemainingFromSource,
          s.CreatedDate
        FROM oe.HouseholdCreditEntries s
        WHERE s.HouseholdId = @householdId
          AND s.EntryType IN (N'OverpaymentRecognized', N'ManualGoodwill', N'ReversedApplication')
          AND s.Amount > 0
        ORDER BY s.CreatedDate, s.EntryId
      `);

    const sources = (sourcesRes.recordset || [])
      .map(s => ({ entryId: s.EntryId, remaining: Math.max(0, Number(s.RemainingFromSource) || 0) }))
      .filter(s => s.remaining > 0.005);

    if (sources.length === 0) {
      if (ownTxn) await txn.commit();
      return { applied: [] };
    }

    // Target invoices: oldest unpaid/partial first
    const invoicesRes = await txn.request()
      .input('householdId', sql.UniqueIdentifier, householdId)
      .query(`
        SELECT InvoiceId, TenantId, TotalAmount,
               COALESCE(PaidAmount, 0) AS PaidAmount,
               COALESCE(CreditAmount, 0) AS CreditAmount,
               BillingPeriodStart, Status
        FROM oe.Invoices
        WHERE HouseholdId = @householdId
          AND Status NOT IN (N'Cancelled', N'Voided')
          AND COALESCE(PaidAmount, 0) + COALESCE(CreditAmount, 0) < COALESCE(TotalAmount, 0) - 0.005
        ORDER BY BillingPeriodStart ASC, InvoiceDate ASC
      `);

    let sourceIdx = 0;
    for (const inv of invoicesRes.recordset || []) {
      if (remaining < 0.005) break;
      const total = Number(inv.TotalAmount) || 0;
      const paid = Number(inv.PaidAmount) || 0;
      const creditOnInvoice = Number(inv.CreditAmount) || 0;
      let invoiceBalance = total - paid - creditOnInvoice;
      if (invoiceBalance < 0.005) continue;

      let appliedToThisInvoice = 0;
      while (invoiceBalance > 0.005 && sourceIdx < sources.length) {
        const src = sources[sourceIdx];
        if (src.remaining < 0.005) { sourceIdx += 1; continue; }
        const take = Math.min(src.remaining, invoiceBalance, remaining);
        const amt = Math.round(take * 100) / 100;
        if (amt < 0.005) break;

        // Insert AppliedToInvoice ledger row (negative Amount, RelatedEntryId -> source)
        await txn.request()
          .input('entryId', sql.UniqueIdentifier, crypto.randomUUID())
          .input('tenantId', sql.UniqueIdentifier, inv.TenantId)
          .input('householdId', sql.UniqueIdentifier, householdId)
          .input('amount', sql.Decimal(10, 2), -amt)
          .input('targetInvoiceId', sql.UniqueIdentifier, inv.InvoiceId)
          .input('relatedEntryId', sql.UniqueIdentifier, src.entryId)
          .query(`
            INSERT INTO oe.HouseholdCreditEntries
              (EntryId, TenantId, HouseholdId, EntryType, Amount, TargetInvoiceId, RelatedEntryId, CreatedDate)
            VALUES
              (@entryId, @tenantId, @householdId, N'AppliedToInvoice', @amount, @targetInvoiceId, @relatedEntryId, GETUTCDATE())
          `);

        src.remaining -= amt;
        invoiceBalance -= amt;
        remaining -= amt;
        appliedToThisInvoice += amt;
      }

      if (appliedToThisInvoice > 0) {
        // Bump invoice CreditAmount + recompute Status
        const newCredit = creditOnInvoice + appliedToThisInvoice;
        const newStatus = recalcStatusFromAmounts(total, paid, newCredit, inv.Status);
        await txn.request()
          .input('invoiceId', sql.UniqueIdentifier, inv.InvoiceId)
          .input('newCredit', sql.Decimal(12, 2), Math.round(newCredit * 100) / 100)
          .input('status', sql.NVarChar(50), newStatus)
          .query(`
            UPDATE oe.Invoices
            SET CreditAmount = @newCredit,
                Status = @status,
                PaymentReceivedDate = CASE WHEN @status = N'Paid' AND PaymentReceivedDate IS NULL THEN GETUTCDATE() ELSE PaymentReceivedDate END,
                ModifiedDate = GETUTCDATE()
            WHERE InvoiceId = @invoiceId
          `);
        applied.push({
          invoiceId: inv.InvoiceId,
          appliedAmount: Math.round(appliedToThisInvoice * 100) / 100,
          newStatus
        });
      }
    }

    if (ownTxn) await txn.commit();
    if (ownTxn) await _fireCommissionsForNewlyPaidInvoices(applied);
    return { applied };
  } catch (err) {
    if (ownTxn) {
      try { await txn.rollback(); } catch (_) {}
    }
    throw err;
  }
}

/**
 * Apply available GROUP-scoped credit to the group's oldest unpaid Group
 * invoices (FIFO). Mirror of `applyForHousehold` but keyed off GroupId and
 * targets oe.Invoices where InvoiceType='Group' and GroupId matches.
 *
 * Optional `transaction` parameter to participate in a caller's transaction.
 */
async function applyForGroup(poolOrTxn, groupId, options = {}) {
  if (!groupId) return { applied: [] };

  const looksLikePool = poolOrTxn && typeof poolOrTxn.transaction === 'function';
  const ownTxn = !options.transaction && looksLikePool;
  let txn;
  if (options.transaction) {
    txn = options.transaction;
  } else if (looksLikePool) {
    txn = poolOrTxn.transaction();
    await txn.begin();
  } else {
    txn = poolOrTxn;
  }

  const applied = [];

  try {
    const balRes = await txn.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`SELECT COALESCE(SUM(Amount), 0) AS Balance FROM oe.HouseholdCreditEntries WHERE GroupId = @groupId`);
    let remaining = Number(balRes.recordset?.[0]?.Balance || 0);
    if (remaining < 0.005) {
      if (ownTxn) await txn.commit();
      return { applied: [] };
    }

    const sourcesRes = await txn.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`
        SELECT s.EntryId, s.TenantId, s.Amount,
          s.Amount + COALESCE((
            SELECT SUM(Amount) FROM oe.HouseholdCreditEntries c
            WHERE c.RelatedEntryId = s.EntryId
              AND c.EntryType IN (N'AppliedToInvoice', N'Voided')
          ), 0) AS RemainingFromSource,
          s.CreatedDate
        FROM oe.HouseholdCreditEntries s
        WHERE s.GroupId = @groupId
          AND s.EntryType IN (N'OverpaymentRecognized', N'ManualGoodwill', N'ReversedApplication')
          AND s.Amount > 0
        ORDER BY s.CreatedDate, s.EntryId
      `);

    const sources = (sourcesRes.recordset || [])
      .map(s => ({ entryId: s.EntryId, tenantId: s.TenantId, remaining: Math.max(0, Number(s.RemainingFromSource) || 0) }))
      .filter(s => s.remaining > 0.005);

    if (sources.length === 0) {
      if (ownTxn) await txn.commit();
      return { applied: [] };
    }

    const invoicesRes = await txn.request()
      .input('groupId', sql.UniqueIdentifier, groupId)
      .query(`
        SELECT InvoiceId, TenantId, TotalAmount,
               COALESCE(PaidAmount, 0) AS PaidAmount,
               COALESCE(CreditAmount, 0) AS CreditAmount,
               BillingPeriodStart, Status
        FROM oe.Invoices
        WHERE GroupId = @groupId
          AND InvoiceType = N'Group'
          AND Status NOT IN (N'Cancelled', N'Voided')
          AND COALESCE(PaidAmount, 0) + COALESCE(CreditAmount, 0) < COALESCE(TotalAmount, 0) - 0.005
        ORDER BY BillingPeriodStart ASC, InvoiceDate ASC
      `);

    let sourceIdx = 0;
    for (const inv of invoicesRes.recordset || []) {
      if (remaining < 0.005) break;
      const total = Number(inv.TotalAmount) || 0;
      const paid = Number(inv.PaidAmount) || 0;
      const creditOnInvoice = Number(inv.CreditAmount) || 0;
      let invoiceBalance = total - paid - creditOnInvoice;
      if (invoiceBalance < 0.005) continue;

      let appliedToThisInvoice = 0;
      while (invoiceBalance > 0.005 && sourceIdx < sources.length) {
        const src = sources[sourceIdx];
        if (src.remaining < 0.005) { sourceIdx += 1; continue; }
        const take = Math.min(src.remaining, invoiceBalance, remaining);
        const amt = Math.round(take * 100) / 100;
        if (amt < 0.005) break;

        await txn.request()
          .input('entryId', sql.UniqueIdentifier, crypto.randomUUID())
          .input('tenantId', sql.UniqueIdentifier, inv.TenantId)
          .input('groupId', sql.UniqueIdentifier, groupId)
          .input('amount', sql.Decimal(10, 2), -amt)
          .input('targetInvoiceId', sql.UniqueIdentifier, inv.InvoiceId)
          .input('relatedEntryId', sql.UniqueIdentifier, src.entryId)
          .query(`
            INSERT INTO oe.HouseholdCreditEntries
              (EntryId, TenantId, GroupId, EntryType, Amount, TargetInvoiceId, RelatedEntryId, CreatedDate)
            VALUES
              (@entryId, @tenantId, @groupId, N'AppliedToInvoice', @amount, @targetInvoiceId, @relatedEntryId, GETUTCDATE())
          `);

        src.remaining -= amt;
        invoiceBalance -= amt;
        remaining -= amt;
        appliedToThisInvoice += amt;
      }

      if (appliedToThisInvoice > 0) {
        const newCredit = creditOnInvoice + appliedToThisInvoice;
        const newStatus = recalcStatusFromAmounts(total, paid, newCredit, inv.Status);
        await txn.request()
          .input('invoiceId', sql.UniqueIdentifier, inv.InvoiceId)
          .input('newCredit', sql.Decimal(12, 2), Math.round(newCredit * 100) / 100)
          .input('status', sql.NVarChar(50), newStatus)
          .query(`
            UPDATE oe.Invoices
            SET CreditAmount = @newCredit,
                Status = @status,
                PaymentReceivedDate = CASE WHEN @status = N'Paid' AND PaymentReceivedDate IS NULL THEN GETUTCDATE() ELSE PaymentReceivedDate END,
                ModifiedDate = GETUTCDATE()
            WHERE InvoiceId = @invoiceId
          `);
        applied.push({
          invoiceId: inv.InvoiceId,
          appliedAmount: Math.round(appliedToThisInvoice * 100) / 100,
          newStatus
        });
      }
    }

    if (ownTxn) await txn.commit();
    if (ownTxn) await _fireCommissionsForNewlyPaidInvoices(applied);
    return { applied };
  } catch (err) {
    if (ownTxn) {
      try { await txn.rollback(); } catch (_) {}
    }
    throw err;
  }
}

/**
 * Apply a single positive credit entry directly to one invoice. Used when an
 * admin wants to "issue + immediately apply" a goodwill credit, or when we
 * want to target a specific invoice rather than walk FIFO oldest-first.
 *
 * - Verifies entry is a positive type with remaining balance
 * - Verifies invoice belongs to the same tenant + household, is not Cancelled/Voided
 * - Allocates min(remainingFromEntry, invoiceBalance, requestedAmount?)
 * - Inserts AppliedToInvoice ledger row + bumps Invoices.CreditAmount
 *
 * Optional `transaction` to participate in a caller's transaction. Otherwise
 * opens its own.
 */
async function applyEntryToInvoice({ entryId, invoiceId, amount, transaction } = {}) {
  if (!entryId) throw new Error('entryId is required');
  if (!invoiceId) throw new Error('invoiceId is required');

  const pool = await getPool();
  const ownTxn = !transaction;
  const txn = transaction || pool.transaction();
  if (ownTxn) await txn.begin();

  try {
    const entryRes = await txn.request()
      .input('entryId', sql.UniqueIdentifier, entryId)
      .query(`
        SELECT e.EntryId, e.TenantId, e.HouseholdId, e.GroupId, e.EntryType, e.Amount,
          e.Amount + COALESCE((
            SELECT SUM(Amount) FROM oe.HouseholdCreditEntries c
            WHERE c.RelatedEntryId = e.EntryId
              AND c.EntryType IN (N'AppliedToInvoice', N'Voided')
          ), 0) AS Remaining
        FROM oe.HouseholdCreditEntries e
        WHERE e.EntryId = @entryId
      `);
    const entry = entryRes.recordset?.[0];
    if (!entry) throw new Error('credit entry not found');
    if (!['ManualGoodwill', 'OverpaymentRecognized', 'ReversedApplication'].includes(entry.EntryType)) {
      throw new Error(`cannot apply entry of type ${entry.EntryType}`);
    }
    const remainingFromEntry = Math.max(0, Number(entry.Remaining) || 0);
    if (remainingFromEntry < 0.005) throw new Error('credit entry has no remaining balance');

    const invRes = await txn.request()
      .input('invoiceId', sql.UniqueIdentifier, invoiceId)
      .query(`
        SELECT InvoiceId, TenantId, HouseholdId, GroupId, InvoiceType, TotalAmount,
               COALESCE(PaidAmount, 0) AS PaidAmount,
               COALESCE(CreditAmount, 0) AS CreditAmount,
               Status
        FROM oe.Invoices WHERE InvoiceId = @invoiceId
      `);
    const inv = invRes.recordset?.[0];
    if (!inv) throw new Error('invoice not found');
    if (['Cancelled', 'Voided'].includes(inv.Status)) {
      throw new Error(`cannot apply credit to invoice with status ${inv.Status}`);
    }
    if (String(inv.TenantId).toLowerCase() !== String(entry.TenantId).toLowerCase()) {
      throw new Error('invoice tenant does not match credit tenant');
    }

    // Scope-aware match: a household credit applies only to invoices for that
    // same household; a group credit applies only to group-type invoices for
    // that same group.
    if (entry.HouseholdId) {
      if (!inv.HouseholdId || String(inv.HouseholdId).toLowerCase() !== String(entry.HouseholdId).toLowerCase()) {
        throw new Error('invoice household does not match credit household');
      }
    } else if (entry.GroupId) {
      if (!inv.GroupId || String(inv.GroupId).toLowerCase() !== String(entry.GroupId).toLowerCase()) {
        throw new Error('invoice group does not match credit group');
      }
      if (inv.InvoiceType !== 'Group') {
        throw new Error('group credit can only be applied to InvoiceType=Group invoices');
      }
    } else {
      throw new Error('credit entry has neither HouseholdId nor GroupId');
    }

    const total = Number(inv.TotalAmount) || 0;
    const paid = Number(inv.PaidAmount) || 0;
    const creditOnInvoice = Number(inv.CreditAmount) || 0;
    const invoiceBalance = total - paid - creditOnInvoice;
    if (invoiceBalance < 0.005) throw new Error('invoice already fully paid/credited');

    const requested = Number.isFinite(Number(amount)) && Number(amount) > 0 ? Number(amount) : Infinity;
    const take = Math.min(remainingFromEntry, invoiceBalance, requested);
    const amt = Math.round(take * 100) / 100;
    if (amt < 0.005) throw new Error('amount too small to apply');

    const newAppliedId = crypto.randomUUID();
    await txn.request()
      .input('entryId', sql.UniqueIdentifier, newAppliedId)
      .input('tenantId', sql.UniqueIdentifier, entry.TenantId)
      .input('householdId', sql.UniqueIdentifier, entry.HouseholdId || null)
      .input('groupId', sql.UniqueIdentifier, entry.GroupId || null)
      .input('amount', sql.Decimal(10, 2), -amt)
      .input('targetInvoiceId', sql.UniqueIdentifier, inv.InvoiceId)
      .input('relatedEntryId', sql.UniqueIdentifier, entry.EntryId)
      .query(`
        INSERT INTO oe.HouseholdCreditEntries
          (EntryId, TenantId, HouseholdId, GroupId, EntryType, Amount, TargetInvoiceId, RelatedEntryId, Notes, CreatedDate)
        VALUES (@entryId, @tenantId, @householdId, @groupId, N'AppliedToInvoice', @amount, @targetInvoiceId, @relatedEntryId,
                N'Applied directly to invoice by admin', GETUTCDATE())
      `);

    const newCredit = creditOnInvoice + amt;
    const newStatus = recalcStatusFromAmounts(total, paid, newCredit, inv.Status);
    await txn.request()
      .input('invoiceId', sql.UniqueIdentifier, inv.InvoiceId)
      .input('newCredit', sql.Decimal(12, 2), Math.round(newCredit * 100) / 100)
      .input('status', sql.NVarChar(50), newStatus)
      .query(`
        UPDATE oe.Invoices
        SET CreditAmount = @newCredit,
            Status = @status,
            PaymentReceivedDate = CASE WHEN @status = N'Paid' AND PaymentReceivedDate IS NULL THEN GETUTCDATE() ELSE PaymentReceivedDate END,
            ModifiedDate = GETUTCDATE()
        WHERE InvoiceId = @invoiceId
      `);

    if (ownTxn) await txn.commit();
    if (ownTxn) {
      await _fireCommissionsForNewlyPaidInvoices([
        { invoiceId: inv.InvoiceId, appliedAmount: amt, newStatus }
      ]);
    }
    return {
      invoiceId: inv.InvoiceId,
      appliedAmount: amt,
      newStatus,
      newCreditAmount: Math.round(newCredit * 100) / 100,
      newBalance: Math.round(Math.max(0, total - paid - newCredit) * 100) / 100
    };
  } catch (err) {
    if (ownTxn) {
      try { await txn.rollback(); } catch (_) {}
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Manual goodwill / void
// ---------------------------------------------------------------------------

async function createManualGoodwill({ tenantId, householdId, groupId, amount, notes, createdBy, sourceInvoiceId, transaction } = {}) {
  if (!tenantId) throw new Error('tenantId is required');
  if (!householdId && !groupId) throw new Error('householdId or groupId is required');
  if (householdId && groupId) throw new Error('cannot set both householdId and groupId');
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('amount must be > 0');

  const entryId = crypto.randomUUID();
  const requester = transaction ? transaction.request() : (await getPool()).request();
  await requester
    .input('entryId', sql.UniqueIdentifier, entryId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('householdId', sql.UniqueIdentifier, householdId || null)
    .input('groupId', sql.UniqueIdentifier, groupId || null)
    .input('amount', sql.Decimal(10, 2), Math.round(amt * 100) / 100)
    .input('notes', sql.NVarChar(500), typeof notes === 'string' && notes.trim() ? notes.trim() : null)
    .input('createdBy', sql.UniqueIdentifier, createdBy || null)
    .input('sourceInvoiceId', sql.UniqueIdentifier, sourceInvoiceId || null)
    .query(`
      INSERT INTO oe.HouseholdCreditEntries
        (EntryId, TenantId, HouseholdId, GroupId, EntryType, Amount, SourceInvoiceId, Notes, CreatedBy, CreatedDate)
      VALUES (@entryId, @tenantId, @householdId, @groupId, N'ManualGoodwill', @amount, @sourceInvoiceId, @notes, @createdBy, GETUTCDATE())
    `);
  return { entryId };
}

/**
 * Void a goodwill or recognized entry by inserting a Voided row of equal
 * negative magnitude. Refuses if the entry is already fully consumed by
 * AppliedToInvoice / Voided rows.
 */
async function voidEntry({ entryId, voidedBy, reason }) {
  if (!entryId) throw new Error('entryId is required');
  const pool = await getPool();

  const targetRes = await pool.request()
    .input('entryId', sql.UniqueIdentifier, entryId)
    .query(`
      SELECT e.EntryId, e.TenantId, e.HouseholdId, e.GroupId, e.EntryType, e.Amount,
        e.Amount + COALESCE((
          SELECT SUM(Amount) FROM oe.HouseholdCreditEntries c
          WHERE c.RelatedEntryId = e.EntryId AND c.EntryType IN (N'AppliedToInvoice', N'Voided')
        ), 0) AS Remaining
      FROM oe.HouseholdCreditEntries e
      WHERE e.EntryId = @entryId
    `);
  const target = targetRes.recordset?.[0];
  if (!target) throw new Error('entry not found');
  if (!['ManualGoodwill', 'OverpaymentRecognized', 'ReversedApplication'].includes(target.EntryType)) {
    throw new Error(`Cannot void entry of type ${target.EntryType}`);
  }
  const remaining = Math.max(0, Number(target.Remaining) || 0);
  if (remaining < 0.005) throw new Error('entry already fully consumed');

  const newId = crypto.randomUUID();
  await pool.request()
    .input('entryId', sql.UniqueIdentifier, newId)
    .input('tenantId', sql.UniqueIdentifier, target.TenantId)
    .input('householdId', sql.UniqueIdentifier, target.HouseholdId || null)
    .input('groupId', sql.UniqueIdentifier, target.GroupId || null)
    .input('amount', sql.Decimal(10, 2), -Math.round(remaining * 100) / 100)
    .input('relatedEntryId', sql.UniqueIdentifier, target.EntryId)
    .input('notes', sql.NVarChar(500), typeof reason === 'string' && reason.trim() ? reason.trim() : null)
    .input('createdBy', sql.UniqueIdentifier, voidedBy || null)
    .query(`
      INSERT INTO oe.HouseholdCreditEntries
        (EntryId, TenantId, HouseholdId, GroupId, EntryType, Amount, RelatedEntryId, Notes, CreatedBy, CreatedDate)
      VALUES (@entryId, @tenantId, @householdId, @groupId, N'Voided', @amount, @relatedEntryId, @notes, @createdBy, GETUTCDATE())
    `);
  return { entryId: newId, voidedAmount: remaining };
}

// ---------------------------------------------------------------------------
// Reversal (called from RefundService.processRefund step 7)
// ---------------------------------------------------------------------------

/**
 * Walk the credit chain originating from `paymentId` and reverse every
 * AppliedToInvoice descendant. Decrements oe.Invoices.CreditAmount on each
 * destination invoice and recomputes Status.
 *
 * Returns { reversedApplications: [{ destinationInvoiceId, amountReversed }] }
 * so the caller can cascade commission clawback for invoices whose credit
 * coverage just disappeared.
 */
async function reverseEntriesForPayment(paymentId, transaction) {
  if (!paymentId) return { reversedApplications: [] };
  if (!transaction) throw new Error('reverseEntriesForPayment requires an open transaction');

  // 1. Find the OverpaymentRecognized entry for this payment
  const sourceRes = await transaction.request()
    .input('paymentId', sql.UniqueIdentifier, paymentId)
    .query(`
      SELECT EntryId, TenantId, HouseholdId
      FROM oe.HouseholdCreditEntries
      WHERE SourcePaymentId = @paymentId AND EntryType = N'OverpaymentRecognized'
    `);
  if (sourceRes.recordset.length === 0) {
    return { reversedApplications: [] };
  }

  const reversedApplications = [];

  for (const source of sourceRes.recordset) {
    // 2. Find every AppliedToInvoice that descends from this source
    const appsRes = await transaction.request()
      .input('relatedEntryId', sql.UniqueIdentifier, source.EntryId)
      .query(`
        SELECT a.EntryId, a.Amount, a.TargetInvoiceId
        FROM oe.HouseholdCreditEntries a
        WHERE a.RelatedEntryId = @relatedEntryId
          AND a.EntryType = N'AppliedToInvoice'
          AND NOT EXISTS (
            SELECT 1 FROM oe.HouseholdCreditEntries r
            WHERE r.RelatedEntryId = a.EntryId AND r.EntryType = N'ReversedApplication'
          )
      `);

    for (const app of appsRes.recordset || []) {
      // app.Amount is negative; reversal amount is the positive magnitude
      const magnitude = Math.abs(Number(app.Amount) || 0);
      if (magnitude < 0.005) continue;

      const newId = crypto.randomUUID();
      await transaction.request()
        .input('entryId', sql.UniqueIdentifier, newId)
        .input('tenantId', sql.UniqueIdentifier, source.TenantId)
        .input('householdId', sql.UniqueIdentifier, source.HouseholdId)
        .input('amount', sql.Decimal(10, 2), magnitude)
        .input('relatedEntryId', sql.UniqueIdentifier, app.EntryId)
        .query(`
          INSERT INTO oe.HouseholdCreditEntries
            (EntryId, TenantId, HouseholdId, EntryType, Amount, RelatedEntryId, Notes, CreatedDate)
          VALUES (@entryId, @tenantId, @householdId, N'ReversedApplication', @amount, @relatedEntryId, N'Reversed by refund of source payment', GETUTCDATE())
        `);

      // Decrement target invoice CreditAmount + recompute Status
      const invRes = await transaction.request()
        .input('invoiceId', sql.UniqueIdentifier, app.TargetInvoiceId)
        .query(`
          SELECT TotalAmount, COALESCE(PaidAmount, 0) AS PaidAmount, COALESCE(CreditAmount, 0) AS CreditAmount, Status
          FROM oe.Invoices WHERE InvoiceId = @invoiceId
        `);
      if (invRes.recordset.length > 0) {
        const inv = invRes.recordset[0];
        const total = Number(inv.TotalAmount) || 0;
        const paid = Number(inv.PaidAmount) || 0;
        const creditOnInvoice = Number(inv.CreditAmount) || 0;
        const newCredit = Math.max(0, creditOnInvoice - magnitude);
        const newStatus = recalcStatusFromAmounts(total, paid, newCredit, inv.Status);
        await transaction.request()
          .input('invoiceId', sql.UniqueIdentifier, app.TargetInvoiceId)
          .input('newCredit', sql.Decimal(12, 2), Math.round(newCredit * 100) / 100)
          .input('status', sql.NVarChar(50), newStatus)
          .query(`
            UPDATE oe.Invoices
            SET CreditAmount = @newCredit,
                Status = @status,
                PaymentReceivedDate = CASE WHEN @status <> N'Paid' THEN NULL ELSE PaymentReceivedDate END,
                ModifiedDate = GETUTCDATE()
            WHERE InvoiceId = @invoiceId
          `);

        reversedApplications.push({
          destinationInvoiceId: app.TargetInvoiceId,
          amountReversed: Math.round(magnitude * 100) / 100
        });
      }
    }
  }

  return { reversedApplications };
}

/**
 * Phase 11 — findOrphanedCreditApplications detector.
 *
 * Looks for AppliedToInvoice entries whose ancestor OverpaymentRecognized came
 * from a payment that was later refunded, but no corresponding
 * ReversedApplication exists. These would indicate a missed reversal — credit
 * was spent on an invoice but the source payment was clawed back.
 */
async function findOrphanedCreditApplications(opts = {}) {
  const tenantId = opts.tenantId && opts.tenantId !== '*' ? String(opts.tenantId) : null;
  const limit = Math.max(1, Math.min(2000, Number(opts.limit) || 200));

  const pool = await getPool();
  const req = pool.request().input('limit', sql.Int, limit);
  if (tenantId) req.input('tenantId', sql.UniqueIdentifier, tenantId);

  const res = await req.query(`
    SELECT TOP (@limit)
      app.EntryId AS AppliedEntryId,
      app.HouseholdId,
      app.TenantId,
      app.Amount AS AppliedAmount,
      app.TargetInvoiceId,
      app.CreatedDate AS AppliedDate,
      src.EntryId AS SourceEntryId,
      src.SourcePaymentId,
      r.PaymentId AS RefundPaymentId,
      r.PaymentDate AS RefundDate
    FROM oe.HouseholdCreditEntries app
    INNER JOIN oe.HouseholdCreditEntries src
      ON app.RelatedEntryId = src.EntryId
     AND src.EntryType = N'OverpaymentRecognized'
    INNER JOIN oe.Payments r
      ON r.OriginalPaymentId = src.SourcePaymentId
     AND r.TransactionType = N'Refund'
    WHERE app.EntryType = N'AppliedToInvoice'
      AND NOT EXISTS (
        SELECT 1 FROM oe.HouseholdCreditEntries rev
        WHERE rev.RelatedEntryId = app.EntryId
          AND rev.EntryType = N'ReversedApplication'
      )
      ${tenantId ? 'AND app.TenantId = @tenantId' : ''}
    ORDER BY app.CreatedDate DESC
  `);

  return { rows: res.recordset || [], count: res.recordset?.length || 0 };
}

module.exports = {
  ENTRY_TYPES,
  getAvailableBalance,
  listHouseholdBalances,
  detectOverpayments,
  applyAvailableCredits,
  simulateApplyAvailableCredits,
  applyForHousehold,
  applyForGroup,
  getGroupAvailableBalance,
  applyEntryToInvoice,
  createManualGoodwill,
  voidEntry,
  reverseEntriesForPayment,
  recalcStatusFromAmounts,
  findOrphanedCreditApplications
};
