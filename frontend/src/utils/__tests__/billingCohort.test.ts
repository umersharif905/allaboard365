import { describe, it, expect } from 'vitest';
import { getCohortFromDate, COHORT_FIRST, COHORT_FIFTEENTH, cohortLabel } from '../billingCohort';

describe('frontend billingCohort helpers', () => {
  it('returns FIRST for day 1 ISO string', () => {
    expect(getCohortFromDate('2026-04-01')).toBe(COHORT_FIRST);
  });
  it('returns FIFTEENTH for day 15 ISO string', () => {
    expect(getCohortFromDate('2026-04-15')).toBe(COHORT_FIFTEENTH);
  });
  it('returns FIRST for day-1 Date object', () => {
    expect(getCohortFromDate(new Date('2026-04-01T12:00:00Z'))).toBe(COHORT_FIRST);
  });
  it('returns null for invalid cohort day (does not throw)', () => {
    expect(getCohortFromDate('2026-04-10')).toBeNull();
  });
  it('returns null for undefined/null input', () => {
    expect(getCohortFromDate(undefined)).toBeNull();
    expect(getCohortFromDate(null as any)).toBeNull();
  });
  it('cohortLabel returns human strings', () => {
    expect(cohortLabel(COHORT_FIRST)).toBe('1st of month');
    expect(cohortLabel(COHORT_FIFTEENTH)).toBe('15th of month');
    expect(cohortLabel(null)).toBe('—');
  });
});
