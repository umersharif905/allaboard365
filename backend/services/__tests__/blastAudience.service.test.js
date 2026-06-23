/**
 * blastAudience.service — recipient resolution for filtered-group message blasts.
 *
 * Pins the contract the Message Blast "Filtered group" mode relies on:
 *   - each audience type builds a tenant-scoped query and resolves recipients
 *   - marketing opt-outs are excluded (members: email + SMS separately; agents: both)
 *   - members with no SMS consent are excluded from SMS
 *   - email/phone lists are de-duplicated and phones are E.164-normalized
 *   - members_by_product / agents_by_agency require a non-empty, valid selection
 *   - unknown audience types throw AudienceError
 *
 * Run: npx jest blastAudience.service
 */

jest.mock('../../config/database', () => {
  const mssql = require('mssql');
  return { sql: mssql, getPool: jest.fn() };
});

const { getPool } = require('../../config/database');
const {
  AUDIENCE_TYPES,
  AudienceError,
  getAudienceOptions,
  resolveAudience,
  buildRecipientLists,
  normalizePhone,
  isValidGuid
} = require('../blastAudience.service');

const TENANT = '11111111-1111-1111-1111-111111111111';
const GUID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const GUID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

/**
 * Fake pool that routes queries by table and returns a configured recordset.
 * `lastQueries` records every executed SQL string + bound params for assertions.
 */
function buildFakePool(handler) {
  const lastQueries = [];
  const makeRequest = () => {
    const params = {};
    const req = {
      input: jest.fn((name, _type, val) => {
        params[name] = val !== undefined ? val : _type;
        return req;
      }),
      query: jest.fn(async (text) => {
        lastQueries.push({ text, params: { ...params } });
        return handler(text, params) || { recordset: [] };
      })
    };
    return req;
  };
  return { request: makeRequest, _lastQueries: lastQueries };
}

describe('pure helpers', () => {
  test('normalizePhone handles 10- and 11-digit US numbers, rejects others', () => {
    expect(normalizePhone('5551234567')).toBe('+15551234567');
    expect(normalizePhone('15551234567')).toBe('+15551234567');
    expect(normalizePhone('(555) 123-4567')).toBe('+15551234567');
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });

  test('isValidGuid accepts 36-char guids, rejects junk', () => {
    expect(isValidGuid(GUID_A)).toBe(true);
    expect(isValidGuid('not-a-guid')).toBe(false);
    expect(isValidGuid('')).toBe(false);
    expect(isValidGuid(123)).toBe(false);
  });
});

describe('buildRecipientLists', () => {
  test('members: excludes email/SMS opt-outs and members without SMS consent', () => {
    const rows = [
      // fully reachable, consented
      { Email: 'a@x.com', PhoneNumber: '5550000001', EmailOptOut: 0, SmsOptOut: 0, SmsConsent: 1 },
      // email opted out -> no email; sms consented -> sms kept
      { Email: 'b@x.com', PhoneNumber: '5550000002', EmailOptOut: 1, SmsOptOut: 0, SmsConsent: 1 },
      // sms opted out -> no sms; email kept
      { Email: 'c@x.com', PhoneNumber: '5550000003', EmailOptOut: 0, SmsOptOut: 1, SmsConsent: 1 },
      // no sms consent -> no sms even though not opted out
      { Email: 'd@x.com', PhoneNumber: '5550000004', EmailOptOut: 0, SmsOptOut: 0, SmsConsent: 0 }
    ];
    const r = buildRecipientLists(rows, { isMember: true });
    expect(r.emails.sort()).toEqual(['a@x.com', 'c@x.com', 'd@x.com']);
    expect(r.phones.sort()).toEqual(['+15550000001', '+15550000002']);
    expect(r.emailOptedOut).toBe(1);
    expect(r.smsOptedOut).toBe(2); // c (opt-out) + d (no consent)
  });

  test('agents: marketing opt-out blocks BOTH channels', () => {
    const rows = [
      { Email: 'agent1@x.com', PhoneNumber: '5550000010', MarketingOptOut: 0 },
      { Email: 'agent2@x.com', PhoneNumber: '5550000011', MarketingOptOut: 1 }
    ];
    const r = buildRecipientLists(rows, { isMember: false });
    expect(r.emails).toEqual(['agent1@x.com']);
    expect(r.phones).toEqual(['+15550000010']);
    expect(r.emailOptedOut).toBe(1);
    expect(r.smsOptedOut).toBe(1);
  });

  test('de-duplicates emails and phones, lowercases emails', () => {
    const rows = [
      { Email: 'DUP@x.com', PhoneNumber: '5550000020', EmailOptOut: 0, SmsOptOut: 0, SmsConsent: 1 },
      { Email: 'dup@x.com', PhoneNumber: '5550000020', EmailOptOut: 0, SmsOptOut: 0, SmsConsent: 1 }
    ];
    const r = buildRecipientLists(rows, { isMember: true });
    expect(r.emails).toEqual(['dup@x.com']);
    expect(r.phones).toEqual(['+15550000020']);
  });
});

