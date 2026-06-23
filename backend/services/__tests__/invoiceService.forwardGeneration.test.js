'use strict';

jest.mock('../../config/database', () => ({
  getPool: jest.fn(),
  sql: {
    UniqueIdentifier: 'UniqueIdentifier',
    NVarChar: () => 'NVarChar',
    NVarChar: (n) => (n === 50 ? 'NVarChar50' : 'NVarChar'),
    Date: 'Date',
    DateTime: 'DateTime',
    Decimal: () => 'Decimal',
    MAX: 'MAX',
  },
}));

jest.mock('../dimeService', () => ({}));

jest.mock('../../config/shared-modules', () => ({
  requireShared: (name) => {
    if (name === 'payment-status') {
      return { isSuccessfulPaymentRecordStatus: () => false };
    }
    if (name === 'payment-product-snapshots') {
      return {
        buildHouseholdProductSnapshots: jest.fn(async () => ({})),
        getPricingFields: jest.fn(async () => ({
          netRate: 0,
          overrideRate: 0,
          commission: 0,
        })),
        getHouseholdFeeBucketsAsOf: jest.fn(async () => ({
          systemFees: 0,
          processingFeeAmount: 0,
          setupFee: 0,
        })),
        resolveProcessingFeeTotalFromParts: (_included, remainder) => ({
          total: remainder,
          isLegacyFullPpfRow: false,
        }),
      };
    }
    throw new Error(`unexpected requireShared:${name}`);
  },
}));

const { getPool } = require('../../config/database');
const { createNextMonthInvoice } = require('../invoiceService');

describe('createNextMonthInvoice — forward generation with arrear', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates the next period when the latest invoice is Partial (older arrear)', async () => {
    const householdId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const tenantId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    let queryCount = 0;
    const insertInputs = [];

    const pool = {
      request() {
        const inputs = {};
        return {
          input(k, _ty, v) {
            inputs[k] = v;
            return this;
          },
          query: jest.fn(async (sql) => {
            queryCount += 1;
            const s = String(sql);
            if (s.includes('TOP 1') && s.includes('BillingPeriodEnd DESC')) {
              return {
                recordset: [{
                  InvoiceId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
                  BillingPeriodStart: new Date('2026-05-01T00:00:00.000Z'),
                  BillingPeriodEnd: new Date('2026-05-31T00:00:00.000Z'),
                  Status: 'Partial',
                }],
              };
            }
            if (s.includes('BillingPeriodStart = @bpStart AND BillingPeriodEnd = @bpEnd')) {
              return { recordset: [] };
            }
            if (s.includes('COALESCE(SUM(COALESCE(e.PremiumAmount')) {
              return {
                recordset: [{
                  PremiumSum: 765.39,
                  IncludedOnProducts: 0,
                  PpfOnFeeRow: 0,
                }],
              };
            }
            if (s.includes('INSERT INTO oe.Invoices')) {
              insertInputs.push({ ...inputs });
              return { rowsAffected: [1] };
            }
            if (s.includes('FROM oe.Payments') || s.includes('selfHeal') || s.includes('Enrollments e')) {
              return { recordset: [] };
            }
            return { recordset: [] };
          }),
        };
      },
    };

    getPool.mockResolvedValue(pool);

    const result = await createNextMonthInvoice(householdId, tenantId, 1);

    expect(result).not.toBeNull();
    expect(result.invoiceNumber).toBeDefined();
    expect(insertInputs.length).toBe(1);
    expect(insertInputs[0].totalAmount).toBe(765.39);
  });
});
