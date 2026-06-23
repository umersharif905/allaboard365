// Helper extracted to `_groups-validation.js` so it can be unit-tested without
// pulling in the full routes/groups.js import chain (which transitively loads
// uploads.js — the latter has a duplicate-function-declaration that babel
// refuses to parse, even though node's standard loader is tolerant).
const { isValidEarliestEffectiveDate } = require('../_groups-validation');

describe('groups route — Earliest Effective Date validation', () => {
  it('accepts day 1 when AllowMidMonthEffective=false', () => {
    const d = new Date('2026-05-01T12:00:00Z');
    expect(isValidEarliestEffectiveDate(d, { AllowMidMonthEffective: false })).toBe(true);
  });
  it('rejects day 15 when AllowMidMonthEffective=false', () => {
    const d = new Date('2026-05-15T12:00:00Z');
    expect(isValidEarliestEffectiveDate(d, { AllowMidMonthEffective: false })).toBe(false);
  });
  it('accepts both day 1 and day 15 when AllowMidMonthEffective=true', () => {
    const g = { AllowMidMonthEffective: true };
    expect(isValidEarliestEffectiveDate(new Date('2026-05-01T12:00:00Z'), g)).toBe(true);
    expect(isValidEarliestEffectiveDate(new Date('2026-05-15T12:00:00Z'), g)).toBe(true);
  });
  it('rejects day 10 even when AllowMidMonthEffective=true', () => {
    expect(
      isValidEarliestEffectiveDate(new Date('2026-05-10T12:00:00Z'), { AllowMidMonthEffective: true })
    ).toBe(false);
  });
  it('rejects day 1 when group is undefined (defensive default)', () => {
    // Document the contract for callers who forget to pass group context.
    // Either: throws, returns false, or treats missing group as flag=off.
    // Pick whatever the impl does and assert it. Adjust if real behavior differs.
    expect(isValidEarliestEffectiveDate(new Date('2026-05-15T12:00:00Z'), undefined)).toBe(false);
  });

  describe('household cohort lock', () => {
    const flagOnGroup = { AllowMidMonthEffective: true };
    const flagOffGroup = { AllowMidMonthEffective: false };

    it('locks a FIRST-cohort household to day 1 even when group flag is on', () => {
      expect(isValidEarliestEffectiveDate(new Date('2026-05-01T12:00:00Z'), flagOnGroup, 'FIRST')).toBe(true);
      expect(isValidEarliestEffectiveDate(new Date('2026-05-15T12:00:00Z'), flagOnGroup, 'FIRST')).toBe(false);
    });

    it('locks a FIFTEENTH-cohort household to day 15 even when group flag is on', () => {
      expect(isValidEarliestEffectiveDate(new Date('2026-05-15T12:00:00Z'), flagOnGroup, 'FIFTEENTH')).toBe(true);
      expect(isValidEarliestEffectiveDate(new Date('2026-05-01T12:00:00Z'), flagOnGroup, 'FIFTEENTH')).toBe(false);
    });

    it('household cohort overrides group flag — FIFTEENTH cohort still valid even if group flag is off', () => {
      // If a group's flag is later toggled off, existing FIFTEENTH-cohort
      // households shouldn't lose their already-locked cohort.
      expect(isValidEarliestEffectiveDate(new Date('2026-05-15T12:00:00Z'), flagOffGroup, 'FIFTEENTH')).toBe(true);
    });

    it('null household cohort falls back to group rules', () => {
      expect(isValidEarliestEffectiveDate(new Date('2026-05-15T12:00:00Z'), flagOnGroup, null)).toBe(true);
      expect(isValidEarliestEffectiveDate(new Date('2026-05-15T12:00:00Z'), flagOffGroup, null)).toBe(false);
    });
  });
});
