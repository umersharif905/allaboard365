/**
 * overdueInvoiceReminderRunner.run — end-to-end pass with mocked DB + composer.
 *
 * Verifies:
 * - tenant filter works
 * - per-channel split: email + SMS each get a separate composer call
 * - resolveRecipient skip paths (NoRecipient, NoConsent, GroupSmsNotSupported) record Skipped log rows
 * - dryRun = true: no recordSend calls, no composer calls
 * - duplicate-log row from recordSend is treated as a skip, not a failure
 *
 * Run: npx jest overdueInvoiceReminderRunner.run
 */

jest.mock('../../config/database', () => ({
  sql: require('mssql'),
  getPool: jest.fn()
}));

jest.mock('../overdueInvoiceReminder.service', () => ({
  selectCandidatesForTenant: jest.fn(),
  recordSend: jest.fn().mockResolvedValue({ ok: true })
}));

jest.mock('../overdueInvoiceReminderEmail.service', () => ({
  composeAndQueueEmail: jest.fn().mockResolvedValue({ messageId: 'EML-MSG-1' }),
  composeAndQueueSms: jest.fn().mockResolvedValue({ messageId: 'SMS-MSG-1' })
}));

const { getPool } = require('../../config/database');
const reminderService = require('../overdueInvoiceReminder.service');
const composer = require('../overdueInvoiceReminderEmail.service');
const runner = require('../overdueInvoiceReminderRunner.service');

const TENANT_A = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA';

function tenantsRecordset(rows) {
  return { request: () => ({ query: jest.fn(async () => ({ recordset: rows })) }) };
}

const ENABLED_TENANT_ROW = {
  TenantId: TENANT_A,
  Name: 'Pilot Tenant',
  AdvancedSettings: JSON.stringify({
    billing: {
      overdueReminders: {
        enabled: true,
        thresholdDays: 14,
        cadenceDays: 7,
        maxCount: 4,
        skipUnderAmount: 0,
        channels: { email: true, sms: true }
      }
    }
  })
};

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

beforeEach(() => {
  jest.clearAllMocks();
  reminderService.recordSend.mockResolvedValue({ ok: true });
  composer.composeAndQueueEmail.mockResolvedValue({ messageId: 'EML-MSG-1' });
  composer.composeAndQueueSms.mockResolvedValue({ messageId: 'SMS-MSG-1' });
});

