'use strict';

const { isBundleProductFlag, resolveProductVendorId } = require('../productBundleVendor');

describe('productBundleVendor', () => {
  const vendorId = 'FB578D19-03B5-4EF5-B5E4-F27DEFCEB836';

  test('isBundleProductFlag accepts common truthy forms', () => {
    expect(isBundleProductFlag(true)).toBe(true);
    expect(isBundleProductFlag('true')).toBe(true);
    expect(isBundleProductFlag(1)).toBe(true);
    expect(isBundleProductFlag(false)).toBe(false);
  });

  test('resolveProductVendorId returns null for bundles', () => {
    expect(resolveProductVendorId(true, vendorId)).toBeNull();
    expect(resolveProductVendorId('true', vendorId)).toBeNull();
  });

  test('resolveProductVendorId preserves vendor for non-bundles', () => {
    expect(resolveProductVendorId(false, vendorId)).toBe(vendorId);
    expect(resolveProductVendorId(false, null)).toBeNull();
  });
});
