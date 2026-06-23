import { describe, expect, it } from 'vitest';
import { normalizeWizardPricingTiers } from '../normalizeWizardPricingTiers';

describe('normalizeWizardPricingTiers', () => {
  it('returns empty for missing input', () => {
    expect(normalizeWizardPricingTiers(null)).toEqual([]);
    expect(normalizeWizardPricingTiers([])).toEqual([]);
  });

  it('passes through grouped tiers with ageBands', () => {
    const raw = [
      {
        id: 'tier-1',
        tierType: 'EE',
        label: 'Standard',
        ageBands: [{ ProductPricingId: 'p1', MSRPRate: 100 }],
      },
    ];
    const out = normalizeWizardPricingTiers(raw);
    expect(out).toHaveLength(1);
    expect(out[0].tierType).toBe('EE');
    expect(out[0].ageBands).toHaveLength(1);
  });

  it('groups flat pricing rows by tier type and label', () => {
    const raw = [
      { TierType: 'EE', Label: '', ProductPricingId: 'a', MSRPRate: 210 },
      { TierType: 'EE', Label: '', ProductPricingId: 'b', MSRPRate: 125, ConfigValue1: '5000' },
      { TierType: 'ES', Label: '', ProductPricingId: 'c', MSRPRate: 300 },
    ];
    const out = normalizeWizardPricingTiers(raw);
    expect(out).toHaveLength(2);
    const ee = out.find((t) => t.tierType === 'EE');
    expect(ee?.ageBands).toHaveLength(2);
  });
});
