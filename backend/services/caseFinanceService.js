// services/caseFinanceService.js
//
// Editable Bills + Ledger for back-office Cases. Mirrors the finance methods on
// shareRequestService.js but keyed by CaseId and vendor-scoped, reading/writing
// oe.CaseBills and oe.CaseTransactions.
//
// Differences from the Share Request finance model:
//   - No UA / Share / CPT / Diagnosis columns (a Case is a support ticket, not
//     an unshared-amount claim).
//   - The ledger offers a reduced transaction-type set (no "UA Payment" /
//     "UA Reduction"); the type strings still roll up through the shared
//     services/financeCategory.js so summaries stay consistent.
//
// Every mutation records a diffed audit entry to oe.CaseNotes (NoteType
// 'finance') so edits surface in the Case History tab.

const crypto = require('crypto');
const { getPool, sql } = require('../config/database');
const CaseService = require('./caseService');

// NoteType written to oe.CaseNotes for finance audit rows. Mapped to the
// 'system' timeline category in historyTimelineService.
const FINANCE_NOTE_TYPE = 'finance';

// Ensure the case exists and belongs to the vendor. Throws a 404 (matching the
// caseService convention) otherwise. Returns the case row.
async function assertCaseOwned(vendorId, caseId) {
  const row = await CaseService.getCaseById(vendorId, caseId);
  if (!row) {
    const err = new Error('Case not found');
    err.statusCode = 404;
    throw err;
  }
  return row;
}

async function logFinanceEvent(pool, { caseId, message, userId, userName }) {
  await pool.request()
    .input('caseId', sql.UniqueIdentifier, caseId)
    .input('noteType', sql.NVarChar, FINANCE_NOTE_TYPE)
    .input('note', sql.NVarChar, message)
    .input('createdBy', sql.UniqueIdentifier, userId ?? null)
    .input('createdByName', sql.NVarChar, userName ?? null)
    .query(`
      INSERT INTO oe.CaseNotes (CaseId, NoteType, Note, IsInternal, CreatedBy, CreatedByName)
      VALUES (@caseId, @noteType, @note, 1, @createdBy, @createdByName)
    `);
}

const money = (v) => (v === null || v === undefined || v === '') ? null : Number(v);
const fmtMoney = (v) => v == null ? 'None' : `$${Number(v).toFixed(2)}`;
const fmtText = (v) => (v === null || v === undefined || v === '') ? 'None' : String(v);
const fmtDate = (v) => {
  if (!v) return 'None';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? 'None' : d.toISOString().split('T')[0];
};

class CaseFinanceService {
  // ==========================================================================
  // BILLS
  // ==========================================================================

  static async getBills(vendorId, caseId) {
    await assertCaseOwned(vendorId, caseId);
    const pool = await getPool();
    const result = await pool.request()
      .input('caseId', sql.UniqueIdentifier, caseId)
      .query(`
        SELECT b.*, p.ProviderName, p.NPI
        FROM oe.CaseBills b
        LEFT JOIN oe.Providers p ON b.ProviderId = p.ProviderId
        WHERE b.CaseId = @caseId AND b.IsActive = 1
        ORDER BY b.BillDate DESC, b.CreatedDate DESC
      `);
    return result.recordset;
  }

  static async createBill(vendorId, caseId, data, actor = {}) {
    await assertCaseOwned(vendorId, caseId);
    const pool = await getPool();
    const billId = crypto.randomUUID();

    await pool.request()
      .input('billId', sql.UniqueIdentifier, billId)
      .input('caseId', sql.UniqueIdentifier, caseId)
      .input('vendorId', sql.UniqueIdentifier, vendorId)
      .input('providerId', sql.UniqueIdentifier, data.providerId || null)
      .input('billNumber', sql.NVarChar, data.billNumber || null)
      .input('billType', sql.NVarChar, data.billType || 'Bill')
      .input('billDate', sql.Date, data.billDate ? new Date(data.billDate) : null)
      .input('dateOfService', sql.Date, data.dateOfService ? new Date(data.dateOfService) : null)
      .input('description', sql.NVarChar, data.description || null)
      .input('billedAmount', sql.Decimal(18, 2), data.billedAmount || 0)
      .input('allowedAmount', sql.Decimal(18, 2), data.allowedAmount || null)
      .input('paidAmount', sql.Decimal(18, 2), data.paidAmount || 0)
      .input('balance', sql.Decimal(18, 2), data.balance != null ? data.balance : (data.billedAmount || 0))
      .input('notes', sql.NVarChar, data.notes || null)
      .input('createdBy', sql.UniqueIdentifier, actor.userId || null)
      .query(`
        INSERT INTO oe.CaseBills (
          BillId, CaseId, VendorId, ProviderId, BillNumber, BillType, BillDate, DateOfService,
          Description, BilledAmount, AllowedAmount, PaidAmount, Balance, Notes,
          IsActive, CreatedDate, CreatedBy
        ) VALUES (
          @billId, @caseId, @vendorId, @providerId, @billNumber, @billType, @billDate, @dateOfService,
          @description, @billedAmount, @allowedAmount, @paidAmount, @balance, @notes,
          1, GETDATE(), @createdBy
        )
      `);

    const amount = data.billedAmount ? `$${parseFloat(data.billedAmount).toFixed(2)}` : '$0.00';
    const billInfo = data.billNumber ? `#${data.billNumber}` : '';
    await logFinanceEvent(pool, {
      caseId,
      message: `Bill added: ${data.billType || 'Bill'} ${billInfo} for ${amount}${data.description ? ` - ${data.description}` : ''}`.replace(/\s+/g, ' ').trim(),
      userId: actor.userId,
      userName: actor.userName,
    });

    return { billId };
  }

