/**
 * Unit/integration tests for VendorGroupIdService location vendor ID methods.
 * DB pool is fully mocked — no live DB required.
 */

jest.mock('../../config/database', () => {
    const requestMock = {
        input: jest.fn().mockReturnThis(),
        query: jest.fn(),
    };
    const poolMock = {
        request: jest.fn(() => ({ ...requestMock, input: jest.fn().mockReturnThis(), query: jest.fn() })),
    };
    return {
        getPool: jest.fn().mockResolvedValue(poolMock),
        sql: require('mssql'),
        __poolMock: poolMock,
        __requestMock: requestMock,
    };
});

const VendorGroupIdService = require('../vendorGroupIdService');
const db = require('../../config/database');

function makePool(...queryResults) {
    let callCount = 0;
    const pool = {
        request: jest.fn(() => {
            const qr = queryResults[callCount] || { recordset: [] };
            callCount++;
            return {
                input: jest.fn().mockReturnThis(),
                query: jest.fn().mockResolvedValue(qr),
            };
        }),
    };
    db.getPool.mockResolvedValue(pool);
    return pool;
}

const VENDOR_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const GROUP_ID  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const LOC_ID_1  = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const LOC_ID_2  = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const USER_ID   = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const TENANT_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

// ----------------------------------------------------------------
// isLocationVendorIdInUse
// ----------------------------------------------------------------
describe('VendorGroupIdService.isLocationVendorIdInUse', () => {
    test('returns false when neither table has the ID', async () => {
        const pool = {
            request: jest.fn(() => ({
                input: jest.fn().mockReturnThis(),
                query: jest.fn().mockResolvedValue({ recordset: [] }),
            })),
        };
        const result = await VendorGroupIdService.isLocationVendorIdInUse(pool, VENDOR_ID, 'MW1001');
        expect(result).toBe(false);
    });

    test('returns true when GroupProductVendorGroupIds has the ID', async () => {
        let call = 0;
        const pool = {
            request: jest.fn(() => ({
                input: jest.fn().mockReturnThis(),
                query: jest.fn().mockImplementation(() => {
                    call++;
                    // First call = GroupProductVendorGroupIds check
                    return Promise.resolve({ recordset: call === 1 ? [{ 1: 1 }] : [] });
                }),
            })),
        };
        const result = await VendorGroupIdService.isLocationVendorIdInUse(pool, VENDOR_ID, 'MW1001');
        expect(result).toBe(true);
    });

    test('returns true when GroupLocationVendorIds has the ID', async () => {
        let call = 0;
        const pool = {
            request: jest.fn(() => ({
                input: jest.fn().mockReturnThis(),
                query: jest.fn().mockImplementation(() => {
                    call++;
                    // First call = GroupProductVendorGroupIds (empty), second = GroupLocationVendorIds (hit)
                    return Promise.resolve({ recordset: call === 2 ? [{ 1: 1 }] : [] });
                }),
            })),
        };
        const result = await VendorGroupIdService.isLocationVendorIdInUse(pool, VENDOR_ID, 'MW1001');
        expect(result).toBe(true);
    });
});

// ----------------------------------------------------------------
// getLocationSetting
// ----------------------------------------------------------------
describe('VendorGroupIdService.getLocationSetting', () => {
    test('returns null when no setting row exists', async () => {
        makePool({ recordset: [] });
        const result = await VendorGroupIdService.getLocationSetting(GROUP_ID, VENDOR_ID);
        expect(result).toBeNull();
    });

    test('returns setting row when it exists', async () => {
        const row = { SettingId: 'sid', GroupId: GROUP_ID, VendorId: VENDOR_ID, LocationVendorGroupIdsEnabled: true };
        makePool({ recordset: [row] });
        const result = await VendorGroupIdService.getLocationSetting(GROUP_ID, VENDOR_ID);
        expect(result).toEqual(row);
    });
});

