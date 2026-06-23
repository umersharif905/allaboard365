/**
 * prospect.service — Track B1 additions:
 *   - findOrCreateProspect fires the centralized notification for inbound sources
 *     only (MightyWELL Website / ApiIngest), and never for Manual / Proposal.
 *   - the notification is non-blocking: an email failure does not break creation.
 *   - listProspects threads a `source` filter and exposes a `source` sort column.
 *   - getProspectStats returns the agreed { bySourceMonth, bySource, byStatus, totals }
 *     shape and reuses the listProspects visibility contract (empty agentIds => empty).
 *
 * DB is mocked. The notification service is mocked so we observe the hook in isolation.
 *
 * Run: npx jest services/__tests__/prospect.service.notify-stats.test.js
 */

jest.mock('../../config/database', () => {
  const mssql = require('mssql');
  return { sql: mssql, rawSql: mssql, getPool: jest.fn() };
});

jest.mock('../prospectNotification.service', () => ({
  notifyAgentOfNewProspect: jest.fn(() => Promise.resolve()),
}));

const { getPool } = require('../../config/database');
const notifySvc = require('../prospectNotification.service');
const svc = require('../prospect.service');

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

function fakePool(router) {
  return {
    request: () => {
      const inputs = {};
      const req = {
        input: (name, _type, value) => { inputs[name] = value !== undefined ? value : _type; return req; },
        query: async (sql) => router(sql, inputs),
      };
      return req;
    },
  };
}

/** A pool that always inserts a fresh prospect with the given created row. */
function insertingPool(createdRow) {
  return fakePool((sql) => {
    if (/FROM oe\.Prospects[\s\S]*EmailNormalized = @emailNorm/.test(sql)) return { recordset: [] };
    if (/FROM oe\.Prospects[\s\S]*PhoneNormalized = @phoneNorm/.test(sql)) return { recordset: [] };
    if (/oe\.Members/.test(sql)) return { recordset: [] };
    if (/INSERT INTO oe\.Prospects/.test(sql)) return { rowsAffected: [1] };
    if (/SELECT \* FROM oe\.Prospects WHERE ProspectId/.test(sql)) return { recordset: [createdRow] };
    return { recordset: [] };
  });
}

describe('findOrCreateProspect — notification hook (inbound only)', () => {
  test('fires notifyAgentOfNewProspect for source=MightyWELL Website with an agent', async () => {
    const createdRow = { ProspectId: 'new-id', TenantId: 't1', FirstName: 'Jane', Source: 'MightyWELL Website' };
    getPool.mockResolvedValue(insertingPool(createdRow));

    const { created } = await svc.findOrCreateProspect({
      tenantId: 't1', agentId: 'agent-1', firstName: 'Jane', email: 'jane@x.com',
      source: 'MightyWELL Website', status: 'New',
    });
    expect(created).toBe(true);
    // Allow the fire-and-forget microtask to settle.
    await Promise.resolve();
    expect(notifySvc.notifyAgentOfNewProspect).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', agentId: 'agent-1', prospect: createdRow })
    );
  });

  test('fires for source=ApiIngest', async () => {
    const createdRow = { ProspectId: 'p2', TenantId: 't1', Source: 'ApiIngest' };
    getPool.mockResolvedValue(insertingPool(createdRow));
    await svc.findOrCreateProspect({ tenantId: 't1', agentId: 'agent-1', email: 'a@b.com', source: 'ApiIngest' });
    await Promise.resolve();
    expect(notifySvc.notifyAgentOfNewProspect).toHaveBeenCalledTimes(1);
  });

  test('does NOT fire for source=Manual', async () => {
    const createdRow = { ProspectId: 'p3', TenantId: 't1', Source: 'Manual' };
    getPool.mockResolvedValue(insertingPool(createdRow));
    await svc.findOrCreateProspect({ tenantId: 't1', agentId: 'agent-1', email: 'm@x.com', source: 'Manual' });
    await Promise.resolve();
    expect(notifySvc.notifyAgentOfNewProspect).not.toHaveBeenCalled();
  });

  test('does NOT fire for source=Proposal', async () => {
    const createdRow = { ProspectId: 'p4', TenantId: 't1', Source: 'Proposal' };
    getPool.mockResolvedValue(insertingPool(createdRow));
    await svc.findOrCreateProspect({ tenantId: 't1', agentId: 'agent-1', email: 'pr@x.com', source: 'Proposal' });
    await Promise.resolve();
    expect(notifySvc.notifyAgentOfNewProspect).not.toHaveBeenCalled();
  });

  test('does NOT fire when there is no owning agent', async () => {
    const createdRow = { ProspectId: 'p5', TenantId: 't1', Source: 'MightyWELL Website' };
    getPool.mockResolvedValue(insertingPool(createdRow));
    await svc.findOrCreateProspect({ tenantId: 't1', agentId: null, email: 'noagent@x.com', source: 'MightyWELL Website' });
    await Promise.resolve();
    expect(notifySvc.notifyAgentOfNewProspect).not.toHaveBeenCalled();
  });

  test('is non-blocking: a notification rejection does not break creation', async () => {
    const createdRow = { ProspectId: 'p6', TenantId: 't1', Source: 'MightyWELL Website' };
    getPool.mockResolvedValue(insertingPool(createdRow));
    notifySvc.notifyAgentOfNewProspect.mockRejectedValueOnce(new Error('smtp down'));

    const { prospect, created } = await svc.findOrCreateProspect({
      tenantId: 't1', agentId: 'agent-1', email: 'boom@x.com', source: 'MightyWELL Website',
    });
    expect(created).toBe(true);
    expect(prospect.ProspectId).toBe('p6');
    await Promise.resolve();
  });

  test("'MightyWELL Website' is an allowed source (not coerced to Manual)", () => {
    expect(svc.PROSPECT_SOURCES).toContain('MightyWELL Website');
    expect(svc.NOTIFY_SOURCES).toEqual(['MightyWELL Website', 'ApiIngest']);
  });
});

