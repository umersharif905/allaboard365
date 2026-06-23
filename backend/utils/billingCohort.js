// backend/utils/billingCohort.js
/**
 * Cohort math for the two supported group billing schedules:
 *   - FIRST cohort:     invoice period = 1st through last day of month; charge on 5th
 *   - FIFTEENTH cohort: invoice period = 15th through 14th of next month; charge on 20th
 *
 * Cohort membership is derived from the day-of-month of a member's EffectiveDate.
 * Only day 1 and day 15 are valid cohort boundaries.
 */

const COHORT_FIRST = 'FIRST';
const COHORT_FIFTEENTH = 'FIFTEENTH';
const CHARGE_DAY = { [COHORT_FIRST]: 5, [COHORT_FIFTEENTH]: 20 };

function getCohortFromDate(date) {
  const day = date.getUTCDate();
  if (day === 1) return COHORT_FIRST;
  if (day === 15) return COHORT_FIFTEENTH;
  throw new Error(
    `Invalid cohort date: day-of-month must be 1 or 15, got ${day}`
  );
}

function getBillingPeriodForCohort(cohort, asOfDate) {
  const y = asOfDate.getUTCFullYear();
  const m = asOfDate.getUTCMonth();
  if (cohort === COHORT_FIRST) {
    const start = new Date(Date.UTC(y, m, 1));
    const end = new Date(Date.UTC(y, m + 1, 0));
    return { start, end };
  }
  if (cohort === COHORT_FIFTEENTH) {
    const start = new Date(Date.UTC(y, m, 15));
    const end = new Date(Date.UTC(y, m + 1, 14));
    return { start, end };
  }
  throw new Error(`Unknown cohort: ${cohort}`);
}

function getChargeDayForCohort(cohort) {
  const day = CHARGE_DAY[cohort];
  if (day === undefined) throw new Error(`Unknown cohort: ${cohort}`);
  return day;
}

function getNextCohortDate(cohort, fromDate) {
  const y = fromDate.getUTCFullYear();
  const m = fromDate.getUTCMonth();
  const d = fromDate.getUTCDate();
  if (cohort === COHORT_FIRST) {
    return new Date(Date.UTC(y, m + 1, 1));
  }
  if (cohort === COHORT_FIFTEENTH) {
    if (d < 15) return new Date(Date.UTC(y, m, 15));
    return new Date(Date.UTC(y, m + 1, 15));
  }
  throw new Error(`Unknown cohort: ${cohort}`);
}

module.exports = {
  COHORT_FIRST,
  COHORT_FIFTEENTH,
  getCohortFromDate,
  getBillingPeriodForCohort,
  getChargeDayForCohort,
  getNextCohortDate
};
