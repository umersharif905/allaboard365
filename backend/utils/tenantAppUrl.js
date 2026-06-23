'use strict';

/**
 * Absolute base URL for the tenant's app (e.g. for in-email deep links into
 * the agent / tenant-admin UI). Same priority order as buildMemberPortalLoginUrl
 * but returns the BASE (no /login or path appended) so callers can append
 * their own deep-link path.
 *
 * 1) Tenant CustomDomain (or AdvancedSettings.domain.customDomain)
 * 2) Verified DefaultUrlPath on the configured app host
 * 3) APP_BASE_URL env var (dev override) or https://app.allaboard365.com
 *
 * NEVER falls back to https://allaboard365.com — that's the marketing site
 * and renders the wrong page when users follow an email deep link.
 *
 * @param {{ CustomDomain?: string|null, DefaultUrlPath?: string|null, IsDefaultUrlPathVerified?: boolean|null, AdvancedSettings?: string|object|null }} tenant
 * @returns {string} base URL with no trailing slash
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
