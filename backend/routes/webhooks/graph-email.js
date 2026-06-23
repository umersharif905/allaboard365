// routes/webhooks/graph-email.js
// Microsoft Graph change-notification endpoint for the Back Office inbox.
// Public (no auth) — genuineness is verified via per-vendor clientState.
// Mounted in app.js without auth. Spec:
// docs/superpowers/specs/2026-06-02-back-office-email/design.md
//
// Graph contract:
//  - Validation handshake: POST with ?validationToken=... → echo it as text/plain
//    (HTTP 200) within 10s.
//  - Notifications: POST { value: [ { subscriptionId, clientState, resourceData:{id} } ] }
//    → ack 202 within 3s, then process async.

const express = require('express');
const router = express.Router();

const emailSyncService = require('../../services/emailSyncService');
const emailSubscriptionService = require('../../services/emailSubscriptionService');

/** Reply to the Graph validation handshake if present. Returns true if handled. */
function handleValidation(req, res) {
    const token = req.query.validationToken;
    if (token) {
        res.set('Content-Type', 'text/plain').status(200).send(String(token));
        return true;
    }
    return false;
}

/** Verify the notification's clientState matches what we registered for that vendor. */
async function resolveAndVerify(notification) {
    const vendorId = await emailSyncService.findVendorBySubscription(notification.subscriptionId);
    if (!vendorId) return null;
    const expected = emailSubscriptionService.clientStateFor(vendorId);
    if (notification.clientState && notification.clientState !== expected) {
        console.warn('⚠️ graph-email: clientState mismatch for subscription', notification.subscriptionId);
        return null;
    }
    return vendorId;
}

// Change notifications --------------------------------------------------------
router.post('/', async (req, res) => {
    if (handleValidation(req, res)) return;

    const notifications = req.body?.value || [];
    res.status(202).send(); // ack fast; process after

    for (const n of notifications) {
        try {
            const vendorId = await resolveAndVerify(n);
            if (!vendorId) continue;
            const messageId = n.resourceData?.id;
            if (messageId) await emailSyncService.ingestMessage(vendorId, messageId);
        } catch (err) {
            console.error('❌ graph-email notification processing failed:', err.message);
        }
    }
});

// Lifecycle notifications ----------------------------------------------------
router.post('/lifecycle', async (req, res) => {
    if (handleValidation(req, res)) return;

    const notifications = req.body?.value || [];
    res.status(202).send();

    for (const n of notifications) {
        try {
            const vendorId = await resolveAndVerify(n);
            if (!vendorId) continue;
            await emailSubscriptionService.handleLifecycle(vendorId, n.lifecycleEvent);
        } catch (err) {
            console.error('❌ graph-email lifecycle processing failed:', err.message);
        }
    }
});

module.exports = router;
