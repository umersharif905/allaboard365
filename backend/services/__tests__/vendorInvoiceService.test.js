'use strict';

const {
  validatePeriod,
  mapRawRow,
  roundMoney,
  buildPreview,
} = require('../vendorInvoiceService');

jest.mock('../vendorImportTenants.service', () => ({
  getImportEligibleTenantsForVendor: jest.fn().mockResolvedValue([
    { tenantId: 't1', tenantName: 'Align Health', isExternal: true },
    { tenantId: 't2', tenantName: 'Internal Co', isExternal: false },
  ]),
  assertTenantEligibleForVendorImport: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../config/database', () => ({
  getPool: jest.fn(),
  sql: require('mssql'),
}));

const { getPool } = require('../../config/database');

describe('vendorInvoiceService', () => {
  test('validatePeriod rejects end before start', () => {
    expect(() => validatePeriod('2026-02-01', '2026-01-01')).toThrow(/periodEnd/);
  });

  test('validatePeriod accepts ISO dates', () => {
    expect(validatePeriod('2026-01-01', '2026-02-01')).toEqual({
      periodStart: '2026-01-01',
      periodEnd: '2026-02-01',
    });
  });

  test('mapRawRow excludes missing ProductPricingId', () => {
    const row = mapRawRow({
      TenantId: 't1',
      TenantName: 'Align',
      ProductPricingId: null,
      NetRate: 100,
      TobaccoUse: 'Y',
    });
    expect(row.excluded).toBe(true);
    expect(row.total).toBe(0);
    expect(row.tobacco).toBe('Yes');
  });

  test('mapRawRow includes zero NetRate with warning flag', () => {
    const row = mapRawRow({
      TenantId: 't1',
      TenantName: 'Align',
      ProductPricingId: 'pp-1',
      NetRate: 0,
      TobaccoUse: 'N',
    });
    expect(row.excluded).toBe(false);
    expect(row.zeroRate).toBe(true);
    expect(row.total).toBe(0);
  });

  test('buildPreview aggregates external tenants only', async () => {
    const chain = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockResolvedValue({
        recordset: [
          {
            TenantId: 't1',
            TenantName: 'Align Health',
            MemberId: 'M1',
            FirstName: 'Jane',
            LastName: 'Doe',
            EffectiveDate: new Date('2026-01-15'),
            TerminationDate: null,
            ProductName: 'Essential',
            Tier: 'EE',
            UA: '1500',
            NetRate: 194,
            ProductPricingId: 'pp-1',
            TobaccoUse: 'N',
          },
        ],
      }),
    };
    getPool.mockResolvedValue({
      request: () => chain,
    });

    const result = await buildPreview('vendor-1', '2026-01-01', '2026-02-01');
    expect(result.tenants).toHaveLength(1);
    expect(result.tenants[0].tenantName).toBe('Align Health');
    expect(result.tenants[0].expectedAmount).toBe(194);
    expect(result.tenants[0].lineCount).toBe(1);
    expect(result.summary.grandTotal).toBe(194);
    expect(roundMoney(194)).toBe(194);
  });
});
