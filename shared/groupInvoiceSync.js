'use strict';

// Deprecated: Invoice sync logic lives in backend/services/invoiceSync.service.js.
// This file is kept so oe_payment_manager remains independently deployable.
// It attempts to call the backend API first; falls back to local SQL if the API is unavailable.

const { isSuccessfulPaymentRecordStatus } = require('./payment-status');

const BACKEND_API_URL = process.env.BACKEND_API_URL || process.env.OE_BACKEND_URL || '';
const API_KEY = process.env.SCHEDULED_JOB_API_KEY || '';

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

  // Try backend API first
  if (BACKEND_API_URL) {
    try {
      const url = `${BACKEND_API_URL}/api/invoices/${invoiceId}/fulfill`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(API_KEY ? { 'x-api-key': API_KEY } : {})
        },
        body: JSON.stringify({ paymentAmount: amt }),
        signal: AbortSignal.timeout(10000)
      });
      if (res.ok) {
        const body = await res.json();
        return { applied: true, newPaidAmount: body.data?.newPaidAmount, invoiceStatus: body.data?.invoiceStatus };
      }
    } catch {
      // Fall through to local SQL
    }
  }

  // Fallback: local SQL
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
  const newInvStatus = isFullyPaid ? 'Paid' : (newPaid > 0 ? 'Partial' : inv.Status);

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
