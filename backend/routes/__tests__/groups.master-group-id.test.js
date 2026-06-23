/**
 * Route tests for the AllAboard Master Group ID endpoints in groups.js:
 *
 *  GET  /api/groups/resolve/:identifier
 *  GET  /api/groups/validate-master-group-id
 *  GET  /api/groups/validate-location-group-id
 *  PATCH /api/groups/:groupId/master-group-id
 *  PATCH /api/groups/:groupId/locations/:locationId/group-id
 *
 * Tenant isolation is verified by asserting TenantId is passed to DB queries.
 */

'use strict';

// ---- Auth middleware mock ----
jest.mock('../../middleware/auth', () => ({
    authorize: () => (_req, _res, next) => next(),
    requireTenantAccess: (_req, _res, next) => next(),
    getUserRoles: jest.fn(() => ['TenantAdmin']),
    optionalAuth: (_req, _res, next) => next(),
}));

// ---- agentGroupAccess mock ----
jest.mock('../../utils/agentGroupAccess', () => ({
    getAccessibleAgentIdsForUser: jest.fn().mockResolvedValue([]),
    buildAgentScopeClause: jest.fn(() => '1=1'),
}));

// ---- PaymentMethodService mock ----
jest.mock('../../services/PaymentMethodService', () => ({
    ensureDimeCustomer: jest.fn(),
    validatePaymentMethodData: jest.fn(),
    createPaymentMethod: jest.fn(),
    insertPaymentMethod: jest.fn(),
    updatePaymentMethodDefaults: jest.fn(),
}));

// ---- DimeService mock ----
jest.mock('../../services/dimeService', () => ({}));

// ---- householdMemberIdService mock ----
jest.mock('../../services/householdMemberIdService', () => ({}));

// ---- householdMemberIdPrefix mock ----
jest.mock('../../utils/householdMemberIdPrefix', () => ({
    swapHouseholdMemberIdPrefix: jest.fn(),
    computePrefixSwapForGroupChange: jest.fn(),
}));

// ---- aiCensusParser mock ----
jest.mock('../../services/aiCensusParser.service', () => ({}));

// ---- shared services mock ----
jest.mock('../../services/shared', () => ({
    EnrollmentLinkService: {},
}));

// ---- constants mock ----
jest.mock('../../constants/linkExpiration', () => ({
    DEFAULT_LINK_EXPIRATION_HOURS: 48,
}));

// ---- groupMasterIdService mock ----
jest.mock('../../services/groupMasterIdService', () => ({
    isValidGroupIdSlug: jest.fn((v) => /^[A-Za-z0-9\-]{1,100}$/.test(v)),
    validateMasterGroupId: jest.fn(),
    validateLocationGroupId: jest.fn(),
    recomputeLocationGroupIds: jest.fn().mockResolvedValue({ updated: 1, masterGroupId: 'ACME' }),
    suggestMasterGroupId: jest.fn(),
}));

jest.mock('../../services/groupAccessService', () => ({
    verifyGroupAccess: jest.fn(),
    resolveGroupIdentifierForUser: jest.fn(),
}));

// ---- _groups-validation mock ----
jest.mock('../../routes/_groups-validation', () => ({
    isValidEarliestEffectiveDate: jest.fn(() => true),
}));

// ---- uploads mock ----
jest.mock('../../routes/uploads', () => ({
    authenticateUrls: jest.fn(() => (_req, _res, next) => next()),
}));

// ---- agentAssignable mock ----
jest.mock('../../utils/agentAssignable', () => ({
    assertAgentMayAssignToTargetAgent: jest.fn().mockResolvedValue(null),
}));

// ---- DB mock ----
const mockInput = jest.fn().mockReturnThis();
let mockQueryResponses = [];
let mockQueryCallIndex = 0;
const mockQuery = jest.fn().mockImplementation(() => {
    const response = mockQueryResponses[mockQueryCallIndex++] || { recordset: [], rowsAffected: [1] };
    return Promise.resolve(response);
});
const mockRequest = jest.fn(() => ({ input: mockInput, query: mockQuery }));
const mockTransaction = {
    request: mockRequest,
    begin: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
};
const mockPool = {
    request: mockRequest,
    transaction: jest.fn(() => mockTransaction),
};

