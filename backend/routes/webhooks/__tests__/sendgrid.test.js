/**
 * Tests for POST /api/webhooks/sendgrid/events
 *
 * Covers:
 *   - Rejects requests with no signature headers
 *   - Rejects requests with invalid signatures
 *   - Inserts events for valid signed payload
 *   - Idempotent on retry (same sg_event_id only inserts once)
 *   - Falls back to oe.MessageHistory lookup by sg_message_id when custom_args.MessageId is absent
 *   - Skips when neither custom_args.MessageId nor sg_message_id resolves
 *
 * The DB layer is mocked — these are handler-level tests. The idempotency
 * test uses the mock to observe how often the insert path is exercised and
 * confirms the IF NOT EXISTS guard is included in the SQL.
 */

// Mock the DB before requiring the route.
const mockQuery = jest.fn();
const mockInput = jest.fn().mockReturnThis();
const mockRequest = { input: mockInput, query: mockQuery };
const mockPool = { request: () => mockRequest };

jest.mock('../../../config/database', () => ({
    getPool: jest.fn(() => Promise.resolve({ request: () => mockRequest })),
    sql: {
        UniqueIdentifier: 'UniqueIdentifier',
        NVarChar: (n) => `NVarChar(${n || 'default'})`,
        DateTime2: 'DateTime2',
        MAX: 'MAX'
    }
}));

const express = require('express');
const request = require('supertest');
const { Ecdsa, PrivateKey } = require('starkbank-ecdsa');
const sendGridRoutes = require('../sendgrid');

// Build an app with just the webhook mounted — same middleware shape as prod
function makeApp() {
    const app = express();
    app.use('/api/webhooks/sendgrid', sendGridRoutes);
    return app;
}

// Fabricate a signed request body using a fresh ECDSA keypair.
// Returns { publicKeyPem, payloadBuffer, signature, timestamp }.
function signPayload(events) {
    const privateKey = new PrivateKey();
    const publicKey = privateKey.publicKey();
    const payload = JSON.stringify(events);
    const timestamp = String(Math.floor(Date.now() / 1000));
    // SendGrid signs `timestamp + payload`
    const signed = Ecdsa.sign(timestamp + payload, privateKey);
    return {
        publicKeyPem: publicKey.toPem(),
        payload,
        signature: signed.toBase64(),
        timestamp
    };
}

