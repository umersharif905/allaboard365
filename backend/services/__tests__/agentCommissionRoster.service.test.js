'use strict';

const {
  parseAgentTierNumber,
  rosterTierToSortOrder,
  parseRosterRowsFromSheet,
  findGroupByName,
  applyRosterToBroker
} = require('../migration/agentCommissionRoster.service');

describe('agentCommissionRoster.service', () => {
  describe('rosterTierToSortOrder', () => {
    it('maps 2-tier group Agent Tier 1/2 to sort 0 and 1', () => {
      expect(rosterTierToSortOrder('Agent Tier 1', 2)).toBe(0);
      expect(rosterTierToSortOrder('Agent Tier 2', 2)).toBe(1);
    });

    it('maps 3-tier group with GA at sort 2', () => {
      expect(rosterTierToSortOrder('Agent Tier 3', 3)).toBe(2);
    });
  });

  describe('parseRosterRowsFromSheet', () => {
    it('parses ShareWELL roster header layout', () => {
      const rows = [
        ['Agent', 'E123 ID', 'Upline', 'Commission Group', 'Tier', 'Enrollment Context'],
        ['Mark Mattlage', 799196, 'Steve Schone', '2T-20 Bridge Solutions, LLC', 'Agent Tier 1', 'Groups']
      ];
      const entries = parseRosterRowsFromSheet(rows);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        e123BrokerId: 799196,
        groupName: '2T-20 Bridge Solutions, LLC',
        tierLabel: 'Agent Tier 1'
      });
    });
  });

  describe('findGroupByName', () => {
    const groups = [
      { commissionGroupId: 'a', name: '2T-20 Bridge Solutions, LLC' },
      { commissionGroupId: 'b', name: 'Global Benefits' }
    ];

    it('matches exact and partial group names', () => {
      expect(findGroupByName(groups, 'Global Benefits')?.commissionGroupId).toBe('b');
      expect(findGroupByName(groups, 'bridge solutions')?.commissionGroupId).toBe('a');
    });
  });

  describe('parseAgentTierNumber', () => {
    it('extracts tier number from label', () => {
      expect(parseAgentTierNumber('Agent Tier 2')).toBe(2);
      expect(parseAgentTierNumber('(unplaced)')).toBeNull();
    });
  });

  describe('applyRosterToBroker', () => {
    it('sets commission group from roster but keeps hierarchy tierLevel', () => {
      const broker = { e123BrokerId: 782721, tierLevel: 1, action: 'promote_user' };
      const rosterEntry = {
        commissionGroupId: 'gb-id',
        commissionGroupName: 'Global Benefits',
        groupName: 'Global Benefits',
        tierLabel: 'Agent Tier 1',
        tierLevel: 0
      };
      const applied = applyRosterToBroker(broker, rosterEntry);
      expect(applied.commissionGroupId).toBe('gb-id');
      expect(applied.tierLevel).toBe(1);
      expect(applied.rosterPayoutTierLevel).toBe(0);
      expect(applied.rosterTierLabel).toBe('Agent Tier 1');
    });
  });
});
