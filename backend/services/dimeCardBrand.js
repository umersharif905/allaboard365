/**
 * Maps card-validator / credit-card-type networks to DIME `cc_brand` strings.
 * DIME expects exact strings, e.g. Visa, MasterCard, Amex (not AmEx — see DIME API docs).
 */
const cardValidator = require('card-validator');

/** @type {Record<string, string>} */
const VALIDATOR_TYPE_TO_DIME = {
  visa: 'Visa',
  mastercard: 'MasterCard',
  'american-express': 'Amex',
  discover: 'Discover',
  jcb: 'JCB',
  'diners-club': 'Diners'
};

/**
 * Normalize PAN: digits only.
 * @param {string} [cardNumber]
 * @returns {string}
 */
function normalizePan(cardNumber) {
  return String(cardNumber || '').replace(/\D/g, '');
}

/**
 * Map credit-card-type type string to DIME cc_brand, or null if unsupported by DIME.
 * @param {string} [validatorType]
 * @returns {string|null}
 */
function mapValidatorTypeToDime(validatorType) {
  if (!validatorType) return null;
  return VALIDATOR_TYPE_TO_DIME[validatorType] || null;
}

/**
 * Map UI / DB labels to DIME cc_brand when full PAN is unavailable.
 * @param {string} [label]
 * @returns {string|null}
 */
function mapDisplayBrandToDime(label) {
  if (!label || typeof label !== 'string') return null;
  const t = label.trim();
  const lower = t.toLowerCase();
  if (lower === 'visa') return 'Visa';
  if (lower === 'mastercard' || lower === 'master card') return 'MasterCard';
  if (lower === 'american express' || lower === 'amex') return 'Amex';
  if (lower === 'discover') return 'Discover';
  if (lower === 'jcb') return 'JCB';
  if (lower === 'diners' || lower === 'diners club' || lower === 'diners-club') return 'Diners';
  return null;
}

/**
 * Resolve DIME cc_brand from PAN using card-validator.
 * @param {string} normalizedPan - digits only
 * @returns {{ brand: string|null, code: string, validatorType?: string, message?: string }}
 */
function getDimeCcBrandFromPan(normalizedPan) {
  if (!normalizedPan) {
    return { brand: null, code: 'EMPTY', message: 'Card number is required' };
  }
  const validation = cardValidator.number(normalizedPan);
  const validatorType = validation.card && validation.card.type;
  const mapped = mapValidatorTypeToDime(validatorType);

  if (mapped) {
    return { brand: mapped, code: 'OK', validatorType };
  }

  if (validatorType) {
    return {
      brand: null,
      code: 'UNSUPPORTED',
      validatorType,
      message: `Card type "${validatorType}" is not supported for this payment processor`
    };
  }

  if (normalizedPan.length < 13) {
    return { brand: null, code: 'INCOMPLETE', message: 'Card number is incomplete' };
  }

  return {
    brand: null,
    code: 'UNKNOWN',
    message: 'Could not determine card type from card number'
  };
}

/**
 * Same as getDimeCcBrandFromPan but returns only the DIME string or null (for callers that need a simple value).
 * @param {string} [cardNumber] - raw or formatted PAN
 * @returns {string|null}
 */
function getCardBrandOrNull(cardNumber) {
  const normalized = normalizePan(cardNumber);
  const r = getDimeCcBrandFromPan(normalized);
  return r.brand;
}

module.exports = {
  normalizePan,
  mapValidatorTypeToDime,
  mapDisplayBrandToDime,
  getDimeCcBrandFromPan,
  getCardBrandOrNull,
  VALIDATOR_TYPE_TO_DIME
};
