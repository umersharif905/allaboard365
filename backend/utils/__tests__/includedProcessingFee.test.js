const { calculateIncludedProcessingFeeForDisplay } = require('../includedProcessingFee');

const tenantSettings = {
  chargeFeeToMember: true,
  activeProcessor: 'openenroll',
  processors: {
    openenroll: {
      fees: {
        ach: { percentageFee: 0.0025, flatFee: 0 },
        creditCard: { percentageFee: 0.03, flatFee: 0.30 }
      }
    }
  }
};

const tenantSettingsFeeOff = { ...tenantSettings, chargeFeeToMember: false };

describe('calculateIncludedProcessingFeeForDisplay', () => {
  describe('guards', () => {
    test('returns 0 when tenantSettings is null', () => {
      expect(calculateIncludedProcessingFeeForDisplay(100, null, false)).toBe(0);
    });

    test('returns 0 when chargeFeeToMember is false', () => {
      expect(calculateIncludedProcessingFeeForDisplay(100, tenantSettingsFeeOff, false)).toBe(0);
    });

    test('ACH zero amount returns 0 (percentage of 0 + no flat fee)', () => {
      expect(
        calculateIncludedProcessingFeeForDisplay(0, tenantSettings, false, { paymentMethod: 'ACH' })
      ).toBe(0);
    });

    test('zero amount on Card still returns the Card flat fee ($0.30)', () => {
      // Documents existing behavior: flat fee applies regardless of amount.
      expect(
        calculateIncludedProcessingFeeForDisplay(0, tenantSettings, false, { paymentMethod: 'Card' })
      ).toBe(0.30);
    });
  });

  describe('default paymentMethod (Highest)', () => {
    test('no options → Highest → Card fee (Card > ACH at $100)', () => {
      // Card: 100 * 0.03 + 0.30 = 3.30; ACH: 100 * 0.0025 = 0.25 → max = 3.30
      expect(calculateIncludedProcessingFeeForDisplay(100, tenantSettings, false)).toBe(3.30);
    });
  });

  describe('paymentMethod=ACH', () => {
    test('zeroFeeForACH=false → ACH fee', () => {
      expect(
        calculateIncludedProcessingFeeForDisplay(100, tenantSettings, false, { paymentMethod: 'ACH' })
      ).toBe(0.25);
    });

    test('zeroFeeForACH=true → 0 (short-circuits)', () => {
      expect(
        calculateIncludedProcessingFeeForDisplay(100, tenantSettings, false, { paymentMethod: 'ACH', zeroFeeForACH: true })
      ).toBe(0);
    });

    test('case-insensitive "ach" → short-circuits with zeroFeeForACH', () => {
      expect(
        calculateIncludedProcessingFeeForDisplay(100, tenantSettings, false, { paymentMethod: 'ach', zeroFeeForACH: true })
      ).toBe(0);
    });
  });

  describe('paymentMethod=Card', () => {
    test('zeroFeeForACH=true → Card fee (zeroFeeForACH only affects ACH)', () => {
      expect(
        calculateIncludedProcessingFeeForDisplay(100, tenantSettings, false, { paymentMethod: 'Card', zeroFeeForACH: true })
      ).toBe(3.30);
    });

    test('zeroFeeForACH=false → Card fee (unchanged)', () => {
      expect(
        calculateIncludedProcessingFeeForDisplay(100, tenantSettings, false, { paymentMethod: 'Card', zeroFeeForACH: false })
      ).toBe(3.30);
    });
  });

  describe('paymentMethod=Highest', () => {
    test('zeroFeeForACH=false → max(ACH, Card) = Card', () => {
      expect(
        calculateIncludedProcessingFeeForDisplay(100, tenantSettings, false, { paymentMethod: 'Highest', zeroFeeForACH: false })
      ).toBe(3.30);
    });

    test('zeroFeeForACH=true → collapses to Card (ACH leg is $0 so Card is the max anyway)', () => {
      expect(
        calculateIncludedProcessingFeeForDisplay(100, tenantSettings, false, { paymentMethod: 'Highest', zeroFeeForACH: true })
      ).toBe(3.30);
    });

    test('case-insensitive "highest" with zeroFeeForACH → Card fee', () => {
      expect(
        calculateIncludedProcessingFeeForDisplay(100, tenantSettings, false, { paymentMethod: 'highest', zeroFeeForACH: true })
      ).toBe(3.30);
    });
  });

  describe('roundUp behavior', () => {
    test('roundUp=false → rounds fee to 2 decimals', () => {
      // Card fee on 33.33: 33.33 * 0.03 + 0.30 = 0.9999 + 0.30 = 1.2999 → rounds to 1.30
      expect(
        calculateIncludedProcessingFeeForDisplay(33.33, tenantSettings, false, { paymentMethod: 'Card' })
      ).toBeCloseTo(1.30, 2);
    });

    test('roundUp=true → rounds UP so (base+fee) ceils to whole dollar', () => {
      // base=100, Card fee = 3.30, base+fee = 103.30 → ceil = 104 → includedFee = 4
      expect(
        calculateIncludedProcessingFeeForDisplay(100, tenantSettings, true, { paymentMethod: 'Card' })
      ).toBe(4.00);
    });

    test('roundUp=true with zeroFeeForACH short-circuit → 0 (no rounding)', () => {
      expect(
        calculateIncludedProcessingFeeForDisplay(100, tenantSettings, true, { paymentMethod: 'ACH', zeroFeeForACH: true })
      ).toBe(0);
    });
  });
});
