'use strict';

const {
  dedupeMappingProducts,
  mergeCatalogSource,
  pickBundleDisplayVendor,
  suggestProductId,
  scoreProductNameMatch
} = require('../migrationProductMapping.service');

describe('dedupeMappingProducts', () => {
  test('merges duplicate products by productId', () => {
    const input = [
      { productId: 'a', name: 'Alpha', catalogSource: 'subscribed' },
      { productId: 'b', name: 'Beta', catalogSource: 'owned' },
      { productId: 'a', name: 'Alpha', catalogSource: 'both' }
    ];
    const result = dedupeMappingProducts(input);
    expect(result).toHaveLength(2);
    expect(result.find((row) => row.productId === 'a')?.catalogSource).toBe('both');
  });

  test('sorts products by name', () => {
    const result = dedupeMappingProducts([
      { productId: '2', name: 'Zulu', catalogSource: 'subscribed' },
      { productId: '1', name: 'Alpha', catalogSource: 'subscribed' }
    ]);
    expect(result.map((row) => row.name)).toEqual(['Alpha', 'Zulu']);
  });
});

describe('mergeCatalogSource', () => {
  test('prefers both over owned and subscribed', () => {
    expect(mergeCatalogSource('subscribed', 'both')).toBe('both');
    expect(mergeCatalogSource('owned', 'subscribed')).toBe('owned');
  });
});

describe('pickBundleDisplayVendor', () => {
  test('prefers carrier vendor over ShareWELL on copay bundles', () => {
    const result = pickBundleDisplayVendor([
      { SortOrder: 1, VendorId: 'sharewell-id', VendorName: 'ShareWELL Health/Partners' },
      { SortOrder: 2, VendorId: 'apex-id', VendorName: 'Apex' },
      { SortOrder: 3, VendorId: 'lyric-id', VendorName: 'Lyric' }
    ]);
    expect(result).toEqual({
      vendorId: 'apex-id',
      vendorName: 'Apex'
    });
  });

  test('falls back to first included vendor when all are platform vendors', () => {
    const result = pickBundleDisplayVendor([
      { SortOrder: 1, VendorId: 'sharewell-id', VendorName: 'ShareWELL Health/Partners' },
      { SortOrder: 2, VendorId: 'lyric-id', VendorName: 'Lyric' }
    ]);
    expect(result).toEqual({
      vendorId: 'sharewell-id',
      vendorName: 'ShareWELL Health/Partners'
    });
  });
});

describe('suggestProductId', () => {
  test('skips bundle products when auto-suggesting by name', () => {
    const products = [
      { productId: 'bundle-1', name: 'MightyWELL CoPay', isBundle: true },
      { productId: 'product-1', name: 'MightyWELL Essential', isBundle: false }
    ];
    const result = suggestProductId('MightyWELL CoPay', products, [], '46523');
    expect(result).toBeNull();
  });

  test('prefers saved map over name match', () => {
    const products = [
      { productId: 'product-1', name: 'Alpha Plan', isBundle: false }
    ];
    const savedMaps = [{
      SourceProductKey: '123',
      IgnoreImport: false,
      ProductId: 'saved-product'
    }];
    const result = suggestProductId('Alpha Plan', products, savedMaps, '123');
    expect(result).toBe('saved-product');
  });
});
