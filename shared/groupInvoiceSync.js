'use strict';

const { isSuccessfulPaymentRecordStatus } = require('./payment-status');

/**
 * When a group payment row transitions from a non-success status to a successful one,
 * add this payment's amount to oe.Invoices.PaidAmount (capped at TotalAmount) and set Status to Paid when fully covered.
 * Same logic as backend/services/groupInvoiceSync.service.js (keep in sync).
 *
 * @param {import('mssql').ConnectionPool} pool
 * @param {typeof import('mssql')} sql
 * @param {{ invoiceId: string|null|undefined; paymentAmount: unknown; previousStatus: unknown; newStatus: unknown }} params
 * @returns {Promise<{ applied: boolean; reason?: string; newPaidAmount?: number; invoiceStatus?: string }>}
 */
async function syncGroupInvoiceAfterPaymentStatusChange(pool, sql, params) {
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
      SELECT TotalAmount, PaidAmount, Status
      FROM oe.Invoices
      WHERE InvoiceId = @invoiceId
    `);

  if (!invRes.recordset?.length) {
    return { applied: false, reason: 'invoice_not_found' };
  }

  const inv = invRes.recordset[0];
  const total = parseFloat(inv.TotalAmount) || 0;
  const prevPaid = parseFloat(inv.PaidAmount || 0) || 0;
  const newPaid = Math.min(total, prevPaid + amt);
  const isFullyPaid = total > 0 && newPaid >= total;
  const newInvStatus = isFullyPaid ? 'Paid' : inv.Status;

  await pool
    .request()
    .input('invoiceId', sql.UniqueIdentifier, invoiceId)
    .input('paidAmount', sql.Decimal(12, 2), newPaid)
    .input('status', sql.NVarChar(50), newInvStatus)
    .query(`
      UPDATE oe.Invoices
      SET PaidAmount = @paidAmount,
          Status = @status,
          PaymentReceivedDate = CASE WHEN @status = N'Paid' THEN GETUTCDATE() ELSE PaymentReceivedDate END,
          ModifiedDate = GETUTCDATE()
      WHERE InvoiceId = @invoiceId
    `);

  return { applied: true, newPaidAmount: newPaid, invoiceStatus: newInvStatus };
}

module.exports = { syncGroupInvoiceAfterPaymentStatusChange };
