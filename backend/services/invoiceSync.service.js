'use strict';

const { requireShared } = require('../config/shared-modules');
const { isSuccessfulPaymentRecordStatus } = requireShared('payment-status');
const { recalcStatusFromAmounts } = require('./householdCredits.service');

/**
 * When a payment row transitions from a non-success status to a successful one,
 * add this payment's amount to oe.Invoices.PaidAmount (capped at TotalAmount) and set Status
 * from paid + credits vs Total (matches fulfillInvoice credit-aware rules).
 * Works for both group and individual invoices.
 *
 * @param {import('mssql').ConnectionPool} pool
 * @param {typeof import('mssql')} sql
 * @param {{ invoiceId: string|null|undefined; paymentAmount: unknown; previousStatus: unknown; newStatus: unknown }} params
 * @returns {Promise<{ applied: boolean; reason?: string; newPaidAmount?: number; invoiceStatus?: string }>}
 */
async function syncInvoiceAfterPaymentStatusChange(pool, sql, params) {
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

  const invRes = await pool
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

  await pool
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

/**
 * Same as syncInvoiceAfterPaymentStatusChange using an open mssql.Transaction.
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

// Backward-compatible alias
const syncGroupInvoiceAfterPaymentStatusChange = syncInvoiceAfterPaymentStatusChange;

module.exports = {
  syncInvoiceAfterPaymentStatusChange,
  syncInvoiceAfterPaymentStatusChangeInTxn,
  syncGroupInvoiceAfterPaymentStatusChange
};
