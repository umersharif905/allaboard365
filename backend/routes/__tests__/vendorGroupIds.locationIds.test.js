/**
 * Route tests for vendor-group-ids location-setting and location-ids endpoints.
 */

// ---- Auth middleware mock ----
jest.mock('../../middleware/auth', () => ({
    authorize: () => (_req, _res, next) => next(),
    authenticate: (req, _res, next) => {
        req.user = req.user || {
            UserId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
            TenantId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
            userType: 'SysAdmin',
            currentRole: 'SysAdmin',
            roles: ['SysAdmin'],
        };
        next();
    },
    getUserRoles: (user) => {
        if (!user) return [];
        if (Array.isArray(user.roles) && user.roles.length) return user.roles;
        if (user.currentRole) return [user.currentRole];
        return ['SysAdmin'];
    },
    optionalAuth: (_req, _res, next) => next(),
}));

// ---- DB mock ----
const mockQuery = jest.fn();
const mockInput = jest.fn().mockReturnThis();
const mockRequest = jest.fn(() => ({ input: mockInput, query: mockQuery }));

jest.mock('../../config/database', () => ({
    getPool: jest.fn(async () => ({ request: mockRequest })),
    sql: {
        UniqueIdentifier: 'UniqueIdentifier',
        NVarChar: jest.fn((n) => `NVarChar(${n})`),
        Int: 'Int',
        Bit: 'Bit',
        VarChar: 'VarChar',
        MAX: 'MAX',
        DateTime2: 'DateTime2',
    },
}));
jest.mock('mssql', () => ({
    UniqueIdentifier: 'UniqueIdentifier',
    NVarChar: jest.fn((n) => `NVarChar(${n})`),
    Int: 'Int',
    Bit: 'Bit',
    VarChar: 'VarChar',
    MAX: 'MAX',
    DateTime2: 'DateTime2',
}));

// ---- Service mock ----
jest.mock('../../services/vendorGroupIdService');

// ---- groupRouteAccess mock ----
jest.mock('../../utils/groupRouteAccess', () => ({
    appendGroupScopeForTenantUsers: jest.fn((q) => q),
    GROUP_DETAIL_READ_STATUS_SQL: `Status IN ('Active','Pending')`,
}));

const request = require('supertest');
const express = require('express');
const vendorGroupIdsRouter = require('../vendorGroupIds');
const VendorGroupIdService = require('../../services/vendorGroupIdService');

const VENDOR_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const GROUP_ID  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const LOC_ID    = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const TENANT_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const USER_ID   = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = {
            UserId: USER_ID,
            TenantId: TENANT_ID,
            userType: 'SysAdmin',
            currentRole: 'SysAdmin',
            roles: ['SysAdmin'],
        };
        next();
    });
    app.use('/api/vendor-group-ids', vendorGroupIdsRouter);
    return app;
}

beforeEach(() => {
    jest.clearAllMocks();
});

// ----------------------------------------------------------------
// GET location-setting
// ----------------------------------------------------------------
describe('GET /api/vendor-group-ids/group/:groupId/vendor/:vendorId/location-setting', () => {
    test('returns setting when it exists', async () => {
        mockQuery.mockResolvedValueOnce({
            recordset: [{ GroupId: GROUP_ID, TenantId: TENANT_ID }],
        });
        VendorGroupIdService.getLocationSetting.mockResolvedValue({
            GroupId: GROUP_ID, VendorId: VENDOR_ID, LocationVendorGroupIdsEnabled: true,
        });

        const res = await request(makeApp())
            .get(`/api/vendor-group-ids/group/${GROUP_ID}/vendor/${VENDOR_ID}/location-setting`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.LocationVendorGroupIdsEnabled).toBe(true);
    });

    test('returns default disabled when no setting row exists', async () => {
        mockQuery.mockResolvedValueOnce({
            recordset: [{ GroupId: GROUP_ID, TenantId: TENANT_ID }],
        });
        VendorGroupIdService.getLocationSetting.mockResolvedValue(null);

        const res = await request(makeApp())
            .get(`/api/vendor-group-ids/group/${GROUP_ID}/vendor/${VENDOR_ID}/location-setting`);

        expect(res.status).toBe(200);
        expect(res.body.data.LocationVendorGroupIdsEnabled).toBe(false);
    });
});

