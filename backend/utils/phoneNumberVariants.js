'use strict';

/**
 * Build phone variants for DB matching (same rules as webhooks/twilio-sms.js).
 * @param {string} phone
 * @returns {string[]}
 */
function buildPhoneNumberVariants(phone) {
  if (!phone) return [];
  let cleaned = String(phone).replace(/[^\d+]/g, '');
  if (!cleaned) return [];

  const variants = [];

  if (cleaned.startsWith('+')) {
    variants.push(cleaned);
    if (cleaned.startsWith('+1')) {
      variants.push(cleaned.substring(2));
      variants.push('1' + cleaned.substring(2));
    }
  } else if (cleaned.startsWith('1') && cleaned.length === 11) {
    variants.push('+' + cleaned);
    variants.push(cleaned);
    variants.push(cleaned.substring(1));
  } else {
    variants.push(cleaned);
    variants.push('+1' + cleaned);
    variants.push('1' + cleaned);
  }

  return [...new Set(variants.filter(Boolean))];
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function looksLikeEmail(identifier) {
  return String(identifier || '').includes('@');
}

module.exports = {
  buildPhoneNumberVariants,
  normalizeEmail,
  looksLikeEmail,
};
