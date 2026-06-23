/**
 * Contract tests for Highest / ACH-only / Card-only included fee display math.
 */

const includedProcessingFee = require('../includedProcessingFee');

const TENANT_SETTINGS = {
  chargeFeeToMember: true,
  activeProcessor: 'openenroll',
  processors: {
    openenroll: {
      fees: {
        ach: { percentageFee: 0.008, flatFee: 0 },
        creditCard: { percentageFee: 0.03, flatFee: 0 }
      }
    }
  }
};

describe('calculateIncludedProcessingFeeForDisplay — contract', () => {
  test('base 180, Highest, roundUp → $6.00 (ceil to whole-dollar display)', () => {
    const fee = includedProcessingFee.calculateIncludedProcessingFeeForDisplay(
      180,
      TENANT_SETTINGS,
      true,
      { paymentMethod: 'Highest' }
    );
    expect(fee).toBe(6);
  });

  test('base 307, Highest, roundUp → $10.00', () => {
    const fee = includedProcessingFee.calculateIncludedProcessingFeeForDisplay(
      307,
      TENANT_SETTINGS,
      true,
      { paymentMethod: 'Highest' }
    );
    expect(fee).toBe(10);
  });

  test('base 180, ACH-only, roundUp → ceil(180+1.44)-180 = 2', () => {
    const fee = includedProcessingFee.calculateIncludedProcessingFeeForDisplay(
      180,
      TENANT_SETTINGS,
      true,
      { paymentMethod: 'ACH' }
    );
    expect(fee).toBe(2);
  });

  test('base 307, Card-only, roundUp → ceil(307+9.21)-307 = 10', () => {
    const fee = includedProcessingFee.calculateIncludedProcessingFeeForDisplay(
      307,
      TENANT_SETTINGS,
      true,
      { paymentMethod: 'Card' }
    );
    expect(fee).toBe(10);
  });

  test('base 180, Highest, roundUp=false → $5.40', () => {
    const fee = includedProcessingFee.calculateIncludedProcessingFeeForDisplay(
      180,
      TENANT_SETTINGS,
      false,
      { paymentMethod: 'Highest' }
    );
    expect(fee).toBe(5.4);
  });
});
