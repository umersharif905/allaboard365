const {
  parseFamilyTierToken,
  normalizeFamilyTierCode,
} = require('../accounting/vendor-breakdown');

describe('vendor-breakdown tier labeling', () => {
  describe('parseFamilyTierToken', () => {
    it('parses standard tier codes from label text', () => {
      expect(parseFamilyTierToken('EE Only')).toBe('EE');
      expect(parseFamilyTierToken('ES Spouse')).toBe('ES');
      expect(parseFamilyTierToken('EC Child')).toBe('EC');
      expect(parseFamilyTierToken('EF Family')).toBe('EF');
    });

    it('returns null for non-tier product names', () => {
      expect(parseFamilyTierToken('MightyWELL CoPay Gold')).toBeNull();
      expect(parseFamilyTierToken('')).toBeNull();
      expect(parseFamilyTierToken(null)).toBeNull();
    });
  });

  describe('normalizeFamilyTierCode', () => {
    it('prefers ProductPricing.TierType over member tier and label', () => {
      expect(
        normalizeFamilyTierCode({
          tierType: 'EE',
          memberTier: 'EF',
          label: 'MightyWELL CoPay Gold',
        })
      ).toBe('EE');
    });

    it('falls back to member tier when tier type is missing', () => {
      expect(
        normalizeFamilyTierCode({
          tierType: null,
          memberTier: 'ES',
          label: 'MightyWELL CoPay Gold',
        })
      ).toBe('ES');
    });

    it('falls back to label when structured fields are missing', () => {
      expect(
        normalizeFamilyTierCode({
          tierType: null,
          memberTier: null,
          label: 'Employee + Spouse',
        })
      ).toBe('ES');
    });

    it('returns Other only when no signal resolves', () => {
      expect(
        normalizeFamilyTierCode({
          tierType: 'Standard',
          memberTier: null,
          label: 'MightyWELL CoPay Gold',
        })
      ).toBe('Other');
    });
  });
});
