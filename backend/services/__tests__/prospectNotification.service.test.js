/**
 * prospectNotification.service — centralized new-prospect agent email.
 *
 *   - resolves the agent email/name, builds a Prospects deep-link, renders the
 *     template, and queues the email.
 *   - respects the per-agent preference: pref=0 => skip; NULL/1 => send.
 *   - DEFENSIVE: if the preference column doesn't exist (query throws) => treat ON.
 *   - skips (no queue) when the agent has no email.
 *
 * DB, template, and queue are mocked.
 *
 * Run: npx jest services/__tests__/prospectNotification.service.test.js
 */

jest.mock('../../config/database', () => {
  const mssql = require('mssql');
  return { sql: mssql, getPool: jest.fn() };
});
jest.mock('../emailTemplates.service', () => ({
  generateNewProspectNotification: jest.fn(() =>
    Promise.resolve({ subject: 'New prospect: Jane Doe', html: '<html>hi</html>' })),
}));
jest.mock('../messageQueue.service', () => ({
  queueEmail: jest.fn(() => Promise.resolve('msg-1')),
}));
jest.mock('../../utils/tenantAppUrl', () => ({
  buildTenantAppBaseUrl: jest.fn(() => 'https://portal.example.com'),
}));

const { getPool } = require('../../config/database');
const EmailTemplatesService = require('../emailTemplates.service');
const MessageQueueService = require('../messageQueue.service');
const notifySvc = require('../prospectNotification.service');

beforeAll(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  console.warn.mockRestore?.();
  console.error.mockRestore?.();
});
beforeEach(() => jest.clearAllMocks());

/**
 * Build a pool whose router decides what each query returns. Inputs are captured.
 * Pass overrides for { agentContact, pref, tenant } query results.
 */
function buildPool({ agentRow, prefRow, prefThrows, tenantRow }) {
  return {
    request: () => {
      const inputs = {};
      const req = {
        input: (name, _type, value) => { inputs[name] = value !== undefined ? value : _type; return req; },
        query: async (sql) => {
          if (/SELECT TOP 1 NotifyNewProspectEmail/.test(sql)) {
            if (prefThrows) throw new Error("Invalid column name 'NotifyNewProspectEmail'.");
            return { recordset: prefRow !== undefined ? [prefRow] : [] };
          }
          if (/SELECT TOP 1 u\.Email, u\.FirstName/.test(sql)) {
            return { recordset: agentRow !== undefined ? [agentRow] : [] };
          }
          if (/FROM oe\.Tenants/.test(sql)) {
            return { recordset: tenantRow !== undefined ? [tenantRow] : [] };
          }
          return { recordset: [] };
        },
      };
      return req;
    },
  };
}

const PROSPECT = { FirstName: 'Jane', LastName: 'Doe', Email: 'jane@x.com', Phone: '2015551234', Source: 'MightyWELL Website' };

describe('notifyAgentOfNewProspect', () => {
  test('sends when preference is NULL (default ON)', async () => {
    getPool.mockResolvedValue(buildPool({
      prefRow: { NotifyNewProspectEmail: null },
      agentRow: { Email: 'agent@x.com', FirstName: 'Al' },
      tenantRow: { TenantId: 't1', Name: 'Acme' },
    }));

    await notifySvc.notifyAgentOfNewProspect({ tenantId: 't1', agentId: 'a1', prospect: PROSPECT });

    expect(EmailTemplatesService.generateNewProspectNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        agentName: 'Al',
        prospectName: 'Jane Doe',
        prospectEmail: 'jane@x.com',
        prospectPhone: '2015551234',
        prospectsUrl: 'https://portal.example.com/agent/prospects',
        source: 'MightyWELL Website',
      })
    );
    expect(MessageQueueService.queueEmail).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', toEmail: 'agent@x.com', subject: 'New prospect: Jane Doe', htmlContent: '<html>hi</html>' })
    );
  });

  test('sends when preference = 1', async () => {
    getPool.mockResolvedValue(buildPool({
      prefRow: { NotifyNewProspectEmail: 1 },
      agentRow: { Email: 'agent@x.com', FirstName: 'Al' },
      tenantRow: { TenantId: 't1', Name: 'Acme' },
    }));
    await notifySvc.notifyAgentOfNewProspect({ tenantId: 't1', agentId: 'a1', prospect: PROSPECT });
    expect(MessageQueueService.queueEmail).toHaveBeenCalledTimes(1);
  });

  test('skips (no queue) when preference = 0', async () => {
    getPool.mockResolvedValue(buildPool({
      prefRow: { NotifyNewProspectEmail: 0 },
      agentRow: { Email: 'agent@x.com', FirstName: 'Al' },
      tenantRow: { TenantId: 't1', Name: 'Acme' },
    }));
    await notifySvc.notifyAgentOfNewProspect({ tenantId: 't1', agentId: 'a1', prospect: PROSPECT });
    expect(MessageQueueService.queueEmail).not.toHaveBeenCalled();
    expect(EmailTemplatesService.generateNewProspectNotification).not.toHaveBeenCalled();
  });

  test('defaults ON when the preference column is missing (query throws)', async () => {
    getPool.mockResolvedValue(buildPool({
      prefThrows: true,
      agentRow: { Email: 'agent@x.com', FirstName: 'Al' },
      tenantRow: { TenantId: 't1', Name: 'Acme' },
    }));
    await notifySvc.notifyAgentOfNewProspect({ tenantId: 't1', agentId: 'a1', prospect: PROSPECT });
    expect(MessageQueueService.queueEmail).toHaveBeenCalledTimes(1);
  });

  test('skips gracefully when the agent has no email', async () => {
    getPool.mockResolvedValue(buildPool({
      prefRow: { NotifyNewProspectEmail: 1 },
      agentRow: { Email: null, FirstName: 'Al' },
      tenantRow: { TenantId: 't1', Name: 'Acme' },
    }));
    await notifySvc.notifyAgentOfNewProspect({ tenantId: 't1', agentId: 'a1', prospect: PROSPECT });
    expect(MessageQueueService.queueEmail).not.toHaveBeenCalled();
  });

  test('no-ops on missing args (never throws)', async () => {
    await expect(notifySvc.notifyAgentOfNewProspect({})).resolves.toBeUndefined();
    expect(MessageQueueService.queueEmail).not.toHaveBeenCalled();
  });
});
