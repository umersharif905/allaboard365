'use strict';

const {
  parseEligibilityImportDate,
  isValidSqlDate,
  toSqlDateOrNull,
} = require('../eligibilityImportDate');

describe('parseEligibilityImportDate', () => {
  test('parses M/d/yyyy (Align Plan Start style)', () => {
    const d = parseEligibilityImportDate('5/1/2026');
    expect(d).not.toBeNull();
    expect(d.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(isValidSqlDate(d)).toBe(true);
  });

  test('parses ISO date-only', () => {
    const d = parseEligibilityImportDate('2026-05-15');
    expect(d?.toISOString()).toBe('2026-05-15T00:00:00.000Z');
  });

  test('parses compact MMDDYYYY', () => {
    const d = parseEligibilityImportDate('05152026');
    expect(d?.toISOString()).toBe('2026-05-15T00:00:00.000Z');
  });

  test('parses ShareWELL Align Plan Start YYYYMMDD', () => {
    const d = parseEligibilityImportDate('20240501');
    expect(d?.toISOString()).toBe('2024-05-01T00:00:00.000Z');
  });

  test('parses Sharewell weekday display format', () => {
    const d = parseEligibilityImportDate('Thu May 01 2025');
    expect(d?.toISOString()).toBe('2025-05-01T00:00:00.000Z');
  });

  test('returns null for blank or whitespace (avoids sql.Date Invalid date)', () => {
    expect(parseEligibilityImportDate('')).toBeNull();
    expect(parseEligibilityImportDate('   ')).toBeNull();
    expect(parseEligibilityImportDate(null)).toBeNull();
    expect(parseEligibilityImportDate(undefined)).toBeNull();
  });

  test('returns null for garbage strings that Date.parse might mishandle', () => {
    expect(parseEligibilityImportDate('N/A')).toBeNull();
    expect(parseEligibilityImportDate('TBD')).toBeNull();
    expect(parseEligibilityImportDate('-')).toBeNull();
    expect(parseEligibilityImportDate('not-a-date')).toBeNull();
  });

  test('returns null for impossible calendar dates', () => {
    expect(parseEligibilityImportDate('2/30/2026')).toBeNull();
    expect(parseEligibilityImportDate('13/1/2026')).toBeNull();
  });

  test('legacy new Date(whitespace) would be invalid — parser stays safe', () => {
    const legacy = new Date('   ');
    expect(Number.isNaN(legacy.getTime())).toBe(true);
    expect(parseEligibilityImportDate('   ')).toBeNull();
    expect(toSqlDateOrNull(parseEligibilityImportDate('   '))).toBeNull();
  });
});

describe('toSqlDateOrNull', () => {
  test('rejects Invalid Date objects', () => {
    expect(toSqlDateOrNull(new Date('not valid'))).toBeNull();
    expect(toSqlDateOrNull(parseEligibilityImportDate('garbage'))).toBeNull();
  });

  test('accepts parsed import dates', () => {
    const d = parseEligibilityImportDate('6/2/2026');
    expect(toSqlDateOrNull(d)?.toISOString()).toBe('2026-06-02T00:00:00.000Z');
  });
});
