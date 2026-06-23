/**
 * Enrollment window predicates.
 *
 * IMPORTANT:
 * - Never evaluate oe.Enrollments.Status for activeness.
 * - Use EffectiveDate/TerminationDate only.
 */

function normalizeDateOnly(d) {
  if (!d) return null;
  const date = d instanceof Date ? new Date(d) : new Date(String(d));
  date.setHours(0, 0, 0, 0);
  return date;
}

/**
 * Returns SQL snippet for "active on @asOfDate".
 * Caller must bind @asOfDate as a DATE/DATETIME.
 */
function sqlActiveOnDate(alias = 'e') {
  return `${alias}.EffectiveDate <= @asOfDate AND (${alias}.TerminationDate IS NULL OR ${alias}.TerminationDate > @asOfDate)`;
}

/**
 * Returns SQL snippet for "future effective after @asOfDate".
 * Caller must bind @asOfDate as a DATE/DATETIME.
 */
function sqlFutureEffectiveAfterDate(alias = 'e') {
  return `${alias}.EffectiveDate > @asOfDate AND (${alias}.TerminationDate IS NULL OR ${alias}.TerminationDate > @asOfDate)`;
}

module.exports = {
  normalizeDateOnly,
  sqlActiveOnDate,
  sqlFutureEffectiveAfterDate
};

