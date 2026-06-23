'use strict';

jest.mock('../../../config/database', () => ({
  sql: { UniqueIdentifier: jest.fn((v) => v) },
  getPool: jest.fn()
}));

jest.mock('../productMap.service', () => ({
  getProductMap: jest.fn()
}));

jest.mock('../migrationProductMapping.service', () => ({
  listProductPricingRows: jest.fn()
}));

const { getPool } = require('../../../config/database');
const productMapService = require('../productMap.service');
const migrationProductMapping = require('../migrationProductMapping.service');
const { buildMigrationEnrollmentPlan } = require('../migrationBundleEnrollment.service');

function mockPool({ isBundle = {}, bundleComponents = {}, parentBundles = {} }) {
  getPool.mockResolvedValue({
    request: () => ({
      input: () => ({
        query: async (sqlText) => mockQuery(sqlText)
      }),
      query: async (sqlText) => mockQuery(sqlText)
    })
  });

  async function mockQuery(sqlText) {
    const text = String(sqlText);
    if (text.includes('FROM oe.Products') && text.includes('IsBundle')) {
      return {
        recordset: Object.entries(isBundle).map(([ProductId, IsBundle]) => ({
          ProductId,
          IsBundle
        }))
      };
    }
    if (text.includes('FROM oe.ProductBundles pb') && text.includes('BundleProductId = @bundleProductId')) {
      const bundleId = 'bundle-cw';
      return { recordset: bundleComponents[bundleId] || [] };
    }
    if (text.includes('pb.IncludedProductId IN')) {
      const rows = [];
      for (const [componentId, bundleIds] of Object.entries(parentBundles)) {
        for (const bundleId of bundleIds) {
          rows.push({ BundleProductId: bundleId, IncludedProductId: componentId });
        }
      }
      return { recordset: rows };
    }
    return { recordset: [] };
  }
}

