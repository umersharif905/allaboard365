import { describe, expect, it } from 'vitest';
import {
  calculatePricingComponentBase,
  memberRetailFromMsrpRate,
  resolveWizardRetailMsrpRate,
} from '../wizardPricingMsrp';

describe('wizardPricingMsrp', () => {
  it('calculatePricingComponentBase sums net + override + commission', () => {
    expect(calculatePricingComponentBase(75, 10.75, 50)).toBe(135.75);
  });

  it('resolveWizardRetailMsrpRate promotes legacy base-only MSRPRate to retail', () => {
    expect(
      resolveWizardRetailMsrpRate({
        msrpFromDb: 135.75,
        componentBase: 135.75,
        includedProcessingFee: 5.25,
        includeProcessingFee: true,
      })
    ).toBe(141);
  });

  it('resolveWizardRetailMsrpRate keeps MSRPRate when already retail total', () => {
    expect(
      resolveWizardRetailMsrpRate({
        msrpFromDb: 141,
        componentBase: 135.75,
        includedProcessingFee: 5.25,
        includeProcessingFee: true,
      })
    ).toBe(141);
  });

  it('memberRetailFromMsrpRate returns msrp as-is', () => {
    expect(memberRetailFromMsrpRate(141)).toBe(141);
  });
});
