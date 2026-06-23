/**
 * overdueInvoiceReminder.service — recordSend behavior + selection-input
 * validation. The selection query itself is integration-tested live against
 * a test tenant per the verification plan; here we pin the predicate-input
 * guards and the idempotency path through recordSend.
 *
 * Run: npx jest overdueInvoiceReminder.service
 */

jest.mock('../../config/database', () => {
  const mssql = require('mssql');
  return {
    sql: mssql,
    getPool: jest.fn()
  };
});

const { getPool } = require('../../config/database');
const reminderService = require('../overdueInvoiceReminder.service');

function buildRequest(queryImpl) {
  const req = {};
  req.input = jest.fn().mockReturnValue(req);
  req.query = jest.fn(queryImpl);
  return req;
}

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

beforeEach(() => {
  jest.clearAllMocks();
});

const VALID_BASE = {
  tenantId: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
  invoiceId: '11111111-2222-3333-4444-555555555555',
  attemptNumber: 1,
  channel: 'Email',
  recipientType: 'MemberPrimary',
  recipientAddress: 'primary@example.com',
  queuedMessageId: '99999999-9999-9999-9999-999999999999',
  status: 'Queued',
  daysOverdueAtSend: 14,
  createdBy: null,
  skipReason: null
};

describe('selectCandidatesForTenant validation', () => {
  test('throws on missing thresholdDays', async () => {
    await expect(
      reminderService.selectCandidatesForTenant(VALID_BASE.tenantId, {
        cadenceDays: 7,
        maxCount: 4
      })
    ).rejects.toThrow(/thresholdDays/);
  });

  test('throws on cadenceDays < 1', async () => {
    await expect(
      reminderService.selectCandidatesForTenant(VALID_BASE.tenantId, {
        thresholdDays: 14,
        cadenceDays: 0,
        maxCount: 4
      })
    ).rejects.toThrow(/cadenceDays/);
  });

  test('throws on maxCount < 1', async () => {
    await expect(
      reminderService.selectCandidatesForTenant(VALID_BASE.tenantId, {
        thresholdDays: 14,
        cadenceDays: 7,
        maxCount: 0
      })
    ).rejects.toThrow(/maxCount/);
  });

  test('returns mapped candidates with derived nextAttemptNumber + recipientType', async () => {
    const recordset = [
      {
        InvoiceId: '11111111-2222-3333-4444-555555555555',
        HouseholdId: 'HHHH',
        GroupId: null,
        InvoiceNumber: 'INV-1',
        BalanceDue: 100,
        DueDate: new Date('2026-04-01'),
        DaysOverdue: 30,
        PriorSendCount: 1,
        LastSentUtc: new Date('2026-04-25'),
        MemberEmail: 'a@b.com',
        MemberPhone: '+15551234567',
        MemberFirstName: 'Stan',
        MemberSmsConsent: 'Y'
      },
      {
        InvoiceId: '22222222-3333-4444-5555-666666666666',
        HouseholdId: null,
        GroupId: 'GGGG',
        InvoiceNumber: 'INV-2',
        BalanceDue: 500,
        DueDate: new Date('2026-04-10'),
        DaysOverdue: 21,
        PriorSendCount: 0,
        LastSentUtc: null,
        GroupName: 'Acme Co',
        GroupContactEmail: 'billing@acme.com'
      }
    ];
    const req = buildRequest(async () => ({ recordset }));
    getPool.mockResolvedValue({ request: () => req });

    const out = await reminderService.selectCandidatesForTenant(VALID_BASE.tenantId, {
      thresholdDays: 14,
      cadenceDays: 7,
      maxCount: 4,
      skipUnderAmount: 0
    });

    expect(out).toHaveLength(2);
    expect(out[0].nextAttemptNumber).toBe(2);
    expect(out[0].recipientType).toBe('MemberPrimary');
    expect(out[1].nextAttemptNumber).toBe(1);
    expect(out[1].recipientType).toBe('GroupBilling');

    // Tenant isolation: every parameter binding must include @tenantId.
    const inputCalls = req.input.mock.calls.map((c) => c[0]);
    expect(inputCalls).toContain('tenantId');

    const sqlText = req.query.mock.calls[0][0];
    expect(sqlText).toMatch(/pmUser\.TenantId\s*=\s*@tenantId/);
    expect(sqlText).not.toMatch(/\npm\.TenantId\s*=\s*@tenantId/);
    expect(sqlText).toMatch(/HasActivePaymentMethodOnFile/);
    expect(sqlText).toMatch(/MemberUserId/);
    expect(sqlText).toMatch(/N'Partial'/);
    expect(sqlText).not.toMatch(/i\.Status\s*=\s*N'Overdue'/);
  });
});

describe('recordSend', () => {
  test('inserts row and returns ok', async () => {
    const req = buildRequest(async () => ({ rowsAffected: [1] }));
    getPool.mockResolvedValue({ request: () => req });

    const out = await reminderService.recordSend({ ...VALID_BASE });
    expect(out).toEqual({ ok: true });
    const inputs = req.input.mock.calls.map(([k]) => k);
    expect(inputs).toEqual(
      expect.arrayContaining([
        'tenantId',
        'invoiceId',
        'attemptNumber',
        'channel',
        'recipientType',
        'recipientAddress',
        'status',
        'daysOverdueAtSend'
      ])
    );
  });

  test('detects unique-constraint violation as duplicate (idempotent)', async () => {
    const req = buildRequest(async () => {
      const err = new Error('Violation of UNIQUE KEY constraint');
      err.number = 2627;
      throw err;
    });
    getPool.mockResolvedValue({ request: () => req });

    const out = await reminderService.recordSend({ ...VALID_BASE });
    expect(out).toEqual({ ok: false, duplicate: true });
  });

  test('detects 2601 (also unique-violation) as duplicate', async () => {
    const req = buildRequest(async () => {
      const err = new Error('Cannot insert duplicate key row');
      err.number = 2601;
      throw err;
    });
    getPool.mockResolvedValue({ request: () => req });

    const out = await reminderService.recordSend({ ...VALID_BASE });
    expect(out).toEqual({ ok: false, duplicate: true });
  });

  test('returns generic error for unrelated DB failure', async () => {
    const req = buildRequest(async () => {
      const err = new Error('connection lost');
      err.number = 4060;
      throw err;
    });
    getPool.mockResolvedValue({ request: () => req });

    const out = await reminderService.recordSend({ ...VALID_BASE });
    expect(out.ok).toBe(false);
    expect(out.duplicate).toBeUndefined();
    expect(out.error).toMatch(/connection lost/);
  });

  test('rejects invalid channel', async () => {
    await expect(
      reminderService.recordSend({ ...VALID_BASE, channel: 'Pigeon' })
    ).rejects.toThrow(/channel invalid/);
  });

  test('rejects invalid status', async () => {
    await expect(
      reminderService.recordSend({ ...VALID_BASE, status: 'Maybe' })
    ).rejects.toThrow(/status invalid/);
  });

  test('rejects invalid recipientType', async () => {
    await expect(
      reminderService.recordSend({ ...VALID_BASE, recipientType: 'Stranger' })
    ).rejects.toThrow(/recipientType invalid/);
  });

  test('rejects attemptNumber < 1', async () => {
    await expect(
      reminderService.recordSend({ ...VALID_BASE, attemptNumber: 0 })
    ).rejects.toThrow(/attemptNumber invalid/);
  });
});