  static async updateBill(vendorId, billId, data, actor = {}) {
    const pool = await getPool();

    // Current row, vendor-scoped — gives us the CaseId for the audit row and the
    // change diff, and enforces tenant isolation.
    const currentResult = await pool.request()
      .input('billId', sql.UniqueIdentifier, billId)
      .input('vendorId', sql.UniqueIdentifier, vendorId)
      .query('SELECT * FROM oe.CaseBills WHERE BillId = @billId AND VendorId = @vendorId');
    const current = currentResult.recordset[0];
    if (!current) {
      return { success: false, message: 'Bill not found' };
    }
    const caseId = current.CaseId;

    const request = pool.request();
    request.input('billId', sql.UniqueIdentifier, billId);
    request.input('modifiedBy', sql.UniqueIdentifier, actor.userId || null);

    const updateFields = [];
    const changes = [];

    // [dataKey, column, sqlType, label, formatter, parser]
    const FIELDS = [
      ['providerId', 'ProviderId', sql.UniqueIdentifier, 'Provider', null, (v) => v || null],
      ['billNumber', 'BillNumber', sql.NVarChar, 'Bill #', fmtText, (v) => v || null],
      ['billType', 'BillType', sql.NVarChar, 'Type', fmtText, (v) => v],
      ['billDate', 'BillDate', sql.Date, 'Bill date', fmtDate, (v) => v ? new Date(v) : null],
      ['dateOfService', 'DateOfService', sql.Date, 'Date of service', fmtDate, (v) => v ? new Date(v) : null],
      ['description', 'Description', sql.NVarChar, 'Description', fmtText, (v) => v || null],
      ['billedAmount', 'BilledAmount', sql.Decimal(18, 2), 'Billed', fmtMoney, money],
      ['allowedAmount', 'AllowedAmount', sql.Decimal(18, 2), 'Allowed', fmtMoney, money],
      ['paidAmount', 'PaidAmount', sql.Decimal(18, 2), 'Paid', fmtMoney, money],
      ['balance', 'Balance', sql.Decimal(18, 2), 'Balance', fmtMoney, money],
      ['notes', 'Notes', sql.NVarChar, 'Notes', fmtText, (v) => v || null],
    ];

    for (const [key, col, type, label, fmt, parse] of FIELDS) {
      if (data[key] === undefined) continue;
      const nextVal = parse ? parse(data[key]) : data[key];
      updateFields.push(`${col} = @${key}`);
      request.input(key, type, nextVal);
      if (fmt) {
        const from = fmt(current[col]);
        const to = fmt(nextVal);
        if (from !== to) changes.push({ field: label, from, to });
      } else if (String(current[col] || '') !== String(nextVal || '')) {
        changes.push({ field: label, from: 'changed', to: 'updated' });
      }
    }

    if (updateFields.length === 0) {
      return { success: false, message: 'No fields to update' };
    }

    updateFields.push('ModifiedDate = GETDATE()');
    updateFields.push('ModifiedBy = @modifiedBy');

    await request.query(`
      UPDATE oe.CaseBills
      SET ${updateFields.join(', ')}
      WHERE BillId = @billId
    `);

    const billRef = current.BillNumber ? `#${current.BillNumber}` : `${current.BillType || 'Bill'}`;
    const summary = changes.length > 0
      ? changes.map(c => `${c.field}: "${c.from}" → "${c.to}"`).join('; ')
      : 'no field changes';
    await logFinanceEvent(pool, {
      caseId,
      message: `Bill ${billRef} updated: ${summary}`,
      userId: actor.userId,
      userName: actor.userName,
    });

    return { success: true };
  }

