'use strict';

/**
 * POST /api/groups/:groupId/invoices/:invoiceId/charge — group manual charge.
 * Mocks DB + DIME (no test DB).
 *
 * Run: npx jest groupBilling.manualCharge
 */

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  console.log.mockRestore?.();
  console.error.mockRestore?.();
  console.warn.mockRestore?.();
});

const express = require('express');
const request = require('supertest');

const mockProcessPayment = jest.fn();
const mockUnfulfillInvoice = jest.fn();
const mockQuery = jest.fn();
const mockInput = jest.fn().mockReturnThis();
const mockRequest = jest.fn(() => ({ input: mockInput, query: mockQuery }));

jest.mock('../../config/database', () => ({
  getPool: jest.fn(async () => ({ request: mockRequest })),
  rawSql: {},
  sql: {
    NVarChar: jest.fn((n) => `NVarChar(${n})`),
    UniqueIdentifier: 'UniqueIdentifier',
    Decimal: jest.fn(() => 'Decimal'),
    DateTime2: 'DateTime2',
    MAX: 'MAX',
  },
}));

jest.mock('../../config/shared-modules', () => {
  const { requireShared: realRequireShared } = jest.requireActual('../../config/shared-modules');
  return {
    requireShared: (name) => {
      if (name === 'payment-product-snapshots') {
        return {
          getPricingFields: jest.fn(async () => ({
            netRate: 0,
            commission: 0,
            overrideRate: 0,
            systemFees: 0,
            processingFeeAmount: 0,
          })),
          buildGroupProductSnapshotsForPeriod: jest.fn(async () => null),
        };
      }
      return realRequireShared(name);
    },
  };
});

jest.mock('../../middleware/auth', () => ({
  authorize: () => (req, _res, next) => next(),
  requireTenantAccess: (req, _res, next) => {
    req.tenantId = req.user?.TenantId || 'tenant-1';
    next();
  },
  getUserRoles: jest.fn(() => ['TenantAdmin']),
}));

jest.mock('../../services/dimeService', () => ({
  processPayment: (...args) => mockProcessPayment(...args),
}));

jest.mock('../../services/invoiceService', () => ({
  unfulfillInvoice: (...args) => mockUnfulfillInvoice(...args),
}));

jest.mock('../../services/encryptionService', () => ({}));
jest.mock('../../utils/achRouting', () => ({ resolveAchRoutingForCharge: jest.fn() }));
jest.mock('../../services/dimeCardBrand', () => ({}));
jest.mock('../../services/PaymentMethodService', () => ({}));
jest.mock('../../services/invoicePdfService', () => ({}));
jest.mock('../../services/invoiceEmailService', () => ({}));
jest.mock('../../services/messageQueue.service', () => ({}));
jest.mock('../../utils/agentGroupAccess', () => ({
  getAccessibleAgentIdsForUser: jest.fn(),
  buildAgentScopeClause: jest.fn(),
}));

const { requireShared } = require('../../config/shared-modules');
const { PENDING_BANK_APPROVAL_MESSAGE } = requireShared('payment-messages');

const groupId = '11111111-1111-1111-1111-111111111111';
const invoiceId = '22222222-2222-2222-2222-222222222222';
const tenantId = '33333333-3333-3333-3333-333333333333';

function buildApp() {
  jest.resetModules();
  const router = require('../groupBilling');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { UserId: 'admin-1', TenantId: tenantId, roles: ['TenantAdmin'] };
    next();
  });
  app.use('/api/groups', router);
  return app;
}

