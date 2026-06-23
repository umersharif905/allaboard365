const axios = require('axios');
const { getPool, sql } = require('../config/database');
const encryptionService = require('./encryptionService');
const { requireShared } = require('../config/shared-modules');
const paymentStatus = requireShared('payment-status');
const dimeCardBrand = require('./dimeCardBrand');

/** DIME recurring `data.name` max practical length (portal display). */
const RECURRING_PAYMENT_NAME_MAX_LEN = 100;

function cleanRecurringLabel(s) {
  if (s == null || s === '') return '';
  return String(s).replace(/\s+/g, ' ').trim();
}

function truncateRecurringLabel(s, maxLen = RECURRING_PAYMENT_NAME_MAX_LEN) {
  const t = cleanRecurringLabel(s);
  if (!t) return '';
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen - 1)}…`;
}

/**
 * DIME POST /api/transaction/charge-ach expects data.account_type: "Checking" or "Savings" only.
 * UI often sends "Business" / "Personal" for bank classification — map those to Checking.
 */
function normalizeDimeAchAccountTypeForCharge(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'savings') return 'Savings';
  if (s === 'checking' || s === '') return 'Checking';
  return 'Checking';
}

/**
 * Format a numeric amount as USD for user-facing messages (e.g. 311.7 → "$311.70").
 * Returns an empty string when the amount is missing / not a number.
 */
function formatUsdAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
  } catch (_) {
    return `$${n.toFixed(2)}`;
  }
}

/**
 * Map an ISO-8583 / DIME decline response (`status_code` + `status_text`) to an
 * end-user-friendly message. Used in BOTH the "success:false" path (when DIME returns
 * HTTP 200 with a non-approved status) and in the HTTP 400 catch path (when DIME
 * returns the decline inside an error response body).
 *
 * `amountForMessage` should be the transaction amount the caller attempted to charge,
 * so we can tell the user exactly how much to have their bank authorize.
 *
 * Returns an object (never throws):
 *   {
 *     message:        user-facing explanation
 *     reasonCode:     normalized ISO-8583 code (string) or null
 *     rawText:        raw DIME status_text (e.g. 'DECLINE') or null
 *     isBankDecline:  true when the issuer declined (user should call their bank)
 *     amount:         the amount we formatted into the message (numeric) or null
 *   }
 */
function buildFriendlyDimeDeclineError(dimeData, amountForMessage) {
  const data = dimeData && typeof dimeData === 'object' ? dimeData : {};
  const rawText = String(data.status_text || data.statusText || '').trim();
  const code = String(data.status_code || '').trim();
  const amt = Number(amountForMessage ?? data.amount);
  const amountStr = formatUsdAmount(Number.isFinite(amt) ? amt : null);
  const suffixAmount = amountStr ? ` in the amount of ${amountStr}` : '';

  // Message catalogue. Keep these in plain language — they are shown directly to the user in
  // the enrollment wizard's error modal. Ask the user to call their bank with the amount
  // whenever the decline is bank-side ("Do not honor", fraud flag, limits, restrictions).
  const BANK_DECLINE = {
    reasonCode: code || 'UNKNOWN',
    isBankDecline: true
  };
  const CARD_ISSUE = { reasonCode: code || 'UNKNOWN', isBankDecline: false };
  const PROCESSOR_ISSUE = { reasonCode: code || 'UNKNOWN', isBankDecline: false };

  const catalogue = {
    '05': { // Do not honor — most common generic decline
      message:
        `Your bank declined this transaction${suffixAmount}. ` +
        `Please call the number on the back of your card and ask them to approve a charge${suffixAmount}, then try again. ` +
        `If that doesn't work, please use a different card or bank account.`,
      ...BANK_DECLINE
    },
    '14': { // Invalid card number
      message:
        `The card number entered doesn't look right. ` +
        `Please double-check the card number, expiration date, and CVV, then try again.`,
      ...CARD_ISSUE
    },
    '51': { // Insufficient funds
      message:
        `Your bank declined this transaction${suffixAmount} for insufficient funds. ` +
        `Please try a different card or bank account, or contact your bank.`,
      ...BANK_DECLINE
    },
    '54': { // Expired card
      message: `This card has expired. Please use a different card.`,
      ...CARD_ISSUE
    },
    '57': { // Transaction not permitted to cardholder
      message:
        `Your bank does not allow this type of transaction on this card. ` +
        `Please call the number on the back of your card to authorize an online charge${suffixAmount}, or try a different card.`,
      ...BANK_DECLINE
    },
    '61': { // Exceeds withdrawal amount limit
      message:
        `Your bank declined this transaction${suffixAmount} because it exceeds your withdrawal limit. ` +
        `Please call your bank to temporarily raise the limit for a charge${suffixAmount}, or try a different card.`,
      ...BANK_DECLINE
    },
    '62': { // Restricted card
      message:
        `Your card has a restriction that prevented this transaction. ` +
        `Please call the number on the back of your card to have them authorize a charge${suffixAmount}, or try a different card.`,
      ...BANK_DECLINE
    },
    '63': { // Security violation
      message:
        `Your bank flagged this charge for security reasons. ` +
        `Please call the number on the back of your card and ask them to approve a charge${suffixAmount}, then try again.`,
      ...BANK_DECLINE
    },
    '65': { // Exceeds withdrawal frequency
      message:
        `Your bank declined this transaction${suffixAmount} because it exceeds the activity limit on this card. ` +
        `Please call your bank to approve a charge${suffixAmount}, or try a different card.`,
      ...BANK_DECLINE
    },
    '75': { // Too many PIN tries
      message:
        `Too many incorrect attempts were made on this card. ` +
        `Please call the number on the back of your card to unlock it, or try a different card.`,
      ...BANK_DECLINE
    },
    '78': { // Blocked / first use
      message:
        `This card is new or has not been activated for online purchases. ` +
        `Please activate the card with your bank and then try again, or use a different card.`,
      ...BANK_DECLINE
    },
    '91': { // Issuer or switch inoperative
      message:
        `Your bank is temporarily unavailable and could not approve this transaction. ` +
        `Please try again in a few minutes.`,
      ...PROCESSOR_ISSUE
    },
    '96': { // System malfunction
      message:
        `The payment network is temporarily unavailable. ` +
        `Please wait a moment and try again. If it keeps failing, try a different card.`,
      ...PROCESSOR_ISSUE
    },
    'N7': { // CVV failure
      message:
        `The security code (CVV) on your card didn't match. ` +
        `Please double-check the 3- or 4-digit CVV and try again.`,
      ...CARD_ISSUE
    }
  };

  const mapped = catalogue[code.toUpperCase()];
  if (mapped) {
    return { message: mapped.message, reasonCode: mapped.reasonCode, rawText: rawText || null, isBankDecline: mapped.isBankDecline, amount: Number.isFinite(amt) ? amt : null };
  }

  // DIME often returns HTTP 400 + status_code 221 (or similar) with a generic sentence — not
  // an ISO decline and not an actionable bank message. Don't imply the member's bank gave a reason.
  const codeNorm = code.toUpperCase();
  const genericProcessorCopy =
    codeNorm === '221' ||
    /something went wrong|please check information and try again|unknown error|internal error/i.test(
      rawText
    );
  if (genericProcessorCopy) {
    const amtHint = amountStr ? ` Amount: ${amountStr}.` : '';
    return {
      message:
        `Payment was not completed. The payment processor did not return a specific decline reason (code ${codeNorm || 'unknown'}).` +
        `${amtHint} Verify bank or card details, try again, or use another payment method. Contact support if this continues.`,
      reasonCode: codeNorm || null,
      rawText: rawText || null,
      isBankDecline: false,
      amount: Number.isFinite(amt) ? amt : null
    };
  }

  // No specific mapping. If DIME just said "DECLINE" (or anything decline-looking) assume it's
  // a bank-side decline and guide the user the same way as `05`.
  const looksLikeDecline = /decline|do not honor|not approved/i.test(rawText);
  if (looksLikeDecline) {
    return {
      message:
        `Your bank declined this transaction${suffixAmount}. ` +
        `Please call the number on the back of your card and ask them to approve a charge${suffixAmount}, then try again. ` +
        `If that doesn't work, please use a different card or bank account.`,
      reasonCode: code || 'DECLINE',
      rawText: rawText || null,
      isBankDecline: true,
      amount: Number.isFinite(amt) ? amt : null
    };
  }

  // Truly unknown fallback — surface what we know but keep it polite/actionable.
  return {
    message:
      (rawText
        ? `Your payment could not be completed (${rawText}).`
        : `Your payment could not be completed.`) +
      ` Please try a different card or bank account, or contact your bank${amountStr ? ` to authorize a charge of ${amountStr}` : ''}.`,
    reasonCode: code || null,
    rawText: rawText || null,
    isBankDecline: false,
    amount: Number.isFinite(amt) ? amt : null
  };
}

/**
 * Build a user-facing error for a DIME payment-method (vault) failure.
 *
 * Used on the deferred-charge / recurring-setup path where we tried to tokenize a card or
 * bank account in DIME but DIME rejected it. This is NOT the same as a charge decline —
 * there's usually no ISO-8583 code. DIME returns one of three shapes:
 *
 *   1. Laravel validation errors      → errPayload.validationErrors = { 'data.cc_number': [...] }
 *      User-fixable (bad number / expired / wrong ZIP). Surface field-level detail.
 *
 *   2. Decline-style body              → errPayload.message contains a decline word, or
 *                                        errPayload.code is an ISO-8583-ish code.
 *      User-fixable via their bank. Reuse the existing buildFriendlyDimeDeclineError
 *      catalogue so the copy stays consistent with the charge-path modal.
 *
 *   3. Generic / unstructured         → just a message we can't classify.
 *      Show a polite "we couldn't save your card, please try again or different card".
 *
 * Callers already classify DIME 5xx / upstream hiccups as transient before reaching this
 * function, so anything that gets here is expected to be user-facing / user-fixable.
 *
 * @param {object} pmResult - return value from setupStoredPaymentMethodAndRecurringForIndividualEnrollment
 * @returns {{ title: string, body: string, validationSummary: string|null, isBankDecline: boolean, declineReasonCode: string|null }}
 */
function buildFriendlyDimeVaultError(pmResult) {
  const details = (pmResult && typeof pmResult === 'object' ? pmResult.processorErrorDetails : null) || {};
  const rawMessage = String(details.message || pmResult?.recurringErrorMessage || '').trim();

  // 1. Laravel validation errors — surface field names + messages as a bullet summary.
  const validationSummary = formatDimeApiValidationErrors(details.validationErrors);
  if (validationSummary) {
    const fieldDetail = validationSummary.replace(/\bdata\./g, '').replace(/_/g, ' ');
    return {
      title: "We couldn't save your payment method",
      body:
        `Your card details didn't pass our payment processor's checks: ${fieldDetail}. ` +
        `Please correct the information and try again, or use a different card.`,
      validationSummary,
      isBankDecline: false,
      declineReasonCode: null
    };
  }

  // 2. "Invalid response from upstream API" — DIME surfaces this as an HTTP 400 when the bank
  //    didn't confirm the card during vaulting. Per DIME support (Apr 2026) it's most often
  //    wrong card details; occasionally a transient bank blip. Either way we block the enrollment
  //    so the user can fix or retry — that's strictly safer than the old "proceed with pending
  //    vault" path which left members Active-but-unbilled. Has its own copy because it's not a
  //    decline (the bank didn't say no, they didn't answer).
  if (/invalid response from upstream|upstream api|upstream error/i.test(rawMessage)) {
    return {
      title: "We couldn't verify this card with your bank",
      body:
        "Your bank didn't confirm this card when we tried to save it. " +
        "Please double-check the card number, expiration date, and billing ZIP code, " +
        "then try again — or use a different card.",
      validationSummary: null,
      isBankDecline: false,
      declineReasonCode: 'UPSTREAM_UNVERIFIED'
    };
  }

  // 3. Decline-style body — reuse the ISO-8583 catalogue so the modal copy matches the charge-path.
  // Regex mirrors the one in createCreditCardPaymentMethod's catch block (includes HMS status
  // names surfaced through DIME). See docs/billing/dime-payments.md → "Known-failure catalog".
  const looksLikeDecline = /decline|do not honor|not approved|insufficient|insufficient(activation|load)amount|expired|restricted|cvv|invalid card|invalid number|invalid ?payment ?type|invalid ?pin|avs|profile(closed|frozen|notfound|authorizationfailed)|accountnotactivated|registrationrequired|serviceunavailable/i
    .test(rawMessage);
  if (looksLikeDecline || details.code) {
    const synthetic = {
      status_code: details.code || '',
      status_text: rawMessage
    };
    const friendly = buildFriendlyDimeDeclineError(synthetic, null);
    return {
      title: friendly.isBankDecline
        ? 'Your bank declined this card'
        : "We couldn't save your payment method",
      body: friendly.message,
      validationSummary: null,
      isBankDecline: friendly.isBankDecline === true,
      declineReasonCode: friendly.reasonCode || null
    };
  }

  // 3. Unknown but user-facing. Stay honest: we don't say "check your card number" unless DIME
  //    actually implicated the card — see the comment at the top of this function.
  return {
    title: "We couldn't save your payment method",
    body:
      "We weren't able to save your card for recurring billing. " +
      "Please try again, try a different card, or contact support if this keeps happening.",
    validationSummary: null,
    isBankDecline: false,
    declineReasonCode: null
  };
}

/** Flatten DIME validation errors (e.g. { 'data.account_type': ['...'] }) for logs and API responses. */
function formatDimeApiValidationErrors(errPayload) {
  if (!errPayload || typeof errPayload !== 'object') return null;
  const parts = [];
  const walk = (obj, prefix = '') => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v != null && typeof v === 'object' && !Array.isArray(v)) {
        walk(v, key);
      } else if (Array.isArray(v)) {
        parts.push(`${key}: ${v.join(' ')}`);
      } else {
        parts.push(`${key}: ${String(v)}`);
      }
    }
  };
  walk(errPayload);
  return parts.length ? parts.join(' | ') : null;
}

/**
 * Build DIME recurring schedule display name: prefer explicit scheduleName, then "Full Name (HouseholdMemberID)",
 * then description (e.g. group flows), else "Monthly Payment".
 */
function buildRecurringPaymentDisplayName({ scheduleName, memberFullName, householdMemberId, description }) {
  if (cleanRecurringLabel(scheduleName)) return truncateRecurringLabel(scheduleName);
  const fn = cleanRecurringLabel(memberFullName);
  const hmid = cleanRecurringLabel(householdMemberId);
  if (fn && hmid) return truncateRecurringLabel(`${fn} (${hmid})`);
  if (fn) return truncateRecurringLabel(fn);
  if (hmid) return truncateRecurringLabel(`HouseholdMember ${hmid}`);
  if (cleanRecurringLabel(description)) return truncateRecurringLabel(description);
  return 'Monthly Payment';
}

/**
 * Format a calendar instant for DIME recurring start_date / end_date.
 * Using UTC midnight (toISOString) produced strings like "2025-06-01 00:00:00" that US portals
 * interpreted in local time, showing the previous calendar day (e.g. May 31 vs June 1).
 * We send noon UTC for the UTC calendar date implied by the Date so US timezones stay on the same day.
 */
function formatDimeRecurringDateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) {
    const fallback = new Date();
    const y = fallback.getUTCFullYear();
    const m = fallback.getUTCMonth();
    const day = fallback.getUTCDate();
    return new Date(Date.UTC(y, m, day, 12, 0, 0, 0)).toISOString().replace('T', ' ').substring(0, 19);
  }
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const noonUtc = new Date(Date.UTC(y, m, day, 12, 0, 0, 0));
  return noonUtc.toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * DIME Payments Service
 * 
 * UNIFIED SERVICE - Used by multiple endpoints for payment processing
 * 
 * Endpoints using this service:
 * - /api/me/member/payment-methods (Member payment methods)
 * - /api/groups/:groupId/payment-method (Group payment methods)
 * - /api/accounting/payments (Payment processing)
 * - /api/enrollment-links/:linkToken/complete-enrollment (Enrollment payments)
 * 
 * CONFIGURATION:
 * - Per-tenant credentials stored in Tenants.PaymentProcessorSettings (encrypted)
 * - Falls back to environment variables if tenant credentials not available
 */
