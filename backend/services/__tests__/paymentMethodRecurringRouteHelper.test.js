'use strict';

jest.mock('../../config/database', () => ({
  sql: { UniqueIdentifier: 'UniqueIdentifier' },
}));

const mockSync = jest.fn();

jest.mock('../invoiceService', () => ({
  syncRecurringAfterPaymentMethodChange: (...args) => mockSync(...args),
}));

const {
  fetchPreviousDefaultProcessorPmId,
  runPaymentMethodRecurringSync,
} = require('../paymentMethodRecurringRouteHelper');

function buildPool(recordset) {
  return {
    request() {
      return {
        input() { return this; },
        query: jest.fn(async () => ({ recordset })),
      };
    },
  };
}

describe('paymentMethodRecurringRouteHelper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSync.mockResolvedValue({
      recurringRecreated: true,
      outstandingInvoice: { invoiceId: 'inv-1', balanceDue: 50 },
    });
  });

  it('fetchPreviousDefaultProcessorPmId returns trimmed processor id', async () => {
    const pool = buildPool([{ ProcessorPaymentMethodId: '  pm-42  ' }]);
    const id = await fetchPreviousDefaultProcessorPmId(pool, 'member-id');
    expect(id).toBe('pm-42');
  });

  it('runPaymentMethodRecurringSync delegates to invoiceService', async () => {
    const pool = buildPool([]);
    const out = await runPaymentMethodRecurringSync(pool, {
      householdId: 'hh',
      tenantId: 'ten',
      paymentMethodId: 'pm',
      previousProcessorPaymentMethodId: 'old',
    });
    expect(mockSync).toHaveBeenCalledWith(pool, {
      householdId: 'hh',
      tenantId: 'ten',
      newPaymentMethodId: 'pm',
      previousProcessorPaymentMethodId: 'old',
      forceRecreate: false,
    });
    expect(out.outstandingInvoice.invoiceId).toBe('inv-1');
  });

  it('runPaymentMethodRecurringSync no-ops without householdId', async () => {
    const pool = buildPool([]);
    const out = await runPaymentMethodRecurringSync(pool, { tenantId: 'ten', paymentMethodId: 'pm' });
    expect(out).toEqual({});
    expect(mockSync).not.toHaveBeenCalled();
  });
});
