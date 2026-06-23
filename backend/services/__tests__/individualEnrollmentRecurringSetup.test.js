const { computeRecurringStartDate } = require('../individualEnrollmentRecurringSetup');

describe('computeRecurringStartDate', () => {
  describe('flag OFF (existing behavior: effective date + 1 month)', () => {
    test('mid-year date rolls month', () => {
      expect(computeRecurringStartDate('2026-05-01', false)).toBe('2026-06-01');
    });

    test('December rolls to next January', () => {
      expect(computeRecurringStartDate('2026-12-15', false)).toBe('2027-01-15');
    });

    test('preserves day-of-month', () => {
      expect(computeRecurringStartDate('2026-03-29', false)).toBe('2026-04-29');
    });

    test('accepts a Date object', () => {
      expect(computeRecurringStartDate(new Date('2026-05-01T00:00:00Z'), false)).toBe('2026-06-01');
    });
  });

  describe('flag ON (new behavior: use effective date itself)', () => {
    test('returns effective date unchanged', () => {
      expect(computeRecurringStartDate('2026-05-01', true)).toBe('2026-05-01');
    });

    test('accepts a Date object', () => {
      expect(computeRecurringStartDate(new Date('2026-05-01T00:00:00Z'), true)).toBe('2026-05-01');
    });
  });
});
