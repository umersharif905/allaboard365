'use strict';

jest.mock('../migrationAgentMap.service', () => ({
  getAgentMap: jest.fn(),
  upsertAgentMap: jest.fn()
}));

jest.mock('../sharewellAgents.service', () => ({
  lookupAgentByBrokerId: jest.fn()
}));

jest.mock('../e123Config', () => ({
  runWithInstanceE123Config: jest.fn(async (_instanceId, fn) => fn())
}));

jest.mock('../e123Agent.service', () => ({
  getAgentProfileById: jest.fn()
}));

jest.mock('../../../config/database', () => ({
  sql: { UniqueIdentifier: 'UniqueIdentifier' },
  getPool: jest.fn()
}));

const agentMapService = require('../migrationAgentMap.service');
const { getPool } = require('../../../config/database');
const { getAgentProfileById } = require('../e123Agent.service');
const { resolveBrokerToAgent } = require('../migrationAgentResolver.service');

describe('migrationAgentResolver skipE123Api', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('uses saved agent map without calling E123 when skipE123Api is true', async () => {
    const agentId = '11111111-1111-1111-1111-111111111111';
    const tenantId = '22222222-2222-2222-2222-222222222222';
    agentMapService.getAgentMap.mockResolvedValue({
      AgentId: agentId,
      MatchMethod: 'manual',
      E123AgentLabel: 'Darin Hunter'
    });
    getPool.mockResolvedValue({
      request: () => ({
        input: jest.fn().mockReturnThis(),
        query: jest.fn().mockResolvedValue({ recordset: [{ AgentId: agentId }] })
      })
    });

    const result = await resolveBrokerToAgent({
      tenantId,
      instanceId: '33333333-3333-3333-3333-333333333333',
      e123BrokerId: 12345,
      skipE123Api: true
    });

    expect(result.agentId).toBe(agentId);
    expect(result.method).toBe('manual');
    expect(getAgentProfileById).not.toHaveBeenCalled();
  });

  test('rejects saved map when agent is in another tenant', async () => {
    const agentId = '11111111-1111-1111-1111-111111111111';
    const tenantId = '22222222-2222-2222-2222-222222222222';
    agentMapService.getAgentMap.mockResolvedValue({
      AgentId: agentId,
      MatchMethod: 'manual',
      E123AgentLabel: 'Darin Hunter'
    });
    getPool.mockResolvedValue({
      request: () => ({
        input: jest.fn().mockReturnThis(),
        query: jest.fn().mockResolvedValue({ recordset: [] })
      })
    });

    const result = await resolveBrokerToAgent({
      tenantId,
      instanceId: '33333333-3333-3333-3333-333333333333',
      e123BrokerId: 12345,
      skipE123Api: true
    });

    expect(result.agentId).toBeNull();
    expect(result.crossTenant).toBe(true);
    expect(result.crossTenantAgentId).toBe(agentId);
  });
});
