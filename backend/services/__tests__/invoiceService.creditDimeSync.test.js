'use strict';

jest.mock('../../config/database', () => ({
  getPool: jest.fn(),
  sql: {
    UniqueIdentifier: 'UniqueIdentifier',
    NVarChar: (n) => (typeof n === 'number' ? `NVarChar${n}` : 'NVarChar'),
    Date: 'Date',
    Decimal: () => 'Decimal',
  },
}));

const mockCancel = jest.fn();
const mockSetup = jest.fn();

jest.mock('../dimeService', () => ({
  cancelRecurringPayment: (...args) => mockCancel(...args),
  setupRecurringPayment: (...args) => mockSetup(...args),
}));

jest.mock('../../config/shared-modules', () => ({
  requireShared: (name) => {
    if (name === 'payment-status') {
      return { isSuccessfulPaymentRecordStatus: () => false };
    }
    if (name === 'payment-product-snapshots') {
      return { resolveProcessingFeeTotalFromParts: () => 0 };
    }
    throw new Error(`unexpected requireShared:${name}`);
  },
}));

jest.mock('../householdCredits.service', () => ({
  recalcStatusFromAmounts: jest.fn(),
  detectOverpayments: jest.fn(async () => ({ recognized: 0 })),
  applyAvailableCredits: jest.fn(async () => ({ applications: [] })),
}));

const { getPool } = require('../../config/database');
const {
  syncDimeRecurringForHousehold,
  addOneMonthUtc,
  isDimeRecurringSetupRejected,
} = require('../invoiceService');

const householdId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const tenantId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const invoiceId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function buildPool(handlers) {
  return {
    request() {
      const inputs = {};
      return {
        input(k, _ty, v) {
          inputs[k] = v;
          return this;
        },
        query: jest.fn(async (sql) => {
          const s = String(sql);
          for (const h of handlers) {
            const out = h(s, inputs);
            if (out !== undefined) return out;
          }
          return { recordset: [] };
        }),
      };
    },
  };
}

