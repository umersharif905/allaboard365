'use strict';

const { isExternalTenantBillingSuppressed } = require('../../utils/externalTenantBilling');

describe('externalTenantBilling', () => {
  test('returns false when tenant missing', () => {
    expect(isExternalTenantBillingSuppressed(null)).toBe(false);
    expect(isExternalTenantBillingSuppressed({ IsExternal: false })).toBe(false);
    expect(isExternalTenantBillingSuppressed({ IsExternal: true })).toBe(true);
  });
});
