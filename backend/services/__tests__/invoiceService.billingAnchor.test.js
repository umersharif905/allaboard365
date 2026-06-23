/**
 * Unit tests for unified household billing anchor period derivation
 * (anchorPeriodContainingReferenceDate + sameDayNextMonth clamps).
 */

const invoiceService = require('../invoiceService');

const { anchorPeriodContainingReferenceDate, sameDayNextMonth } = invoiceService;

function utcYmd(d) {
  const x = new Date(d);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
}

describe('invoiceService billing anchor helpers', () => {
  describe('sameDayNextMonth clamps to month length', () => {
    it('anchors day 31 to Jan 31 in January', () => {
      expect(utcYmd(sameDayNextMonth(31, 2026, 0))).toBe('2026-01-31');
    });
    it('anchors day 31 to Feb 28 in non-leap February', () => {
      expect(utcYmd(sameDayNextMonth(31, 2025, 1))).toBe('2025-02-28');
    });
    it('anchors day 31 to Feb 29 in leap February', () => {
      expect(utcYmd(sameDayNextMonth(31, 2024, 1))).toBe('2024-02-29');
    });
  });

  describe('anchorPeriodContainingReferenceDate (DOM anchor → anchor…EOM)', () => {
    const anchor = 25;

    it('uses current month window when ref is on anchor day UTC', () => {
      const { bpStart, bpEnd } = anchorPeriodContainingReferenceDate(anchor, '2026-04-25T00:00:00.000Z');
      expect(utcYmd(bpStart)).toBe('2026-04-25');
      expect(utcYmd(bpEnd)).toBe('2026-04-30');
    });

    it('uses current month window when ref is after anchor in same UTC month', () => {
      const { bpStart, bpEnd } = anchorPeriodContainingReferenceDate(anchor, '2026-04-30T23:59:59.999Z');
      expect(utcYmd(bpStart)).toBe('2026-04-25');
      expect(utcYmd(bpEnd)).toBe('2026-04-30');
    });

    it('rolls to previous anchored month when ref is before anchor in same UTC month', () => {
      const { bpStart, bpEnd } = anchorPeriodContainingReferenceDate(anchor, '2026-04-10T12:00:00.000Z');
      expect(utcYmd(bpStart)).toBe('2026-03-25');
      expect(utcYmd(bpEnd)).toBe('2026-03-31');
    });

    it('rolls from January correctly into previous December', () => {
      const { bpStart, bpEnd } = anchorPeriodContainingReferenceDate(anchor, '2026-01-05T00:00:00.000Z');
      expect(utcYmd(bpStart)).toBe('2025-12-25');
      expect(utcYmd(bpEnd)).toBe('2025-12-31');
    });

    it('when anchor is calendar 1st, reference on 15th stays in same month', () => {
      const { bpStart, bpEnd } = anchorPeriodContainingReferenceDate(1, '2026-04-15T00:00:00.000Z');
      expect(utcYmd(bpStart)).toBe('2026-04-01');
      expect(utcYmd(bpEnd)).toBe('2026-04-30');
    });

    it('when anchor is calendar 1st, reference last day stays in same month', () => {
      const { bpStart, bpEnd } = anchorPeriodContainingReferenceDate(1, '2026-04-30T00:00:00.000Z');
      expect(utcYmd(bpStart)).toBe('2026-04-01');
      expect(utcYmd(bpEnd)).toBe('2026-04-30');
    });

    it('DOM 31 in April: anchor month is Apr 30; ref Apr 29 uses March window', () => {
      const { bpStart, bpEnd } = anchorPeriodContainingReferenceDate(31, '2026-04-29T00:00:00.000Z');
      expect(utcYmd(bpStart)).toBe('2026-03-31');
      expect(utcYmd(bpEnd)).toBe('2026-03-31');
    });

    it('DOM 31 in April: ref Apr 30 uses April window (single-day period end)', () => {
      const { bpStart, bpEnd } = anchorPeriodContainingReferenceDate(31, '2026-04-30T00:00:00.000Z');
      expect(utcYmd(bpStart)).toBe('2026-04-30');
      expect(utcYmd(bpEnd)).toBe('2026-04-30');
    });
  });

  describe('getHouseholdBillingAnchor (fake sql pool)', () => {
    const hid = '11111111-1111-1111-1111-111111111111';

    it('returns anchorDate and anchorDay from query row', async () => {
      const pool = {
        request() {
          return {
            input: jest.fn().mockReturnThis(),
            query: jest.fn().mockResolvedValue({
              recordset: [{ EffectiveDate: new Date('2026-03-25T00:00:00.000Z') }]
            })
          };
        }
      };
      const r = await invoiceService.getHouseholdBillingAnchor(pool, hid);
      expect(r).not.toBeNull();
      expect(r.anchorDay).toBe(25);
      expect(utcYmd(r.anchorDate)).toBe('2026-03-25');
    });

    it('returns null when no matching enrollment', async () => {
      const pool = {
        request() {
          return {
            input: jest.fn().mockReturnThis(),
            query: jest.fn().mockResolvedValue({ recordset: [] })
          };
        }
      };
      const r = await invoiceService.getHouseholdBillingAnchor(pool, hid);
      expect(r).toBeNull();
    });
  });
});
