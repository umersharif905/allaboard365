'use strict';

/**
 * User-facing copy for manual / one-time charges when DIME accepted the charge
 * but settlement is still pending (pending:true, CC_CREDIT without fund_date, ACH).
 * Keep aligned with frontend/src/constants/paymentMessages.ts
 */
const PENDING_BANK_APPROVAL_MESSAGE =
  'Payment succeeded but is pending approval with your bank. Please give it 24-48 hours to fully process. Not to worry — your coverage will remain in effect.';

module.exports = {
  PENDING_BANK_APPROVAL_MESSAGE,
};
