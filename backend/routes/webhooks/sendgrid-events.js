/**
 * Twilio SendGrid Event Webhook — signed POST from SendGrid.
 * - `open`: public form routing mail first-open (existing behavior).
 * - `processed` / `deferred` / `delivered` / `bounce` / `dropped`: updates oe.MessageHistory + oe.EmailLogs by sg_message_id (quick quote + other sends).
 * Requires raw JSON body (see app.js mount before express.json).
 * Env: SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY (PEM). Optional: SENDGRID_EVENT_WEBHOOK_SKIP_VERIFY=true (dev only).
 * In SendGrid: enable Event Webhook for these event types and point URL at this route.
 */
const express = require('express');
const { EventWebhook, EventWebhookHeader } = require('@sendgrid/eventwebhook');
const publicFormAdminService = require('../../services/publicFormAdminService');
const sendGridEmailDeliveryTracking = require('../../services/sendGridEmailDeliveryTracking.service');

const router = express.Router();

function normalizePem(key) {
    if (!key) return '';
    return String(key).replace(/\\n/g, '\n').trim();
}

function verifyRequest(rawBuffer, signature, timestamp) {
    if (process.env.SENDGRID_EVENT_WEBHOOK_SKIP_VERIFY === 'true') {
        console.warn('sendgrid-events: SENDGRID_EVENT_WEBHOOK_SKIP_VERIFY is on — not verifying signatures');
        return true;
    }
    const pem = normalizePem(process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY);
    if (!pem || !signature || !timestamp) return false;
    try {
        const ew = new EventWebhook();
        const pub = ew.convertPublicKeyToECDSA(pem);
        return ew.verifySignature(pub, rawBuffer, signature, timestamp);
    } catch (e) {
        console.error('sendgrid-events verify', e.message);
        return false;
    }
}

router.post('/', async (req, res) => {
    try {
        const rawBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''), 'utf8');
        const signature = req.get(EventWebhookHeader.SIGNATURE()) || req.get('x-twilio-email-event-webhook-signature');
        const timestamp = req.get(EventWebhookHeader.TIMESTAMP()) || req.get('x-twilio-email-event-webhook-timestamp');
        if (!verifyRequest(rawBuffer, signature, timestamp)) {
            return res.status(401).json({ success: false, message: 'Invalid signature' });
        }
        let events;
        try {
            events = JSON.parse(rawBuffer.toString('utf8'));
        } catch {
            return res.status(400).json({ success: false, message: 'Invalid JSON' });
        }
        if (!Array.isArray(events)) {
            return res.status(400).json({ success: false, message: 'Expected array' });
        }
        for (const ev of events) {
            if (!ev) continue;
            if (ev.event === 'open') {
                const sgMsgId = ev.sg_message_id;
                const ts = ev.timestamp;
                if (!sgMsgId || ts === undefined || ts === null) continue;
                const eventUtc = new Date(Number(ts) * 1000);
                if (Number.isNaN(eventUtc.getTime())) continue;
                await publicFormAdminService.applyRoutingEmailFirstOpenedFromSendGrid(String(sgMsgId), eventUtc);
                continue;
            }
            const et = String(ev.event || '').toLowerCase();
            if (['processed', 'delivered', 'bounce', 'dropped', 'deferred'].includes(et)) {
                const delivery = await sendGridEmailDeliveryTracking.applySendGridDeliveryEvent(ev);
                if (delivery && delivery.ok && (delivery.historyRows > 0 || delivery.emailLogRows > 0)) {
                    console.log('sendgrid-events: delivery update', {
                        event: ev.event,
                        historyRows: delivery.historyRows,
                        emailLogRows: delivery.emailLogRows
                    });
                }
            }
        }
        return res.status(200).json({ success: true });
    } catch (e) {
        console.error('sendgrid-events webhook', e);
        return res.status(500).json({ success: false, message: 'Webhook failed' });
    }
});

module.exports = router;
