'use strict';

jest.mock('../../utils/agentGroupAccess', () => ({
    getAccessibleAgentIdsForUser: jest.fn(),
    buildAgentScopeClause: jest.fn(),
}));

jest.mock('../../middleware/auth', () => ({
    getUserRoles: jest.fn((user) => user.roles || []),
}));

const agentGroupAccess = require('../../utils/agentGroupAccess');
const { verifyGroupAccess, resolveGroupIdentifierForUser } = require('../groupAccessService');

const GROUP_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_GROUP_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TENANT_A = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const TENANT_B = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const AGENT_SELF = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const AGENT_DOWNLINE = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const AGENT_OTHER = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const MASTER_ID = '482913';

let mockQueryResponses = [];
let mockQueryCallIndex = 0;
const mockInput = jest.fn().mockReturnThis();
const mockQuery = jest.fn().mockImplementation(() => {
    const response = mockQueryResponses[mockQueryCallIndex++] || { recordset: [] };
    return Promise.resolve(response);
});
const mockRequest = jest.fn(() => ({ input: mockInput, query: mockQuery }));
const mockPool = { request: mockRequest };

function setResponses(...responses) {
    mockQueryCallIndex = 0;
    mockQueryResponses = responses;
    mockInput.mockClear();
    mockQuery.mockClear();
    mockRequest.mockClear();
}

function user(role, extra = {}) {
    return {
        UserId: USER_ID,
        TenantId: TENANT_A,
        currentRole: role,
        roles: [role],
        ...extra,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    agentGroupAccess.getAccessibleAgentIdsForUser.mockResolvedValue([]);
    agentGroupAccess.buildAgentScopeClause.mockImplementation((_req, ids, col) => {
        if (!ids?.length) return '1 = 0';
        return `${col} IN ('${ids.join("','")}')`;
    });
});

