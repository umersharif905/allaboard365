'use strict';

const { requireShared } = require('../../config/shared-modules');
const { PENDING_BANK_APPROVAL_MESSAGE } = requireShared('payment-messages');
const { isSuccessfulPaymentRecordStatus } = requireShared('payment-status');

describe('shared/payment-messages', () => {
  it('exports pending bank approval user message', () => {
    expect(PENDING_BANK_APPROVAL_MESSAGE).toMatch(/pending approval with your bank/i);
    expect(PENDING_BANK_APPROVAL_MESSAGE).toMatch(/24-48 hours/i);
    expect(PENDING_BANK_APPROVAL_MESSAGE).toMatch(/coverage will remain in effect/i);
  });

  it('Pending is not a successful payment record status (invoice stays open)', () => {
    expect(isSuccessfulPaymentRecordStatus('Pending')).toBe(false);
  });
});
