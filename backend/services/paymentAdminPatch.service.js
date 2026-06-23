'use strict';

const { requireShared } = require('../config/shared-modules');
const { isSuccessfulPaymentRecordStatus } = requireShared('payment-status');
const invoiceService = require('./invoiceService');
const invoiceSyncService = require('./invoiceSync.service');

/**
 * Admin PATCH payment status: determine whether to adjust the linked invoice.
 * @param {import('mssql').ConnectionPool} pool
 * @param {typeof import('mssql')} sql
 * @param {string} paymentId
 * @param {object} paymentRow — oe.Payments row fields used below
 * @param {string} newStatus
 * @param {boolean} updateInvoice
 * @returns {Promise<{
 *   kind: null | 'unfulfill' | 'sync',
 *   invoiceSync: { applied: boolean; reason?: string; warnings?: string[] }
 * }>}
 */
async function getPaymentStatusInvoiceAdjustmentPlan(pool, sql, paymentId, paymentRow, newStatus, updateInvoice) {
  const invoiceSync = { applied: false };
  const warnings = [];

  if (!updateInvoice) {
    invoiceSync.reason = 'update_invoice_off';
    return { kind: null, invoiceSync };
  }

  if (!paymentRow.InvoiceId) {
    invoiceSync.reason = 'no_invoice';
    return { kind: null, invoiceSync };
  }

  const tt = paymentRow.TransactionType;
  if (tt != null && String(tt).trim() !== '' && String(tt).trim().toLowerCase() !== 'payment') {
    invoiceSync.reason = 'not_eligible_payment_row';
    return { kind: null, invoiceSync };
  }

  if (paymentRow.OriginalPaymentId != null && String(paymentRow.OriginalPaymentId).trim() !== '') {
    invoiceSync.reason = 'not_eligible_payment_row';
    return { kind: null, invoiceSync };
  }

  const previousStatus = paymentRow.Status;
  const prevOk = isSuccessfulPaymentRecordStatus(String(previousStatus ?? ''));
  const nextOk = isSuccessfulPaymentRecordStatus(String(newStatus ?? ''));
  const ps = String(previousStatus ?? '').trim();
  const ns = String(newStatus ?? '').trim();
  if (ps === 'Refunded' || ns === 'Refunded') {
    invoiceSync.reason = 'refunded_status_excluded';
    return { kind: null, invoiceSync };
  }

  if (prevOk === nextOk) {
    invoiceSync.reason = 'no_success_state_change';
    return { kind: null, invoiceSync };
  }

  if (prevOk && !nextOk) {
    const comRes = await pool
      .request()
      .input('paymentId', sql.UniqueIdentifier, paymentId)
      .query(`
        SELECT TOP 1 1 AS Ok FROM oe.Commissions c
        WHERE c.PaymentId = @paymentId AND ISNULL(c.Status, N'') <> N'Deleted'
      `);
    if (comRes.recordset?.length) {
      warnings.push('commission_may_remain');
    }
    return {
      kind: 'unfulfill',
      invoiceSync: { ...invoiceSync, warnings: warnings.length ? warnings : undefined }
    };
  }

  if (!prevOk && nextOk) {
    return {
      kind: 'sync',
      invoiceSync: { ...invoiceSync, warnings: warnings.length ? warnings : undefined }
    };
  }

  invoiceSync.reason = 'no_success_state_change';
  return { kind: null, invoiceSync };
}

/**
 * @param {import('mssql').Transaction} transaction
 * @param {'unfulfill'|'sync'} kind
 */
async function applyPaymentStatusInvoiceAdjustmentInTxn(transaction, sql, kind, paymentRow, newStatus) {
  if (kind === 'unfulfill') {
    return invoiceService.unfulfillInvoiceInTxn(
      transaction,
      sql,
      paymentRow.InvoiceId,
      paymentRow.Amount
    );
  }
  if (kind === 'sync') {
    return invoiceSyncService.syncInvoiceAfterPaymentStatusChangeInTxn(transaction, sql, {
      invoiceId: paymentRow.InvoiceId,
      paymentAmount: paymentRow.Amount,
      previousStatus: paymentRow.Status,
      newStatus
    });
  }
  return { applied: false, reason: 'unknown_kind' };
}

module.exports = {
  getPaymentStatusInvoiceAdjustmentPlan,
  applyPaymentStatusInvoiceAdjustmentInTxn
};