describe('resolveAudience — members', () => {
  test('active_members: tenant-scoped, no product clause', async () => {
    const pool = buildFakePool((text) => {
      if (/FROM oe\.Members/i.test(text)) {
        return { recordset: [{ MemberId: GUID_A, Email: 'm@x.com', PhoneNumber: '5551112222', EmailOptOut: 0, SmsOptOut: 0, SmsConsent: 1 }] };
      }
      return { recordset: [] };
    });
    getPool.mockResolvedValue(pool);

    const r = await resolveAudience({ tenantId: TENANT, audienceType: AUDIENCE_TYPES.ACTIVE_MEMBERS });
    expect(r.emails).toEqual(['m@x.com']);
    expect(r.phones).toEqual(['+15551112222']);

    const q = pool._lastQueries.find((x) => /FROM oe\.Members/i.test(x.text));
    expect(q.params.TenantId).toBe(TENANT);
    expect(q.text).not.toMatch(/e\.ProductId IN/);
    expect(q.text).toMatch(/TerminationDate IS NULL/i);
  });

  test('members_by_product: binds selected product ids into IN clause', async () => {
    const pool = buildFakePool(() => ({ recordset: [] }));
    getPool.mockResolvedValue(pool);

    await resolveAudience({
      tenantId: TENANT,
      audienceType: AUDIENCE_TYPES.MEMBERS_BY_PRODUCT,
      productIds: [GUID_A, GUID_B]
    });

    const q = pool._lastQueries.find((x) => /FROM oe\.Members/i.test(x.text));
    expect(q.text).toMatch(/e\.ProductId IN \(@prod0,@prod1\)/);
    expect(q.params.prod0).toBe(GUID_A);
    expect(q.params.prod1).toBe(GUID_B);
  });

  test('members_by_product: throws when no products selected', async () => {
    getPool.mockResolvedValue(buildFakePool(() => ({ recordset: [] })));
    await expect(
      resolveAudience({ tenantId: TENANT, audienceType: AUDIENCE_TYPES.MEMBERS_BY_PRODUCT, productIds: [] })
    ).rejects.toThrow(AudienceError);
  });

  test('members_by_product: ignores invalid guids and throws if none valid', async () => {
    getPool.mockResolvedValue(buildFakePool(() => ({ recordset: [] })));
    await expect(
      resolveAudience({ tenantId: TENANT, audienceType: AUDIENCE_TYPES.MEMBERS_BY_PRODUCT, productIds: ['junk', ''] })
    ).rejects.toThrow(AudienceError);
  });
});

