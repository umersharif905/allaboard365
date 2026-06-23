/**
 * SendGrid Event Webhook Handler
 *
 * Receives signed event POSTs from SendGrid and persists them to oe.MessageEvent.
 *
 * Security:
 *   - HMAC-verified via @sendgrid/eventwebhook (ECDSA signature).
 *   - Public verification key must be provided via env var
 *     SENDGRID_WEBHOOK_PUBLIC_KEY. When the env var is missing, all requests
 *     are rejected with 401 — the endpoint is a no-op until the user enables
 *     signing in the SendGrid dashboard (Stage 4).
 *
 * Idempotency:
 *   - oe.MessageEvent has UNIQUE(Provider, ProviderEventId).
 *   - We guard each insert with an IF NOT EXISTS check so retries from
 *     SendGrid (same sg_event_id) are silently ignored.
 *
 * Body parsing:
 *   - This route MUST receive the raw request body for signature verification.
 *     It is mounted in app.js BEFORE the global express.json() so the
 *     express.raw() middleware below takes precedence.
 */

const express = require('express');
const { EventWebhook, EventWebhookHeader } = require('@sendgrid/eventwebhook');
const { getPool, sql } = require('../../config/database');

// Existing services preserved from the legacy /api/webhooks/sendgrid-events route.
// Calling them here so the new route is a superset of the old one: anything the
// old handler did continues to work, AND we also insert oe.MessageEvent rows.
const publicFormAdminService = require('../../services/publicFormAdminService');
const sendGridEmailDeliveryTracking = require('../../services/sendGridEmailDeliveryTracking.service');
const { providerIdLookupKeys } = sendGridEmailDeliveryTracking;

const router = express.Router();

const LEGACY_DELIVERY_EVENTS = new Set(['processed', 'delivered', 'bounce', 'dropped', 'deferred']);

