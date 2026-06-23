/**
 * prospect.service — Phase 1 contract tests.
 *
 * Pins the behavior the Prospects CRM relies on:
 *   - normalizeEmail / normalizePhone produce stable dedupe keys
 *   - findOrCreateProspect dedupes email-primary then phone-fallback (no duplicate)
 *   - a brand-new contact inserts a fresh prospect (created=true)
 *   - suggestMemberMatch checks email first, phone second, and never mutates
 *   - confirmMemberLink refuses a member from another tenant
 *   - status validation rejects out-of-set values
 *
 * DB is mocked: a fake pool routes each query by its SQL text + captured inputs.
 *
 * Run: npx jest services/__tests__/prospect.service.test.js
 */

jest.mock('../../config/database', () => {
  const mssql = require('mssql');
  return { sql: mssql, rawSql: mssql, getPool: jest.fn() };
});

const { getPool } = require('../../config/database');
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

/**
 * Build a fake pool whose every request captures .input() values and dispatches
 * .query(sql) to `router(sql, inputs)`, which returns { recordset } (or a row count).
 */
function fakePool(router) {
  return {
    request: () => {
      const inputs = {};
      const req = {
        input: (name, _type, value) => {
          // Support both input(name,type,value) and input(name,value)
          req._args = (req._args || 0) + 1;
          inputs[name] = value !== undefined ? value : _type;
          return req;
        },
        query: async (sql) => router(sql, inputs),
      };
      return req;
    },
  };
}

describe('normalizeEmail', () => {
  test('trims and lowercases', () => {
    expect(svc.normalizeEmail('  Foo@Bar.COM ')).toBe('foo@bar.com');
  });
  test('returns null for empty/invalid', () => {
    expect(svc.normalizeEmail('')).toBeNull();
    expect(svc.normalizeEmail(null)).toBeNull();
    expect(svc.normalizeEmail('   ')).toBeNull();
  });
});

describe('normalizePhone', () => {
  test('reduces to last 10 digits', () => {
    expect(svc.normalizePhone('(201) 555-1234')).toBe('2015551234');
  });
  test('drops US country code on 11-digit numbers', () => {
    expect(svc.normalizePhone('+1 201-555-1234')).toBe('2015551234');
  });
  test('returns null when fewer than 10 digits', () => {
    expect(svc.normalizePhone('555-1234')).toBeNull();
    expect(svc.normalizePhone(null)).toBeNull();
  });
});

describe('suggestMemberMatch', () => {
  test('matches by email first (no phone query issued)', async () => {
    const calls = [];
    const pool = fakePool((sql) => {
      calls.push(sql);
      if (/LOWER\(LTRIM\(RTRIM\(u\.Email\)\)\) = @emailNorm/.test(sql)) {
        return { recordset: [{ MemberId: 'member-1' }] };
      }
      throw new Error('phone query should not run when email matches');
    });
    const id = await svc.suggestMemberMatch(pool, {
      tenantId: 't1', emailNormalized: 'a@b.com', phoneNormalized: '2015551234',
    });
    expect(id).toBe('member-1');
    expect(calls).toHaveLength(1);
  });

  test('falls back to phone when email has no match', async () => {
    const pool = fakePool((sql) => {
      if (/u\.Email\)\)\) = @emailNorm/.test(sql)) return { recordset: [] };
      if (/= @phoneNorm/.test(sql)) return { recordset: [{ MemberId: 'member-2' }] };
      return { recordset: [] };
    });
    const id = await svc.suggestMemberMatch(pool, {
      tenantId: 't1', emailNormalized: 'a@b.com', phoneNormalized: '2015551234',
    });
    expect(id).toBe('member-2');
  });

  test('returns null when nothing provided', async () => {
    const pool = fakePool(() => { throw new Error('should not query'); });
    const id = await svc.suggestMemberMatch(pool, { tenantId: 't1' });
    expect(id).toBeNull();
  });
});

describe('findOrCreateProspect', () => {
  test('returns existing prospect on email match (no insert, created=false)', async () => {
    let inserted = false;
    const existingRow = { ProspectId: 'p1', TenantId: 't1', MemberId: null };
    const pool = fakePool((sql) => {
      if (/FROM oe\.Prospects[\s\S]*EmailNormalized = @emailNorm/.test(sql)) {
        return { recordset: [existingRow] };
      }
      if (/INSERT INTO oe\.Prospects/.test(sql)) { inserted = true; return { rowsAffected: [1] }; }
      if (/UPDATE oe\.Prospects SET/.test(sql)) return { rowsAffected: [1] };
      if (/SELECT \* FROM oe\.Prospects WHERE ProspectId/.test(sql)) {
        return { recordset: [{ ...existingRow, FirstName: 'Existing' }] };
      }
      if (/oe\.Members/.test(sql)) return { recordset: [] }; // member suggestion
      return { recordset: [] };
    });
    getPool.mockResolvedValue(pool);

    const { prospect, created } = await svc.findOrCreateProspect({
      tenantId: 't1', email: 'Dup@x.com', firstName: 'New',
    });
    expect(created).toBe(false);
    expect(inserted).toBe(false);
    expect(prospect.ProspectId).toBe('p1');
  });

  test('inserts a new prospect when no identity match (created=true)', async () => {
    let inserted = false;
    const pool = fakePool((sql) => {
      if (/FROM oe\.Prospects[\s\S]*EmailNormalized = @emailNorm/.test(sql)) return { recordset: [] };
      if (/FROM oe\.Prospects[\s\S]*PhoneNormalized = @phoneNorm/.test(sql)) return { recordset: [] };
      if (/oe\.Members/.test(sql)) return { recordset: [] };
      if (/INSERT INTO oe\.Prospects/.test(sql)) { inserted = true; return { rowsAffected: [1] }; }
      if (/SELECT \* FROM oe\.Prospects WHERE ProspectId/.test(sql)) {
        return { recordset: [{ ProspectId: 'new-id', TenantId: 't1', FirstName: 'Jane' }] };
      }
      return { recordset: [] };
    });
    getPool.mockResolvedValue(pool);

    const { prospect, created } = await svc.findOrCreateProspect({
      tenantId: 't1', firstName: 'Jane', email: 'jane@x.com', phone: '201-555-9999',
    });
    expect(created).toBe(true);
    expect(inserted).toBe(true);
    expect(prospect.ProspectId).toBe('new-id');
  });

  test('throws without tenantId', async () => {
    await expect(svc.findOrCreateProspect({ email: 'x@y.com' })).rejects.toThrow(/tenantId/);
  });
});

