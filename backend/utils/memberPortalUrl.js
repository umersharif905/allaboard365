'use strict';

/**
 * Absolute member login URL for emails/SMS (matches enrollment-links tenant redirect priority).
 * 1) Tenant CustomDomain (or AdvancedSettings.domain.customDomain)
 * 2) Verified DefaultUrlPath on app.allaboard365.com
 * 3) https://app.allaboard365.com/login
 *
 * @param {{ CustomDomain?: string|null, DefaultUrlPath?: string|null, IsDefaultUrlPathVerified?: boolean|null, AdvancedSettings?: string|object|null }} tenant
 * @returns {string}
 */
function buildMemberPortalLoginUrl(tenant) {
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
    return `https://${customDomain}/login`;
  }
  const pathRaw = tenant?.DefaultUrlPath != null ? String(tenant.DefaultUrlPath).trim() : '';
  const path = pathRaw.replace(/^\/+|\/+$/g, '');
  if (path && tenant?.IsDefaultUrlPathVerified) {
    return `https://app.allaboard365.com/${path}/login`;
  }
  return 'https://app.allaboard365.com/login';
}

module.exports = { buildMemberPortalLoginUrl };
