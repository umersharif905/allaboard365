import {
  calculateWizardIncludedProcessingFee,
  getHighestFeeConfigForWizardDisplay
} from '../wizardIncludedProcessingFee';
import type { PaymentProcessorSettings } from '../../types/paymentProcessorSettings';

const tenantSettings: PaymentProcessorSettings = {
  activeProcessor: 'openenroll',
  chargeFeeToMember: false,
  processors: {
    openenroll: {
      fees: {
        ach: { percentageFee: 0.008, flatFee: 0 },
        creditCard: { percentageFee: 0.03, flatFee: 0 }
      }
    }
  }
};

describe('wizardIncludedProcessingFee catalog mode', () => {
  it('returns 0 when chargeFeeToMember is false and ignore flag is off', () => {
    expect(calculateWizardIncludedProcessingFee(100, tenantSettings, false)).toBe(0);
    expect(getHighestFeeConfigForWizardDisplay(tenantSettings, 100, false)).toBeNull();
  });

  it('calculates included fee when ignoreChargeFeeToMember is set (catalog wizard)', () => {
    const fee = calculateWizardIncludedProcessingFee(100, tenantSettings, false, {
      ignoreChargeFeeToMember: true
    });
    expect(fee).toBe(3);
    expect(getHighestFeeConfigForWizardDisplay(tenantSettings, 100, false, { ignoreChargeFeeToMember: true })).toEqual(
      expect.objectContaining({ percentage: 3, flatFee: 0 })
    );
  });

  it('honors product-level processing fee % override in catalog mode', () => {
    const fee = calculateWizardIncludedProcessingFee(135.75, tenantSettings, false, {
      ignoreChargeFeeToMember: true,
      percentage: 3,
      flatFee: 0
    });
    expect(fee).toBe(4.07);
  });
});
