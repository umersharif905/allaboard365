'use strict';

const {
  computeExcludedAgentIds,
  computeDownlineCounts,
  filterAgentTreeNodes,
  isExcludedBranchLabel,
  shouldExcludeOrgRootChild
} = require('../e123AgentTree/agentTreeFilters');

describe('agentTreeFilters', () => {
  test('isExcludedBranchLabel matches portals and vendors only', () => {
    expect(isExcludedBranchLabel('PORTALS')).toBe(true);
    expect(isExcludedBranchLabel('Vendors')).toBe(true);
    expect(isExcludedBranchLabel('Member Portal')).toBe(false);
    expect(isExcludedBranchLabel('ShareWELL Partners')).toBe(false);
  });

  test('computeExcludedAgentIds removes branch and descendants', () => {
    const nodes = [
      { agentId: 775982, parentAgentId: null, label: 'Sharewell Partners' },
      { agentId: 778694, parentAgentId: 775982, label: 'PORTALS' },
      { agentId: 778699, parentAgentId: 778694, label: 'Member Portal' },
      { agentId: 783390, parentAgentId: 775982, label: 'ShareWELL Partners' },
      { agentId: 785508, parentAgentId: 783390, label: 'Steve Schone' }
    ];
    const excluded = computeExcludedAgentIds(nodes, { orgBrokerId: 775982 });
    expect(excluded.has(778694)).toBe(true);
    expect(excluded.has(778699)).toBe(true);
    expect(excluded.has(783390)).toBe(false);
  });

  test('computeExcludedAgentIds removes org-root junk siblings without downline', () => {
    const nodes = [
      { agentId: 775982, parentAgentId: null, label: 'Sharewell Partners' },
      { agentId: 783390, parentAgentId: 775982, label: 'ShareWELL Partners' },
      { agentId: 785508, parentAgentId: 783390, label: 'Steve Schone' },
      { agentId: 867604, parentAgentId: 775982, label: 'test bundle' },
      { agentId: 887431, parentAgentId: 775982, label: 'eBenefits Copy Over' },
      { agentId: 883564, parentAgentId: 775982, label: 'Lyric' }
    ];
    const excluded = computeExcludedAgentIds(nodes, { orgBrokerId: 775982 });
    expect(excluded.has(783390)).toBe(false);
    expect(excluded.has(785508)).toBe(false);
    expect(excluded.has(867604)).toBe(true);
    expect(excluded.has(887431)).toBe(true);
    expect(excluded.has(883564)).toBe(true);
  });

  test('shouldExcludeOrgRootChild keeps agencies with downline', () => {
    const nodes = [
      { agentId: 775982, parentAgentId: null, label: 'Sharewell Partners' },
      { agentId: 783390, parentAgentId: 775982, label: 'ShareWELL Partners', isGroup: true },
      { agentId: 785508, parentAgentId: 783390, label: 'Steve Schone', isGroup: false }
    ];
    const excluded = new Set();
    expect(shouldExcludeOrgRootChild(nodes[1], nodes, excluded, 775982)).toBe(false);
  });

  test('computeDownlineCounts returns direct and total descendant counts', () => {
    const { directCounts, totalCounts } = computeDownlineCounts([
      { agentId: 775982, parentAgentId: null, label: 'Org' },
      { agentId: 783390, parentAgentId: 775982, label: 'Agency' },
      { agentId: 785508, parentAgentId: 783390, label: 'Agent A' },
      { agentId: 785509, parentAgentId: 783390, label: 'Agent B' },
      { agentId: 785510, parentAgentId: 785508, label: 'Sub-agent' }
    ]);
    expect(directCounts.get(783390)).toBe(2);
    expect(totalCounts.get(783390)).toBe(3);
    expect(totalCounts.get(785508)).toBe(1);
    expect(totalCounts.get(785510)).toBe(0);
    expect(totalCounts.get(775982)).toBe(4);
  });

  test('filterAgentTreeNodes recalculates child counts', () => {
    const filtered = filterAgentTreeNodes([
      { agentId: 775982, parentAgentId: null, label: 'Sharewell Partners', depth: 0, sortOrder: 0 },
      { agentId: 778694, parentAgentId: 775982, label: 'PORTALS', depth: 1, sortOrder: 1 },
      { agentId: 783390, parentAgentId: 775982, label: 'ShareWELL Partners', depth: 1, sortOrder: 2 },
      { agentId: 785508, parentAgentId: 783390, label: 'Steve Schone', depth: 2, sortOrder: 3 }
    ], { orgBrokerId: 775982 });
    expect(filtered).toHaveLength(3);
    expect(filtered.find((n) => n.agentId === 775982)?.childCount).toBe(1);
    expect(filtered.find((n) => n.agentId === 783390)?.childCount).toBe(1);
  });
});
