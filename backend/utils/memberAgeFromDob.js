/**
 * Member age for pricing / PricingEngine (must stay within 0–120 per PricingValidator).
 *
 * SQL/legacy data sometimes stores birthdays like 0067-12-05 (intended 1967-12-05).
 * A plain Date diff then yields absurd ages and pricing fails — enrollments were created at $0.
 *
 * @param {string|Date|null|undefined} dateOfBirth
 * @param {number} [defaultAge=35]
 * @returns {number}
 */
function getMemberAgeForPricing(dateOfBirth, defaultAge = 35) {
  if (dateOfBirth == null || dateOfBirth === '') {
    return defaultAge;
  }
  const raw = dateOfBirth instanceof Date ? new Date(dateOfBirth.getTime()) : new Date(dateOfBirth);
  if (Number.isNaN(raw.getTime())) {
    return defaultAge;
  }
  let y = raw.getUTCFullYear();
  const m = raw.getUTCMonth();
  const d = raw.getUTCDate();
  // Two-digit / Roman-era year bug: 0067-xx-xx → 1967-xx-xx
  if (y >= 1 && y <= 99) {
    y = 1900 + y;
  }
  if (y < 1900 || y > 2100) {
    console.warn('⚠️ getMemberAgeForPricing: DOB year out of expected range, using default age', {
      dateOfBirth,
      resolvedYear: y
    });
    return defaultAge;
  }
  const normalized = new Date(Date.UTC(y, m, d));
  const ms = Date.now() - normalized.getTime();
  if (!Number.isFinite(ms)) {
    return defaultAge;
  }
  const age = Math.floor(ms / (365.25 * 24 * 60 * 60 * 1000));
  if (!Number.isFinite(age)) {
    return defaultAge;
  }
  const clamped = Math.max(0, Math.min(120, age));
  if (clamped !== age) {
    console.warn('⚠️ getMemberAgeForPricing: clamped age', { dateOfBirth, age, clamped });
  }
  return clamped;
}

module.exports = { getMemberAgeForPricing };
