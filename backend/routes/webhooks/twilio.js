/**
 * Twilio Message Status Callback Handler (SMS delivery events)
 *
 * Flag-gated: only mounted in app.js when ENABLE_TWILIO_WEBHOOK === 'true'.
 *
 * Receives status updates from Twilio for outbound SMS and persists them to
 * oe.MessageEvent. Signature verification uses twilio.webhook() middleware
 * with TWILIO_AUTH_TOKEN.
 *
 * We link events by the custom `MessageId` parameter we append to the
 * StatusCallback URL at send time. See messageCenter/shared/bulkBlastProcessor.js
 * and messageCenter/MessageProcessor/index.js (Stage 2).
 *
 * Idempotency:
 *   - oe.MessageEvent has UNIQUE(Provider, ProviderEventId). We use the
 *     combination of MessageSid + MessageStatus as ProviderEventId so the
 *     same status update posted twice is a no-op.
 */

const express = require('express');
const twilio = require('twilio');
const { getPool, sql } = require('../../config/database');

const router = express.Router();

// Twilio posts application/x-www-form-urlencoded — we need body parsing BEFORE
// signature verification. Mount urlencoded parser local to this router so we
// do not depend on the global parser order.
router.use(express.urlencoded({ extended: false }));

// Map Twilio MessageStatus values to the normalized event types we store.
// Unknown statuses are stored as-is (truncated to 40 chars).
const STATUS_MAP = {
    queued: 'queued',
    accepted: 'accepted',
    scheduled: 'scheduled',
    sending: 'sending',
    sent: 'sent',
    delivered: 'delivered',
    undelivered: 'undelivered',
    failed: 'failed',
    receiving: 'receiving',
    received: 'received',
    read: 'read'
};

function verifyTwilioMiddleware(req, res, next) {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) {
        console.warn('twilio webhook: TWILIO_AUTH_TOKEN not set; rejecting');
        return res.status(401).json({ error: 'Webhook not configured' });
    }
    // Use Twilio's validateRequest against the full external URL.
    // We pass validate: true so the middleware responds 403 on failure.
    return twilio.webhook({ validate: true, authToken })(req, res, next);
}

router.post('/status', verifyTwilioMiddleware, async (req, res) => {
    try {
        const {
            MessageSid,
            MessageStatus,
            ErrorCode,
            ErrorMessage,
            To,
            From
        } = req.body || {};

        // MessageId is threaded through via query string on the StatusCallback URL.
        const messageId = (req.query && req.query.MessageId) || null;

        if (!MessageSid || !MessageStatus) {
            return res.status(400).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
        }

        if (!messageId) {
            console.warn('twilio webhook: status callback missing MessageId query param', MessageSid, MessageStatus);
            // Still 200 so Twilio does not retry indefinitely.
            return res.status(200).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
        }

        const normalizedStatus = STATUS_MAP[MessageStatus] || String(MessageStatus).slice(0, 40);
        // Include status in the provider event id so each distinct status update is a unique row.
        const providerEventId = `${MessageSid}:${normalizedStatus}`.slice(0, 100);

        const reasonParts = [];
        if (ErrorCode) reasonParts.push(`code=${ErrorCode}`);
        if (ErrorMessage) reasonParts.push(ErrorMessage);
        const reason = reasonParts.length ? reasonParts.join(' ').slice(0, 1000) : null;

        const pool = await getPool();
        const request = pool.request();
        request.input('messageId', sql.UniqueIdentifier, messageId);
        request.input('provider', sql.NVarChar(20), 'twilio');
        request.input('eventType', sql.NVarChar(40), normalizedStatus);
        request.input('eventTime', sql.DateTime2, new Date());
        request.input('reason', sql.NVarChar(1000), reason);
        request.input('mxServer', sql.NVarChar(200), null);
        request.input('providerEventId', sql.NVarChar(100), providerEventId);
        request.input('raw', sql.NVarChar(sql.MAX), JSON.stringify({
            ...req.body,
            _query: req.query || {}
        }));

        await request.query(`
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

        // Twilio expects a 2xx response. Return empty TwiML to match existing pattern.
        return res.status(200).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    } catch (err) {
        console.error('twilio webhook: status callback error', err.message);
        // Return 200 to avoid Twilio retry storms; the row is not persisted but the error is logged.
        return res.status(200).type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }
});

module.exports = router;
