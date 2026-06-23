/**
 * Enrollment Date Helper Functions
 *
 * Utilities for calculating effective dates, termination dates, and validating
 * enrollment timing rules.
 */

const {
  COHORT_FIRST,
  COHORT_FIFTEENTH,
  getNextCohortDate,
  getCohortFromDate,
  getBillingPeriodForCohort
} = require('./billingCohort');

/**
 * Compute the next valid enrollment effective date for a member.
 *
 * @param {Object} member - { GroupId?, ... }
 * @param {Object|null} product - optional product for individual effective-date-logic
 * @param {Object|null} group - optional group metadata. When group.AllowMidMonthEffective === true
 *                              and no household cohort is set, returns whichever of next-1st
 *                              or next-15th is sooner.
 * @param {'FIRST'|'FIFTEENTH'|null} householdCohort - existing household cohort, if any. When
 *                              set, the result is locked to that cohort so dependents and
 *                              plan changes don't drift from the rest of the family.
 * @returns {Date} Next valid effective date (UTC).
 */
function calculateNextEffectiveDate(member, product = null, group = null, householdCohort = null) {
  const today = new Date();

  // Household cohort lock takes precedence: keep the family on a single cohort.
  if (householdCohort === COHORT_FIRST) return getNextCohortDate(COHORT_FIRST, today);
  if (householdCohort === COHORT_FIFTEENTH) return getNextCohortDate(COHORT_FIFTEENTH, today);

  if (member.GroupId) {
    if (group && group.AllowMidMonthEffective === true) {
      const nextFirst = getNextCohortDate(COHORT_FIRST, today);
      const nextFifteenth = getNextCohortDate(COHORT_FIFTEENTH, today);
      return nextFirst < nextFifteenth ? nextFirst : nextFifteenth;
    }
    return getNextCohortDate(COHORT_FIRST, today);
  }

  if (product && product.effectiveDateLogic &&
      String(product.effectiveDateLogic).toLowerCase().includes('first_of_month')) {
    return getNextCohortDate(COHORT_FIRST, today);
  }

  // Individual default (preserves current behavior — characterization tests pin this)
  return getNextCohortDate(COHORT_FIRST, today);
}

/**
 * Next plan-change effective date for a **non–group-billed** (individual) member:
 * same day-of-month as the current enrollment's effective date, next occurrence strictly
 * after `fromDate` (UTC calendar days). Clamps when the month is shorter (e.g. Jan 31 → Feb 28).
 * If `anchorEffectiveDate` is missing or invalid, falls back to the next 1st-of-month cohort date.
 *
 * @param {Date|string} anchorEffectiveDate
 * @param {Date} [fromDate]
 * @returns {Date}
 */
function nextIndividualRenewalEffectiveDate(anchorEffectiveDate, fromDate = new Date()) {
  const from = fromDate instanceof Date ? fromDate : new Date(fromDate);
  if (Number.isNaN(from.getTime())) {
    return getNextCohortDate(COHORT_FIRST, new Date());
  }
  let anchor;
  if (anchorEffectiveDate instanceof Date) {
    anchor = anchorEffectiveDate;
  } else if (typeof anchorEffectiveDate === 'string' && anchorEffectiveDate.trim()) {
    const s = anchorEffectiveDate.trim();
    anchor = new Date(s.includes('T') ? s : `${s}T12:00:00Z`);
  } else {
    return getNextCohortDate(COHORT_FIRST, from);
  }
  if (Number.isNaN(anchor.getTime())) {
    return getNextCohortDate(COHORT_FIRST, from);
  }
  const dayOfMonth = anchor.getUTCDate();
  const asOfTs = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());

  let y = from.getUTCFullYear();
  let m = from.getUTCMonth();
  for (let attempt = 0; attempt < 36; attempt += 1) {
    const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const d = Math.min(dayOfMonth, dim);
    const cand = Date.UTC(y, m, d);
    if (cand > asOfTs) {
      return new Date(cand);
    }
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }
  return getNextCohortDate(COHORT_FIRST, from);
}

/**
 * Calculate termination date (day before new effective date)
 * @param {Date} newEffectiveDate - The new enrollment's effective date
 * @returns {Date} Termination date for old enrollment
 */
function calculateTerminationDate(newEffectiveDate) {
  const termDate = new Date(newEffectiveDate);
  termDate.setDate(termDate.getDate() - 1); // Day before
  return termDate;
}

/**
 * Calculate end of current billing month
 * @param {Date} billingDate - Current billing date (optional, defaults to today)
 * @returns {Date} Last day of the month
 */