function mockGroupChargeQueries({ invoiceStatus = 'Unpaid', paidAmount = 0 } = {}) {
  mockQuery.mockImplementation(async (sqlText) => {
    if (sqlText.includes('FROM oe.Invoices WHERE InvoiceId')) {
      return {
        recordset: [
          {
            InvoiceId: invoiceId,
            GroupId: groupId,
            Status: invoiceStatus,
            TotalAmount: 500,
            PaidAmount: paidAmount,
            InvoiceNumber: 'INV-G-1',
            LocationId: null,
            BillingPeriodStart: '2026-06-01',
            BillingPeriodEnd: '2026-06-30',
          },
        ],
      };
    }
    if (sqlText.includes('ProcessorCustomerId, TenantId FROM oe.Groups')) {
      return { recordset: [{ ProcessorCustomerId: 'cust_g1', TenantId: tenantId }] };
    }
    if (sqlText.includes('FROM oe.GroupPaymentMethods')) {
      return {
        recordset: [
          {
            PaymentMethodId: 'pm-1',
            ProcessorPaymentMethodId: 'dime-pm-1',
            ProcessorToken: 'tok',
            Type: 'CreditCard',
            CardholderName: 'Group Admin',
            BillingAddress: '1 Main',
            BillingCity: 'City',
            BillingState: 'GA',
            BillingZip: '30301',
          },
        ],
      };
    }
    if (sqlText.includes('GroupRecurringPaymentPlans')) {
      return { recordset: [] };
    }
    if (sqlText.includes('AgentId FROM oe.Groups')) {
      return { recordset: [{ AgentId: null }] };
    }
    if (sqlText.includes('FROM oe.Payments') && sqlText.includes('Status IN')) {
      return { recordset: [] };
    }
    if (sqlText.startsWith('INSERT INTO oe.Payments')) {
      return { recordset: [] };
    }
    if (sqlText.startsWith('UPDATE oe.Payments')) {
      return { recordset: [] };
    }
    if (sqlText.startsWith('UPDATE oe.Invoices')) {
      return { recordset: [] };
    }
    return { recordset: [] };
  });
}