describe('run() — both channels enabled', () => {
  test('member with email + phone + consent → 2 queued (email + SMS), 0 skipped', async () => {
    getPool.mockResolvedValue(tenantsRecordset([ENABLED_TENANT_ROW]));
    reminderService.selectCandidatesForTenant.mockResolvedValue([
      {
        InvoiceId: 'INV-1', InvoiceNumber: 'INV-1', BalanceDue: 100, DueDate: new Date('2026-04-01'),
        DaysOverdue: 30, HouseholdId: 'HH-1', GroupId: null,
        MemberEmail: 'a@b.com', MemberPhone: '+15550000001', MemberFirstName: 'Stan',
        MemberUserId: 'FEDCBA09-8765-4321-FEDC-BA0987654321',
        MemberSmsConsent: true, // BIT true
        nextAttemptNumber: 1, recipientType: 'MemberPrimary'
      }
    ]);

    const summary = await runner.run({});
    expect(summary.totalQueued).toBe(2);
    expect(summary.totalSkipped).toBe(0);
    expect(summary.totalFailed).toBe(0);
    expect(composer.composeAndQueueEmail).toHaveBeenCalledTimes(1);
    expect(composer.composeAndQueueSms).toHaveBeenCalledTimes(1);
    expect(composer.composeAndQueueEmail.mock.calls[0][0]).toMatchObject({
      recipientUserId: 'FEDCBA09-8765-4321-FEDC-BA0987654321'
    });
    expect(composer.composeAndQueueSms.mock.calls[0][0]).toMatchObject({
      recipientUserId: 'FEDCBA09-8765-4321-FEDC-BA0987654321'
    });
    expect(reminderService.recordSend).toHaveBeenCalledTimes(2);
    const [emailLog, smsLog] = reminderService.recordSend.mock.calls.map((c) => c[0]);
    expect(emailLog.channel).toBe('Email');
    expect(emailLog.status).toBe('Queued');
    expect(smsLog.channel).toBe('SMS');
    expect(smsLog.status).toBe('Queued');
  });

  test('member without phone → SMS records Skipped(NoRecipient), email still queues', async () => {
    getPool.mockResolvedValue(tenantsRecordset([ENABLED_TENANT_ROW]));
    reminderService.selectCandidatesForTenant.mockResolvedValue([
      {
        InvoiceId: 'INV-2', InvoiceNumber: 'INV-2', BalanceDue: 100, DueDate: new Date('2026-04-01'),
        DaysOverdue: 30, HouseholdId: 'HH-2', GroupId: null,
        MemberEmail: 'a@b.com', MemberPhone: '', MemberFirstName: 'Stan',
        MemberUserId: 'FEDCBA09-8765-4321-FEDC-BA0987654321',
        MemberSmsConsent: true,
        nextAttemptNumber: 1, recipientType: 'MemberPrimary'
      }
    ]);

    const summary = await runner.run({});
    expect(summary.totalQueued).toBe(1);
    expect(summary.totalSkipped).toBe(1);
    const skipLog = reminderService.recordSend.mock.calls.find((c) => c[0].channel === 'SMS')[0];
    expect(skipLog.status).toBe('Skipped');
    expect(skipLog.skipReason).toBe('NoRecipient');
  });

  test('member with explicit consent=false → SMS Skipped(NoConsent); email still queued', async () => {
    getPool.mockResolvedValue(tenantsRecordset([ENABLED_TENANT_ROW]));
    reminderService.selectCandidatesForTenant.mockResolvedValue([
      {
        InvoiceId: 'INV-3', InvoiceNumber: 'INV-3', BalanceDue: 100, DueDate: new Date('2026-04-01'),
        DaysOverdue: 30, HouseholdId: 'HH-3', GroupId: null,
        MemberEmail: 'a@b.com', MemberPhone: '+15550000003', MemberFirstName: 'Stan',
        MemberUserId: 'FEDCBA09-8765-4321-FEDC-BA0987654321',
        MemberSmsConsent: false, // explicit deny — only this short-circuits SMS
        nextAttemptNumber: 1, recipientType: 'MemberPrimary'
      }
    ]);

    const summary = await runner.run({});
    expect(summary.totalSkipped).toBe(1);
    const skipLog = reminderService.recordSend.mock.calls.find((c) => c[0].channel === 'SMS')[0];
    expect(skipLog.skipReason).toBe('NoConsent');
  });

  test('member with consent=null (never set) → SMS still queues (transactional billing)', async () => {
    getPool.mockResolvedValue(tenantsRecordset([ENABLED_TENANT_ROW]));
    reminderService.selectCandidatesForTenant.mockResolvedValue([
      {
        InvoiceId: 'INV-3B', InvoiceNumber: 'INV-3B', BalanceDue: 100, DueDate: new Date('2026-04-01'),
        DaysOverdue: 30, HouseholdId: 'HH-3B', GroupId: null,
        MemberEmail: 'b@b.com', MemberPhone: '+15550000033', MemberFirstName: 'Stan',
        MemberUserId: 'FEDCBA09-8765-4321-FEDC-BA0987654321',
        MemberSmsConsent: null, // unset
        nextAttemptNumber: 1, recipientType: 'MemberPrimary'
      }
    ]);

    const summary = await runner.run({});
    expect(summary.totalQueued).toBe(2); // email + SMS
    expect(summary.totalSkipped).toBe(0);
    expect(composer.composeAndQueueSms).toHaveBeenCalledTimes(1);
  });

  test('group invoice → email queued; SMS records Skipped(GroupSmsNotSupported)', async () => {
    getPool.mockResolvedValue(tenantsRecordset([ENABLED_TENANT_ROW]));
    reminderService.selectCandidatesForTenant.mockResolvedValue([
      {
        InvoiceId: 'INV-4', InvoiceNumber: 'INV-4', BalanceDue: 500, DueDate: new Date('2026-04-01'),
        DaysOverdue: 30, HouseholdId: null, GroupId: 'GG-1',
        GroupName: 'Acme Co', GroupContactEmail: 'billing@acme.com', GroupContactPhone: '+15550000099', GroupContactName: 'Pat',
        nextAttemptNumber: 1, recipientType: 'GroupBilling'
      }
    ]);

    const summary = await runner.run({});
    expect(summary.totalQueued).toBe(1);
    expect(summary.totalSkipped).toBe(1);
    expect(composer.composeAndQueueEmail).toHaveBeenCalledTimes(1);
    expect(composer.composeAndQueueSms).not.toHaveBeenCalled();
    const skipLog = reminderService.recordSend.mock.calls.find((c) => c[0].channel === 'SMS')[0];
    expect(skipLog.skipReason).toBe('GroupSmsNotSupported');
  });

  test('group invoice with no contact email → email Skipped(NoRecipient)', async () => {
    getPool.mockResolvedValue(tenantsRecordset([ENABLED_TENANT_ROW]));
    reminderService.selectCandidatesForTenant.mockResolvedValue([
      {
        InvoiceId: 'INV-5', InvoiceNumber: 'INV-5', BalanceDue: 500, DueDate: new Date('2026-04-01'),
        DaysOverdue: 30, HouseholdId: null, GroupId: 'GG-2',
        GroupName: 'NoEmail Co', GroupContactEmail: null, GroupContactPhone: null, GroupContactName: 'Pat',
        nextAttemptNumber: 1, recipientType: 'GroupBilling'
      }
    ]);

    const summary = await runner.run({});
    expect(summary.totalQueued).toBe(0);
    expect(summary.totalSkipped).toBe(2); // Email NoRecipient + SMS GroupSmsNotSupported
    expect(composer.composeAndQueueEmail).not.toHaveBeenCalled();
  });
});

