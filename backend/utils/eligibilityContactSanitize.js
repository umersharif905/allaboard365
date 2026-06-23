'use strict';

/** Reject street addresses / phones masquerading as email in eligibility exports. */
function isPlausibleEligibilityEmail(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw);
}

function escapeRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strip non-digits so phone-in-address can be compared to Phone column. */
function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function isPhoneLikeAddress(address, phone) {
  const addrDigits = digitsOnly(address);
  const phoneDigits = digitsOnly(phone);
  if (!addrDigits || addrDigits.length < 10) return false;
  if (phoneDigits && addrDigits === phoneDigits) return true;
  // Lone 10–11 digit string with no letters/spaces is almost certainly a phone, not a street.
  return /^[\d]+$/.test(String(address || '').trim()) && addrDigits.length >= 10;
}

/**
 * When Address holds city/state/zip/USA but City/State/Zip columns are populated,
 * keep only the street portion for Tall Tree and similar formats.
 */
function stripCityStateFromAddressLine(address, city, state, zip) {
  let addr = String(address || '').trim();
  if (!addr) return '';

  const cityStr = String(city || '').trim();
  const stateStr = String(state || '').trim();
  const zipStr = String(zip || '').trim().replace(/\D/g, '').slice(0, 5);

  if (cityStr) {
    const cityPat = new RegExp(
      `,\\s*${escapeRegex(cityStr)}(?:\\s*,\\s*${escapeRegex(stateStr)})?(?:\\s*,\\s*${escapeRegex(zipStr)})?(?:\\s*,\\s*USA)?\\s*$`,
      'i'
    );
    addr = addr.replace(cityPat, '').trim();
  }

  if (cityStr && stateStr) {
    const trailPat = new RegExp(
      `\\s+${escapeRegex(cityStr)}\\s+${escapeRegex(stateStr)}(?:\\s+${escapeRegex(zipStr)})?(?:\\s+USA)?\\s*$`,
      'i'
    );
    addr = addr.replace(trailPat, '').trim();
  }

  return addr.replace(/,\s*$/, '').trim();
}

/**
 * Normalize swapped or contaminated address/email/name fields before eligibility CSV output.
 * Mutates record in place (ARM column names: '1st Address Line', 'Email', etc.).
 */
function sanitizeEligibilityContactFields(record) {
  if (!record || typeof record !== 'object') return record;

  let addr = String(record['1st Address Line'] || '').trim();
  let email = String(record.Email || '').trim();
  const city = String(record.City || '').trim();
  const state = String(record.State || '').trim();
  const zip = String(record['Zip Code'] || '').trim();
  const phone = String(record.Phone || record['Phone Number'] || '').trim();

  // Address field holds an email — recover email and clear address.
  if (isPlausibleEligibilityEmail(addr)) {
    if (!isPlausibleEligibilityEmail(email)) {
      email = addr;
    }
    addr = '';
  }

  // Address field holds a phone number (common enrollment typo) — clear address, keep Phone column.
  if (addr && isPhoneLikeAddress(addr, phone)) {
    addr = '';
  }

  // Email field holds a street address or other non-email — never export it as email.
  if (email && !isPlausibleEligibilityEmail(email)) {
    if (!addr && !email.includes('@')) {
      addr = email;
    }
    email = '';
  }

  if (addr && (city || state)) {
    addr = stripCityStateFromAddressLine(addr, city, state, zip);
  }

  for (const field of ['First Name', 'Last Name', 'Middle Initial']) {
    const v = String(record[field] || '').trim();
    if (v && (isPlausibleEligibilityEmail(v) || v.includes('@'))) {
      record[field] = '';
    }
  }

  record['1st Address Line'] = addr;
  record.Email = email;
  return record;
}

module.exports = {
  isPlausibleEligibilityEmail,
  stripCityStateFromAddressLine,
  digitsOnly,
  isPhoneLikeAddress,
  sanitizeEligibilityContactFields,
};
