'use strict';

const { handleCreditCardRefund } = require('../index');

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), success: jest.fn() };
}

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

// Real prod payload shape from webhook event 1133 (Cary Bryan, 2026-06-10):
// CC_DEBIT_REFUND carries parent_transaction_info_id (the original's INFO id),
// NOT the original's transaction_number.
const refundPayload = {
  transaction_type: 'CC',
  transaction_status: 'CC_DEBIT_REFUND',
  transaction_number: '1024259797',
  amount: '6.01',
  parent_transaction_info_id: '1292240374',
};

describe('handleCreditCardRefund', () => {
  it('skips when the refund was already recorded by the app (idempotency)', async () => {
    let inserted = false;
    const pool = makePool(async (sqlText) => {
      if (sqlText.includes("TransactionType = 'Refund'")) {
        return { recordset: [{ PaymentId: '04215427-F3AC-41A3-AB3B-3B854F724CCC' }] };
      }
      if (sqlText.includes('INSERT INTO oe.Payments')) {
        inserted = true;
        return { recordset: [] };
      }
      return { recordset: [] };
    });
    const logger = makeLogger();

    await handleCreditCardRefund(pool, refundPayload, 1133, logger);

    expect(inserted).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('already recorded'));
  });

  it('finds the original via ProcessorTransactionInfoId when parent_transaction_info_id is not a txn number', async () => {
    let lookupSql = null;
    let inserted = false;
    const pool = makePool(async (sqlText, inputs) => {
      if (sqlText.includes("TransactionType = 'Refund'")) {
        return { recordset: [] }; // no prior refund row
      }
      if (sqlText.includes("TransactionType = 'Payment'")) {
        lookupSql = sqlText;
        expect(inputs.processorTransactionId).toBe('1292240374');
        return {
          recordset: [{
            PaymentId: '82855778-1619-414A-BAAD-CEC734D2EE28',
            GroupId: null,
            TenantId: '1CD92AF7-B6F2-4E48-A8F3-EC6316158826',
            NetRate: 0, Commission: 0, OverrideRate: 0, SystemFees: 0,
          }],
        };
      }
      if (sqlText.includes('INSERT INTO oe.Payments')) {
        inserted = true;
        expect(inputs.amount).toBe(-6.01);
        expect(inputs.originalPaymentId).toBe('82855778-1619-414A-BAAD-CEC734D2EE28');
        return { recordset: [] };
      }
      return { recordset: [] };
    });

    await handleCreditCardRefund(pool, refundPayload, 1133, makeLogger());

    expect(inserted).toBe(true);
    expect(lookupSql).toContain('ProcessorTransactionInfoId');
  });

  it('still throws when the original payment is not found by either id', async () => {
    const pool = makePool(async () => ({ recordset: [] }));

    await expect(
      handleCreditCardRefund(pool, refundPayload, 1133, makeLogger())
    ).rejects.toThrow('Original payment not found: 1292240374');
  });
});
