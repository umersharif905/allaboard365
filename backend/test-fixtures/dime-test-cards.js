/**
 * DIME sandbox test data — extracted verbatim from
 *   - docs/dime-credit-cards/DP_Test_Card_Information (1) (1).xlsx
 *   - docs/dime-credit-cards/HPS+TEST+Hardcode+Values+v04212016 (4) (1).xlsx
 *
 * DIME's sandbox driver returns response codes based on the TRANSACTION
 * AMOUNT (not the card number), so a test that wants to force a "Do Not
 * Honor" decline charges exactly `$10.25`, etc.
 *
 * Keep this file as the single source of truth. Frontend Cypress mirrors
 * the same values in frontend/cypress/fixtures/enrollment/dime-test-data.json.
 */

// ─── Cards (from sheet1 of DP_Test_Card_Information.xlsx) ──────────────────
const TEST_CARDS = {
  visa: {
    brand: 'Visa',
    number: '4012002000060016',
    expMonth: '12',
    expYear: '2030',
    cvv: '123',
    address: '6860 Dallas Pkwy',
    zip: '75024-1234'
  },
  mastercardBin2: {
    // New MasterCard 2-series BIN (2221-2720). Some processors gate these
    // behind a feature flag, so keep it distinct from the legacy 5-BIN.
    brand: 'MasterCard',
    number: '2223000010005780',
    expMonth: '12',
    expYear: '2030',
    cvv: '900',
    address: '6860 Dallas Pkwy',
    zip: '75024'
  },
  mastercard: {
    brand: 'MasterCard',
    number: '5473500000000014',
    expMonth: '12',
    expYear: '2030',
    cvv: '123',
    address: '6860 Dallas Pkwy',
    zip: '75024'
  },
  discover: {
    brand: 'Discover',
    number: '6011000990156527',
    expMonth: '12',
    expYear: '2030',
    cvv: '123',
    address: '6860',
    zip: '75024-1234'
  },
  amex: {
    brand: 'Amex',
    number: '372700699251018',
    expMonth: '12',
    expYear: '2030',
    cvv: '1234', // Amex CVV is 4 digits
    address: '6860',
    zip: '75024'
  },
  jcb: {
    brand: 'JCB',
    number: '3566007770007321',
    expMonth: '12',
    expYear: '2030',
    cvv: '123',
    address: '6860',
    zip: '75024'
  }
};

// ─── ACH (DP ACH processor) ────────────────────────────────────────────────
const TEST_ACH = {
  accountNumber: '1357902468',
  routingNumber: '122000030'
};

// ─── Amount triggers ───────────────────────────────────────────────────────
// These apply to VISA in the sandbox. Exact dollar amount → response code.
// Source: sheet2 of DP_Test_Card_Information.xlsx.
const VISA_AMOUNT_TRIGGERS = {
  '10.01': { code: '04', text: 'HOLD-CALL', comment: 'Retain Card (MC only, but included for parity)' },
  '10.03': { code: '43', text: 'HOLD-CALL', comment: 'Pickup card - Stolen Card' },
  '10.04': { code: '44', text: 'HOLD-CALL' },
  '10.05': { code: 'EB', text: 'CHECK DIGIT ERR' },
  '10.08': { code: '51', text: 'DECLINE', comment: 'Insufficient Funds' },
  '10.09': { code: '61', text: 'DECLINE' },
  '10.10': { code: '62', text: 'DECLINE' },
  '10.11': { code: '65', text: 'DECLINE' },
  '10.16': { code: '52', text: 'NO CHECK ACCOUNT' },
  '10.17': { code: '53', text: 'NO SAVE ACCOUNT' },
  '10.18': { code: '15', text: 'NO SUCH ISSUER' },
  '10.19': { code: '63', text: 'SEC VIOLATION' },
  '10.20': { code: 'R1', text: 'STOP RECURRING', comment: 'Revoke future auth' },
  '10.21': { code: '96', text: 'SYSTEM ERROR' },
  '10.22': { code: '03', text: 'TERM ID ERROR' },
  '10.23': { code: 'N7', text: 'CVV2 MISMATCH' },
  '10.25': { code: '05', text: 'DECLINE', comment: 'Do Not Honor' },
  '10.26': { code: '12', text: 'INVALID TRANS' },
  '10.28': { code: '14', text: 'CARD NO. ERROR' },
  '10.29': { code: '19', text: 'RE ENTER' },
  '10.30': { code: '58', text: 'SERV NOT ALLOWED' },
  '10.31': { code: '41', text: 'HOLD-CALL', comment: 'Pickup card - Lost Card' },
  '10.32': { code: '54', text: 'EXPIRED CARD' },
  '10.33': { code: '91', text: 'NO REPLY' },
  '10.34': { code: '02', text: 'CALL' },
  '10.35': { code: 'R0', text: 'STOP PAYMENT', comment: 'Stop a specific recurring payment' },
  '10.36': { code: 'R3', text: 'STOP ALL RECURR', comment: 'Cancel all recurring for this card' }
};

