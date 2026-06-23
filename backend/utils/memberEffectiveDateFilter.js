/**
 * Optional query params: effectiveDay (1–31), effectiveMonth (1–12), effectiveYear (e.g. 2026).
 * Empty/omitted means "any" for that part. At least one part must be set to apply the filter.
 * Matches members who have at least one qualifying product enrollment (Active/Pending, not terminated)
 * with EffectiveDate on that calendar day/month/year in local date parts (SQL Server date cast).
 */
const { sql } = require('../config/database');

function parseEffectiveDateParts(query) {
    if (!query || typeof query !== 'object') return { parts: null };
    const rawDay = query.effectiveDay;
    const rawMonth = query.effectiveMonth;
    const rawYear = query.effectiveYear;
    const day = rawDay !== undefined && String(rawDay).trim() !== '' ? parseInt(String(rawDay).trim(), 10) : null;
    const month = rawMonth !== undefined && String(rawMonth).trim() !== '' ? parseInt(String(rawMonth).trim(), 10) : null;
    const year = rawYear !== undefined && String(rawYear).trim() !== '' ? parseInt(String(rawYear).trim(), 10) : null;
    if (day === null && month === null && year === null) return { parts: null };
    if (day !== null && (Number.isNaN(day) || day < 1 || day > 31)) {
        return { error: 'effectiveDay must be 1–31' };
    }
    if (month !== null && (Number.isNaN(month) || month < 1 || month > 12)) {
        return { error: 'effectiveMonth must be 1–12' };
    }
    if (year !== null && (Number.isNaN(year) || year < 1900 || year > 2100)) {
        return { error: 'effectiveYear must be between 1900 and 2100' };
    }
    return { parts: { day, month, year } };
}

/**
 * @returns {string} Fragment starting with ` AND ` when parts set, else empty string.
 */
function buildEffectiveDateExistsSql(parts) {
    if (!parts) return '';
    const { day, month, year } = parts;
    const dateConds = [];
    if (day !== null) dateConds.push('DAY(CAST(e.EffectiveDate AS DATE)) = @effectiveDay');
    if (month !== null) dateConds.push('MONTH(CAST(e.EffectiveDate AS DATE)) = @effectiveMonth');
    if (year !== null) dateConds.push('YEAR(CAST(e.EffectiveDate AS DATE)) = @effectiveYear');
    const dateCond = dateConds.join(' AND ');
    return ` AND EXISTS (
    SELECT 1 FROM oe.Enrollments e
    WHERE e.MemberId = m.MemberId
    AND e.EffectiveDate IS NOT NULL
    AND (e.EnrollmentType = 'Product' OR (e.EnrollmentType IS NULL AND e.ProductId IS NOT NULL))
    AND (e.Status = 'Active' OR e.Status = 'Pending')
    AND (e.TerminationDate IS NULL OR e.TerminationDate > GETDATE())
    AND ${dateCond}
  )`;
}

/**
 * Predicate only (no leading AND), for WHERE arrays that use AND joins.
 */
function buildEffectiveDateExistsPredicate(parts) {
    const s = buildEffectiveDateExistsSql(parts);
    return s ? s.trim().replace(/^AND\s+/i, '') : '';
}

function bindEffectiveDateParams(parts, ...requests) {
    if (!parts) return;
    const { day, month, year } = parts;
    for (const r of requests) {
        if (!r || typeof r.input !== 'function') continue;
        if (day !== null) r.input('effectiveDay', sql.Int, day);
        if (month !== null) r.input('effectiveMonth', sql.Int, month);
        if (year !== null) r.input('effectiveYear', sql.Int, year);
    }
}

function resolveAsOfDateParts(parts) {
    const now = new Date();
    const year = parts?.year ?? now.getFullYear();
    const month = parts?.month ?? (now.getMonth() + 1);
    const maxDayInMonth = new Date(year, month, 0).getDate();
    const hasMonthOrYearPart = !!parts && (parts.month !== null || parts.year !== null);
    const defaultDay = hasMonthOrYearPart ? 1 : now.getDate();
    const requestedDay = parts?.day ?? defaultDay;
    const day = Math.min(Math.max(requestedDay, 1), maxDayInMonth);
    return { year, month, day };
}

function buildAsOfDateValue(parts) {
    const resolved = resolveAsOfDateParts(parts || null);
    const mm = String(resolved.month).padStart(2, '0');
    const dd = String(resolved.day).padStart(2, '0');
    return `${resolved.year}-${mm}-${dd}`;
}

/**
 * Enrollment status values for members list:
 * - activelyEnrolled: has at least one non-terminated enrollment (currently effective OR future effective)
 * - active: active on as-of date (effective on/before date and not terminated by that date)
 * - futureEffective: effective after as-of date
 * - effectiveCurrently: effective exactly on as-of date
 * - all: no enrollment-status filter
 */
function buildEnrollmentStatusExistsSql(enrollmentStatus) {
    if (!enrollmentStatus || enrollmentStatus === 'all') return '';
    const base = `
    SELECT 1 FROM oe.Enrollments e
    WHERE e.MemberId = m.MemberId
    AND (e.EnrollmentType = 'Product' OR (e.EnrollmentType IS NULL AND e.ProductId IS NOT NULL))
    AND (e.Status = 'Active' OR e.Status = 'Pending')
  `;
    if (enrollmentStatus === 'activelyEnrolled') {
        return ` AND EXISTS (
  ${base}
    AND (e.TerminationDate IS NULL OR CAST(e.TerminationDate AS DATE) > @asOfDate)
  )`;
    }
    if (enrollmentStatus === 'futureEffective') {
        return ` AND EXISTS (
  ${base}
    AND e.EffectiveDate IS NOT NULL
    AND CAST(e.EffectiveDate AS DATE) > @asOfDate
    AND (e.TerminationDate IS NULL OR CAST(e.TerminationDate AS DATE) > @asOfDate)
  )`;
    }
    if (enrollmentStatus === 'effectiveCurrently') {
        return ` AND EXISTS (
  ${base}
    AND (
      e.EffectiveDate IS NULL
      OR CAST(e.EffectiveDate AS DATE) <= @asOfDate
    )
    AND (e.TerminationDate IS NULL OR CAST(e.TerminationDate AS DATE) > @asOfDate)
  )`;
    }
    if (enrollmentStatus === 'active') {
        return ` AND EXISTS (
  ${base}
    AND (
      e.EffectiveDate IS NULL
      OR CAST(e.EffectiveDate AS DATE) <= @asOfDate
    )
    AND (e.TerminationDate IS NULL OR CAST(e.TerminationDate AS DATE) > @asOfDate)
  )`;
    }
    return '';
}

function bindAsOfDateParam(parts, ...requests) {
    const asOfDate = buildAsOfDateValue(parts || null);
    for (const r of requests) {
        if (!r || typeof r.input !== 'function') continue;
        r.input('asOfDate', sql.Date, asOfDate);
    }
}

module.exports = {
    parseEffectiveDateParts,
    buildEffectiveDateExistsSql,
    buildEffectiveDateExistsPredicate,
    bindEffectiveDateParams,
    resolveAsOfDateParts,
    buildEnrollmentStatusExistsSql,
    bindAsOfDateParam
};
