/**
 * @jest-environment node
 */

jest.mock('../../config/shared-modules', () => ({
  requireShared: (name) => {
    if (name === 'payment-status') {
      return {
        isSuccessfulPaymentRecordStatus: (s) =>
          ['Completed', 'succeeded', 'Success', 'SUCCESS', 'Paid', 'PAID'].includes(String(s))
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

const {
  getPaymentStatusInvoiceAdjustmentPlan,
  applyPaymentStatusInvoiceAdjustmentInTxn
} = require('../paymentAdminPatch.service');
const invoiceService = require('../invoiceService');
const invoiceSync = require('../invoiceSync.service');

describe('paymentAdminPatch.service', () => {
  const sql = require('mssql');
  const paymentId = '11111111-1111-1111-1111-111111111111';
  const invoiceId = '22222222-2222-2222-2222-222222222222';

  function mockPoolWithCommission(exists) {
    return {
      request() {
        return {
          input() {
            return this;
          },
          query: jest.fn(async () =>
            exists ? { recordset: [{ Ok: 1 }] } : { recordset: [] }
          )
        };
      }
    };
  }

  it('getPaymentStatusInvoiceAdjustmentPlan: updateInvoice off', async () => {
    const pool = mockPoolWithCommission(false);
    const row = {
      Status: 'Completed',
      InvoiceId: invoiceId,
      Amount: 50,
      TransactionType: 'Payment',
      OriginalPaymentId: null
    };
    const r = await getPaymentStatusInvoiceAdjustmentPlan(pool, sql, paymentId, row, 'Failed', false);
    expect(r.kind).toBeNull();
    expect(r.invoiceSync.applied).toBe(false);
    expect(r.invoiceSync.reason).toBe('update_invoice_off');
  });

  it('getPaymentStatusInvoiceAdjustmentPlan: success → fail yields unfulfill and commission warning when row exists', async () => {
    const pool = mockPoolWithCommission(true);
    const row = {
      Status: 'Completed',
      InvoiceId: invoiceId,
      Amount: 99,
      TransactionType: 'Payment',
      OriginalPaymentId: null
    };
    const r = await getPaymentStatusInvoiceAdjustmentPlan(pool, sql, paymentId, row, 'Failed', true);
    expect(r.kind).toBe('unfulfill');
    expect(r.invoiceSync.warnings).toEqual(['commission_may_remain']);
  });

  it('getPaymentStatusInvoiceAdjustmentPlan: fail → success yields sync', async () => {
    const pool = mockPoolWithCommission(false);
    const row = {
      Status: 'Failed',
      InvoiceId: invoiceId,
      Amount: 40,
      TransactionType: null,
      OriginalPaymentId: null
    };
    const r = await getPaymentStatusInvoiceAdjustmentPlan(pool, sql, paymentId, row, 'Completed', true);
    expect(r.kind).toBe('sync');
  });

  it('getPaymentStatusInvoiceAdjustmentPlan: Pending → Completed yields sync (audit timer path)', async () => {
    const pool = mockPoolWithCommission(false);
    const row = {
      Status: 'Pending',
      InvoiceId: invoiceId,
      Amount: 250,
      TransactionType: 'Payment',
      OriginalPaymentId: null,
    };
    const r = await getPaymentStatusInvoiceAdjustmentPlan(pool, sql, paymentId, row, 'Completed', true);
    expect(r.kind).toBe('sync');
  });

  it('getPaymentStatusInvoiceAdjustmentPlan: Pending → Pending yields no invoice change', async () => {
    const pool = mockPoolWithCommission(false);
    const row = {
      Status: 'Pending',
      InvoiceId: invoiceId,
      Amount: 250,
      TransactionType: 'Payment',
      OriginalPaymentId: null,
    };
    const r = await getPaymentStatusInvoiceAdjustmentPlan(pool, sql, paymentId, row, 'Pending', true);
    expect(r.kind).toBeNull();
    expect(r.invoiceSync.reason).toBe('no_success_state_change');
  });

  it('getPaymentStatusInvoiceAdjustmentPlan: Completed → Failed yields unfulfill (chargeback / decline after settle)', async () => {
    const pool = mockPoolWithCommission(false);
    const row = {
      Status: 'Completed',
      InvoiceId: invoiceId,
      Amount: 99,
      TransactionType: 'Payment',
      OriginalPaymentId: null,
    };
    const r = await getPaymentStatusInvoiceAdjustmentPlan(pool, sql, paymentId, row, 'Failed', true);
    expect(r.kind).toBe('unfulfill');
  });

  it('getPaymentStatusInvoiceAdjustmentPlan: skips refund-linked rows', async () => {
    const pool = mockPoolWithCommission(false);
    const row = {
      Status: 'Completed',
      InvoiceId: invoiceId,
      Amount: 40,
      TransactionType: 'Payment',
      OriginalPaymentId: '33333333-3333-3333-3333-333333333333'
    };
    const r = await getPaymentStatusInvoiceAdjustmentPlan(pool, sql, paymentId, row, 'Failed', true);
    expect(r.kind).toBeNull();
    expect(r.invoiceSync.reason).toBe('not_eligible_payment_row');
  });

  it('getPaymentStatusInvoiceAdjustmentPlan: skips when Refunded involved', async () => {
    const pool = mockPoolWithCommission(false);
    const row = {
      Status: 'Completed',
      InvoiceId: invoiceId,
      Amount: 40,
      TransactionType: 'Payment',
      OriginalPaymentId: null
    };
    const r = await getPaymentStatusInvoiceAdjustmentPlan(pool, sql, paymentId, row, 'Refunded', true);
    expect(r.kind).toBeNull();
    expect(r.invoiceSync.reason).toBe('refunded_status_excluded');
  });

  it('applyPaymentStatusInvoiceAdjustmentInTxn: unfulfill delegates to invoiceService.unfulfillInvoiceInTxn', async () => {
    const spy = jest.spyOn(invoiceService, 'unfulfillInvoiceInTxn').mockResolvedValue({
      applied: true,
      newPaidAmount: 1,
      invoiceStatus: 'Partial'
    });
    const tx = {
      request: jest.fn(() => ({
        input() {
          return this;
        },
        query: jest.fn()
      }))
    };
    const row = { InvoiceId: invoiceId, Amount: 55, Status: 'Completed' };
    const out = await applyPaymentStatusInvoiceAdjustmentInTxn(tx, sql, 'unfulfill', row, 'Failed');
    expect(out.applied).toBe(true);
    expect(spy).toHaveBeenCalledWith(tx, sql, invoiceId, 55);
    spy.mockRestore();
  });

  it('applyPaymentStatusInvoiceAdjustmentInTxn: sync delegates to syncInvoiceAfterPaymentStatusChangeInTxn', async () => {
    const spy = jest
      .spyOn(invoiceSync, 'syncInvoiceAfterPaymentStatusChangeInTxn')
      .mockResolvedValue({ applied: true, invoiceStatus: 'Paid' });
    const tx = {};
    const row = { InvoiceId: invoiceId, Amount: 10, Status: 'Failed' };
    await applyPaymentStatusInvoiceAdjustmentInTxn(tx, sql, 'sync', row, 'Completed');
    expect(spy).toHaveBeenCalledWith(tx, sql, {
      invoiceId,
      paymentAmount: 10,
      previousStatus: 'Failed',
      newStatus: 'Completed'
    });
    spy.mockRestore();
  });
});
