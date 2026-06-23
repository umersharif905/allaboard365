'use strict';

const { resolveMsrpAndIncludedFromWizardBand } = require('../productMsrpBandSave');

describe('resolveMsrpAndIncludedFromWizardBand', () => {
  it('persists wizard msrp 141 / included 5.25 for EE tier (eBenefits MEC)', () => {
    const result = resolveMsrpAndIncludedFromWizardBand(
      135.75,
      true,
      { msrpRate: 141, includedProcessingFee: 5.25 }
    );
    expect(result).toEqual({ msrpRate: 141, includedFee: 5.25 });
  });

  it('returns null when include-fee is off', () => {
    expect(
      resolveMsrpAndIncludedFromWizardBand(135.75, false, { msrpRate: 141, includedProcessingFee: 5.25 })
    ).toBeNull();
  });

  it('infers included fee from msrp minus base when included not sent', () => {
    expect(resolveMsrpAndIncludedFromWizardBand(135.75, true, { msrpRate: 141 })).toEqual({
      msrpRate: 141,
      includedFee: 5.25,
    });
  });
});