function calculateEndOfCurrentMonth(billingDate = null) {
  const date = billingDate ? new Date(billingDate) : new Date();
  const year = date.getFullYear();
  const month = date.getMonth();

  // Get last day of current month
  const lastDay = new Date(year, month + 1, 0); // Day 0 of next month = last day of current month
  return lastDay;
}

/**
 * End of the member's current billing period (cohort-aware).
 * For a 1st-cohort member this is the last day of the calendar month.
 * For a 15th-cohort member this is the 14th of the next calendar month.
 *
 * Falls back to calculateEndOfCurrentMonth() for members whose EffectiveDate
 * is missing or lands on a day-of-month other than 1 or 15 (legacy data).
 *
 * @param {Object} member - { EffectiveDate?: Date|string }
 * @returns {Date} UTC end-of-period (or local end-of-month on fallback)
 */
function calculateEndOfCurrentPeriod(member) {
  const today = new Date();
  if (!member || !member.EffectiveDate) {
    return calculateEndOfCurrentMonth(); // fallback for legacy callers
  }
  let cohort;
  try {
    cohort = getCohortFromDate(new Date(member.EffectiveDate));
  } catch {
    return calculateEndOfCurrentMonth(); // legacy non-cohort EffectiveDate (not 1 or 15)
  }
  const { end } = getBillingPeriodForCohort(cohort, today);
  return end;
}

/**
 * Normalize to local calendar midnight. YYYY-MM-DD strings use local y/m/d
 * (not UTC midnight) so comparisons match Date(y, m, d) and API date-only fields.
 * @param {Date|string} value
 * @returns {Date|null}
 */