  static async deleteBill(vendorId, caseId, billId, actor = {}) {
    const pool = await getPool();

    const billResult = await pool.request()
      .input('billId', sql.UniqueIdentifier, billId)
      .input('vendorId', sql.UniqueIdentifier, vendorId)
      .query('SELECT BillNumber, BillType, BilledAmount FROM oe.CaseBills WHERE BillId = @billId AND VendorId = @vendorId');
    const bill = billResult.recordset[0];
    if (!bill) {
      return { success: false, message: 'Bill not found' };
    }

    await pool.request()
      .input('billId', sql.UniqueIdentifier, billId)
      .input('vendorId', sql.UniqueIdentifier, vendorId)
      .input('modifiedBy', sql.UniqueIdentifier, actor.userId || null)
      .query(`
        UPDATE oe.CaseBills
        SET IsActive = 0, ModifiedDate = GETDATE(), ModifiedBy = @modifiedBy
        WHERE BillId = @billId AND VendorId = @vendorId
      `);

    const amount = bill.BilledAmount ? `$${parseFloat(bill.BilledAmount).toFixed(2)}` : '';
    await logFinanceEvent(pool, {
      caseId,
      message: `Bill deleted: ${bill.BillType || 'Bill'} ${bill.BillNumber ? '#' + bill.BillNumber : ''} ${amount}`.replace(/\s+/g, ' ').trim(),
      userId: actor.userId,
      userName: actor.userName,
    });

    return { success: true };
  }

  // ==========================================================================
  // TRANSACTIONS
  // ==========================================================================

  static async getTransactions(vendorId, caseId) {
    await assertCaseOwned(vendorId, caseId);
    const pool = await getPool();
    const result = await pool.request()
      .input('caseId', sql.UniqueIdentifier, caseId)
      .query(`
        SELECT t.*, b.BillNumber, p.ProviderName
        FROM oe.CaseTransactions t
        LEFT JOIN oe.CaseBills b ON t.BillId = b.BillId
        LEFT JOIN oe.Providers p ON t.ProviderId = p.ProviderId
        WHERE t.CaseId = @caseId
        ORDER BY t.TransactionDate DESC, t.CreatedDate DESC
      `);
    return result.recordset;
  }

  static async createTransaction(vendorId, caseId, data, actor = {}) {
    await assertCaseOwned(vendorId, caseId);
    const pool = await getPool();
    const transactionId = crypto.randomUUID();

    await pool.request()
      .input('transactionId', sql.UniqueIdentifier, transactionId)
      .input('caseId', sql.UniqueIdentifier, caseId)
      .input('vendorId', sql.UniqueIdentifier, vendorId)
      .input('billId', sql.UniqueIdentifier, data.billId || null)
      .input('providerId', sql.UniqueIdentifier, data.providerId || null)
      .input('transactionType', sql.NVarChar, data.transactionType)
      .input('paymentType', sql.NVarChar, data.paymentType || null)
      .input('transactionStatus', sql.NVarChar, data.transactionStatus || 'Pending')
      .input('amount', sql.Decimal(18, 2), data.amount || 0)
      .input('transactionDate', sql.Date, data.transactionDate ? new Date(data.transactionDate) : new Date())
      .input('referenceNumber', sql.NVarChar, data.referenceNumber || null)
      .input('description', sql.NVarChar, data.description || null)
      .input('notes', sql.NVarChar, data.notes || null)
      .input('createdBy', sql.UniqueIdentifier, actor.userId || null)
      .query(`
        INSERT INTO oe.CaseTransactions (
          TransactionId, CaseId, VendorId, BillId, ProviderId,
          TransactionType, PaymentType, TransactionStatus, Amount,
          TransactionDate, ReferenceNumber, Description, Notes,
          CreatedDate, CreatedBy
        ) VALUES (
          @transactionId, @caseId, @vendorId, @billId, @providerId,
          @transactionType, @paymentType, @transactionStatus, @amount,
          @transactionDate, @referenceNumber, @description, @notes,
          GETDATE(), @createdBy
        )
      `);

    const amount = data.amount ? `$${parseFloat(data.amount).toFixed(2)}` : '$0.00';
    const ref = data.referenceNumber ? ` (Ref: ${data.referenceNumber})` : '';
    await logFinanceEvent(pool, {
      caseId,
      message: `Transaction added: ${data.transactionType} - ${amount}${ref} [${data.transactionStatus || 'Pending'}]`,
      userId: actor.userId,
      userName: actor.userName,
    });

    return { transactionId };
  }

