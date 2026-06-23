'use strict';

/**
 * Credit-aware invoice PaidAmount transitions inside a transaction (vendored from backend).
 */
const { isSuccessfulPaymentRecordStatus } = require('./payment-status');

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
 * @param {import('mssql').Transaction} transaction
 */
async function unfulfillInvoiceInTxn(transaction, sql, invoiceId, refundAmount) {
  if (!invoiceId) return { applied: false, reason: 'no_invoice_id' };
  const amt = parseFloat(refundAmount) || 0;
  if (amt <= 0) return { applied: false, reason: 'invalid_amount' };

  const inv = await transaction
    .request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .query(
      `SELECT TotalAmount, PaidAmount, CreditAmount, Status FROM oe.Invoices WHERE InvoiceId = @invoiceId`
    );

  if (!inv.recordset.length) return { applied: false, reason: 'invoice_not_found' };

  const total = parseFloat(inv.recordset[0].TotalAmount) || 0;
  const prevPaid = parseFloat(inv.recordset[0].PaidAmount) || 0;
  const credit = parseFloat(inv.recordset[0].CreditAmount) || 0;
  const newPaid = Math.max(0, prevPaid - amt);
  const newStatus = recalcStatusFromAmounts(total, newPaid, credit, inv.recordset[0].Status);

  await transaction
    .request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .input('paidAmount', sql.Decimal(12, 2), newPaid)
    .input('status', sql.NVarChar(50), newStatus)
    .query(`
      UPDATE oe.Invoices
      SET PaidAmount = @paidAmount,
          Status = @status,
          PaymentReceivedDate = CASE WHEN @status <> N'Paid' THEN NULL ELSE PaymentReceivedDate END,
          ModifiedDate = GETUTCDATE()
      WHERE InvoiceId = @invoiceId
    `);

  return { applied: true, newPaidAmount: newPaid, invoiceStatus: newStatus };
}

/**
 * @param {import('mssql').Transaction} transaction
 */
async function syncInvoiceAfterPaymentStatusChangeInTxn(transaction, sql, params) {
  const invoiceId = params.invoiceId;
  const paymentAmount = params.paymentAmount;
  const previousStatus = params.previousStatus;
  const newStatus = params.newStatus;

  if (!invoiceId) {
    return { applied: false, reason: 'no_invoice' };
  }

  const prevOk = isSuccessfulPaymentRecordStatus(String(previousStatus ?? ''));
  const nextOk = isSuccessfulPaymentRecordStatus(String(newStatus ?? ''));

  if (!nextOk) {
    return { applied: false, reason: 'not_success_status' };
  }
  if (prevOk) {
    return { applied: false, reason: 'payment_already_successful' };
  }

  const amt = Number(paymentAmount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return { applied: false, reason: 'invalid_amount' };
  }

  const invRes = await transaction
    .request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .query(`
      SELECT TotalAmount, PaidAmount, Status, COALESCE(CreditAmount, 0) AS CreditAmount
      FROM oe.Invoices
      WHERE InvoiceId = @invoiceId
    `);

  if (!invRes.recordset?.length) {
    return { applied: false, reason: 'invoice_not_found' };
  }

  const inv = invRes.recordset[0];
  const total = parseFloat(inv.TotalAmount) || 0;
  const prevPaid = parseFloat(inv.PaidAmount || 0) || 0;
  const credit = parseFloat(inv.CreditAmount || 0) || 0;
  const newPaid = Math.min(total, prevPaid + amt);
  const newInvStatus = recalcStatusFromAmounts(total, newPaid, credit, inv.Status);

  await transaction
    .request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .input('paidAmount', sql.Decimal(12, 2), newPaid)
    .input('status', sql.NVarChar(50), newInvStatus)
    .query(`
      UPDATE oe.Invoices
      SET PaidAmount = @paidAmount,
          Status = @status,
          PaymentReceivedDate = CASE
            WHEN @status = N'Paid' THEN COALESCE(PaymentReceivedDate, GETUTCDATE())
            ELSE NULL
          END,
          ModifiedDate = GETUTCDATE()
      WHERE InvoiceId = @invoiceId
    `);

  return { applied: true, newPaidAmount: newPaid, invoiceStatus: newInvStatus };
}

async function unfulfillInvoiceForPaymentAmount(pool, sql, invoiceId, paymentAmount) {
  if (!invoiceId) return { applied: false, reason: 'no_invoice_id' };
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();
    const result = await unfulfillInvoiceInTxn(transaction, sql, invoiceId, paymentAmount);
    await transaction.commit();
    return result;
  } catch (err) {
    try {
      await transaction.rollback();
    } catch (_rollbackErr) {
      /* ignore */
    }
    throw err;
  }
}

module.exports = {
  unfulfillInvoiceInTxn,
  unfulfillInvoiceForPaymentAmount,
  syncInvoiceAfterPaymentStatusChangeInTxn,
  recalcStatusFromAmounts
};