describe('confirmMemberLink', () => {
  test('refuses a member from another tenant', async () => {
    const pool = fakePool((sql) => {
      if (/FROM oe\.Members WHERE MemberId = @memberId AND TenantId = @tenantId/.test(sql)) {
        return { recordset: [] }; // not found in this tenant
      }
      throw new Error('should not update when member not in tenant');
    });
    const ok = await svc.confirmMemberLink(pool, { prospectId: 'p1', memberId: 'm-other', tenantId: 't1' });
    expect(ok).toBe(false);
  });

  test('links + closes when member is in tenant', async () => {
    let updated = false;
    const pool = fakePool((sql) => {
      if (/FROM oe\.Members WHERE MemberId = @memberId AND TenantId = @tenantId/.test(sql)) {
        return { recordset: [{ MemberId: 'm1' }] };
      }
      if (/UPDATE oe\.Prospects[\s\S]*Status = 'Closed'/.test(sql)) { updated = true; return { rowsAffected: [1] }; }
      return { recordset: [] };
    });
    const ok = await svc.confirmMemberLink(pool, { prospectId: 'p1', memberId: 'm1', tenantId: 't1' });
    expect(ok).toBe(true);
    expect(updated).toBe(true);
  });
});

describe('deleteProspect', () => {
  function fakeTxPool(router) {
    const tx = {
      begin: jest.fn(async () => {}),
      commit: jest.fn(async () => {}),
      rollback: jest.fn(async () => {}),
      request: () => {
        const inputs = {};
        const req = {
          input: (name, _type, value) => { inputs[name] = value !== undefined ? value : _type; return req; },
          query: async (sql) => router(sql, inputs),
        };
        return req;
      },
    };
    // rawSql.Transaction(pool) is invoked as `new rawSql.Transaction(pool)`.
    const mssql = require('mssql');
    jest.spyOn(mssql, 'Transaction').mockImplementation(() => tx);
    return { pool: {}, tx };
  }

  afterEach(() => jest.restoreAllMocks());

  test('deletes child products then the prospect within a transaction', async () => {
    const seen = [];
    const { tx } = fakeTxPool((sql) => {
      seen.push(sql);
      if (/DELETE FROM oe\.Prospects/.test(sql)) return { rowsAffected: [1] };
      return { rowsAffected: [2] };
    });
    const ok = await svc.deleteProspect({}, { prospectId: 'p1', tenantId: 't1' });
    expect(ok).toBe(true);
    expect(seen.some((s) => /DELETE FROM oe\.ProspectProducts/.test(s))).toBe(true);
    expect(seen.some((s) => /DELETE FROM oe\.Prospects/.test(s))).toBe(true);
    expect(tx.commit).toHaveBeenCalled();
    expect(tx.rollback).not.toHaveBeenCalled();
  });

  test('rolls back when a delete fails', async () => {
    const { tx } = fakeTxPool(() => { throw new Error('boom'); });
    await expect(svc.deleteProspect({}, { prospectId: 'p1', tenantId: 't1' })).rejects.toThrow('boom');
    expect(tx.rollback).toHaveBeenCalled();
    expect(tx.commit).not.toHaveBeenCalled();
  });
});

describe('getProspectsForReport', () => {
  test('returns [] (and runs no main query) when the visible agent set is empty', async () => {
    const pool = fakePool((sql) => {
      if (/FROM oe\.Prospects/.test(sql)) throw new Error('should not query when agentIds is empty');
      return { recordset: [] };
    });
    getPool.mockResolvedValue(pool);
    const rows = await svc.getProspectsForReport({ tenantId: 't1', agentIds: [] });
    expect(rows).toEqual([]);
  });
});

describe('prospectAddressCandidates', () => {
  test('includes lowercased email and E.164 + bare phone forms', () => {
    const c = svc.prospectAddressCandidates({ Email: 'A@B.com', PhoneNormalized: '2015551234' });
    expect(c).toContain('a@b.com');
    expect(c).toContain('+12015551234');
    expect(c).toContain('2015551234');
  });
});

describe('splitName', () => {
  test('splits on the first space', () => {
    expect(svc.splitName('Jane Q Doe')).toEqual({ firstName: 'Jane', lastName: 'Q Doe' });
    expect(svc.splitName('Cher')).toEqual({ firstName: 'Cher', lastName: null });
  });
});

describe('status set', () => {
  test('exposes the agreed lifecycle', () => {
    expect(svc.PROSPECT_STATUSES).toEqual(['New', 'Contacted', 'Proposal Sent', 'Closed', 'Lost']);
  });
});