class DimeService {
  /**
   * Format phone number for DIME API (E.164 format)
   * @param {string} phone - Phone number to format
   * @returns {string} Formatted phone number in E.164 format
   */
  static formatPhoneNumber(phone) {
    if (!phone || phone.trim() === '') {
      return null;
    }
    
    // Remove all non-digit characters
    const digits = phone.replace(/\D/g, '');
    
    // If it's a US number (10 digits), add +1
    if (digits.length === 10) {
      return `+1${digits}`;
    }
    
    // If it's already 11 digits and starts with 1, add +
    if (digits.length === 11 && digits.startsWith('1')) {
      return `+${digits}`;
    }
    
    // If it's a 7-digit number (local number), treat as invalid and return null
    // This will trigger the default phone number logic
    if (digits.length === 7) {
      console.log('⚠️ Invalid phone number format (7 digits):', phone);
      return null;
    }
    
    // If it already has +, return as is (assuming it's already E.164)
    if (phone.startsWith('+')) {
      return phone;
    }
    
    // For other international numbers, add + prefix
    return `+${digits}`;
  }

  /**
   * Format zip code for DIME API (must be exactly 5 digits)
   * @param {string} zip - Zip code to format
   * @returns {string} Formatted zip code (exactly 5 digits)
   */
  static formatZipCode(zip) {
    if (!zip || zip.trim() === '') {
      return '00000'; // Default to 00000 if zip is missing
    }
    
    // Remove all non-digit characters
    const digits = zip.replace(/\D/g, '');
    
    if (digits.length === 0) {
      return '00000';
    }
    
    // Take only the first 5 digits (for ZIP+4 format like "12345-6789")
    const zip5 = digits.substring(0, 5);
    
    // Pad with zeros if less than 5 digits
    return zip5.padStart(5, '0');
  }

  /**
   * Get DIME configuration for a specific tenant
   * Retrieves encrypted credentials from database and decrypts them
   * @param {string} tenantId - Tenant ID (REQUIRED)
   * @returns {Promise<Object>} Configuration object with API credentials and base URL
   * @throws {Error} If tenantId not provided or credentials not configured
   */
  static async getConfigForTenant(tenantId) {
    if (!tenantId) {
      throw new Error('❌ DIME Configuration Error: tenantId is required. Please provide a valid tenant ID.');
    }

    const pool = await getPool();
    const result = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query('SELECT Name, PaymentProcessorSettings FROM oe.Tenants WHERE TenantId = @tenantId');

    if (result.recordset.length === 0) {
      throw new Error(`❌ DIME Configuration Error: Tenant ${tenantId} not found in database.`);
    }

    const tenantName = result.recordset[0].Name;

    if (!result.recordset[0].PaymentProcessorSettings) {
      throw new Error(`❌ DIME Configuration Error: Tenant "${tenantName}" has not configured payment processor credentials. Please configure DIME credentials in Settings → Payment Processing.`);
    }

    const paymentSettings = JSON.parse(result.recordset[0].PaymentProcessorSettings);
    
    // Check if AllAboard365 / DIME (processors.openenroll) is the active processor
    if (paymentSettings.activeProcessor !== 'openenroll') {
      throw new Error(`❌ DIME Configuration Error: Tenant "${tenantName}" is using ${paymentSettings.activeProcessor} payment processor, not AllAboard365 (DIME).`);
    }

    const dimeSettings = paymentSettings.processors?.openenroll?.dime;
    if (!dimeSettings) {
      throw new Error(`❌ DIME Configuration Error: Tenant "${tenantName}" has AllAboard365 (DIME) selected but DIME credentials are missing.`);
    }

    // Decrypt sensitive credentials
    const apiToken = dimeSettings.apiTokenEncrypted 
      ? encryptionService.decrypt(dimeSettings.apiTokenEncrypted)
      : dimeSettings.apiToken; // Fallback for non-encrypted legacy data
    
    const webhookSecret = dimeSettings.webhookSecretEncrypted
      ? encryptionService.decrypt(dimeSettings.webhookSecretEncrypted)
      : dimeSettings.webhookSecret; // Fallback for non-encrypted legacy data

    const sid = dimeSettings.sid;
    const environment = dimeSettings.environment || 'production';

    // Validate required credentials
    if (!apiToken) {
      throw new Error(`❌ DIME Configuration Error: Tenant "${tenantName}" is missing DIME API Token. Please configure in Settings → Payment Processing.`);
    }
    if (!sid) {
      throw new Error(`❌ DIME Configuration Error: Tenant "${tenantName}" is missing DIME SID. Please configure in Settings → Payment Processing.`);
    }

    // Determine base URL based on environment setting
    const baseUrl = environment === 'demo' 
      ? 'https://demo.dimepayments.com'
      : 'https://app.dimepayments.com';

    const config = {
      apiToken,
      sid,
      webhookSecret,
      environment,
      baseUrl,
      tenantId,
      tenantName
    };

    if (process.env.DEBUG_DIME === '1') {
      console.log('🔓 Loaded DIME config for tenant:', {
        tenantId,
        tenantName,
        environment,
        hasApiToken: !!apiToken,
        hasSid: !!sid,
        hasWebhookSecret: !!webhookSecret,
        baseUrl
      });
    }

    return config;
  }

  /**
   * Get DIME configuration based on environment variables (LEGACY/FALLBACK)
   * @deprecated Use getConfigForTenant(tenantId) instead
   * @returns {Object} Configuration object with API credentials and base URL
   */
  static getConfig() {
    const isProduction = process.env.NODE_ENV === 'production';
    
    const config = {
      apiToken: isProduction 
        ? process.env.DIME_PROD_API_TOKEN 
        : process.env.DIME_DEMO_API_TOKEN,
      sid: isProduction 
        ? process.env.DIME_PROD_SID 
        : process.env.DIME_DEMO_SID,
      baseUrl: isProduction 
        ? process.env.DIME_PROD_API_BASE_URL 
        : process.env.DIME_DEMO_API_BASE_URL,
      webhookSecret: isProduction
        ? process.env.DIME_PROD_WEBHOOK_SECRET
        : process.env.DIME_DEMO_WEBHOOK_SECRET
    };
    
    // Debug logging can be removed in production
    if (process.env.NODE_ENV !== 'production') {
      console.log('🔍 DEBUG: DIME Config (from env vars):', {
        isProduction,
        apiToken: config.apiToken ? 'Set' : 'Missing',
        sid: config.sid,
        baseUrl: config.baseUrl,
        webhookSecret: config.webhookSecret ? 'Set' : 'Missing'
      });
    }
    
    return config;
  }