describe('POST /api/webhooks/sendgrid/events', () => {
    const originalEnv = process.env.SENDGRID_WEBHOOK_PUBLIC_KEY;

    beforeEach(() => {
        mockQuery.mockReset();
        mockInput.mockClear();
        mockQuery.mockResolvedValue({ rowsAffected: [1] });
    });

    afterAll(() => {
        if (originalEnv === undefined) {
            delete process.env.SENDGRID_WEBHOOK_PUBLIC_KEY;
        } else {
            process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = originalEnv;
        }
    });

    test('rejects when public key env var is missing', async () => {
        delete process.env.SENDGRID_WEBHOOK_PUBLIC_KEY;
        const app = makeApp();
        const res = await request(app)
            .post('/api/webhooks/sendgrid/events')
            .set('Content-Type', 'application/json')
            .send([{ event: 'delivered', sg_event_id: 'x', custom_args: { MessageId: '00000000-0000-0000-0000-000000000001' } }]);
        expect(res.status).toBe(401);
        expect(mockQuery).not.toHaveBeenCalled();
    });

    test('rejects when signature headers are missing', async () => {
        process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----\n';
        const app = makeApp();
        const res = await request(app)
            .post('/api/webhooks/sendgrid/events')
            .set('Content-Type', 'application/json')
            .send([{ event: 'delivered', sg_event_id: 'x' }]);
        expect(res.status).toBe(401);
        expect(mockQuery).not.toHaveBeenCalled();
    });

    test('rejects when signature does not verify', async () => {
        // Generate a valid signed payload, then swap in a DIFFERENT public key so
        // verification fails.
        const signed = signPayload([{ event: 'delivered', sg_event_id: 'x', custom_args: { MessageId: '00000000-0000-0000-0000-000000000001' } }]);
        const otherKey = new PrivateKey().publicKey().toPem();
        process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = otherKey;

        const app = makeApp();
        const res = await request(app)
            .post('/api/webhooks/sendgrid/events')
            .set('Content-Type', 'application/json')
            .set('X-Twilio-Email-Event-Webhook-Signature', signed.signature)
            .set('X-Twilio-Email-Event-Webhook-Timestamp', signed.timestamp)
            .send(signed.payload);
        expect(res.status).toBe(401);
        expect(mockQuery).not.toHaveBeenCalled();
    });

    test('inserts events for valid signed payload', async () => {
        const events = [
            {
                event: 'delivered',
                sg_event_id: 'evt-1',
                timestamp: 1712000000,
                email: 'a@b.com',
                custom_args: { MessageId: '11111111-1111-1111-1111-111111111111' }
            }
        ];
        const signed = signPayload(events);
        process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = signed.publicKeyPem;

        const app = makeApp();
        const res = await request(app)
            .post('/api/webhooks/sendgrid/events')
            .set('Content-Type', 'application/json')
            .set('X-Twilio-Email-Event-Webhook-Signature', signed.signature)
            .set('X-Twilio-Email-Event-Webhook-Timestamp', signed.timestamp)
            .send(signed.payload);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.inserted).toBe(1);
        expect(mockQuery).toHaveBeenCalledTimes(1);
        // Verify the SQL uses IF NOT EXISTS for idempotency.
        const sqlText = mockQuery.mock.calls[0][0];
        expect(sqlText).toMatch(/IF NOT EXISTS/i);
        expect(sqlText).toMatch(/INSERT INTO oe\.MessageEvent/i);
    });

    test('idempotent on retry: identical payload re-POST does not double-insert', async () => {
        // Simulate DB idempotency by returning rowsAffected=0 on the second call,
        // mirroring what the IF NOT EXISTS guard does in real SQL.
        mockQuery
            .mockResolvedValueOnce({ rowsAffected: [1] })  // first insert
            .mockResolvedValueOnce({ rowsAffected: [0] }); // second (duplicate) -> no row

        const events = [{
            event: 'bounce',
            sg_event_id: 'evt-dedupe',
            timestamp: 1712000000,
            custom_args: { MessageId: '22222222-2222-2222-2222-222222222222' }
        }];
        const signed = signPayload(events);
        process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = signed.publicKeyPem;

        const app = makeApp();

        const firstRes = await request(app)
            .post('/api/webhooks/sendgrid/events')
            .set('Content-Type', 'application/json')
            .set('X-Twilio-Email-Event-Webhook-Signature', signed.signature)
            .set('X-Twilio-Email-Event-Webhook-Timestamp', signed.timestamp)
            .send(signed.payload);

        const secondRes = await request(app)
            .post('/api/webhooks/sendgrid/events')
            .set('Content-Type', 'application/json')
            .set('X-Twilio-Email-Event-Webhook-Signature', signed.signature)
            .set('X-Twilio-Email-Event-Webhook-Timestamp', signed.timestamp)
            .send(signed.payload);

        expect(firstRes.status).toBe(200);
        expect(firstRes.body.inserted).toBe(1);
        expect(secondRes.status).toBe(200);
        expect(secondRes.body.inserted).toBe(0);
        expect(secondRes.body.skipped).toBe(1);
    });

    test('skips when neither custom_args.MessageId nor sg_message_id is present', async () => {
        const events = [
            {
                event: 'delivered',
                sg_event_id: 'no-ids-1',
                timestamp: 1712000000
                // no custom_args, no sg_message_id
            }
        ];
        const signed = signPayload(events);
        process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = signed.publicKeyPem;

        const app = makeApp();
        const res = await request(app)
            .post('/api/webhooks/sendgrid/events')
            .set('Content-Type', 'application/json')
            .set('X-Twilio-Email-Event-Webhook-Signature', signed.signature)
            .set('X-Twilio-Email-Event-Webhook-Timestamp', signed.timestamp)
            .send(signed.payload);

        expect(res.status).toBe(200);
        expect(res.body.inserted).toBe(0);
        expect(res.body.skipped).toBe(1);
        expect(mockQuery).not.toHaveBeenCalled();
    });

    test('falls back to sg_message_id lookup in oe.MessageHistory when custom_args.MessageId is absent', async () => {
        const resolvedMessageId = '33333333-3333-3333-3333-333333333333';
        // First query: the MessageHistory lookup returns a match.
        // Second query: the MessageEvent INSERT succeeds.
        // Subsequent queries belong to the legacy delivery-tracker delegation
        // (terminalUpdateMessageHistory / terminalUpdateEmailLogs) which runs
        // because 'delivered' is a legacy delivery event.
        mockQuery
            .mockResolvedValueOnce({ recordset: [{ MessageId: resolvedMessageId }] })
            .mockResolvedValue({ rowsAffected: [1] });

        const events = [
            {
                event: 'delivered',
                sg_event_id: 'evt-fallback',
                sg_message_id: 'abc123xyz.filterdrecv-abc-1',
                timestamp: 1712000000
                // custom_args intentionally absent
            }
        ];
        const signed = signPayload(events);
        process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = signed.publicKeyPem;

        const app = makeApp();
        const res = await request(app)
            .post('/api/webhooks/sendgrid/events')
            .set('Content-Type', 'application/json')
            .set('X-Twilio-Email-Event-Webhook-Signature', signed.signature)
            .set('X-Twilio-Email-Event-Webhook-Timestamp', signed.timestamp)
            .send(signed.payload);

        expect(res.status).toBe(200);
        expect(res.body.inserted).toBe(1);
        expect(res.body.skipped).toBe(0);

        const lookupSql = mockQuery.mock.calls[0][0];
        expect(lookupSql).toMatch(/FROM oe\.MessageHistory/i);
        expect(lookupSql).toMatch(/ProviderMessageId = @kExact/);
        expect(lookupSql).toMatch(/ProviderMessageId LIKE @kLike/);

        const insertSql = mockQuery.mock.calls[1][0];
        expect(insertSql).toMatch(/INSERT INTO oe\.MessageEvent/i);

        // The resolved MessageId should have been bound as the @messageId input.
        const messageIdBinding = mockInput.mock.calls.find(c => c[0] === 'messageId');
        expect(messageIdBinding).toBeTruthy();
        expect(messageIdBinding[2]).toBe(resolvedMessageId);
    });

    test('skips when sg_message_id is present but has no matching MessageHistory row', async () => {
        // Lookup returns empty recordset; insert should not run.
        mockQuery.mockResolvedValue({ recordset: [] });

        const events = [
            {
                event: 'delivered',
                sg_event_id: 'evt-no-match',
                sg_message_id: 'does-not-exist.recvd-zzz',
                timestamp: 1712000000
            }
        ];
        const signed = signPayload(events);
        process.env.SENDGRID_WEBHOOK_PUBLIC_KEY = signed.publicKeyPem;

        const app = makeApp();
        const res = await request(app)
            .post('/api/webhooks/sendgrid/events')
            .set('Content-Type', 'application/json')
            .set('X-Twilio-Email-Event-Webhook-Signature', signed.signature)
            .set('X-Twilio-Email-Event-Webhook-Timestamp', signed.timestamp)
            .send(signed.payload);

        expect(res.status).toBe(200);
        expect(res.body.inserted).toBe(0);
        expect(res.body.skipped).toBe(1);

        // No INSERT call should have fired.
        const insertCalls = mockQuery.mock.calls.filter(c => /INSERT INTO oe\.MessageEvent/i.test(c[0]));
        expect(insertCalls).toHaveLength(0);
    });
});
