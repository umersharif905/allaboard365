/**
 * Tests for POST /api/webhooks/twilio/status (flag-gated Twilio status callback)
 *
 * Covers:
 *   - Rejects when TWILIO_AUTH_TOKEN is missing
 *   - Rejects invalid Twilio signature (via twilio.webhook middleware)
 *   - Accepts valid signed request and inserts a MessageEvent row
 *   - Idempotency SQL guard is in place
 */

const mockQuery = jest.fn();
const mockInput = jest.fn().mockReturnThis();
const mockRequest = { input: mockInput, query: mockQuery };
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
const supertest = require('supertest');
const twilio = require('twilio');
const twilioWebhookRoutes = require('../twilio');

function makeApp() {
    const app = express();
    app.use('/api/webhooks/twilio', twilioWebhookRoutes);
    return app;
}

describe('POST /api/webhooks/twilio/status', () => {
    const originalToken = process.env.TWILIO_AUTH_TOKEN;

    beforeEach(() => {
        mockQuery.mockReset();
        mockInput.mockClear();
        mockQuery.mockResolvedValue({ rowsAffected: [1] });
    });

    afterAll(() => {
        if (originalToken === undefined) {
            delete process.env.TWILIO_AUTH_TOKEN;
        } else {
            process.env.TWILIO_AUTH_TOKEN = originalToken;
        }
    });

    test('rejects when TWILIO_AUTH_TOKEN is missing', async () => {
        delete process.env.TWILIO_AUTH_TOKEN;
        const app = makeApp();
        const res = await supertest(app)
            .post('/api/webhooks/twilio/status')
            .type('form')
            .send({ MessageSid: 'SM1', MessageStatus: 'delivered' });
        expect(res.status).toBe(401);
        expect(mockQuery).not.toHaveBeenCalled();
    });

    test('rejects invalid Twilio signature', async () => {
        process.env.TWILIO_AUTH_TOKEN = 'fake-token';
        const app = makeApp();
        const res = await supertest(app)
            .post('/api/webhooks/twilio/status')
            .set('X-Twilio-Signature', 'not-a-real-signature')
            .type('form')
            .send({ MessageSid: 'SM1', MessageStatus: 'delivered' });
        expect(res.status).toBe(403);
        expect(mockQuery).not.toHaveBeenCalled();
    });

    test('accepts a validly-signed request and inserts an event row', async () => {
        const authToken = 'test-auth-token-abcdefg';
        process.env.TWILIO_AUTH_TOKEN = authToken;
        const messageId = '33333333-3333-3333-3333-333333333333';
        const params = { MessageSid: 'SM-ok-1', MessageStatus: 'delivered' };

        const server = makeApp().listen(0);
        try {
            const port = server.address().port;
            // Twilio's signature algorithm hashes the URL (including query string)
            // concatenated with each sorted POST param key+value. Use helper to
            // produce the signature the route's middleware will expect.
            const urlWithQuery = `http://127.0.0.1:${port}/api/webhooks/twilio/status?MessageId=${messageId}`;
            const signature = twilio.getExpectedTwilioSignature(authToken, urlWithQuery, params);

            const res = await supertest(server)
                .post('/api/webhooks/twilio/status')
                .set('X-Twilio-Signature', signature)
                .type('form')
                .query({ MessageId: messageId })
                .send(params);

            expect(res.status).toBe(200);
            expect(mockQuery).toHaveBeenCalledTimes(1);
            const sqlText = mockQuery.mock.calls[0][0];
            expect(sqlText).toMatch(/IF NOT EXISTS/i);
            expect(sqlText).toMatch(/INSERT INTO oe\.MessageEvent/i);
        } finally {
            server.close();
        }
    });
});
