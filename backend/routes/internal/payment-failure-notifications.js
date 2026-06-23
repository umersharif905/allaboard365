'use strict';

/**
 * Queue payment failure emails (member + agent) — called by oe_payment_manager WebhookProcessor.
 * Auth: x-internal-token header (INTERNAL_API_TOKEN).
 *
 * Smoke test bypass (blocked when NODE_ENV=production): set PAYMENT_FAILURE_NOTIFICATION_TEST_BYPASS=true
 */


const express = require('express');
const router = express.Router();
const MessageQueueService = require('../../services/messageQueue.service');

function requireInternalToken(req, res, next) {
  const bypass =
    process.env.PAYMENT_FAILURE_NOTIFICATION_TEST_BYPASS === 'true' &&
    process.env.NODE_ENV !== 'production';
  if (bypass) {
    console.warn(
      '[payment-failure-notifications] TEST BYPASS ACTIVE — unset PAYMENT_FAILURE_NOTIFICATION_TEST_BYPASS before production deploy'
    );
    return next();
  }

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

router.post('/queue', requireInternalToken, async (req, res) => {
  try {
    const body = req.body || {};
    const result = await MessageQueueService.queuePaymentFailureNotifications(body);
    return res.json({
      success: true,
      memberQueued: result.memberQueued,
      agentQueued: result.agentQueued,
      messageIds: result.messageIds,
      skippedReason: result.skippedReason || null
    });
  } catch (err) {
    console.error('internal payment-failure-notifications queue:', err);
    return res.status(400).json({
      success: false,
      message: err.message || 'Failed to queue payment failure notifications'
    });
  }
});

module.exports = router;
