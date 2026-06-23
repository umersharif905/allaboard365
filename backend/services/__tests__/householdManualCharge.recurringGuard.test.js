'use strict';

/**
 * Scenario tests for shouldSyncRecurringAfterManualInvoicePayment — the guard
 * that decides whether a manual invoice payment may advance/skip the DIME
 * recurring schedule.
 *
 * Core rule: only sync when the paid invoice is the SAME cycle the schedule is
 * about to charge (schedule NextBillingDate ∈ [invoice period start, end]).
 * Overdue/back payments and pre-paid future invoices must NOT bump the schedule.
 */

jest.mock('../../config/database', () => ({ sql: {}, }));
jest.mock('../paymentDatabaseService', () => ({}));
jest.mock('../dimeService', () => ({}));
jest.mock('../encryptionService', () => ({}));
jest.mock('../../utils/achRouting', () => ({ resolveAchRoutingForCharge: jest.fn() }));
jest.mock('../../config/shared-modules', () => ({
  requireShared: () => ({ isSuccessfulPaymentRecordStatus: () => true }),
}));

const {
  shouldSyncRecurringAfterManualInvoicePayment,
} = require('../householdManualCharge.service');

describe('shouldSyncRecurringAfterManualInvoicePayment', () => {
  // ---------------------------------------------------------------------------
  // SHOULD sync — paid invoice IS the upcoming cycle
  // ---------------------------------------------------------------------------
  describe('advances recurring (sync = true)', () => {
    it('early pay of the current cycle (Major Burden case): schedule June 1, invoice Jun 1–30', () => {
      expect(
        shouldSyncRecurringAfterManualInvoicePayment({
          scheduleNextBillingDate: new Date('2026-06-01T00:00:00.000Z'),
          invoiceBillingPeriodStart: '2026-06-01',
          invoiceBillingPeriodEnd: '2026-06-30',
        })
      ).toBe(true);
    });

    it('behind a month, schedule still points at the unpaid cycle: schedule May 1, invoice May 1–31', () => {
      // Member is paying the cycle the schedule will charge → advance is correct.
      expect(
        shouldSyncRecurringAfterManualInvoicePayment({
          scheduleNextBillingDate: new Date('2026-05-01T00:00:00.000Z'),
          invoiceBillingPeriodStart: '2026-05-01',
          invoiceBillingPeriodEnd: '2026-05-31',
        })
      ).toBe(true);
    });

    it('15th cohort: schedule May 15, invoice May 15–Jun 14', () => {
      expect(
        shouldSyncRecurringAfterManualInvoicePayment({
          scheduleNextBillingDate: new Date('2026-05-15T00:00:00.000Z'),
          invoiceBillingPeriodStart: '2026-05-15',
          invoiceBillingPeriodEnd: '2026-06-14',
        })
      ).toBe(true);
    });

    it('falls back to end-of-month when invoice period end is missing: schedule Jun 1, invoice start Jun 1', () => {
      expect(
        shouldSyncRecurringAfterManualInvoicePayment({
          scheduleNextBillingDate: '2026-06-01',
          invoiceBillingPeriodStart: '2026-06-01',
          invoiceBillingPeriodEnd: null,
        })
      ).toBe(true);
    });

    it('tolerates time component / ISO strings (date-only comparison)', () => {
      expect(
        shouldSyncRecurringAfterManualInvoicePayment({
          scheduleNextBillingDate: '2026-06-30T23:59:59.000Z',
          invoiceBillingPeriodStart: '2026-06-01T00:00:00.000Z',
          invoiceBillingPeriodEnd: '2026-06-30T00:00:00.000Z',
        })
      ).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // SHOULD NOT sync — overdue / back payment (schedule already past this period)
  // ---------------------------------------------------------------------------
  describe('keeps recurring intact for overdue / back payments (sync = false)', () => {
    it('pays overdue May invoice while schedule already on June 1 → do NOT bump June', () => {
      expect(
        shouldSyncRecurringAfterManualInvoicePayment({
          scheduleNextBillingDate: new Date('2026-06-01T00:00:00.000Z'),
          invoiceBillingPeriodStart: '2026-05-01',
          invoiceBillingPeriodEnd: '2026-05-31',
        })
      ).toBe(false);
    });

    it('pays a months-old invoice (March) while schedule on June 1', () => {
      expect(
        shouldSyncRecurringAfterManualInvoicePayment({
          scheduleNextBillingDate: new Date('2026-06-01T00:00:00.000Z'),
          invoiceBillingPeriodStart: '2026-03-01',
          invoiceBillingPeriodEnd: '2026-03-31',
        })
      ).toBe(false);
    });

    it('15th cohort overdue: schedule Jun 15, invoice May 15–Jun 14', () => {
      expect(
        shouldSyncRecurringAfterManualInvoicePayment({
          scheduleNextBillingDate: new Date('2026-06-15T00:00:00.000Z'),
          invoiceBillingPeriodStart: '2026-05-15',
          invoiceBillingPeriodEnd: '2026-06-14',
        })
      ).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // SHOULD NOT sync — pre-paying a future invoice while a nearer charge is due
  // ---------------------------------------------------------------------------
  describe('keeps recurring intact when pre-paying a future cycle (sync = false)', () => {
    it('pays July invoice while schedule still on June 1 → June must still charge', () => {
      expect(
        shouldSyncRecurringAfterManualInvoicePayment({
          scheduleNextBillingDate: new Date('2026-06-01T00:00:00.000Z'),
          invoiceBillingPeriodStart: '2026-07-01',
          invoiceBillingPeriodEnd: '2026-07-31',
        })
      ).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Defensive: missing inputs → false (never touch recurring on ambiguity)
  // ---------------------------------------------------------------------------
  describe('defensive no-ops (sync = false)', () => {
    it('no active schedule (null next billing date)', () => {
      expect(
        shouldSyncRecurringAfterManualInvoicePayment({
          scheduleNextBillingDate: null,
          invoiceBillingPeriodStart: '2026-06-01',
          invoiceBillingPeriodEnd: '2026-06-30',
        })
      ).toBe(false);
    });

    it('no invoice billing period start', () => {
      expect(
        shouldSyncRecurringAfterManualInvoicePayment({
          scheduleNextBillingDate: '2026-06-01',
          invoiceBillingPeriodStart: null,
          invoiceBillingPeriodEnd: null,
        })
      ).toBe(false);
    });

    it('unparseable dates', () => {
      expect(
        shouldSyncRecurringAfterManualInvoicePayment({
          scheduleNextBillingDate: 'not-a-date',
          invoiceBillingPeriodStart: 'nope',
          invoiceBillingPeriodEnd: 'nope',
        })
      ).toBe(false);
    });

    it('called with no args', () => {
      expect(shouldSyncRecurringAfterManualInvoicePayment()).toBe(false);
    });
  });
});
