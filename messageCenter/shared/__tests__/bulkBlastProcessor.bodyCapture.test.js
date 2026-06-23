/**
 * Unit tests for bulkBlastProcessor Body/FromAddress capture + custom_args tagging.
 *
 * These tests mock @sendgrid/mail, twilio, and the mssql-backed helpers via the
 * ./tenantMessaging module. They focus on wiring, not DB persistence.
 */

jest.mock('@sendgrid/mail', () => ({
  send: jest.fn(() => Promise.resolve([{ statusCode: 202, headers: { 'x-message-id': 'test-provider-id' } }]))
}));

jest.mock('twilio', () => jest.fn(() => ({
  messages: { create: jest.fn() }
})));

jest.mock('../tenantMessaging', () => ({
  ensureConnected: jest.fn(async () => {}),
  resolveSendFromStrict: jest.fn(async () => ({
    fromName: 'Test Tenant',
    fromEmail: 'noreply@example.com'
  })),
  resolveSmsFromStrict: jest.fn(async () => '+15551234567'),
  formatPhone: (p) => p,
  NULL_RECIPIENT_SENTINEL: '00000000-0000-0000-0000-000000000000'
}));

jest.mock('../emailContent', () => ({
  buildEmailHtmlParts: jest.fn(() => ({
    emailText: 'hello text',
    emailHtml: '<p>hello html</p>',
    replyToParam: null,
    metaFromQueue: {}
  }))
}));

const sgMail = require('@sendgrid/mail');
const { processBulkBatch } = require('../bulkBlastProcessor');

function makePoolStub() {
  const insertCalls = [];
  const request = {
    input: jest.fn(function (name, type, value) {
      this._inputs = this._inputs || {};
      this._inputs[name] = value;
      return this;
    }),
    query: jest.fn(async function (sqlText) {
      insertCalls.push({ sql: sqlText, inputs: { ...this._inputs } });
      this._inputs = {};
      return { recordset: [] };
    })
  };
  const pool = {
    connected: true,
    request: () => ({ ...request, _inputs: {} })
  };
  // share state via closure
  pool.__insertCalls = insertCalls;
  pool.request = () => {
    const fresh = {
      _inputs: {},
      input(name, type, value) { this._inputs[name] = value; return this; },
      async query(sqlText) {
        insertCalls.push({ sql: sqlText, inputs: { ...this._inputs } });
        return { recordset: [] };
      }
    };
    return fresh;
  };
  return { pool, insertCalls };
}

describe('processBulkBatch — Body/FromAddress capture + custom_args.MessageId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sgMail.send.mockResolvedValue([{ statusCode: 202, headers: { 'x-message-id': 'test-provider-id' } }]);
  });

  test('each personalization carries a valid UUID custom_args.MessageId', async () => {
    const { pool } = makePoolStub();
    const context = { log: Object.assign(() => {}, { warn: () => {}, error: () => {} }) };
    const payload = {
      v: 1,
      batchId: '11111111-1111-1111-1111-111111111111',
      tenantId: '22222222-2222-2222-2222-222222222222',
      subject: 'Hello',
      emailBody: '<p>hello</p>',
      sendEmail: true,
      emails: ['a@example.com', 'b@example.com', 'c@example.com']
    };

    await processBulkBatch(context, pool, {
      MessageId: '33333333-3333-3333-3333-333333333333',
      RetryCount: 0,
      Body: JSON.stringify(payload)
    });

    expect(sgMail.send).toHaveBeenCalledTimes(1);
    const callArg = sgMail.send.mock.calls[0][0];
    expect(callArg.personalizations).toHaveLength(3);
    const messageIds = new Set();
    for (const p of callArg.personalizations) {
      expect(p).toHaveProperty('custom_args');
      expect(p.custom_args).toHaveProperty('MessageId');
      expect(p.custom_args.MessageId).toMatch(/^[0-9a-f-]{36}$/i);
      messageIds.add(p.custom_args.MessageId);
    }
    // Ensure each recipient gets its own unique MessageId
    expect(messageIds.size).toBe(3);
  });

  test('MessageHistory inserts include Body and FromAddress values', async () => {
    const { pool, insertCalls } = makePoolStub();
    const context = { log: Object.assign(() => {}, { warn: () => {}, error: () => {} }) };
    const payload = {
      v: 1,
      batchId: '11111111-1111-1111-1111-111111111111',
      tenantId: '22222222-2222-2222-2222-222222222222',
      subject: 'Hello',
      emailBody: '<p>hello</p>',
      sendEmail: true,
      emails: ['a@example.com']
    };

    await processBulkBatch(context, pool, {
      MessageId: '33333333-3333-3333-3333-333333333333',
      RetryCount: 0,
      Body: JSON.stringify(payload)
    });

    const historyInserts = insertCalls.filter((c) => /INSERT INTO oe\.MessageHistory/.test(c.sql));
    expect(historyInserts.length).toBeGreaterThan(0);
    for (const call of historyInserts) {
      expect(call.sql).toMatch(/Body, FromAddress/);
      expect(call.inputs).toHaveProperty('Body');
      expect(call.inputs).toHaveProperty('FromAddress');
      expect(call.inputs.Body).toBe('<p>hello html</p>');
      expect(call.inputs.FromAddress).toBe('noreply@example.com');
    }
  });

  test('uses the same MessageId for personalization and the matching MessageHistory row', async () => {
    const { pool, insertCalls } = makePoolStub();
    const context = { log: Object.assign(() => {}, { warn: () => {}, error: () => {} }) };
    const payload = {
      v: 1,
      batchId: '11111111-1111-1111-1111-111111111111',
      tenantId: '22222222-2222-2222-2222-222222222222',
      subject: 'Hello',
      emailBody: '<p>hello</p>',
      sendEmail: true,
      emails: ['a@example.com', 'b@example.com']
    };

    await processBulkBatch(context, pool, {
      MessageId: '33333333-3333-3333-3333-333333333333',
      RetryCount: 0,
      Body: JSON.stringify(payload)
    });

    const callArg = sgMail.send.mock.calls[0][0];
    const sentMessageIdsByEmail = new Map();
    for (const p of callArg.personalizations) {
      sentMessageIdsByEmail.set(p.to[0].email, p.custom_args.MessageId);
    }

    const historyInserts = insertCalls.filter((c) => /INSERT INTO oe\.MessageHistory/.test(c.sql));
    const historyIdsByEmail = new Map();
    for (const call of historyInserts) {
      historyIdsByEmail.set(call.inputs.RecipientAddress, call.inputs.MessageId);
    }

    for (const [email, id] of sentMessageIdsByEmail.entries()) {
      expect(historyIdsByEmail.get(email)).toBe(id);
    }
  });
});
