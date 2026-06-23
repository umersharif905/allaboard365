/**
 * Frontend cohort derivation — mirrors backend/utils/billingCohort.js but
 * with null-tolerant inputs (UI should never crash on bad data).
 */
export const COHORT_FIRST = 'FIRST' as const;
export const COHORT_FIFTEENTH = 'FIFTEENTH' as const;

export type Cohort = typeof COHORT_FIRST | typeof COHORT_FIFTEENTH;

export function getCohortFromDate(input: string | Date | null | undefined): Cohort | null {
  if (input === null || input === undefined) return null;
  const date = input instanceof Date ? input : new Date(input);
  if (isNaN(date.getTime())) return null;
  const day = date.getUTCDate();
  if (day === 1) return COHORT_FIRST;
  if (day === 15) return COHORT_FIFTEENTH;
  return null;
}

export function cohortLabel(cohort: Cohort | null): string {
  if (cohort === COHORT_FIRST) return '1st of month';
  if (cohort === COHORT_FIFTEENTH) return '15th of month';
  return '—';
}
