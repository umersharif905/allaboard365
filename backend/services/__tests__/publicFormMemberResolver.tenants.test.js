/**
 * Tests for cross-tenant member resolution — the fix for sharing requests that
 * were dropped because matching was hard-scoped to the form's single tenant.
 */

// Captured per-call so assertions can inspect the last query + bound inputs.
// Must be `mock`-prefixed to be referenceable inside the jest.mock factory.
let mockLastQuery = null;
let mockLastInputs = null;
let mockNextRecordset = [];

jest.mock('../../config/database', () => {
    function makeRequest() {
        const inputs = {};
        const req = {
            input(name, _type, value) {
                // mssql allows .input(name, type, value) or .input(name, value)
                inputs[name] = arguments.length === 2 ? _type : value;
                return req;
            },
            async query(text) {
                mockLastQuery = text;
                mockLastInputs = inputs;
                // mockNextRecordset may be an array (same rows for any query) or a
                // function (route rows by query text — needed to exercise the
                // email-then-phone fallback order in one call).
                const rs = typeof mockNextRecordset === 'function'
                    ? mockNextRecordset(text)
                    : mockNextRecordset;
                return { recordset: rs };
            }
        };
        return req;
    }
    return {
        getPool: async () => ({ request: () => makeRequest() }),
        sql: { UniqueIdentifier: 'UniqueIdentifier', NVarChar: 'NVarChar', Int: 'Int' }
    };
});

const {
    resolveMemberForTenants,
    resolveMemberForTenant,
    buildResolverTenantSet,
    normalizeTenantIdList
} = require('../publicFormMemberResolver');

const T1 = 'AAAAAAAA-1111-4111-8111-AAAAAAAAAAAA';
const T2 = 'BBBBBBBB-2222-4222-8222-BBBBBBBBBBBB';

beforeEach(() => {
    mockLastQuery = null;
    mockLastInputs = null;
    mockNextRecordset = [];
});

describe('normalizeTenantIdList', () => {
    it('flattens, trims, and de-dupes case-insensitively', () => {
        expect(normalizeTenantIdList(T1)).toEqual([T1]);
        expect(normalizeTenantIdList([T1, T1.toLowerCase(), '  ', null, T2]))
            .toEqual([T1, T2]);
    });
});

describe('buildResolverTenantSet', () => {
    it('always includes the own tenant', () => {
        expect(buildResolverTenantSet(T1, null)).toEqual([T1]);
        expect(buildResolverTenantSet(T1, '')).toEqual([T1]);
    });
    it('unions the JSON allow-list with the own tenant (deduped)', () => {
        expect(buildResolverTenantSet(T1, JSON.stringify([T2, T1])))
            .toEqual([T1, T2]);
    });
    it('degrades to own-tenant-only on invalid JSON', () => {
        expect(buildResolverTenantSet(T1, 'not json')).toEqual([T1]);
    });
});

describe('resolveMemberForTenants', () => {
    it('returns Unmatched for empty tenant set or empty card', async () => {
        expect(await resolveMemberForTenants([], 'SW123')).toEqual(
            { status: 'Unmatched', memberId: null, ambiguousCount: null });
        expect(await resolveMemberForTenants([T1], '   ')).toEqual(
            { status: 'Unmatched', memberId: null, ambiguousCount: null });
    });

    it('binds every tenant in the set into an IN (...) clause', async () => {
        mockNextRecordset = [{ MemberId: 'M1', HouseholdMemberID: 'SW8153334' }];
        const res = await resolveMemberForTenants([T1, T2], 'SW8153334');
        expect(res).toEqual({ status: 'Matched', memberId: 'M1', ambiguousCount: null });
        expect(mockLastQuery).toMatch(/TenantId IN \(@t0, @t1\)/);
        expect(mockLastInputs.t0).toBe(T1);
        expect(mockLastInputs.t1).toBe(T2);
        // card normalized to lower-case, dashes/spaces stripped
        expect(mockLastInputs.hid).toBe('sw8153334');
    });

    it('matches a card that lives in a SECOND allowed tenant (the core fix)', async () => {
        // Simulates John Simmons: card under ShareWELL (T2), form under T1.
        mockNextRecordset = [{ MemberId: 'JOHN', HouseholdMemberID: 'SW8153334' }];
        const res = await resolveMemberForTenants([T1, T2], 'SW8153334');
        expect(res.status).toBe('Matched');
        expect(res.memberId).toBe('JOHN');
    });

    it('is Ambiguous when a card resolves to multiple members across the set', async () => {
        mockNextRecordset = [
            { MemberId: 'M1', HouseholdMemberID: 'SW1' },
            { MemberId: 'M2', HouseholdMemberID: 'SW1' }
        ];
        const res = await resolveMemberForTenants([T1, T2], 'SW1');
        expect(res).toEqual({ status: 'Ambiguous', memberId: null, ambiguousCount: 2 });
    });

    it('is Unmatched when the card exists in no allowed tenant', async () => {
        mockNextRecordset = [];
        const res = await resolveMemberForTenants([T1, T2], 'SW-NOPE');
        expect(res).toEqual({ status: 'Unmatched', memberId: null, ambiguousCount: null });
    });
});

