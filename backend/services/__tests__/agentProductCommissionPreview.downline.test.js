/**
 * Unit tests for getDownlineAgentProductCommissionPreview row capping.
 * Mocked DB only — no live writes.
 */

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const PRODUCT_ID = '22222222-2222-2222-2222-222222222222';
const VIEWER_AGENT_ID = '33333333-3333-3333-3333-333333333333';
const SUBJECT_AGENT_ID = '44444444-4444-4444-4444-444444444444';
const GROUP_ID = '55555555-5555-5555-5555-555555555555';

jest.mock('../../config/database', () => ({
  getPool: jest.fn(),
  sql: new Proxy({}, { get: () => 'MOCK_SQL_TYPE' })
}));

jest.mock('../CommissionCalculatorService', () => ({
  resolveCommissionGroupId: jest.fn(),
  getCommissionGroupRules: jest.fn()
}));

const { getPool } = require('../../config/database');
const commissionCalculatorService = require('../CommissionCalculatorService');
const { getDownlineAgentProductCommissionPreview } = require('../agentProductCommissionPreview.service');

describe('getDownlineAgentProductCommissionPreview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('caps rows between viewer and subject sort orders and highlights subject tier', async () => {
    const COMMISSION_LEVELS = [
      { CommissionLevelId: 'l0', DisplayName: 'FMO', SortOrder: 0 },
      { CommissionLevelId: 'l1', DisplayName: 'GA', SortOrder: 1 },
      { CommissionLevelId: 'l2', DisplayName: 'Agent', SortOrder: 2 },
      { CommissionLevelId: 'l3', DisplayName: 'Associate', SortOrder: 3 }
    ];

    getPool.mockImplementation(async () => ({
      request() {
        const params = {};
        const self = {
          input(name, _type, value) {
            params[name] = value;
            return self;
          },
          async query(sql) {
            if (/FROM oe\.CommissionLevels/i.test(sql)) {
              return { recordset: COMMISSION_LEVELS };
            }
            if (/FROM oe\.Agents a/i.test(sql) && params.AgentId === VIEWER_AGENT_ID) {
              return { recordset: [{ SortOrder: 1 }] };
            }
            if (/FROM oe\.Agents a/i.test(sql) && params.AgentId === SUBJECT_AGENT_ID) {
              return {
                recordset: [{
                  SortOrder: 0,
                  LevelDisplayName: null,
                  CommissionGroupId: GROUP_ID,
                  FullName: 'Jane Smith',
                  Email: 'jane@example.com'
                }]
              };
            }
            return { recordset: [] };
          }
        };
        return self;
      }
    }));

    commissionCalculatorService.resolveCommissionGroupId.mockResolvedValue(GROUP_ID);
    commissionCalculatorService.getCommissionGroupRules.mockResolvedValue([
      {
        EntityType: 'Tier',
        RulePrecedence: 1,
        Priority: 1,
        EffectiveDate: '2024-01-01',
        RuleName: 'Tier rule',
        ProductId: PRODUCT_ID,
        CommissionJson: JSON.stringify({
          type: 'flatrate',
          tiers: [
            { level: -1, name: 'Advisor', productTiers: { EE: { flatAmount: 20 } } },
            { level: 0, name: 'Junior Partner', productTiers: { EE: { flatAmount: 25 } } },
            { level: 1, name: 'Senior Partner', productTiers: { EE: { flatAmount: 108 } } }
          ]
        })
      }
    ]);

    const result = await getDownlineAgentProductCommissionPreview({
      viewerAgentId: VIEWER_AGENT_ID,
      subjectAgentId: SUBJECT_AGENT_ID,
      tenantId: TENANT_ID,
      productId: PRODUCT_ID
    });

    expect(result.viewerRole).toBe('downlineAgent');
    expect(result.subjectAgentName).toBe('Jane Smith');
    expect(result.rows.map((r) => r.levelSortOrder)).toEqual([0, 1]);
    const highlighted = result.rows.find((r) => r.isAgentLevel);
    expect(highlighted?.levelSortOrder).toBe(0);
    expect(highlighted?.label).toBe('Junior Partner');
    expect(highlighted?.familyFlat?.EE).toBe(25);
    expect(result.rows.some((r) => r.levelSortOrder === 0)).toBe(true);
  });
});
