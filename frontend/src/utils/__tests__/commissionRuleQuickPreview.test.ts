import { describe, expect, it } from 'vitest';
import { buildCommissionRuleQuickPreview } from '../commissionRuleQuickPreview';

describe('buildCommissionRuleQuickPreview', () => {
  it('expands flat tier base to all family bands', () => {
    const lines = buildCommissionRuleQuickPreview({
      CommissionType: 'Tiered',
      CommissionJson: JSON.stringify({
        type: 'flatrate',
        tiers: [{ level: 2, name: 'Agent', flatAmount: 10 }],
      }),
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].tier).toBe('Agent');
    expect(lines[0].amount).toContain('EE $10.00');
    expect(lines[0].amount).toContain('EF $10.00');
  });

  it('shows percentage rate for simple percentage rules', () => {
    const lines = buildCommissionRuleQuickPreview({
      CommissionType: 'Percentage',
      CommissionRate: 0.05,
    });
    expect(lines[0]).toEqual({ tier: 'Rate', amount: '5.00%' });
  });
});