jest.mock('../../config/database', () => ({
    getPool: jest.fn(async () => mockPool),
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
    Transaction: jest.fn().mockImplementation(() => ({
        request: mockRequest,
        begin: jest.fn().mockResolvedValue(undefined),
        commit: jest.fn().mockResolvedValue(undefined),
        rollback: jest.fn().mockResolvedValue(undefined),
    })),
}));

jest.mock('../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const groupsRouter = require('../groups');
const groupMasterIdService = require('../../services/groupMasterIdService');
const groupAccessService = require('../../services/groupAccessService');
const { getUserRoles } = require('../../middleware/auth');

const TENANT_ID  = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const GROUP_ID   = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const LOC_ID     = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const USER_ID    = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

function makeApp(role = 'TenantAdmin') {
    getUserRoles.mockReturnValue([role]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = {
            UserId: USER_ID,
            TenantId: TENANT_ID,
            userType: role,
            currentRole: role,
            roles: [role],
        };
        req.tenantId = TENANT_ID;
        next();
    });
    app.use('/api/groups', groupsRouter);
    return app;
}

function setQueryResponses(...responses) {
    mockQueryCallIndex = 0;
    mockQueryResponses = responses;
    mockInput.mockClear();
    mockQuery.mockClear();
}

// ---------------------------------------------------------------------------
// GET /api/groups/resolve/:identifier
// ---------------------------------------------------------------------------

describe('GET /api/groups/resolve/:identifier', () => {
    beforeEach(() => {
        groupAccessService.resolveGroupIdentifierForUser.mockReset();
    });

    test('returns 404 when no group matches', async () => {
        groupAccessService.resolveGroupIdentifierForUser.mockResolvedValue(null);
        const app = makeApp('TenantAdmin');
        const res = await request(app)
            .get(`/api/groups/resolve/UNKNOWN-ID`);
        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
    });

    test('returns group data when found', async () => {
        groupAccessService.resolveGroupIdentifierForUser.mockResolvedValue({
            GroupId: GROUP_ID,
            Name: 'Acme Corp',
            Status: 'Active',
            TenantId: TENANT_ID,
            AllAboardMasterGroupId: '482913',
            TenantName: 'Test Tenant',
        });
        const app = makeApp('TenantAdmin');
        const res = await request(app)
            .get(`/api/groups/resolve/482913`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.AllAboardMasterGroupId).toBe('482913');
        expect(res.body.data.groupId).toBe(GROUP_ID);
    });

    test('TenantAdmin passes active tenant into access service', async () => {
        groupAccessService.resolveGroupIdentifierForUser.mockResolvedValue(null);
        const app = makeApp('TenantAdmin');
        await request(app).get('/api/groups/resolve/482913');
        expect(groupAccessService.resolveGroupIdentifierForUser).toHaveBeenCalledWith(
            expect.anything(),
            '482913',
            expect.anything(),
            expect.objectContaining({ tenantId: expect.anything() })
        );
    });
});

// ---------------------------------------------------------------------------
// GET /api/groups/validate-master-group-id
// ---------------------------------------------------------------------------

