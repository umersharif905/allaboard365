'use strict';

/**
 * Limited-edit GET/PUT route tests for /api/me/agent/agents/:id
 * Mocked DB only — no live writes (prod DB policy).
 */

const request = require('supertest');
const express = require('express');

const CALLER_USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CALLER_AGENT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TARGET_AGENT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const AGENCY_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const COMMISSION_LEVEL_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const LOWER_LEVEL_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

const updates = [];

function routeQuery(sql) {
    if (/UserId = @userId/i.test(sql) && /Status = 'Active'/i.test(sql)) {
        return {
            recordset: [{ AgentId: CALLER_AGENT_ID, AgencyId: AGENCY_ID }]
        };
    }
    if (/a\.AgencyId = @currentAgencyId/i.test(sql)) {
        return {
            recordset: [{
                AgentId: TARGET_AGENT_ID,
                AgencyId: AGENCY_ID,
                CommissionLevelId: COMMISSION_LEVEL_ID,
                CommissionGroupId: null,
                CommissionTierLevel: 2,
                FirstName: 'Andrew',
                LastName: 'Johnson',
                Email: 'jwms.andy@gmail.com',
                PhoneNumber: '9122232884',
                Status: 'Active'
            }]
        };
    }
    if (/EditorSortOrder/i.test(sql)) {
        return {
            recordset: [{ AgentId: CALLER_AGENT_ID, EditorSortOrder: 5 }]
        };
    }
    if (/TargetSortOrder/i.test(sql)) {
        return {
            recordset: [{
                AgencyId: AGENCY_ID,
                CommissionLevelId: COMMISSION_LEVEL_ID,
                TargetSortOrder: 2
            }]
        };
    }
    if (/FROM oe\.CommissionLevels/i.test(sql)) {
        const sortOrder = routeQuery._requestedLevelSortOrder ?? 2;
        return {
            recordset: [{ SortOrder: sortOrder, TenantId: 'tenant-id' }]
        };
    }
    if (/UPDATE oe\.Agents/i.test(sql) || /UPDATE u SET/i.test(sql)) {
        updates.push(sql);
        return { recordset: [], rowsAffected: [1] };
    }
    return { recordset: [] };
}

function mockMakeRequest() {
    const self = {
        input() {
            return self;
        },
        async query(sql) {
            return routeQuery(sql);
        }
    };
    return self;
}

const mockPool = {
    request: jest.fn(() => mockMakeRequest())
};

const mockTx = {
    begin: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined)
};

jest.mock('../../../../config/database', () => ({
    getPool: jest.fn(async () => mockPool),
    sql: new Proxy({}, { get: () => 'MOCK_SQL_TYPE' })
}));

jest.mock('mssql', () => ({
    ISOLATION_LEVEL: { READ_COMMITTED: 'READ_COMMITTED' },
    Transaction: jest.fn(() => mockTx),
    Request: jest.fn(() => mockMakeRequest()),
    UniqueIdentifier: 'UniqueIdentifier',
    NVarChar: jest.fn((n) => `NVarChar(${n})`)
}));

jest.mock('../../../../middleware/auth', () => ({
    authorize: () => (_req, _res, next) => next(),
    getUserRoles: (user) => user?.roles || ['Agent']
}));

jest.mock('../../../../utils/agentHierarchy', () => ({
    isUplineAncestor: jest.fn(),
    isAgencyAdmin: jest.fn()
}));

jest.mock('../../../../utils/agencyAdmins', () => ({}));
jest.mock('../../../../utils/memberStatsSql', () => ({
    buildMonthlyRosterPremiumSubquery: jest.fn(() => '0')
}));
jest.mock('../../../../services/agencyMrr.service', () => ({
    getMonthlyRecurringRevenueByAgencyMap: jest.fn(),
    normalizeAgencyKey: jest.fn()
}));
jest.mock('../../../../services/shared/agent-hierarchy.service', () => ({
    buildAgenciesWithAgents: jest.fn(),
    buildDownlineAgencies: jest.fn()
}));
jest.mock('../../../../services/agentHierarchyBatch.service', () => ({
    batchTotalAgentCountsByAgency: jest.fn()
}));

const { isUplineAncestor, isAgencyAdmin } = require('../../../../utils/agentHierarchy');

function buildApp() {
    const routes = require('../agents');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.user = {
            UserId: CALLER_USER_ID,
            currentRole: 'Agent',
            roles: ['Agent']
        };
        next();
    });
    app.use('/api/me/agent/agents', routes);
    return app;
}

beforeEach(() => {
    isUplineAncestor.mockReset();
    isAgencyAdmin.mockReset();
    updates.length = 0;
    routeQuery._requestedLevelSortOrder = 2;
    mockPool.request.mockImplementation(() => mockMakeRequest());
    mockTx.commit.mockClear();
    mockTx.rollback.mockClear();
    const mssql = require('mssql');
    mssql.Request.mockImplementation(() => mockMakeRequest());
    mssql.Transaction.mockImplementation(() => mockTx);
});

describe('GET /api/me/agent/agents/:id limited-edit detail', () => {
    test('returns CommissionLevelId and editableFields for same-agency agent', async () => {
        isUplineAncestor.mockResolvedValue(true);
        isAgencyAdmin.mockResolvedValue(false);

        const app = buildApp();
        const res = await request(app).get(`/api/me/agent/agents/${TARGET_AGENT_ID}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.CommissionLevelId).toBe(COMMISSION_LEVEL_ID);
        expect(res.body.data.editableFields).toEqual({
            profile: false,
            status: false,
            commissionTier: true
        });
        expect(res.body.data.editableScopes).toEqual(['upline']);
    });
});

describe('PUT /api/me/agent/agents/:agentId limited-edit', () => {
    test('returns clear 400 when upline-only caller submits profile-only changes', async () => {
        isUplineAncestor.mockResolvedValue(true);
        isAgencyAdmin.mockResolvedValue(false);

        const app = buildApp();
        const res = await request(app)
            .put(`/api/me/agent/agents/${TARGET_AGENT_ID}`)
            .send({ email: 'new@example.com' });

        expect(res.status).toBe(400);
        expect(res.body.message).toBe('Your role can only change commission tier for this agent.');
    });

    test('allows agency admin who is also upline to update email', async () => {
        isUplineAncestor.mockResolvedValue(true);
        isAgencyAdmin.mockResolvedValue(true);

        const app = buildApp();
        const res = await request(app)
            .put(`/api/me/agent/agents/${TARGET_AGENT_ID}`)
            .send({ email: 'new@example.com' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(updates.some((sql) => /Email = @email/i.test(sql))).toBe(true);
    });

    test('rejects tier at or above editor SortOrder', async () => {
        isUplineAncestor.mockResolvedValue(true);
        isAgencyAdmin.mockResolvedValue(false);
        routeQuery._requestedLevelSortOrder = 5;

        const app = buildApp();
        const res = await request(app)
            .put(`/api/me/agent/agents/${TARGET_AGENT_ID}`)
            .send({ commissionLevelId: LOWER_LEVEL_ID });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/at or above your own/i);
    });

    test('allows tier change strictly below editor SortOrder', async () => {
        isUplineAncestor.mockResolvedValue(true);
        isAgencyAdmin.mockResolvedValue(false);
        routeQuery._requestedLevelSortOrder = 2;

        const app = buildApp();
        const res = await request(app)
            .put(`/api/me/agent/agents/${TARGET_AGENT_ID}`)
            .send({ commissionLevelId: LOWER_LEVEL_ID });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.message).toBe('Agent updated.');
        expect(mockTx.commit).toHaveBeenCalledTimes(1);
    });
});