// ----------------------------------------------------------------
// upsertLocationSetting
// ----------------------------------------------------------------
describe('VendorGroupIdService.upsertLocationSetting', () => {
    test('inserts new row when none exists', async () => {
        // Query 1: check existing (empty) → insert
        const queries = [];
        const pool = {
            request: jest.fn(() => ({
                input: jest.fn().mockReturnThis(),
                query: jest.fn().mockImplementation(q => {
                    queries.push(q);
                    return Promise.resolve({ recordset: [] });
                }),
            })),
        };
        db.getPool.mockResolvedValue(pool);
        const result = await VendorGroupIdService.upsertLocationSetting(
            GROUP_ID, VENDOR_ID, true, TENANT_ID, USER_ID
        );
        expect(result.success).toBe(true);
        expect(result.data.LocationVendorGroupIdsEnabled).toBe(true);
        // Should have SELECT and then INSERT
        expect(queries.some(q => q.includes('INSERT'))).toBe(true);
    });

    test('updates existing row when one exists', async () => {
        const queries = [];
        let call = 0;
        const pool = {
            request: jest.fn(() => ({
                input: jest.fn().mockReturnThis(),
                query: jest.fn().mockImplementation(q => {
                    queries.push(q);
                    call++;
                    // First call is SELECT — return existing row
                    return Promise.resolve({
                        recordset: call === 1 ? [{ SettingId: 'sid' }] : []
                    });
                }),
            })),
        };
        db.getPool.mockResolvedValue(pool);
        const result = await VendorGroupIdService.upsertLocationSetting(
            GROUP_ID, VENDOR_ID, false, TENANT_ID, USER_ID
        );
        expect(result.success).toBe(true);
        expect(result.data.LocationVendorGroupIdsEnabled).toBe(false);
        expect(queries.some(q => q.includes('UPDATE'))).toBe(true);
    });
});

// ----------------------------------------------------------------
// upsertLocationVendorId
// ----------------------------------------------------------------
describe('VendorGroupIdService.upsertLocationVendorId', () => {
    test('returns error when vendor location ID is already in use', async () => {
        // isLocationVendorIdInUse → true (both checks look at pool.request)
        let call = 0;
        const pool = {
            request: jest.fn(() => ({
                input: jest.fn().mockReturnThis(),
                query: jest.fn().mockImplementation(() => {
                    call++;
                    // First call GroupProductVendorGroupIds has the ID → in use
                    return Promise.resolve({ recordset: call === 1 ? [{ 1: 1 }] : [] });
                }),
            })),
        };
        db.getPool.mockResolvedValue(pool);
        const result = await VendorGroupIdService.upsertLocationVendorId(
            LOC_ID_1, VENDOR_ID, 'MW1001', TENANT_ID, USER_ID
        );
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/already in use/i);
    });

    test('inserts new row when not in use and no existing row', async () => {
        const queries = [];
        let call = 0;
        const pool = {
            request: jest.fn(() => ({
                input: jest.fn().mockReturnThis(),
                query: jest.fn().mockImplementation(q => {
                    queries.push(q);
                    call++;
                    return Promise.resolve({ recordset: [] }); // not in use, no existing
                }),
            })),
        };
        db.getPool.mockResolvedValue(pool);
        const result = await VendorGroupIdService.upsertLocationVendorId(
            LOC_ID_1, VENDOR_ID, 'MW1001', TENANT_ID, USER_ID
        );
        expect(result.success).toBe(true);
        expect(result.vendorLocationId).toBe('MW1001');
        expect(queries.some(q => q.includes('INSERT'))).toBe(true);
    });

    test('updates existing row', async () => {
        const queries = [];
        let call = 0;
        const pool = {
            request: jest.fn(() => ({
                input: jest.fn().mockReturnThis(),
                query: jest.fn().mockImplementation(q => {
                    queries.push(q);
                    call++;
                    // calls: 1=isInUse/GVGI, 2=isInUse/GLVI, 3=check existing (found)
                    if (call === 3) return Promise.resolve({ recordset: [{ LocationVendorIdRow: 'rid' }] });
                    return Promise.resolve({ recordset: [] });
                }),
            })),
        };
        db.getPool.mockResolvedValue(pool);
        const result = await VendorGroupIdService.upsertLocationVendorId(
            LOC_ID_1, VENDOR_ID, 'MW9999', TENANT_ID, USER_ID
        );
        expect(result.success).toBe(true);
        expect(queries.some(q => q.includes('UPDATE'))).toBe(true);
    });
});

