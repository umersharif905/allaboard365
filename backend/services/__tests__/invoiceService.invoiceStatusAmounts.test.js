/**
 * Credit-aware invoice Status vs PaidAmount/CreditAmount/TotalAmount
 * (fulfillInvoice, unfulfillInvoice, reconcileUnfulfilledInvoice) plus
 * syncInvoiceAfterPaymentStatusChange — mocked SQL pool only.
 */

jest.mock('../../config/database', () => {
  const sql = require('mssql');
  return {
    getPool: jest.fn(),
    sql,
    rawSql: {}
  };
});

jest.mock('../../config/shared-modules', () => ({
  requireShared: (name) => {
    if (name === 'payment-status') {
      return {
        isSuccessfulPaymentRecordStatus: (s) =>
          ['Completed', 'succeeded', 'Success'].includes(String(s))
      };
    }
    if (name === 'payment-product-snapshots') {
      return {
        resolveProcessingFeeTotalFromParts: (_included, remainder) => ({
          total: remainder,
          isLegacyFullPpfRow: false,
        }),
      };
    }
    throw new Error(`unexpected requireShared:${name}`);
  }
}));

jest.mock('../dimeService', () => ({}));

const invoiceService = require('../invoiceService');
const { getPool } = require('../../config/database');
const {
  fulfillInvoice,
  unfulfillInvoice
} = invoiceService;

const {
  syncInvoiceAfterPaymentStatusChange
} = require('../invoiceSync.service');

const sql = require('mssql');

const { recalcStatusFromAmounts } = require('../householdCredits.service');

function poolWithFulfillMocks(firstRow) {
  const updateInputs = [];
  let phase = 0;
  const pool = {
    request() {
      const inputs = {};
      return {
        input(k, ty, v) {
          inputs[k] = v;
          return this;
        },
        query: jest.fn(async () => {
          phase += 1;
          if (phase === 1) {
            return { recordset: [firstRow] };
          }
          updateInputs.push(inputs);
          return { rowsAffected: [1] };
        })
      };
    }
  };
  return { pool, updateInputs };
}

describe('credit-aware Individual invoice Status (mocked DB)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fulfillInvoice sets Paid when new paid + CreditAmount reaches TotalAmount', async () => {
    const invoiceId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const { pool, updateInputs } = poolWithFulfillMocks({
      TotalAmount: 100,
      PaidAmount: 40,
      CreditAmount: 70
    });
    getPool.mockResolvedValue(pool);

    const result = await fulfillInvoice(invoiceId, 10);

    expect(result.applied).toBe(true);
    expect(result.newPaidAmount).toBeCloseTo(50, 5);
    expect(result.invoiceStatus).toBe('Paid');
    expect(updateInputs.length).toBe(1);
    expect(updateInputs[0].paidAmount.toString()).toBe('50'); // Decimal serializes oddly
    expect(updateInputs[0].status).toBe('Paid');
  });

  it('fulfillInvoice sets Partial when paid + credits still leave a balance', async () => {
    const invoiceId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const { pool, updateInputs } = poolWithFulfillMocks({
      TotalAmount: 100,
      PaidAmount: 40,
      CreditAmount: 50
    });
    getPool.mockResolvedValue(pool);

    const result = await fulfillInvoice(invoiceId, 5);

    expect(result.invoiceStatus).toBe('Partial');
    expect(updateInputs[0].status).toBe('Partial');
  });

  it('unfulfillInvoice keeps Paid when refunds leave cash short but credits cover remainder', async () => {
    const invoiceId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const { pool, updateInputs } = poolWithFulfillMocks({
      TotalAmount: 600,
      PaidAmount: 450,
      CreditAmount: 400
    });
    getPool.mockResolvedValue(pool);

    const result = await unfulfillInvoice(invoiceId, 200);

    expect(result.invoiceStatus).toBe('Paid');
    expect(result.newPaidAmount).toBeCloseTo(250, 5);
    expect(updateInputs[0].status).toBe('Paid');
  });

  it('unfulfillInvoice sets Partial when refunded cash + credits no longer settle total', async () => {
    const invoiceId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const { pool, updateInputs } = poolWithFulfillMocks({
      TotalAmount: 600,
      PaidAmount: 400,
      CreditAmount: 50
    });
    getPool.mockResolvedValue(pool);

    const result = await unfulfillInvoice(invoiceId, 100);

    expect(result.invoiceStatus).toBe('Partial');
    expect(result.newPaidAmount).toBeCloseTo(300, 5);
    expect(updateInputs[0].status).toBe('Partial');
  });

  it('recalcStatusFromAmounts matches reconcile semantics after TotalAmount drops (paid+credit unchanged)', () => {
    expect(recalcStatusFromAmounts(400, 250, 200)).toBe('Paid');
    expect(recalcStatusFromAmounts(400, 200, 199)).toBe('Partial');
  });

  it('recalcStatusFromAmounts preserves Overdue for open invoices (Beckner Unpaid-label regression)', () => {
    // Amount-driven recalcs (payment status audit, webhooks, credit applies) must
    // not flip a past-due invoice back to Unpaid/Partial — that clobbered the
    // nightly overdue sweep 4x/day and members showed "Unpaid" while past due.
    expect(recalcStatusFromAmounts(389.72, 0, 0, 'Overdue')).toBe('Overdue');
    expect(recalcStatusFromAmounts(400, 100, 0, 'Overdue')).toBe('Overdue');
    // Fully covered still wins — Paid clears Overdue
    expect(recalcStatusFromAmounts(400, 400, 0, 'Overdue')).toBe('Paid');
    expect(recalcStatusFromAmounts(400, 250, 150, 'Overdue')).toBe('Paid');
    // Non-Overdue current statuses keep amount-driven semantics
    expect(recalcStatusFromAmounts(400, 0, 0, 'Unpaid')).toBe('Unpaid');
    expect(recalcStatusFromAmounts(400, 100, 0, 'Partial')).toBe('Partial');
    expect(recalcStatusFromAmounts(400, 0, 0)).toBe('Unpaid');
  });

  it('syncInvoiceAfterPaymentStatusChange sets Paid using CreditAmount after success flip', async () => {
    let phase = 0;
    const updateInputs = [];
    const fakePool = {
      request() {
        const inputs = {};
        return {
          input(k, ty, v) {
            inputs[k] = v;
            return this;
          },
          query: jest.fn(async () => {
            phase += 1;
            if (phase === 1) {
              return {
                recordset: [
                  {
                    TotalAmount: 100,
                    PaidAmount: 30,
                    CreditAmount: 50,
                    Status: 'Unpaid'
                  }
                ]
              };
            }
            updateInputs.push(inputs);
            return { rowsAffected: [1] };
          })
        };
      }
    };

    const invoiceId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    await syncInvoiceAfterPaymentStatusChange(fakePool, sql, {
      invoiceId,
      paymentAmount: 20,
      previousStatus: 'Pending',
      newStatus: 'Success'
    });

    expect(updateInputs.length).toBe(1);
    expect(updateInputs[0].paidAmount.toString()).toBe('50');
    expect(updateInputs[0].status).toBe('Paid');
  });
});