  static async updateTransaction(vendorId, transactionId, data, actor = {}) {
    const pool = await getPool();

    const currentResult = await pool.request()
      .input('transactionId', sql.UniqueIdentifier, transactionId)
      .input('vendorId', sql.UniqueIdentifier, vendorId)
      .query('SELECT * FROM oe.CaseTransactions WHERE TransactionId = @transactionId AND VendorId = @vendorId');
    const current = currentResult.recordset[0];
    if (!current) {
      return { success: false, message: 'Transaction not found' };
    }
    const caseId = current.CaseId;

    const request = pool.request();
    request.input('transactionId', sql.UniqueIdentifier, transactionId);
    request.input('modifiedBy', sql.UniqueIdentifier, actor.userId || null);

    const updateFields = [];
    const changes = [];

    const FIELDS = [
      ['billId', 'BillId', sql.UniqueIdentifier, 'Bill', null, (v) => v || null],
      ['transactionType', 'TransactionType', sql.NVarChar, 'Type', fmtText, (v) => v],
      ['paymentType', 'PaymentType', sql.NVarChar, 'Payment method', fmtText, (v) => v || null],
      ['transactionStatus', 'TransactionStatus', sql.NVarChar, 'Status', fmtText, (v) => v],
      ['amount', 'Amount', sql.Decimal(18, 2), 'Amount', fmtMoney, money],
      ['transactionDate', 'TransactionDate', sql.Date, 'Date', fmtDate, (v) => v ? new Date(v) : null],
      ['referenceNumber', 'ReferenceNumber', sql.NVarChar, 'Reference', fmtText, (v) => v || null],
      ['description', 'Description', sql.NVarChar, 'Description', fmtText, (v) => v || null],
      ['notes', 'Notes', sql.NVarChar, 'Notes', fmtText, (v) => v || null],
    ];

    for (const [key, col, type, label, fmt, parse] of FIELDS) {
      if (data[key] === undefined) continue;
      const nextVal = parse ? parse(data[key]) : data[key];
      updateFields.push(`${col} = @${key}`);
      request.input(key, type, nextVal);
      if (fmt) {
        const from = fmt(current[col]);
        const to = fmt(nextVal);
        if (from !== to) changes.push({ field: label, from, to });
      } else if (String(current[col] || '') !== String(nextVal || '')) {
        changes.push({ field: label, from: 'changed', to: 'updated' });
      }
    }

    if (updateFields.length === 0) {
      return { success: false, message: 'No fields to update' };
    }

    updateFields.push('ModifiedDate = GETDATE()');
    updateFields.push('ModifiedBy = @modifiedBy');

    await request.query(`
      UPDATE oe.CaseTransactions
      SET ${updateFields.join(', ')}
      WHERE TransactionId = @transactionId
    `);

    const summary = changes.length > 0
      ? changes.map(c => `${c.field}: "${c.from}" → "${c.to}"`).join('; ')
      : 'no field changes';
    await logFinanceEvent(pool, {
      caseId,
      message: `Transaction (${current.TransactionType}) updated: ${summary}`,
      userId: actor.userId,
      userName: actor.userName,
    });

    return { success: true };
  }

  static async deleteTransaction(vendorId, caseId, transactionId, actor = {}) {
    const pool = await getPool();

    const txnResult = await pool.request()
      .input('transactionId', sql.UniqueIdentifier, transactionId)
      .input('vendorId', sql.UniqueIdentifier, vendorId)
      .query('SELECT TransactionType, Amount, ReferenceNumber FROM oe.CaseTransactions WHERE TransactionId = @transactionId AND VendorId = @vendorId');
    const txn = txnResult.recordset[0];
    if (!txn) {
      return { success: false, message: 'Transaction not found' };
    }

    await pool.request()
      .input('transactionId', sql.UniqueIdentifier, transactionId)
      .input('vendorId', sql.UniqueIdentifier, vendorId)
      .query('DELETE FROM oe.CaseTransactions WHERE TransactionId = @transactionId AND VendorId = @vendorId');

    const amount = txn.Amount ? `$${parseFloat(txn.Amount).toFixed(2)}` : '';
    const ref = txn.ReferenceNumber ? ` (Ref: ${txn.ReferenceNumber})` : '';
    await logFinanceEvent(pool, {
      caseId,
      message: `Transaction deleted: ${txn.TransactionType} - ${amount}${ref}`,
      userId: actor.userId,
      userName: actor.userName,
    });

    return { success: true };
  }
}

module.exports = CaseFinanceService;
