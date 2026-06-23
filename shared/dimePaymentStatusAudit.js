'use strict';

/**
 * Same reconciliation logic as backend/services/dimePaymentStatusAudit.service.js (Azure Functions).
 * Optional `hoursBack` filters by PaymentDate in the last N hours (for timer jobs); do not combine with startDate/endDate.
 */

const { getPool, sql } = require('./db');
const DimeService = require('./dimeService');
const {
  getPaymentStatusInvoiceAdjustmentPlan,
  applyPaymentStatusInvoiceAdjustmentInTxn
} = require('./paymentAdminPatch');
const {
  mapDimePayloadToPaymentRecordStatus,
  isSuccessfulPaymentRecordStatus,
  sqlSuccessfulPaymentOrderKeyExpr,
  sqlSuccessfulPaymentPredicate
} = require('./payment-status');

function canonicalDbPaymentStatus(status) {
  const s = String(status || '').trim();
  if (isSuccessfulPaymentRecordStatus(s)) return 'Completed';
  if (/^failed$/i.test(s)) return 'Failed';
  if (/^pending$/i.test(s)) return 'Pending';
  if (/^refunded$/i.test(s)) return 'Refunded';
  if (/^voided$/i.test(s)) return 'Voided';
  if (/^returned$/i.test(s)) return 'Returned';
  return s;
}

function shouldSkipBecauseDbTerminal(canonical) {
  return canonical === 'Refunded' || canonical === 'Voided';
}

/** SET clause when reconciling oe.Payments.Status from DIME audit. */
function auditPaymentStatusUpdateSetClause(newStatus) {
  if (isSuccessfulPaymentRecordStatus(newStatus)) {
    return 'Status = @status, FailureReason = NULL, ModifiedDate = GETUTCDATE()';
  }
  return 'Status = @status, ModifiedDate = GETUTCDATE()';
}

function isStaleAchSettlementFailureReason(reason) {
  const r = String(reason || '').trim().toLowerCase();
  return r.includes('ach_payment_credit_pending') || (r.includes('ach_payment') && r.includes('pending'));
}

function paymentRowForInvoicePlan(row) {
  return {
    InvoiceId: row.InvoiceId,
    TransactionType: row.TransactionType,
    OriginalPaymentId: row.OriginalPaymentId,
    Amount: row.Amount,
    Status: row.Status
  };
}

function mergeRowsByPaymentId(primary, secondary) {
  const seen = new Set();
  const out = [];
  for (const r of primary) {
    const id = String(r.PaymentId);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(r);
  }
  for (const r of secondary) {
    const id = String(r.PaymentId);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(r);
  }
  return out;
}