describe('POST /api/groups/:groupId/invoices/:invoiceId/charge', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockInput.mockReturnThis();
    mockRequest.mockImplementation(() => ({ input: mockInput, query: mockQuery }));
    mockProcessPayment.mockReset();
    mockUnfulfillInvoice.mockReset();
    mockGroupChargeQueries();
  });

  it('returns pending message and does not update invoice when DIME charge is Pending', async () => {
    mockProcessPayment.mockResolvedValue({
      success: true,
      transactionId: 'tx_cc_pending',
      recordStatus: 'Pending',
    });

    const app = buildApp();
    const res = await request(app)
      .post(`/api/groups/${groupId}/invoices/${invoiceId}/charge`)
      .send({ amount: 500 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe(PENDING_BANK_APPROVAL_MESSAGE);
    expect(res.body.data.paymentStatus).toBe('Pending');
    expect(res.body.data.invoiceUpdated).toBe(false);

    const invoiceUpdates = mockQuery.mock.calls.filter(([sql]) =>
      /UPDATE\s+oe\.Invoices/i.test(String(sql))
    );
    expect(invoiceUpdates).toHaveLength(0);
    expect(mockUnfulfillInvoice).not.toHaveBeenCalled();
  });

  it('marks invoice updated when DIME charge is Completed', async () => {
    mockProcessPayment.mockResolvedValue({
      success: true,
      transactionId: 'tx_cc_ok',
      recordStatus: 'Completed',
    });

    const app = buildApp();
    const res = await request(app)
      .post(`/api/groups/${groupId}/invoices/${invoiceId}/charge`)
      .send({ amount: 500 });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Invoice charged successfully');
    expect(res.body.data.paymentStatus).toBe('Completed');
    expect(res.body.data.invoiceUpdated).toBe(true);

    const invoiceUpdates = mockQuery.mock.calls.filter(([sql]) =>
      /UPDATE\s+oe\.Invoices/i.test(String(sql))
    );
    expect(invoiceUpdates.length).toBeGreaterThan(0);
  });

  it('unfulfills prematurely paid invoice when new charge is still Pending', async () => {
    mockQuery.mockImplementation(async (sqlText) => {
      if (sqlText.includes('HasUnsettled')) {
        return { recordset: [{ HasUnsettled: 1 }] };
      }
      if (sqlText.includes('FROM oe.Invoices WHERE InvoiceId')) {
        return {
          recordset: [
            {
              InvoiceId: invoiceId,
              GroupId: groupId,
              Status: 'Paid',
              TotalAmount: 500,
              PaidAmount: 500,
              InvoiceNumber: 'INV-G-1',
              LocationId: null,
              BillingPeriodStart: '2026-06-01',
              BillingPeriodEnd: '2026-06-30',
            },
          ],
        };
      }
      if (sqlText.includes('ProcessorCustomerId, TenantId FROM oe.Groups')) {
        return { recordset: [{ ProcessorCustomerId: 'cust_g1', TenantId: tenantId }] };
      }
      if (sqlText.includes('FROM oe.GroupPaymentMethods')) {
        return {
          recordset: [
            {
              PaymentMethodId: 'pm-1',
              ProcessorPaymentMethodId: 'dime-pm-1',
              ProcessorToken: 'tok',
              Type: 'CreditCard',
              CardholderName: 'G',
              BillingAddress: '1',
              BillingCity: 'C',
              BillingState: 'GA',
              BillingZip: '30301',
            },
          ],
        };
      }
      if (sqlText.includes('GroupRecurringPaymentPlans')) return { recordset: [] };
      if (sqlText.includes('AgentId FROM oe.Groups')) return { recordset: [{ AgentId: null }] };
      if (sqlText.includes('FROM oe.Payments')) return { recordset: [] };
      if (sqlText.startsWith('INSERT INTO oe.Payments')) return { recordset: [] };
      return { recordset: [] };
    });

    mockProcessPayment.mockResolvedValue({
      success: true,
      transactionId: 'tx_retry_pending',
      recordStatus: 'Pending',
    });
    mockUnfulfillInvoice.mockResolvedValue({ applied: true });

    const app = buildApp();
    const res = await request(app)
      .post(`/api/groups/${groupId}/invoices/${invoiceId}/charge`)
      .send({ amount: 500 });

    expect(res.status).toBe(200);
    expect(res.body.data.invoiceUpdated).toBe(false);
    expect(mockUnfulfillInvoice).toHaveBeenCalledWith(invoiceId, 500);
  });

  it('inserts new payment with OriginalPaymentId when retrying after Failed row', async () => {
    const failedPaymentId = '55555555-5555-4555-8555-555555555555';
    let inputsForLastQuery = {};

    mockRequest.mockImplementation(() => {
      const inputs = {};
      return {
        input(name, _type, val) {
          inputs[name] = val;
          inputsForLastQuery = inputs;
          return this;
        },
        query: mockQuery,
      };
    });

    mockQuery.mockImplementation(async (sqlText) => {
      if (sqlText.includes('FROM oe.Invoices WHERE InvoiceId')) {
        return {
          recordset: [
            {
              InvoiceId: invoiceId,
              GroupId: groupId,
              Status: 'Unpaid',
              TotalAmount: 500,
              PaidAmount: 0,
              InvoiceNumber: 'INV-G-1',
              LocationId: null,
              BillingPeriodStart: '2026-06-01',
              BillingPeriodEnd: '2026-06-30',
            },
          ],
        };
      }
      if (sqlText.includes('ProcessorCustomerId, TenantId FROM oe.Groups')) {
        return { recordset: [{ ProcessorCustomerId: 'cust_g1', TenantId: tenantId }] };
      }
      if (sqlText.includes('FROM oe.GroupPaymentMethods')) {
        return {
          recordset: [
            {
              PaymentMethodId: 'pm-1',
              ProcessorPaymentMethodId: 'dime-pm-1',
              ProcessorToken: 'tok',
              Type: 'CreditCard',
              CardholderName: 'G',
              BillingAddress: '1',
              BillingCity: 'C',
              BillingState: 'GA',
              BillingZip: '30301',
            },
          ],
        };
      }
      if (sqlText.includes('GroupRecurringPaymentPlans')) return { recordset: [] };
      if (sqlText.includes('AgentId FROM oe.Groups')) return { recordset: [{ AgentId: null }] };
      if (sqlText.includes('FROM oe.Payments') && sqlText.includes('Status IN')) {
        return {
          recordset: [
            {
              PaymentId: failedPaymentId,
              Status: 'Failed',
              ProcessorTransactionId: 'tx_old_failed',
            },
          ],
        };
      }
      return { recordset: [] };
    });

    mockProcessPayment.mockResolvedValue({
      success: true,
      transactionId: 'tx_retry_new',
      recordStatus: 'Pending',
    });

    const app = buildApp();
    const res = await request(app)
      .post(`/api/groups/${groupId}/invoices/${invoiceId}/charge`)
      .send({ amount: 500 });

    expect(res.status).toBe(200);
    expect(res.body.data.invoiceUpdated).toBe(false);

    const updatePaymentCalls = mockQuery.mock.calls.filter(([sql]) =>
      /UPDATE\s+oe\.Payments/i.test(String(sql))
    );
    expect(updatePaymentCalls).toHaveLength(0);

    const insertCalls = mockQuery.mock.calls.filter(([sql]) =>
      /INSERT INTO oe\.Payments/i.test(String(sql))
    );
    expect(insertCalls.length).toBeGreaterThan(0);
    expect(inputsForLastQuery.originalPaymentId).toBe(failedPaymentId);
    expect(inputsForLastQuery.paymentStatus).toBe('Pending');
  });
});
