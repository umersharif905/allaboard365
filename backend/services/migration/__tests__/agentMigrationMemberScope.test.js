'use strict';

const {
  defaultImportSettings,
  computeSubtreeActiveMemberCounts,
  filterScopeBrokerIdsByActiveMembers,
  filterScopeBrokerIdsWithoutEmail,
  hasUsableEmail
} = require('../agentMigrationMemberScope.service');

describe('agentMigrationMemberScope.service', () => {
  it('defaults excludeAgentsWithNoMembers to true', () => {
    expect(defaultImportSettings().excludeAgentsWithNoMembers).toBe(true);
    expect(defaultImportSettings({ excludeAgentsWithNoMembers: false }).excludeAgentsWithNoMembers).toBe(false);
  });

  it('defaults excludeAgentsWithoutEmail to true', () => {
    expect(defaultImportSettings().excludeAgentsWithoutEmail).toBe(true);
    expect(hasUsableEmail('  a@b.com  ')).toBe(true);
    expect(hasUsableEmail('')).toBe(false);
  });

  it('filters brokers without email but keeps root', () => {
    const profiles = new Map([
      [100, { email: null }],
      [200, { email: 'agent@example.com' }],
      [201, { email: '   ' }]
    ]);
    const { scopeIds, excludedCount } = filterScopeBrokerIdsWithoutEmail(
      [100, 200, 201],
      profiles,
      { keepBrokerIds: [100] }
    );
    expect(scopeIds).toEqual([100, 200]);
    expect(excludedCount).toBe(1);
  });

  it('rolls up direct member counts through the tree', () => {
    const rows = [
      { AgentId: 1, ParentAgentId: null },
      { AgentId: 2, ParentAgentId: 1 },
      { AgentId: 3, ParentAgentId: 2 }
    ];
    const direct = new Map([[2, 3], [3, 1]]);
    const subtree = computeSubtreeActiveMemberCounts([1, 2, 3], rows, direct);
    expect(subtree.get(3)).toBe(1);
    expect(subtree.get(2)).toBe(4);
    expect(subtree.get(1)).toBe(4);
  });

  it('filters brokers with zero subtree members but keeps root', () => {
    const subtree = new Map([[100, 0], [200, 2], [201, 0]]);
    const { scopeIds, excludedCount } = filterScopeBrokerIdsByActiveMembers(
      [100, 200, 201],
      subtree,
      { keepBrokerIds: [100] }
    );
    expect(scopeIds).toEqual([100, 200]);
    expect(excludedCount).toBe(1);
  });
});
