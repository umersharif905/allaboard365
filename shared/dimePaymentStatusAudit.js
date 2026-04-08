'use strict';

/**
 * Same reconciliation logic as backend/services/dimePaymentStatusAudit.service.js.
 * Optional `hoursBack` filters by PaymentDate in the last N hours (for timer jobs); do not combine with startDate/endDate.
 */

const { getPool, sql } = require('./db');
const DimeService = require('./dimeService');
const { syncGroupInvoiceAfterPaymentStatusChange } = require('./groupInvoiceSync');
const { mapDimePayloadToPaymentRecordStatus, isSuccessfulPaymentRecordStatus } = require('./payment-status');

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

/**
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string|null} [params.startDate] YYYY-MM-DD
 * @param {string|null} [params.endDate] YYYY-MM-DD
 * @param {number|null} [params.hoursBack] If set, only payments with PaymentDate in the last N hours (1–168). Mutually exclusive with startDate/endDate.
 * @param {boolean} [params.dryRun]
 * @param {number} [params.limit]
 */
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

  if (hoursBack && (startDate || endDate)) {
    throw new Error('Specify either hoursBack or startDate/endDate, not both');
  }

  const pool = await getPool();
  const request = pool.request();
  request.input('tenantId', sql.UniqueIdentifier, tenantId);
  request.input('limit', sql.Int, limit);
  let dateClause = '';
  if (hoursBack) {
    request.input('hoursBack', sql.Int, hoursBack);
    dateClause = ' AND p.PaymentDate >= DATEADD(HOUR, -@hoursBack, SYSUTCDATETIME())';
  } else {
    if (startDate) {
      request.input('startDate', sql.Date, startDate);
      dateClause += ' AND CAST(p.PaymentDate AS DATE) >= @startDate';
    }
    if (endDate) {
      request.input('endDate', sql.Date, endDate);
      dateClause += ' AND CAST(p.PaymentDate AS DATE) <= @endDate';
    }
  }

  let rows;
  try {
    const result = await request.query(`
      SELECT TOP (@limit)
        p.PaymentId,
        p.InvoiceId,
        p.Status,
        p.PaymentMethod,
        p.Processor,
        p.ProcessorTransactionId,
        p.ProcessorTransactionInfoId,
        p.PaymentDate,
        p.Amount,
        p.GroupId,
        p.HouseholdId,
        g.Name AS GroupName,
        ind.PrimaryMemberName
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
      ORDER BY p.PaymentDate DESC
    `);
    rows = result.recordset || [];
  } catch (e) {
    if ((e.message || '').includes('ProcessorTransactionInfoId') || (e.message || '').includes('Invalid column name')) {
      const r2 = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('limit', sql.Int, limit);
      let dc = '';
      if (hoursBack) {
        r2.input('hoursBack', sql.Int, hoursBack);
        dc = ' AND p.PaymentDate >= DATEADD(HOUR, -@hoursBack, SYSUTCDATETIME())';
      } else {
        if (startDate) {
          r2.input('startDate', sql.Date, startDate);
          dc += ' AND CAST(p.PaymentDate AS DATE) >= @startDate';
        }
        if (endDate) {
          r2.input('endDate', sql.Date, endDate);
          dc += ' AND CAST(p.PaymentDate AS DATE) <= @endDate';
        }
      }
      const result = await r2.query(`
        SELECT TOP (@limit)
          p.PaymentId,
          p.InvoiceId,
          p.Status,
          p.PaymentMethod,
          p.Processor,
          p.ProcessorTransactionId,
          p.PaymentDate,
          p.Amount,
          p.GroupId,
          p.HouseholdId,
          g.Name AS GroupName,
          ind.PrimaryMemberName
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
        ${dc}
        ORDER BY p.PaymentDate DESC
      `);
      rows = (result.recordset || []).map((r) => ({ ...r, ProcessorTransactionInfoId: null }));
    } else {
      throw e;
    }
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
      inSync += 1;
      outRows.push({
        ...base,
        dbCanonical: dbCanon,
        dimeCanonical: dimeCanon,
        dimeTransactionStatus: transactionStatusRaw,
        newStatus: null,
        inSync: true,
        skipped: false,
        error: null
      });
      continue;
    }

    wouldUpdate += 1;
    const newStatus = dimeCanon;

    if (dryRun) {
      const wouldSyncInvoice = !!(
        row.InvoiceId &&
        isSuccessfulPaymentRecordStatus(newStatus) &&
        !isSuccessfulPaymentRecordStatus(row.Status)
      );
      outRows.push({
        ...base,
        dbCanonical: dbCanon,
        dimeCanonical: dimeCanon,
        dimeTransactionStatus: transactionStatusRaw,
        newStatus,
        inSync: false,
        skipped: false,
        error: null,
        wouldSyncInvoice
      });
      continue;
    }

    const upd = await pool
      .request()
      .input('paymentId', sql.UniqueIdentifier, row.PaymentId)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('status', sql.NVarChar(50), newStatus)
      .query(`
        UPDATE oe.Payments
        SET Status = @status, ModifiedDate = GETUTCDATE()
        WHERE PaymentId = @paymentId AND TenantId = @tenantId
      `);

    if (upd.rowsAffected && upd.rowsAffected[0] > 0) {
      updated += 1;
    }

    let invoiceSync = { applied: false, reason: 'skipped' };
    try {
      invoiceSync = await syncGroupInvoiceAfterPaymentStatusChange(pool, sql, {
        invoiceId: row.InvoiceId,
        paymentAmount: row.Amount,
        previousStatus: row.Status,
        newStatus
      });
    } catch (invErr) {
      console.error('dimePaymentStatusAudit invoice sync:', invErr);
      invoiceSync = { applied: false, reason: invErr.message || 'invoice_sync_error' };
    }
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
      invoiceStatus: invoiceSync.invoiceStatus
    });
  }

  return {
    dryRun,
    tenantId,
    startDate,
    endDate,
    hoursBack,
    limit,
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
 * Tenants that have at least one DIME payment row in the lookback window (for scheduling per-tenant audit).
 * @param {number} hoursBack 1–168
 */
async function listTenantIdsForDimeAudit(hoursBack) {
  const hb = Math.min(168, Math.max(1, Number(hoursBack) || 48));
  const pool = await getPool();
  const result = await pool
    .request()
    .input('hoursBack', sql.Int, hb)
    .query(`
      SELECT DISTINCT p.TenantId
      FROM oe.Payments p
      WHERE LOWER(ISNULL(p.Processor, '')) LIKE '%dime%'
        AND p.ProcessorTransactionId IS NOT NULL
        AND LTRIM(RTRIM(CAST(p.ProcessorTransactionId AS NVARCHAR(128)))) <> ''
        AND (p.TransactionType IS NULL OR p.TransactionType = 'Payment')
        AND p.PaymentDate >= DATEADD(HOUR, -@hoursBack, SYSUTCDATETIME())
    `);
  return (result.recordset || []).map((r) => String(r.TenantId));
}

module.exports = { runAudit, listTenantIdsForDimeAudit };