// ----------------------------------------------------------------
// PUT location-setting
// ----------------------------------------------------------------
describe('PUT /api/vendor-group-ids/group/:groupId/vendor/:vendorId/location-setting', () => {
    test('400 when locationVendorGroupIdsEnabled is missing', async () => {
        const res = await request(makeApp())
            .put(`/api/vendor-group-ids/group/${GROUP_ID}/vendor/${VENDOR_ID}/location-setting`)
            .send({});
        expect(res.status).toBe(400);
    });

    test('200 on successful update', async () => {
        mockQuery.mockResolvedValueOnce({
            recordset: [{ TenantId: TENANT_ID }],
        });
        VendorGroupIdService.upsertLocationSetting.mockResolvedValue({
            success: true, data: { LocationVendorGroupIdsEnabled: true },
        });

        const res = await request(makeApp())
            .put(`/api/vendor-group-ids/group/${GROUP_ID}/vendor/${VENDOR_ID}/location-setting`)
            .send({ locationVendorGroupIdsEnabled: true });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    test('404 when group not found', async () => {
        mockQuery.mockResolvedValueOnce({ recordset: [] });

        const res = await request(makeApp())
            .put(`/api/vendor-group-ids/group/${GROUP_ID}/vendor/${VENDOR_ID}/location-setting`)
            .send({ locationVendorGroupIdsEnabled: true });

        expect(res.status).toBe(404);
    });
});

// ----------------------------------------------------------------
// GET location-ids/generate (preview)
// ----------------------------------------------------------------
describe('GET /api/vendor-group-ids/group/:groupId/vendor/:vendorId/location-ids/generate', () => {
    test('200 with preview list', async () => {
        VendorGroupIdService.previewLocationVendorGroupIds.mockResolvedValue({
            success: true,
            preview: [
                { locationId: LOC_ID, locationName: 'HQ', vendorLocationId: 'MW1000', alreadyExists: false },
            ],
        });

        const res = await request(makeApp())
            .get(`/api/vendor-group-ids/group/${GROUP_ID}/vendor/${VENDOR_ID}/location-ids/generate`);

        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].vendorLocationId).toBe('MW1000');
    });

    test('400 when service returns error', async () => {
        VendorGroupIdService.previewLocationVendorGroupIds.mockResolvedValue({
            success: false, error: 'Vendor not configured', preview: [],
        });

        const res = await request(makeApp())
            .get(`/api/vendor-group-ids/group/${GROUP_ID}/vendor/${VENDOR_ID}/location-ids/generate`);

        expect(res.status).toBe(400);
    });
});

// ----------------------------------------------------------------
// POST location-ids/generate (apply)
// ----------------------------------------------------------------
describe('POST /api/vendor-group-ids/group/:groupId/vendor/:vendorId/location-ids/generate', () => {
    test('200 returns created count', async () => {
        VendorGroupIdService.generateLocationVendorGroupIds.mockResolvedValue({
            success: true, created: 2, errors: [],
        });

        const res = await request(makeApp())
            .post(`/api/vendor-group-ids/group/${GROUP_ID}/vendor/${VENDOR_ID}/location-ids/generate`);

        expect(res.status).toBe(200);
        expect(res.body.data.created).toBe(2);
    });

    test('400 when service returns error', async () => {
        VendorGroupIdService.generateLocationVendorGroupIds.mockResolvedValue({
            success: false, error: 'No config', created: 0, errors: [],
        });

        const res = await request(makeApp())
            .post(`/api/vendor-group-ids/group/${GROUP_ID}/vendor/${VENDOR_ID}/location-ids/generate`);

        expect(res.status).toBe(400);
    });
});