describe('run() — dry-run mode', () => {
  test('does not call recordSend or composer; returns plan only', async () => {
    getPool.mockResolvedValue(tenantsRecordset([ENABLED_TENANT_ROW]));
    reminderService.selectCandidatesForTenant.mockResolvedValue([
      {
        InvoiceId: 'INV-D', InvoiceNumber: 'INV-D', BalanceDue: 100, DueDate: new Date('2026-04-01'),
        DaysOverdue: 30, HouseholdId: 'HH-D', GroupId: null,
        MemberEmail: 'd@b.com', MemberPhone: '+15550000007', MemberFirstName: 'Stan',
        MemberUserId: 'FEDCBA09-8765-4321-FEDC-BA0987654321',
        MemberSmsConsent: true,
        nextAttemptNumber: 1, recipientType: 'MemberPrimary'
      }
    ]);

    const summary = await runner.run({ dryRun: true });
    expect(summary.dryRun).toBe(true);
    expect(reminderService.recordSend).not.toHaveBeenCalled();
    expect(composer.composeAndQueueEmail).not.toHaveBeenCalled();
    expect(composer.composeAndQueueSms).not.toHaveBeenCalled();
  });
});

describe('run() — duplicate log row treated as skip', () => {
  test('recordSend returning duplicate=true increments skipped, not failed', async () => {
    getPool.mockResolvedValue(tenantsRecordset([ENABLED_TENANT_ROW]));
    reminderService.selectCandidatesForTenant.mockResolvedValue([
      {
        InvoiceId: 'INV-DUP', InvoiceNumber: 'INV-DUP', BalanceDue: 100, DueDate: new Date('2026-04-01'),
        DaysOverdue: 30, HouseholdId: 'HH-X', GroupId: null,
        MemberEmail: 'e@b.com', MemberPhone: '+15550000008', MemberFirstName: 'Stan',
        MemberUserId: 'FEDCBA09-8765-4321-FEDC-BA0987654321',
        MemberSmsConsent: true,
        nextAttemptNumber: 1, recipientType: 'MemberPrimary'
      }
    ]);
    reminderService.recordSend.mockResolvedValue({ ok: false, duplicate: true });

    const summary = await runner.run({});
    expect(summary.totalQueued).toBe(0);
    expect(summary.totalSkipped).toBe(2); // both channels deduplicated
    expect(summary.totalFailed).toBe(0);
  });
});

describe('run() — composer failure path', () => {
  test('composer throws → records Failed log row + counted as failure', async () => {
    getPool.mockResolvedValue(tenantsRecordset([ENABLED_TENANT_ROW]));
    reminderService.selectCandidatesForTenant.mockResolvedValue([
      {
        InvoiceId: 'INV-F', InvoiceNumber: 'INV-F', BalanceDue: 100, DueDate: new Date('2026-04-01'),
        DaysOverdue: 30, HouseholdId: 'HH-F', GroupId: null,
        MemberEmail: 'f@b.com', MemberPhone: '+15550000009', MemberFirstName: 'Stan',
        MemberUserId: 'FEDCBA09-8765-4321-FEDC-BA0987654321',
        MemberSmsConsent: false,
        nextAttemptNumber: 1, recipientType: 'MemberPrimary'
      }
    ]);
    composer.composeAndQueueEmail.mockRejectedValue(new Error('SendGrid down'));

    const summary = await runner.run({});
    expect(summary.totalFailed).toBe(1); // email failed
    expect(summary.totalSkipped).toBe(1); // SMS NoConsent
    const failedLog = reminderService.recordSend.mock.calls.find(
      (c) => c[0].channel === 'Email' && c[0].status === 'Failed'
    );
    expect(failedLog).toBeDefined();
    expect(failedLog[0].skipReason).toMatch(/SendGrid/);
  });
});

describe('run() — tenantId filter', () => {
  test('only the specified tenant runs', async () => {
    const TENANT_B = 'BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB';
    getPool.mockResolvedValue(tenantsRecordset([
      ENABLED_TENANT_ROW,
      {
        TenantId: TENANT_B,
        Name: 'Other Tenant',
        AdvancedSettings: JSON.stringify({
          billing: { overdueReminders: { enabled: true, thresholdDays: 14, cadenceDays: 7, maxCount: 4, channels: { email: true, sms: false } } }
        })
      }
    ]));
    reminderService.selectCandidatesForTenant.mockResolvedValue([]);

    await runner.run({ tenantId: TENANT_A });
    expect(reminderService.selectCandidatesForTenant).toHaveBeenCalledTimes(1);
    expect(reminderService.selectCandidatesForTenant.mock.calls[0][0]).toBe(TENANT_A);
  });
});
