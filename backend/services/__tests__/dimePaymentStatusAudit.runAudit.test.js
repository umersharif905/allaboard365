'use strict';

/**
 * runAudit — Pending payment reconciled to Completed via DIME poll syncs invoice.
 * Run: cd backend && npx jest dimePaymentStatusAudit.runAudit
 */

const tenantId = '11111111-1111-4111-8111-111111111111';
const paymentId = '22222222-2222-4222-8222-222222222222';
const invoiceId = '33333333-3333-4333-8333-333333333333';

const mockGetTransactionForAudit = jest.fn();
const mockGetPaymentStatusInvoiceAdjustmentPlan = jest.fn();
const mockApplyPaymentStatusInvoiceAdjustmentInTxn = jest.fn();

const mockPoolQuery = jest.fn();
const mockTxnQuery = jest.fn();

jest.mock('../dimeService', () => ({
  getTransactionForAudit: (...args) => mockGetTransactionForAudit(...args),
}));

jest.mock('../paymentAdminPatch.service', () => ({
  getPaymentStatusInvoiceAdjustmentPlan: (...args) =>
    mockGetPaymentStatusInvoiceAdjustmentPlan(...args),
  applyPaymentStatusInvoiceAdjustmentInTxn: (...args) =>
    mockApplyPaymentStatusInvoiceAdjustmentInTxn(...args),
}));

jest.mock('../../config/database', () => ({
  getPool: jest.fn(async () => ({
    request: () => ({
      input: jest.fn().mockReturnThis(),
      query: mockPoolQuery,
    }),
  })),
  sql: {
    UniqueIdentifier: 'UniqueIdentifier',
    NVarChar: jest.fn((n) => `NVarChar(${n})`),
    Int: 'Int',
    Date: 'Date',
  },
  rawSql: {
    Transaction: jest.fn().mockImplementation(function mockTransaction() {
      this.begin = jest.fn(async () => {});
      this.commit = jest.fn(async () => {});
      this.rollback = jest.fn(async () => {});
      this.request = jest.fn(() => ({
        input: jest.fn().mockReturnThis(),
        query: mockTxnQuery,
      }));
    }),
  },
}));

const { runAudit } = require('../dimePaymentStatusAudit.service');

const pendingRow = {
  PaymentId: paymentId,
  InvoiceId: invoiceId,
  Status: 'Pending',
  PaymentMethod: 'dime',
  Processor: 'DIME',
  ProcessorTransactionId: 'tx_audit_1',
  ProcessorTransactionInfoId: null,
  PaymentDate: new Date('2026-06-05T12:00:00Z'),
  Amount: 500,
  GroupId: '44444444-4444-4444-8444-444444444444',
  HouseholdId: null,
  TransactionType: 'Payment',
  OriginalPaymentId: null,
  GroupName: 'Test Group',
  PrimaryMemberName: null,
  FailureReason: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPoolQuery.mockResolvedValue({ recordset: [pendingRow] });
  mockTxnQuery.mockResolvedValue({ rowsAffected: [1] });
  mockGetTransactionForAudit.mockResolvedValue({
    success: true,
    data: {
      transaction_type: 'CC',
      transaction_status: 'CC_CREDIT',
      status_code: '00',
      status_text: 'Approved',
      fund_date: '2026-06-06',
      settle_date: '2026-06-06',
      pending: false,
    },
  });
  mockGetPaymentStatusInvoiceAdjustmentPlan.mockResolvedValue({
    kind: 'sync',
    invoiceSync: { applied: false },
  });
  mockApplyPaymentStatusInvoiceAdjustmentInTxn.mockResolvedValue({
    applied: true,
    invoiceStatus: 'Paid',
    newPaidAmount: 500,
  });
});

describe('dimePaymentStatusAudit.runAudit — Pending to Completed', () => {
  it('updates payment and syncs invoice when DIME reports settled capture', async () => {
    const result = await runAudit({
      tenantId,
      hoursBack: 168,
      dryRun: false,
      limit: 10,
      successRecheckDays: 0,
      pendingLookbackDays: 0,
      pendingSecondaryLimit: 0,
    });

    expect(result.examined).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.invoicesSynced).toBe(1);
    expect(mockGetTransactionForAudit).toHaveBeenCalledWith(
      tenantId,
      'tx_audit_1',
      'dime',
      null
    );
    expect(mockGetPaymentStatusInvoiceAdjustmentPlan).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      paymentId,
      expect.objectContaining({ Status: 'Pending', InvoiceId: invoiceId }),
      'Completed',
      true
    );
    expect(mockApplyPaymentStatusInvoiceAdjustmentInTxn).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'sync',
      expect.objectContaining({ InvoiceId: invoiceId, Amount: 500 }),
      'Completed'
    );
    expect(result.rows[0].applied).toBe(true);
    expect(result.rows[0].invoiceSynced).toBe(true);
  });

  it('dryRun reports wouldSyncInvoice without writing', async () => {
    const result = await runAudit({
      tenantId,
      hoursBack: 168,
      dryRun: true,
      limit: 10,
      successRecheckDays: 0,
      pendingLookbackDays: 0,
      pendingSecondaryLimit: 0,
    });

    expect(result.wouldUpdate).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.invoicesSynced).toBe(0);
    expect(result.rows[0].wouldSyncInvoice).toBe(true);
    expect(mockApplyPaymentStatusInvoiceAdjustmentInTxn).not.toHaveBeenCalled();
  });
});
