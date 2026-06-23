'use strict';

/**
 * Internal refund processing endpoint - called by oe_payment_manager webhook.
 *
 * Authentication: shared secret in `x-internal-token` header (env INTERNAL_API_TOKEN).
 *
 * The webhook discovers the OriginalPaymentId from the processor transaction id and
 * forwards the refund event here so all DB writes go through RefundService.processRefund
 * (the same code path manual refunds use). This eliminates the previous divergence
 * where webhook only inserted oe.Payments rows and manual only wrote oe.Refunds.
 */

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../config/database');
const RefundService = require('../../services/refundService');

function requireInternalToken(req, res, next) {
  const expected = process.env.INTERNAL_API_TOKEN;
  if (!expected) {
    return res.status(503).json({ success: false, message: 'Internal token not configured' });
  }
  const provided = req.headers['x-internal-token'];
  if (!provided || String(provided) !== String(expected)) {
    return res.status(401).json({ success: false, message: 'Invalid internal token' });
  }
  next();
}

router.post('/process', requireInternalToken, async (req, res) => {
  try {
    const {
      originalPaymentId,            // direct linkage when webhook already knows it
      originalProcessorTransactionId, // alternative lookup key
      refundProcessorTransactionId, // for idempotency
      amount,
      reason,
      paymentMethod                 // 'CreditCard' | 'ACH'
    } = req.body || {};

    let paymentId = originalPaymentId;
    if (!paymentId && originalProcessorTransactionId) {
      const pool = await getPool();
      const lookup = await pool.request()
        .input('processorTxnId', sql.NVarChar(255), String(originalProcessorTransactionId))
        .query(`
          SELECT TOP 1 PaymentId
          FROM oe.Payments
          WHERE ProcessorTransactionId = @processorTxnId
            AND TransactionType = N'Payment'
          ORDER BY CreatedDate DESC
        `);
      paymentId = lookup.recordset?.[0]?.PaymentId;
    }

    if (!paymentId) {
      return res.status(404).json({ success: false, message: 'Original payment not found' });
    }

    const result = await RefundService.processRefund({
      paymentId,
      refundAmount: Number(amount),
      reason: reason || 'Webhook refund',
      processedBy: 'webhook',
      processorTxnId: refundProcessorTransactionId || null,
      source: 'webhook',
      bypassTenantGuard: true,
      paymentMethodHint: paymentMethod
    });

    if (!result.success) {
      const status = result.code === 'NOT_FOUND' ? 404 : 400;
      return res.status(status).json({ success: false, message: result.message, code: result.code });
    }

    res.json({
      success: true,
      refundPaymentId: result.refundPaymentId,
      partial: !!result.partial,
      alreadyProcessed: !!result.alreadyProcessed
    });
  } catch (err) {
    console.error('[internal/refunds] error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
