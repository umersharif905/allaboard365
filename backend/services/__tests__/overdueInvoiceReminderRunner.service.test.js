/**
 * overdueInvoiceReminderRunner — settings parsing + tenant filter.
 *
 * Run: npx jest overdueInvoiceReminderRunner.service
 */

jest.mock('../../config/database', () => {
  const mssql = require('mssql');
  return { sql: mssql, getPool: jest.fn() };
});

const { getPool } = require('../../config/database');
const runner = require('../overdueInvoiceReminderRunner.service');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('parseSettings', () => {
  test('returns DEFAULT_SETTINGS with enabled=true for null/undefined input (opt-out semantics)', () => {
    const a = runner.parseSettings(null);
    expect(a.enabled).toBe(true);
    expect(a.thresholdDays).toBe(6);
    expect(a.cadenceDays).toBe(7);
    expect(a.maxCount).toBe(4);
    expect(a.channels).toEqual({ email: true, sms: false });

    const b = runner.parseSettings(undefined);
    expect(b.enabled).toBe(true);
  });

  test('returns DEFAULT_SETTINGS with enabled=true when overdueReminders block is missing', () => {
    const out = runner.parseSettings(JSON.stringify({ branding: {} }));
    expect(out.enabled).toBe(true);
    expect(out.thresholdDays).toBe(6);
  });

  test('explicit enabled=false silences feature', () => {
    expect(runner.parseSettings({
      billing: { overdueReminders: { enabled: false } }
    }).enabled).toBe(false);
  });

  test('parses string JSON correctly', () => {
    const json = JSON.stringify({
      billing: {
        overdueReminders: {
          enabled: true,
          thresholdDays: 21,
          cadenceDays: 5,
          maxCount: 3,
          skipUnderAmount: 10,
          channels: { email: true, sms: true },
          replyToEmail: 'billing@x.com'
        }
      }
    });
    const out = runner.parseSettings(json);
    expect(out).toMatchObject({
      enabled: true,
      thresholdDays: 21,
      cadenceDays: 5,
      maxCount: 3,
      skipUnderAmount: 10,
      channels: { email: true, sms: true },
      replyToEmail: 'billing@x.com'
    });
  });

  test('accepts already-parsed object', () => {
    const out = runner.parseSettings({
      billing: { overdueReminders: { enabled: true, thresholdDays: 14, cadenceDays: 7, maxCount: 4 } }
    });
    expect(out.enabled).toBe(true);
    expect(out.thresholdDays).toBe(14);
    // Defaults applied for missing fields
    expect(out.skipUnderAmount).toBe(0);
    expect(out.channels.email).toBe(true);
    expect(out.channels.sms).toBe(false);
  });

  test('only an explicit false silences (truthy / undefined / non-bool count as enabled)', () => {
    expect(runner.parseSettings({ billing: { overdueReminders: { enabled: false } } }).enabled).toBe(false);
    expect(runner.parseSettings({ billing: { overdueReminders: { enabled: true } } }).enabled).toBe(true);
    expect(runner.parseSettings({ billing: { overdueReminders: {} } }).enabled).toBe(true);
    expect(runner.parseSettings({ billing: { overdueReminders: { enabled: 'no' } } }).enabled).toBe(true); // not strict false
  });

  test('returns DEFAULT_SETTINGS on malformed JSON', () => {
    const out = runner.parseSettings('not-json{{');
    expect(out.enabled).toBe(true);
    expect(out.thresholdDays).toBe(6);
  });

  test('falls back to defaults when numeric fields are non-finite', () => {
    const out = runner.parseSettings({
      billing: {
        overdueReminders: {
          enabled: true,
          thresholdDays: 'banana',
          cadenceDays: NaN,
          maxCount: undefined,
          skipUnderAmount: 'free'
        }
      }
    });
    expect(out.thresholdDays).toBe(6);
    expect(out.cadenceDays).toBe(7);
    expect(out.maxCount).toBe(4);
    expect(out.skipUnderAmount).toBe(0);
  });

  test('replyToEmail trimmed; empty becomes null', () => {
    expect(runner.parseSettings({
      billing: { overdueReminders: { enabled: true, replyToEmail: '   ' } }
    }).replyToEmail).toBeNull();
    expect(runner.parseSettings({
      billing: { overdueReminders: { enabled: true, replyToEmail: '  a@b.com  ' } }
    }).replyToEmail).toBe('a@b.com');
  });
});

describe('listEnabledTenants — opt-out semantics', () => {
  test('default-enabled tenants (no settings, no JSON, malformed JSON) participate; explicit false excluded', async () => {
    const recordset = [
      {
        TenantId: 'TENANT-A',
        Name: 'Alpha',
        AdvancedSettings: JSON.stringify({
          billing: { overdueReminders: { enabled: true, thresholdDays: 14, cadenceDays: 7, maxCount: 4 } }
        })
      },
      {
        TenantId: 'TENANT-B',
        Name: 'Beta — explicitly off',
        AdvancedSettings: JSON.stringify({
          billing: { overdueReminders: { enabled: false } }
        })
      },
      {
        TenantId: 'TENANT-C',
        Name: 'Gamma — malformed JSON, defaults apply',
        AdvancedSettings: 'not json'
      },
      {
        TenantId: 'TENANT-D',
        Name: 'Delta — null AdvancedSettings, defaults apply',
        AdvancedSettings: null
      },
      {
        TenantId: 'TENANT-E',
        Name: 'Epsilon — has AdvancedSettings but no billing block, defaults apply',
        AdvancedSettings: JSON.stringify({ branding: { colors: {} } })
      }
    ];
    const req = { query: jest.fn(async () => ({ recordset })) };
    getPool.mockResolvedValue({ request: () => req });

    const out = await runner.listEnabledTenants();
    const ids = out.map((t) => t.tenantId);
    expect(ids).toContain('TENANT-A');
    expect(ids).toContain('TENANT-C');
    expect(ids).toContain('TENANT-D');
    expect(ids).toContain('TENANT-E');
    expect(ids).not.toContain('TENANT-B');
    expect(out).toHaveLength(4);
  });

  test('SQL filters Status=Active only', async () => {
    const req = { query: jest.fn(async () => ({ recordset: [] })) };
    getPool.mockResolvedValue({ request: () => req });
    await runner.listEnabledTenants();
    expect(req.query.mock.calls[0][0]).toMatch(/Status\s*=\s*N'Active'/);
  });
});

describe('run with no enabled tenants', () => {
  test('produces empty summary, no error', async () => {
    const req = { query: jest.fn(async () => ({ recordset: [] })) };
    getPool.mockResolvedValue({ request: () => req });

    const summary = await runner.run({ dryRun: true });
    expect(summary.tenantCount).toBe(0);
    expect(summary.totalQueued).toBe(0);
    expect(summary.tenants).toEqual([]);
  });
});