describe('verifyGroupAccess', () => {
    test('SysAdmin can access any group', async () => {
        setResponses({
            recordset: [{ GroupId: GROUP_ID, TenantId: TENANT_B, AgentId: AGENT_OTHER }],
        });
        const result = await verifyGroupAccess(mockPool, GROUP_ID, user('SysAdmin'));
        expect(result.hasAccess).toBe(true);
        expect(result.group.GroupId).toBe(GROUP_ID);
    });

    test('TenantAdmin denied for group in another tenant', async () => {
        setResponses({ recordset: [] });
        const result = await verifyGroupAccess(
            mockPool,
            GROUP_ID,
            user('TenantAdmin'),
            { tenantId: TENANT_A }
        );
        expect(result.hasAccess).toBe(false);
        expect(mockInput).toHaveBeenCalledWith('activeTenantId', expect.anything(), TENANT_A);
    });

    test('TenantAdmin granted for group in active tenant', async () => {
        setResponses({
            recordset: [{ GroupId: GROUP_ID, TenantId: TENANT_A, AgentId: AGENT_SELF }],
        });
        const result = await verifyGroupAccess(
            mockPool,
            GROUP_ID,
            user('TenantAdmin'),
            { tenantId: TENANT_A }
        );
        expect(result.hasAccess).toBe(true);
    });

    test('GroupAdmin granted only for assigned group', async () => {
        setResponses({
            recordset: [{ GroupId: GROUP_ID, TenantId: TENANT_A, AgentId: AGENT_SELF }],
        });
        const result = await verifyGroupAccess(
            mockPool,
            GROUP_ID,
            user('GroupAdmin', { GroupId: GROUP_ID }),
            { tenantId: TENANT_A }
        );
        expect(result.hasAccess).toBe(true);
    });

    test('GroupAdmin denied for a different group', async () => {
        setResponses({ recordset: [] });
        const result = await verifyGroupAccess(
            mockPool,
            OTHER_GROUP_ID,
            user('GroupAdmin', { GroupId: GROUP_ID }),
            { tenantId: TENANT_A }
        );
        expect(result.hasAccess).toBe(false);
    });

    test('GroupAdmin loads assigned group from oe.GroupAdmins when JWT missing GroupId', async () => {
        setResponses(
            { recordset: [{ GroupId: GROUP_ID }] },
            { recordset: [{ GroupId: GROUP_ID, TenantId: TENANT_A, AgentId: AGENT_SELF }] }
        );
        const result = await verifyGroupAccess(
            mockPool,
            GROUP_ID,
            user('GroupAdmin'),
            { tenantId: TENANT_A }
        );
        expect(result.hasAccess).toBe(true);
        expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    test('Agent granted when group agent is in accessible scope (self/downline/agency)', async () => {
        agentGroupAccess.getAccessibleAgentIdsForUser.mockResolvedValue([AGENT_SELF, AGENT_DOWNLINE]);
        setResponses({
            recordset: [{ GroupId: GROUP_ID, TenantId: TENANT_A, AgentId: AGENT_DOWNLINE }],
        });
        const result = await verifyGroupAccess(
            mockPool,
            GROUP_ID,
            user('Agent'),
            { tenantId: TENANT_A }
        );
        expect(result.hasAccess).toBe(true);
        expect(agentGroupAccess.getAccessibleAgentIdsForUser).toHaveBeenCalled();
        expect(agentGroupAccess.buildAgentScopeClause).toHaveBeenCalled();
    });

    test('Agent denied when group agent is outside accessible scope', async () => {
        agentGroupAccess.getAccessibleAgentIdsForUser.mockResolvedValue([AGENT_SELF]);
        setResponses({ recordset: [] });
        const result = await verifyGroupAccess(
            mockPool,
            GROUP_ID,
            user('Agent'),
            { tenantId: TENANT_A }
        );
        expect(result.hasAccess).toBe(false);
    });

    test('unsupported role is denied', async () => {
        const result = await verifyGroupAccess(
            mockPool,
            GROUP_ID,
            user('Member'),
            { tenantId: TENANT_A }
        );
        expect(result.hasAccess).toBe(false);
        expect(result.reason).toBe('unsupported_role');
        expect(mockQuery).not.toHaveBeenCalled();
    });
});

describe('resolveGroupIdentifierForUser', () => {
    test('returns null when master ID not in tenant', async () => {
        setResponses({ recordset: [] });
        const result = await resolveGroupIdentifierForUser(
            mockPool,
            MASTER_ID,
            user('TenantAdmin'),
            { tenantId: TENANT_A }
        );
        expect(result).toBeNull();
    });

    test('returns null when master ID resolves but agent lacks access', async () => {
        setResponses(
            { recordset: [{ GroupId: GROUP_ID }] },
            { recordset: [] }
        );
        agentGroupAccess.getAccessibleAgentIdsForUser.mockResolvedValue([AGENT_SELF]);
        const result = await resolveGroupIdentifierForUser(
            mockPool,
            MASTER_ID,
            user('Agent'),
            { tenantId: TENANT_A }
        );
        expect(result).toBeNull();
    });

    test('returns group when master ID resolves and tenant admin has access', async () => {
        setResponses(
            { recordset: [{ GroupId: GROUP_ID }] },
            { recordset: [{ GroupId: GROUP_ID, TenantId: TENANT_A, AllAboardMasterGroupId: MASTER_ID }] }
        );
        const result = await resolveGroupIdentifierForUser(
            mockPool,
            MASTER_ID,
            user('TenantAdmin'),
            { tenantId: TENANT_A }
        );
        expect(result).not.toBeNull();
        expect(result.GroupId).toBe(GROUP_ID);
        expect(result.AllAboardMasterGroupId).toBe(MASTER_ID);
    });

    test('UUID identifier skips master lookup and enforces access', async () => {
        setResponses({
            recordset: [{ GroupId: GROUP_ID, TenantId: TENANT_A, AllAboardMasterGroupId: MASTER_ID }],
        });
        const result = await resolveGroupIdentifierForUser(
            mockPool,
            GROUP_ID,
            user('TenantAdmin'),
            { tenantId: TENANT_A }
        );
        expect(result).not.toBeNull();
        expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    test('SysAdmin can resolve master ID across tenants', async () => {
        setResponses(
            { recordset: [{ GroupId: GROUP_ID }] },
            { recordset: [{ GroupId: GROUP_ID, TenantId: TENANT_B, AllAboardMasterGroupId: MASTER_ID }] }
        );
        const result = await resolveGroupIdentifierForUser(
            mockPool,
            MASTER_ID,
            user('SysAdmin'),
            { tenantId: TENANT_A }
        );
        expect(result).not.toBeNull();
        expect(result.TenantId).toBe(TENANT_B);
    });
});
