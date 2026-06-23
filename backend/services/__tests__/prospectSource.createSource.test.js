// Regression coverage for createSource. The api-type path opens a DB
// transaction; it must use the raw mssql module (rawSql.Transaction), not the
// SqlTypes alias (sql), which has no Transaction constructor.
jest.mock('../../config/database', () => {
  const makeReq = () => ({
    input: jest.fn().mockReturnThis(),
    query: jest.fn().mockResolvedValue({ recordset: [] }),
  });
  const tx = {
    begin: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
    request: jest.fn(makeReq),
  };
  return {
    getPool: jest.fn(),
    // SqlTypes alias: type tokens only, NO Transaction (mirrors real export)
    sql: { UniqueIdentifier: 'UniqueIdentifier', NVarChar: 'NVarChar', Bit: 'Bit' },
    rawSql: { Transaction: jest.fn(() => tx) },
  };
});

const svc = require('../prospectSource.service');

function fakePool() {
  return {
    request: () => ({
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockResolvedValue({ recordset: [] }),
    }),
  };
}

describe('createSource', () => {
  test('api type creates key + source atomically and returns apiKey (regression)', async () => {
    const result = await svc.createSource(fakePool(), {
      tenantId: 't', agentId: 'a', agentCode: 'MWA1', idParam: 'id',
      name: 'My API', tag: null, type: 'api', destinationUrl: null, createdBy: 'u',
    });
    expect(result.type).toBe('api');
    expect(result.apiKey).toMatch(/^sk_live_/);
    expect(result.sourceId).toBeTruthy();
  });

  test('website type generates a unique public link, no apiKey', async () => {
    const result = await svc.createSource(fakePool(), {
      tenantId: 't', agentId: 'a', agentCode: 'MWA1', idParam: 'id',
      name: 'Web', tag: 'x', type: 'website', destinationUrl: 'https://m.com/get-a-quote', createdBy: 'u',
    });
    expect(result.type).toBe('website');
    expect(result.link).toContain('https://m.com/get-a-quote?id=MWA1_');
    expect(result.apiKey).toBeNull();
    expect(result.isDefault).toBe(false);
    expect(result.color).toBeNull();
  });

  test('website type accepts a color label', async () => {
    const result = await svc.createSource(fakePool(), {
      tenantId: 't', agentId: 'a', agentCode: 'MWA1', idParam: 'id',
      name: 'Web', tag: null, type: 'website', destinationUrl: 'https://m.com/q', createdBy: 'u',
      color: '#1f8dbf',
    });
    expect(result.color).toBe('#1f8dbf');
  });
});
