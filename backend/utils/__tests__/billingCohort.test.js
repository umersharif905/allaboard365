const {
  getCohortFromDate,
  getBillingPeriodForCohort,
  getChargeDayForCohort,
  getNextCohortDate,
  COHORT_FIRST,
  COHORT_FIFTEENTH
} = require('../billingCohort');

describe('billingCohort helpers', () => {
  describe('getCohortFromDate', () => {
    it('returns FIRST for day 1', () => {
      expect(getCohortFromDate(new Date('2026-04-01T12:00:00Z'))).toBe(COHORT_FIRST);
    });
    it('returns FIFTEENTH for day 15', () => {
      expect(getCohortFromDate(new Date('2026-04-15T12:00:00Z'))).toBe(COHORT_FIFTEENTH);
    });
    it('throws for day 10 (invalid cohort)', () => {
      expect(() => getCohortFromDate(new Date('2026-04-10T12:00:00Z'))).toThrow(/cohort/i);
    });
  });

  describe('getBillingPeriodForCohort', () => {
    it('FIRST cohort on 2026-04-01 → period Apr 1 – Apr 30 (UTC)', () => {
      const { start, end } = getBillingPeriodForCohort(COHORT_FIRST, new Date('2026-04-01T12:00:00Z'));
      expect(start.toISOString().slice(0, 10)).toBe('2026-04-01');
      expect(end.toISOString().slice(0, 10)).toBe('2026-04-30');
    });

    it('FIFTEENTH cohort on 2026-04-15 → period Apr 15 – May 14 (UTC)', () => {
      const { start, end } = getBillingPeriodForCohort(COHORT_FIFTEENTH, new Date('2026-04-15T12:00:00Z'));
      expect(start.toISOString().slice(0, 10)).toBe('2026-04-15');
      expect(end.toISOString().slice(0, 10)).toBe('2026-05-14');
    });

    it('FIFTEENTH cohort wraps year boundary (Dec 15 → Jan 14)', () => {
      const { start, end } = getBillingPeriodForCohort(COHORT_FIFTEENTH, new Date('2026-12-15T12:00:00Z'));
      expect(start.toISOString().slice(0, 10)).toBe('2026-12-15');
      expect(end.toISOString().slice(0, 10)).toBe('2027-01-14');
    });

    it('FIRST cohort handles leap-year February correctly', () => {
      const { end } = getBillingPeriodForCohort(COHORT_FIRST, new Date('2028-02-01T12:00:00Z'));
      expect(end.toISOString().slice(0, 10)).toBe('2028-02-29');
    });
  });

  describe('getChargeDayForCohort', () => {
    it('returns 5 for FIRST cohort', () => {
      expect(getChargeDayForCohort(COHORT_FIRST)).toBe(5);
    });
    it('returns 20 for FIFTEENTH cohort', () => {
      expect(getChargeDayForCohort(COHORT_FIFTEENTH)).toBe(20);
    });
  });

  describe('getNextCohortDate', () => {
    it('FIRST on Apr 15 → May 1', () => {
      const result = getNextCohortDate(COHORT_FIRST, new Date('2026-04-15T12:00:00Z'));
      expect(result.toISOString().slice(0, 10)).toBe('2026-05-01');
    });
    it('FIRST on Apr 1 → May 1 (strictly after today)', () => {
      const result = getNextCohortDate(COHORT_FIRST, new Date('2026-04-01T12:00:00Z'));
      expect(result.toISOString().slice(0, 10)).toBe('2026-05-01');
    });
    it('FIFTEENTH on Apr 1 → Apr 15', () => {
      const result = getNextCohortDate(COHORT_FIFTEENTH, new Date('2026-04-01T12:00:00Z'));
      expect(result.toISOString().slice(0, 10)).toBe('2026-04-15');
    });
    it('FIFTEENTH on Apr 15 → May 15', () => {
      const result = getNextCohortDate(COHORT_FIFTEENTH, new Date('2026-04-15T12:00:00Z'));
      expect(result.toISOString().slice(0, 10)).toBe('2026-05-15');
    });
  });
});