async function loadCandidateRows(pool, opts) {
  const {
    tenantId,
    limit,
    hoursBack,
    startDate,
    endDate,
    extraWhere,
    prioritizeSuccessfulFirst,
    extraSqlInputs = {}
  } = opts;

  let dateClause = '';
  const orderClause = prioritizeSuccessfulFirst
    ? `ORDER BY ${sqlSuccessfulPaymentOrderKeyExpr('p.Status')}, p.PaymentDate DESC`
    : `ORDER BY p.PaymentDate DESC`;

  async function runWithColumns(includeProcessorTransactionInfoId, includeOriginalPaymentId) {
    const req = pool.request();
    req.input('tenantId', sql.UniqueIdentifier, tenantId);
    req.input('limit', sql.Int, limit);
    if (hoursBack) {
      req.input('hoursBack', sql.Int, hoursBack);
      dateClause = ' AND p.PaymentDate >= DATEADD(HOUR, -@hoursBack, SYSUTCDATETIME())';
    } else {
      dateClause = '';
      if (startDate) {
        req.input('startDate', sql.Date, startDate);
        dateClause += ' AND CAST(p.PaymentDate AS DATE) >= @startDate';
      }
      if (endDate) {
        req.input('endDate', sql.Date, endDate);
        dateClause += ' AND CAST(p.PaymentDate AS DATE) <= @endDate';
      }
    }
    if (extraSqlInputs.successRecheckDays != null) {
      req.input('successRecheckDays', sql.Int, extraSqlInputs.successRecheckDays);
    }
    if (extraSqlInputs.pendingLookbackDays != null) {
      req.input('pendingLookbackDays', sql.Int, extraSqlInputs.pendingLookbackDays);
    }
    // Upper bound (older-than) for secondary sweeps; passed explicitly because
    // those passes run with hoursBack=null so the auto ">= -hoursBack" lower bound
    // is not applied (otherwise the window self-contradicts and sweeps nothing).
    if (extraSqlInputs.windowUpperHours != null) {
      req.input('windowUpperHours', sql.Int, extraSqlInputs.windowUpperHours);
    }

    const cols = [
      'p.PaymentId',
      'p.InvoiceId',
      'p.Status',
      'p.PaymentMethod',
      'p.Processor',
      'p.ProcessorTransactionId',
      'p.FailureReason'
    ];
    if (includeProcessorTransactionInfoId) {
      cols.push('p.ProcessorTransactionInfoId');
    }
    cols.push('p.PaymentDate', 'p.Amount', 'p.GroupId', 'p.HouseholdId', 'p.TransactionType');
    if (includeOriginalPaymentId) {
      cols.push('p.OriginalPaymentId');
    }
    cols.push('g.Name AS GroupName', 'ind.PrimaryMemberName');
    const selectList = cols.join(',\n        ');

    const q = `
      SELECT TOP (@limit)
        ${selectList}
      FROM oe.Payments p
      LEFT JOIN oe.Groups g ON p.GroupId = g.GroupId
      OUTER APPLY (
        SELECT TOP 1
          LTRIM(RTRIM(CONCAT(ISNULL(u.FirstName, N''), N' ', ISNULL(u.LastName, N'')))) AS PrimaryMemberName
        FROM oe.Members m
        INNER JOIN oe.Users u ON m.UserId = u.UserId
        WHERE m.HouseholdId = p.HouseholdId AND m.RelationshipType = N'P'
        ORDER BY m.CreatedDate
      ) ind
      WHERE p.TenantId = @tenantId
        AND LOWER(ISNULL(p.Processor, '')) LIKE '%dime%'
        AND p.ProcessorTransactionId IS NOT NULL
        AND LTRIM(RTRIM(CAST(p.ProcessorTransactionId AS NVARCHAR(128)))) <> ''
        AND (p.TransactionType IS NULL OR p.TransactionType = 'Payment')
      ${dateClause}
      ${extraWhere}
      ${orderClause}
    `;

    const result = await req.query(q);
    let rows = result.recordset || [];
    if (!includeProcessorTransactionInfoId) {
      rows = rows.map((r) => ({ ...r, ProcessorTransactionInfoId: null }));
    }
    if (!includeOriginalPaymentId) {
      rows = rows.map((r) => ({ ...r, OriginalPaymentId: null }));
    }
    return rows;
  }

  try {
    const rows = await runWithColumns(true, true);
    return { rows, usedFallbackNoInfoId: false, usedFallbackNoOriginal: false };
  } catch (e) {
    const msg = e.message || '';
    if (msg.includes('ProcessorTransactionInfoId') || msg.includes('OriginalPaymentId') || msg.includes('Invalid column name')) {
      try {
        const rows = await runWithColumns(true, false);
        return { rows, usedFallbackNoInfoId: false, usedFallbackNoOriginal: true };
      } catch (e2) {
        const rows = await runWithColumns(false, false);
        return { rows, usedFallbackNoInfoId: true, usedFallbackNoOriginal: true };
      }
    }
    throw e;
  }
}