function toLocalCalendarMidnight(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const d = new Date(value.getTime());
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const datePart = trimmed.split('T')[0];
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Check if an enrollment has a future effective date
 * @param {Date|string} effectiveDate - Enrollment effective date
 * @returns {boolean} True if enrollment is in the future
 */
function isFutureEnrollment(effectiveDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const effective = toLocalCalendarMidnight(effectiveDate);
  if (!effective) return false;

  return effective > today;
}

/**
 * Check if member has any future-effective enrollments for given products
 * @param {Object} transaction - Database transaction
 * @param {string} memberId - Member ID
 * @param {Array} productIds - Array of product IDs to check
 * @returns {Promise<Array>} Array of future enrollments
 */
async function checkForFutureEnrollments(transaction, memberId, productIds) {
  const sql = require('mssql');
  
  const query = `
    SELECT 
      e.EnrollmentId,
      e.ProductId,
      p.Name as ProductName,
      e.EffectiveDate,
      e.Status,
      DATEDIFF(day, CAST(GETUTCDATE() AS DATE), e.EffectiveDate) as DaysUntilEffective
    FROM oe.Enrollments e
    INNER JOIN oe.Products p ON e.ProductId = p.ProductId
    WHERE e.MemberId = @memberId
      AND e.ProductId IN (${productIds.map((_, i) => `@productId${i}`).join(', ')})
      AND e.Status IN ('Active', 'Pending')
      AND e.EffectiveDate > CAST(GETUTCDATE() AS DATE)
      AND (e.TerminationDate IS NULL OR e.TerminationDate > CAST(GETUTCDATE() AS DATE))
  `;
  
  const request = transaction.request();
  request.input('memberId', sql.UniqueIdentifier, memberId);
  
  productIds.forEach((productId, index) => {
    request.input(`productId${index}`, sql.UniqueIdentifier, productId);
  });
  
  const result = await request.query(query);
  return result.recordset;
}

/**
 * Get all household members for an enrollment
 * @param {Object} transaction - Database transaction
 * @param {string} memberId - Primary member ID
 * @returns {Promise<Array>} Array of household member IDs
 */
async function getHouseholdMemberIds(transaction, memberId) {
  const sql = require('mssql');
  
  const query = `
    SELECT m.MemberId, m.RelationshipType
    FROM oe.Members m
    WHERE m.HouseholdId = (
      SELECT HouseholdId FROM oe.Members WHERE MemberId = @memberId
    )
  `;
  
  const request = transaction.request();
  request.input('memberId', sql.UniqueIdentifier, memberId);
  
  const result = await request.query(query);
  return result.recordset;
}

/**
 * Terminate enrollment with proper date logic
 * @param {Object} transaction - Database transaction
 * @param {string} enrollmentId - Enrollment ID to terminate
 * @param {Date} newEffectiveDate - New enrollment's effective date
 * @param {string} modifiedBy - User ID making the change
 * @returns {Promise<void>}
 */
async function terminateEnrollment(transaction, enrollmentId, newEffectiveDate, modifiedBy) {
  const sql = require('mssql');
  
  const terminationDate = calculateTerminationDate(newEffectiveDate);
  
  const query = `
    UPDATE oe.Enrollments
    SET Status = 'Inactive',
        TerminationDate = @terminationDate,
        ModifiedDate = GETUTCDATE(),
        ModifiedBy = @modifiedBy
    WHERE EnrollmentId = @enrollmentId
  `;
  
  const request = transaction.request();
  request.input('enrollmentId', sql.UniqueIdentifier, enrollmentId);
  request.input('terminationDate', sql.Date, terminationDate);
  request.input('modifiedBy', sql.UniqueIdentifier, modifiedBy);
  
  await request.query(query);
  
  console.log(`✅ Terminated enrollment ${enrollmentId} on ${terminationDate.toISOString().split('T')[0]}`);
}

/**
 * Cancel a future enrollment (soft delete)
 * @param {Object} transaction - Database transaction
 * @param {string} enrollmentId - Enrollment ID to cancel
 * @param {string} modifiedBy - User ID making the change
 * @returns {Promise<void>}
 */
async function cancelFutureEnrollment(transaction, enrollmentId, modifiedBy) {
  const sql = require('mssql');
  
  // Get the effective date to calculate proper termination
  const getQuery = `
    SELECT EffectiveDate 
    FROM oe.Enrollments 
    WHERE EnrollmentId = @enrollmentId
  `;
  
  const getRequest = transaction.request();
  getRequest.input('enrollmentId', sql.UniqueIdentifier, enrollmentId);
  const result = await getRequest.query(getQuery);
  
  if (result.recordset.length === 0) {
    throw new Error('Enrollment not found');
  }
  
  const effectiveDate = result.recordset[0].EffectiveDate;
  const terminationDate = calculateTerminationDate(new Date(effectiveDate));
  
  const updateQuery = `
    UPDATE oe.Enrollments
    SET Status = 'Cancelled',
        TerminationDate = @terminationDate,
        ModifiedDate = GETUTCDATE(),
        ModifiedBy = @modifiedBy
    WHERE EnrollmentId = @enrollmentId
  `;
  
  const updateRequest = transaction.request();
  updateRequest.input('enrollmentId', sql.UniqueIdentifier, enrollmentId);
  updateRequest.input('terminationDate', sql.Date, terminationDate);
  updateRequest.input('modifiedBy', sql.UniqueIdentifier, modifiedBy);
  
  await updateRequest.query(updateQuery);
  
  console.log(`✅ Cancelled future enrollment ${enrollmentId} (termination: ${terminationDate.toISOString().split('T')[0]})`);
}

/**
 * Format date and time from UTC ISO string without timezone conversion
 * Parses date parts separately to avoid timezone shifts (e.g., "2025-12-31T00:00:00Z" stays Dec 31, not Dec 30)
 * 
 * @param {string} isoDateString - ISO date string from database (e.g., "2025-12-31T23:59:59Z")
 * @param {object} options - Formatting options (same as toLocaleString)
 * @returns {string} Formatted date string
 */
function formatDateWithoutTimezone(isoDateString, options = {}) {
  if (!isoDateString) return '';
  
  try {
    // Convert Date object to ISO string if needed
    let dateString = isoDateString;
    if (isoDateString instanceof Date) {
      dateString = isoDateString.toISOString();
    } else if (typeof isoDateString !== 'string') {
      // Try to convert to string
      dateString = String(isoDateString);
    }
    
    // Extract date and time parts from ISO string
    const [datePart, timePart] = dateString.split('T');
    const [year, month, day] = datePart.split('-');
    
    // Extract time parts (remove 'Z' or timezone if present)
    const timeOnly = (timePart || '').split(/[Z+-]/)[0];
    const [hour = 0, minute = 0, second = 0] = timeOnly.split(':').map(n => parseInt(n) || 0);
    
    // Create date from parts (month is 0-indexed in JS Date)
    // This creates a local date without timezone conversion
    const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day), hour, minute, second);
    
    // Format with provided options (default to date + time)
    const defaultOptions = {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      ...options
    };
    
    return date.toLocaleString('en-US', defaultOptions);
  } catch (error) {
    console.error('Error formatting date without timezone:', error);
    // Fallback to simple date string
    try {
      const dateString = isoDateString instanceof Date ? isoDateString.toISOString() : String(isoDateString);
      return dateString.split('T')[0];
    } catch (fallbackError) {
      console.error('Error in fallback date formatting:', fallbackError);
      return '';
    }
  }
}

module.exports = {
  calculateNextEffectiveDate,
  nextIndividualRenewalEffectiveDate,
  calculateTerminationDate,
  calculateEndOfCurrentMonth,
  calculateEndOfCurrentPeriod,
  isFutureEnrollment,
  checkForFutureEnrollments,
  getHouseholdMemberIds,
  terminateEnrollment,
  cancelFutureEnrollment,
  formatDateWithoutTimezone
};

