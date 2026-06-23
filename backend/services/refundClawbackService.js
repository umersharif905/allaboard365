'use strict';

/**
 * RefundClawbackService — orchestrates clawback writes inside the unified refund
 * transaction (called by RefundService.processRefund step 8).
 *
 * Three target ledgers:
 *   1. oe.Commissions — agent / agency clawback (Phase 2 — clawBackForRefund)
 *   2. oe.PayoutClawbacks (PayoutType='Vendor')          — Phase 3
 *   3. oe.PayoutClawbacks (PayoutType='TenantOverride')  — Phase 3
 *
 * Each write is best-effort independent — but all share the parent transaction
 * so a failure in any one rolls everything back together.
 *
 * NOTE: There is no automatic reversal of these clawbacks if a replacement payment
 * later pays the same invoice. That needs an explicit finance/ops workflow so we
 * do not incorrectly re-pay or leave phantom clawbacks.
 */

const safeRequire = (p) => { try { return require(p); } catch (_) { return null; } };

async function processClawbacks(paymentId, refundAmount, transaction, opts = {}) {
  if (!paymentId) throw new Error('processClawbacks: paymentId required');
  if (!transaction) throw new Error('processClawbacks: transaction required');
  if (!Number.isFinite(Number(refundAmount)) || Number(refundAmount) <= 0) {
    return { commission: null, payouts: null };
  }

  const result = { commission: null, payouts: null };
  const refundId = opts.refundId || null;

  // 1. Commission clawback
  const CommissionService = safeRequire('./commissionService.advances');
  if (CommissionService && typeof CommissionService.clawBackForRefund === 'function') {
    result.commission = await CommissionService.clawBackForRefund(paymentId, refundAmount, transaction);
  }

  // 2 + 3. Vendor + tenant override clawbacks (single ledger via discriminator).
  // refundId is forwarded so each oe.PayoutClawbacks row gets SourceRefundId populated.
  const PayoutClawbacks = safeRequire('./payoutClawbacks.service');
  if (PayoutClawbacks && typeof PayoutClawbacks.recordClawbacksForRefund === 'function') {
    result.payouts = await PayoutClawbacks.recordClawbacksForRefund(paymentId, refundAmount, transaction, { refundId });
  }

  return result;
}

module.exports = {
  processClawbacks
};
