'use strict';

jest.mock('../sharewellAgents.service', () => ({
  hydrateSharewellEnv: jest.fn(),
  isSharewellConfigured: jest.fn(() => false)
}));

jest.mock('../e123Config', () => ({
  assertMemberSearchConfigured: jest.fn(() => ({
    corpid: 'corp',
    username: 'user',
    password: 'pass'
  })),
  getActiveE123Override: jest.fn(() => null),
  getE123OrgBrokerId: jest.fn(() => 775982),
  getE123OrgBrokerLabelOverride: jest.fn(() => 'ShareWELL Partners')
}));

jest.mock('../orgBrokerDiscovery.service', () => ({
  ensureOrgBrokerDiscovery: jest.fn(),
  getDiscoveredOrgBrokerId: jest.fn(() => null),
  isOrgBrokerDiscoveryPending: jest.fn(() => false),
  getOrgBrokerDiscoveryError: jest.fn(() => null)
}));

jest.mock('../e123AgentTreeSnapshot.service', () => ({
  getAgentTreeStatus: jest.fn(async () => ({ configured: false, nodeCount: 0, latestExport: null })),
  searchAgentTreeNodes: jest.fn(async () => ({ agents: [], totalCount: 0, topLevelOnly: true }))
}));

const { getMigrationAgentOptions, searchMigrationAgents } = require('../migrationAgentCatalog.service');

describe('migrationAgentCatalog', () => {
  test('getMigrationAgentOptions returns org preset immediately without agent index scan', async () => {
    const startedAt = Date.now();
    const result = await getMigrationAgentOptions({ search: '', limit: 500, topLevelOnly: true });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(result.presets).toHaveLength(1);
    expect(result.presets[0].rootBrokerId).toBe(775982);
    expect(result.agents).toEqual([]);
    expect(result.indexBuilding).toBe(false);
    expect(result.source).toBe('org_preset');
    expect(result.diagnostics?.orgBrokerConfigured).toBe(true);
    expect(result.diagnostics?.memberSearchConfigured).toBe(true);
  });

  test('searchMigrationAgents returns empty when no agent tree uploaded', async () => {
    const result = await searchMigrationAgents({ search: 'foo', limit: 10, instanceId: 'test-instance' });
    expect(result.agents).toEqual([]);
    expect(result.totalCount).toBe(0);
    expect(result.source).toBe('none');
    expect(result.indexBuilding).toBe(false);
  });
});