describe('resolveAudience — agents', () => {
  test('active_agents: tenant-scoped, no agency clause', async () => {
    const pool = buildFakePool((text) => {
      if (/FROM oe\.Agents/i.test(text)) {
        return { recordset: [{ AgentId: GUID_A, Email: 'a@x.com', PhoneNumber: '5553334444', MarketingOptOut: 0 }] };
      }
      return { recordset: [] };
    });
    getPool.mockResolvedValue(pool);

    const r = await resolveAudience({ tenantId: TENANT, audienceType: AUDIENCE_TYPES.ACTIVE_AGENTS });
    expect(r.emails).toEqual(['a@x.com']);

    const q = pool._lastQueries.find((x) => /FROM oe\.Agents/i.test(x.text));
    expect(q.params.TenantId).toBe(TENANT);
    expect(q.text).toMatch(/a\.Status = N'Active'/);
    expect(q.text).not.toMatch(/a\.AgencyId IN/);
  });

  test('agents_by_agency: binds selected agency ids into IN clause', async () => {
    const pool = buildFakePool(() => ({ recordset: [] }));
    getPool.mockResolvedValue(pool);

    await resolveAudience({
      tenantId: TENANT,
      audienceType: AUDIENCE_TYPES.AGENTS_BY_AGENCY,
      agencyIds: [GUID_A]
    });

    const q = pool._lastQueries.find((x) => /FROM oe\.Agents/i.test(x.text));
    expect(q.text).toMatch(/a\.AgencyId IN \(@ag0\)/);
    expect(q.params.ag0).toBe(GUID_A);
  });

  test('agents_by_agency: throws when no agencies selected', async () => {
    getPool.mockResolvedValue(buildFakePool(() => ({ recordset: [] })));
    await expect(
      resolveAudience({ tenantId: TENANT, audienceType: AUDIENCE_TYPES.AGENTS_BY_AGENCY, agencyIds: [] })
    ).rejects.toThrow(AudienceError);
  });
});

describe('resolveAudience — guards', () => {
  test('unknown audience type throws AudienceError', async () => {
    getPool.mockResolvedValue(buildFakePool(() => ({ recordset: [] })));
    await expect(
      resolveAudience({ tenantId: TENANT, audienceType: 'nope' })
    ).rejects.toThrow(AudienceError);
  });

  test('missing tenant throws AudienceError', async () => {
    await expect(
      resolveAudience({ tenantId: null, audienceType: AUDIENCE_TYPES.ACTIVE_MEMBERS })
    ).rejects.toThrow(AudienceError);
  });
});

describe('getAudienceOptions', () => {
  test('returns products (with bundle flag) and agencies; applies vendor filter', async () => {
    const pool = buildFakePool((text) => {
      if (/FROM oe\.Enrollments[\s\S]*JOIN oe\.Products/i.test(text)) {
        return { recordset: [
          { id: GUID_A, name: 'Dental', isBundle: 0 },
          { id: GUID_B, name: 'Family Bundle', isBundle: 1 }
        ] };
      }
      if (/FROM oe\.Agencies/i.test(text)) {
        return { recordset: [{ id: GUID_A, name: 'Acme Agency' }] };
      }
      return { recordset: [] };
    });
    getPool.mockResolvedValue(pool);

    const data = await getAudienceOptions(TENANT, 'cccccccc-cccc-cccc-cccc-cccccccccccc');
    expect(data.products).toEqual([
      { id: GUID_A, name: 'Dental', isBundle: false },
      { id: GUID_B, name: 'Family Bundle', isBundle: true }
    ]);
    expect(data.agencies).toEqual([{ id: GUID_A, name: 'Acme Agency' }]);

    const prodQ = pool._lastQueries.find((x) => /JOIN oe\.Products/i.test(x.text));
    expect(prodQ.text).toMatch(/p\.VendorId = @VendorId/);
    expect(prodQ.params.VendorId).toBe('cccccccc-cccc-cccc-cccc-cccccccccccc');
  });

  test('without vendor filter, no VendorId clause is applied', async () => {
    const pool = buildFakePool(() => ({ recordset: [] }));
    getPool.mockResolvedValue(pool);
    await getAudienceOptions(TENANT, null);
    const prodQ = pool._lastQueries.find((x) => /JOIN oe\.Products/i.test(x.text));
    expect(prodQ.text).not.toMatch(/p\.VendorId = @VendorId/);
  });
});
