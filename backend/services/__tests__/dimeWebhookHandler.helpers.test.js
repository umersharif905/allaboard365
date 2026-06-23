'use strict';

/**
 * DIME webhook handler helpers (oe_payment_manager) — pending charge / failure history.
 * Run: cd backend && npx jest dimeWebhookHandler.helpers
 */

const mockUnfulfillInvoiceForPaymentAmount = jest.fn();

jest.mock('../../../oe_payment_manager/shared/invoicePaymentTxn', () => ({
  ...jest.requireActual('../../../oe_payment_manager/shared/invoicePaymentTxn'),
  unfulfillInvoiceForPaymentAmount: (...args) => mockUnfulfillInvoiceForPaymentAmount(...args),
}));

const webhook = require('../../../oe_payment_manager/DimeWebhookHandler/index.js');

const {
  storedFailureReasonForNonSuccessfulChargeWebhook,
  findOpenCreditCardPaymentRow,
  lookupOriginalPaymentIdForNewCharge,
  syncInvoiceForUnsettledPayment,
  resolveProcessorTransactionIdFromWebhookData,
  resolveDimeTransactionInfoId,
  buildAchReturnOriginalLookupRefs,
  findOriginalPaymentForBounce,
  replayStoredPaymentWebhook,
} = webhook;

const tenantId = '11111111-1111-4111-8111-111111111111';
const groupId = '22222222-2222-4222-8222-222222222222';
const invoiceId = '33333333-3333-4333-8333-333333333333';
const failedPaymentId = '44444444-4444-4444-8444-444444444444';
const householdId = '55555555-5555-4555-8555-555555555555';
const originalPaymentId = '66666666-6666-4666-8666-666666666666';

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

beforeEach(() => {
  mockUnfulfillInvoiceForPaymentAmount.mockReset();
  mockUnfulfillInvoiceForPaymentAmount.mockResolvedValue({ applied: true });
});

