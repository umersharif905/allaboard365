'use strict';

const {
  syncInvoiceStatusAfterRecurringPaymentFailure,
  isInvoiceCoveredByOtherSettledPayments,
} = require('../index');

const invoiceId = '33333333-3333-4333-8333-333333333333';

const mockSql = {
  UniqueIdentifier: 'UniqueIdentifier',
  NVarChar: (len) => `NVarChar(${len})`,
};

function makePool(queryImpl) {
  return {
    request() {
      const inputs = {};
      return {
        input(name, _type, val) {
          inputs[name] = val;
          return this;
        },
        query: async (sqlText) => queryImpl(sqlText, inputs),
      };
    },
  };
}

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

describe('syncInvoiceStatusAfterRecurringPaymentFailure', () => {
  it('skips when invoice is already Paid with full coverage', async () => {
    const pool = makePool(async () => ({
      recordset: [{ TotalAmount: 1830.91, PaidAmount: 1830.91, CreditAmount: 0, Status: 'Paid' }],
    }));
    const logger = makeLogger();

    const result = await syncInvoiceStatusAfterRecurringPaymentFailure(pool, mockSql, invoiceId, logger);

    expect(result).toEqual({ applied: false, reason: 'already_covered' });
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('skip failure status downgrade'));
  });

  it('skips when PaidAmount + Credit covers total even if status is stale', async () => {
    const pool = makePool(async (sqlText) => {
      if (sqlText.includes('UPDATE oe.Invoices')) throw new Error('should not update');
      return {
        recordset: [{ TotalAmount: 500, PaidAmount: 500, CreditAmount: 0, Status: 'Unpaid' }],
      };
    });
    const logger = makeLogger();

    const result = await syncInvoiceStatusAfterRecurringPaymentFailure(pool, mockSql, invoiceId, logger);

    expect(result).toEqual({ applied: false, reason: 'already_covered' });
  });

  it('sets Partial when partially covered', async () => {
    let updateInputs = null;
    const pool = makePool(async (sqlText, inputs) => {
      if (sqlText.includes('UPDATE oe.Invoices')) {
        updateInputs = inputs;
        return { recordset: [] };
      }
      return {
        recordset: [{ TotalAmount: 500, PaidAmount: 200, CreditAmount: 0, Status: 'Unpaid' }],
      };
    });
    const logger = makeLogger();

    const result = await syncInvoiceStatusAfterRecurringPaymentFailure(pool, mockSql, invoiceId, logger);

    expect(result).toEqual({ applied: true, invoiceStatus: 'Partial' });
    expect(updateInputs.status).toBe('Partial');
  });

  it('sets Unpaid when nothing is covered', async () => {
    let updateInputs = null;
    const pool = makePool(async (sqlText, inputs) => {
      if (sqlText.includes('UPDATE oe.Invoices')) {
        updateInputs = inputs;
        return { recordset: [] };
      }
      return {
        recordset: [{ TotalAmount: 500, PaidAmount: 0, CreditAmount: 0, Status: 'Unpaid' }],
      };
    });
    const logger = makeLogger();

    const result = await syncInvoiceStatusAfterRecurringPaymentFailure(pool, mockSql, invoiceId, logger);

    expect(result).toEqual({ applied: true, invoiceStatus: 'Unpaid' });
    expect(updateInputs.status).toBe('Unpaid');
  });
});

describe('isInvoiceCoveredByOtherSettledPayments', () => {
  it('returns true when another completed payment covers the invoice', async () => {
    const pool = makePool(async (sqlText, inputs) => {
      if (sqlText.includes('FROM oe.Invoices')) {
        return { recordset: [{ TotalAmount: 1830.91, CreditAmount: 0 }] };
      }
      const rows = [
        { Amount: 1830.91, Status: 'Completed', ProcessorTransactionId: '958439110' },
        { Amount: 1830.91, Status: 'Failed', ProcessorTransactionId: 'retry-2' },
      ];
      if (sqlText.includes('FROM oe.Payments')) {
        const exclude = inputs.excludeTxn;
        const filtered = exclude
          ? rows.filter((r) => String(r.ProcessorTransactionId).trim() !== String(exclude).trim())
          : rows;
        return { recordset: filtered };
      }
      return { recordset: [] };
    });

    const covered = await isInvoiceCoveredByOtherSettledPayments(pool, mockSql, invoiceId, 'retry-2');
    expect(covered).toBe(true);
  });

  it('returns false for premature-paid (only same-txn completed row)', async () => {
    const pool = makePool(async (sqlText, inputs) => {
      if (sqlText.includes('FROM oe.Invoices')) {
        return { recordset: [{ TotalAmount: 500, CreditAmount: 0 }] };
      }
      const rows = [{ Amount: 500, Status: 'Completed', ProcessorTransactionId: 'txn-same' }];
      if (sqlText.includes('FROM oe.Payments')) {
        const exclude = inputs.excludeTxn;
        const filtered = exclude
          ? rows.filter((r) => String(r.ProcessorTransactionId).trim() !== String(exclude).trim())
          : rows;
        return { recordset: filtered };
      }
      return { recordset: [] };
    });

    const covered = await isInvoiceCoveredByOtherSettledPayments(pool, mockSql, invoiceId, 'txn-same');
    expect(covered).toBe(false);
  });
});