describe('buildMigrationEnrollmentPlan', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('expands bundle into component enrollments with ProductBundleId and skips wrapper row', async () => {
    mockPool({
      isBundle: {
        'bundle-cw': true,
        'prod-sw': false,
        'prod-lyric': false
      },
      parentBundles: {
        'prod-sw': ['bundle-cw'],
        'prod-lyric': ['bundle-cw']
      },
      bundleComponents: {
        'bundle-cw': [
          { IncludedProductId: 'prod-sw', SortOrder: 1, ProductName: 'Sharewell' },
          { IncludedProductId: 'prod-lyric', SortOrder: 2, ProductName: 'Lyric' }
        ]
      }
    });

    productMapService.getProductMap.mockImplementation(async ({ sourceProductKey }) => {
      const maps = {
        100: { ProductId: 'bundle-cw', ProductPricingId: 'price-bundle', IgnoreImport: false },
        200: { ProductId: 'prod-sw', ProductPricingId: 'price-sw', IgnoreImport: false },
        300: { ProductId: 'prod-lyric', ProductPricingId: 'price-lyric', IgnoreImport: false }
      };
      return maps[Number(sourceProductKey)] || null;
    });

    migrationProductMapping.listProductPricingRows.mockImplementation(async (productId) => {
      if (productId === 'prod-sw') {
        return [{ productPricingId: 'price-sw', msrpRate: 200, netRate: 200, overrideRate: 0, commission: 0, systemFees: 0 }];
      }
      if (productId === 'prod-lyric') {
        return [{ productPricingId: 'price-lyric', msrpRate: 50, netRate: 50, overrideRate: 0, commission: 0, systemFees: 0 }];
      }
      return [{ productPricingId: 'price-bundle', msrpRate: 0, netRate: 0, overrideRate: 0, commission: 0, systemFees: 0 }];
    });

    const household = {
      primary: { tier: 'EE', tobaccoUse: 'No' },
      products: [
        { pdid: 100, label: 'Connected Wellness', productfees: [{ amount: 0 }] },
        { pdid: 200, label: 'Sharewell', productfees: [{ amount: 200 }] },
        { pdid: 300, label: 'Lyric', productfees: [{ amount: 50 }] }
      ]
    };

    const plan = await buildMigrationEnrollmentPlan(household, household.products, 'instance-1');
    expect(plan.enrollmentItems).toHaveLength(2);
    expect(plan.enrollmentItems.map((row) => row.productId).sort()).toEqual(['prod-lyric', 'prod-sw']);
    expect(plan.enrollmentItems.every((row) => row.productBundleId === 'bundle-cw')).toBe(true);
    expect(plan.enrollmentItems.find((row) => row.productId === 'prod-sw').amounts.premiumAmount).toBe(200);
    expect(plan.enrollmentItems.find((row) => row.productId === 'prod-lyric').amounts.premiumAmount).toBe(50);
  });

  test('does not expand when one component belongs to many parent bundles', async () => {
    mockPool({
      isBundle: { 'prod-sw': false },
      parentBundles: {
        'prod-sw': ['bundle-a', 'bundle-b', 'bundle-c']
      },
      bundleComponents: {
        'bundle-a': [{ IncludedProductId: 'prod-sw', SortOrder: 1, ProductName: 'Sharewell' }],
        'bundle-b': [{ IncludedProductId: 'prod-sw', SortOrder: 1, ProductName: 'Sharewell' }],
        'bundle-c': [{ IncludedProductId: 'prod-sw', SortOrder: 1, ProductName: 'Sharewell' }]
      }
    });

    productMapService.getProductMap.mockResolvedValue({
      ProductId: 'prod-sw',
      ProductPricingId: 'price-sw',
      IgnoreImport: false
    });
    migrationProductMapping.listProductPricingRows.mockResolvedValue([
      { productPricingId: 'price-sw', msrpRate: 200, netRate: 200, overrideRate: 0, commission: 0, systemFees: 0 }
    ]);

    const household = {
      primary: { tier: 'EE', tobaccoUse: 'No' },
      products: [{ pdid: 200, label: 'Sharewell', productfees: [{ amount: 200 }] }]
    };

    const plan = await buildMigrationEnrollmentPlan(household, household.products, 'instance-1');
    expect(plan.enrollmentItems).toHaveLength(1);
    expect(plan.enrollmentItems[0].productId).toBe('prod-sw');
    expect(plan.enrollmentItems[0].productBundleId).toBeNull();
  });

  test('creates $0 component row when included in bundle but absent from E123 products', async () => {
    mockPool({
      isBundle: { 'bundle-cw': true, 'prod-sw': false },
      parentBundles: { 'prod-sw': ['bundle-cw'] },
      bundleComponents: {
        'bundle-cw': [
          { IncludedProductId: 'prod-sw', SortOrder: 1, ProductName: 'Sharewell' },
          { IncludedProductId: 'prod-lyric', SortOrder: 2, ProductName: 'Lyric' }
        ]
      }
    });

    productMapService.getProductMap.mockResolvedValue({
      ProductId: 'prod-sw',
      ProductPricingId: 'price-sw',
      IgnoreImport: false
    });
    migrationProductMapping.listProductPricingRows.mockImplementation(async (productId) => {
      if (productId === 'prod-sw') {
        return [{ productPricingId: 'price-sw', msrpRate: 200, netRate: 200, overrideRate: 0, commission: 0, systemFees: 0 }];
      }
      return [{ productPricingId: 'price-lyric', msrpRate: 50, netRate: 50, overrideRate: 0, commission: 0, systemFees: 0 }];
    });

    const household = {
      primary: { tier: 'EE', tobaccoUse: 'No' },
      products: [{ pdid: 200, label: 'Sharewell', productfees: [{ amount: 200 }] }]
    };

    const plan = await buildMigrationEnrollmentPlan(household, household.products, 'instance-1');
    expect(plan.enrollmentItems).toHaveLength(2);
    const lyric = plan.enrollmentItems.find((row) => row.productId === 'prod-lyric');
    expect(lyric.productBundleId).toBe('bundle-cw');
    expect(lyric.amounts.premiumAmount).toBe(0);
  });
});
