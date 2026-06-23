'use strict';

const {
  defaultTierForUpline,
  collectSubtreeBrokerIds,
  topologicalSortNodes
} = require('../migration/agentMigration.service');
const { normalizeAchBankRecord } = require('../migration/e123AgentBank.service');

describe('agentMigration.service helpers', () => {
  describe('defaultTierForUpline', () => {
    it('returns 0 when upline tier is unknown', () => {
      expect(defaultTierForUpline(null)).toBe(0);
      expect(defaultTierForUpline(undefined)).toBe(0);
    });

    it('returns Agency (1) for direct reports to the AB365 agency anchor', () => {
      expect(defaultTierForUpline(null, { parentIsAgency: true })).toBe(1);
    });

    it('returns one level below upline', () => {
      expect(defaultTierForUpline(3)).toBe(2);
      expect(defaultTierForUpline(0)).toBe(-1);
    });

    it('clamps at -1', () => {
      expect(defaultTierForUpline(-1)).toBe(-1);
      expect(defaultTierForUpline(0)).toBe(-1);
    });
  });

  describe('collectSubtreeBrokerIds', () => {
    const rows = [
      { AgentId: 1, ParentAgentId: null },
      { AgentId: 2, ParentAgentId: 1 },
      { AgentId: 3, ParentAgentId: 2 },
      { AgentId: 99, ParentAgentId: 1 }
    ];

    it('includes only root when includeDownline is false', () => {
      const ids = collectSubtreeBrokerIds(rows, 1, false);
      expect([...ids]).toEqual([1]);
    });

    it('includes full downline when includeDownline is true', () => {
      const ids = collectSubtreeBrokerIds(rows, 1, true);
      expect([...ids].sort()).toEqual([1, 2, 3, 99]);
    });
  });

  describe('topologicalSortNodes', () => {
    it('orders parents before children by depth fallback', () => {
      const nodes = [
        { e123BrokerId: 3, parentE123BrokerId: 2, depth: 3 },
        { e123BrokerId: 1, parentE123BrokerId: null, depth: 1 },
        { e123BrokerId: 2, parentE123BrokerId: 1, depth: 2 }
      ];
      const ordered = topologicalSortNodes(nodes);
      expect(ordered.map((n) => n.e123BrokerId)).toEqual([1, 2, 3]);
    });
  });
});

describe('e123AgentBank.service', () => {
  it('normalizes ACH bank record', () => {
    const ach = normalizeAchBankRecord({
      PAYTYPE: 'ACH',
      ROUTINGNUMBER: '021000021',
      ACCOUNTNUMBER: '123456789',
      BANKNAME: 'Test Bank',
      ACCOUNTTYPE: 'C'
    });
    expect(ach).toMatchObject({
      routingNumber: '021000021',
      accountNumber: '123456789',
      accountType: 'Checking',
      bankName: 'Test Bank'
    });
  });

  it('returns null for non-ACH pay type', () => {
    expect(normalizeAchBankRecord({ PAYTYPE: 'CC', CARDNUMBER: '4111' })).toBeNull();
  });
});