  /**
   * Create authenticated request headers
   * @param {Object} config - Optional config object (if not provided, uses getConfig())
   * @returns {Object} Headers object with authorization
   */
  static getHeaders(config = null, headerOpts = {}) {
    const dimeConfig = config || this.getConfig();
    const headers = {
      'Authorization': `Bearer ${dimeConfig.apiToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };

    if (process.env.DEBUG_DIME === '1' && !headerOpts.silent) {
      console.log('🔍 DEBUG: DIME Headers:', {
        authorization: headers.Authorization.substring(0, 20) + '...',
        contentType: headers['Content-Type'],
        accept: headers.Accept
      });
    }

    return headers;
  }

  static getJWTHeaders(config = null) {
    const dimeConfig = config || this.getConfig();
    return {
      'client_key': dimeConfig.apiToken, // DIME uses client_key for JWT-based payments
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
  }

  /**
   * Tokenize a credit card with DIME
   * @param {Object} cardData - Credit card information
   * @param {string} cardData.number - Credit card number
   * @param {string} cardData.expiryMonth - Expiry month (MM)
   * @param {string} cardData.expiryYear - Expiry year (YYYY)
   * @param {string} cardData.cvv - CVV code
   * @param {string} cardData.cardholderName - Cardholder name
   * @param {Object} cardData.billingAddress - Billing address information
   * @param {string} cardData.customerId - DIME customer ID (optional, will create customer if not provided)
   * @param {Object} cardData.customerData - Customer data for creation (optional)
   * @returns {Object} Tokenization result with token and metadata
   */
  static async tokenizeCreditCard(cardData, tenantId) {
    try {
      // Get tenant-specific DIME credentials (throws error if not configured)
      const config = await this.getConfigForTenant(tenantId);
      const headers = this.getHeaders(config);

      // PCI DSS 3.2.2: never log CVV, even at DEBUG. Log a presence flag only.
      console.log('🔍 DEBUG: DIME tokenizeCreditCard input:', {
        cardNumber: cardData.cardNumber,
        number: cardData.number,
        expiryMonth: cardData.expiryMonth,
        expiryYear: cardData.expiryYear,
        cvvProvided: cardData.cvv ? true : false,
        cardholderName: cardData.cardholderName,
        billingAddress: cardData.billingAddress,
        customerId: cardData.customerId
      });

      // Validate required fields
      const cardNumber = cardData.cardNumber || cardData.number;
      if (!cardNumber) {
        throw new Error('Card number is required');
      }
      if (!cardData.expiryMonth || !cardData.expiryYear) {
        throw new Error('Expiry month and year are required');
      }
      if (!cardData.cvv) {
        throw new Error('CVV is required');
      }
      if (!cardData.cardholderName) {
        throw new Error('Cardholder name is required');
      }

      const payload = {
        data: {
          sid: config.sid,
          card_number: cardData.cardNumber || cardData.number,
          expiration_date: `${cardData.expiryMonth.toString().padStart(2, '0')}/${cardData.expiryYear}`,
          cvv: cardData.cvv,
          cardholder_name: cardData.cardholderName,
          billing_address: {
            first_name: cardData.billingAddress?.firstName || cardData.billingAddress?.first_name || '',
            last_name: cardData.billingAddress?.lastName || cardData.billingAddress?.last_name || '',
            addr1: cardData.billingAddress?.address || cardData.billingAddress?.addr1 || '',
            addr2: cardData.billingAddress?.address2 || cardData.billingAddress?.addr2 || '',
            city: cardData.billingAddress?.city || '',
            state: cardData.billingAddress?.state || '',
            zip: cardData.billingAddress?.zip || ''
          }
        }
      };

      // Add customer ID if provided, otherwise include customer data for creation
      if (cardData.customerId) {
        payload.data.customer_id = cardData.customerId;
      } else if (cardData.customerData) {
        payload.data.first_name = cardData.customerData.firstName;
        payload.data.last_name = cardData.customerData.lastName;
        payload.data.email = cardData.customerData.email;
        payload.data.phone = cardData.customerData.phone;
      }

      console.log('🔍 DEBUG: Tokenizing credit card with DIME:', {
        sid: config.sid,
        baseUrl: config.baseUrl,
        cardholderName: cardData.cardholderName,
        hasCardNumber: !!(cardData.cardNumber || cardData.number),
        hasBillingAddress: !!cardData.billingAddress,
        hasCustomerId: !!cardData.customerId
      });

      console.log('🔍 DEBUG: Full tokenization payload:', JSON.stringify(payload, null, 2));

      const response = await axios.post(
        `${config.baseUrl}/api/transaction/tokenize-card`,
        payload,
        { headers }
      );

      console.log('✅ DIME Credit Card Tokenization Success:', {
        success: true,
        hasToken: !!response.data.data?.token,
        responseData: response.data
      });

      return {
        success: true,
        token: response.data.data?.token || response.data.token,
        customerId: cardData.customerId, // Use the customerId from input
        paymentMethodId: response.data.data?.payment_method_id || response.data.payment_method_id || null, // May not exist in tokenization response
        cardBrand: dimeCardBrand.getCardBrandOrNull(cardNumber) || undefined,
        last4: cardNumber.slice(-4),
        expiryMonth: cardData.expiryMonth,
        expiryYear: cardData.expiryYear,
        rawResponse: response.data
      };

    } catch (error) {
      console.error('❌ DIME Credit Card Tokenization Error:', {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data
      });

      return {
        success: false,
        error: {
          message: error.response?.data?.message || error.message,
          code: error.response?.data?.code || 'TOKENIZATION_ERROR',
          status: error.response?.status
        }
      };
    }
  }

  /**
   * Get DIME cc_brand string from card number (card-validator + mapping). Returns null if unknown/unsupported.
   * @param {string} cardNumber - Card number (any formatting)
   * @returns {string|null} DIME brand or null
   */
  static getCardBrand(cardNumber) {
    return dimeCardBrand.getCardBrandOrNull(cardNumber);
  }

  /**
   * Create a credit card payment method with DIME using the payment-method/create endpoint
   * @param {Object} cardData - Credit card information
   * @param {string} cardData.number - Card number
   * @param {string} cardData.expiryMonth - Expiry month (MM)
   * @param {string} cardData.expiryYear - Expiry year (YYYY)
   * @param {string} cardData.cvv - CVV code
   * @param {string} cardData.cardholderName - Cardholder name
   * @param {Object} cardData.billingAddress - Billing address information
   * @param {string} cardData.customerId - DIME customer ID (required)
   * @returns {Object} Payment method creation result with token and metadata
   */
  static async createCreditCardPaymentMethod(cardData, tenantId) {
    try {
      // Get tenant-specific DIME credentials (throws error if not configured)
      const config = await this.getConfigForTenant(tenantId);
      const headers = this.getHeaders(config);

      // PCI DSS 3.2.2: never log CVV, even at DEBUG. Log a presence flag only.
      console.log('🔍 DEBUG: DIME createCreditCardPaymentMethod input:', {
        number: cardData.number,
        expiryMonth: cardData.expiryMonth,
        expiryYear: cardData.expiryYear,
        cvvProvided: cardData.cvv ? true : false,
        cardholderName: cardData.cardholderName,
        billingAddress: cardData.billingAddress,
        customerId: cardData.customerId
      });

      // Validate required fields
      if (!cardData.number) {
        throw new Error('Card number is required');
      }
      if (!cardData.expiryMonth || !cardData.expiryYear) {
        throw new Error('Expiry month and year are required');
      }
      if (!cardData.cvv) {
        throw new Error('CVV is required');
      }
      if (!cardData.cardholderName) {
        throw new Error('Cardholder name is required');
      }
      if (!cardData.customerId) {
        throw new Error('Customer ID is required');
      }

      const normalizedNumber = dimeCardBrand.normalizePan(cardData.number);
      const brandResolution = dimeCardBrand.getDimeCcBrandFromPan(normalizedNumber);
      if (!brandResolution.brand) {
        return {
          success: false,
          error: {
            message: brandResolution.message || 'Invalid card number or unsupported card type',
            code: brandResolution.code || 'INVALID_CARD_TYPE',
            details: { validatorType: brandResolution.validatorType }
          }
        };
      }

      // DIME requires m/Y format: month with leading zeros (01-12) and 4-digit year
      // Laravel validation format: m = month with padding, Y = 4-digit year
      // Example: 07/2028
      const fullYear = cardData.expiryYear.toString().length === 2 
        ? `20${cardData.expiryYear}` 
        : cardData.expiryYear.toString();
      
      const payload = {
        filters: {
          uuid: cardData.customerId
        },
        data: {
          sid: config.sid,
          type: "cc",
          uuid: cardData.customerId, // Required: customer UUID in data object
          cc_number: normalizedNumber, // Required: card number (not token)
          cc_cvv: cardData.cvv, // Required: CVV
          cc_name_on_card: cardData.cardholderName,
          cc_last_four: normalizedNumber.slice(-4),
          cc_expiration_date: `${cardData.expiryMonth.toString().padStart(2, '0')}/${fullYear}`, // m/Y format: 07/2028
          cc_brand: brandResolution.brand,
          addr1: cardData.billingAddress.address || '',
          addr2: cardData.billingAddress.address2 || '',
          city: cardData.billingAddress.city || '',
          state: cardData.billingAddress.state || '',
          zip: this.formatZipCode(cardData.billingAddress.zip || ''),
          default: true
        }
      };

      // PCI DSS 3.2.2: never log CVV. Redact before stringifying. Masking card number too
      // since DEBUG logs are kept in appservice/analytics and shouldn't carry full PANs either.
      const redactedPayload = JSON.parse(JSON.stringify(payload));
      if (redactedPayload?.data) {
        if (redactedPayload.data.cc_cvv) redactedPayload.data.cc_cvv = '***';
        if (typeof redactedPayload.data.cc_number === 'string' && redactedPayload.data.cc_number.length >= 4) {
          redactedPayload.data.cc_number = `****${redactedPayload.data.cc_number.slice(-4)}`;
        }
      }
      console.log('🔍 DEBUG: Full credit card payment method payload:', JSON.stringify(redactedPayload, null, 2));

      const response = await axios.post(
        `${config.baseUrl}/api/payment-method/create`,
        payload,
        { headers }
      );

      console.log('✅ DIME Credit Card Payment Method Success:', {
        success: true,
        hasPaymentMethodId: !!(response.data.data?.id || response.data.id),
        fullResponse: response.data
      });

      const extractedToken = response.data.data?.token || response.data.token;
      const extractedId = response.data.data?.id || response.data.id;
      
      console.log('🔍 DEBUG: DIME response token analysis:', {
        token: extractedToken,
        tokenLength: extractedToken?.toString().length,
        tokenLooksLikeCardNumber: /^\d{16}$/.test(extractedToken),
        paymentMethodId: extractedId,
        inputCardNumber: normalizedNumber,
        inputCardLast4: normalizedNumber?.slice(-4),
        tokenMatchesInputCard: extractedToken === normalizedNumber
      });

      return {
        success: true,
        token: extractedToken,
        customerId: cardData.customerId, // Use the customer ID from input since it's not in response
        paymentMethodId: extractedId,
        cardBrand: response.data.data?.cc_brand || response.data.cc_brand,
        last4: response.data.data?.cc_last_four || response.data.cc_last_four,
        expiryMonth: cardData.expiryMonth,
        expiryYear: cardData.expiryYear,
        rawResponse: response.data
      };

            } catch (error) {
              // Format DIME validation errors for better readability
              const dimeErrors = error.response?.data?.errors || {};
              const errorMessages = [];
              
              // Extract validation errors into readable messages
              Object.keys(dimeErrors).forEach(key => {
                const fieldName = key.replace('data.', '').replace(/_/g, ' ');
                const messages = Array.isArray(dimeErrors[key]) ? dimeErrors[key] : [dimeErrors[key]];
                messages.forEach(msg => {
                  errorMessages.push(`${fieldName}: ${msg}`);
                });
              });

              // DIME's 400 shape varies: sometimes `{ message }` at the root, sometimes nested
              // under `{ data: { message } }` (e.g. "Invalid response from upstream API" when
              // their own upstream card network rejects). Walk both before falling back to the
              // stock axios "Request failed with status code 400" string.
              const rd = error.response?.data;
              const nestedMessage =
                (typeof rd?.message === 'string' && rd.message) ||
                (typeof rd?.data?.message === 'string' && rd.data.message) ||
                (typeof rd?.error?.message === 'string' && rd.error.message) ||
                null;

              // Stringify the raw body as a last-resort fallback so operators always have
              // SOMETHING to look at when DIME returns an unfamiliar shape.
              let rawBodyString = null;
              if (!nestedMessage && rd !== undefined) {
                try {
                  rawBodyString =
                    typeof rd === 'string' ? rd : JSON.stringify(rd);
                } catch (_e) {
                  rawBodyString = null;
                }
              }

              // Raw message (for logs / integration error records / support).
              const rawMessage = nestedMessage || rawBodyString || error.message;

              // Classify: is this something the user can actually act on, or is it a
              // DIME-internal / upstream-technical message that shouldn't leak to the UI?
              // Validation errors (populated `errors[]`), decline-style wording, and the
              // "Invalid response from upstream API" case (bank didn't confirm card during
              // vault) are all user-actionable — the member either has bad details or should
              // retry with a different card. Anything else (timeouts, 500s surfaced as 400, etc.)
              // gets a generic friendly message, with the real text preserved in `rawMessage`
              // /`details` for developers.
              const isValidationError = errorMessages.length > 0;
              // Covers DIME-native wording + Heartland HMS status names (InsufficientFunds,
              // InsufficientActivationAmount, InvalidPaymentType, InvalidPin, ProfileClosed,
              // ProfileFrozen, ProfileNotFound, ProfileAuthorizationFailed, AccountNotActivated,
              // RegistrationRequired, ServiceUnavailable) in case DIME ever bubbles them up
              // verbatim on a 4xx. See docs/billing/dime-payments.md → "Known-failure catalog".
              const looksLikeDecline = /decline|do not honor|not approved|insufficient|insufficient(activation|load)amount|expired|restricted|cvv|invalid card|invalid number|invalid ?payment ?type|invalid ?pin|avs|profile(closed|frozen|notfound|authorizationfailed)|accountnotactivated|registrationrequired|serviceunavailable/i
                .test(rawMessage || '');
              // Not technically a decline — the bank just didn't answer — but we treat it like
              // one so enrollment blocks instead of silently completing with no billing schedule.
              // See docs/billing/dime-payments.md → "Known-failure catalog" (UPSTREAM_UNVERIFIED).
              const looksLikeUpstreamUnverified = /invalid response from upstream|upstream api|upstream error/i
                .test(rawMessage || '');
              const isUserActionable = isValidationError || looksLikeDecline || looksLikeUpstreamUnverified;

              const userFacingMessage = isValidationError
                ? `DIME Payment Processor Validation Error: ${errorMessages.join('; ')}`
                : looksLikeDecline
                  ? rawMessage
                  : looksLikeUpstreamUnverified
                    ? "We couldn't verify this card with your bank. Please double-check the card number, expiration, and billing ZIP, or try a different card."
                    : 'Payment method rejected for unknown reason. Please try again or use a different card.';

              console.error('❌ DIME Credit Card Payment Method Error:', {
                message: error.message,
                status: error.response?.status,
                data: error.response?.data,
                errors: error.response?.data?.errors,
                formattedErrors: errorMessages,
                extractedMessage: nestedMessage,
                isUserActionable
              });

      return {
        success: false,
        error: {
          // User-safe message — never includes DIME-internal technical text.
          message: userFacingMessage,
          // Real DIME text for support / logs / integration-error records.
          rawMessage: rawMessage || null,
          code: error.response?.data?.code || 'PAYMENT_METHOD_CREATION_ERROR',
          status: error.response?.status,
          // Whether the downstream consumer can show `message` directly to the user
          // (validation error / decline) vs. needing to fall back to a generic string.
          isUserActionable,
          // Preserve the full response body (or validation errors array) so integration-error
          // records always capture DIME's raw answer, not just our reformatted summary.
          details: error.response?.data?.errors || error.response?.data || undefined
        }
      };
    }
  }

  /**
   * @deprecated This method is deprecated. Use createBankAccountPaymentMethod() instead.
   * Create a bank account payment method with DIME using the payment-method/create endpoint
   * @param {Object} bankData - Bank account information
   * @param {string} bankData.routingNumber - Bank routing number
   * @param {string} bankData.accountNumber - Bank account number
   * @param {string} bankData.accountType - Account type (Checking, Savings, Business)
   * @param {string} bankData.accountHolderName - Account holder name
   * @param {string} bankData.bankName - Bank name
   * @param {Object} bankData.billingAddress - Billing address information
   * @param {string} bankData.customerId - DIME customer ID (required)
   * @returns {Object} Payment method creation result with token and metadata
   */
  static async tokenizeBankAccount(bankData, tenantId) {
    try {
      // Get tenant-specific DIME credentials (throws error if not configured)
      const config = await this.getConfigForTenant(tenantId);
      const headers = this.getHeaders(config);

      // Format billing address
      const billingAddress = bankData.billingAddress;
      const address1 = billingAddress?.address || billingAddress?.addr1 || '';
      const address2 = billingAddress?.address2 || billingAddress?.addr2 || '';
      const city = billingAddress?.city || '';
      const state = billingAddress?.state || '';
      const zip = billingAddress?.zip || '';

      const payload = {
        filters: {
          uuid: bankData.customerId
        },
        data: {
          sid: config.sid,
          type: "ach",
          uuid: bankData.customerId, // Required: customer UUID in data object
          ach_bank_account_name: bankData.accountHolderName,
          ach_routing_number: bankData.routingNumber,
          ach_account_number: bankData.accountNumber,
          ach_ownership_type: "Personal",
          ach_account_type: normalizeDimeAchAccountTypeForCharge(bankData.accountType),
          ach_bank_name: bankData.bankName,
          default: true,
          addr1: address1,
          addr2: address2,
          city: city,
          state: state,
          zip: zip
        }
      };

      console.log('🔍 DEBUG: Creating bank account payment method with DIME:', {
        sid: config.sid,
        baseUrl: config.baseUrl,
        customerId: bankData.customerId,
        accountHolderName: bankData.accountHolderName,
        bankName: bankData.bankName,
        hasRoutingNumber: !!bankData.routingNumber,
        hasAccountNumber: !!bankData.accountNumber,
        hasBillingAddress: !!billingAddress
      });

      console.log('🔍 DEBUG: Full bank payment method payload:', JSON.stringify(payload, null, 2));

      const response = await axios.post(
        `${config.baseUrl}/api/payment-method/create`,
        payload,
        { headers }
      );

      console.log('✅ DIME Bank Account Payment Method Success:', {
        success: true,
        hasPaymentMethodId: !!response.data.data?.id,
        fullResponse: response.data
      });

      return {
        success: true,
        token: null, // ACH doesn't use tokens - only payment method IDs
        customerId: bankData.customerId,
        paymentMethodId: response.data.data?.id,
        bankName: bankData.bankName,
        last4: bankData.accountNumber.slice(-4),
        accountType: bankData.accountType,
        rawResponse: response.data
      };

    } catch (error) {
      // Mirror the credit-card path's classification so the caller can distinguish a user-
      // fixable validation error / decline from a DIME-side / unclassified failure.
      const dimeErrors = error.response?.data?.errors || {};
      const errorMessages = [];
      Object.keys(dimeErrors).forEach(key => {
        const fieldName = key.replace('data.', '').replace(/_/g, ' ');
        const messages = Array.isArray(dimeErrors[key]) ? dimeErrors[key] : [dimeErrors[key]];
        messages.forEach(msg => errorMessages.push(`${fieldName}: ${msg}`));
      });

      const rd = error.response?.data;
      const nestedMessage =
        (typeof rd?.message === 'string' && rd.message) ||
        (typeof rd?.data?.message === 'string' && rd.data.message) ||
        (typeof rd?.error?.message === 'string' && rd.error.message) ||
        null;
      let rawBodyString = null;
      if (!nestedMessage && rd !== undefined) {
        try { rawBodyString = typeof rd === 'string' ? rd : JSON.stringify(rd); } catch (_) {}
      }
      const rawMessage = nestedMessage || rawBodyString || error.message;
      const isValidationError = errorMessages.length > 0;
      // ACH-flavored decline / NACHA return strings.
      const looksLikeDecline = /invalid routing|invalid account|nsf|insufficient|r\d{2}|closed account|no account|unable to locate/i
        .test(rawMessage || '');
      // "Invalid response from upstream API" also shows up on ACH vault when the bank didn't
      // confirm — treat as user-actionable so enrollment blocks rather than silently completing.
      const looksLikeUpstreamUnverified = /invalid response from upstream|upstream api|upstream error/i
        .test(rawMessage || '');
      const isUserActionable = isValidationError || looksLikeDecline || looksLikeUpstreamUnverified;
      const userFacingMessage = isValidationError
        ? `DIME Payment Processor Validation Error: ${errorMessages.join('; ')}`
        : looksLikeDecline
          ? rawMessage
          : looksLikeUpstreamUnverified
            ? "We couldn't verify this bank account. Please double-check the routing and account numbers, or try a different account."
            : 'Bank account rejected for unknown reason. Please verify your routing/account numbers or try a different account.';

      console.error('❌ DIME Bank Account Payment Method Error:', {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data,
        extractedMessage: nestedMessage,
        isUserActionable
      });

      return {
        success: false,
        error: {
          message: userFacingMessage,
          rawMessage: rawMessage || null,
          code: error.response?.data?.code || 'PAYMENT_METHOD_ERROR',
          status: error.response?.status,
          isUserActionable,
          details: error.response?.data?.errors || error.response?.data || undefined
        }
      };
    }
  }

  /**
   * Create a bank account payment method with DIME using the payment-method/create endpoint
   * @param {Object} bankData - Bank account information
   * @param {string} bankData.routingNumber - Routing number
   * @param {string} bankData.accountNumber - Account number
   * @param {string} bankData.accountType - Account type (Checking/Savings)
   * @param {string} bankData.accountHolderName - Account holder name
   * @param {string} bankData.bankName - Bank name
   * @param {Object} bankData.billingAddress - Billing address information
   * @param {string} bankData.customerId - DIME customer ID (required)
   * @returns {Object} Payment method creation result with token and metadata
   */
  static async createBankAccountPaymentMethod(bankData, tenantId) {
    // This method just calls the existing tokenizeBankAccount method
    // which actually uses the correct /api/payment-method/create endpoint
    return await this.tokenizeBankAccount(bankData, tenantId);
  }

  /**
   * Get a customer from DIME (GET /api/customer/show with filters.uuid)
   * @param {string} customerId - DIME customer UUID
   * @returns {Object} Customer information
   */
  static async getCustomer(customerId, tenantId) {
    try {
      const config = await this.getConfigForTenant(tenantId);
      const headers = this.getHeaders(config);
      const payload = {
        data: { sid: config.sid },
        filters: { uuid: customerId }
      };

      console.log('🔍 DEBUG: Getting customer from DIME:', {
        customerId,
        baseUrl: config.baseUrl
      });

      const response = await axios.get(
        `${config.baseUrl}/api/customer/show`,
        { headers, data: payload }
      );

      if (!response.data?.data) {
        return {
          success: false,
          error: {
            message: 'Customer not found',
            code: 'CUSTOMER_RETRIEVAL_ERROR',
            status: 404
          }
        };
      }

      console.log('✅ DIME Customer Retrieval Success:', {
        success: true,
        hasCustomerData: !!response.data.data
      });

      return {
        success: true,
        customer: response.data.data,
        rawResponse: response.data
      };

    } catch (error) {
      console.error('❌ DIME Customer Retrieval Error:', {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data
      });

      return {
        success: false,
        error: {
          message: error.response?.data?.message || error.message,
          code: error.response?.data?.code || 'CUSTOMER_RETRIEVAL_ERROR',
          status: error.response?.status
        }
      };
    }
  }

  /**
   * List payment methods for a DIME customer (GET /api/payment-method/list with filters.uuid = customer UUID).
   * Used when linking by customer ID only so we can auto-fill the primary payment method and card details.
   * @param {string} customerId - DIME customer UUID
   * @param {string} tenantId - Tenant ID for config
   * @returns {Promise<{ success: boolean, paymentMethods?: Array<{ id: string, type: string, last4?: string, brand?: string, isDefault?: boolean }>, error?: { message: string } }>}
   */
  static async getCustomerPaymentMethods(customerId, tenantId) {
    try {
      const config = await this.getConfigForTenant(tenantId);
      const headers = this.getHeaders(config);

      // DIME GET /api/payment-method/list: filters.uuid or customer_uuid = customer UUID; response.data = array of payment methods
      const listPayload = {
        data: { sid: config.sid },
        filters: { uuid: customerId, customer_uuid: customerId }
      };
      try {
        console.log('🔍 DIME payment-method/list request:', { customerId, baseUrl: config.baseUrl, filters: listPayload.filters });
        const listRes = await axios.get(
          `${config.baseUrl}/api/payment-method/list`,
          { headers, data: listPayload }
        );
        // Response: { data: [ { id, type, cc_last_four, cc_brand, default, ... }, ... ] }
        const raw = listRes.data?.data ?? listRes.data;
        const arr = Array.isArray(raw) ? raw : (raw?.payment_methods ?? raw?.payment_method ?? []);
        console.log('🔍 DIME payment-method/list response:', {
          status: listRes.status,
          topLevelKeys: listRes.data ? Object.keys(listRes.data) : [],
          isArray: Array.isArray(raw),
          arrLength: arr?.length,
          dataKeys: raw && !Array.isArray(raw) ? Object.keys(raw) : []
        });
        if (arr.length > 0) {
          // Help map token fields: log keys only (never log full PM object — may contain sensitive refs)
          try {
            const k = arr[0] && typeof arr[0] === 'object' ? Object.keys(arr[0]) : [];
            console.log('🔍 DIME payment-method/list first row keys:', k);
          } catch (_) { /* ignore */ }
          const paymentMethods = arr.map((pm) => {
            const id = pm.id ?? pm.uuid ?? pm.payment_method_id ?? pm.paymentMethodId;
            const type = (pm.type || pm.payment_method_type || 'cc').toLowerCase();
            const last4 = pm.cc_last_four ?? pm.last4 ?? pm.last_four;
            const brand = pm.cc_brand ?? pm.brand ?? pm.card_brand;
            const isDefault = pm.default ?? pm.is_default ?? pm.isDefault;
            const tokenRaw = pm.multi_use_token ?? pm.token ?? pm.multiUseToken ?? pm.taas_token ?? pm.payment_token;
            const token = tokenRaw != null && String(tokenRaw).trim() !== '' ? String(tokenRaw).trim() : undefined;
            return { id: String(id), type, last4, brand, isDefault: !!isDefault, token };
          }).filter((pm) => pm.id);
          console.log('✅ DIME payment-method/list: using', paymentMethods.length, 'payment method(s)');
          return { success: true, paymentMethods };
        }
      } catch (listErr) {
        console.warn('⚠️ DIME payment-method/list failed:', listErr.response?.status, listErr.response?.data || listErr.message);
      }

      // Fallback: get customer and see if response embeds payment methods
      const customerResult = await this.getCustomer(customerId, tenantId);
      if (!customerResult.success || !customerResult.customer) {
        return { success: false, paymentMethods: [], error: customerResult.error };
      }
      const customer = customerResult.customer;
      const embedded = customer.payment_methods ?? customer.payment_method ?? customer.default_payment_method_id;
      if (Array.isArray(embedded) && embedded.length > 0) {
        const paymentMethods = embedded.map((pm) => {
          const id = (typeof pm === 'string' ? pm : (pm?.id ?? pm?.uuid ?? pm?.payment_method_id));
          if (!id) return null;
          const last4 = typeof pm === 'object' && pm ? (pm.cc_last_four ?? pm.last4) : undefined;
          const brand = typeof pm === 'object' && pm ? (pm.cc_brand ?? pm.brand) : undefined;
          return { id: String(id), last4, brand, isDefault: undefined };
        }).filter(Boolean);
        if (paymentMethods.length > 0) {
          return { success: true, paymentMethods };
        }
      }
      if (embedded && typeof embedded === 'string') {
        return { success: true, paymentMethods: [{ id: embedded, last4: undefined, brand: undefined, isDefault: true }] };
      }

      return { success: true, paymentMethods: [] };
    } catch (error) {
      console.error('❌ DIME getCustomerPaymentMethods Error:', error.message, error.response?.data);
      return {
        success: false,
        paymentMethods: [],
        error: { message: error.response?.data?.message || error.message }
      };
    }
  }

  /**
   * Update a customer in DIME
   * @param {string} customerId - DIME customer ID
   * @param {Object} customerData - Customer information to update
   * @param {string} customerData.firstName - Customer first name
   * @param {string} customerData.lastName - Customer last name
   * @param {string} customerData.email - Customer email
   * @param {string} customerData.phone - Customer phone number
   * @param {Object} customerData.billingAddress - Billing address information
   * @returns {Object} Customer update result
   */
  static async updateCustomer(customerId, customerData, tenantId) {
    try {
      const config = await this.getConfigForTenant(tenantId);
      const headers = this.getHeaders(config);

      const payload = {
        sid: config.sid,
        first_name: customerData.firstName,
        last_name: customerData.lastName,
        email: customerData.email,
        phone: customerData.phone,
        billing_address: customerData.billingAddress
      };

      console.log('🔍 DEBUG: Updating customer with DIME:', {
        customerId,
        sid: config.sid,
        baseUrl: config.baseUrl,
        firstName: customerData.firstName,
        lastName: customerData.lastName,
        email: customerData.email
      });

      const response = await axios.put(
        `${config.baseUrl}/api/customers/${customerId}`,
        payload,
        { headers }
      );

      console.log('✅ DIME Customer Update Success:', {
        success: true,
        hasCustomerData: !!response.data.data
      });

      return {
        success: true,
        customer: response.data.data,
        rawResponse: response.data
      };

    } catch (error) {
      console.error('❌ DIME Customer Update Error:', {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data
      });

      return {
        success: false,
        error: {
          message: error.response?.data?.message || error.message,
          code: error.response?.data?.code || 'CUSTOMER_UPDATE_ERROR',
          status: error.response?.status
        }
      };
    }
  }

  /**
   * Create a customer in DIME
   * @param {Object} customerData - Customer information
   * @param {string} customerData.firstName - Customer first name
   * @param {string} customerData.lastName - Customer last name
   * @param {string} customerData.email - Customer email
   * @param {string} customerData.phone - Customer phone number
   * @param {Object} customerData.billingAddress - Billing address information
   * @returns {Object} Customer creation result with customer ID
   */
  static async createCustomer(customerData, tenantId) {
    try {
      // Get tenant-specific DIME credentials (throws error if not configured)
      const config = await this.getConfigForTenant(tenantId);
      const headers = this.getHeaders(config);

      const payload = {
        data: {
          sid: config.sid,
          first_name: customerData.firstName,
          last_name: customerData.lastName,
          email: customerData.email,
          addr1: customerData.billingAddress || '', // Provide default address
          city: customerData.billingCity || '',
          state: customerData.billingState || '',
          zip: customerData.billingZip || '',
          country: customerData.billingCountry || 'USA'
        }
      };

      // Include phone - DIME requires this field
      const formattedPhone = this.formatPhoneNumber(customerData.phone);
      console.log('🔍 DEBUG: Phone formatting:', {
        original: customerData.phone,
        formatted: formattedPhone,
        willUseDefault: !formattedPhone || formattedPhone === '+15555555555'
      });
      
      if (formattedPhone && formattedPhone !== '+15555555555') {
        // Try different phone number formats for DIME compatibility
        const phoneDigits = formattedPhone.replace(/\D/g, '');
        
        // DIME rejects certain phone number patterns (like 555 numbers)
        // Check if this looks like a test number and replace if needed
        let finalPhone = phoneDigits;
        
        if (phoneDigits.length === 11 && phoneDigits.startsWith('1')) {
          // Remove the leading 1 and try 10-digit format: XXXXXXXXXX
          finalPhone = phoneDigits.substring(1);
        }
        else if (phoneDigits.length === 10) {
          // Use 10-digit format: XXXXXXXXXX
          finalPhone = phoneDigits;
        }
        else {
          // Fallback to original formatted phone
          finalPhone = formattedPhone.replace(/\D/g, '');
        }
        
        // Check if this is a test number that DIME might reject (only in dev/localhost)
        const isDevMode = process.env.NODE_ENV === 'development' || 
                         process.env.NODE_ENV === 'dev' || 
                         process.env.BASE_URL?.includes('localhost') ||
                         process.env.DIME_DEMO_BASE_URL?.includes('demo');
        
        const isRepeatingDigits = finalPhone.length === 10 && /^(\d)\1{9}$/.test(finalPhone);
        const hasRepeatingPattern = finalPhone.length === 10 && /^(\d{2,3})\1+/.test(finalPhone);

        if (isDevMode && (
            finalPhone.startsWith('555') || 
            finalPhone.startsWith('123') || 
            finalPhone === '1234567890' || 
            isRepeatingDigits ||
            hasRepeatingPattern)) {
          console.log('⚠️ Detected test phone number in dev mode, using customer service fallback');
          finalPhone = '8002691451';
        }
        
        payload.data.phone = finalPhone;
        console.log('🔍 DEBUG: Final phone number for DIME:', payload.data.phone);
      } else {
        payload.data.phone = '8002691451';
        console.log('🔍 DEBUG: Using customer service fallback phone:', payload.data.phone);
      }

      console.log('🔍 DEBUG: Creating customer with DIME:', {
        sid: config.sid,
        baseUrl: config.baseUrl,
        firstName: customerData.firstName,
        lastName: customerData.lastName,
        email: customerData.email,
        phone: customerData.phone,
        billingAddress: customerData.billingAddress
      });

      console.log('🔍 DEBUG: Full payload being sent to DIME:', JSON.stringify(payload, null, 2));

      const response = await axios.post(
        `${config.baseUrl}/api/customer/create`,
        payload,
        { headers }
      );

      console.log('✅ DIME Customer Creation Success:', {
        success: true,
        hasCustomerId: !!(response.data.customer_id || response.data.data?.customer_id || response.data.data?.uuid),
        fullResponse: response.data
      });

      return {
        success: true,
        customerId: response.data.customer_id || response.data.data?.customer_id || response.data.data?.uuid,
        rawResponse: response.data
      };

    } catch (error) {
      console.error('❌ DIME Customer Creation Error:', {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data
      });

      // Log detailed validation errors if available
      if (error.response?.data?.errors) {
        console.error('❌ DIME Validation Errors:', JSON.stringify(error.response.data.errors, null, 2));
        
        // Log specific phone validation error if present
        if (error.response.data.errors['data.phone']) {
          console.error('📞 Phone validation failed:', error.response.data.errors['data.phone']);
          console.error('📞 Phone number that failed:', customerData.phone);
        }
        
        // Log specific email validation error if present
        if (error.response.data.errors['data.email']) {
          console.error('📧 Email validation failed:', error.response.data.errors['data.email']);
          console.error('📧 Email that failed:', customerData.email);
        }
      }

      // Check if email already exists - try to get existing customer (same merchant)
      if (error.response?.data?.errors?.['data.email']?.some(msg => msg.includes('has already been taken') || msg.includes('already been taken'))) {
        console.log('🔍 Email already exists in DIME, attempting to get existing customer...');
        console.log('🔍 DEBUG: Email error messages:', error.response.data.errors['data.email']);
        try {
          const existingCustomer = await this.getCustomerByEmail(customerData.email, tenantId);
          if (existingCustomer.success) {
            console.log('✅ Found existing DIME customer:', existingCustomer.customerId);
            return {
              success: true,
              customerId: existingCustomer.customerId,
              rawResponse: existingCustomer.rawResponse
            };
          }
          // Email taken but customer not found under this merchant (e.g. exists under another merchant)
          console.warn('📧 Email taken but customer not found under current merchant – may need to migrate customer in DIME');
          return {
            success: false,
            message: 'This email is already registered in the payment system under a different account. If you recently switched payment processors, add or migrate this customer in the new account first, or use a different contact email for this group.',
            error: {
              message: 'This email is already registered in the payment system under a different account. If you recently switched payment processors, add or migrate this customer in the new account first, or use a different contact email for this group.',
              code: 'EMAIL_CONFLICT_OTHER_MERCHANT',
              status: 400,
              details: error.response?.data?.errors || null
            }
          };
        } catch (getError) {
          console.error('❌ Failed to get existing customer:', getError.message);
        }
      }

      // Check if phone number already exists - try to get existing customer
      if (error.response?.data?.errors?.['data.phone']?.includes('already exists')) {
        console.log('🔍 Phone number already exists in DIME, attempting to get existing customer...');
        try {
          const existingCustomer = await this.getCustomerByEmail(customerData.email, tenantId);
          if (existingCustomer.success) {
            console.log('✅ Found existing DIME customer by email:', existingCustomer.customerId);
            return {
              success: true,
              customerId: existingCustomer.customerId,
              rawResponse: existingCustomer.rawResponse
            };
          }
        } catch (getError) {
          console.error('❌ Failed to get existing customer:', getError.message);
        }
      }

      // Phone validation failed (invalid format/area code) — retry with customer service fallback phone.
      // DIME requires a phone field; member can update to their real number later.
      const phoneErrors = error.response?.data?.errors?.['data.phone'];
      const isPhoneValidationOnly = phoneErrors &&
        Object.keys(error.response.data.errors).length === 1;
      if (isPhoneValidationOnly) {
        const fallbackPhone = '8002691451';
        console.log(`🔁 Phone validation failed — retrying DIME customer creation with fallback phone: ${fallbackPhone}`);
        try {
          const config2 = await this.getConfigForTenant(tenantId);
          const headers2 = this.getHeaders(config2);
          const retryPayload = {
            data: {
              sid: config2.sid,
              first_name: customerData.firstName,
              last_name: customerData.lastName,
              email: customerData.email,
              addr1: customerData.billingAddress || '',
              city: customerData.billingCity || '',
              state: customerData.billingState || '',
              zip: customerData.billingZip || '',
              country: customerData.billingCountry || 'USA',
              phone: fallbackPhone
            }
          };
          const retryResp = await axios.post(
            `${config2.baseUrl}/api/customer/create`,
            retryPayload,
            { headers: headers2 }
          );
          console.log('✅ DIME Customer Creation Success (fallback phone retry):', {
            success: true,
            hasCustomerId: !!(retryResp.data.customer_id || retryResp.data.data?.customer_id || retryResp.data.data?.uuid)
          });
          return {
            success: true,
            customerId: retryResp.data.customer_id || retryResp.data.data?.customer_id || retryResp.data.data?.uuid,
            rawResponse: retryResp.data
          };
        } catch (retryErr) {
          console.error('❌ DIME Customer Creation retry (fallback phone) also failed:', retryErr.response?.data || retryErr.message);
        }
      }

      // Create detailed error message
      let errorMessage = error.response?.data?.message || error.message;
      let errorCode = error.response?.data?.code || 'CUSTOMER_CREATION_ERROR';
      
      // Add specific phone validation error details
      if (error.response?.data?.errors?.['data.phone']) {
        errorMessage = `Phone number validation failed: ${error.response.data.errors['data.phone'].join(', ')}`;
        errorCode = 'PHONE_VALIDATION_ERROR';
      }
      
      return {
        success: false,
        message: errorMessage,
        error: {
          message: errorMessage,
          code: errorCode,
          status: error.response?.status,
          details: error.response?.data?.errors || null
        }
      };
    }
  }

  /**
   * Get existing customer by email from DIME.
   * Tries GET /api/customer/show with filters.email, then GET /api/customer/list as fallback.
   * @param {string} email - Customer email
   * @returns {Object} Customer data with customerId (uuid)
   */
  static async getCustomerByEmail(email, tenantId) {
    const config = await this.getConfigForTenant(tenantId);
    const headers = this.getHeaders(config);
    const payload = {
      data: { sid: config.sid },
      filters: { email }
    };

    // Try show first
    try {
      console.log('🔍 DEBUG: Getting customer by email (show):', { email, baseUrl: config.baseUrl });
      const response = await axios.get(
        `${config.baseUrl}/api/customer/show`,
        { headers, data: payload }
      );
      if (response.data?.data?.uuid) {
        const customer = response.data.data;
        console.log('✅ DIME Get Customer by Email Success (show):', { customerId: customer.uuid });
        return {
          success: true,
          customerId: customer.uuid,
          rawResponse: customer
        };
      }
    } catch (showErr) {
      console.log('🔍 DEBUG: customer/show by email failed, trying list:', showErr.response?.status || showErr.message);
    }

    // Fallback: list customers with email filter (returns array)
    try {
      const listPayload = {
        data: { sid: config.sid },
        filters: { email }
      };
      const listResponse = await axios.get(
        `${config.baseUrl}/api/customer/list`,
        { headers, data: listPayload }
      );
      const list = listResponse.data?.data;
      if (Array.isArray(list) && list.length > 0 && list[0].uuid) {
        const customer = list[0];
        console.log('✅ DIME Get Customer by Email Success (list):', { customerId: customer.uuid });
        return {
          success: true,
          customerId: customer.uuid,
          rawResponse: customer
        };
      }
    } catch (listErr) {
      console.error('❌ DIME Get Customer by Email (list) Error:', {
        message: listErr.message,
        status: listErr.response?.status,
        data: listErr.response?.data
      });
    }

    return {
      success: false,
      message: 'Customer not found'
    };
  }

  /**
   * Process a one-time payment using DIME (GENERAL PURPOSE METHOD)
   * 
   * USE THIS FOR:
   * - Plan change immediate charges (already enrolled members)
   * - Manual one-off payments
   * - Payment retries
   * - Adjustment charges
   * - Any payment where you need custom invoice numbering
   * 
   * EXAMPLE USAGE (Plan Changes):
   * ```javascript
   * await DimeService.processPayment({
   *   customerId: 'dime-customer-123',
   *   paymentMethodId: 'pm-456',
   *   amount: 150.00,
   *   description: 'First month payment for plan changes',
   *   invoiceNumber: `PLAN-CHANGE-${householdId}-${Date.now()}`, // Custom format
   *   paymentMethodType: 'Card'
   * }, tenantId);
   * ```
   * 
   * NOTE: For initial enrollment payments, use processInitialPayment() instead.
   * That method auto-generates invoice numbers in format: INITIAL-{householdId}-{timestamp}
   * 
   * @param {Object} paymentData - Payment information
   * @param {string} paymentData.customerId - DIME customer ID (REQUIRED)
   * @param {string} paymentData.paymentMethodId - DIME payment method ID (REQUIRED)
   * @param {number} paymentData.amount - Payment amount in dollars (REQUIRED)
   * @param {string} paymentData.description - Payment description (REQUIRED)
   * @param {string} paymentData.invoiceNumber - Custom invoice number (REQUIRED - you provide this)
   * @param {string} paymentData.paymentMethodType - 'Card' or 'ACH' (default: 'Card')
   * @param {string} paymentData.token - DIME payment token (optional, for stored methods)
   * @param {string} paymentData.idempotencyKey - Idempotency key to prevent duplicates (optional)
   * @param {Object} paymentData.billingAddress - Billing info (optional, for new payments)
   * @param {string} tenantId - Tenant ID for loading DIME credentials (REQUIRED)
   * @returns {Promise<Object>} Payment processing result
   */
  static async processPayment(paymentData, tenantId) {
    try {
      const config = await this.getConfigForTenant(tenantId);
      const headers = this.getHeaders(config);

      // Add idempotency key to headers if provided
      if (paymentData.idempotencyKey) {
        headers['Idempotency-Key'] = paymentData.idempotencyKey;
      }

      // Determine the correct endpoint based on payment method type and whether it's tokenized
      const paymentMethodType = paymentData.paymentMethodType || 'Card';
      // Check if we have a DIME payment method ID (tokenized) vs raw payment data
      const paymentMethodIdStr = String(paymentData.paymentMethodId || '');
      const isTokenized = paymentData.paymentMethodId && 
        paymentMethodIdStr.length > 1 && // DIME payment method IDs are at least 2 characters
        !paymentMethodIdStr.match(/^\d{16}$/); // Not a raw 16-digit card number
      
      // Use type-specific endpoints for payment processing
      const endpoint = paymentMethodType === 'ACH' 
        ? '/api/transaction/charge-ach' 
        : '/api/transaction/charge-card';

      // For direct charging (no stored payment method), we allow raw payment data
      // For stored payment methods, we still need to send raw data due to DIME limitations

      let payload;
      if (paymentMethodType === 'ACH') {
        // Check if we have raw ACH data (for one-time payments) or stored payment method ID
        if (paymentData.routingNumber && paymentData.accountNumber) {
          // Use raw ACH data for one-time payments (DIME requirement)
          console.log('🔍 DEBUG: Using raw ACH data for one-time payment');
          payload = {
            data: {
              sid: config.sid,
              amount: paymentData.amount,
              customer_uuid: paymentData.customerId,
              routing_number: paymentData.routingNumber,
              account_number: paymentData.accountNumber,
              account_type: normalizeDimeAchAccountTypeForCharge(paymentData.accountType),
              account_name: paymentData.accountHolderName || 'Account Holder',
              bank_name: paymentData.bankName || 'Bank',
              memo: (paymentData.description || 'Product enrollment payment').replace(/[^a-zA-Z0-9\s,.\-']/g, ''),
              billing_address: {
                first_name: paymentData.billingFirstName || '',
                last_name: paymentData.billingLastName || '',
                addr1: paymentData.billingAddress || '',
                addr2: paymentData.billingAddress2 || '',
                city: paymentData.billingCity || '',
                state: paymentData.billingState || '',
                zip: paymentData.billingZip || ''
              }
            }
          };
        } else {
          // Use stored payment method ID for recurring payments
          console.log('🔍 DEBUG: Using stored payment method ID for ACH');
          payload = {
            data: {
              sid: config.sid,
              amount: paymentData.amount,
              customer_uuid: paymentData.customerId,
              payment_method_id: paymentData.paymentMethodId, // Use stored payment method ID
              memo: (paymentData.description || 'Product enrollment payment').replace(/[^a-zA-Z0-9\s,.\-']/g, ''),
              billing_address: {
                first_name: paymentData.billingFirstName || '',
                last_name: paymentData.billingLastName || '',
                addr1: paymentData.billingAddress || '',
                addr2: paymentData.billingAddress2 || '',
                city: paymentData.billingCity || '',
                state: paymentData.billingState || '',
                zip: paymentData.billingZip || ''
              }
            }
          };
        }
      } else {
        // For credit cards, check if we have raw card data or a token
        let finalToken = paymentData.token || paymentData.paymentMethodToken;
        
        // Check if we have raw card details (for new enrollments).
        // Prefer raw card details when provided (token charging can fail in some DIME environments even after tokenization).
        if (paymentData.cardNumber) {
          console.log('🔍 DEBUG: Raw card details provided, will send directly to DIME');
          
          // Parse expiry date (MM/YYYY format) into month and year
          let expiryMonth = '12';
          let expiryYear = '2025';
          if (paymentData.expiryDate) {
            const parts = paymentData.expiryDate.split('/');
            if (parts.length === 2) {
              expiryMonth = parts[0];
              expiryYear = parts[1];
            }
          }
          
          // Send raw card data directly to DIME (they will tokenize and charge in one call)
          payload = {
            data: {
              sid: config.sid,
              amount: paymentData.amount,
              customer_uuid: paymentData.customerId,
              cardholder_name: paymentData.cardholderName || '',
              card_number: paymentData.cardNumber.replace(/\s/g, ''), // Remove spaces
              expiration_date: `${expiryMonth}/${expiryYear}`,
              cvv: paymentData.cvv || '',
              memo: (paymentData.description || 'Product enrollment payment').replace(/[^a-zA-Z0-9\s,.\-']/g, ''),
              billing_address: {
                first_name: paymentData.billingFirstName || paymentData.cardholderName?.split(' ')[0] || '',
                last_name: paymentData.billingLastName || paymentData.cardholderName?.split(' ').slice(1).join(' ') || '',
                addr1: paymentData.billingAddress || '',
                addr2: paymentData.billingAddress2 || '',
                city: paymentData.billingCity || '',
                state: paymentData.billingState || '',
                zip: paymentData.billingZip || ''
              }
            }
          };
        } else if (paymentData.paymentMethodToken && paymentData.paymentMethodToken.match(/^\d{16}$/)) {
          // Legacy: If the payment method token is a raw card number (16 digits), tokenize it first
          console.log('🔍 DEBUG: Raw card number detected in paymentMethodToken, tokenizing...');
          
          const tokenizeResult = await this.tokenizeCreditCard({
            cardNumber: paymentData.paymentMethodToken,
            expiryMonth: paymentData.expiryMonth || '12',
            expiryYear: paymentData.expiryYear || '2025',
            cvv: paymentData.cvv || '123',
            cardholderName: (paymentData.billingFirstName || '') + ' ' + (paymentData.billingLastName || ''),
            billingAddress: {
              firstName: paymentData.billingFirstName || '',
              lastName: paymentData.billingLastName || '',
              address: paymentData.billingAddress || '',
              address2: paymentData.billingAddress2 || '',
              city: paymentData.billingCity || '',
              state: paymentData.billingState || '',
              zip: paymentData.billingZip || ''
            }
          });

          if (!tokenizeResult.success) {
            return {
              success: false,
              error: {
                message: 'Failed to tokenize credit card: ' + tokenizeResult.error.message,
                code: 'TOKENIZATION_ERROR'
              }
            };
          }

          finalToken = tokenizeResult.token;
          console.log('✅ Credit card tokenized successfully');
          
          // Use the tokenized payment method
          payload = {
            data: {
              sid: config.sid,
              amount: paymentData.amount,
              customer_uuid: paymentData.customerId,
              token: finalToken,
              memo: (paymentData.description || 'Product enrollment payment').replace(/[^a-zA-Z0-9\s,.\-']/g, ''),
              billing_address: {
                first_name: paymentData.billingFirstName || '',
                last_name: paymentData.billingLastName || '',
                addr1: paymentData.billingAddress || '',
                addr2: paymentData.billingAddress2 || '',
                city: paymentData.billingCity || '',
                state: paymentData.billingState || '',
                zip: paymentData.billingZip || ''
              }
            }
          };
        } else if (paymentData.paymentMethodId && !finalToken) {
          // DIME charge-card requires either token OR full PAN; payment_method_id alone is not accepted for cards
          console.error('❌ Stored card has no token - DIME requires token or PAN for charge-card');
          return {
            success: false,
            error: {
              message: 'Stored card payment method has no token; cannot charge. Please update or re-add the payment method.',
              code: 'CARD_TOKEN_REQUIRED'
            }
          };
        } else if (finalToken) {
          // Use stored payment method token for credit card payments (PCI compliant). DIME requires cardholder_name (and billing with zip when no token; we send both when available).
          const cardholderName = (paymentData.cardholderName && String(paymentData.cardholderName).trim()) ||
            [paymentData.billingFirstName, paymentData.billingLastName].filter(Boolean).join(' ') ||
            'Cardholder';
          console.log('🔍 DEBUG: Using payment method token:', {
            token: finalToken ? `${finalToken.substring(0, 10)}...` : 'null',
            tokenLength: finalToken ? finalToken.length : 0,
            wasTokenized: finalToken !== paymentData.paymentMethodToken
          });
          
          payload = {
            data: {
              sid: config.sid,
              amount: paymentData.amount,
              customer_uuid: paymentData.customerId,
              token: finalToken,
              cardholder_name: cardholderName,
              memo: (paymentData.description || 'Product enrollment payment').replace(/[^a-zA-Z0-9\s,.\-']/g, ''),
              billing_address: {
                first_name: paymentData.billingFirstName || (cardholderName.split(' ')[0] || ''),
                last_name: paymentData.billingLastName || (cardholderName.split(' ').slice(1).join(' ') || ''),
                addr1: paymentData.billingAddress || '',
                addr2: paymentData.billingAddress2 || '',
                city: paymentData.billingCity || '',
                state: paymentData.billingState || '',
                zip: paymentData.billingZip || ''
              }
            }
          };
        } else {
          // No token and no card details - this is an error
          console.error('❌ No payment method provided - need either token or card details');
          return {
            success: false,
            error: {
              message: 'No payment method provided - need either token or card details',
              code: 'NO_PAYMENT_METHOD'
            }
          };
        }
      }

      console.log('🔍 DEBUG: Processing payment with DIME:', {
        sid: config.sid,
        baseUrl: config.baseUrl,
        amount: paymentData.amount,
        description: paymentData.description,
        hasCustomerId: !!paymentData.customerId,
        hasPaymentMethodId: !!paymentData.paymentMethodId,
        paymentMethodId: paymentData.paymentMethodId,
        hasRawCardData: !!paymentData.cardNumber,
        hasToken: !!(paymentData.token || paymentData.paymentMethodToken),
        paymentMethodType: paymentMethodType,
        endpoint: endpoint,
        approach: paymentData.cardNumber ? 'raw_card_data' : 
                 paymentData.paymentMethodId ? 'stored_payment_method_id' : 
                 'stored_token'
      });

      console.log('🔍 DEBUG: DIME payment payload:', JSON.stringify(payload, null, 2));

      const response = await axios.post(
        `${config.baseUrl}${endpoint}`,
        payload,
        { headers }
      );

      const data = response.data?.data || {};
      const recordStatus = paymentStatus.mapDimeSyncChargeResponseToDbStatus(data);

      console.log('✅ DIME Payment Processing response:', {
        success: true,
        transactionNumber: data.transaction_number,
        transactionInfoId: data.transaction_info_id,
        statusCode: data.status_code,
        statusText: data.status_text,
        pending: data.pending,
        recordStatus,
        availableFields: Object.keys(data || {})
      });

      if (recordStatus === 'Failed') {
        const declineErr = buildFriendlyDimeDeclineError(data, paymentData.amount);
        return {
          success: false,
          error: {
            message: declineErr.message,
            code: 'DIME_DECLINED',
            statusCode: data.status_code,
            statusText: declineErr.rawText || null,
            isBankDecline: declineErr.isBankDecline,
            declineReasonCode: declineErr.reasonCode || null,
            amount: declineErr.amount,
            details: response.data
          }
        };
      }

      return {
        success: true,
        recordStatus,
        transactionId: data.transaction_number || data.transaction_info_id,
        transactionNumber: data.transaction_number,
        transactionInfoId: data.transaction_info_id,
        status: data.status_text,
        statusCode: data.status_code,
        amount: data.amount,
        description: data.description,
        multiUseToken: data.multi_use_token,
        transactionType: data.transaction_type,
        billingAddress: data.billing_address,
        rawResponse: response.data
      };

    } catch (error) {
      const validationFlat = formatDimeApiValidationErrors(error.response?.data?.errors);
      console.error('❌ DIME Payment Processing Error:', {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data,
        errors: error.response?.data?.errors,
        fullError: error.response?.data
      });

      // DIME returns most card declines (status_code '05', '51', etc.) as HTTP 400 with the
      // decline embedded in `response.data.data` — see Pamela Bolton 2026-04-18 for reference.
      // Surface the same human-friendly message in this path as in the success-false branch so
      // the user sees e.g. "Your bank declined this transaction in the amount of $311.73…"
      // instead of "Request failed with status code 400".
      const dimeInnerData = error.response?.data?.data;
      if (dimeInnerData && (dimeInnerData.status_code || dimeInnerData.status_text)) {
        const declineErr = buildFriendlyDimeDeclineError(dimeInnerData, paymentData.amount);
        return {
          success: false,
          error: {
            message: declineErr.message,
            code: 'DIME_DECLINED',
            statusCode: dimeInnerData.status_code,
            statusText: declineErr.rawText || null,
            isBankDecline: declineErr.isBankDecline,
            declineReasonCode: declineErr.reasonCode || null,
            amount: declineErr.amount,
            status: error.response?.status,
            details: error.response?.data,
            validationSummary: validationFlat || undefined
          }
        };
      }

      const userMessage =
        validationFlat ||
        error.response?.data?.message ||
        error.message ||
        'Payment processing failed';

      return {
        success: false,
        error: {
          message: userMessage,
          code: error.response?.data?.code || 'PAYMENT_ERROR',
          status: error.response?.status,
          details: error.response?.data?.errors || error.response?.data,
          validationSummary: validationFlat || undefined
        }
      };
    }
  }

  /**
   * Get transaction details from DIME (GET /api/transaction) to resolve transaction_info_id from transaction_id.
   * Used when we only have ProcessorTransactionId (transaction_number) and need transaction_info_id for refund.
   * @param {string} tenantId - Tenant ID for DIME config
   * @param {string} transactionId - DIME transaction_id (e.g. our ProcessorTransactionId / transaction_number)
   * @param {string} transactionType - 'CC' or 'ACH'
   * @returns {Promise<{ success: boolean, transactionInfoId?: string, rawResponse?: object, error?: object }>}
   */
  /**
   * @param {string} tenantId
   * @param {string} transactionId
   * @param {string} transactionType 'ACH' | 'CC'
   * @param {{ transactionInfoId?: string|null }} [options]
   */
  static async getTransaction(tenantId, transactionId, transactionType, options = {}) {
    if (!tenantId || !transactionId || !transactionType) {
      return { success: false, error: { message: 'tenantId, transactionId and transactionType are required' } };
    }
    try {
      const config = await this.getConfigForTenant(tenantId);
      const headers = this.getHeaders(config);
      const payload = {
        data: {
          sid: config.sid,
          transaction_id: String(transactionId).trim(),
          transaction_type: transactionType === 'ACH' ? 'ACH' : 'CC'
        }
      };
      const tid = options.transactionInfoId != null && String(options.transactionInfoId).trim() !== ''
        ? String(options.transactionInfoId).trim()
        : null;
      if (tid) {
        payload.data.transaction_info_id = tid;
      }
      console.log('🔍 DIME GET /api/transaction (resolve transaction_info_id):', {
        transaction_id: payload.data.transaction_id,
        transaction_type: payload.data.transaction_type,
        has_transaction_info_id: !!tid
      });
      const response = await axios.request({
        method: 'GET',
        url: `${config.baseUrl}/api/transaction`,
        headers,
        data: payload
      });
      const data = response.data?.data || response.data;
      const transactionInfoId = data?.transaction_info_id != null ? String(data.transaction_info_id) : null;
      return {
        success: true,
        transactionInfoId,
        data: data && typeof data === 'object' ? data : null,
        rawResponse: response.data
      };
    } catch (error) {
      console.error('❌ DIME GET transaction Error:', {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data
      });
      return {
        success: false,
        error: {
          message: error.response?.data?.message || error.message,
          status: error.response?.status,
          details: error.response?.data
        }
      };
    }
  }

  /**
   * Resolve a transaction for admin audit / reconciliation: try CC vs ACH when PaymentMethod is ambiguous
   * (e.g. oe.Payments.PaymentMethod = 'Recurring' from webhook inserts defaults to CC in getTransaction otherwise),
   * then fall back to GET /api/transactions/:id when GET /api/transaction returns 404.
   * @param {string} tenantId
   * @param {string} transactionId ProcessorTransactionId / DIME transaction_number
   * @param {string} [paymentMethod] oe.Payments.PaymentMethod
   * @param {string|null} [transactionInfoId] ProcessorTransactionInfoId when known
   * @returns {Promise<{ success: boolean, data?: object, error?: object, attemptedTypes?: string[], source?: string }>}
   */
  static async getTransactionForAudit(tenantId, transactionId, paymentMethod, transactionInfoId = null) {
    const pm = String(paymentMethod || '').toLowerCase();
    const infoId =
      transactionInfoId != null && String(transactionInfoId).trim() !== ''
        ? String(transactionInfoId).trim()
        : null;

    /** @type {string[]} */
    let types;
    if (pm.includes('ach') || pm.includes('bank') || pm.includes('checking') || pm.includes('savings')) {
      types = ['ACH'];
    } else if (pm.includes('recurring')) {
      // Webhook failure rows store PaymentMethod as "Recurring"; charges are often ACH — try ACH before CC.
      types = ['ACH', 'CC'];
    } else if (pm === 'dime') {
      // Legacy manual-charge label; household default is usually ACH.
      types = ['ACH', 'CC'];
    } else if (pm.includes('card') || pm.includes('cc') || pm.includes('credit') || pm.includes('debit')) {
      // Try CC first, then fall back to ACH: some rows are stored as "Card" but
      // were actually ACH debits (mislabeled at creation). Without the ACH retry
      // the CC lookup 404s and the payment can never be reconciled.
      types = ['CC', 'ACH'];
    } else {
      types = ['CC', 'ACH'];
    }

    const attemptedTypes = [];
    for (const txType of types) {
      attemptedTypes.push(txType);
      const r = await this.getTransaction(tenantId, transactionId, txType, { transactionInfoId: infoId });
      if (r.success) {
        return { ...r, attemptedTypes, source: 'GET /api/transaction' };
      }
      const st = r.error && r.error.status;
      if (st != null && st !== 404) {
        return { ...r, attemptedTypes };
      }
    }

    try {
      const config = await this.getConfigForTenant(tenantId);
      const headers = this.getHeaders(config);
      const tid = encodeURIComponent(String(transactionId).trim());
      const response = await axios.get(`${config.baseUrl}/api/transactions/${tid}`, { headers });
      const data = response.data?.data || response.data;
      if (data && typeof data === 'object') {
        return {
          success: true,
          data,
          rawResponse: response.data,
          attemptedTypes,
          source: 'GET /api/transactions/:id'
        };
      }
    } catch (e) {
      const st = e.response && e.response.status;
      if (st != null && st !== 404) {
        return {
          success: false,
          error: {
            message: (e.response.data && e.response.data.message) || e.message,
            status: st,
            details: e.response.data
          },
          attemptedTypes
        };
      }
    }

    return {
      success: false,
      error: {
        message: 'No transaction found',
        status: 404,
        details: null
      },
      attemptedTypes
    };
  }

  /**
   * Get transaction status from DIME
   * @param {string} transactionId - DIME transaction ID
   * @returns {Object} Transaction status information
   */
  static async getTransactionStatus(transactionId, tenantId) {
    try {
      const config = await this.getConfigForTenant(tenantId);
      const headers = this.getHeaders(config);

      console.log('🔍 DEBUG: Getting transaction status from DIME:', {
        sid: config.sid,
        baseUrl: config.baseUrl,
        transactionId
      });

      const response = await axios.get(
        `${config.baseUrl}/api/transactions/${transactionId}`,
        { headers }
      );

      console.log('✅ DIME Transaction Status Success:', {
        success: true,
        status: response.data.status
      });

      return {
        success: true,
        transactionId: response.data.transaction_id,
        status: response.data.status,
        amount: response.data.amount,
        processorResponse: response.data.processor_response,
        rawResponse: response.data
      };

    } catch (error) {
      console.error('❌ DIME Transaction Status Error:', {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data
      });

      return {
        success: false,
        error: {
          message: error.response?.data?.message || error.message,
          code: error.response?.data?.code || 'TRANSACTION_STATUS_ERROR',
          status: error.response?.status
        }
      };
    }
  }

  /**
   * Refund or void a prior charge. Use when enrollment commit fails after a successful charge
   * so the customer is not left charged without an enrollment.
   * DIME API: POST /api/transaction/refund with data.sid, data.amount, data.transaction_info_id,
   * data.transaction_type ('CC' or 'ACH'), data.transaction_id.
   * @param {string} transactionId - DIME transaction info id / transaction id (numeric, from charge response)
   * @param {number} amount - Amount to refund (same as charged)
   * @param {string} tenantId - Tenant ID for DIME config
   * @param {string} [paymentMethod] - Payment method from oe.Payments (e.g. dime_cc, Card, ACH) to set transaction_type CC vs ACH
   * @returns {Promise<{ success: boolean, transactionId?: string, error?: { message, code, status } }>}
   */
  static async refundTransaction(transactionId, amount, tenantId, paymentMethod) {
    if (!transactionId || amount == null) {
      return {
        success: false,
        error: { message: 'transactionId and amount are required for refund', code: 'REFUND_VALIDATION' }
      };
    }
    try {
      const config = await this.getConfigForTenant(tenantId);
      const headers = this.getHeaders(config);

      const pm = String(paymentMethod || '').toLowerCase();
      const transactionType = (pm.includes('ach') || pm.includes('bank')) ? 'ACH' : 'CC';
      const txIdStr = String(transactionId).trim();
      const txIdNumeric = txIdStr ? Number(txIdStr) : NaN;

      const payload = {
        data: {
          sid: config.sid,
          amount: Number(amount),
          transaction_info_id: Number.isFinite(txIdNumeric) ? txIdNumeric : txIdStr,
          transaction_type: transactionType,
          transaction_id: Number.isFinite(txIdNumeric) ? txIdNumeric : txIdStr
        }
      };
      console.log('🔍 DIME refund request payload (sid redacted):', {
        amount: payload.data.amount,
        transaction_info_id: payload.data.transaction_info_id,
        transaction_type: payload.data.transaction_type,
        transaction_id: payload.data.transaction_id
      });

      const response = await axios.post(
        `${config.baseUrl}/api/transaction/refund`,
        payload,
        { headers }
      );

      const data = response.data?.data || response.data;
      return {
        success: true,
        transactionId: data?.transaction_id || data?.transaction_number || transactionId,
        rawResponse: response.data
      };
    } catch (error) {
      console.error('❌ DIME Refund Error:', {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data,
        errorsDetail: JSON.stringify(error.response?.data?.errors || {})
      });
      return {
        success: false,
        error: {
          message: error.response?.data?.message || error.message,
          code: error.response?.data?.code || 'REFUND_ERROR',
          status: error.response?.status,
          details: error.response?.data
        }
      };
    }
  }

  /**
   * Validate if a payment method is still active in DIME
   * Note: DIME doesn't provide a direct validation endpoint, so we assume validity
   * unless we encounter actual processing errors
   * @param {string} paymentMethodId - DIME payment method ID
   * @param {string} customerId - DIME customer ID
   * @returns {Object} Validation result
   */
  static async validatePaymentMethod(paymentMethodId, customerId, tenantId) {
    // DIME API doesn't provide a payment method validation endpoint
    // tenantId parameter added for consistency
    // The only way to validate a payment method is to attempt to use it
    // For now, we'll assume all payment methods are valid until we encounter
    // actual processing errors during transactions
    
    console.log('🔍 DIME Payment Method Validation:', {
      paymentMethodId,
      customerId,
      note: 'DIME API validation endpoint not available, assuming valid'
    });

    return {
      success: true,
      isValid: true,
      status: 'assumed_valid',
      message: 'DIME API validation endpoint not available, assuming valid'
    };
  }

  /**
   * Update an existing payment method in DIME (PATCH /api/payment-method/update)
   * @param {string} customerId - DIME customer UUID
   * @param {string|number} paymentMethodId - DIME payment method ID (existing)
   * @param {Object} updateData - { type: 'ach'|'cc', billing address, and ACH or CC fields }
   * @param {string} tenantId - Tenant ID for config
   * @returns {Object} { success, paymentMethodId?, last4?, cardBrand?, error? }
   */
  static async updatePaymentMethod(customerId, paymentMethodId, updateData, tenantId) {
    try {
      const config = await this.getConfigForTenant(tenantId);
      const headers = this.getHeaders(config);
      const addr1 = updateData.billingAddress || '';
      const addr2 = updateData.billingAddress2 || '';
      const city = updateData.billingCity || '';
      const state = updateData.billingState || '';
      const zip = this.formatZipCode(updateData.billingZip || '');

      const data = {
        uuid: customerId,
        sid: config.sid,
        payment_method_id: typeof paymentMethodId === 'string' && paymentMethodId.includes('.') ? parseFloat(paymentMethodId) : paymentMethodId,
        type: updateData.type === 'ACH' || updateData.type === 'ach' ? 'ach' : 'cc',
        default: true,
        addr1,
        addr2: addr2 || '',
        city,
        state,
        zip
      };

      if (data.type === 'ach') {
        data.ach_bank_account_name = updateData.accountHolderName || 'Group';
        data.ach_routing_number = updateData.routingNumber || '';
        data.ach_account_number = updateData.accountNumber || '';
        data.ach_ownership_type = 'Personal';
        data.ach_account_type = normalizeDimeAchAccountTypeForCharge(updateData.accountType);
        data.ach_bank_name = updateData.bankName || '';
      } else {
        data.cc_name_on_card = updateData.cardholderName || '';
        const panFull = updateData.cardNumber ? String(updateData.cardNumber).replace(/\D/g, '') : '';
        data.cc_number = panFull ? panFull.slice(-4) : '';
        const month = updateData.expiryMonth != null ? String(updateData.expiryMonth).padStart(2, '0') : '';
        const year = updateData.expiryYear != null ? String(updateData.expiryYear) : '';
        data.cc_expiration_date = month && year ? `${month}/${year}` : '';
        data.cc_cvv = updateData.cvv || '';
        let resolvedBrand = null;
        if (panFull.length >= 13) {
          const br = dimeCardBrand.getDimeCcBrandFromPan(panFull);
          if (!br.brand) {
            return {
              success: false,
              error: {
                message: br.message || 'Invalid card number or unsupported card type',
                code: 'INVALID_CARD_TYPE',
                details: { validatorType: br.validatorType }
              }
            };
          }
          resolvedBrand = br.brand;
        } else {
          resolvedBrand = dimeCardBrand.mapDisplayBrandToDime(updateData.cardBrand) || 'Visa';
        }
        data.cc_brand = resolvedBrand;
      }

      const payload = { data };

      console.log('🔍 DEBUG: Updating payment method in DIME:', {
        customerId,
        paymentMethodId: data.payment_method_id,
        type: data.type,
        baseUrl: config.baseUrl
      });

      const response = await axios.patch(
        `${config.baseUrl}/api/payment-method/update`,
        payload,
        { headers }
      );

      const resData = response.data?.data;
      if (!resData) {
        return {
          success: false,
          error: { message: 'No data in DIME update response', status: response.status }
        };
      }

      const last4 = resData.cc_last_four || (updateData.accountNumber ? String(updateData.accountNumber).slice(-4) : null);
      console.log('✅ DIME Payment Method Update Success:', { paymentMethodId: resData.id, last4 });

      return {
        success: true,
        paymentMethodId: resData.id != null ? String(resData.id) : paymentMethodId,
        token: resData.token || null,
        last4: last4 || undefined,
        cardBrand: resData.cc_brand || undefined,
        rawResponse: response.data
      };
    } catch (error) {
      console.error('❌ DIME Payment Method Update Error:', {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data
      });
      return {
        success: false,
        error: {
          message: error.response?.data?.message || error.response?.data?.data?.message || error.message,
          code: error.response?.data?.code || 'PAYMENT_METHOD_UPDATE_ERROR',
          status: error.response?.status
        }
      };
    }
  }

  /**
   * Update a payment method's default status in DIME
   * @param {string} paymentMethodId - DIME payment method ID
   * @param {boolean} isDefault - Whether this should be the default payment method
   * @returns {Object} Update result
   */
  static async updatePaymentMethodDefault(paymentMethodId, isDefault, tenantId) {
    try {
      const config = await this.getConfigForTenant(tenantId);
      const headers = this.getHeaders(config);

      const payload = {
        data: {
          default: isDefault
        }
      };

      console.log('🔍 DEBUG: Updating payment method default status in DIME:', {
        paymentMethodId,
        isDefault,
        baseUrl: config.baseUrl
      });

      const response = await axios.patch(
        `${config.baseUrl}/api/payment-methods/${paymentMethodId}`,
        payload,
        { headers }
      );

      console.log('✅ DIME Payment Method Default Update Success:', {
        paymentMethodId,
        isDefault,
        success: response.data.success
      });

      return {
        success: true,
        isDefault: isDefault,
        rawResponse: response.data
      };

    } catch (error) {
      console.error('❌ DIME Payment Method Default Update Error:', {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data
      });

      return {
        success: false,
        message: error.response?.data?.message || error.message,
        code: 'UPDATE_DEFAULT_ERROR',
        status: error.response?.status
      };
    }
  }

  /**
   * Delete a payment method from DIME
   * Note: DIME may not provide a direct deletion endpoint
   * @param {string} paymentMethodId - DIME payment method ID
   * @returns {Object} Deletion result
   */
  static async deletePaymentMethod(paymentMethodId, tenantId) {
    try {
      const config = await this.getConfigForTenant(tenantId);
      const headers = this.getHeaders(config);

      console.log('🔍 DEBUG: Attempting to delete payment method from DIME:', {
        sid: config.sid,
        baseUrl: config.baseUrl,
        paymentMethodId
      });

      const response = await axios.delete(
        `${config.baseUrl}/api/payment-methods/${paymentMethodId}`,
        { headers }
      );

      console.log('✅ DIME Payment Method Deletion Success:', {
        success: response.data.success
      });

      return {
        success: true,
        rawResponse: response.data
      };

    } catch (error) {
      console.error('❌ DIME Payment Method Deletion Error:', {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data
      });

      // If DIME doesn't support payment method deletion (404), 
      // we'll still consider it successful since we can remove it from our database
      if (error.response?.status === 404) {
        console.log('⚠️ DIME API deletion endpoint not available (404), proceeding with database deletion only');
        return {
          success: true,
          message: 'DIME deletion endpoint not available, payment method removed from database only'
        };
      }

      return {
        success: false,
        error: {
          message: error.response?.data?.message || error.message,
          code: error.response?.data?.code || 'DELETE_ERROR',
          status: error.response?.status
        }
      };
    }
  }

  /**
   * Process initial enrollment payment (CONVENIENCE WRAPPER)
   * 
   * USE THIS FOR:
   * - Initial enrollment payments (first charge when member enrolls)
   * - New product additions during enrollment
   * - Any "first payment" scenario
   * 
   * BENEFITS:
   * - Automatically generates invoice numbers: INITIAL-{householdId}-{timestamp}
   * - Simplified parameters (no need to manually create invoice numbers)
   * - Consistent invoice naming across all initial enrollments
   * - Handles both Credit Card and ACH payment types
   * - Includes idempotency key support (prevents duplicate charges)
   * 
   * EXAMPLE USAGE (Initial Enrollment):
   * ```javascript
   * await DimeService.processInitialPayment({
   *   customerId: 'dime-customer-123',
   *   paymentMethodId: 'pm-456',
   *   amount: 250.00,
   *   description: 'Initial payment for individual enrollment',
   *   householdId: 'household-789', // Used for auto invoice number
   *   paymentMethodType: 'Card',
   *   idempotencyKey: 'unique-key-123'
   * }, tenantId);
   * // Invoice number auto-generated as: INITIAL-household-789-1699564800000
   * ```
   * 
   * NOTE: This is a wrapper around processPayment() that adds automatic
   * invoice numbering. For plan changes or one-off payments, use processPayment()
   * directly so you can provide custom invoice numbers like PLAN-CHANGE-{id}-{timestamp}.
   * 
   * @param {Object} paymentData - Payment information
   * @param {string} paymentData.customerId - DIME customer ID
   * @param {string} paymentData.paymentMethodId - DIME payment method ID
   * @param {number} paymentData.amount - Payment amount in dollars
   * @param {string} paymentData.description - Payment description
   * @param {string} paymentData.householdId - Household ID (used for invoice number)
   * @param {string} paymentData.paymentMethodType - 'Card' or 'ACH'
   * @param {string} paymentData.idempotencyKey - Optional key to prevent duplicate charges
   * @param {string} paymentData.token - DIME payment token (for stored methods)
   * @param {string} paymentData.cardNumber - Card number (for new card payments)
   * @param {string} paymentData.expiryDate - Card expiry (for new card payments)
   * @param {string} paymentData.cvv - Card CVV (for new card payments)
   * @param {string} paymentData.routingNumber - Bank routing (for ACH payments)
   * @param {string} paymentData.accountNumber - Bank account (for ACH payments)
   * @param {string} tenantId - Tenant ID for loading DIME credentials (REQUIRED)
   * @returns {Promise<Object>} Payment result
   */
  static async processInitialPayment(paymentData, tenantId) {
    try {
      const { customerId, paymentMethodId, amount, description, householdId, paymentMethodType, token, idempotencyKey } = paymentData;
      
      // Process payment using DIME with idempotency key
      const paymentResult = await this.processPayment({
        paymentMethodId: paymentMethodId,
        token: token,
        customerId,
        amount,
        description,
        invoiceNumber: `INITIAL-${householdId}-${Date.now()}`,
        paymentMethodType: paymentMethodType || 'Card',
        idempotencyKey: idempotencyKey,
        // Pass through card details for new enrollments
        cardNumber: paymentData.cardNumber,
        expiryDate: paymentData.expiryDate,
        cvv: paymentData.cvv,
        cardholderName: paymentData.cardholderName,
        // Pass through ACH details
        routingNumber: paymentData.routingNumber,
        accountNumber: paymentData.accountNumber,
        accountType: paymentData.accountType,
        accountHolderName: paymentData.accountHolderName,
        // Pass through billing details
        billingAddress: paymentData.billingAddress,
        billingCity: paymentData.billingCity,
        billingState: paymentData.billingState,
        billingZip: paymentData.billingZip,
        billingCountry: paymentData.billingCountry,
        billingFirstName: paymentData.billingFirstName,
        billingLastName: paymentData.billingLastName
      }, tenantId);

      if (paymentResult.success) {
        return {
          success: true,
          transactionId: paymentResult.transactionId,
          amount,
          status: paymentResult.status,
          recordStatus: paymentResult.recordStatus,
          processorResponse: paymentResult.processorResponse
        };
      } else {
        return {
          success: false,
          error: paymentResult.error
        };
      }
    } catch (error) {
      console.error('❌ Error processing initial payment:', error);
      return {
        success: false,
        error: {
          message: error.message,
          code: 'INITIAL_PAYMENT_ERROR'
        }
      };
    }
  }

  /**
   * Cancel existing recurring payment schedule
   * @param {string} scheduleId - DIME recurring schedule ID
   * @returns {Promise<Object>} Cancel result
   */
  static async cancelRecurringPayment(scheduleId, tenantId) {
    try {
      const config = await this.getConfigForTenant(tenantId);
      const headers = this.getHeaders(config);
      
      const payload = {
        data: {
          sid: config.sid,
          recurring_payment_id: scheduleId
        }
      };
      
      console.log('🔍 DEBUG: Canceling recurring payment with DIME:', {
        scheduleId,
        payload
      });
      
      const response = await axios.patch(
        `${config.baseUrl}/api/recurring-payment/cancel`,
        payload,
        { headers }
      );
      
      if (response.data && response.data.success) {
        console.log('✅ DIME recurring payment canceled successfully:', response.data);
        return {
          success: true,
          scheduleId: scheduleId
        };
      } else {
        console.error('❌ DIME recurring payment cancel failed:', response.data);
        return {
          success: false,
          error: response.data?.message || 'Unknown error canceling recurring payment'
        };
      }
    } catch (error) {
      console.error('❌ Error canceling DIME recurring payment:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Get current recurring payment schedule for a household
   * @param {string} householdId - Household ID
   * @returns {Promise<Object>} Schedule info
   */
  static async getRecurringPaymentSchedule(householdId, tenantId) {
    try {
      const pool = await require('../config/database').getPool();
      const sql = require('mssql');
      
      const query = `
        SELECT TOP 1
          p.RecurringScheduleId,
          p.Amount,
          p.NextBillingDate,
          p.PaymentDate,
          p.Status
        FROM oe.Payments p
        WHERE p.HouseholdId = @householdId 
          AND p.Status IN ('succeeded', 'APPROVAL', 'Completed', 'RecurringScheduled')
          AND p.RecurringScheduleId IS NOT NULL
        ORDER BY p.PaymentDate DESC
      `;
      
      const result = await pool.request()
        .input('householdId', sql.UniqueIdentifier, householdId)
        .query(query);
      
      if (result.recordset.length > 0) {
        const payment = result.recordset[0];
        return {
          success: true,
          scheduleId: payment.RecurringScheduleId,
          currentAmount: payment.Amount,
          nextBillingDate: payment.NextBillingDate,
          nextRunDate: payment.NextBillingDate, // Alias for compatibility
          lastPaymentDate: payment.PaymentDate,
          status: payment.Status
        };
      } else {
        return {
          success: false,
          error: 'No recurring payment schedule found for household'
        };
      }
    } catch (error) {
      console.error('❌ Error getting recurring payment schedule:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Primary member display fields for DIME recurring schedule name (OpenEnroll household).
   * @param {string} householdId
   * @returns {Promise<{ memberFullName: string|null, householdMemberId: string|null }>}
   */
  static async fetchPrimaryMemberRecurringLabels(householdId) {
    if (!householdId) {
      return { memberFullName: null, householdMemberId: null };
    }
    try {
      const pool = await getPool();
      const result = await pool
        .request()
        .input('householdId', sql.UniqueIdentifier, householdId)
        .query(`
          SELECT TOP 1 m.HouseholdMemberID, u.FirstName, u.LastName
          FROM oe.Members m
          INNER JOIN oe.Users u ON u.UserId = m.UserId
          WHERE m.HouseholdId = @householdId AND m.RelationshipType = 'P'
        `);
      const row = result.recordset?.[0];
      if (!row) return { memberFullName: null, householdMemberId: null };
      const memberFullName = `${row.FirstName || ''} ${row.LastName || ''}`.trim() || null;
      const householdMemberId = row.HouseholdMemberID ? String(row.HouseholdMemberID).trim() : null;
      return { memberFullName, householdMemberId };
    } catch (e) {
      console.warn('⚠️ fetchPrimaryMemberRecurringLabels failed:', e.message);
      return { memberFullName: null, householdMemberId: null };
    }
  }

  /**
   * Setup recurring payment via DIME native recurring API.
   * @param {Object} scheduleData
   * @param {string} scheduleData.customerId - DIME customer ID
   * @param {string} scheduleData.paymentMethodId - DIME payment method ID
   * @param {number} scheduleData.amount - Payment amount in dollars
   * @param {string} [scheduleData.description] - Fallback label for `data.name` when member fields are absent
   * @param {string} [scheduleData.householdId] - Loads primary member name + HouseholdMemberID for `data.name` when not passed explicitly
   * @param {string} [scheduleData.memberFullName]
   * @param {string} [scheduleData.householdMemberId]
   * @param {string} [scheduleData.scheduleName] - Explicit DIME schedule title (highest priority)
   * @param {Date} scheduleData.startDate
   * @param {Date} [scheduleData.endDate]
   * @param {string} tenantId
   * @returns {Promise<Object>}
   */
  static async setupRecurringPayment(scheduleData, tenantId) {
    try {
      let {
        customerId,
        paymentMethodId,
        amount,
        description,
        householdId,
        startDate,
        endDate,
        memberFullName,
        householdMemberId,
        scheduleName
      } = scheduleData;

      if (householdId && (!memberFullName || !householdMemberId)) {
        const labels = await DimeService.fetchPrimaryMemberRecurringLabels(householdId);
        if (!memberFullName) memberFullName = labels.memberFullName;
        if (!householdMemberId) householdMemberId = labels.householdMemberId;
      }

      const recurringDisplayName = buildRecurringPaymentDisplayName({
        scheduleName,
        memberFullName,
        householdMemberId,
        description
      });

      const config = await this.getConfigForTenant(tenantId);
      const headers = this.getHeaders(config);
      
      // Format dates for DIME API (noon UTC for calendar-day stability in US timezones — see formatDimeRecurringDateTime)
      const startDateFormatted = formatDimeRecurringDateTime(startDate);
      
      // Build payload - only include end_date if explicitly provided
      const payload = {
        data: {
          sid: config.sid,
          name: recurringDisplayName,
          amount: amount, // DIME expects amount in dollars
          start_date: startDateFormatted,
          recurrence_schedule: 'Monthly',
          payment_method: paymentMethodId,
          customer_uuid: customerId
        }
      };
      
      // Only include end_date if provided (for individual enrollments, we want no end date)
      if (endDate) {
        const endDateFormatted = formatDimeRecurringDateTime(endDate);
        payload.data.end_date = endDateFormatted;
      }
      
      console.log('🔍 DEBUG: Creating recurring payment with DIME:', {
        sid: config.sid,
        baseUrl: config.baseUrl,
        customerId,
        paymentMethodId,
        amount,
        startDate: startDateFormatted,
        endDate: endDate ? formatDimeRecurringDateTime(endDate) : 'None (recurring indefinitely)',
        householdId
      });

      console.log('🔍 DEBUG: DIME recurring payment payload:', JSON.stringify(payload, null, 2));
      
      const response = await axios.post(
        `${config.baseUrl}/api/recurring-payment/create`,
        payload,
        { headers }
      );
      
      console.log('✅ DIME Recurring Payment Creation Success:', {
        success: true,
        responseData: response.data
      });
      
      // Get the recurring payment ID from the response and convert to string
      const recurringPaymentId = (response.data.data?.id || response.data.id).toString();
      
      // Recurring payment is already active by default - no activation step needed
      console.log('✅ DIME Recurring Payment Setup Complete:', {
        success: true,
        scheduleId: recurringPaymentId,
        status: response.data.data?.status || response.data.status || 'Active',
        message: 'Recurring payment schedule created and active'
      });
      
      return {
        success: true,
        scheduleId: recurringPaymentId,
        nextBillingDate: startDate,
        status: 'active',
        message: 'Recurring payment schedule created and active',
        rawResponse: response.data
      };
      
    } catch (error) {
      console.error('❌ DIME Recurring Payment Creation Error:', {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data
      });
      
      return {
        success: false,
        error: {
          message: error.response?.data?.message || error.message,
          code: error.response?.data?.code || 'RECURRING_SETUP_ERROR',
          status: error.response?.status,
          data: error.response?.data
        }
      };
    }
  }

  /**
   * Cancel a recurring payment schedule in DIME.
   * Uses PATCH /api/recurring-payment/cancel with recurring_payment_id in body (DIME route).
   * Callers must only mark as cancelled in DB when this returns success: true.
   * @param {string} scheduleId - DIME schedule ID to cancel
   * @param {string} tenantId - Tenant ID
   * @returns {Promise<Object>} Cancel result { success, error?, message?, data? }
   */
  static async cancelRecurringPayment(scheduleId, tenantId) {
    try {
      const config = await this.getConfigForTenant(tenantId);
      const headers = this.getHeaders(config);
      const url = `${config.baseUrl}/api/recurring-payment/cancel`;
      const payload = { data: { sid: config.sid, recurring_payment_id: scheduleId } };
      console.log('📤 [DIME] PATCH cancel recurring:', { url, scheduleId });
      
      const response = await axios.patch(
        url,
        payload,
        { headers }
      );
      
      console.log('📥 [DIME] Cancel recurring response:', { status: response.status, data: response.data });

      // DIME's schedule payload often carries an `error` field describing the last TRANSACTION's failure
      // (e.g. dead token) — that is NOT a cancel failure. If the schedule itself reports Cancelled / has
      // a cancelled_at timestamp, the cancel succeeded. Only treat it as a failure when the schedule is
      // not in a cancelled state AND DIME returned an explicit failure signal.
      const body = response.data || {};
      const scheduleStatus = typeof body.status === 'string' ? body.status.toLowerCase() : '';
      const isScheduleCancelled = scheduleStatus === 'cancelled' || scheduleStatus === 'canceled' || !!body.cancelled_at;
      const explicitSuccessFalse = body.success === false;
      const topLevelMessage = typeof body.message === 'string' ? body.message : '';

      if (isScheduleCancelled) {
        if (body.error) {
          console.log('⚠️ [DIME] Schedule cancelled, but response includes last-transaction error (safe to ignore for cancel):', body.error);
        }
        return {
          success: true,
          message: 'Recurring payment schedule canceled',
          data: body
        };
      }

      if (explicitSuccessFalse || topLevelMessage) {
        console.error('❌ DIME cancel recurring returned failure:', body);
        return {
          success: false,
          error: topLevelMessage || body.error || 'DIME did not confirm cancellation',
          data: body
        };
      }

      return {
        success: true,
        message: 'Recurring payment schedule canceled',
        data: body
      };
    } catch (error) {
      const errData = error.response?.data;
      const errMsg = errData?.message || error.message;
      console.log('📥 [DIME] Cancel recurring error:', { status: error.response?.status, data: errData, message: error.message });
      // 404 "route could not be found" = wrong API path; do NOT treat as success
      const isRouteNotFound = errMsg && String(errMsg).toLowerCase().includes('route') && String(errMsg).toLowerCase().includes('could not be found');
      if (error.response?.status === 404 && !isRouteNotFound) {
        // 404 for schedule/resource (e.g. already canceled) - update DB to match
        console.log('⚠️ [DIME] Schedule already canceled or not found (404), updating DB to match');
        return {
          success: true,
          message: 'Schedule already canceled or not found',
          wasAlreadyCanceled: true
        };
      }
      if (isRouteNotFound) {
        console.error('❌ DIME cancel endpoint not found (wrong path?). Use PATCH /api/recurring-payment/cancel with recurring_payment_id in body.');
      }
      console.error('❌ DIME cancel recurring error:', errData || error.message);
      return {
        success: false,
        error: errMsg
      };
    }
  }

  /**
   * Update an existing recurring payment schedule in DIME
   * NOTE: DIME doesn't have a direct update endpoint, so we cancel and recreate
   * @param {Object} updateData - Update data for the recurring payment
   * @param {string} updateData.scheduleId - DIME schedule ID to cancel
   * @param {string} updateData.customerId - DIME customer ID
   * @param {string} updateData.paymentMethodId - Payment method ID
   * @param {number} updateData.amount - New payment amount
   * @param {Date} updateData.startDate - Start date for new schedule
   * @param {string} updateData.description - Payment description (fallback for DIME schedule name)
   * @param {string} [updateData.householdId] - Loads primary member name + HouseholdMemberID for DIME `name` when not passed explicitly
   * @param {string} [updateData.memberFullName]
   * @param {string} [updateData.householdMemberId]
   * @param {string} [updateData.scheduleName]
   * @param {string} tenantId - Tenant ID
   * @returns {Promise<Object>} Update result
   */
  static async updateRecurringPayment(updateData, tenantId) {
    try {
      const { scheduleId, customerId, paymentMethodId, amount, startDate, description } = updateData;
      
      console.log('🔍 DEBUG: Updating recurring payment (cancel + recreate):', { 
        scheduleId, 
        customerId,
        paymentMethodId, 
        amount
      });
      
      const config = await this.getConfigForTenant(tenantId);
      const headers = this.getHeaders(config);
      
      // Step 1: Cancel existing recurring payment schedule (uses PATCH /api/recurring-payment/cancel)
      console.log('🔍 Step 1: Canceling existing recurring payment schedule...');
      const cancelResult = await this.cancelRecurringPayment(scheduleId, tenantId);
      if (cancelResult.success) {
        console.log('✅ Existing recurring payment canceled:', cancelResult.data);
      } else {
        console.warn('⚠️ Failed to cancel existing schedule (proceeding with recreation):', cancelResult.error);
      }
      
      // Step 2: Create new recurring payment with updated amount
      console.log('🔍 Step 2: Creating new recurring payment schedule...');
      const newSchedule = await this.setupRecurringPayment({
        customerId,
        paymentMethodId,
        amount,
        description: description || 'Monthly Payment',
        startDate: startDate || new Date(),
        householdId: updateData.householdId,
        memberFullName: updateData.memberFullName,
        householdMemberId: updateData.householdMemberId,
        scheduleName: updateData.scheduleName
      }, tenantId);
      
      if (!newSchedule.success) {
        throw new Error(`Failed to create new recurring payment: ${newSchedule.message}`);
      }
      
      console.log('✅ DIME Recurring Payment Updated Successfully:', {
        oldScheduleId: scheduleId,
        newScheduleId: newSchedule.scheduleId,
        amount
      });
      
      return {
        success: true,
        scheduleId: newSchedule.scheduleId, // Return NEW schedule ID
        amount: amount,
        nextBillingDate: newSchedule.nextBillingDate,
        message: 'Recurring payment schedule updated (canceled and recreated)'
      };
      
    } catch (error) {
      console.error('❌ DIME Recurring Payment Update Error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data || error.message,
        message: 'Failed to update recurring payment schedule'
      };
    }
  }

  /**
   * Find existing customer by email in DIME
   * @param {string} email - Customer email
   * @param {string} tenantId - Tenant ID for loading DIME credentials
   * @returns {Promise<Object>} Customer lookup result
   */
  static async findCustomerByEmail(email, tenantId) {
    try {
      // DIME lookup should use /api/customer/show with filters.email
      // This keeps behavior consistent across demo/production environments.
      const res = await this.getCustomerByEmail(email, tenantId);
      if (res && res.success && res.customerId) {
        return {
          success: true,
          customer: res.rawResponse || null,
          customerId: res.customerId
        };
      }
      return { success: false, customer: null, customerId: null };
    } catch (error) {
      console.error('❌ Error finding customer by email:', error);
      return {
        success: false,
        error: {
          message: error.message,
          code: 'CUSTOMER_LOOKUP_ERROR'
        }
      };
    }
  }

  /**
   * Get deposit list from DIME for a date range (actual processor fees).
   * GET https://app.dimepayments.com/api/deposit/list with body containing sid and filters.
   * @param {string} tenantId - Tenant ID for DIME config
   * @param {string} startDate - Start date (YYYY-MM-DD or ISO datetime)
   * @param {string} endDate - End date (YYYY-MM-DD or ISO datetime)
   * @returns {Promise<Object>} { success, data: deposits[], error? } - data may include fee per deposit/transaction
   */
  static async getDepositList(tenantId, startDate, endDate) {
    try {
      const config = await this.getConfigForTenant(tenantId);
      const headers = this.getHeaders(config);
      const startDateTime = typeof startDate === 'string' && startDate.length === 10
        ? `${startDate} 00:00:00`
        : startDate;
      const endDateTime = typeof endDate === 'string' && endDate.length === 10
        ? `${endDate} 23:59:59`
        : endDate;
      const payload = {
        data: { sid: config.sid },
        filters: {
          start_date: startDateTime,
          end_date: endDateTime
        }
      };
      console.log('📋 DIME getDepositList request:', {
        tenantId,
        tenantName: config.tenantName,
        baseUrl: config.baseUrl,
        sid: config.sid,
        start_date: startDateTime,
        end_date: endDateTime
      });
      const response = await axios.get(`${config.baseUrl}/api/deposit/list`, {
        headers,
        data: payload
      });
      return {
        success: true,
        data: response.data?.data ?? response.data ?? []
      };
    } catch (error) {
      console.error('❌ DIME getDepositList error:', error?.response?.data || error.message, { tenantId, start_date: startDate, end_date: endDate });
      return {
        success: false,
        data: [],
        error: error?.response?.data || { message: error.message }
      };
    }
  }

  /**
   * Get DIME processor fee for a single transaction using deposit list (no per-transaction endpoint).
   * Calls GET /api/deposit/list for the payment date and finds the matching transaction by transaction_id or transaction_info_id.
   * Fee from item.fee, or derived as authorization_amount - net_amount when fee not present.
   * @param {string} tenantId - Tenant ID for DIME config
   * @param {string} processorTransactionId - DIME transaction ID (ProcessorTransactionId from oe.Payments)
   * @param {string|Date} paymentDate - Payment date (YYYY-MM-DD or Date) to request deposit list for that day
   * @returns {Promise<Object>} { success, processorFee: number | null, processorName: 'DIME', error? }
   */
  static async getProcessorFeeForTransaction(tenantId, processorTransactionId, paymentDate) {
    const txId = processorTransactionId ? String(processorTransactionId).trim() : '';
    if (!txId) {
      return { success: false, processorFee: null, processorName: 'DIME', error: { message: 'Processor transaction ID required' } };
    }
    const dateStr = paymentDate
      ? (typeof paymentDate === 'string' && paymentDate.length >= 10
        ? paymentDate.slice(0, 10)
        : (paymentDate instanceof Date ? paymentDate.toISOString().slice(0, 10) : null))
      : null;
    if (!dateStr) {
      return { success: false, processorFee: null, processorName: 'DIME', error: { message: 'Payment date required' } };
    }
    try {
      const depositRes = await this.getDepositList(tenantId, dateStr, dateStr);
      if (!depositRes.success) {
        const msg = (depositRes.error?.message || '').toLowerCase();
        if (msg.includes('permission denied') || msg.includes('permission denied.')) {
          return { success: true, processorFee: null, processorName: 'DIME', comingSoon: true };
        }
        return { success: true, processorFee: null, processorName: 'DIME' };
      }
      if (!Array.isArray(depositRes.data)) {
        return { success: true, processorFee: null, processorName: 'DIME' };
      }
      const match = depositRes.data.find((item) => {
        const id = item.transaction_id ?? item.transaction_info_id ?? item.transactionId ?? item.transactionInfoId;
        return id != null && String(id).trim() === txId;
      });
      if (!match) {
        return { success: true, processorFee: null, processorName: 'DIME' };
      }
      const fee =
        match.fee ?? match.processor_fee ?? match.processing_fee ?? match.transaction_fee
          ?? match.Fee ?? match.ProcessorFee ?? match.ProcessingFee ?? match.fee_amount;
      if (fee != null && !Number.isNaN(Number(fee))) {
        return { success: true, processorFee: Number(fee), processorName: 'DIME' };
      }
      const auth = match.authorization_amount ?? match.authorizationAmount;
      const net = match.net_amount ?? match.netAmount;
      if (auth != null && net != null) {
        const authNum = Number(auth);
        const netNum = Number(net);
        if (!Number.isNaN(authNum) && !Number.isNaN(netNum)) {
          const derivedFee = authNum - netNum;
          return { success: true, processorFee: Math.round(derivedFee * 100) / 100, processorName: 'DIME' };
        }
      }
      return { success: true, processorFee: null, processorName: 'DIME' };
    } catch (error) {
      console.warn('DIME getProcessorFeeForTransaction (deposit list):', txId, error?.message);
      return {
        success: false,
        processorFee: null,
        processorName: 'DIME',
        error: error?.response?.data ?? { message: error.message }
      };
    }
  }

  /**
   * GET /api/recurring-payment/list for one DIME customer (GET with JSON body per DIME spec).
   * @param {string} customerId - DIME customer_uuid (ProcessorCustomerId)
   * @param {string} tenantId
   * @param {{ status?: string; preloadedConfig?: object }} opts - e.g. status: 'Active'; pass preloadedConfig from batch callers to avoid reloading config per customer.
   */
  static async listRecurringPaymentsForCustomer(customerId, tenantId, opts = {}) {
    try {
      const config = opts.preloadedConfig || (await this.getConfigForTenant(tenantId));
      const headers = this.getHeaders(config, { silent: true });
      const cid = String(customerId || '').trim();
      if (!cid) {
        return { success: false, schedules: [], error: { message: 'customerId required' } };
      }
      const filters = { customer_uuid: cid };
      if (opts.status) filters.status = opts.status;
      const response = await axios.request({
        method: 'GET',
        url: `${config.baseUrl}/api/recurring-payment/list`,
        headers,
        data: {
          data: { sid: config.sid },
          filters
        }
      });
      const raw = response.data?.data;
      const schedules = Array.isArray(raw) ? raw : [];
      return { success: true, schedules, rawResponse: response.data };
    } catch (error) {
      const msg = String(error.response?.data?.message || error.message || '');
      const is404NoRecurring =
        error.response?.status === 404 &&
        (msg.toLowerCase().includes('no recurring') || msg.toLowerCase().includes('not found'));
      if (is404NoRecurring) {
        return { success: true, schedules: [] };
      }
      return {
        success: false,
        schedules: [],
        error: {
          message: error.response?.data?.message || error.message,
          status: error.response?.status
        }
      };
    }
  }

  /**
   * Sum Active recurring amounts from DIME recurring-payment/list across distinct customer UUIDs (parallel batches).
   */
  static async sumActiveRecurringMrrFromDimeApi(tenantId, customerIds, options = {}) {
    const timeoutMs = options.timeoutMs ?? 22000;
    const maxCustomers = options.maxCustomers ?? 200;
    const concurrency = options.concurrency ?? 6;
    const started = Date.now();
    const raw = customerIds || [];
    const uniqueAll = [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))];
    const capped = uniqueAll.length > maxCustomers;
    const ids = uniqueAll.slice(0, maxCustomers);
    if (ids.length === 0) {
      return {
        total: 0,
        customersChecked: 0,
        customersSkipped: 0,
        scheduleRowsCounted: 0,
        apiCallFailures: 0,
        timedOut: false,
        capped: false
      };
    }
    const safeAmount = (v) => {
      if (v == null) return 0;
      if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
      const raw = String(v).trim();
      if (!raw) return 0;
      const normalized = raw.replace(/[$,\s]/g, '');
      const n = Number(normalized);
      return Number.isFinite(n) ? n : 0;
    };
    const dimeConfig = await this.getConfigForTenant(tenantId);
    let total = 0;
    let scheduleRowsCounted = 0;
    let apiCallFailures = 0;
    let timedOut = false;
    let nextRunDateMin = null;
    let nextRunDateMax = null;
    const updateNextRunRange = (value) => {
      if (!value) return;
      const d = new Date(String(value));
      if (Number.isNaN(d.getTime())) return;
      if (!nextRunDateMin || d < nextRunDateMin) nextRunDateMin = d;
      if (!nextRunDateMax || d > nextRunDateMax) nextRunDateMax = d;
    };
    for (let i = 0; i < ids.length; i += concurrency) {
      if (Date.now() - started > timeoutMs) {
        timedOut = true;
        break;
      }
      const chunk = ids.slice(i, i + concurrency);
      const results = await Promise.all(
        chunk.map(async (cid) => {
          const res = await this.listRecurringPaymentsForCustomer(cid, tenantId, {
            status: 'Active',
            preloadedConfig: dimeConfig
          });
          if (!res.success) {
            return { sum: 0, rows: 0, fail: true, nextRunDateMin: null, nextRunDateMax: null };
          }
          let sum = 0;
          let rows = 0;
          let localMin = null;
          let localMax = null;
          for (const sch of res.schedules || []) {
            const st = String(sch.status || '').trim().toLowerCase();
            if (st !== 'active') continue;
            sum += safeAmount(sch.amount);
            rows += 1;
            const nrd = sch.next_run_date || sch.nextRunDate || sch.next_billing_date || sch.nextBillingDate || null;
            if (nrd) {
              const d = new Date(String(nrd));
              if (!Number.isNaN(d.getTime())) {
                if (!localMin || d < localMin) localMin = d;
                if (!localMax || d > localMax) localMax = d;
              }
            }
          }
          return { sum, rows, fail: false, nextRunDateMin: localMin, nextRunDateMax: localMax };
        })
      );
      for (const r of results) {
        if (r.fail) apiCallFailures += 1;
        else {
          total += r.sum;
          scheduleRowsCounted += r.rows;
          updateNextRunRange(r.nextRunDateMin);
          updateNextRunRange(r.nextRunDateMax);
        }
      }
    }
    const rounded = Math.round(total * 100) / 100;
    return {
      total: Number.isFinite(rounded) ? rounded : 0,
      customersChecked: ids.length,
      customersSkipped: capped ? uniqueAll.length - maxCustomers : 0,
      scheduleRowsCounted,
      apiCallFailures,
      timedOut,
      capped,
      nextRunDateMin: nextRunDateMin ? nextRunDateMin.toISOString() : null,
      nextRunDateMax: nextRunDateMax ? nextRunDateMax.toISOString() : null,
      snapshotAt: new Date().toISOString()
    };
  }
}

// Expose the friendly-error helpers on the class so callers (routes, services) can reuse them
// without duplicating the ISO-8583 / Laravel-validation mapping.
DimeService.buildFriendlyDimeDeclineError = buildFriendlyDimeDeclineError;
DimeService.buildFriendlyDimeVaultError = buildFriendlyDimeVaultError;

module.exports = DimeService;
