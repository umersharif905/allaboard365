'use strict';

const { buildTenantAppBaseUrl } = require('../tenantAppUrl');

describe('buildTenantAppBaseUrl', () => {
  it('uses custom domain when set', () => {
    expect(
      buildTenantAppBaseUrl({ CustomDomain: 'portal.example.com' })
    ).toBe('https://portal.example.com');
  });

  it('uses verified default url path on app host', () => {
    expect(
      buildTenantAppBaseUrl({
        DefaultUrlPath: 'mightywell',
        IsDefaultUrlPathVerified: true
      })
    ).toBe('https://app.allaboard365.com/mightywell');
  });

  it('falls back to app host without path', () => {
    expect(buildTenantAppBaseUrl({})).toBe('https://app.allaboard365.com');
  });
});
