'use strict';

/**
 * Pending manual charge: record status resolution and invoice fulfillment gate.
 * Run: cd backend && npx jest householdManualCharge.pendingInvoice
 */

jest.mock('../../config/database', () => ({
  sql: {
    UniqueIdentifier: jest.fn((v) => v),
    NVarChar: jest.fn((v) => v),
    Decimal: jest.fn((v) => v),
    DateTime2: jest.fn((v) => v),
  },
}));

const mockFulfillInvoice = jest.fn();
const mockStorePaymentRecord = jest.fn();
const mockProcessPayment = jest.fn();

jest.mock('../paymentDatabaseService', () => ({
  storePaymentRecord: (...a) => mockStorePaymentRecord(...a),
}));
jest.mock('../dimeService', () => ({
  processPayment: (...a) => mockProcessPayment(...a),
}));
jest.mock('../encryptionService', () => ({
  decryptPaymentData: jest.fn(),
}));
jest.mock('../../utils/achRouting', () => ({ resolveAchRoutingForCharge: jest.fn() }));
jest.mock('../invoiceService', () => ({
  fulfillInvoice: (...a) => mockFulfillInvoice(...a),
  syncDimeRecurringForHousehold: jest.fn(),
}));

const {
  resolveManualChargeRecordStatus,
  executeHouseholdManualCharge,
} = require('../householdManualCharge.service');

const householdId = '11111111-1111-1111-1111-111111111111';
const tenantId = '22222222-2222-2222-2222-222222222222';
const memberId = '33333333-3333-3333-3333-333333333333';
const invoiceId = '44444444-4444-4444-4444-444444444444';

function makePool() {
  return {
    request: () => {
      const inputs = {};
      const req = {
        input(name, _type, val) {
          inputs[name] = val;
          return this;
        },
        query: async (sqlText) => {
          if (sqlText.includes("RelationshipType = 'P'")) {
            return {
              recordset: [
                {
                  MemberId: memberId,
                  ProcessorCustomerId: 'cust_1',
                  AgentId: null,
                },
              ],
            };
          }
          if (sqlText.includes('FROM oe.MemberPaymentMethods')) {
            return {
              recordset: [
                {
                  PaymentMethodId: 'pm-1',
                  ProcessorPaymentMethodId: 'dime-pm-1',
                  PaymentMethodType: 'Card',
                  ProcessorToken: 'tok_1',
                  CardholderName: 'Test User',
                  BillingAddress: '1 Main',
                  BillingCity: 'City',
                  BillingState: 'GA',
                  BillingZip: '30301',
                },
              ],
            };
          }
          if (sqlText.includes('IndividualRecurringSchedules')) {
            return { recordset: [] };
          }
          return { recordset: [] };
        },
      };
      return req;
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStorePaymentRecord.mockResolvedValue({ PaymentId: 'pay-new-1' });
  mockFulfillInvoice.mockResolvedValue({ applied: true });
});

describe('resolveManualChargeRecordStatus', () => {
  it('returns Pending when recordStatus and status are missing', () => {
    expect(resolveManualChargeRecordStatus({ success: true, transactionId: 'tx_1' })).toBe('Pending');
  });

  it('returns Pending when DIME reports pending settlement', () => {
    expect(resolveManualChargeRecordStatus({ recordStatus: 'Pending' })).toBe('Pending');
  });

  it('returns Completed when DIME reports settled capture', () => {
    expect(resolveManualChargeRecordStatus({ recordStatus: 'Completed' })).toBe('Completed');
  });

  it('prefers recordStatus over legacy status field', () => {
    expect(
      resolveManualChargeRecordStatus({ recordStatus: 'Pending', status: 'APPROVAL' })
    ).toBe('Pending');
  });
});

describe('executeHouseholdManualCharge — pending vs settled invoice fulfillment', () => {
  const baseOpts = {
    householdId,
    tenantId,
    chargeAmount: 100,
    actingUserId: 'user-1',
    targetInvoiceId: invoiceId,
    mode: 'member-pay',
    prefillInvoiceNumber: 'INV-1',
    failClosedOnFulfillError: false,
  };

  it('does not fulfill invoice when DIME sync response is Pending (pending:true)', async () => {
    mockProcessPayment.mockResolvedValue({
      success: true,
      transactionId: 'tx_pending_1',
      recordStatus: 'Pending',
    });

    const pool = makePool();
    const result = await executeHouseholdManualCharge(pool, baseOpts);

    expect(result.ok).toBe(true);
    expect(result.data.paymentRecordStatus).toBe('Pending');
    expect(mockStorePaymentRecord).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'Pending', invoiceId })
    );
    expect(mockFulfillInvoice).not.toHaveBeenCalled();
  });

  it('fulfills invoice when DIME sync response is Completed', async () => {
    mockProcessPayment.mockResolvedValue({
      success: true,
      transactionId: 'tx_ok_1',
      recordStatus: 'Completed',
    });

    const pool = makePool();
    const result = await executeHouseholdManualCharge(pool, baseOpts);

    expect(result.ok).toBe(true);
    expect(result.data.paymentRecordStatus).toBe('Completed');
    expect(mockStorePaymentRecord).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'Completed' })
    );
    expect(mockFulfillInvoice).toHaveBeenCalledWith(invoiceId, 100);
  });

  it('does not fulfill when recordStatus omitted (defaults Pending, not Completed)', async () => {
    mockProcessPayment.mockResolvedValue({
      success: true,
      transactionId: 'tx_missing_status',
    });

    const pool = makePool();
    const result = await executeHouseholdManualCharge(pool, baseOpts);

    expect(result.ok).toBe(true);
    expect(result.data.paymentRecordStatus).toBe('Pending');
    expect(mockFulfillInvoice).not.toHaveBeenCalled();
  });
});
