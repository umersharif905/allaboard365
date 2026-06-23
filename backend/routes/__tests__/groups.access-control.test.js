'use strict';

/**
 * Route-level access control for group detail + resolve endpoints.
 */

jest.mock('../../middleware/auth', () => ({
    authorize: (roles) => (req, _res, next) => {
        req.allowedRoles = roles;
        next();
    },
    requireTenantAccess: (req, _res, next) => {
        req.tenantId = req.headers['x-test-tenant-id'] || req.user?.TenantId;
        next();
    },
    getUserRoles: jest.fn((user) => user.roles || [user.currentRole]),
    optionalAuth: (_req, _res, next) => next(),
}));

jest.mock('../../utils/agentGroupAccess', () => ({
    getAccessibleAgentIdsForUser: jest.fn().mockResolvedValue([]),
    buildAgentScopeClause: jest.fn(() => '1=0'),
}));

jest.mock('../../services/groupAccessService', () => ({
    verifyGroupAccess: jest.fn(),
    resolveGroupIdentifierForUser: jest.fn(),
}));

jest.mock('../../services/PaymentMethodService', () => ({}));
jest.mock('../../services/dimeService', () => ({}));
jest.mock('../../services/householdMemberIdService', () => ({}));
jest.mock('../../utils/householdMemberIdPrefix', () => ({}));
jest.mock('../../services/aiCensusParser.service', () => ({}));
jest.mock('../../services/shared', () => ({ EnrollmentLinkService: {} }));
jest.mock('../../constants/linkExpiration', () => ({ DEFAULT_LINK_EXPIRATION_HOURS: 48 }));
jest.mock('../../services/groupMasterIdService', () => ({
    isValidGroupIdSlug: jest.fn(),
    validateMasterGroupId: jest.fn(),
    validateLocationGroupId: jest.fn(),
    recomputeLocationGroupIds: jest.fn(),
    suggestMasterGroupId: jest.fn(),
}));
jest.mock('../../routes/_groups-validation', () => ({ isValidEarliestEffectiveDate: jest.fn(() => true) }));
jest.mock('../../routes/uploads', () => ({ authenticateUrls: jest.fn(() => (_req, _res, next) => next()) }));

jest.mock('../../config/database', () => ({
    getPool: jest.fn(async () => ({
        request: jest.fn(() => ({
            input: jest.fn().mockReturnThis(),
            query: jest.fn().mockResolvedValue({ recordset: [{ Name: 'Test Group' }] }),
        })),
    })),
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

const request = require('supertest');
const express = require('express');
const groupAccessService = require('../../services/groupAccessService');

const GROUP_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = {
            UserId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
            TenantId: TENANT_ID,
            currentRole: req.headers['x-test-role'] || 'TenantAdmin',
            roles: [req.headers['x-test-role'] || 'TenantAdmin'],
        };
        next();
    });
    app.use('/api/groups', require('../groups'));
    return app;
}

describe('GET /api/groups/:id access control', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('returns 404 when verifyGroupAccess denies', async () => {
        groupAccessService.verifyGroupAccess.mockResolvedValue({ hasAccess: false, group: null });
        const app = buildApp();
        const res = await request(app)
            .get(`/api/groups/${GROUP_ID}`)
            .set('x-test-role', 'Agent');
        expect(res.status).toBe(404);
        expect(res.body.message).toMatch(/not found or access denied/i);
        expect(groupAccessService.verifyGroupAccess).toHaveBeenCalledWith(
            expect.anything(),
            GROUP_ID,
            expect.objectContaining({ currentRole: 'Agent' }),
            expect.objectContaining({ tenantId: TENANT_ID })
        );
    });

    test('returns group data when verifyGroupAccess allows', async () => {
        groupAccessService.verifyGroupAccess.mockResolvedValue({
            hasAccess: true,
            group: { GroupId: GROUP_ID, TenantId: TENANT_ID },
        });
        const app = buildApp();
        const res = await request(app)
            .get(`/api/groups/${GROUP_ID}`)
            .set('x-test-role', 'TenantAdmin');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.Name).toBe('Test Group');
    });
});

describe('GET /api/groups/resolve/:identifier access control', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('returns 404 when resolve returns null (wrong tenant or agent scope)', async () => {
        groupAccessService.resolveGroupIdentifierForUser.mockResolvedValue(null);
        const app = buildApp();
        const res = await request(app)
            .get('/api/groups/resolve/482913')
            .set('x-test-role', 'Agent');
        expect(res.status).toBe(404);
        expect(groupAccessService.resolveGroupIdentifierForUser).toHaveBeenCalledWith(
            expect.anything(),
            '482913',
            expect.objectContaining({ currentRole: 'Agent' }),
            expect.objectContaining({ tenantId: TENANT_ID })
        );
    });

    test('returns groupId when resolve succeeds', async () => {
        groupAccessService.resolveGroupIdentifierForUser.mockResolvedValue({
            GroupId: GROUP_ID,
            AllAboardMasterGroupId: '482913',
            Name: 'Acme',
        });
        const app = buildApp();
        const res = await request(app)
            .get('/api/groups/resolve/482913')
            .set('x-test-role', 'TenantAdmin');
        expect(res.status).toBe(200);
        expect(res.body.data.groupId).toBe(GROUP_ID);
        expect(res.body.data.AllAboardMasterGroupId).toBe('482913');
    });
});
