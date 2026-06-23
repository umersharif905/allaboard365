/**
 * notificationService — in-app notifications backed by oe.Notifications.
 *
 * Pins:
 *   - createNotifications: filters invalid rows, inserts one per row, best-effort
 *     (an insert failure — e.g. missing table — never throws, just lowers count)
 *   - createMentionNotifications: resolves a friendly label, writes one 'mention'
 *     row per validated recipient
 *   - createFormSubmissionNotifications: fans out one deduped 'form-submission'
 *     row per active vendor user
 *   - listForVendorUser: maps rows to the bell shape + returns unread count,
 *     scoped to recipient + vendor
 *   - markRead / markAllRead: scoped UPDATEs returning rows affected
 *
 * Run: npx jest notificationService
 */

jest.mock('../../config/database', () => {
  const mssql = require('mssql');
  return { sql: mssql, getPool: jest.fn() };
});

const { getPool } = require('../../config/database');
const notificationService = require('../notificationService');

/**
 * Build a mock pool whose request().input(...).query(text) is routed through
 * `dispatch(text, inputs)`. Every captured (text, inputs) pair is recorded in
 * `calls` so tests can assert what SQL ran and with which params.
 */
function makePool(dispatch) {
  const calls = [];
  const pool = {
    calls,
    request: jest.fn(() => {
      const inputs = {};
      const req = {
        input(name, _type, value) {
          inputs[name] = value;
          return req;
        },
        query: jest.fn(async (text) => {
          calls.push({ text, inputs });
          return dispatch(text, inputs);
        })
      };
      return req;
    })
  };
  return pool;
}

const insertCalls = (pool) =>
  pool.calls.filter((c) => /INSERT INTO oe\.Notifications/i.test(c.text));

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  console.log.mockRestore?.();
  console.error.mockRestore?.();
  console.warn.mockRestore?.();
});
beforeEach(() => jest.clearAllMocks());

describe('createNotifications', () => {
  it('inserts one row per valid row and skips rows missing recipient/type', async () => {
    const pool = makePool(() => ({ recordset: [], rowsAffected: [1] }));
    getPool.mockResolvedValue(pool);

    const { created } = await notificationService.createNotifications([
      { recipientUserId: 'u1', type: 'mention' },
      { recipientUserId: 'u2', type: 'mention' },
      { recipientUserId: '', type: 'mention' }, // dropped — no recipient
      { recipientUserId: 'u3' } // dropped — no type
    ]);

    expect(created).toBe(2);
    expect(insertCalls(pool)).toHaveLength(2);
  });

  it('is best-effort: an insert failure does not throw and lowers the count', async () => {
    const pool = makePool(() => {
      throw new Error("Invalid object name 'oe.Notifications'.");
    });
    getPool.mockResolvedValue(pool);

    await expect(
      notificationService.createNotifications([{ recipientUserId: 'u1', type: 'mention' }])
    ).resolves.toEqual({ created: 0 });
  });
});

describe('createMentionNotifications', () => {
  it('resolves a label and writes one mention row per recipient', async () => {
    const pool = makePool((text) => {
      if (/FROM oe\.ShareRequests/i.test(text)) {
        return { recordset: [{ Label: 'SR-1042' }] };
      }
      return { recordset: [], rowsAffected: [1] };
    });
    getPool.mockResolvedValue(pool);

    const { created } = await notificationService.createMentionNotifications({
      recipients: [{ UserId: 'u1' }, { UserId: 'u2' }],
      vendorId: 'v1',
      tenantId: 't1',
      contextType: 'share-request',
      contextId: 'sr1',
      actorUserId: 'author1',
      actorName: 'Jane Doe',
      body: 'hey @John can you look',
      href: '/vendor/share-requests/sr1?tab=notes'
    });

    expect(created).toBe(2);
    const inserts = insertCalls(pool);
    expect(inserts).toHaveLength(2);
    expect(inserts[0].inputs.type).toBe('mention');
    expect(inserts[0].inputs.contextLabel).toBe('SR-1042');
    expect(inserts[0].inputs.recipientUserId).toBe('u1');
    expect(inserts[1].inputs.recipientUserId).toBe('u2');
  });

  it('uses the Cases label query for case mentions', async () => {
    let labelQuery = null;
    const pool = makePool((text) => {
      if (/CaseNumber/i.test(text)) {
        labelQuery = text;
        return { recordset: [{ Label: 'CASE-7' }] };
      }
      return { recordset: [], rowsAffected: [1] };
    });
    getPool.mockResolvedValue(pool);

    const { created } = await notificationService.createMentionNotifications({
      recipients: [{ UserId: 'u1' }],
      vendorId: 'v1',
      contextType: 'case',
      contextId: 'c1',
      actorUserId: 'a1',
      body: 'note',
      href: '/vendor/cases/c1?tab=notes'
    });

    expect(created).toBe(1);
    expect(labelQuery).toMatch(/FROM oe\.Cases/i);
    expect(insertCalls(pool)[0].inputs.contextType).toBe('case');
  });

  it('no-ops with no recipients', async () => {
    getPool.mockResolvedValue(makePool(() => ({ recordset: [] })));
    await expect(
      notificationService.createMentionNotifications({
        recipients: [],
        contextId: 'sr1',
        contextType: 'share-request'
      })
    ).resolves.toEqual({ created: 0 });
  });
});

