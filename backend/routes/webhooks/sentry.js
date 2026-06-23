/**
 * Sentry Internal Integration webhook → Cursor Automation bridge.
 *
 * Sentry cannot attach Cursor's Bearer token to outbound webhooks, so this route
 * verifies the Sentry signature and forwards eligible issues to the existing
 * BUG_REPORT_WEBHOOK_URL automation using publishBugReport().
 *
 * Mount BEFORE express.json() so signature verification uses the raw body.
 */

const express = require('express');
const {
  SENTRY_HOOK_SIGNATURE_HEADER,
  verifyWebhookSignature,
  handleSentryWebhook,
} = require('../../services/sentryCursorAutomationService');

const router = express.Router();

router.post('/', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const secret = process.env.SENTRY_WEBHOOK_SECRET;
  const signature = req.get(SENTRY_HOOK_SIGNATURE_HEADER);

  if (!secret) {
    console.warn('sentry webhook: SENTRY_WEBHOOK_SECRET not set; rejecting');
    return res.status(401).json({ error: 'Webhook not configured' });
  }

  if (!signature) {
    return res.status(401).json({ error: 'Missing sentry-hook-signature header' });
  }

  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: 'Missing or invalid body' });
  }

  if (!verifyWebhookSignature(req.body, signature, secret)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  try {
    const result = await handleSentryWebhook({
      rawBody: req.body,
      headers: {
        'sentry-hook-resource': req.get('sentry-hook-resource'),
        'sentry-hook-timestamp': req.get('sentry-hook-timestamp'),
      },
    });

    return res.status(result.status).json(result);
  } catch (err) {
    console.error('sentry webhook: forward failed:', err.message);
    return res.status(500).json({ error: 'Failed to forward issue to Cursor automation' });
  }
});

module.exports = router;
