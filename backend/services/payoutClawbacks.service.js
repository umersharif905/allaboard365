'use strict';

/**
 * Phase 3 — oe.PayoutClawbacks service.
 *
 * Single discriminated ledger for vendor and tenant-override clawbacks. The
 * commission counterpart is oe.Commissions (Phase 2). Both ledgers are netted
 * into NACHA in Phase 6.
 *
 * All write functions accept an optional open transaction so RefundService can
 * include them in the unified refund DB transaction.
 */

const sql = require('mssql');
const crypto = require('crypto');
const { getPool } = require('../config/database');

const PAYOUT_TYPES = Object.freeze({
  VENDOR: 'Vendor',
  TENANT_OVERRIDE: 'TenantOverride'
});

const STATUS = Object.freeze({
  AVAILABLE: 'Available',
  PARTIALLY_APPLIED: 'PartiallyApplied',
  FULLY_APPLIED: 'FullyApplied',
  VOIDED: 'Voided'
});

function asReq(transaction) {
  if (transaction) return transaction.request();
  return null;
}

async function ensurePool() {
  return getPool();
}

/**
 * Insert a clawback row for a given source payment + recipient.
 * Idempotent on (SourcePaymentId, PayoutType, RecipientEntityId, Amount).
 */
async function recordClawback({
  tenantId,
  payoutType,
  recipientEntityType,
  recipientEntityId,
  sourcePaymentId,
  sourceRefundId = null,
  amount,
  notes = null
}, transaction = null) {
  if (!tenantId) throw new Error('recordClawback: tenantId required');
  if (!sourcePaymentId) throw new Error('recordClawback: sourcePaymentId required');
  if (!recipientEntityId) throw new Error('recordClawback: recipientEntityId required');
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('recordClawback: amount must be > 0');
  if (!Object.values(PAYOUT_TYPES).includes(payoutType)) {
    throw new Error(`recordClawback: invalid payoutType ${payoutType}`);
  }

  const id = crypto.randomUUID();
  const req = transaction ? transaction.request() : (await ensurePool()).request();
  req.input('clawbackId', sql.UniqueIdentifier, id);
  req.input('tenantId', sql.UniqueIdentifier, tenantId);
  req.input('payoutType', sql.NVarChar(20), payoutType);
  req.input('recipientEntityType', sql.NVarChar(20), recipientEntityType);
  req.input('recipientEntityId', sql.UniqueIdentifier, recipientEntityId);
  req.input('sourcePaymentId', sql.UniqueIdentifier, sourcePaymentId);
  req.input('sourceRefundId', sql.UniqueIdentifier, sourceRefundId);
  req.input('amount', sql.Decimal(10, 2), amt);
  req.input('notes', sql.NVarChar(500), notes);

  await req.query(`
    -- Idempotency: skip if a row already exists for this source payment + recipient + amount
    IF NOT EXISTS (
      SELECT 1 FROM oe.PayoutClawbacks
      WHERE SourcePaymentId = @sourcePaymentId
        AND PayoutType = @payoutType
        AND RecipientEntityId = @recipientEntityId
        AND ABS(Amount - @amount) < 0.005
    )
    BEGIN
      INSERT INTO oe.PayoutClawbacks
        (ClawbackId, TenantId, PayoutType, RecipientEntityType, RecipientEntityId,
         SourcePaymentId, SourceRefundId, Amount, RemainingAmount, Status, Notes,
         CreatedDate, ModifiedDate)
      VALUES
        (@clawbackId, @tenantId, @payoutType, @recipientEntityType, @recipientEntityId,
         @sourcePaymentId, @sourceRefundId, @amount, @amount, N'Available', @notes,
         GETUTCDATE(), GETUTCDATE());
    END
  `);

  return { clawbackId: id, amount: amt };
}

/**
 * Look up positive vendor + tenant override payouts that came from this payment
 * (via oe.NACHAPaymentDetails) and create matching clawback rows for each.
 *
 * Caller (RefundService) provides the open transaction.
 */
