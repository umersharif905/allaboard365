'use strict';

const { buildPricingPromptSection } = require('../productAiPatch');

describe('productAi pricing phase prompt', () => {
  it('includes phase-in guidance and active targets in prompt section', () => {
    const section = buildPricingPromptSection({
      pricingPhase: {
        snapshotSource: 'live_wizard_form',
        activePricingTargets: [
          {
            tierId: 'new-tier',
            tierType: 'EE',
            label: 'EE',
            openBandIds: ['band-new'],
            effectiveDates: ['2026-05-29'],
            bandCount: 1,
          },
        ],
        phasedOutBands: [
          {
            tierId: 'old-tier',
            tierType: 'EE',
            label: 'EE',
            bandId: 'band-old',
            effectiveDate: '2024-01-01',
            terminationDate: '2026-05-28',
            minAge: 18,
            maxAge: 65,
            tobaccoStatus: 'N/A',
          },
        ],
        duplicateTierTypes: [
          {
            tierType: 'EE',
            tierIds: ['old-tier', 'new-tier'],
            recommendedActiveTierId: 'new-tier',
          },
        ],
        guidance: 'test',
      },
      pricingTiersSummary: [],
      includeProcessingFee: true,
      roundUpProcessingFee: true,
      processingFeePercentage: 3,
      manualIncludedProcessingFee: false,
    });

    expect(section).toContain('PHASE IN / PHASE OUT');
    expect(section).toContain('live_wizard_form');
    expect(section).toContain('recommendedActiveTierId');
    expect(section).toContain('phasedOutBands');
    expect(section).toContain('DO NOT patch unless');
  });
});
