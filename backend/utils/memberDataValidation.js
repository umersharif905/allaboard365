/**
 * Shared member-data validators + normalizers.
 *
 * Single source of truth for what a valid ZIP / TobaccoUse / SSN looks like on
 * oe.Members. Backend write paths (agent Add Member, bulk sheet upload, member
 * self-edit, enrollment completion) should run payload through `validateMemberPayload`
 * or call the individual normalizers before INSERT/UPDATE so that downstream UIs
 * (enrollment wizard, member portal) don't break on malformed data.
 *
 * Written 2026-04-16 after a prod incident: a member (David Broom / Powerlink
 * Technologies) was prefilled with Zip='30047-4629' (ZIP+4) and TobaccoUse='U'.
 * The wizard's 5-digit-only ZIP check rejected him and the Y/N-only tobacco
 * dropdown rendered in an inconsistent state. Continue button grayed out.
 */

'use strict';

const {
  isPlausibleEligibilityEmail,
  stripCityStateFromAddressLine,
  isPhoneLikeAddress,
} = require('./eligibilityContactSanitize');

class MemberDataValidationError extends Error {
  constructor(fields) {
    const msg = Array.isArray(fields) && fields.length
      ? `Invalid member data: ${fields.map((f) => `${f.field} (${f.reason})`).join(', ')}`
      : 'Invalid member data';
    super(msg);
    this.name = 'MemberDataValidationError';
    this.fields = Array.isArray(fields) ? fields : [];
    this.statusCode = 400;
  }
}

/**
 * Normalize a ZIP input to the 5-digit form we store on oe.Members.
 * Accepts either 5-digit ("30047") or 9-digit ZIP+4 ("30047-4629" or "300474629").
 * Returns the first 5 digits.
 *
 * @param {unknown} raw - any input from a form field
 * @returns {string|null} 5-digit ZIP, or null when input is missing/unparseable
 */
function normalizeZip(raw) {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 5 || digits.length === 9) return digits.slice(0, 5);
  return null;
}

/**
 * @param {unknown} raw
 * @returns {boolean}
 */
function isValidZip(raw) {
  return normalizeZip(raw) !== null;
}

/**
 * Normalize TobaccoUse to the two values supported downstream: 'Y' or 'N'.
 * 'U' and any blank/unknown input coerce to 'N' (the conservative default).
 * This stops the wizard dropdown from rendering in an inconsistent state
 * (value='U' but options only include Y/N).
 *
 * @param {unknown} raw
 * @returns {'Y'|'N'}
 */
function normalizeTobaccoUse(raw) {
  const s = String(raw ?? '').trim().toUpperCase();
  if (s === 'Y' || s === 'YES' || s === 'TRUE' || s === '1') return 'Y';
  return 'N';
}

/**
 * @param {unknown} raw
 * @returns {boolean}
 */
function isValidSSN(raw) {
  if (raw == null) return false;
  const digits = String(raw).replace(/\D/g, '');
  return digits.length === 9;
}

/**
 * @param {unknown} raw
 * @returns {string|null} 9-digit SSN without hyphens, or null when invalid/missing
 */
function normalizeSSN(raw) {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, '');
  return digits.length === 9 ? digits : null;
}

/**
 * Reject email, phone-only, or date-like values in oe.Members.Address.
 * Optionally strip trailing city/state/zip when separate columns are present.
 *
 * @returns {{ address: string|null, error: { field: string, reason: string }|null }}
 */
function normalizeStreetAddress(rawAddress, { city, state, zip, phone } = {}) {
  if (rawAddress == null || String(rawAddress).trim() === '') {
    return { address: null, error: null };
  }

  let address = String(rawAddress).trim();

  if (isPlausibleEligibilityEmail(address)) {
    return { address: null, error: { field: 'Address', reason: 'must be a street address, not an email' } };
  }

  if (isPhoneLikeAddress(address, phone)) {
    return { address: null, error: { field: 'Address', reason: 'must be a street address, not a phone number' } };
  }

  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(address)) {
    return { address: null, error: { field: 'Address', reason: 'must be a street address, not a date' } };
  }

  if (!/[a-zA-Z]/.test(address)) {
    return { address: null, error: { field: 'Address', reason: 'must include a street name' } };
  }

  if (city || state || zip) {
    address = stripCityStateFromAddressLine(address, city, state, zip);
  }

  address = address.replace(/,\s*$/, '').trim();
  if (!address) {
    return { address: null, error: { field: 'Address', reason: 'must include a street name' } };
  }

  return { address, error: null };
}

