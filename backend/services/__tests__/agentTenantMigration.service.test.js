const mockTransactionBegin = jest.fn().mockResolvedValue(undefined);
const mockTransactionCommit = jest.fn().mockResolvedValue(undefined);
const mockTransactionRollback = jest.fn().mockResolvedValue(undefined);

jest.mock('mssql', () => {
  function MockTransaction() {
    this.begin = mockTransactionBegin;
    this.commit = mockTransactionCommit;
    this.rollback = mockTransactionRollback;
  }
  function MockRequest() {
    return {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockResolvedValue({ rowsAffected: [1], recordset: [] })
    };
  }
  const MAX = 2147483647;
  return {
    Transaction: MockTransaction,
    Request: MockRequest,
    UniqueIdentifier: jest.fn(),
    NVarChar: jest.fn(() => MAX),
    Int: jest.fn(),
    Decimal: jest.fn(),
    MAX
  };
});

jest.mock('../../config/database', () => ({
  getPool: jest.fn()
}));

jest.mock('../commissionLevel.service', () => ({
  listTenantLevels: jest.fn(),
  getCommissionLevelById: jest.fn(),
  getLegacyLabel: jest.fn((n) => `Legacy-${n}`)
}));

const mssql = require('mssql');
const { getPool } = require('../../config/database');
const CommissionLevelService = require('../commissionLevel.service');
const migrationService = require('../agentTenantMigration.service');
const {
  buildAgentTenantMigrationPreview,
  executeAgentTenantMigration,
  getSubtreeAgentIds,
  suggestTargetCommissionLevel
} = migrationService;

function mockRequest(recordsets = []) {
  let call = 0;
  const sqlCalls = [];
  const req = {
    input: jest.fn().mockReturnThis(),
    query: jest.fn().mockImplementation(async (sql) => {
      if (sql) sqlCalls.push(String(sql));
      const next = recordsets[call++] || { recordset: [] };
      return next;
    })
  };
  req._sqlCalls = sqlCalls;
  return req;
}

const agentId = '11111111-1111-1111-1111-111111111111';
const sourceTenantId = '22222222-2222-2222-2222-222222222222';
const targetTenantId = '33333333-3333-3333-3333-333333333333';
const targetAgencyId = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA';
const targetLevelId = 'BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB';

function baseAgentRecordset() {
  return [{
    AgentId: agentId,
    UserId: '44444444-4444-4444-4444-444444444444',
    TenantId: sourceTenantId,
    AgencyId: null,
    AgentCode: 'A1',
    CommissionRuleId: null,
    CommissionGroupId: null,
    CommissionLevelId: targetLevelId,
    CommissionTierLevel: 1,
    Email: 'agent@test.com',
    FirstName: 'Test',
    LastName: 'Agent',
    TenantName: 'Source Tenant'
  }];
}

function setupPreviewMocks({
  blockingProduct = false,
  linkHasTenantId = false,
  onboardingLinks = 0
} = {}) {
  CommissionLevelService.listTenantLevels.mockResolvedValue([
    {
      CommissionLevelId: targetLevelId,
      DisplayName: 'Agency',
      Code: 'agency',
      SortOrder: 1,
      LegacyTierLevel: 1
    }
  ]);
  CommissionLevelService.getCommissionLevelById.mockResolvedValue({
    commissionLevelId: targetLevelId,
    displayName: 'Agency',
    legacyTierLevel: 1,
    sortOrder: 1
  });

  const req = mockRequest([
    linkHasTenantId ? { recordset: [{ ok: 1 }] } : { recordset: [] },
    { recordset: [{ ok: 1 }] },
    { recordset: [] },
    { recordset: baseAgentRecordset() },
    { recordset: [{ TenantId: targetTenantId, Name: 'Target Tenant', Status: 'Active' }] },
    {
      recordset: [{
        CommissionLevelId: targetLevelId,
        CommissionTierLevel: 1,
        SourceLevelDisplayName: 'Agency',
        SourceLevelCode: 'agency',
        SourceLegacyTierLevel: 1
      }]
    },
    { recordset: [{ AgentId: agentId }] },
    { recordset: [{ AgencyId: targetAgencyId, AgencyName: 'Dest Agency' }] },
    { recordset: [{ MemberId: '55555555-5555-5555-5555-555555555555' }] },
    {
      recordset: [{
        agents: 1,
        agentUsers: 1,
        members: 1,
        households: 1,
        enrollments: blockingProduct ? 1 : 0,
        groups: 0,
        hierarchyRows: 1,
        onboardingLinks,
        enrollmentLinkTemplates: 0
      }]
    },
    blockingProduct
      ? {
          recordset: [{
            ProductId: '66666666-6666-6666-6666-666666666666',
            ProductName: 'Missing Product'
          }]
        }
      : { recordset: [] }
  ]);
  getPool.mockResolvedValue({ request: () => req });
  return req;
}

