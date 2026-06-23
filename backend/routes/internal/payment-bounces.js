'use strict';

/**
 * Internal payment-bounce processing endpoint - called by oe_payment_manager webhook
 * for ACH returns and credit-card chargebacks.
 *
 * Authentication: shared secret in `x-internal-token` header (env INTERNAL_API_TOKEN).
 */

const express = require('express');
const router = express.Router();
const PaymentBounceService = require('../../services/paymentBounceService');

// Accept either the internal token (x-internal-token / INTERNAL_API_TOKEN) OR the
// scheduled-job key (x-api-key / SCHEDULED_JOB_API_KEY). The DIME webhook handler
// (oe_payment_manager, Azure Function) already authenticates backend calls with the
// scheduled-job key, so allowing it here lets the webhook reuse processBounce instead
// of its own inferior inline logic (which never flipped the original payment).
function requireInternalToken(req, res, next) {
  const internalExpected = process.env.INTERNAL_API_TOKEN;
  const apiKeyExpected = process.env.SCHEDULED_JOB_API_KEY;
  if (!internalExpected && !apiKeyExpected) {
    return res.status(503).json({ success: false, message: 'No internal auth secret configured' });
  }
  const internalProvided = req.headers['x-internal-token'];
  const apiKeyProvided = req.headers['x-api-key'];
  const internalOk = internalExpected && internalProvided && String(internalProvided) === String(internalExpected);
  const apiKeyOk = apiKeyExpected && apiKeyProvided && String(apiKeyProvided) === String(apiKeyExpected);
  if (!internalOk && !apiKeyOk) {
    return res.status(401).json({ success: false, message: 'Invalid internal token' });
  }
  next();
}

router.post('/process', requireInternalToken, async (req, res) => {
  try {
    const {
      originalPaymentId,
      originalProcessorTransactionId,
      returnType,
      amount,
      returnCode,
      returnReason,
      chargebackReason,
      webhookEventId,
      customerUuid
    } = req.body || {};

    const result = await PaymentBounceService.processBounce({
      originalPaymentId,
      originalProcessorTransactionId,
      returnType,
      amount: Number(amount),
      returnCode,
      returnReason,
      chargebackReason,
      webhookEventId,
      customerUuid
    });

    if (!result.success) {
      const status =
        result.code === 'ORIGINAL_NOT_FOUND' ? 404 :
        result.code === 'BAD_RETURN_TYPE' || result.code === 'BAD_AMOUNT' || result.code === 'MISSING_LOOKUP' ? 400 :
        500;
      return res.status(status).json(result);
    }

    res.json(result);
  } catch (err) {
    console.error('[internal/payment-bounces] error:', err);
    res.status(500).json({ success: false, message: err && err.message ? err.message : String(err) });
  }
});

module.exports = router;
