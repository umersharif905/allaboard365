// backend/services/__tests__/invoiceService.characterization.test.js
// Pulls the pure helper functions into testable scope. If they're not already
// exported, export them (they're logic-only with no side effects).
const invoiceService = require('../invoiceService');

describe('invoiceService — characterization (current month-boundary helpers)', () => {
  describe('startOfMonth', () => {
    it('returns 1st of the UTC month for mid-month date', () => {
      const d = new Date('2026-04-15T12:00:00Z');
      const result = invoiceService.startOfMonth(d);
      expect(result.getUTCFullYear()).toBe(2026);
      expect(result.getUTCMonth()).toBe(3);
      expect(result.getUTCDate()).toBe(1);
    });
  });

  describe('endOfMonth', () => {
    it('returns last day of UTC month', () => {
      const d = new Date('2026-04-15T12:00:00Z');
      const result = invoiceService.endOfMonth(d);
      expect(result.getUTCDate()).toBe(30);
      expect(result.getUTCMonth()).toBe(3);
    });

    it('handles February correctly in non-leap year', () => {
      const d = new Date('2026-02-14T12:00:00Z');
      expect(invoiceService.endOfMonth(d).getUTCDate()).toBe(28);
    });

    it('handles February correctly in leap year', () => {
      const d = new Date('2028-02-14T12:00:00Z');
      expect(invoiceService.endOfMonth(d).getUTCDate()).toBe(29);
    });
  });

  describe('sameDayNextMonth', () => {
    it('preserves day-of-month across months', () => {
      const result = invoiceService.sameDayNextMonth(15, 2026, 4); // May 15 (month 0-indexed=4)
      expect(result.getUTCFullYear()).toBe(2026);
      expect(result.getUTCMonth()).toBe(4);
      expect(result.getUTCDate()).toBe(15);
    });

    it('clamps day 31 to last day of short month', () => {
      const result = invoiceService.sameDayNextMonth(31, 2026, 5); // June has 30 days
      expect(result.getUTCDate()).toBe(30);
    });
  });
});
