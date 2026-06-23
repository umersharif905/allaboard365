'use strict';

const { requireShared } = require('../../config/shared-modules');
const { resolveProcessingFeeTotalFromParts } = requireShared('payment-product-snapshots');

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function legacyDue({ premiumSum, included, ppfRow }) {
  const { total } = resolveProcessingFeeTotalFromParts(included, ppfRow);
  return round2(premiumSum - ppfRow + total);
}

function migratedPremiumSum({ premiumSum, included, ppfRow }) {
  const { total: newPpf } = resolveProcessingFeeTotalFromParts(included, ppfRow);
  return round2(premiumSum - ppfRow + newPpf);
}

describe('included fee migration parity', () => {
  const cases = [
    {
      name: 'Colin Smith (ACH)',
      premiumSum: 842.5,
      included: 7.5,
      ppfRow: 0.25,
      expected: 850,
    },
    {
      name: 'Major Burden (Card)',
      premiumSum: 417.84,
      included: 6,
      ppfRow: 7.09,
      expected: 423.84,
    },
    {
      name: 'Michael Griffin (ACH)',
      premiumSum: 710.42,
      included: 8.5,
      ppfRow: 0.17,
      expected: 718.92,
    },
    {
      name: 'No PPF row household',
      premiumSum: 500,
      included: 12,
      ppfRow: 0,
      expected: 512,
    },
    {
      name: 'Equal-split legacy full row',
      premiumSum: 200,
      included: 6,
      ppfRow: 6,
      expected: 200,
    },
  ];

  for (const c of cases) {
    it(`${c.name}: migration preserves billed total ${c.expected}`, () => {
      expect(legacyDue(c)).toBe(c.expected);
      expect(migratedPremiumSum(c)).toBe(c.expected);
    });
  }
});
