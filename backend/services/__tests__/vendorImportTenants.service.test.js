'use strict';

jest.mock('../../config/database', () => ({
  getPool: jest.fn(),
  sql: require('mssql'),
}));

const {
  assertVendorOwnsProducts,
  normalizeTenantDirectoryQuery,
  aggregateTenantDirectoryRows,
} = require('../vendorImportTenants.service');

describe('vendorImportTenants.service', () => {
  test('assertVendorOwnsProducts rejects empty list', async () => {
    const pool = { request: jest.fn() };
    await expect(assertVendorOwnsProducts(pool, 'vendor-id', [])).rejects.toThrow(
      'Select at least one product'
    );
  });

  test('assertVendorOwnsProducts rejects partial matches', async () => {
    const query = jest.fn().mockResolvedValue({ recordset: [{ ProductId: 'a' }] });
    const pool = { request: () => ({ input: jest.fn().mockReturnThis(), query }) };
    await expect(
      assertVendorOwnsProducts(pool, 'vendor-id', ['a', 'b'])
    ).rejects.toThrow('invalid or not owned');
  });

  test('normalizeTenantDirectoryQuery applies defaults and caps limit', () => {
    expect(normalizeTenantDirectoryQuery({})).toEqual({
      search: '',
      page: 1,
      limit: 25,
      offset: 0,
      searchPattern: null,
    });
    expect(normalizeTenantDirectoryQuery({ page: 0, limit: 500, q: ' acme ' })).toEqual({
      search: 'acme',
      page: 1,
      limit: 100,
      offset: 0,
      searchPattern: '%acme%',
    });
    expect(normalizeTenantDirectoryQuery({ page: 3, limit: 10 }).offset).toBe(20);
  });

  test('normalizeTenantDirectoryQuery escapes SQL LIKE wildcards', () => {
    expect(normalizeTenantDirectoryQuery({ search: '100%' }).searchPattern).toBe('%100[%]%');
  });

  test('aggregateTenantDirectoryRows groups products under tenants', () => {
    const result = aggregateTenantDirectoryRows([
      {
        TenantId: 't1',
        TenantName: 'Acme',
        IsExternal: 1,
        TotalCount: 2,
        ProductId: 'p1',
        ProductName: 'Plan A',
        HouseholdCount: 3,
        GroupCount: 1,
        IsOwner: 1,
        IsSubscribed: 0,
        HasEnrollment: 1,
      },
      {
        TenantId: 't1',
        TenantName: 'Acme',
        IsExternal: 1,
        TotalCount: 2,
        ProductId: 'p2',
        ProductName: 'Plan B',
        HouseholdCount: 2,
        GroupCount: 0,
        IsOwner: 0,
        IsSubscribed: 1,
        HasEnrollment: 0,
      },
    ]);

    expect(result.total).toBe(2);
    expect(result.tenants).toHaveLength(1);
    expect(result.tenants[0].products).toHaveLength(2);
    expect(result.tenants[0].products[0].relationships).toEqual(['owner', 'enrollment']);
    expect(result.tenants[0].products[1].relationships).toEqual(['subscription']);
  });
});
