/**
 * Unit tests for onboarding link grant tier validation (no DB).
 */

const {
  tierLevelsMatch,
  validateGrantTierAgainstSortOrders
} = require('../onboardingLinkGrantTierValidation.service');

describe('onboardingLinkGrantTierValidation.service', () => {
  describe('tierLevelsMatch', () => {
    it('matches decimals within epsilon', () => {
      expect(tierLevelsMatch(-0.7, -0.7000001)).toBe(true);
      expect(tierLevelsMatch(0, 0.00005)).toBe(true);
    });

    it('does not match distinct tiers', () => {
      expect(tierLevelsMatch(-2, 0)).toBe(false);
      expect(tierLevelsMatch(-1, 0)).toBe(false);
    });
  });

  describe('validateGrantTierAgainstSortOrders', () => {
    const allowed = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

    it('allows null/empty grant tier', () => {
      expect(validateGrantTierAgainstSortOrders(null, allowed).valid).toBe(true);
      expect(validateGrantTierAgainstSortOrders(undefined, allowed).valid).toBe(true);
      expect(validateGrantTierAgainstSortOrders('', allowed).valid).toBe(true);
    });

    it('allows valid SortOrder 0', () => {
      const r = validateGrantTierAgainstSortOrders(0, allowed);
      expect(r.valid).toBe(true);
    });

    it('rejects orphan negative tiers (MightyWell Tyler case)', () => {
      for (const orphan of [-2, -1, -0.7, -0.5]) {
        const r = validateGrantTierAgainstSortOrders(orphan, allowed);
        expect(r.valid).toBe(false);
        expect(r.message).toMatch(/not a valid commission tier/i);
      }
    });
  });
});
