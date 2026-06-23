/**
 * ACH routing normalization for charges (DIME/NACHA).
 * RoutingNumber column is often correct while RoutingNumberEncrypted can decrypt to a bad value
 * (wrong key/version, corrupted blob). US ABA 9-digit checksum picks the trustworthy source.
 */
const encryptionService = require('../services/encryptionService');

function normalizeRoutingNineDigits(value) {
  if (value == null || value === undefined) return null;
  const d = String(value).replace(/\D/g, '');
  return d.length === 9 ? d : null;
}

function isAbaRoutingChecksumValid(nineDigit) {
  if (!nineDigit || nineDigit.length !== 9 || !/^\d{9}$/.test(nineDigit)) return false;
  const digits = nineDigit.split('').map(Number);
  const checksum =
    (3 * (digits[0] + digits[3] + digits[6]) +
      7 * (digits[1] + digits[4] + digits[7]) +
      (digits[2] + digits[5] + digits[8])) %
    10;
  return checksum === 0;
}

/** Try decrypt (AES iv:tag:data), then legacy smart decode same as stored account payloads. */
function tryDecryptRoutingFromEncrypted(routingNumberEncrypted) {
  if (!routingNumberEncrypted || String(routingNumberEncrypted).trim() === '') return null;
  const blob = String(routingNumberEncrypted).trim();
  try {
    const dec = encryptionService.decryptPaymentData({ routingNumberEncrypted: blob });
    const n = normalizeRoutingNineDigits(dec?.routingNumber);
    if (n) return n;
  } catch (_e) {
    // Wrong key / not AES — try legacy handlers on raw column
  }
  try {
    const legacy = encryptionService.smartDecryptAccountNumber(blob);
    return normalizeRoutingNineDigits(legacy);
  } catch (_e2) {
    return null;
  }
}

/**
 * Prefer a routing that passes ABA checksum when plaintext and ciphertext disagree.
 * @param {string|null|undefined} routingPlain - oe.*.RoutingNumber column
 * @param {string|null|undefined} routingEncrypted - oe.*.RoutingNumberEncrypted
 * @returns {string|null} 9 digits or null
 */
function resolveAchRoutingForCharge(routingPlain, routingEncrypted) {
  const fromColumn = normalizeRoutingNineDigits(routingPlain);
  const fromEncrypted = tryDecryptRoutingFromEncrypted(routingEncrypted);

  const columnValid = fromColumn && isAbaRoutingChecksumValid(fromColumn) ? fromColumn : null;
  const encryptedValid = fromEncrypted && isAbaRoutingChecksumValid(fromEncrypted) ? fromEncrypted : null;

  if (columnValid && encryptedValid && columnValid !== encryptedValid) {
    return columnValid;
  }
  if (columnValid) return columnValid;
  if (encryptedValid) return encryptedValid;

  return fromColumn || fromEncrypted || null;
}

module.exports = {
  normalizeRoutingNineDigits,
  isAbaRoutingChecksumValid,
  resolveAchRoutingForCharge,
  tryDecryptRoutingFromEncrypted,
};
