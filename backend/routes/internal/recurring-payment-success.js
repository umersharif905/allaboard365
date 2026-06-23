'use strict';

/**
 * Applies DIME recurring_payment.success payloads (individual + group schedules).
 *
 * Authentication: shared secret in `x-internal-token` header (INTERNAL_API_TOKEN).
 * Called by oe_payment_manager/WebhookProcessor (and optional replay tooling).
 */

const express = require('express');
const router = express.Router();
const { applyRecurringPaymentSuccessFromWebhook } = require('../../services/recurringPaymentWebhookApply.service');

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

router.post('/apply', requireInternalToken, async (req, res) => {
  try {
    const result = await applyRecurringPaymentSuccessFromWebhook(req.body || {});

    if (result.success) {
      return res.status(200).json({ ...result });
    }

    if (result.skipped && result.retryable === false) {
      return res.status(200).json({ ...result, success: false });
    }

    const retryHttp =
      result.code === 'SCHEDULE_NOT_FOUND' ||
      result.code === 'MISSING_TRANSACTION_ID' ||
      result.code === 'INVOICE_RESOLVE_FAILED' ||
      result.code === 'MISSING_SCHEDULE' ||
      result.retryable === true;

    return res.status(retryHttp ? 422 : 400).json({ ...result, success: false });
  } catch (err) {
    console.error('[internal/recurring-payment-success] error:', err);
    return res.status(500).json({
      success: false,
      message: err.message || String(err)
    });
  }
});

module.exports = router;
