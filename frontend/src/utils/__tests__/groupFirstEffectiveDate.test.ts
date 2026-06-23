import { describe, expect, it } from 'vitest';
import {
  buildFirstEffectiveDateOptions,
  computeInitialEnrollmentPeriodFromFirstEffective,
  isValidFirstEffectiveDayOfMonth
} from '../groupFirstEffectiveDate';

describe('groupFirstEffectiveDate', () => {
  it('allows only 1st when mid-month is off', () => {
    expect(isValidFirstEffectiveDayOfMonth('2026-07-01', false)).toBe(true);
    expect(isValidFirstEffectiveDayOfMonth('2026-07-15', false)).toBe(false);
  });

  it('allows 1st and 15th when mid-month is on', () => {
    expect(isValidFirstEffectiveDayOfMonth('2026-07-15', true)).toBe(true);
    expect(isValidFirstEffectiveDayOfMonth('2026-07-10', true)).toBe(false);
  });

  it('builds sorted future options', () => {
    const options = buildFirstEffectiveDateOptions(false, 3, new Date(2026, 5, 4));
    expect(options[0]).toBe('2026-07-01');
    expect(options).not.toContain('2026-06-01');
  });

  it('computes enrollment period ending day before effective', () => {
    const period = computeInitialEnrollmentPeriodFromFirstEffective('2026-08-01', '2026-06-04');
    expect(period).toEqual({
      startDate: '2026-06-04',
      endDate: '2026-07-31',
      earliestEffectiveDate: '2026-08-01'
    });
  });
});