describe('listProspects — source filter + sort', () => {
  test('adds AND p.Source = @source and binds the param', async () => {
    let capturedSql = '';
    let capturedInputs = {};
    const pool = fakePool((sql, inputs) => {
      capturedSql = sql;
      capturedInputs = inputs;
      return { recordset: [] };
    });
    getPool.mockResolvedValue(pool);

    await svc.listProspects({ tenantId: 't1', agentIds: null, source: 'MightyWELL Website' });
    expect(capturedSql).toMatch(/p\.Source = @source/);
    expect(capturedInputs.source).toBe('MightyWELL Website');
  });

  test("sortBy='source' orders by p.Source", async () => {
    let capturedSql = '';
    const pool = fakePool((sql) => { capturedSql = sql; return { recordset: [] }; });
    getPool.mockResolvedValue(pool);
    await svc.listProspects({ tenantId: 't1', agentIds: null, sortBy: 'source' });
    expect(capturedSql).toMatch(/ORDER BY p\.Source/);
  });
});

describe('getProspectStats', () => {
  test('returns the agreed shape from grouped recordsets', async () => {
    const pool = fakePool(() => ({
      recordsets: [
        [{ Month: '2026-05', Source: 'MightyWELL Website', Cnt: 3 }],
        [{ Source: 'MightyWELL Website', Cnt: 5 }, { Source: 'Manual', Cnt: 2 }],
        [{ Status: 'New', Cnt: 4 }, { Status: 'Closed', Cnt: 1 }],
        [{ Total: 7, NewThisMonth: 2, Sources: 2 }],
      ],
    }));
    getPool.mockResolvedValue(pool);

    const stats = await svc.getProspectStats({ tenantId: 't1', agentIds: null });
    expect(stats).toEqual({
      bySourceMonth: [{ month: '2026-05', source: 'MightyWELL Website', count: 3 }],
      bySource: [{ source: 'MightyWELL Website', count: 5, enrolled: 0 }, { source: 'Manual', count: 2, enrolled: 0 }],
      byStatus: [{ status: 'New', count: 4 }, { status: 'Closed', count: 1 }],
      totals: { total: 7, newThisMonth: 2, sources: 2, enrolled: 0 },
    });
  });

  test('returns empty shape (no query) when the visible agent set is empty', async () => {
    const pool = fakePool(() => { throw new Error('should not query when agentIds is empty'); });
    getPool.mockResolvedValue(pool);
    const stats = await svc.getProspectStats({ tenantId: 't1', agentIds: [] });
    expect(stats.totals).toEqual({ total: 0, newThisMonth: 0, sources: 0, enrolled: 0 });
    expect(stats.bySourceMonth).toEqual([]);
  });

  test('restricts to the provided agent ids', async () => {
    let capturedSql = '';
    const pool = fakePool((sql) => {
      capturedSql = sql;
      return { recordsets: [[], [], [], [{ Total: 0, NewThisMonth: 0, Sources: 0 }]] };
    });
    getPool.mockResolvedValue(pool);
    await svc.getProspectStats({ tenantId: 't1', agentIds: ['agent-self', 'agent-down'] });
    expect(capturedSql).toMatch(/p\.AgentId IN/);
  });
});
