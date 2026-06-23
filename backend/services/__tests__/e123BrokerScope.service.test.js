'use strict';

const {
  buildParentByAgentId,
  buildScopeBrokerIds,
  isGroupInBrokerScope
} = require('../migration/e123BrokerScope.service');

const TREE_ROWS = [
  { AgentId: 100, ParentAgentId: null },
  { AgentId: 200, ParentAgentId: 100 },
  { AgentId: 300, ParentAgentId: 200 },
  { AgentId: 945227, ParentAgentId: 788190, IsGroup: true }
];

describe('buildScopeBrokerIds', () => {
  test('includes only root when downline disabled', () => {
    const scope = buildScopeBrokerIds(TREE_ROWS, 200, false);
    expect(scope.has(200)).toBe(true);
    expect(scope.has(300)).toBe(false);
  });

  test('includes descendants when downline enabled', () => {
    const scope = buildScopeBrokerIds(TREE_ROWS, 200, true);
    expect(scope.has(200)).toBe(true);
    expect(scope.has(300)).toBe(true);
    expect(scope.has(100)).toBe(false);
  });
});

describe('isGroupInBrokerScope', () => {
  const parentByAgentId = buildParentByAgentId([
    ...TREE_ROWS,
    { AgentId: 788190, ParentAgentId: 200 }
  ]);

  test('matches group when parent agent is in scope', () => {
    const scope = buildScopeBrokerIds(TREE_ROWS, 200, true);
    expect(isGroupInBrokerScope(
      { e123BrokerId: 945227, parentAgentId: 788190 },
      scope,
      parentByAgentId
    )).toBe(true);
  });

  test('excludes group outside selected downline', () => {
    const scope = buildScopeBrokerIds(TREE_ROWS, 300, false);
    expect(isGroupInBrokerScope(
      { e123BrokerId: 945227, parentAgentId: 788190 },
      scope,
      parentByAgentId
    )).toBe(false);
  });
});