describe('agentTenantMigration.service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTransactionBegin.mockResolvedValue(undefined);
    mockTransactionCommit.mockResolvedValue(undefined);
    mockTransactionRollback.mockResolvedValue(undefined);
  });

  test('getSubtreeAgentIds returns agent ids from query', async () => {
    const req = mockRequest([{ recordset: [{ AgentId: 'a1' }, { AgentId: 'a2' }] }]);
    getPool.mockResolvedValue({ request: () => req });
    const ids = await getSubtreeAgentIds(await getPool(), 'root-id');
    expect(ids).toEqual(['a1', 'a2']);
  });

  test('suggestTargetCommissionLevel matches by display name', () => {
    const id = suggestTargetCommissionLevel(
      { SourceLevelDisplayName: 'Agency' },
      [{ CommissionLevelId: 'x', DisplayName: 'Agency', Code: 'other' }]
    );
    expect(id).toBe('x');
  });

  test('preview blocks when destination lacks product subscriptions', async () => {
    setupPreviewMocks({ blockingProduct: true });

    const result = await buildAgentTenantMigrationPreview({
      agentId,
      targetTenantId,
      targetAgencyId,
      targetCommissionLevelId: targetLevelId
    });

    expect(result.ok).toBe(true);
    expect(result.canExecute).toBe(false);
    expect(result.blockingProducts).toHaveLength(1);
    expect(result.commission.suggestedTargetCommissionLevelId).toBe(targetLevelId);
  });

  test('preview succeeds with agency and commission level', async () => {
    setupPreviewMocks();

    const result = await buildAgentTenantMigrationPreview({
      agentId,
      targetTenantId,
      targetAgencyId,
      targetCommissionLevelId: targetLevelId
    });

    expect(result.ok).toBe(true);
    expect(result.canExecute).toBe(true);
    expect(result.commission.selectedTargetDisplayName).toBe('Agency');
    expect(result.placement.targetAgencyId).toBe(targetAgencyId);
  });

  test('preview rejects same tenant', async () => {
    const tenantId = '22222222-2222-2222-2222-222222222222';
    const req = mockRequest([
      { recordset: [] },
      { recordset: [{ ok: 1 }] },
      { recordset: [] },
      {
        recordset: [{
          AgentId: agentId,
          UserId: '44444444-4444-4444-4444-444444444444',
          TenantId: tenantId,
          AgencyId: null,
          AgentCode: null,
          CommissionRuleId: null,
          CommissionGroupId: null,
          CommissionLevelId: null,
          CommissionTierLevel: 0,
          Email: 'a@b.com',
          FirstName: 'A',
          LastName: 'B',
          TenantName: 'Same'
        }]
      }
    ]);
    getPool.mockResolvedValue({ request: () => req });

    const result = await buildAgentTenantMigrationPreview({
      agentId,
      targetTenantId: tenantId,
      targetAgencyId
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/already/i);
  });

  test('preview requires agency when validating placement', async () => {
    setupPreviewMocks();
    const result = await buildAgentTenantMigrationPreview({
      agentId,
      targetTenantId,
      targetCommissionLevelId: targetLevelId
    });
    expect(result.ok).toBe(true);
    expect(result.canExecute).toBe(false);
    expect(result.warnings.some((w) => /agency/i.test(w))).toBe(true);
  });

  test('preview SQL uses prod schema columns (AgencyName, member TenantId for enrollments)', async () => {
    const req = setupPreviewMocks();

    await buildAgentTenantMigrationPreview({
      agentId,
      targetTenantId,
      targetAgencyId,
      targetCommissionLevelId: targetLevelId
    });

    const allSql = req._sqlCalls.join('\n');
    expect(allSql).toMatch(/AgencyName/);
    expect(allSql).not.toMatch(/SELECT\s+AgencyId,\s*Name\s+FROM\s+oe\.Agencies/i);
    expect(allSql).not.toMatch(/e\.TenantId\s*=\s*@sourceTenantId/);
    expect(allSql).toMatch(/m\.TenantId\s*=\s*@sourceTenantId/);
  });

  test('execute path uses mssql.Transaction constructor (regression: not database SqlTypes)', () => {
    expect(typeof mssql.Transaction).toBe('function');
    expect(typeof mssql.Request).toBe('function');
    const tx = new mssql.Transaction({});
    expect(typeof tx.begin).toBe('function');
    expect(typeof tx.commit).toBe('function');
    expect(typeof tx.rollback).toBe('function');
  });

  test('preview warns when onboarding links will move', async () => {
    setupPreviewMocks({ linkHasTenantId: true, onboardingLinks: 2 });

    const result = await buildAgentTenantMigrationPreview({
      agentId,
      targetTenantId,
      targetAgencyId,
      targetCommissionLevelId: targetLevelId
    });

    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => /onboarding link/i.test(w))).toBe(true);
  });

  test('execute updates AgentOnboardingLinks TenantId, AgencyId, and source tenant scope', async () => {
    const txSqlCalls = [];
    const txReq = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async (sql) => {
        if (sql) txSqlCalls.push(String(sql));
        return { rowsAffected: [1], recordset: [] };
      })
    };
    jest.spyOn(mssql, 'Request').mockImplementation(() => txReq);

    const previewReq = mockRequest([
      { recordset: [{ ok: 1 }] },
      { recordset: [{ ok: 1 }] },
      { recordset: [] },
      { recordset: baseAgentRecordset() },
      { recordset: [{ TenantId: targetTenantId, Name: 'Target Tenant', Status: 'Active' }] },
      {
        recordset: [{
          CommissionLevelId: targetLevelId,
          CommissionTierLevel: 1,
          SourceLevelDisplayName: 'Agency',
          SourceLevelCode: 'agency',
          SourceLegacyTierLevel: 1
        }]
      },
      { recordset: [{ AgentId: agentId }] },
      { recordset: [{ AgencyId: targetAgencyId, AgencyName: 'Dest Agency' }] },
      { recordset: [] },
      {
        recordset: [{
          agents: 1,
          agentUsers: 1,
          members: 0,
          households: 0,
          enrollments: 0,
          groups: 0,
          hierarchyRows: 1,
          onboardingLinks: 1,
          enrollmentLinkTemplates: 0
        }]
      },
      { recordset: [] },
      { recordset: [{ ok: 1 }] },
      { recordset: [{ ok: 1 }] },
      { recordset: [] },
      { recordset: [{ AgentId: agentId }] },
      { recordset: [] }
    ]);
    getPool.mockResolvedValue({ request: () => previewReq });

    const result = await executeAgentTenantMigration({
      agentId,
      targetTenantId,
      targetAgencyId,
      targetCommissionLevelId: targetLevelId
    });

    expect(result.ok).toBe(true);
    expect(mockTransactionCommit).toHaveBeenCalled();
    const onboardingSql = txSqlCalls.find((s) => s.includes('AgentOnboardingLinks'));
    expect(onboardingSql).toBeDefined();
    expect(onboardingSql).toMatch(/l\.TenantId\s*=\s*@targetTenantId/);
    expect(onboardingSql).toMatch(/l\.AgencyId\s*=\s*CASE/);
    expect(onboardingSql).toMatch(/l\.TenantId\s*=\s*@sourceTenantId/);
    expect(onboardingSql).toMatch(/WHEN l\.AgentId = @rootAgentId THEN @targetAgencyId/);
  });
});
