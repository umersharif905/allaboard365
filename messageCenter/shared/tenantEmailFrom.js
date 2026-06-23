'use strict';

/** Keep in sync with backend/utils/tenantEmailFrom.js */

function platformDefaultFromEmail() {
  return (
    process.env.DEFAULT_FROM_EMAIL ||
    process.env.SENDGRID_FROM_EMAIL ||
    'noreply@allaboard365.com'
  );
}

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

function resolveFromEmailForTenant(emailSettings) {
  if (isTenantEmailSendReady(emailSettings)) {
    return String(emailSettings.customFromAddress).trim();
  }
  return platformDefaultFromEmail();
}

module.exports = {
  platformDefaultFromEmail,
  isTenantEmailSendReady,
  resolveFromEmailForTenant,
};
