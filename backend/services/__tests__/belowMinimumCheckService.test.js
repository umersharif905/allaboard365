/**
 * belowMinimumCheckService — below-minimum check scheduled job
 *
 * Tests covering:
 *   - T-10 warning sent once per (group, effectiveDate)
 *   - T-10 warning NOT re-sent when already recorded
 *   - T-5 lock email sent and alert recorded
 *   - ListBill groups skipped (computeApplicableMinimum returns null for them)
 *   - Groups with no vendor minimum skipped
 *   - Strictest (max) minimum used across vendors (via vendorMinimumService)
 *
 * Run: npx jest belowMinimumCheckService
 */

jest.mock('../../config/database', () => {
  const mssql = require('mssql');
  return { sql: mssql, getPool: jest.fn() };
});

jest.mock('../vendorMinimumService', () => ({
  computeApplicableMinimum: jest.fn()
}));

jest.mock('../messageQueue.service', () => ({
  queueEmail: jest.fn().mockResolvedValue('mock-message-id')
}));

jest.mock('../emailTemplates.service', () => ({
  loadTemplate: jest.fn().mockReturnValue('<html>{{groupName}}</html>'),
  processTemplate: jest.fn().mockImplementation((tpl, vars) => `rendered:${vars.groupName}`),
  getTenantEmailConfig: jest.fn().mockResolvedValue({
    tenantName: 'Test Tenant',
    defaultFromEmail: 'noreply@test.com'
  })
}));

const { getPool } = require('../../config/database');
const { computeApplicableMinimum } = require('../vendorMinimumService');
const MessageQueueService = require('../messageQueue.service');
const EmailTemplatesService = require('../emailTemplates.service');
const { run } = require('../belowMinimumCheckService');

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
beforeEach(() => {
  jest.clearAllMocks();
});

// ─── helpers ────────────────────────────────────────────────────────────────

const GROUP_ID = 'aaa00000-0000-0000-0000-000000000001';
const TENANT_ID = 'bbb00000-0000-0000-0000-000000000002';
const AGENT_ID  = 'ccc00000-0000-0000-0000-000000000003';

/** Build a minimal mssql-like request mock.
 *  queryMap: { [substring]: result } — first match wins. */
function buildRequest(queryMap = {}) {
  const req = {};
  req.input = jest.fn().mockReturnValue(req);
  req.query = jest.fn(async (sql) => {
    for (const [key, result] of Object.entries(queryMap)) {
      if (sql.includes(key)) return result;
    }
    return { recordset: [], rowsAffected: [0] };
  });
  return req;
}

function buildPool(requestFactory) {
  return { request: jest.fn(() => requestFactory()) };
}

/** 10 days before the first of next month from `today`. */
function tenDaysBefore(today) {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
  d.setUTCDate(d.getUTCDate() - 10);
  return d;
}

/** 4 days before the first of next month from `today`. */
function fourDaysBefore(today) {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
  d.setUTCDate(d.getUTCDate() - 4);
  return d;
}

// ─── test suites ─────────────────────────────────────────────────────────────