describe('resolveMemberForTenants — email/phone fallback', () => {
    it('matches by email (unique), case-insensitive + trimmed', async () => {
        mockNextRecordset = [{ MemberId: 'JOHN' }];
        const res = await resolveMemberForTenants([T1, T2], { email: '  John@Example.COM ' });
        expect(res).toEqual({ status: 'Matched', memberId: 'JOHN', ambiguousCount: null });
        expect(mockLastQuery).toMatch(/u\.Email/);
        expect(mockLastInputs.email).toBe('john@example.com');
    });

    it('is Ambiguous if an email somehow matches more than one member', async () => {
        mockNextRecordset = [{ MemberId: 'A' }, { MemberId: 'B' }];
        const res = await resolveMemberForTenants([T1], { email: 'dup@x.com' });
        expect(res).toEqual({ status: 'Ambiguous', memberId: null, ambiguousCount: 2 });
    });

    it('matches by phone, normalized to last 10 digits', async () => {
        mockNextRecordset = [{ MemberId: 'P1', HouseholdId: 'H1', RelationshipType: 'P' }];
        const res = await resolveMemberForTenants([T1], { phone: '+1 (555) 123-4567' });
        expect(res).toEqual({ status: 'Matched', memberId: 'P1', ambiguousCount: null });
        expect(mockLastQuery).toMatch(/PhoneNumber/);
        expect(mockLastInputs.ph).toBe('5551234567');
    });

    it('collapses a same-household phone match to the primary (P) member', async () => {
        mockNextRecordset = [
            { MemberId: 'KID', HouseholdId: 'H1', RelationshipType: 'C' },
            { MemberId: 'DAD', HouseholdId: 'H1', RelationshipType: 'P' }
        ];
        const res = await resolveMemberForTenants([T1], { phone: '5551234567' });
        expect(res).toEqual({ status: 'Matched', memberId: 'DAD', ambiguousCount: null });
    });

    it('is Ambiguous when a phone spans different households', async () => {
        mockNextRecordset = [
            { MemberId: 'A', HouseholdId: 'H1', RelationshipType: 'P' },
            { MemberId: 'B', HouseholdId: 'H2', RelationshipType: 'P' }
        ];
        const res = await resolveMemberForTenants([T1], { phone: '5551234567' });
        expect(res).toEqual({ status: 'Ambiguous', memberId: null, ambiguousCount: 2 });
    });

    it('lets a typed member id short-circuit before email/phone', async () => {
        // Card matches; email/phone must never be queried.
        mockNextRecordset = (text) => (/HouseholdMemberID/.test(text) ? [{ MemberId: 'M1' }] : []);
        const res = await resolveMemberForTenants([T1], {
            memberIdText: 'SW1',
            email: 'x@y.com',
            phone: '5551234567'
        });
        expect(res).toEqual({ status: 'Matched', memberId: 'M1', ambiguousCount: null });
        expect(mockLastQuery).toMatch(/HouseholdMemberID/);
        expect(mockLastQuery).not.toMatch(/u\.Email/);
    });

    it('tries email before phone (email wins when both could match)', async () => {
        mockNextRecordset = (text) => {
            if (/u\.Email/.test(text)) return [{ MemberId: 'BY_EMAIL' }];
            if (/PhoneNumber/.test(text)) return [{ MemberId: 'BY_PHONE', HouseholdId: 'H1', RelationshipType: 'P' }];
            return [];
        };
        const res = await resolveMemberForTenants([T1], { email: 'x@y.com', phone: '5551234567' });
        expect(res.memberId).toBe('BY_EMAIL');
        expect(mockLastQuery).toMatch(/u\.Email/);
    });

    it('falls through to phone when email misses', async () => {
        mockNextRecordset = (text) => {
            if (/u\.Email/.test(text)) return [];
            if (/PhoneNumber/.test(text)) return [{ MemberId: 'BY_PHONE', HouseholdId: 'H1', RelationshipType: 'P' }];
            return [];
        };
        const res = await resolveMemberForTenants([T1], { email: 'x@y.com', phone: '5551234567' });
        expect(res).toEqual({ status: 'Matched', memberId: 'BY_PHONE', ambiguousCount: null });
        expect(mockLastQuery).toMatch(/PhoneNumber/);
    });

    it('is Unmatched when nothing was supplied', async () => {
        const res = await resolveMemberForTenants([T1], {});
        expect(res).toEqual({ status: 'Unmatched', memberId: null, ambiguousCount: null });
    });
});

describe('resolveMemberForTenant (single-tenant back-compat)', () => {
    it('delegates with a one-tenant IN clause', async () => {
        mockNextRecordset = [{ MemberId: 'M1', HouseholdMemberID: 'SW1' }];
        const res = await resolveMemberForTenant(T1, 'SW1');
        expect(res.status).toBe('Matched');
        expect(mockLastQuery).toMatch(/TenantId IN \(@t0\)/);
        expect(mockLastInputs.t0).toBe(T1);
    });
});