// ----------------------------------------------------------------
// PUT vendor-location-id (manual override)
// ----------------------------------------------------------------
describe('PUT /api/vendor-group-ids/group/:groupId/location/:locationId/vendor/:vendorId/vendor-location-id', () => {
    const url = `/api/vendor-group-ids/group/${GROUP_ID}/location/${LOC_ID}/vendor/${VENDOR_ID}/vendor-location-id`;

    test('400 when vendorLocationId is missing', async () => {
        const res = await request(makeApp()).put(url).send({});
        expect(res.status).toBe(400);
    });

    test('404 when location not found', async () => {
        mockQuery.mockResolvedValueOnce({ recordset: [] });

        const res = await request(makeApp()).put(url).send({ vendorLocationId: 'MW9999' });
        expect(res.status).toBe(404);
    });

    test('400 when vendorLocationId already in use', async () => {
        mockQuery.mockResolvedValueOnce({ recordset: [{ LocationId: LOC_ID, TenantId: TENANT_ID }] });
        VendorGroupIdService.upsertLocationVendorId.mockResolvedValue({
            success: false, error: 'already in use',
        });

        const res = await request(makeApp()).put(url).send({ vendorLocationId: 'MW9999' });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/already in use/i);
    });

    test('200 on successful manual override', async () => {
        mockQuery.mockResolvedValueOnce({ recordset: [{ LocationId: LOC_ID, TenantId: TENANT_ID }] });
        VendorGroupIdService.upsertLocationVendorId.mockResolvedValue({
            success: true, vendorLocationId: 'MW9999',
        });

        const res = await request(makeApp()).put(url).send({ vendorLocationId: 'MW9999' });
        expect(res.status).toBe(200);
        expect(res.body.data.vendorLocationId).toBe('MW9999');
    });
});

// ----------------------------------------------------------------
// AC3 — TenantAdmin role can enable/disable location vendor IDs
// ----------------------------------------------------------------
describe('AC3: TenantAdmin role — location-setting PUT/GET access', () => {
    function makeTenantAdminApp() {
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = {
                UserId: USER_ID,
                TenantId: TENANT_ID,
                userType: 'TenantAdmin',
                currentRole: 'TenantAdmin',
                roles: ['TenantAdmin'],
            };
            next();
        });
        app.use('/api/vendor-group-ids', vendorGroupIdsRouter);
        return app;
    }

    test('TenantAdmin can GET location-setting (200)', async () => {
        mockQuery.mockResolvedValueOnce({
            recordset: [{ GroupId: GROUP_ID, TenantId: TENANT_ID }],
        });
        VendorGroupIdService.getLocationSetting.mockResolvedValue({
            GroupId: GROUP_ID, VendorId: VENDOR_ID, LocationVendorGroupIdsEnabled: false,
        });

        const res = await request(makeTenantAdminApp())
            .get(`/api/vendor-group-ids/group/${GROUP_ID}/vendor/${VENDOR_ID}/location-setting`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    test('TenantAdmin can PUT location-setting (200)', async () => {
        mockQuery.mockResolvedValueOnce({
            recordset: [{ TenantId: TENANT_ID }],
        });
        VendorGroupIdService.upsertLocationSetting.mockResolvedValue({
            success: true, data: { LocationVendorGroupIdsEnabled: true },
        });

        const res = await request(makeTenantAdminApp())
            .put(`/api/vendor-group-ids/group/${GROUP_ID}/vendor/${VENDOR_ID}/location-setting`)
            .send({ locationVendorGroupIdsEnabled: true });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    test('TenantAdmin can POST location-ids/generate (200)', async () => {
        VendorGroupIdService.generateLocationVendorGroupIds.mockResolvedValue({
            success: true, created: 3, errors: [],
        });

        const res = await request(makeTenantAdminApp())
            .post(`/api/vendor-group-ids/group/${GROUP_ID}/vendor/${VENDOR_ID}/location-ids/generate`);

        expect(res.status).toBe(200);
        expect(res.body.data.created).toBe(3);
    });
});

// ----------------------------------------------------------------
// GET location-ids
// ----------------------------------------------------------------
describe('GET /api/vendor-group-ids/group/:groupId/vendor/:vendorId/location-ids', () => {
    test('200 returns location IDs list', async () => {
        VendorGroupIdService.getLocationVendorIds.mockResolvedValue({
            success: true,
            locationIds: [
                { LocationId: LOC_ID, VendorLocationId: 'MW1000', IsActive: true },
            ],
        });

        const res = await request(makeApp())
            .get(`/api/vendor-group-ids/group/${GROUP_ID}/vendor/${VENDOR_ID}/location-ids`);

        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].VendorLocationId).toBe('MW1000');
    });
});
