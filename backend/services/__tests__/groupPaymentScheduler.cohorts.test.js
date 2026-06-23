// backend/services/__tests__/groupPaymentScheduler.cohorts.test.js
// Unit tests for the dual-cohort dispatch helper `getCohortsToProcessToday`.
// Replaces the Phase 0.2 characterization test that pinned the `5` literal.

const { getCohortsToProcessToday, shouldGroupProcessForCohort } = require('../groupPaymentScheduler');

describe('groupPaymentScheduler — getCohortsToProcessToday', () => {
  it('returns [FIRST] on UTC day 1', () => {
    expect(getCohortsToProcessToday(new Date('2026-04-01T12:00:00Z'))).toEqual(['FIRST']);
  });

  it('returns [FIFTEENTH] on UTC day 15', () => {
    expect(getCohortsToProcessToday(new Date('2026-04-15T12:00:00Z'))).toEqual(['FIFTEENTH']);
  });

  it('returns [] on any other day', () => {
    expect(getCohortsToProcessToday(new Date('2026-04-10T12:00:00Z'))).toEqual([]);
    expect(getCohortsToProcessToday(new Date('2026-04-14T23:59:59Z'))).toEqual([]);
    expect(getCohortsToProcessToday(new Date('2026-04-16T00:00:00Z'))).toEqual([]);
    expect(getCohortsToProcessToday(new Date('2026-04-30T12:00:00Z'))).toEqual([]);
  });

  it('uses UTC day-of-month (not local)', () => {
    // 2026-04-14T23:30Z is still UTC day 14 even if local TZ says day 15.
    expect(getCohortsToProcessToday(new Date('2026-04-14T23:30:00Z'))).toEqual([]);
    // 2026-04-15T00:30Z is UTC day 15.
    expect(getCohortsToProcessToday(new Date('2026-04-15T00:30:00Z'))).toEqual(['FIFTEENTH']);
  });
});

describe('groupPaymentScheduler — shouldGroupProcessForCohort (mixed-cohort eligibility)', () => {
  it('routes a non-mid-month group to the FIRST cohort only', () => {
    const g = { AllowMidMonthEffective: false };
    expect(shouldGroupProcessForCohort(g, 'FIRST')).toBe(true);
    expect(shouldGroupProcessForCohort(g, 'FIFTEENTH')).toBe(false);
  });

  it('routes a mid-month group to BOTH cohorts (mixed-cohort billing)', () => {
    // A mid-month group can have 1st-cohort hires AND 15th-cohort hires; the FIRST
    // run bills the 1st-cohort subset on day 5, the FIFTEENTH run bills the 15th
    // subset on day 20. The two cohorts get independent DIME schedules so neither
    // touches the other.
    const g = { AllowMidMonthEffective: true };
    expect(shouldGroupProcessForCohort(g, 'FIRST')).toBe(true);
    expect(shouldGroupProcessForCohort(g, 'FIFTEENTH')).toBe(true);
  });

  it('treats AllowMidMonthEffective=1 (sql bit) the same as true', () => {
    const g = { AllowMidMonthEffective: 1 };
    expect(shouldGroupProcessForCohort(g, 'FIRST')).toBe(true);
    expect(shouldGroupProcessForCohort(g, 'FIFTEENTH')).toBe(true);
  });

  it('treats missing/null/0 as non-mid-month (FIRST cohort only)', () => {
    expect(shouldGroupProcessForCohort({}, 'FIRST')).toBe(true);
    expect(shouldGroupProcessForCohort({}, 'FIFTEENTH')).toBe(false);
    expect(shouldGroupProcessForCohort({ AllowMidMonthEffective: 0 }, 'FIRST')).toBe(true);
    expect(shouldGroupProcessForCohort({ AllowMidMonthEffective: 0 }, 'FIFTEENTH')).toBe(false);
    expect(shouldGroupProcessForCohort({ AllowMidMonthEffective: null }, 'FIFTEENTH')).toBe(false);
  });

  it('a non-mid-month group with no FIFTEENTH plan is NOT eligible for the FIFTEENTH cohort', () => {
    // The validators block 15th-of-month enrollments for non-mid-month groups, so the
    // FIFTEENTH scheduler run would always compute $0 for them anyway. Filtering at
    // eligibility keeps the run cheap.
    expect(shouldGroupProcessForCohort({ AllowMidMonthEffective: false, HasFifteenthPlan: false }, 'FIFTEENTH')).toBe(false);
    expect(shouldGroupProcessForCohort({ AllowMidMonthEffective: false }, 'FIFTEENTH')).toBe(false);
  });

  it('toggle-off mid-stream: a non-mid-month group WITH an existing FIFTEENTH plan IS eligible for the FIFTEENTH cohort', () => {
    // Tenant flips AllowMidMonthEffective off after legacy 15th-cohort households have
    // already enrolled. Their plan still needs to refresh each cycle (otherwise their
    // DIME schedule goes stale and billing silently stops). The cohort-emptied branch
    // in processGroupForCohort handles the case where 0 enrollments remain.
    expect(shouldGroupProcessForCohort({ AllowMidMonthEffective: false, HasFifteenthPlan: true }, 'FIFTEENTH')).toBe(true);
    expect(shouldGroupProcessForCohort({ AllowMidMonthEffective: 0, HasFifteenthPlan: 1 }, 'FIFTEENTH')).toBe(true);
  });
});
