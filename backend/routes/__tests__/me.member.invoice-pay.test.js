'use strict';

/**
 * POST /api/me/member/invoices/pay-balance — member self-serve manual charge.
 * Mocks DB + executeHouseholdManualCharge (no test DB).
 *
 * Run: npx jest me.member.invoice-pay
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

const mockExecuteCharge = jest.fn();
const mockQuery = jest.fn();
const mockInput = jest.fn().mockReturnThis();
const mockRequest = jest.fn(() => ({ input: mockInput, query: mockQuery }));

jest.mock('../../config/database', () => ({
  getPool: jest.fn(async () => ({ request: mockRequest })),
  sql: {
    UniqueIdentifier: 'UniqueIdentifier',
  },
}));

jest.mock('../../middleware/auth', () => ({
  authorize: () => (req, _res, next) => next(),
}));

jest.mock('../../middleware/attachMemberHouseholdContext', () => ({
  getEffectiveUserId: (req) => req.user?.UserId || null,
  getHouseholdId: (req) => req.householdId || null,
}));

jest.mock('../../services/householdManualCharge.service', () => ({
  executeHouseholdManualCharge: (...args) => mockExecuteCharge(...args),
}));

const { requireShared } = require('../../config/shared-modules');
const { PENDING_BANK_APPROVAL_MESSAGE } = requireShared('payment-messages');

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const tenantId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const householdId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const invoiceId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const groupIdForMember = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function buildApp() {
  const router = require('../me/member/invoice-pay');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { UserId: userId, TenantId: tenantId, roles: ['Member'] };
    req.householdId = householdId;
    next();
  });
  app.use('/api/me/member/invoices', router);
  return app;
}

function mockInvoicePayQueries() {
  mockQuery.mockImplementation(async (sqlText) => {
    if (sqlText.includes('RelationshipType = \'P\'')) {
      return {
        recordset: [{ HouseholdId: householdId, GroupId: null, MemberTenantId: tenantId }],
      };
    }
    if (sqlText.includes('FROM oe.Invoices i')) {
      return {
        recordset: [
          {
            InvoiceId: invoiceId,
            HouseholdId: householdId,
            TenantId: tenantId,
            InvoiceType: 'Individual',
            Status: 'Unpaid',
            BalanceDue: 150,
            InvoiceNumber: 'INV-TEST',
            BillingPeriodStart: '2026-06-01',
            BillingPeriodEnd: '2026-06-30',
          },
        ],
      };
    }
    return { recordset: [] };
  });
}

describe('POST /api/me/member/invoices/pay-balance', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockInput.mockReturnThis();
    mockRequest.mockImplementation(() => ({ input: mockInput, query: mockQuery }));
    mockExecuteCharge.mockReset();
    mockInvoicePayQueries();
  });

  it('returns pending bank approval message when charge is Pending (invoice not fulfilled)', async () => {
    mockExecuteCharge.mockResolvedValue({
      ok: true,
      data: {
        paymentId: 'pay-1',
        amount: 150,
        transactionId: 'tx_pending',
        paymentRecordStatus: 'Pending',
      },
    });

    const app = buildApp();
    const res = await request(app)
      .post('/api/me/member/invoices/pay-balance')
      .send({ invoiceId });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe(PENDING_BANK_APPROVAL_MESSAGE);
    expect(res.body.data.paymentRecordStatus).toBe('Pending');
    expect(mockExecuteCharge).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        mode: 'member-pay',
        targetInvoiceId: invoiceId,
        chargeAmount: 150,
      })
    );
  });

  it('returns success message when charge is Completed', async () => {
    mockExecuteCharge.mockResolvedValue({
      ok: true,
      data: {
        paymentId: 'pay-2',
        amount: 150,
        transactionId: 'tx_ok',
        paymentRecordStatus: 'Completed',
      },
    });

    const app = buildApp();
    const res = await request(app)
      .post('/api/me/member/invoices/pay-balance')
      .send({ invoiceId });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Payment processed successfully');
    expect(res.body.data.paymentRecordStatus).toBe('Completed');
  });

  it('rejects group-billed members', async () => {
    mockQuery.mockImplementation(async (sqlText) => {
      if (sqlText.includes('RelationshipType = \'P\'')) {
        return {
          recordset: [
            {
              HouseholdId: householdId,
              GroupId: groupIdForMember,
              MemberTenantId: tenantId,
            },
          ],
        };
      }
      return { recordset: [] };
    });

    const app = buildApp();
    const res = await request(app)
      .post('/api/me/member/invoices/pay-balance')
      .send({ invoiceId });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not available for group-billed/i);
    expect(mockExecuteCharge).not.toHaveBeenCalled();
  });
});
