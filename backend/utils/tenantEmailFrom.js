'use strict';

/**
 * Platform default outbound email (SendGrid verified on AllAboard365 account).
 * Matches Azure AllAboard365-Backend app setting DEFAULT_FROM_EMAIL.
 */
function platformDefaultFromEmail() {
  return (
    process.env.DEFAULT_FROM_EMAIL ||
    process.env.SENDGRID_FROM_EMAIL ||
    'noreply@allaboard365.com'
  );
}

/**
 * True when tenant AdvancedSettings.email is ready to send from a custom domain address.
 * Requires DKIM enabled, a from address, and verified domain (status or all DNS records).
 */
function isTenantEmailSendReady(email) {
  if (!email || typeof email !== 'object') return false;

  const addr = email.customFromAddress && String(email.customFromAddress).trim();
  if (!addr) return false;
  if (email.dkimEnabled !== true) return false;

  const status = String(
    email.verificationStatus || email.domainStatus || ''
  ).toLowerCase();
  if (status === 'verified') return true;

  const records = email.dnsRecords;
  if (Array.isArray(records) && records.length > 0) {
    return records.every((r) => String(r.status || '').toLowerCase() === 'verified');
  }

  return false;
}

/**
 * Resolve from-address for outbound email for a tenant (or raw email settings object).
 * @param {object|null} emailSettings - AdvancedSettings.email
 * @returns {string}
 */
function resolveFromEmailForTenant(emailSettings) {
  if (isTenantEmailSendReady(emailSettings)) {
    return String(emailSettings.customFromAddress).trim();
  }
  return platformDefaultFromEmail();
}

/**
 * Parse AdvancedSettings JSON and resolve from email.
 * @param {string|object|null} advancedSettingsRaw
 */
function resolveFromEmailFromAdvancedSettings(advancedSettingsRaw) {
  if (!advancedSettingsRaw) return platformDefaultFromEmail();
  try {
    const advanced =
      typeof advancedSettingsRaw === 'string'
        ? JSON.parse(advancedSettingsRaw)
        : advancedSettingsRaw;
    return resolveFromEmailForTenant(advanced?.email);
  } catch {
    return platformDefaultFromEmail();
  }
}

module.exports = {
  platformDefaultFromEmail,
  isTenantEmailSendReady,
  resolveFromEmailForTenant,
  resolveFromEmailFromAdvancedSettings,
};