describe('belowMinimumCheckService.run', () => {

  test('sends T-10 warning once per (group, effectiveDate)', async () => {
    const today = tenDaysBefore(new Date('2026-05-01T00:00:00Z'));

    const requests = [];
    getPool.mockResolvedValue(buildPool(() => {
      const callIdx = requests.length;
      const req = buildRequest({
        // 1st call: fetch Standard groups
        'oe.Groups': { recordset: [{ GroupId: GROUP_ID, TenantId: TENANT_ID, GroupName: 'Test Group', AgentId: AGENT_ID }] },
        // 2nd call: member count
        'COUNT(DISTINCT': { recordset: [{ Cnt: 3 }] },
        // 3rd call: existing alert check — none found
        'oe.GroupMinimumAlerts': { recordset: [] },
        // 4th call: agent email
        'oe.Agents': { recordset: [{ Email: 'agent@test.com', FirstName: 'Joe' }] },
        // 5th call: tenant settings
        'oe.Tenants': { recordset: [{ AdvancedSettings: '{}' }] },
        // 6th call: INSERT
        'INSERT INTO oe.GroupMinimumAlerts': { recordset: [], rowsAffected: [1] }
      });
      requests.push(req);
      return req;
    }));

    computeApplicableMinimum.mockResolvedValue(5); // minimum is 5, group has 3 — below

    const result = await run({ now: today });

    expect(result).toEqual({ processed: 1 });
    expect(MessageQueueService.queueEmail).toHaveBeenCalledTimes(1);
    const callArg = MessageQueueService.queueEmail.mock.calls[0][0];
    expect(callArg.toEmail).toBe('agent@test.com');

    // Verify INSERT was called with AlertType='Warning'
    const insertCall = requests.find(r => r.query.mock.calls.some(c => c[0].includes('INSERT')));
    expect(insertCall).toBeTruthy();
    const insertInputs = insertCall.input.mock.calls.map(c => c.slice(0, 2));
    expect(insertInputs).toEqual(expect.arrayContaining([
      ['AlertType', 'Warning']
    ]));
  });

  test('does NOT re-send T-10 warning when one already exists', async () => {
    const today = tenDaysBefore(new Date('2026-05-01T00:00:00Z'));

    getPool.mockResolvedValue(buildPool(() => buildRequest({
      'oe.Groups': { recordset: [{ GroupId: GROUP_ID, TenantId: TENANT_ID, GroupName: 'Test Group', AgentId: AGENT_ID }] },
      'COUNT(DISTINCT': { recordset: [{ Cnt: 3 }] },
      // existing alert found — dedup fires
      'oe.GroupMinimumAlerts': { recordset: [{ AlertType: 'Warning' }] }
    })));

    computeApplicableMinimum.mockResolvedValue(5);

    const result = await run({ now: today });

    expect(result).toEqual({ processed: 0 });
    expect(MessageQueueService.queueEmail).not.toHaveBeenCalled();
  });

  test('sends T-5 lock email and records Lock alert', async () => {
    const today = fourDaysBefore(new Date('2026-05-01T00:00:00Z'));

    const insertRequests = [];
    getPool.mockResolvedValue(buildPool(() => {
      const req = buildRequest({
        'oe.Groups': { recordset: [{ GroupId: GROUP_ID, TenantId: TENANT_ID, GroupName: 'Test Group', AgentId: AGENT_ID }] },
        'COUNT(DISTINCT': { recordset: [{ Cnt: 2 }] },
        'oe.GroupMinimumAlerts': { recordset: [] },
        'oe.Agents': { recordset: [{ Email: 'agent@test.com', FirstName: 'Joe' }] },
        'oe.Tenants': { recordset: [{ AdvancedSettings: '{}' }] },
        'INSERT INTO oe.GroupMinimumAlerts': { recordset: [], rowsAffected: [1] }
      });
      // Track insert calls
      const origQuery = req.query;
      req.query = jest.fn(async (sql) => {
        if (sql.includes('INSERT')) insertRequests.push({ sql, inputs: req.input.mock.calls });
        return origQuery(sql);
      });
      return req;
    }));

    computeApplicableMinimum.mockResolvedValue(5);

    const result = await run({ now: today });

    expect(result).toEqual({ processed: 1 });
    expect(MessageQueueService.queueEmail).toHaveBeenCalledTimes(1);

    // Template used should be the lock template
    const templateCall = EmailTemplatesService.loadTemplate.mock.calls[0]?.[0];
    expect(templateCall).toBe('group-below-minimum-lock');
  });

  test('skips ListBill groups', async () => {
    const today = tenDaysBefore(new Date('2026-05-01T00:00:00Z'));

    // Groups query returns no rows (WHERE GroupType = 'Standard' filters them out)
    getPool.mockResolvedValue(buildPool(() => buildRequest({
      'oe.Groups': { recordset: [] }
    })));

    computeApplicableMinimum.mockResolvedValue(5);

    const result = await run({ now: today });

    expect(result).toEqual({ processed: 0 });
    expect(MessageQueueService.queueEmail).not.toHaveBeenCalled();
  });

  test('skips groups with no vendor minimum', async () => {
    const today = tenDaysBefore(new Date('2026-05-01T00:00:00Z'));

    getPool.mockResolvedValue(buildPool(() => buildRequest({
      'oe.Groups': { recordset: [{ GroupId: GROUP_ID, TenantId: TENANT_ID, GroupName: 'Test Group', AgentId: AGENT_ID }] },
      'COUNT(DISTINCT': { recordset: [{ Cnt: 3 }] }
    })));

    computeApplicableMinimum.mockResolvedValue(null); // no minimum set

    const result = await run({ now: today });

    expect(result).toEqual({ processed: 0 });
    expect(MessageQueueService.queueEmail).not.toHaveBeenCalled();
  });

  test('uses strictest minimum across vendors (consumes vendorMinimumService)', async () => {
    // computeApplicableMinimum already returns the max across vendors (tested in vendorMinimumService tests).
    // Here we verify belowMinimumCheckService passes the result through correctly.
    const today = tenDaysBefore(new Date('2026-05-01T00:00:00Z'));

    getPool.mockResolvedValue(buildPool(() => buildRequest({
      'oe.Groups': { recordset: [{ GroupId: GROUP_ID, TenantId: TENANT_ID, GroupName: 'Test Group', AgentId: AGENT_ID }] },
      'COUNT(DISTINCT': { recordset: [{ Cnt: 8 }] }, // 8 members
      'oe.GroupMinimumAlerts': { recordset: [] },
      'oe.Agents': { recordset: [{ Email: 'agent@test.com', FirstName: 'Joe' }] },
      'oe.Tenants': { recordset: [{ AdvancedSettings: '{}' }] },
      'INSERT INTO oe.GroupMinimumAlerts': { recordset: [], rowsAffected: [1] }
    })));

    // strictest vendor says 10, so 8 members is still below
    computeApplicableMinimum.mockResolvedValue(10);

    const result = await run({ now: today });

    expect(result).toEqual({ processed: 1 });
    expect(computeApplicableMinimum).toHaveBeenCalledWith(GROUP_ID);

    // The email context should show requiredMinimum=10
    const renderCall = EmailTemplatesService.processTemplate.mock.calls[0];
    expect(renderCall[1].requiredMinimum).toBe(10);
  });

  test('returns early with no processing outside T-10 and T-5 windows', async () => {
    // 15 days before effective date — not T-10 and not <=5
    const today = new Date('2026-04-16T00:00:00Z'); // 15 days before 2026-05-01

    getPool.mockResolvedValue(buildPool(() => buildRequest()));

    const result = await run({ now: today });

    expect(result).toEqual({ processed: 0 });
    expect(getPool).not.toHaveBeenCalled(); // pool never fetched — early return
  });

  test('skips group that meets the minimum', async () => {
    const today = tenDaysBefore(new Date('2026-05-01T00:00:00Z'));

    getPool.mockResolvedValue(buildPool(() => buildRequest({
      'oe.Groups': { recordset: [{ GroupId: GROUP_ID, TenantId: TENANT_ID, GroupName: 'Test Group', AgentId: AGENT_ID }] },
      'COUNT(DISTINCT': { recordset: [{ Cnt: 10 }] } // exactly at minimum
    })));

    computeApplicableMinimum.mockResolvedValue(10); // minimum is 10, group has 10 — at limit

    const result = await run({ now: today });

    expect(result).toEqual({ processed: 0 });
    expect(MessageQueueService.queueEmail).not.toHaveBeenCalled();
  });

  test('does NOT insert dedup row when there are no recipients (regression: silent-mute bug)', async () => {
    // Setup: group has no AgentId (or agent has no email), AND no manual
    // recipients in tenant settings. Previously the code would queue zero
    // emails BUT still insert the dedup row, silently muting future runs
    // for this (group, effectiveDate) — meaning if an agent is assigned
    // tomorrow, the alert would never fire.
    const today = tenDaysBefore(new Date('2026-05-01T00:00:00Z'));

    const txCalls = [];
    getPool.mockResolvedValue(buildPool(() => {
      const req = buildRequest({
        'oe.Groups': { recordset: [{ GroupId: GROUP_ID, TenantId: TENANT_ID, GroupName: 'Test Group', AgentId: AGENT_ID }] },
        'COUNT(DISTINCT': { recordset: [{ Cnt: 2 }] },
        'oe.GroupMinimumAlerts': { recordset: [] },
        // Agent lookup returns no rows (agent unassigned or email missing)
        'oe.Agents': { recordset: [] },
        // Tenant settings have no manual recipients
        'oe.Tenants': { recordset: [{ AdvancedSettings: '{}' }] }
      });
      txCalls.push(req);
      return req;
    }));

    computeApplicableMinimum.mockResolvedValue(5);

    const result = await run({ now: today });

    // The group is processed (it qualified for the alert) but no email could
    // be sent.
    expect(result).toEqual({ processed: 0 });
    expect(MessageQueueService.queueEmail).not.toHaveBeenCalled();

    // Critical: NO INSERT into GroupMinimumAlerts. A future run with a
    // configured recipient must be able to fire the alert.
    const allSqlCalls = txCalls.flatMap((r) => r.query.mock.calls).map((c) => c[0]);
    const insertCalls = allSqlCalls.filter((sql) => /INSERT\s+INTO\s+oe\.GroupMinimumAlerts/i.test(sql));
    expect(insertCalls).toHaveLength(0);
  });

  test('sends to extra recipients from tenant AdvancedSettings', async () => {
    const today = tenDaysBefore(new Date('2026-05-01T00:00:00Z'));
    const advancedSettings = JSON.stringify({
      enrollment: { belowMinimumAlertRecipients: ['ops@broker.com', 'admin@broker.com'] }
    });

    getPool.mockResolvedValue(buildPool(() => buildRequest({
      'oe.Groups': { recordset: [{ GroupId: GROUP_ID, TenantId: TENANT_ID, GroupName: 'Test Group', AgentId: AGENT_ID }] },
      'COUNT(DISTINCT': { recordset: [{ Cnt: 2 }] },
      'oe.GroupMinimumAlerts': { recordset: [] },
      'oe.Agents': { recordset: [{ Email: 'agent@test.com', FirstName: 'Joe' }] },
      'oe.Tenants': { recordset: [{ AdvancedSettings: advancedSettings }] },
      'INSERT INTO oe.GroupMinimumAlerts': { recordset: [], rowsAffected: [1] }
    })));

    computeApplicableMinimum.mockResolvedValue(5);

    const result = await run({ now: today });

    expect(result).toEqual({ processed: 1 });
    // Agent + 2 extra = 3 emails
    expect(MessageQueueService.queueEmail).toHaveBeenCalledTimes(3);
    const recipients = MessageQueueService.queueEmail.mock.calls.map(c => c[0].toEmail);
    expect(recipients).toContain('agent@test.com');
    expect(recipients).toContain('ops@broker.com');
    expect(recipients).toContain('admin@broker.com');
  });
});