// ----------------------------------------------------------------
// generateLocationVendorGroupIds — success path
// ----------------------------------------------------------------
describe('VendorGroupIdService.generateLocationVendorGroupIds', () => {
    test('returns created=0 when no locations have missing IDs', async () => {
        // Mock: group exists, previewLocationVendorGroupIds → all alreadyExists
        const previewSpy = jest.spyOn(VendorGroupIdService, 'previewLocationVendorGroupIds')
            .mockResolvedValueOnce({
                success: true,
                preview: [
                    { locationId: LOC_ID_1, locationName: 'HQ', vendorLocationId: 'MW1001', alreadyExists: true },
                ],
            });
        makePool({ recordset: [{ TenantId: TENANT_ID }] }); // group query
        const result = await VendorGroupIdService.generateLocationVendorGroupIds(GROUP_ID, VENDOR_ID, USER_ID);
        expect(result.success).toBe(true);
        expect(result.created).toBe(0);
        previewSpy.mockRestore();
    });

    test('creates rows for locations missing an ID', async () => {
        const previewSpy = jest.spyOn(VendorGroupIdService, 'previewLocationVendorGroupIds')
            .mockResolvedValueOnce({
                success: true,
                preview: [
                    { locationId: LOC_ID_1, locationName: 'HQ',    vendorLocationId: 'MW1000', alreadyExists: false },
                    { locationId: LOC_ID_2, locationName: 'Branch', vendorLocationId: 'MW1001', alreadyExists: false },
                ],
            });

        const queries = [];
        const pool = {
            request: jest.fn(() => ({
                input: jest.fn().mockReturnThis(),
                query: jest.fn().mockImplementation(q => {
                    queries.push(q);
                    return Promise.resolve({ recordset: [{ TenantId: TENANT_ID }] });
                }),
            })),
        };
        db.getPool.mockResolvedValue(pool);

        const result = await VendorGroupIdService.generateLocationVendorGroupIds(GROUP_ID, VENDOR_ID, USER_ID);
        expect(result.success).toBe(true);
        expect(result.created).toBe(2);
        expect(queries.filter(q => q.includes('INSERT')).length).toBe(2);
        previewSpy.mockRestore();
    });
});

// ----------------------------------------------------------------
// getLocationVendorIds
// ----------------------------------------------------------------
describe('VendorGroupIdService.getLocationVendorIds', () => {
    test('returns location IDs from DB', async () => {
        const row = { LocationVendorIdRow: 'rid', LocationId: LOC_ID_1, VendorLocationId: 'MW1001', IsAutoGenerated: 1, LocationName: 'HQ', IsPrimary: true };
        makePool({ recordset: [row] });
        const result = await VendorGroupIdService.getLocationVendorIds(GROUP_ID, VENDOR_ID);
        expect(result.success).toBe(true);
        expect(result.locationIds).toHaveLength(1);
        expect(result.locationIds[0].VendorLocationId).toBe('MW1001');
    });

    test('returns empty array when none found', async () => {
        makePool({ recordset: [] });
        const result = await VendorGroupIdService.getLocationVendorIds(GROUP_ID, VENDOR_ID);
        expect(result.success).toBe(true);
        expect(result.locationIds).toHaveLength(0);
    });
});
