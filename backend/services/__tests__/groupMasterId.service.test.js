/**
 * Unit tests for groupMasterIdService.js
 *
 * Covers (no DB required for pure helpers; DB-backed functions use mocked pool):
 *  - isValidGroupIdSlug — valid/invalid format (location IDs)
 *  - isValidMasterGroupId — 6-digit master ID format
 *  - recomputeLocationGroupIds — single vs. multi-location, override flag
 *  - validateMasterGroupId — format + uniqueness delegation
 *  - validateLocationGroupId — format + uniqueness delegation
 *  - suggestMasterGroupId — next available 6-digit ID
 *  - resolveMasterGroupIdForCreate — auto-assign or validate provided value
 */

'use strict';

// ---- DB mock ----
const mockInput = jest.fn().mockReturnThis();
let mockQueryResponses = [];
let mockQueryCallIndex = 0;
const mockQuery = jest.fn().mockImplementation(() => {
    const response = mockQueryResponses[mockQueryCallIndex++] || { recordset: [] };
    return Promise.resolve(response);
});
const mockRequest = jest.fn(() => ({ input: mockInput, query: mockQuery }));
const mockPool = { request: mockRequest };

jest.mock('../../config/database', () => ({
    getPool: jest.fn(async () => mockPool),
    sql: {
        UniqueIdentifier: 'UniqueIdentifier',
        NVarChar: jest.fn((n) => `NVarChar(${n})`),
        Int: 'Int',
        Bit: 'Bit',
    },
}));

jest.mock('mssql', () => ({
    UniqueIdentifier: 'UniqueIdentifier',
    NVarChar: jest.fn((n) => `NVarChar(${n})`),
    Int: 'Int',
    Bit: 'Bit',
}));

jest.mock('../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
}));

jest.mock('crypto', () => ({
    randomInt: jest.fn(() => 482913),
}));

const svc = require('../groupMasterIdService');

const GROUP_ID   = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_ID  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const LOC_1      = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const LOC_2      = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const LOC_3      = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