/**
 * Normalize memberInfo.address during enrollment when a value was submitted.
 * Returns HTTP-friendly error object or updated memberInfo.
 */
function sanitizeMemberInfoAddress(memberInfo) {
  if (!memberInfo || memberInfo.address == null || String(memberInfo.address).trim() === '') {
    return { memberInfo, error: null };
  }
  const { address, error } = normalizeStreetAddress(memberInfo.address, {
    city: memberInfo.city,
    state: memberInfo.state,
    zip: memberInfo.zip,
    phone: memberInfo.phone,
  });
  if (error) {
    return { memberInfo, error };
  }
  return { memberInfo: { ...memberInfo, address }, error: null };
}

/**
 * Validate a member-shape payload headed for oe.Members INSERT/UPDATE.
 *
 * @param {Object} payload - partial member fields from an HTTP request
 * @param {Object} [options]
 * @param {boolean} [options.requireSSN=true] - SSN is required for individual/agent flows
 *   (set false ONLY for legacy bulk paths that provide SSN later)
 * @returns {{ normalized: Object, errors: Array<{field:string,reason:string}> }}
 *
 * Does NOT mutate `payload`. Returns a new object with normalized fields that
 * callers can spread into their SQL parameter bindings.
 */
function validateMemberPayload(payload, options = {}) {
  const { requireSSN = true } = options;
  const errors = [];
  const normalized = { ...payload };

  if (payload.Zip !== undefined || payload.zip !== undefined) {
    const raw = payload.Zip ?? payload.zip;
    const zip = normalizeZip(raw);
    if (!zip) {
      errors.push({ field: 'Zip', reason: 'must be a 5- or 9-digit US ZIP code' });
    } else {
      normalized.Zip = zip;
      if ('zip' in normalized) normalized.zip = zip;
    }
  }

  if (payload.TobaccoUse !== undefined || payload.tobaccoUse !== undefined) {
    const raw = payload.TobaccoUse ?? payload.tobaccoUse;
    const t = normalizeTobaccoUse(raw);
    normalized.TobaccoUse = t;
    if ('tobaccoUse' in normalized) normalized.tobaccoUse = t;
  }

  const ssnRaw = payload.SSN ?? payload.ssn;
  if (ssnRaw !== undefined && ssnRaw !== null && String(ssnRaw).trim() !== '') {
    const ssn = normalizeSSN(ssnRaw);
    if (!ssn) {
      errors.push({ field: 'SSN', reason: 'must be 9 digits' });
    } else {
      normalized.SSN = ssn;
      if ('ssn' in normalized) normalized.ssn = ssn;
    }
  } else if (requireSSN) {
    errors.push({ field: 'SSN', reason: 'required' });
  }

  if (payload.Address !== undefined || payload.address !== undefined) {
    const rawAddress = payload.Address ?? payload.address;
    const city = payload.City ?? payload.city;
    const state = payload.State ?? payload.state;
    const zip = payload.Zip ?? payload.zip;
    const phone = payload.PhoneNumber ?? payload.phoneNumber ?? payload.phone;
    const { address, error } = normalizeStreetAddress(rawAddress, { city, state, zip, phone });
    if (error) {
      errors.push(error);
    } else {
      if ('Address' in normalized || payload.Address !== undefined) normalized.Address = address;
      if ('address' in normalized || payload.address !== undefined) normalized.address = address;
    }
  }

  return { normalized, errors };
}

module.exports = {
  MemberDataValidationError,
  normalizeZip,
  isValidZip,
  normalizeTobaccoUse,
  isValidSSN,
  normalizeSSN,
  normalizeStreetAddress,
  sanitizeMemberInfoAddress,
  validateMemberPayload,
};
