import { describe, expect, it } from 'vitest';
import {
  applyAutoMapForPlanGroups,
  pickDefaultAutoMapTier,
  type PlanCodeGroup,
  type PricingTierOption,
} from '../vendorImportProductMapping';

const tier = (
  partial: Partial<PricingTierOption> & Pick<PricingTierOption, 'productPricingId' | 'importKey'>,
): PricingTierOption => ({
  productId: 'prod-1',
  productName: 'Essential (ShareWELL)',
  tierType: 'EE',
  displayLabel: partial.displayLabel || partial.importKey || 'tier',
  netRate: 100,
  msrpRate: 100,
  minAge: 18,
  maxAge: 64,
  tobaccoStatus: null,
  ...partial,
});

describe('pickDefaultAutoMapTier', () => {
  it('prefers Tobacco No over Yes when import keys match', () => {
    const picked = pickDefaultAutoMapTier([
      tier({ productPricingId: 'yes-id', importKey: 'ES_2500', tobaccoStatus: 'Yes' }),
      tier({ productPricingId: 'no-id', importKey: 'ES_2500', tobaccoStatus: 'No' }),
    ]);
    expect(picked?.productPricingId).toBe('no-id');
  });

  it('prefers N/A over Yes', () => {
    const picked = pickDefaultAutoMapTier([
      tier({ productPricingId: 'yes-id', importKey: 'EF_2500', tobaccoStatus: 'Yes' }),
      tier({ productPricingId: 'na-id', importKey: 'EF_2500', tobaccoStatus: 'N/A' }),
    ]);
    expect(picked?.productPricingId).toBe('na-id');
  });
});

describe('applyAutoMapForPlanGroups', () => {
  const tiers: PricingTierOption[] = [
    tier({ productPricingId: 'no-es', importKey: 'ES_2500', tobaccoStatus: 'No' }),
    tier({ productPricingId: 'yes-es', importKey: 'ES_2500', tobaccoStatus: 'Yes' }),
  ];

  const group: PlanCodeGroup = {
    lookupKey: 'ES_2500',
    filePlanCodes: ['11321_AH3000ES'],
  };

  it('overrides stale saved alias keys with non-tobacco auto-map', () => {
    const result = applyAutoMapForPlanGroups(
      [group],
      tiers,
      'prod-1',
      null,
      { '11321_AH3000ES': 'yes-es' },
    );
    expect(result.ES_2500).toBe('no-es');
    expect(result['11321_AH3000ES']).toBe('no-es');
  });
});