function setResponses(...responses) {
    mockQueryCallIndex = 0;
    mockQueryResponses = responses;
    mockInput.mockClear();
    mockQuery.mockClear();
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('isValidGroupIdSlug', () => {
    test('valid slugs (location IDs)', () => {
        expect(svc.isValidGroupIdSlug('000042')).toBe(true);
        expect(svc.isValidGroupIdSlug('000042-01')).toBe(true);
        expect(svc.isValidGroupIdSlug('ACME-CORP')).toBe(true);
    });

    test('invalid slugs', () => {
        expect(svc.isValidGroupIdSlug('')).toBe(false);
        expect(svc.isValidGroupIdSlug(null)).toBe(false);
        expect(svc.isValidGroupIdSlug('ACME CORP')).toBe(false);
        expect(svc.isValidGroupIdSlug('A'.repeat(101))).toBe(false);
    });
});

describe('isValidMasterGroupId', () => {
    test('valid 6-digit IDs', () => {
        expect(svc.isValidMasterGroupId('000001')).toBe(true);
        expect(svc.isValidMasterGroupId('000042')).toBe(true);
        expect(svc.isValidMasterGroupId('999999')).toBe(true);
    });

    test('invalid master IDs', () => {
        expect(svc.isValidMasterGroupId('')).toBe(false);
        expect(svc.isValidMasterGroupId('42')).toBe(false);
        expect(svc.isValidMasterGroupId('0000042')).toBe(false);
        expect(svc.isValidMasterGroupId('ACME-CORP')).toBe(false);
        expect(svc.isValidMasterGroupId('00004a')).toBe(false);
    });
});

describe('formatMasterGroupId', () => {
    test('pads to 6 digits', () => {
        expect(svc.formatMasterGroupId(42)).toBe('000042');
        expect(svc.formatMasterGroupId(1)).toBe('000001');
    });
});

// ---------------------------------------------------------------------------
// recomputeLocationGroupIds
// ---------------------------------------------------------------------------

describe('recomputeLocationGroupIds', () => {
    beforeEach(() => {
        mockInput.mockClear();
        mockQuery.mockClear();
    });

    test('returns early when group has no AllAboardMasterGroupId', async () => {
        setResponses(
            { recordset: [{ AllAboardMasterGroupId: null }] },
        );
        const result = await svc.recomputeLocationGroupIds(GROUP_ID);
        expect(result).toEqual({ updated: 0, masterGroupId: null });
        expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    test('single location → AllAboardGroupId = masterGroupId (no suffix)', async () => {
        setResponses(
            { recordset: [{ AllAboardMasterGroupId: '000042' }] },
            { recordset: [{ LocationId: LOC_1, IsPrimary: 1, IsGroupIdOverride: 0, CreatedDate: new Date() }] },
            { rowsAffected: [1] },
        );
        const result = await svc.recomputeLocationGroupIds(GROUP_ID);
        expect(result.updated).toBe(1);
        const groupIdCall = mockInput.mock.calls.find(c => c[0] === 'AllAboardGroupId');
        expect(groupIdCall[2]).toBe('000042');
    });

    test('two locations → -01 / -02 suffixes', async () => {
        const d1 = new Date('2025-01-01');
        const d2 = new Date('2025-02-01');
        setResponses(
            { recordset: [{ AllAboardMasterGroupId: '000042' }] },
            {
                recordset: [
                    { LocationId: LOC_1, IsPrimary: 1, IsGroupIdOverride: 0, CreatedDate: d1 },
                    { LocationId: LOC_2, IsPrimary: 0, IsGroupIdOverride: 0, CreatedDate: d2 },
                ],
            },
            { rowsAffected: [1] },
            { rowsAffected: [1] },
        );
        const result = await svc.recomputeLocationGroupIds(GROUP_ID);
        expect(result.updated).toBe(2);
        const groupIdInputs = mockInput.mock.calls
            .filter(c => c[0] === 'AllAboardGroupId')
            .map(c => c[2]);
        expect(groupIdInputs).toEqual(['000042-01', '000042-02']);
    });
});

// ---------------------------------------------------------------------------
// validateMasterGroupId
// ---------------------------------------------------------------------------

describe('validateMasterGroupId', () => {
    beforeEach(() => {
        mockInput.mockClear();
        mockQuery.mockClear();
    });

    test('returns error for invalid format', async () => {
        const { valid, errors } = await svc.validateMasterGroupId(mockPool, TENANT_ID, 'ACME-CORP', null);
        expect(valid).toBe(false);
        expect(errors.some(e => e.includes('6 digits'))).toBe(true);
        expect(mockQuery).not.toHaveBeenCalled();
    });

    test('returns valid when ID is unique in tenant', async () => {
        setResponses({ recordset: [{ cnt: 0 }] });
        const { valid, errors } = await svc.validateMasterGroupId(mockPool, TENANT_ID, '000042', null);
        expect(valid).toBe(true);
        expect(errors).toEqual([]);
    });

    test('returns error when ID is taken in tenant', async () => {
        setResponses({ recordset: [{ cnt: 1 }] });
        const { valid, errors } = await svc.validateMasterGroupId(mockPool, TENANT_ID, '000042', null);
        expect(valid).toBe(false);
        expect(errors.some(e => e.includes('already used'))).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// validateLocationGroupId
// ---------------------------------------------------------------------------

describe('validateLocationGroupId', () => {
    test('returns valid for numeric location suffix format', async () => {
        setResponses({ recordset: [{ cnt: 0 }] });
        const { valid } = await svc.validateLocationGroupId(mockPool, GROUP_ID, '000042-01', null);
        expect(valid).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// suggestMasterGroupId
// ---------------------------------------------------------------------------

describe('suggestMasterGroupId', () => {
    beforeEach(() => {
        mockInput.mockClear();
        mockQuery.mockClear();
    });

    test('returns random available 6-digit ID', async () => {
        setResponses(
            { recordset: [{ TenantId: TENANT_ID }] },
            { recordset: [{ cnt: 0 }] },
        );
        const result = await svc.suggestMasterGroupId(mockPool, GROUP_ID);
        expect(result.suggestion).toBe('482913');
        expect(result.available).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// resolveMasterGroupIdForCreate
// ---------------------------------------------------------------------------

describe('resolveMasterGroupIdForCreate', () => {
    beforeEach(() => {
        mockInput.mockClear();
        mockQuery.mockClear();
    });

    test('auto-assigns random ID when no value provided', async () => {
        setResponses({ recordset: [{ cnt: 0 }] });
        const result = await svc.resolveMasterGroupIdForCreate(mockPool, TENANT_ID, 'Pig and Sprout', null);
        expect(result).toEqual({ ok: true, value: '482913' });
    });

    test('rejects non-numeric provided value', async () => {
        const result = await svc.resolveMasterGroupIdForCreate(mockPool, TENANT_ID, 'Acme', 'ACME-CORP');
        expect(result.ok).toBe(false);
        expect(result.status).toBe(400);
    });

    test('accepts valid provided value when unique', async () => {
        setResponses({ recordset: [{ cnt: 0 }] });
        const result = await svc.resolveMasterGroupIdForCreate(mockPool, TENANT_ID, 'Acme', '000099');
        expect(result).toEqual({ ok: true, value: '000099' });
    });
});
