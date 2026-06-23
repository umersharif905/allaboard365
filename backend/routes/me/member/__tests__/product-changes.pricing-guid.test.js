/**
 * Regression: PRICING_VALIDATION_FAILED with backendAmount $0 vs real premium when
 * PricingEngine.products[].productId casing/shape differs from frontendPricing[].productId.
 *
 * Cypress enrollment / plan-change specs typically intercept member APIs — they never
 * exercised this PricingEngine ⇄ payload join. These tests are the intentional guard.
 */

const request = require('supertest');
const express = require('express');

jest.mock('../../../../config/database', () => ({
  getPool: jest.fn(),
  sql: {
    UniqueIdentifier: 'UniqueIdentifier',
    NVarChar: 'NVarChar',
    Date: 'Date',
    Decimal: jest.fn((_p, _s) => 'Decimal'),
    DateTime2: 'DateTime2'
  }
}));

const mockCalculatePricing = jest.fn();

jest.mock('../../../../services/pricing/PricingEngine', () => ({
  PricingEngine: {
    calculatePricing: (...args) => mockCalculatePricing(...args)
  }
}));

jest.spyOn(require('crypto'), 'randomUUID').mockReturnValue('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

const { getPool } = require('../../../../config/database');

const TENANT_ID = '11111111-2222-3333-4444-555555555555';
const MEMBER_ID = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
const PRODUCT_ID_UPPER = '8941BEE7-FAD0-4027-B234-D3331603E053';

function makePoolWithQueues({ transactionQueue, poolQueue }) {
  let ti = 0;
  let pi = 0;

  function makeRequest(which) {
    return () => ({
      input: jest.fn().mockReturnThis(),
      async query() {
        const rows = which === 'tx' ? transactionQueue[ti++] : poolQueue[pi++];
        if (!rows) {
          return { recordset: [] };
        }
        return rows;
      }
    });
  }

  const transaction = {
    begin: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
    request: makeRequest('tx')
  };

  return {
    transaction: jest.fn(() => transaction),
    request: makeRequest('pool')
  };
}

describe('POST /api/me/member/product-changes — pricing validation (GUID match)', () => {
  let app;
  let restoreConsole;

  beforeEach(() => {
    jest.clearAllMocks();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    restoreConsole = () => {
      logSpy.mockRestore();
      errSpy.mockRestore();
    };
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { UserId: 'cccccccc-dddd-eeee-ffff-999999999999' };
      next();
    });
    // eslint-disable-next-line global-require
    app.use(require('../product-changes'));
  });

  afterEach(() => {
    if (restoreConsole) restoreConsole();
  });

  function mountPool(transactionQueue, poolQueue) {
    getPool.mockResolvedValue(makePoolWithQueues({ transactionQueue, poolQueue }));
  }

  /**
   * SQL call order inside handler:
   *  TX: member by userId
   *  TX: member criteria row
   *  POOL: household size count
   *  TX: current enrollments
   *  TX: product+tps eligibility (once per selected product)
   *  TX: INSERT enrollment
   */
  const baseStacks = () => ({
    tx: [
      {
        recordset: [
          {
            MemberId: MEMBER_ID,
            HouseholdId: 'bbbbbbbb-1111-2222-3333-bbbbbbbbbbbb',
            TenantId: TENANT_ID,
            GroupId: null,
            AgentId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
            FirstName: 'Test',
            LastName: 'Member'
          }
        ]
      },
      {
        recordset: [
          {
            RelationshipType: 'P',
            Tier: 'ES',
            DateOfBirth: '1990-01-01',
            TobaccoUse: 'N'
          }
        ]
      },
      // enrollments active
      { recordset: [] },
      // product available for tenant
      {
        recordset: [
          {
            ProductId: PRODUCT_ID_UPPER,
            Name: 'MightyWELL CoPay',
            Status: 'Active',
            SubscriptionStatus: 'Active',
            IsConfigured: 1
          }
        ]
      },
      // INSERT
      {}
    ],
    pool: [{ recordset: [{ MemberCount: 1 }] }]
  });

  test('does not falsely fail when PricingEngine returns a different-case productId than frontendPricing', async () => {
    mockCalculatePricing.mockResolvedValueOnce({
      products: [
        {
          productId: PRODUCT_ID_UPPER.toLowerCase(),
          monthlyPremium: 315.25
        }
      ],
      totals: { totalPremium: 315.25 }
    });

    const { tx, pool } = baseStacks();
    mountPool(tx, pool);

    const res = await request(app)
      .post('/')
      .send({
        selectedProducts: [PRODUCT_ID_UPPER],
        removedProducts: [],
        configValues: {},
        effectiveDate: '2026-06-01',
        frontendPricing: [
          {
            productId: PRODUCT_ID_UPPER,
            productName: 'MightyWELL CoPay',
            monthlyPremium: 315.25,
            selectedConfig: null
          }
        ]
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockCalculatePricing).toHaveBeenCalled();
  });

  test('still rejects when premiums truly disagree (sanity)', async () => {
    mockCalculatePricing.mockResolvedValueOnce({
      products: [
        {
          productId: PRODUCT_ID_UPPER.toLowerCase(),
          monthlyPremium: 999
        }
      ],
      totals: { totalPremium: 999 }
    });

    const { tx, pool } = baseStacks();
    mountPool(tx, pool);

    const res = await request(app)
      .post('/')
      .send({
        selectedProducts: [PRODUCT_ID_UPPER],
        removedProducts: [],
        configValues: {},
        effectiveDate: '2026-06-01',
        frontendPricing: [
          {
            productId: PRODUCT_ID_UPPER,
            productName: 'MightyWELL CoPay',
            monthlyPremium: 315.25,
            selectedConfig: null
          }
        ]
      });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('PRICING_VALIDATION_FAILED');
    expect(res.body.error?.details?.backendAmount).toBe(999);
  });
});