describe('invoiceService — credit-aware DIME sync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCancel.mockResolvedValue({ success: true });
    mockSetup.mockResolvedValue({ success: true, scheduleId: '999' });
  });

  describe('addOneMonthUtc', () => {
    it('advances June 1 to July 1', () => {
      const next = addOneMonthUtc(new Date('2026-06-01T00:00:00.000Z'));
      expect(next.getUTCMonth()).toBe(6);
      expect(next.getUTCDate()).toBe(1);
    });
  });

  describe('isDimeRecurringSetupRejected', () => {
    it('detects amount-related processor errors', () => {
      expect(isDimeRecurringSetupRejected({
        success: false,
        error: { message: 'Amount must be greater than zero', code: 'INVALID_AMOUNT' },
      })).toBe(true);
      expect(isDimeRecurringSetupRejected({ success: true })).toBe(false);
    });
  });

  describe('syncDimeRecurringForHousehold', () => {
    it('skip-cycle when BalanceDue is zero and enrollments are active', async () => {
      const pool = buildPool([
        (s) => {
          if (s.includes('FROM oe.Invoices') && s.includes('BalanceDue')) {
            return {
              recordset: [{
                TotalAmount: 659.12,
                PaidAmount: 0,
                CreditAmount: 659.12,
                BalanceDue: 0,
                DueDate: new Date('2026-07-01T00:00:00.000Z'),
                BillingPeriodStart: new Date('2026-07-01T00:00:00.000Z'),
              }],
            };
          }
          if (s.includes('MemberPaymentMethods')) {
            return {
              recordset: [{
                ProcessorCustomerId: 'cust-1',
                ProcessorPaymentMethodId: 'pm-1',
              }],
            };
          }
          if (s.includes('IndividualRecurringSchedules') && s.includes('IsActive = 1')) {
            return {
              recordset: [{
                DimeScheduleId: '926',
                MonthlyAmount: 659.12,
                NextBillingDate: new Date('2026-07-01T00:00:00.000Z'),
              }],
            };
          }
          if (s.includes('FROM oe.Enrollments e') && s.includes('TOP 1 1')) {
            return { recordset: [{ x: 1 }] };
          }
          if (s.includes('MERGE oe.IndividualRecurringSchedules')) {
            return { rowsAffected: [1] };
          }
          if (s.includes('EffectiveDate')) {
            return { recordset: [{ EffectiveDate: new Date('2026-01-01') }] };
          }
          return undefined;
        },
      ]);
      getPool.mockResolvedValue(pool);

      const synced = await syncDimeRecurringForHousehold(pool, householdId, tenantId, invoiceId);

      expect(synced).toBe(true);
      expect(mockCancel).toHaveBeenCalledWith('926', tenantId);
      expect(mockSetup).toHaveBeenCalled();
      const setupArg = mockSetup.mock.calls[0][0];
      expect(setupArg.amount).toBe(659.12);
      expect(setupArg.startDate.getUTCMonth()).toBe(7);
      expect(setupArg.startDate.getUTCDate()).toBe(1);
    });

    it('recreates schedule at reduced BalanceDue when partially credited', async () => {
      const pool = buildPool([
        (s) => {
          if (s.includes('FROM oe.Invoices') && s.includes('BalanceDue')) {
            return {
              recordset: [{
                TotalAmount: 659.12,
                PaidAmount: 0,
                CreditAmount: 78.44,
                BalanceDue: 580.68,
                DueDate: new Date('2026-07-01T00:00:00.000Z'),
                BillingPeriodStart: new Date('2026-07-01T00:00:00.000Z'),
              }],
            };
          }
          if (s.includes('MemberPaymentMethods')) {
            return {
              recordset: [{
                ProcessorCustomerId: 'cust-1',
                ProcessorPaymentMethodId: 'pm-1',
              }],
            };
          }
          if (s.includes('IndividualRecurringSchedules') && s.includes('IsActive = 1')) {
            return {
              recordset: [{
                DimeScheduleId: '100',
                MonthlyAmount: 659.12,
                NextBillingDate: new Date('2026-07-01T00:00:00.000Z'),
              }],
            };
          }
          if (s.includes('MERGE oe.IndividualRecurringSchedules')) {
            return { rowsAffected: [1] };
          }
          if (s.includes('EffectiveDate')) {
            return { recordset: [{ EffectiveDate: new Date('2026-01-01') }] };
          }
          return undefined;
        },
      ]);
      getPool.mockResolvedValue(pool);

      const synced = await syncDimeRecurringForHousehold(pool, householdId, tenantId, invoiceId);

      expect(synced).toBe(true);
      expect(mockSetup).toHaveBeenCalled();
      expect(mockSetup.mock.calls[0][0].amount).toBe(580.68);
    });

    it('uses full monthly enrollment total when invoice has partial payment but no credit', async () => {
      const pool = buildPool([
        (s) => {
          if (s.includes('FROM oe.Invoices') && s.includes('BalanceDue')) {
            return {
              recordset: [{
                TotalAmount: 659.12,
                PaidAmount: 658,
                CreditAmount: 0,
                BalanceDue: 1.12,
                DueDate: new Date('2026-07-01T00:00:00.000Z'),
                BillingPeriodStart: new Date('2026-07-01T00:00:00.000Z'),
              }],
            };
          }
          if (s.includes('SUM(COALESCE(e.PremiumAmount')) {
            return { recordset: [{ PremiumSum: 659.12 }] };
          }
          if (s.includes('MemberPaymentMethods')) {
            return {
              recordset: [{
                ProcessorCustomerId: 'cust-1',
                ProcessorPaymentMethodId: 'pm-1',
              }],
            };
          }
          if (s.includes('IndividualRecurringSchedules') && s.includes('IsActive = 1')) {
            return {
              recordset: [{
                DimeScheduleId: '100',
                MonthlyAmount: 1.12,
                NextBillingDate: new Date('2026-07-01T00:00:00.000Z'),
              }],
            };
          }
          if (s.includes('MERGE oe.IndividualRecurringSchedules')) {
            return { rowsAffected: [1] };
          }
          if (s.includes('EffectiveDate')) {
            return { recordset: [{ EffectiveDate: new Date('2026-01-01') }] };
          }
          return undefined;
        },
      ]);
      getPool.mockResolvedValue(pool);

      const synced = await syncDimeRecurringForHousehold(pool, householdId, tenantId, invoiceId);

      expect(synced).toBe(true);
      expect(mockSetup).toHaveBeenCalledTimes(1);
      expect(mockSetup.mock.calls[0][0].amount).toBe(659.12);
    });
  });
});