async function runAudit(params) {
  const tenantId = params.tenantId;
  const dryRun = params.dryRun !== false;
  const limit = Math.min(1000, Math.max(1, Number(params.limit) || 500));
  const startDate = params.startDate || null;
  const endDate = params.endDate || null;
  const hoursBack =
    params.hoursBack != null && params.hoursBack !== ''
      ? Math.min(168, Math.max(1, Number(params.hoursBack)))
      : null;

  const prioritizeSuccessfulFirst = params.prioritizeSuccessfulFirst !== false;
  const successRecheckDays = Math.min(366, Math.max(0, Number(params.successRecheckDays) || 0));
  const secondaryLimit = Math.min(1000, Math.max(0, Number(params.secondaryLimit) || 0));
  const pendingLookbackDays =
    params.pendingLookbackDays != null && params.pendingLookbackDays !== ''
      ? Math.min(366, Math.max(0, Number(params.pendingLookbackDays)))
      : 14;
  const pendingSecondaryLimit =
    params.pendingSecondaryLimit != null && params.pendingSecondaryLimit !== ''
      ? Math.min(1000, Math.max(0, Number(params.pendingSecondaryLimit)))
      : 200;

  if (hoursBack && (startDate || endDate)) {
    throw new Error('Specify either hoursBack or startDate/endDate, not both');
  }

  const pool = await getPool();

  const loadOptsBase = {
    tenantId,
    hoursBack,
    startDate,
    endDate,
    prioritizeSuccessfulFirst: prioritizeSuccessfulFirst
  };

  const { rows: passARows } = await loadCandidateRows(pool, {
    ...loadOptsBase,
    limit,
    extraWhere: ''
  });

  let rows = passARows;
  let passBRows = [];

  if (hoursBack && successRecheckDays > 0 && secondaryLimit > 0) {
    const successPred = sqlSuccessfulPaymentPredicate('p.Status');
    const extraB = ` AND ${successPred} AND p.PaymentDate < DATEADD(HOUR, -@windowUpperHours, SYSUTCDATETIME()) AND p.PaymentDate >= DATEADD(DAY, -@successRecheckDays, SYSUTCDATETIME())`;
    const { rows: bRows } = await loadCandidateRows(pool, {
      ...loadOptsBase,
      hoursBack: null,
      startDate: null,
      endDate: null,
      limit: secondaryLimit,
      extraWhere: extraB,
      prioritizeSuccessfulFirst: false,
      extraSqlInputs: { successRecheckDays, windowUpperHours: hoursBack }
    });
    passBRows = bRows;
    rows = mergeRowsByPaymentId(passARows, passBRows);
  }

  let passCRows = [];
  if (hoursBack && pendingLookbackDays > 0 && pendingSecondaryLimit > 0) {
    const extraC = ` AND LOWER(LTRIM(RTRIM(p.Status))) = N'pending'
      AND p.PaymentDate < DATEADD(HOUR, -@windowUpperHours, SYSUTCDATETIME())
      AND p.PaymentDate >= DATEADD(DAY, -@pendingLookbackDays, SYSUTCDATETIME())`;
    const { rows: cRows } = await loadCandidateRows(pool, {
      ...loadOptsBase,
      hoursBack: null,
      startDate: null,
      endDate: null,
      limit: pendingSecondaryLimit,
      extraWhere: extraC,
      prioritizeSuccessfulFirst: false,
      extraSqlInputs: { pendingLookbackDays, windowUpperHours: hoursBack }
    });
    passCRows = cRows;
    rows = mergeRowsByPaymentId(rows, passCRows);
  }

  const outRows = [];
  let examined = 0;
  let inSync = 0;
  let skipped = 0;
  let errors = 0;
  let wouldUpdate = 0;
  let updated = 0;
  let invoicesSynced = 0;

  for (const row of rows) {
    examined += 1;
    const processorTx = String(row.ProcessorTransactionId).trim();
    const infoId =
      row.ProcessorTransactionInfoId != null && String(row.ProcessorTransactionInfoId).trim() !== ''
        ? String(row.ProcessorTransactionInfoId).trim()
        : null;

    const groupName = row.GroupName != null && String(row.GroupName).trim() !== '' ? String(row.GroupName).trim() : null;
    const primaryMemberName =
      row.PrimaryMemberName != null && String(row.PrimaryMemberName).trim() !== ''
        ? String(row.PrimaryMemberName).trim()
        : null;
    const payerLabel =
      groupName || (primaryMemberName ? `Individual: ${primaryMemberName}` : null);

    const base = {
      paymentId: String(row.PaymentId),
      amount: Number(row.Amount) || 0,
      paymentDate: row.PaymentDate,
      currentStatus: row.Status,
      processorTransactionId: processorTx,
      paymentMethod: row.PaymentMethod,
      groupName,
      primaryMemberName,
      payerLabel
    };

    const dbCanon = canonicalDbPaymentStatus(row.Status);
    if (shouldSkipBecauseDbTerminal(dbCanon)) {
      skipped += 1;
      outRows.push({
        ...base,
        dbCanonical: dbCanon,
        dimeCanonical: null,
        newStatus: null,
        inSync: true,
        skipped: true,
        skipReason: 'db_refunded_or_voided',
        error: null
      });
      continue;
    }

    const dimeResult = await DimeService.getTransactionForAudit(
      tenantId,
      processorTx,
      row.PaymentMethod,
      infoId
    );

    if (!dimeResult.success) {
      errors += 1;
      const errMsg = dimeResult.error?.message || 'DIME lookup failed';
      const hint =
        errMsg.includes('No transaction found') && String(row.PaymentMethod || '').toLowerCase().includes('recurring')
          ? ' (tried ACH+CC; Recurring rows often need ACH.)'
          : '';
      outRows.push({
        ...base,
        dbCanonical: dbCanon,
        dimeCanonical: null,
        newStatus: null,
        inSync: false,
        skipped: false,
        error: `${errMsg}${hint}`,
        dimeError: dimeResult.error || null,
        dimeLookupSource: dimeResult.source || null,
        dimeLookupAttemptedTypes: dimeResult.attemptedTypes || null
      });
      continue;
    }

    const dimeData = dimeResult.data;
    const dimeCanon = mapDimePayloadToPaymentRecordStatus(dimeData || {});
    const transactionStatusRaw =
      dimeData && (dimeData.transaction_status != null ? String(dimeData.transaction_status) : '');

    if (dimeCanon === 'Unknown') {
      skipped += 1;
      outRows.push({
        ...base,
        dbCanonical: dbCanon,
        dimeCanonical: dimeCanon,
        dimeTransactionStatus: transactionStatusRaw,
        newStatus: null,
        inSync: false,
        skipped: true,
        skipReason: 'dime_status_unknown',
        error: null
      });
      continue;
    }

    const mismatch = dbCanon !== dimeCanon;
    if (!mismatch) {
      const staleFailure =
        dbCanon === 'Completed' && isStaleAchSettlementFailureReason(row.FailureReason);
      if (staleFailure && !dryRun) {
        try {
          await pool
            .request()
            .input('paymentId', sql.UniqueIdentifier, row.PaymentId)
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .query(`
              UPDATE oe.Payments
              SET FailureReason = NULL, ModifiedDate = GETUTCDATE()
              WHERE PaymentId = @paymentId AND TenantId = @tenantId
            `);
          updated += 1;
        } catch (clearErr) {
          errors += 1;
          outRows.push({
            ...base,
            dbCanonical: dbCanon,
            dimeCanonical: dimeCanon,
            error: clearErr.message || String(clearErr),
            inSync: false,
            skipped: false
          });
          continue;
        }
      }
      inSync += 1;
      outRows.push({
        ...base,
        dbCanonical: dbCanon,
        dimeCanonical: dimeCanon,
        dimeTransactionStatus: transactionStatusRaw,
        newStatus: staleFailure ? 'Completed' : null,
        inSync: true,
        skipped: false,
        error: null,
        applied: staleFailure && !dryRun,
        clearedStaleFailureReason: staleFailure
      });
      continue;
    }

    wouldUpdate += 1;
    const newStatus = dimeCanon;
    const paymentRow = paymentRowForInvoicePlan(row);
    const paymentIdStr = String(row.PaymentId);

    if (dryRun) {
      const plan = await getPaymentStatusInvoiceAdjustmentPlan(
        pool,
        sql,
        paymentIdStr,
        paymentRow,
        newStatus,
        true
      );
      const wouldSyncInvoice = plan.kind === 'sync';
      const wouldUnfulfillInvoice = plan.kind === 'unfulfill';
      outRows.push({
        ...base,
        dbCanonical: dbCanon,
        dimeCanonical: dimeCanon,
        dimeTransactionStatus: transactionStatusRaw,
        newStatus,
        inSync: false,
        skipped: false,
        error: null,
        wouldSyncInvoice,
        wouldUnfulfillInvoice,
        invoiceAdjustmentKind: plan.kind,
        invoicePlanReason: plan.invoiceSync?.reason,
        invoicePlanWarnings: plan.invoiceSync?.warnings
      });
      continue;
    }

    const plan = await getPaymentStatusInvoiceAdjustmentPlan(
      pool,
      sql,
      paymentIdStr,
      paymentRow,
      newStatus,
      true
    );

    const transaction = new sql.Transaction(pool);
    let invoiceSync = { applied: false, reason: plan.invoiceSync?.reason || 'skipped' };
    try {
      await transaction.begin();

      const upd = await transaction
        .request()
        .input('paymentId', sql.UniqueIdentifier, row.PaymentId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('status', sql.NVarChar(50), newStatus)
        .query(`
          UPDATE oe.Payments
          SET ${auditPaymentStatusUpdateSetClause(newStatus)}
          WHERE PaymentId = @paymentId AND TenantId = @tenantId
        `);

      const affected = upd.rowsAffected && upd.rowsAffected[0] > 0;
      if (!affected) {
        await transaction.rollback();
        outRows.push({
          ...base,
          dbCanonical: dbCanon,
          dimeCanonical: dimeCanon,
          dimeTransactionStatus: transactionStatusRaw,
          newStatus,
          inSync: false,
          skipped: false,
          error: 'payment_update_no_rows',
          applied: false
        });
        continue;
      }

      if (plan.kind) {
        invoiceSync = await applyPaymentStatusInvoiceAdjustmentInTxn(
          transaction,
          sql,
          plan.kind,
          paymentRow,
          newStatus
        );
      }

      await transaction.commit();
      updated += 1;

      if (invoiceSync.applied) {
        invoicesSynced += 1;
      }

      outRows.push({
        ...base,
        dbCanonical: dbCanon,
        dimeCanonical: dimeCanon,
        dimeTransactionStatus: transactionStatusRaw,
        newStatus,
        currentStatus: newStatus,
        inSync: true,
        skipped: false,
        error: null,
        applied: true,
        invoiceSynced: invoiceSync.applied,
        invoiceSyncReason: invoiceSync.reason,
        invoiceNewPaidAmount: invoiceSync.newPaidAmount,
        invoiceStatus: invoiceSync.invoiceStatus,
        invoiceAdjustmentKind: plan.kind,
        invoicePlanWarnings: plan.invoiceSync?.warnings
      });
    } catch (txnErr) {
      try {
        await transaction.rollback();
      } catch (_rbErr) {
        /* ignore */
      }
      console.error('dimePaymentStatusAudit transaction:', txnErr);
      errors += 1;
      outRows.push({
        ...base,
        dbCanonical: dbCanon,
        dimeCanonical: dimeCanon,
        dimeTransactionStatus: transactionStatusRaw,
        newStatus,
        inSync: false,
        skipped: false,
        error: txnErr.message || String(txnErr),
        applied: false
      });
    }
  }

  return {
    dryRun,
    tenantId,
    startDate,
    endDate,
    hoursBack,
    limit,
    successRecheckDays,
    secondaryLimit,
    prioritizeSuccessfulFirst,
    passAPrimaryCount: passARows.length,
    passBCount: passBRows.length,
    passCCount: passCRows.length,
    pendingLookbackDays,
    pendingSecondaryLimit,
    examined,
    inSync,
    skipped,
    errors,
    wouldUpdate,
    updated,
    invoicesSynced,
    rows: outRows
  };
}

/**
 * Tenants with auditable DIME payment rows in the lookback window — used by
 * DimePaymentStatusAuditTimer to decide which tenants to reconcile.
 * @param {number} hoursBack
 * @returns {Promise<string[]>}
 */
async function listTenantIdsForDimeAudit(hoursBack) {
  const hours = Math.min(168, Math.max(1, Number(hoursBack) || 168));
  const pool = await getPool();
  const result = await pool.request()
    .input('hoursBack', sql.Int, hours)
    .query(`
      SELECT DISTINCT CAST(p.TenantId AS NVARCHAR(36)) AS TenantId
      FROM oe.Payments p
      WHERE p.TenantId IS NOT NULL
        AND LOWER(ISNULL(p.Processor, '')) LIKE '%dime%'
        AND p.ProcessorTransactionId IS NOT NULL
        AND (p.TransactionType IS NULL OR p.TransactionType = 'Payment')
        AND p.PaymentDate >= DATEADD(HOUR, -@hoursBack, SYSUTCDATETIME())
    `);
  return (result.recordset || []).map((r) => String(r.TenantId));
}

module.exports = { runAudit, loadCandidateRows, mergeRowsByPaymentId, listTenantIdsForDimeAudit };