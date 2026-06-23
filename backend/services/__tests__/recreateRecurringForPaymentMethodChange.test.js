'use strict';

jest.mock('../../config/database', () => ({
  getPool: jest.fn(),
  sql: {
    UniqueIdentifier: 'UniqueIdentifier',
    NVarChar: (n) => (typeof n === 'number' ? `NVarChar${n}` : 'NVarChar'),
    Date: 'Date',
    DateTime2: 'DateTime2',
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

const {
  recreateRecurringForPaymentMethodChange,
  findOutstandingInvoiceForPaymentMethodPrompt,
  syncRecurringAfterPaymentMethodChange,
  computeFutureRecurringStartDateForPmChange,
  noonUtcOnBillingDom,
} = require('../invoiceService');

const householdId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const tenantId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const paymentMethodId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

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

describe('recreateRecurringForPaymentMethodChange', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCancel.mockResolvedValue({ success: true });
    mockSetup.mockResolvedValue({ success: true, scheduleId: 'new-schedule-1' });
  });

  describe('guard conditions', () => {
    it('1. group-billing household → skipped group_household', async () => {
      const pool = buildPool([
        (s) => {
          if (s.includes('RelationshipType') && s.includes('GroupId')) {
            return { recordset: [{ GroupId: 'gggggggg-gggg-gggg-gggg-gggggggggggg' }] };
          }
        },
      ]);
      const result = await recreateRecurringForPaymentMethodChange(pool, {
        householdId, tenantId, newPaymentMethodId: paymentMethodId,
      });
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('group_household');
      expect(mockSetup).not.toHaveBeenCalled();
    });

    it('2. no active schedule → skipped no_active_dime_schedule', async () => {
      const pool = buildPool([
        (s) => {
          if (s.includes('RelationshipType') && s.includes('GroupId')) return { recordset: [{ GroupId: null }] };
          if (s.includes('PaymentMethodId = @paymentMethodId')) {
            return {
              recordset: [{
                PaymentMethodId: paymentMethodId,
                IsDefault: 1,
                ProcessorCustomerId: 'cust-1',
                ProcessorPaymentMethodId: 'pm-99',
              }],
            };
          }
          if (s.includes('IndividualRecurringSchedules') && s.includes('IsActive = 1')) {
            return { recordset: [] };
          }
        },
      ]);
      const result = await recreateRecurringForPaymentMethodChange(pool, {
        householdId, tenantId, newPaymentMethodId: paymentMethodId,
      });
      expect(result.reason).toBe('no_active_dime_schedule');
      expect(mockSetup).not.toHaveBeenCalled();
    });

    it('3. not default PM → skipped', async () => {
      const pool = buildPool([
        (s) => {
          if (s.includes('RelationshipType') && s.includes('GroupId')) return { recordset: [{ GroupId: null }] };
          if (s.includes('PaymentMethodId = @paymentMethodId')) {
            return {
              recordset: [{
                PaymentMethodId: paymentMethodId,
                IsDefault: 0,
                ProcessorCustomerId: 'cust-1',
                ProcessorPaymentMethodId: 'pm-99',
              }],
            };
          }
        },
      ]);
      const result = await recreateRecurringForPaymentMethodChange(pool, {
        householdId, tenantId, newPaymentMethodId: paymentMethodId,
      });
      expect(result.reason).toBe('not_default_payment_method');
      expect(mockSetup).not.toHaveBeenCalled();
    });

    it('4. missing ProcessorPaymentMethodId → skipped unvaulted', async () => {
      const pool = buildPool([
        (s) => {
          if (s.includes('RelationshipType') && s.includes('GroupId')) return { recordset: [{ GroupId: null }] };
          if (s.includes('PaymentMethodId = @paymentMethodId')) {
            return {
              recordset: [{
                PaymentMethodId: paymentMethodId,
                IsDefault: 1,
                ProcessorCustomerId: 'cust-1',
                ProcessorPaymentMethodId: null,
              }],
            };
          }
        },
      ]);
      const result = await recreateRecurringForPaymentMethodChange(pool, {
        householdId, tenantId, newPaymentMethodId: paymentMethodId,
      });
      expect(result.reason).toBe('payment_method_not_vaulted');
      expect(mockSetup).not.toHaveBeenCalled();
    });

    it('5. missing ProcessorCustomerId → skipped', async () => {
      const pool = buildPool([
        (s) => {
          if (s.includes('RelationshipType') && s.includes('GroupId')) return { recordset: [{ GroupId: null }] };
          if (s.includes('PaymentMethodId = @paymentMethodId')) {
            return {
              recordset: [{
                PaymentMethodId: paymentMethodId,
                IsDefault: 1,
                ProcessorCustomerId: null,
                ProcessorPaymentMethodId: 'pm-99',
              }],
            };
          }
        },
      ]);
      const result = await recreateRecurringForPaymentMethodChange(pool, {
        householdId, tenantId, newPaymentMethodId: paymentMethodId,
      });
      expect(result.reason).toBe('payment_method_not_vaulted');
    });

    it('6. same processor PM id → idempotent same_payment_method', async () => {
      const pool = buildPool([
        (s) => {
          if (s.includes('RelationshipType') && s.includes('GroupId')) return { recordset: [{ GroupId: null }] };
          if (s.includes('PaymentMethodId = @paymentMethodId')) {
            return {
              recordset: [{
                PaymentMethodId: paymentMethodId,
                IsDefault: 1,
                ProcessorCustomerId: 'cust-1',
                ProcessorPaymentMethodId: 'pm-same',
              }],
            };
          }
        },
      ]);
      const result = await recreateRecurringForPaymentMethodChange(pool, {
        householdId,
        tenantId,
        newPaymentMethodId: paymentMethodId,
        previousProcessorPaymentMethodId: 'pm-same',
      });
      expect(result.reason).toBe('same_payment_method');
      expect(mockSetup).not.toHaveBeenCalled();
    });

    it('7. missing params → skipped missing_params', async () => {
      const pool = buildPool([]);
      const result = await recreateRecurringForPaymentMethodChange(pool, {
        householdId: null, tenantId, newPaymentMethodId: paymentMethodId,
      });
      expect(result.reason).toBe('missing_params');
    });

    it('8. zero schedule amount → skipped schedule_monthly_amount_zero', async () => {
      const pool = buildPool([
        (s) => {
          if (s.includes('RelationshipType') && s.includes('GroupId')) return { recordset: [{ GroupId: null }] };
          if (s.includes('PaymentMethodId = @paymentMethodId')) {
            return {
              recordset: [{
                PaymentMethodId: paymentMethodId,
                IsDefault: 1,
                ProcessorCustomerId: 'cust-1',
                ProcessorPaymentMethodId: 'pm-new',
              }],
            };
          }
          if (s.includes('IndividualRecurringSchedules') && s.includes('IsActive = 1')) {
            return {
              recordset: [{ DimeScheduleId: 'old-1', MonthlyAmount: 0, NextBillingDate: new Date('2026-08-01T12:00:00.000Z') }],
            };
          }
        },
      ]);
      const result = await recreateRecurringForPaymentMethodChange(pool, {
        householdId, tenantId, newPaymentMethodId: paymentMethodId,
      });
      expect(result.reason).toBe('schedule_monthly_amount_zero');
      expect(mockSetup).not.toHaveBeenCalled();
    });
  });

  describe('start-date computation', () => {
    it('9. future NextBillingDate preserved', () => {
      const future = new Date('2099-06-15T12:00:00.000Z');
      const picked = computeFutureRecurringStartDateForPmChange(future, 15);
      expect(picked.toISOString()).toBe(future.toISOString());
    });

    it('10. past NextBillingDate rolls to next anchor after now', () => {
      const past = new Date('2020-01-01T12:00:00.000Z');
      const nowMs = Date.UTC(2026, 5, 9, 18, 0, 0);
      const picked = computeFutureRecurringStartDateForPmChange(past, 15, nowMs);
      expect(picked.getTime()).toBeGreaterThan(nowMs);
      expect(picked.getUTCDate()).toBe(15);
    });

    it('11. anchor day 31 clamps in short month', () => {
      const d = noonUtcOnBillingDom(2026, 1, 31);
      expect(d.getUTCMonth()).toBe(1);
      expect(d.getUTCDate()).toBe(28);
    });

    it('12. anchor occurrence today-but-passed rolls forward', () => {
      const nowMs = Date.UTC(2026, 5, 15, 18, 0, 0);
      const picked = computeFutureRecurringStartDateForPmChange(null, 15, nowMs);
      expect(picked.getTime()).toBeGreaterThan(nowMs);
      expect(picked.getUTCMonth()).toBe(6);
      expect(picked.getUTCDate()).toBe(15);
    });

    it('13. null NextBillingDate falls back without throw', () => {
      expect(() => computeFutureRecurringStartDateForPmChange(null, 1)).not.toThrow();
      const picked = computeFutureRecurringStartDateForPmChange(null, 1, Date.UTC(2026, 5, 9));
      expect(picked).toBeTruthy();
    });

    it('14. computed date is noon UTC', () => {
      const picked = computeFutureRecurringStartDateForPmChange(null, 5, Date.UTC(2026, 5, 9));
      expect(picked.getUTCHours()).toBe(12);
      expect(picked.getUTCMinutes()).toBe(0);
    });
  });

  describe('create-then-cancel orchestration', () => {
    function happyPool(schedules = [{ DimeScheduleId: 'old-1', MonthlyAmount: 120, NextBillingDate: new Date('2099-07-01T12:00:00.000Z') }]) {
      return buildPool([
        (s) => {
          if (s.includes('RelationshipType') && s.includes('GroupId')) return { recordset: [{ GroupId: null }] };
          if (s.includes('PaymentMethodId = @paymentMethodId')) {
            return {
              recordset: [{
                PaymentMethodId: paymentMethodId,
                IsDefault: 1,
                ProcessorCustomerId: 'cust-1',
                ProcessorPaymentMethodId: 'pm-new',
              }],
            };
          }
          if (s.includes('IndividualRecurringSchedules') && s.includes('IsActive = 1')) {
            return { recordset: schedules };
          }
          if (s.includes('FROM oe.Enrollments') && s.includes('EffectiveDate')) {
            return { recordset: [{ EffectiveDate: new Date('2026-01-15T12:00:00.000Z') }] };
          }
        },
      ]);
    }

    it('15. happy path create → cancel → DB bookkeeping', async () => {
      const pool = happyPool();
      const result = await recreateRecurringForPaymentMethodChange(pool, {
        householdId, tenantId, newPaymentMethodId: paymentMethodId,
      });
      expect(result.recurringRecreated).toBe(true);
      expect(result.newRecurringStartDate).toBeTruthy();
      expect(mockSetup).toHaveBeenCalledTimes(1);
      expect(mockSetup.mock.calls[0][0].paymentMethodId).toBe('pm-new');
      expect(mockSetup.mock.calls[0][0].amount).toBe(120);
      expect(mockCancel).toHaveBeenCalledWith('old-1', tenantId);
    });

    it('16. create fails → old schedule untouched', async () => {
      mockSetup.mockResolvedValueOnce({ success: false, error: { message: 'DIME down' } });
      const pool = happyPool();
      const result = await recreateRecurringForPaymentMethodChange(pool, {
        householdId, tenantId, newPaymentMethodId: paymentMethodId,
      });
      expect(result.recurringRecreated).toBe(false);
      expect(result.recurringWarning).toMatch(/DIME down/i);
      expect(mockCancel).not.toHaveBeenCalled();
    });

    it('17. create succeeds, cancel fails → duplicateRecurringRisk', async () => {
      mockCancel.mockResolvedValueOnce({ success: false, error: { message: 'cancel failed' } });
      const pool = happyPool();
      const result = await recreateRecurringForPaymentMethodChange(pool, {
        householdId, tenantId, newPaymentMethodId: paymentMethodId,
      });
      expect(result.recurringRecreated).toBe(true);
      expect(result.duplicateRecurringRisk).toBe(true);
    });

    it('19. amount preserved from schedule row', async () => {
      const pool = happyPool([{ DimeScheduleId: 'old-1', MonthlyAmount: 87.43, NextBillingDate: new Date('2099-07-01T12:00:00.000Z') }]);
      await recreateRecurringForPaymentMethodChange(pool, {
        householdId, tenantId, newPaymentMethodId: paymentMethodId,
      });
      expect(mockSetup.mock.calls[0][0].amount).toBe(87.43);
    });

    it('20. dual active schedules → two create + two cancel', async () => {
      const pool = happyPool([
        { DimeScheduleId: 'old-1', MonthlyAmount: 50, NextBillingDate: new Date('2099-07-01T12:00:00.000Z') },
        { DimeScheduleId: 'old-2', MonthlyAmount: 75, NextBillingDate: new Date('2099-08-01T12:00:00.000Z') },
      ]);
      mockSetup
        .mockResolvedValueOnce({ success: true, scheduleId: 'new-1' })
        .mockResolvedValueOnce({ success: true, scheduleId: 'new-2' });
      const result = await recreateRecurringForPaymentMethodChange(pool, {
        householdId, tenantId, newPaymentMethodId: paymentMethodId,
      });
      expect(result.recurringRecreated).toBe(true);
      expect(mockSetup).toHaveBeenCalledTimes(2);
      expect(mockCancel).toHaveBeenCalledTimes(2);
      expect(mockSetup.mock.calls[0][0].amount).toBe(50);
      expect(mockSetup.mock.calls[1][0].amount).toBe(75);
    });

    it('21. dual schedules with zero amount → skip entire recreation', async () => {
      const pool = happyPool([
        { DimeScheduleId: 'old-1', MonthlyAmount: 50, NextBillingDate: new Date('2099-07-01T12:00:00.000Z') },
        { DimeScheduleId: 'old-2', MonthlyAmount: 0, NextBillingDate: new Date('2099-08-01T12:00:00.000Z') },
      ]);
      const result = await recreateRecurringForPaymentMethodChange(pool, {
        householdId, tenantId, newPaymentMethodId: paymentMethodId,
      });
      expect(result.reason).toBe('schedule_monthly_amount_zero');
      expect(mockSetup).not.toHaveBeenCalled();
    });
  });

  describe('outstanding-invoice detection', () => {
    it('22. unpaid invoice with no payments → returned', async () => {
      const pool = buildPool([
        (s) => {
          if (s.includes('RelationshipType') && s.includes('GroupId')) return { recordset: [{ GroupId: null }] };
          if (s.includes('FROM oe.Invoices')) {
            return {
              recordset: [{
                InvoiceId: 'inv-1',
                InvoiceNumber: 'INV-100',
                BillingPeriodStart: new Date('2026-06-01'),
                BillingPeriodEnd: new Date('2026-06-30'),
                BalanceDue: 120,
                Status: 'Unpaid',
              }],
            };
          }
        },
      ]);
      const row = await findOutstandingInvoiceForPaymentMethodPrompt(pool, householdId);
      expect(row.invoiceId).toBe('inv-1');
      expect(row.balanceDue).toBe(120);
    });

    it('25. pending payment attached → not returned', async () => {
      const pool = buildPool([
        (s) => {
          if (s.includes('RelationshipType') && s.includes('GroupId')) return { recordset: [{ GroupId: null }] };
          if (s.includes('FROM oe.Invoices')) return { recordset: [] };
        },
      ]);
      const row = await findOutstandingInvoiceForPaymentMethodPrompt(pool, householdId);
      expect(row).toBeNull();
    });

    it('29. group household → never returned', async () => {
      const pool = buildPool([
        (s) => {
          if (s.includes('RelationshipType') && s.includes('GroupId')) {
            return { recordset: [{ GroupId: 'gggggggg-gggg-gggg-gggg-gggggggggggg' }] };
          }
        },
      ]);
      const row = await findOutstandingInvoiceForPaymentMethodPrompt(pool, householdId);
      expect(row).toBeNull();
    });
  });

  describe('syncRecurringAfterPaymentMethodChange', () => {
    it('31. recreation throw does not bubble', async () => {
      const pool = {
        request() {
          return {
            input() { return this; },
            query: jest.fn(async () => { throw new Error('db exploded'); }),
          };
        },
      };
      const result = await syncRecurringAfterPaymentMethodChange(pool, {
        householdId, tenantId, newPaymentMethodId: paymentMethodId,
      });
      expect(result.recurringRecreated).toBe(false);
      expect(result.recurringWarning).toMatch(/db exploded/i);
    });
  });
});