describe('GET /api/groups/validate-master-group-id', () => {
    test('returns 400 when value param is missing', async () => {
        const app = makeApp('TenantAdmin');
        const res = await request(app)
            .get('/api/groups/validate-master-group-id');
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    test('returns valid=true when service returns no errors', async () => {
        groupMasterIdService.validateMasterGroupId.mockResolvedValue({ valid: true, errors: [] });
        const app = makeApp('TenantAdmin');
        const res = await request(app)
            .get('/api/groups/validate-master-group-id?value=ACME-CORP');
        expect(res.status).toBe(200);
        expect(res.body.data.valid).toBe(true);
    });

    test('returns valid=false when value is taken', async () => {
        groupMasterIdService.validateMasterGroupId.mockResolvedValue({
            valid: false,
            errors: ['"ACME-CORP" is already used by another group in this tenant.'],
        });
        const app = makeApp('TenantAdmin');
        const res = await request(app)
            .get('/api/groups/validate-master-group-id?value=ACME-CORP');
        expect(res.status).toBe(200);
        expect(res.body.data.valid).toBe(false);
        expect(res.body.data.errors.length).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// GET /api/groups/validate-location-group-id
// ---------------------------------------------------------------------------

describe('GET /api/groups/validate-location-group-id', () => {
    test('returns 400 when groupId is missing', async () => {
        const app = makeApp('TenantAdmin');
        const res = await request(app)
            .get('/api/groups/validate-location-group-id?value=ACME-01');
        expect(res.status).toBe(400);
    });

    test('returns 400 when value is missing', async () => {
        const app = makeApp('TenantAdmin');
        const res = await request(app)
            .get(`/api/groups/validate-location-group-id?groupId=${GROUP_ID}`);
        expect(res.status).toBe(400);
    });

    test('returns valid=true when location slug is unique', async () => {
        groupMasterIdService.validateLocationGroupId.mockResolvedValue({ valid: true, errors: [] });
        const app = makeApp('TenantAdmin');
        const res = await request(app)
            .get(`/api/groups/validate-location-group-id?value=ACME-01&groupId=${GROUP_ID}`);
        expect(res.status).toBe(200);
        expect(res.body.data.valid).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// PATCH /api/groups/:groupId/master-group-id
// ---------------------------------------------------------------------------

describe('PATCH /api/groups/:groupId/master-group-id', () => {
    test('returns 400 when value is missing', async () => {
        const app = makeApp('TenantAdmin');
        const res = await request(app)
            .patch(`/api/groups/${GROUP_ID}/master-group-id`)
            .send({});
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    test('returns 400 when format is invalid', async () => {
        groupMasterIdService.validateMasterGroupId.mockResolvedValue({
            valid: false,
            errors: ['Invalid format.'],
        });
        const app = makeApp('TenantAdmin');
        const res = await request(app)
            .patch(`/api/groups/${GROUP_ID}/master-group-id`)
            .send({ value: 'bad slug!' });
        expect(res.status).toBe(400);
    });

    test('returns 404 when group not found for tenant', async () => {
        groupMasterIdService.validateMasterGroupId.mockResolvedValue({ valid: true, errors: [] });
        setQueryResponses({ recordset: [] });  // group check fails
        const app = makeApp('TenantAdmin');
        const res = await request(app)
            .patch(`/api/groups/${GROUP_ID}/master-group-id`)
            .send({ value: 'ACME-CORP' });
        expect(res.status).toBe(404);
    });

    test('updates master group ID and returns success', async () => {
        groupMasterIdService.validateMasterGroupId.mockResolvedValue({ valid: true, errors: [] });
        setQueryResponses(
            { recordset: [{ GroupId: GROUP_ID, TenantId: TENANT_ID }] },  // group check
            { rowsAffected: [1] },  // UPDATE
        );
        const app = makeApp('TenantAdmin');
        const res = await request(app)
            .patch(`/api/groups/${GROUP_ID}/master-group-id`)
            .send({ value: 'ACME-CORP' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.allAboardMasterGroupId).toBe('ACME-CORP');
    });

    test('TenantId is passed in group access check query (isolation)', async () => {
        groupMasterIdService.validateMasterGroupId.mockResolvedValue({ valid: true, errors: [] });
        setQueryResponses(
            { recordset: [{ GroupId: GROUP_ID, TenantId: TENANT_ID }] },
            { rowsAffected: [1] },
        );
        const app = makeApp('TenantAdmin');
        await request(app)
            .patch(`/api/groups/${GROUP_ID}/master-group-id`)
            .send({ value: 'ACME' });
        const tenantInput = mockInput.mock.calls.find(c => c[0] === 'TenantId');
        expect(tenantInput).toBeDefined();
        expect(tenantInput[2]).toBe(TENANT_ID);
    });

    test('triggers recompute after successful update', async () => {
        groupMasterIdService.validateMasterGroupId.mockResolvedValue({ valid: true, errors: [] });
        groupMasterIdService.recomputeLocationGroupIds.mockResolvedValue({ updated: 1, masterGroupId: 'ACME' });
        setQueryResponses(
            { recordset: [{ GroupId: GROUP_ID, TenantId: TENANT_ID }] },
            { rowsAffected: [1] },
        );
        const app = makeApp('TenantAdmin');
        await request(app)
            .patch(`/api/groups/${GROUP_ID}/master-group-id`)
            .send({ value: 'ACME' });
        // Give the fire-and-forget a tick to resolve
        await new Promise(r => setTimeout(r, 10));
        expect(groupMasterIdService.recomputeLocationGroupIds).toHaveBeenCalledWith(GROUP_ID);
    });
});

// ---------------------------------------------------------------------------
// PATCH /api/groups/:groupId/locations/:locationId/group-id
// ---------------------------------------------------------------------------

describe('PATCH /api/groups/:groupId/locations/:locationId/group-id', () => {
    test('clears override and recomputes when value is null', async () => {
        groupMasterIdService.recomputeLocationGroupIds.mockResolvedValue({ updated: 1, masterGroupId: 'ACME' });
        setQueryResponses(
            { recordset: [{ LocationId: LOC_ID }] },
            { rowsAffected: [1] },
            { recordset: [{ AllAboardGroupId: 'ACME-01' }] },
        );
        const app = makeApp('TenantAdmin');
        const res = await request(app)
            .patch(`/api/groups/${GROUP_ID}/locations/${LOC_ID}/group-id`)
            .send({ value: null });
        expect(res.status).toBe(200);
        expect(res.body.data.isGroupIdOverride).toBe(false);
        expect(groupMasterIdService.recomputeLocationGroupIds).toHaveBeenCalledWith(GROUP_ID);
    });

    test('returns 400 when format validation fails', async () => {
        groupMasterIdService.validateLocationGroupId.mockResolvedValue({
            valid: false,
            errors: ['Invalid format.'],
        });
        setQueryResponses({ recordset: [{ LocationId: LOC_ID }] });
        const app = makeApp('TenantAdmin');
        const res = await request(app)
            .patch(`/api/groups/${GROUP_ID}/locations/${LOC_ID}/group-id`)
            .send({ value: 'bad slug!' });
        expect(res.status).toBe(400);
    });

    test('returns 404 when location not found', async () => {
        groupMasterIdService.validateLocationGroupId.mockResolvedValue({ valid: true, errors: [] });
        setQueryResponses({ recordset: [] });  // location check fails
        const app = makeApp('TenantAdmin');
        const res = await request(app)
            .patch(`/api/groups/${GROUP_ID}/locations/${LOC_ID}/group-id`)
            .send({ value: 'ACME-01' });
        expect(res.status).toBe(404);
    });

    test('sets location group ID and IsGroupIdOverride=1', async () => {
        groupMasterIdService.validateLocationGroupId.mockResolvedValue({ valid: true, errors: [] });
        setQueryResponses(
            { recordset: [{ LocationId: LOC_ID }] },  // location exists
            { rowsAffected: [1] },  // UPDATE
        );
        const app = makeApp('TenantAdmin');
        const res = await request(app)
            .patch(`/api/groups/${GROUP_ID}/locations/${LOC_ID}/group-id`)
            .send({ value: 'ACME-EAST' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.allAboardGroupId).toBe('ACME-EAST');
        expect(res.body.data.isGroupIdOverride).toBe(true);
    });
});
