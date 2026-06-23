'use strict';

const VendorExportService = require('../services/vendorExportService');

const MONTH_ABBR = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * UTC midnight Date from calendar parts (month 1–12).
 * @returns {Date|null}
 */
function partsToUtcDate(parts) {
  if (!parts) return null;
  const d = new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
  if (
    d.getUTCFullYear() !== parts.y
    || d.getUTCMonth() !== parts.m - 1
    || d.getUTCDate() !== parts.d
  ) {
    return null;
  }
  return d;
}

/**
 * Parse vendor eligibility CSV date strings for import (UTC calendar date).
 * Returns null for blank/invalid — never returns an Invalid Date.
 *
 * Supports M/d/yyyy, ISO date, MMDDYYYY, YYYYMMDD (ShareWELL Plan Start), and Sharewell "Mon May 01 2026" style.
 *
 * @param {string|number|null|undefined} value
 * @returns {Date|null}
 */
function parseEligibilityImportDate(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;

  const fromParts = partsToUtcDate(VendorExportService.parseEligibilityDateDisplayToParts(s));
  if (fromParts) return fromParts;

  // ShareWELL Align / full eligibility exports: Plan Start as YYYYMMDD (e.g. 20240501)
  const ymdCompact = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (ymdCompact) {
    const y = parseInt(ymdCompact[1], 10);
    const m = parseInt(ymdCompact[2], 10);
    const d = parseInt(ymdCompact[3], 10);
    const fromYmd = partsToUtcDate({ y, m, d });
    if (fromYmd) return fromYmd;
  }

  const sharewell = s.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})\b/);
  if (sharewell) {
    const mon = MONTH_ABBR[sharewell[1].toLowerCase()];
    if (mon != null) {
      return partsToUtcDate({ y: +sharewell[3], m: mon + 1, d: +sharewell[2] });
    }
  }

  return null;
}

/** True when value is safe to pass to mssql sql.Date. */
function isValidSqlDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * @param {Date|null|undefined} parsed
 * @returns {Date|null}
 */
function toSqlDateOrNull(parsed) {
  return isValidSqlDate(parsed) ? parsed : null;
}

module.exports = {
  parseEligibilityImportDate,
  isValidSqlDate,
  toSqlDateOrNull,
  partsToUtcDate,
};