describe('dimeWebhookHandler helpers', () => {
  describe('storedFailureReasonForNonSuccessfulChargeWebhook', () => {
    it('returns null for Pending even when transaction_status is CC_CREDIT', () => {
      expect(
        storedFailureReasonForNonSuccessfulChargeWebhook(
          { transaction_status: 'CC_CREDIT', pending: true },
          'Pending'
        )
      ).toBeNull();
    });

    it('returns formatted reason for Failed declines', () => {
      const reason = storedFailureReasonForNonSuccessfulChargeWebhook(
        { status_code: '05', status_text: 'DECLINE' },
        'Failed'
      );
      expect(reason).toContain('05');
    });
  });

  describe('resolveProcessorTransactionIdFromWebhookData', () => {
    it('returns null when recurring_payment_failed has no txn id (await charge webhook)', () => {
      expect(resolveProcessorTransactionIdFromWebhookData({ amount: '100' })).toBeNull();
      expect(resolveProcessorTransactionIdFromWebhookData({ transaction_number: '  ' })).toBeNull();
    });

    it('reads transaction_number snake or camel case', () => {
      expect(resolveProcessorTransactionIdFromWebhookData({ transaction_number: '956451900' })).toBe(
        '956451900'
      );
      expect(resolveProcessorTransactionIdFromWebhookData({ transactionNumber: 'tx-1' })).toBe('tx-1');
    });
  });

  describe('findOpenCreditCardPaymentRow', () => {
    it('with new processor txn id, only matches Pending rows (preserves Failed history)', async () => {
      let capturedSql = '';
      const pool = makePool(async (sqlText) => {
        capturedSql = sqlText;
        return { recordset: [] };
      });

      await findOpenCreditCardPaymentRow(pool, {
        tenantId,
        groupId,
        amount: 500,
        invoiceId,
        processorTransactionId: 'tx_new_999',
      });

      expect(capturedSql).toMatch(/Status = N'Pending'/);
      expect(capturedSql).not.toMatch(/Status IN \(N'Pending', N'Failed'\)/);
    });

    it('without processor txn id, may match Pending or Failed open rows', async () => {
      let capturedSql = '';
      const pool = makePool(async (sqlText) => {
        capturedSql = sqlText;
        return { recordset: [{ PaymentId: 'open-1' }] };
      });

      const row = await findOpenCreditCardPaymentRow(pool, {
        tenantId,
        groupId,
        amount: 500,
        invoiceId,
      });

      expect(capturedSql).toMatch(/Status IN \(N'Pending', N'Failed'\)/);
      expect(row?.PaymentId).toBe('open-1');
    });
  });

  describe('lookupOriginalPaymentIdForNewCharge', () => {
    it('returns most recent Failed payment id for same invoice + amount', async () => {
      const pool = makePool(async () => ({
        recordset: [{ PaymentId: failedPaymentId }],
      }));

      const linked = await lookupOriginalPaymentIdForNewCharge(pool, {
        tenantId,
        groupId,
        invoiceId,
        amount: 500,
      });

      expect(linked).toBe(failedPaymentId);
    });
  });

  describe('resolveDimeTransactionInfoId', () => {
    it('reads transaction_info_id and ignores blanks', () => {
      expect(resolveDimeTransactionInfoId({ transaction_info_id: '1280259894' })).toBe('1280259894');
      expect(resolveDimeTransactionInfoId({ transaction_info_id: '  ' })).toBeNull();
      expect(resolveDimeTransactionInfoId({})).toBeNull();
    });
  });

  describe('buildAchReturnOriginalLookupRefs', () => {
    it('prefers transaction_number before parent_transaction_info_id for ProcessorTransactionId lookup', () => {
      const darceyReturn = {
        transaction_number: '778',
        parent_transaction_info_id: '1280259894',
      };
      expect(buildAchReturnOriginalLookupRefs(darceyReturn)).toEqual({
        refs: ['778'],
        parentInfoId: '1280259894',
      });
    });
  });

  describe('findOriginalPaymentForBounce', () => {
    it('finds original by ProcessorTransactionId when parent_info_id is a different id space', async () => {
      let queryCount = 0;
      const pool = makePool(async (sqlText, inputs) => {
        queryCount += 1;
        if (sqlText.includes('ProcessorTransactionId') && inputs.ref === '778') {
          return {
            recordset: [
              {
                PaymentId: originalPaymentId,
                GroupId: groupId,
                TenantId: tenantId,
                AgentId: null,
                NetRate: 0,
                Commission: 0,
                OverrideRate: 0,
                SystemFees: 0,
                ProcessorTransactionId: '778',
              },
            ],
          };
        }
        return { recordset: [] };
      });

      const result = await findOriginalPaymentForBounce(pool, {
        transactionNumber: '778',
        parentTransactionInfoId: '1280259894',
        amount: 799,
      });

      expect(result?.matchedBy).toBe('processorTransactionId');
      expect(result?.payment?.PaymentId).toBe(originalPaymentId);
      expect(queryCount).toBe(1);
    });

    it('falls back to ProcessorTransactionInfoId when transaction_number misses', async () => {
      const pool = makePool(async (sqlText, inputs) => {
        if (sqlText.includes('ProcessorTransactionInfoId') && inputs.infoId === '1280259894') {
          return {
            recordset: [
              {
                PaymentId: originalPaymentId,
                ProcessorTransactionId: '778',
              },
            ],
          };
        }
        return { recordset: [] };
      });

      const result = await findOriginalPaymentForBounce(pool, {
        transactionNumber: '778',
        parentTransactionInfoId: '1280259894',
        amount: 799,
      });

      expect(result?.matchedBy).toBe('processorTransactionInfoId');
      expect(result?.payment?.ProcessorTransactionId).toBe('778');
    });

    it('falls back to household + amount via customer_uuid', async () => {
      const pool = makePool(async (sqlText, inputs) => {
        if (sqlText.includes('FROM oe.Members')) {
          return { recordset: [{ HouseholdId: householdId }] };
        }
        if (sqlText.includes('HouseholdId = @householdId')) {
          return {
            recordset: [
              {
                PaymentId: originalPaymentId,
                ProcessorTransactionId: '707',
              },
            ],
          };
        }
        return { recordset: [] };
      });

      const result = await findOriginalPaymentForBounce(pool, {
        transactionNumber: '778',
        parentTransactionInfoId: '1280259894',
        customerUuid: '423b27d4-e25b-4538-bbec-ba4a4a3650f0',
        amount: 799,
      });

      expect(result?.matchedBy).toBe('householdAmount');
      expect(result?.payment?.PaymentId).toBe(originalPaymentId);
    });

    it('returns null when no strategy matches (ghost return)', async () => {
      const pool = makePool(async () => ({ recordset: [] }));
      const result = await findOriginalPaymentForBounce(pool, {
        transactionNumber: '778',
        parentTransactionInfoId: '1280259894',
        customerUuid: '423b27d4-e25b-4538-bbec-ba4a4a3650f0',
        amount: 799,
      });
      expect(result).toBeNull();
    });
  });

  describe('replayStoredPaymentWebhook', () => {
    it('skips when already processed unless force', async () => {
      const pool = makePool(async () => ({
        recordset: [
          {
            WebhookEventId: 1105,
            EventType: 'ach_payment_return',
            Payload: '{"transaction_number":"778"}',
            Processed: 1,
            ErrorMessage: 'Original payment not found: 1280259894',
          },
        ],
      }));
      const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), success: jest.fn() };
      const r = await replayStoredPaymentWebhook(pool, 1105, logger, { force: false });
      expect(r.skipped).toBe(true);
      expect(r.alreadyProcessed).toBe(true);
    });
  });

  describe('syncInvoiceForUnsettledPayment', () => {
    it('unfulfills invoice when payment status is Pending', async () => {
      const logger = { info: jest.fn(), warn: jest.fn() };
      const pool = makePool(async () => ({ recordset: [] }));

      await syncInvoiceForUnsettledPayment(pool, mockSql, invoiceId, 500, 'Pending', logger);

      expect(mockUnfulfillInvoiceForPaymentAmount).toHaveBeenCalledWith(pool, mockSql, invoiceId, 500);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('unfulfilled')
      );
    });

    it('does nothing when payment status is Completed', async () => {
      const logger = { info: jest.fn(), warn: jest.fn() };
      const pool = makePool(async () => ({ recordset: [] }));

      await syncInvoiceForUnsettledPayment(pool, mockSql, invoiceId, 500, 'Completed', logger);

      expect(mockUnfulfillInvoiceForPaymentAmount).not.toHaveBeenCalled();
    });

    it('skips unfulfill when another settled payment covers the invoice', async () => {
      const logger = { info: jest.fn(), warn: jest.fn() };
      const pool = makePool(async (sqlText) => {
        if (sqlText.includes('FROM oe.Invoices')) {
          return { recordset: [{ TotalAmount: 1830.91, CreditAmount: 0 }] };
        }
        if (sqlText.includes('FROM oe.Payments')) {
          return {
            recordset: [
              { Amount: 1830.91, Status: 'Completed', ProcessorTransactionId: '958439110' },
            ],
          };
        }
        return { recordset: [] };
      });

      await syncInvoiceForUnsettledPayment(pool, mockSql, invoiceId, 1830.91, 'Failed', logger, {
        excludeProcessorTransactionId: 'retry-fail',
      });

      expect(mockUnfulfillInvoiceForPaymentAmount).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('covered by other settled payment')
      );
    });

    it('still unfulfills premature-paid invoice (only same-txn completed row)', async () => {
      const logger = { info: jest.fn(), warn: jest.fn() };
      const pool = makePool(async (sqlText, inputs) => {
        if (sqlText.includes('FROM oe.Invoices')) {
          return { recordset: [{ TotalAmount: 500, CreditAmount: 0 }] };
        }
        if (sqlText.includes('FROM oe.Payments')) {
          const rows = [{ Amount: 500, Status: 'Completed', ProcessorTransactionId: 'txn-same' }];
          const exclude = inputs.excludeTxn;
          const filtered = exclude
            ? rows.filter((r) => String(r.ProcessorTransactionId).trim() !== String(exclude).trim())
            : rows;
          return { recordset: filtered };
        }
        if (sqlText.includes('SELECT TOP 1 Status')) {
          return { recordset: [{ Status: 'Pending' }] };
        }
        return { recordset: [] };
      });

      await syncInvoiceForUnsettledPayment(pool, mockSql, invoiceId, 500, 'Failed', logger, {
        excludeProcessorTransactionId: 'txn-same',
      });

      expect(mockUnfulfillInvoiceForPaymentAmount).toHaveBeenCalledWith(pool, mockSql, invoiceId, 500);
    });

    it('skips unfulfill when existing payment row is already Failed', async () => {
      const logger = { info: jest.fn(), warn: jest.fn() };
      const pool = makePool(async () => ({ recordset: [] }));

      await syncInvoiceForUnsettledPayment(pool, mockSql, invoiceId, 500, 'Failed', logger, {
        excludeProcessorTransactionId: 'txn-1',
        existingPaymentStatus: 'Failed',
      });

      expect(mockUnfulfillInvoiceForPaymentAmount).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('payment row already Failed')
      );
    });

    it('skips unfulfill when txn lookup finds payment already Failed', async () => {
      const logger = { info: jest.fn(), warn: jest.fn() };
      const pool = makePool(async (sqlText) => {
        if (sqlText.includes('SELECT TOP 1 Status')) {
          return { recordset: [{ Status: 'Failed' }] };
        }
        return { recordset: [] };
      });

      await syncInvoiceForUnsettledPayment(pool, mockSql, invoiceId, 500, 'Failed', logger, {
        excludeProcessorTransactionId: 'txn-1',
      });

      expect(mockUnfulfillInvoiceForPaymentAmount).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('already Failed')
      );
    });
  });
});