// MasterCard-specific extras from sheet3 (most overlap with Visa, listed here
// only for the codes that DON'T appear in the Visa sheet).
const MASTERCARD_EXTRA_TRIGGERS = {
  '10.01': { code: '04', text: 'HOLD-CALL', comment: 'Retain Card' },
  '10.06': { code: 'EC', text: 'CID FORMAT ERROR' },
  '10.14': { code: '14', text: 'CARD NO ERROR', comment: 'Card No Error (distinct from 10.28)' },
  '10.19': { code: '63', text: 'SEC VIOLATION' }
};

// Back-compat alias. Old specs import `AMOUNT_TRIGGERS` — keep that name
// pointing at VISA_AMOUNT_TRIGGERS so existing imports don't break.
const AMOUNT_TRIGGERS = VISA_AMOUNT_TRIGGERS;

// ─── AVS / HPS hardcode values (Heartland) ─────────────────────────────────
// sheet1 of HPS+TEST+Hardcode+Values+v04212016.xlsx — amounts 91.01..91.07
// return status_code=00 with a specific AVS result code. Used when you want
// an approved charge that exercises AVS response handling.
const AVS_AMOUNT_TRIGGERS = {
  '91.01': { code: '00', avs: 'B' },
  '91.02': { code: '00', avs: 'C' },
  '91.03': { code: '00', avs: 'D' },
  '91.05': { code: '00', avs: 'I' },
  '91.06': { code: '00', avs: 'M' },
  '91.07': { code: '00', avs: 'P' }
};

// ─── Member + dependent shapes ─────────────────────────────────────────────
const NEW_MEMBER = {
  firstName: 'Test',
  lastName: 'Enrollee',
  dateOfBirth: '1990-01-15',
  gender: 'M',
  email: null,
  phone: '555-123-4567',
  ssn: '123-45-6789',
  tobaccoUse: 'No'
};

const SPOUSE_DEPENDENT = {
  firstName: 'Test',
  lastName: 'Spouse',
  dateOfBirth: '1991-03-22',
  gender: 'F',
  relationship: 'S',
  email: 'test.spouse@example.com',
  tobaccoUse: 'No'
};

const CHILD_DEPENDENT = {
  firstName: 'Test',
  lastName: 'Child',
  dateOfBirth: '2015-06-10',
  gender: 'M',
  relationship: 'C',
  tobaccoUse: 'No'
};

function uniqueEmail(prefix = 'test') {
  return `${prefix}+${Date.now()}.${process.pid}@example.com`;
}

module.exports = {
  TEST_CARDS,
  TEST_ACH,
  AMOUNT_TRIGGERS, // alias → VISA_AMOUNT_TRIGGERS (back-compat)
  VISA_AMOUNT_TRIGGERS,
  MASTERCARD_EXTRA_TRIGGERS,
  AVS_AMOUNT_TRIGGERS,
  NEW_MEMBER,
  SPOUSE_DEPENDENT,
  CHILD_DEPENDENT,
  uniqueEmail
};
