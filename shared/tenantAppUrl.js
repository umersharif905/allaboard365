'use strict';

/**
 * Absolute base URL for the tenant app (agent / member UI deep links).
 * Mirrors backend/utils/tenantAppUrl.js.
 */
function buildTenantAppBaseUrl(tenant) {
  let advanced = {};
  if (tenant?.AdvancedSettings) {
    try {
      advanced =
        typeof tenant.AdvancedSettings === 'string'
          ? JSON.parse(tenant.AdvancedSettings)
          : tenant.AdvancedSettings;
    } catch {
      advanced = {};
    }
  }
  const customDomain = String(tenant?.CustomDomain || advanced?.domain?.customDomain || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .split('/')[0];
  if (customDomain) {
    return `https://${customDomain}`;
  }
  const fallback = (process.env.APP_BASE_URL || 'https://app.allaboard365.com').replace(/\/+$/, '');
  const pathRaw = tenant?.DefaultUrlPath != null ? String(tenant.DefaultUrlPath).trim() : '';
  const path = pathRaw.replace(/^\/+|\/+$/g, '');
  if (path && tenant?.IsDefaultUrlPathVerified) {
    return `${fallback}/${path}`;
  }
  return fallback;
}

module.exports = { buildTenantAppBaseUrl };