router.post(
    '/events',
    express.raw({ type: '*/*', limit: '5mb' }),
    async (req, res) => {
        const publicKey = process.env.SENDGRID_WEBHOOK_PUBLIC_KEY;
        const signature = req.get(EventWebhookHeader.SIGNATURE());
        const timestamp = req.get(EventWebhookHeader.TIMESTAMP());

        if (!publicKey) {
            console.warn('sendgrid webhook: SENDGRID_WEBHOOK_PUBLIC_KEY not set; rejecting');
            return res.status(401).json({ error: 'Webhook not configured' });
        }
        if (!signature || !timestamp) {
            return res.status(401).json({ error: 'Missing signature headers' });
        }
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
            return res.status(400).json({ error: 'Missing or invalid body' });
        }

        // Verify HMAC/ECDSA signature against the raw body
        let verified = false;
        try {
            const ew = new EventWebhook();
            const ecKey = ew.convertPublicKeyToECDSA(publicKey);
            verified = ew.verifySignature(ecKey, req.body, signature, timestamp);
        } catch (err) {
            console.error('sendgrid webhook: signature verification threw', err.message);
            return res.status(401).json({ error: 'Invalid signature' });
        }
        if (!verified) {
            return res.status(401).json({ error: 'Invalid signature' });
        }

        // Parse events
        let events;
        try {
            events = JSON.parse(req.body.toString('utf8'));
        } catch (err) {
            return res.status(400).json({ error: 'Invalid JSON' });
        }
        if (!Array.isArray(events)) {
            events = [events];
        }

        let inserted = 0;
        let skipped = 0;
        let failed = 0;

        try {
            const pool = await getPool();

            for (const e of events) {
                try {
                    const providerEventId = e && e.sg_event_id ? String(e.sg_event_id) : null;
                    if (!providerEventId) {
                        console.warn('sendgrid webhook: event missing sg_event_id', e && e.event);
                        skipped++;
                        continue;
                    }

                    let messageId = (e.custom_args && e.custom_args.MessageId) || null;
                    if (!messageId) {
                        // Fallback: look up oe.MessageHistory.MessageId by sg_message_id.
                        // Senders that don't yet thread customArgs.MessageId still land here;
                        // MessageHistory.ProviderMessageId stores SendGrid's sg_message_id
                        // (sometimes with a `.recvd-*` suffix), so we mirror the legacy
                        // tracking service's normalization via providerIdLookupKeys.
                        const keys = providerIdLookupKeys(e.sg_message_id);
                        for (const k of keys) {
                            const lookup = pool.request();
                            lookup.input('kExact', sql.NVarChar(300), k);
                            lookup.input('kLike', sql.NVarChar(301), `${k}.%`);
                            const r = await lookup.query(`
                                SELECT TOP 1 MessageId FROM oe.MessageHistory
                                WHERE MessageType = N'Email'
                                  AND (ProviderMessageId = @kExact OR ProviderMessageId LIKE @kLike)
                            `);
                            if (r.recordset && r.recordset.length > 0 && r.recordset[0].MessageId) {
                                messageId = r.recordset[0].MessageId;
                                break;
                            }
                        }
                    }
                    if (!messageId) {
                        // Neither custom_args nor sg_message_id yielded a MessageId.
                        // MessageEvent.MessageId is NOT NULL; skip rather than orphan.
                        console.warn('sendgrid webhook: unable to resolve MessageId', providerEventId, e.event, e.sg_message_id);
                        skipped++;
                        continue;
                    }

                    const eventTimeMs = (typeof e.timestamp === 'number' ? e.timestamp : Date.now() / 1000) * 1000;

                    const request = pool.request();
                    request.input('messageId', sql.UniqueIdentifier, messageId);
                    request.input('provider', sql.NVarChar(20), 'sendgrid');
                    request.input('eventType', sql.NVarChar(40), String(e.event || 'unknown').slice(0, 40));
                    request.input('eventTime', sql.DateTime2, new Date(eventTimeMs));
                    request.input('reason', sql.NVarChar(1000), e.reason ? String(e.reason).slice(0, 1000) : null);
                    request.input('mxServer', sql.NVarChar(200), e.mx ? String(e.mx).slice(0, 200) : null);
                    request.input('providerEventId', sql.NVarChar(100), providerEventId.slice(0, 100));
                    request.input('raw', sql.NVarChar(sql.MAX), JSON.stringify(e));

                    const result = await request.query(`
                        IF NOT EXISTS (
                            SELECT 1 FROM oe.MessageEvent
                             WHERE Provider = @provider AND ProviderEventId = @providerEventId
                        )
                        BEGIN
                            INSERT INTO oe.MessageEvent
                                (MessageId, Provider, EventType, EventTime, Reason, MxServer, ProviderEventId, RawPayload)
                            VALUES
                                (@messageId, @provider, @eventType, @eventTime, @reason, @mxServer, @providerEventId, @raw);
                        END
                    `);

                    if (result && typeof result.rowsAffected !== 'undefined') {
                        const rows = Array.isArray(result.rowsAffected) ? result.rowsAffected[0] : result.rowsAffected;
                        if (rows > 0) inserted++; else skipped++;
                    } else {
                        inserted++;
                    }
                } catch (err) {
                    failed++;
                    console.error('sendgrid webhook: event insert failed', err.message, e && e.sg_event_id);
                }
            }

            // Delegate to legacy services so existing features (public-form open
            // tracking, MessageHistory delivery-state updates) keep working now
            // that traffic arrives here instead of /api/webhooks/sendgrid-events.
            // Failures here do NOT fail the webhook — SendGrid retries would
            // otherwise re-insert MessageEvent rows and we'd lose idempotency.
            for (const e of events) {
                try {
                    if (!e) continue;
                    const eventType = String(e.event || '').toLowerCase();
                    if (eventType === 'open') {
                        const sgMsgId = e.sg_message_id;
                        const ts = e.timestamp;
                        if (sgMsgId && ts !== undefined && ts !== null) {
                            const eventUtc = new Date(Number(ts) * 1000);
                            if (!Number.isNaN(eventUtc.getTime())) {
                                await publicFormAdminService.applyRoutingEmailFirstOpenedFromSendGrid(String(sgMsgId), eventUtc);
                            }
                        }
                    } else if (LEGACY_DELIVERY_EVENTS.has(eventType)) {
                        await sendGridEmailDeliveryTracking.applySendGridDeliveryEvent(e);
                    }
                } catch (err) {
                    console.error('sendgrid webhook: legacy delegation failed (non-fatal)', err.message, e && e.sg_event_id);
                }
            }
        } catch (err) {
            console.error('sendgrid webhook: db pool error', err.message);
            return res.status(500).json({ error: 'Database unavailable' });
        }

        return res.json({ success: true, inserted, skipped, failed, total: events.length });
    }
);

module.exports = router;
