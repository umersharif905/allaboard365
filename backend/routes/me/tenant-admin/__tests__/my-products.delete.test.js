/**
 * Tests for DELETE /api/me/tenant-admin/my-products/:productId
 */

const request = require('supertest');
const express = require('express');

const TENANT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PRODUCT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OTHER_TENANT_PRODUCT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const executedSql = [];

function makeFakePool({ owned = true, enrollmentCount = 0, deleteFailsOn = null } = {}) {
  const transaction = {
    begin: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
    request() {
      const params = {};
      return {
        input(name, _type, value) {
          params[name] = value;
          return this;
        },
        async query(sqlText) {
          executedSql.push(sqlText);

          if (deleteFailsOn && sqlText.includes(deleteFailsOn)) {
            throw new Error(`Simulated failure on ${deleteFailsOn}`);
          }

          if (/DELETE FROM oe\.Products/i.test(sqlText)) {
            return { rowsAffected: [1] };
          }

          return { rowsAffected: [0], recordset: [] };
        }
      };
    }
  };

  return {
    request() {
      const params = {};
      return {
        input(name, _type, value) {
          params[name] = value;
          return this;
        },
        async query(sqlText) {
          executedSql.push(sqlText);

          if (/FROM oe\.Products/i.test(sqlText) && /ProductOwnerId/i.test(sqlText)) {
            if (params.productId === PRODUCT_ID && owned) {
              return {
                recordset: [{
                  ProductId: PRODUCT_ID,
                  Name: 'Ideal Health Sharewell',
                  Status: 'Active',
                  ProductOwnerId: TENANT_ID
                }]
              };
            }
            return { recordset: [] };
          }

          if (/FROM oe\.Enrollments/i.test(sqlText)) {
            return { recordset: [{ EnrollmentCount: enrollmentCount }] };
          }

          return { recordset: [], rowsAffected: [0] };
        }
      };
    },
    Transaction: jest.fn(() => transaction)
  };
}

jest.mock('../../../../config/database', () => {
  const actualSql = {
    UniqueIdentifier: 'UNIQUEIDENTIFIER',
    Transaction: jest.fn()
  };

  return {
    getPool: jest.fn(),
    sql: actualSql
  };
});

jest.mock('../../../../middleware/auth', () => ({
  authenticate: (_req, _res, next) => next(),
  authorize: () => (_req, _res, next) => next()
}));

jest.mock('../../../../middleware/requireTenantAccess', () => {
  return (req, _res, next) => {
    req.user = req.user || { UserId: 'user-1', TenantId: TENANT_ID, currentRole: 'TenantAdmin' };
    req.tenantId = TENANT_ID;
    next();
  };
});

jest.mock('../../../uploads', () => ({
  authenticateProductUrls: jest.fn(async (product) => product)
}));

jest.mock('../../../../constants/uploadLimits', () => ({
  MAX_UPLOAD_FILE_BYTES: 10 * 1024 * 1024
}));

const { getPool, sql } = require('../../../../config/database');

let app;

beforeAll(() => {
  const routes = require('../my-products');
  app = express();
  app.use(express.json());
  app.use('/api/me/tenant-admin/my-products', routes);
});

beforeEach(() => {
  executedSql.length = 0;
  jest.clearAllMocks();
});

describe('DELETE /api/me/tenant-admin/my-products/:productId', () => {
  it('permanently deletes an owned product with no enrollments', async () => {
    const pool = makeFakePool();
    getPool.mockResolvedValue(pool);
    sql.Transaction = pool.Transaction;

    const res = await request(app)
      .delete(`/api/me/tenant-admin/my-products/${PRODUCT_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(executedSql.some((s) => /DELETE FROM oe\.ProductBundles/i.test(s))).toBe(true);
    expect(executedSql.some((s) => /BundleProductId = @productId OR IncludedProductId = @productId/i.test(s))).toBe(true);
    expect(executedSql.some((s) => /DELETE FROM oe\.Products/i.test(s))).toBe(true);
    expect(executedSql.some((s) => /DELETE FROM oe\.BundleProducts/i.test(s))).toBe(false);
  });

  it('blocks delete when enrollments are attached', async () => {
    const pool = makeFakePool({ enrollmentCount: 3 });
    getPool.mockResolvedValue(pool);
    sql.Transaction = pool.Transaction;

    const res = await request(app)
      .delete(`/api/me/tenant-admin/my-products/${PRODUCT_ID}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/3 enrollments are attached/i);
    expect(executedSql.some((s) => /DELETE FROM oe\.Products/i.test(s))).toBe(false);
  });

  it('returns 404 when the product is not owned by the tenant', async () => {
    const pool = makeFakePool({ owned: false });
    getPool.mockResolvedValue(pool);
    sql.Transaction = pool.Transaction;

    const res = await request(app)
      .delete(`/api/me/tenant-admin/my-products/${OTHER_TENANT_PRODUCT_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/not found or you do not have permission/i);
  });
});
