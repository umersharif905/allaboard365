const { getMemberAgeForPricing } = require('../memberAgeFromDob');

describe('getMemberAgeForPricing', () => {
  test('returns 0 for an infant DOB under one year old', () => {
    const d = new Date();
    d.setMonth(d.getMonth() - 3);
    const iso = d.toISOString().split('T')[0];
    expect(getMemberAgeForPricing(iso, 30)).toBe(0);
  });

  test('returns adult age for 1990-06-15', () => {
    const age = getMemberAgeForPricing('1990-06-15', 30);
    expect(age).toBeGreaterThanOrEqual(18);
    expect(age).toBeLessThanOrEqual(64);
  });

  test('uses default when DOB is missing', () => {
    expect(getMemberAgeForPricing(null, 30)).toBe(30);
    expect(getMemberAgeForPricing('', 30)).toBe(30);
  });
});