describe('createFormSubmissionNotifications', () => {
  it('fans out one deduped row per active vendor user', async () => {
    const pool = makePool((text) => {
      if (/FROM oe\.Users/i.test(text)) {
        return { recordset: [{ UserId: 'u1' }, { UserId: 'u2' }, { UserId: 'u3' }] };
      }
      return { recordset: [], rowsAffected: [1] };
    });
    getPool.mockResolvedValue(pool);

    const { created } = await notificationService.createFormSubmissionNotifications({
      vendorId: 'v1',
      tenantId: 't1',
      submissionId: 'sub1',
      formTitle: 'Intake Form'
    });

    expect(created).toBe(3);
    const inserts = insertCalls(pool);
    expect(inserts).toHaveLength(3);
    // Fan-out inserts use the dedupe guard.
    expect(inserts[0].text).toMatch(/WHERE NOT EXISTS/i);
    expect(inserts[0].inputs.type).toBe('form-submission');
    expect(inserts[0].inputs.contextId).toBe('sub1');
    expect(inserts[0].inputs.href).toBe('/vendor/sharing-forms/submissions/sub1');
  });

  it('no-ops when the vendor has no active users', async () => {
    const pool = makePool((text) =>
      /FROM oe\.Users/i.test(text) ? { recordset: [] } : { recordset: [], rowsAffected: [0] }
    );
    getPool.mockResolvedValue(pool);

    const { created } = await notificationService.createFormSubmissionNotifications({
      vendorId: 'v1',
      submissionId: 'sub1'
    });
    expect(created).toBe(0);
    expect(insertCalls(pool)).toHaveLength(0);
  });
});

describe('listForVendorUser', () => {
  it('maps rows to the bell shape and returns the unread count', async () => {
    const row = {
      NotificationId: 'n1',
      Type: 'mention',
      ContextType: 'share-request',
      ContextId: 'sr1',
      ContextLabel: 'SR-1042',
      ActorName: 'Jane Doe',
      Body: 'hey look at this',
      Href: '/vendor/share-requests/sr1?tab=notes',
      IsRead: false,
      CreatedDate: '2026-05-23T10:00:00Z'
    };
    const pool = makePool((text) => {
      if (/COUNT\(\*\)/i.test(text)) return { recordset: [{ UnreadCount: 4 }] };
      return { recordset: [row] };
    });
    getPool.mockResolvedValue(pool);

    const { data, unreadCount } = await notificationService.listForVendorUser({
      userId: 'u1',
      vendorId: 'v1'
    });

    expect(unreadCount).toBe(4);
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      id: 'n1',
      type: 'mention',
      contextType: 'share-request',
      contextLabel: 'SR-1042',
      noteSnippet: 'hey look at this',
      createdByName: 'Jane Doe',
      href: '/vendor/share-requests/sr1?tab=notes',
      isRead: false
    });
    // Scoped to recipient + vendor.
    const listCall = pool.calls.find((c) => /SELECT TOP/i.test(c.text));
    expect(listCall.inputs.userId).toBe('u1');
    expect(listCall.inputs.vendorId).toBe('v1');
  });
});

describe('markRead', () => {
  it('updates only the given ids, scoped to recipient + vendor', async () => {
    const pool = makePool(() => ({ recordset: [], rowsAffected: [2] }));
    getPool.mockResolvedValue(pool);

    const { updated } = await notificationService.markRead({
      userId: 'u1',
      vendorId: 'v1',
      ids: ['n1', 'n2']
    });

    expect(updated).toBe(2);
    const call = pool.calls[0];
    expect(call.text).toMatch(/UPDATE oe\.Notifications/i);
    expect(call.inputs.userId).toBe('u1');
    expect(call.inputs.vendorId).toBe('v1');
    expect(call.inputs.n0).toBe('n1');
    expect(call.inputs.n1).toBe('n2');
  });

  it('no-ops (no query) when ids is empty', async () => {
    const pool = makePool(() => ({ recordset: [], rowsAffected: [0] }));
    getPool.mockResolvedValue(pool);

    const { updated } = await notificationService.markRead({ userId: 'u1', vendorId: 'v1', ids: [] });
    expect(updated).toBe(0);
    expect(pool.calls).toHaveLength(0);
  });
});

describe('markAllRead', () => {
  it('updates all unread rows for the recipient + vendor', async () => {
    const pool = makePool(() => ({ recordset: [], rowsAffected: [3] }));
    getPool.mockResolvedValue(pool);

    const { updated } = await notificationService.markAllRead({ userId: 'u1', vendorId: 'v1' });

    expect(updated).toBe(3);
    const call = pool.calls[0];
    expect(call.text).toMatch(/SET IsRead = 1/i);
    expect(call.text).toMatch(/IsRead = 0/i); // only flips unread
  });
});