async function recordClawbacksForRefund(paymentId, refundAmount, transaction, opts = {}) {
  if (!paymentId) throw new Error('recordClawbacksForRefund: paymentId required');
  if (!transaction) throw new Error('recordClawbacksForRefund: transaction required');
  const refund = Number(refundAmount);
  if (!Number.isFinite(refund) || refund <= 0) return { rows: [] };
  const sourceRefundId = opts.refundId || null;

  // Fetch payment + sum of payouts to this payment by recipient type.
  // Match payment-anchored OR invoice-anchored vendor/tenant detail rows (ShareWELL
  // pivot: NACHAPaymentDetails.PaymentId NULL, InvoiceId set — join via p.InvoiceId).
  const payRes = await transaction.request()
    .input('paymentId', sql.UniqueIdentifier, paymentId)
    .query(`
      SELECT p.PaymentId, p.TenantId, p.Amount,
             d.RecipientEntityType, d.RecipientEntityId,
             SUM(d.Amount) AS PaidAmount
      FROM oe.Payments p
      INNER JOIN oe.NACHAPaymentDetails d ON (
        (d.PaymentId IS NOT NULL AND d.PaymentId = p.PaymentId)
        OR (
          d.PaymentId IS NULL
          AND d.InvoiceId IS NOT NULL
          AND p.InvoiceId IS NOT NULL
          AND d.InvoiceId = p.InvoiceId
        )
      )
      INNER JOIN oe.NACHAGenerations g ON g.NACHAId = d.NACHAId
      WHERE p.PaymentId = @paymentId
        AND g.Status IN (N'Pending', N'Sent')
        AND d.RecipientEntityType IN (N'Vendor', N'Tenant')
        AND d.Amount > 0
        AND d.ReissueOfNACHAPaymentDetailId IS NULL
      GROUP BY p.PaymentId, p.TenantId, p.Amount, d.RecipientEntityType, d.RecipientEntityId
    `);

  // Full-refund-only rule: RefundService validates refund == payment.Amount
  // before this is called, so no proration. Each recipient's clawback is the
  // full amount they were paid out for this payment.
  const rows = [];

  for (const r of payRes.recordset || []) {
    const paid = Number(r.PaidAmount) || 0;
    if (paid <= 0) continue;
    const clawbackAmount = Math.round(paid * 100) / 100;
    if (clawbackAmount <= 0) continue;
    const payoutType = r.RecipientEntityType === 'Vendor'
      ? PAYOUT_TYPES.VENDOR
      : PAYOUT_TYPES.TENANT_OVERRIDE;
    const result = await recordClawback({
      tenantId: r.TenantId,
      payoutType,
      recipientEntityType: r.RecipientEntityType,
      recipientEntityId: r.RecipientEntityId,
      sourcePaymentId: paymentId,
      sourceRefundId,
      amount: clawbackAmount,
      notes: `Refund clawback for payment ${paymentId}`
    }, transaction);
    rows.push({ ...result, payoutType, recipientEntityId: r.RecipientEntityId });
  }

  return { rows };
}

/**
 * List Available/PartiallyApplied clawbacks for a recipient. Used by the NACHA
 * generator (Phase 6e) to net these against positive payouts.
 */
async function listAvailableForRecipient({ tenantId, payoutType, recipientEntityId }) {
  const pool = await ensurePool();
  const res = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('payoutType', sql.NVarChar(20), payoutType)
    .input('recipientEntityId', sql.UniqueIdentifier, recipientEntityId)
    .query(`
      SELECT ClawbackId, Amount, RemainingAmount, Status, CreatedDate
      FROM oe.PayoutClawbacks
      WHERE TenantId = @tenantId
        AND PayoutType = @payoutType
        AND RecipientEntityId = @recipientEntityId
        AND Status IN (N'Available', N'PartiallyApplied')
        AND RemainingAmount > 0
      ORDER BY CreatedDate ASC
    `);
  return res.recordset || [];
}

/**
 * Apply a positive netting amount against the FIFO list of available clawbacks
 * for a recipient. Used by NACHA cycle when it nets debits into a recipient's
 * positive payout. Caller passes the open transaction.
 *
 * Returns { applied: number, drained: Array<{clawbackId, applied}> }
 */
async function applyClawbacksToRecipient({ tenantId, payoutType, recipientEntityId, amountToApply, nachaId }, transaction) {
  if (!transaction) throw new Error('applyClawbacksToRecipient: transaction required');
  const remainingToApply = Number(amountToApply) || 0;
  if (remainingToApply <= 0) return { applied: 0, drained: [] };

  const list = await transaction.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('payoutType', sql.NVarChar(20), payoutType)
    .input('recipientEntityId', sql.UniqueIdentifier, recipientEntityId)
    .query(`
      SELECT ClawbackId, RemainingAmount
      FROM oe.PayoutClawbacks
      WHERE TenantId = @tenantId
        AND PayoutType = @payoutType
        AND RecipientEntityId = @recipientEntityId
        AND Status IN (N'Available', N'PartiallyApplied')
        AND RemainingAmount > 0
      ORDER BY CreatedDate ASC
    `);

  let pool = remainingToApply;
  const drained = [];
  let totalApplied = 0;

  for (const row of list.recordset || []) {
    if (pool <= 0) break;
    const remaining = Number(row.RemainingAmount) || 0;
    const take = Math.min(pool, remaining);
    if (take <= 0) continue;
    const newRemaining = Math.round((remaining - take) * 100) / 100;
    const newStatus = newRemaining <= 0.005 ? STATUS.FULLY_APPLIED : STATUS.PARTIALLY_APPLIED;

    await transaction.request()
      .input('clawbackId', sql.UniqueIdentifier, row.ClawbackId)
      .input('newRemaining', sql.Decimal(10, 2), newRemaining)
      .input('newStatus', sql.NVarChar(20), newStatus)
      .input('nachaId', sql.UniqueIdentifier, nachaId || null)
      .query(`
        UPDATE oe.PayoutClawbacks
        SET RemainingAmount = @newRemaining,
            Status = @newStatus,
            AppliedToNACHAId = @nachaId,
            ModifiedDate = GETUTCDATE()
        WHERE ClawbackId = @clawbackId
      `);

    drained.push({ clawbackId: row.ClawbackId, applied: take, status: newStatus });
    pool -= take;
    totalApplied += take;
  }

  return { applied: Math.round(totalApplied * 100) / 100, drained };
}

module.exports = {
  PAYOUT_TYPES,
  STATUS,
  recordClawback,
  recordClawbacksForRefund,
  listAvailableForRecipient,
  applyClawbacksToRecipient
};
