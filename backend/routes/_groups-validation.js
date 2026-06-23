// File: backend/routes/_groups-validation.js
// Validation helpers extracted from routes/groups.js so they can be unit-tested
// without pulling in the full Express router (and its heavy transitive deps).

/**
 * Returns true when `date` is a valid Earliest Effective Date for the given
 * group's configuration.
 *
 * Rules (in priority order):
 *  - If `householdCohort` is 'FIRST', only day 1 is allowed.
 *  - If `householdCohort` is 'FIFTEENTH', only day 15 is allowed.
 *  - Otherwise (no cohort lock yet), if `group.AllowMidMonthEffective` is
 *    truthy, day 1 or 15 is allowed.
 *  - Otherwise, only day 1 is allowed.
 *  - If `date` is null/invalid, returns false.
 *
 * The household cohort lock keeps a single household on one billing cohort:
 * once a primary subscriber enrolls on the 1st, every dependent and plan
 * change for that household must also land on the 1st (and same for the 15th).
 * Eliminates mixed-cohort households so a family always has one invoice per
 * period.
 *
 * Uses UTC day-of-month (getUTCDate()) to avoid timezone drift. Callers should
 * construct `date` with `Date.UTC(...)` or an ISO string so the UTC day matches
 * the calendar day the user picked.
 */
function isValidEarliestEffectiveDate(date, group, householdCohort = null) {
  if (!date || isNaN(date.getTime())) return false;
  const day = date.getUTCDate();
  if (householdCohort === 'FIRST') return day === 1;
  if (householdCohort === 'FIFTEENTH') return day === 15;
  if (group && (group.AllowMidMonthEffective === true || group.AllowMidMonthEffective === 1)) {
    return day === 1 || day === 15;
  }
  return day === 1;
}

module.exports = {
  isValidEarliestEffectiveDate,
};
