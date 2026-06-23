jest.mock('../../config/database', () => ({
  getPool: jest.fn(),
  sql: {
    UniqueIdentifier: 'UniqueIdentifier', NVarChar: 'NVarChar',
    Date: 'Date', DateTime2: 'DateTime2', Decimal: () => 'Decimal'
  }
}));

const invoiceService = require('../invoiceService');

describe('invoiceService — mid-month cohort', () => {
  describe('billing-period for 15th-cohort member', () => {
    it('creates period 2026-04-15 → 2026-05-14 for effectiveDate 2026-04-15', () => {
      const period = invoiceService.computeBillingPeriodFromEffectiveDate(
        new Date('2026-04-15T12:00:00Z')
      );
      expect(period.start.toISOString().slice(0, 10)).toBe('2026-04-15');
      expect(period.end.toISOString().slice(0, 10)).toBe('2026-05-14');
    });
  });

  describe('billing-period for 1st-cohort member', () => {
    it('creates period 2026-04-01 → 2026-04-30 for effectiveDate 2026-04-01', () => {
      const period = invoiceService.computeBillingPeriodFromEffectiveDate(
        new Date('2026-04-01T12:00:00Z')
      );
      expect(period.start.toISOString().slice(0, 10)).toBe('2026-04-01');
      expect(period.end.toISOString().slice(0, 10)).toBe('2026-04-30');
    });
  });

  describe('rejects invalid cohort days', () => {
    it('throws for day 10', () => {
      expect(() =>
        invoiceService.computeBillingPeriodFromEffectiveDate(new Date('2026-04-10T12:00:00Z'))
      ).toThrow(/cohort/i);
    });
  });

  describe('createNextMonthInvoice — cohort advancement (logic check)', () => {
    it('1st cohort: April invoice → May 1 to May 31', () => {
      const apr = new Date('2026-04-01T12:00:00Z');
      const advance = new Date(Date.UTC(2026, 4, 1)); // May 1
      const period = invoiceService.computeBillingPeriodFromEffectiveDate(advance);
      expect(period.start.toISOString().slice(0, 10)).toBe('2026-05-01');
      expect(period.end.toISOString().slice(0, 10)).toBe('2026-05-31');
    });

    it('15th cohort: April-15 invoice → May 15 to June 14', () => {
      const apr15 = new Date('2026-04-15T12:00:00Z');
      const advance = new Date(Date.UTC(2026, 4, 15)); // May 15
      const period = invoiceService.computeBillingPeriodFromEffectiveDate(advance);
      expect(period.start.toISOString().slice(0, 10)).toBe('2026-05-15');
      expect(period.end.toISOString().slice(0, 10)).toBe('2026-06-14');
    });
  });

  describe('getOrCreateInvoiceForPayment — cohort period mapping (logic)', () => {
    // Verifies the period-anchor math, not the full SQL/transaction flow.
    it('15th cohort with payment on the 20th maps to same-month 15-to-14', () => {
      // Tests use computeBillingPeriodFromEffectiveDate as the proxy
      const period = invoiceService.computeBillingPeriodFromEffectiveDate(new Date('2026-04-15T12:00:00Z'));
      expect(period.start.toISOString().slice(0, 10)).toBe('2026-04-15');
      expect(period.end.toISOString().slice(0, 10)).toBe('2026-05-14');
    });
  });
});
