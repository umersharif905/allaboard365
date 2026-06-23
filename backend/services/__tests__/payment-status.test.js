/**
 * Unit tests for shared/payment-status (DIME → oe.Payments mapping).
 * Run from backend: npm test -- payment-status
 */
const { requireShared } = require('../../config/shared-modules');
const paymentStatus = requireShared('payment-status');

const {
  mapDimePayloadToPaymentRecordStatus,
  mapDimeSyncChargeResponseToDbStatus,
  mapChargeWebhookMappedStatusToDbStatus,
  isDimePendingFlagTrue,
  isSuccessfulPaymentRecordStatus,
  formatDimeRecurringFailureReasonForStorage,
  formatDimeChargeFailureReasonForStorage,
  normalizeDimeRecurringProcessorTransactionId,
  extractDimePaymentRetryAttemptFromPayload,
  normalizeInboundRecurringWebhookBody
} = paymentStatus;

describe('shared/payment-status', () => {
  describe('isDimePendingFlagTrue', () => {
    it('is true for boolean true', () => {
      expect(isDimePendingFlagTrue({ pending: true })).toBe(true);
    });
    it('is false for boolean false', () => {
      expect(isDimePendingFlagTrue({ pending: false })).toBe(false);
    });
    it('is false when pending is omitted', () => {
      expect(isDimePendingFlagTrue({ status_code: '00' })).toBe(false);
    });
  });

  describe('mapDimePayloadToPaymentRecordStatus', () => {
    it('maps DIME sample with pending:false and Success to Completed', () => {
      const data = {
        transaction_type: 'ACH',
        transaction_status: 'Success',
        transaction_status_description: 'Success',
        transaction_number: '130',
        amount: '25',
        status_code: '00',
        status_text: 'Success',
        pending: false
      };
      expect(mapDimePayloadToPaymentRecordStatus(data)).toBe('Completed');
    });

    it('maps pending:true to Pending when status_code/text are not an explicit 00+approval (pending settles after code)', () => {
      const data = {
        transaction_status: 'Success',
        pending: true
      };
      expect(mapDimePayloadToPaymentRecordStatus(data)).toBe('Pending');
    });

    it('maps status_code 00 + approval text to Completed even when pending:true (explicit approval wins)', () => {
      const data = {
        transaction_status: 'Success',
        status_code: '00',
        status_text: 'Success',
        pending: true
      };
      expect(mapDimePayloadToPaymentRecordStatus(data)).toBe('Completed');
    });

    it('maps status_code 00 and status_text APPROVAL (DIME demo) to Completed', () => {
      const data = {
        status_code: '00',
        status_text: 'APPROVAL',
        pending: false
      };
      expect(mapDimePayloadToPaymentRecordStatus(data)).toBe('Completed');
    });

    it('maps ACH_PAYMENT_CREDIT_PENDING before bare status_code 00 (manual ACH charge API)', () => {
      const data = {
        transaction_type: 'ACH',
        transaction_status: 'ACH_PAYMENT_CREDIT_PENDING',
        status_code: '00',
        status_text: '',
        pending: true
      };
      expect(mapDimePayloadToPaymentRecordStatus(data)).toBe('Pending');
    });

    it('still maps non-00 status_code to Failed when pending:true', () => {
      const data = {
        status_code: '05',
        status_text: 'Declined',
        pending: true
      };
      expect(mapDimePayloadToPaymentRecordStatus(data)).toBe('Failed');
    });

    it('maps ACH_PAYMENT_CREDIT_REJECTED to Failed (not Completed)', () => {
      const data = {
        transaction_type: 'ACH',
        transaction_status: 'ACH_PAYMENT_CREDIT_REJECTED',
        transaction_status_description: 'Submitted ACH Payment that has been rejected after the ACH file has been submitted.'
      };
      expect(mapDimePayloadToPaymentRecordStatus(data)).toBe('Failed');
    });

    it('maps ACH_PAYMENT_REFUND to Refunded (money out, not a capture; previously Unknown → stuck Pending)', () => {
      const data = {
        transaction_type: 'ACH',
        transaction_status: 'ACH_PAYMENT_REFUND',
        transaction_status_description:
          'Completed ACH transfer of funds out of the ProPay Account to a bank account.',
        status_code: '',
        status_text: '',
        pending: false
      };
      expect(mapDimePayloadToPaymentRecordStatus(data)).toBe('Refunded');
    });

    it('maps CC_REFUND to Refunded', () => {
      const data = { transaction_status: 'CC_REFUND', pending: false };
      expect(mapDimePayloadToPaymentRecordStatus(data)).toBe('Refunded');
    });

    it('refund label wins even when a refund payload carries an approval status_code 00', () => {
      const data = {
        transaction_status: 'ACH_PAYMENT_REFUND',
        status_code: '00',
        status_text: 'APPROVAL',
        pending: false
      };
      expect(mapDimePayloadToPaymentRecordStatus(data)).toBe('Refunded');
    });

    it('does not confuse a "returned" ACH debit (failed) with a refund', () => {
      const data = {
        transaction_type: 'ACH',
        transaction_status: 'ACH_PAYMENT_RETURNED',
        pending: false
      };
      expect(mapDimePayloadToPaymentRecordStatus(data)).toBe('Failed');
    });
  });

  describe('mapRecurringSuccessWebhookToDbStatus', () => {
    it('stores ACH recurring success with empty transaction_status as Pending', () => {
      const payload = {
        type: 'recurring_payment_success',
        transaction_type: 'ACH',
        transaction_status: '',
        status_code: '00',
        status_text: 'Success',
        pending: false
      };
      expect(paymentStatus.mapRecurringSuccessWebhookToDbStatus(payload)).toBe('Pending');
    });

    it('stores settled ACH recurring with ACH_PAYMENT_CREDIT as Completed', () => {
      const payload = {
        transaction_type: 'ACH',
        transaction_status: 'ACH_PAYMENT_CREDIT',
        status_code: '00',
        status_text: 'Success'
      };
      expect(paymentStatus.mapRecurringSuccessWebhookToDbStatus(payload)).toBe('Completed');
    });

    it('stores CC recurring success as Completed when approved', () => {
      const payload = {
        transaction_type: 'CC',
        status_code: '00',
        status_text: 'Success'
      };
      expect(paymentStatus.mapRecurringSuccessWebhookToDbStatus(payload)).toBe('Completed');
    });
  });

  describe('mapChargeWebhookMappedStatusToDbStatus', () => {
    it('maps Completed and Failed exactly', () => {
      expect(mapChargeWebhookMappedStatusToDbStatus('Completed')).toBe('Completed');
      expect(mapChargeWebhookMappedStatusToDbStatus('Failed')).toBe('Failed');
    });
    it('passes through Refunded, Voided, Canceled', () => {
      expect(mapChargeWebhookMappedStatusToDbStatus('Refunded')).toBe('Refunded');
      expect(mapChargeWebhookMappedStatusToDbStatus('Voided')).toBe('Voided');
      expect(mapChargeWebhookMappedStatusToDbStatus('Canceled')).toBe('Canceled');
    });
    it('defaults Unknown and other non-terminal mapper output to Pending', () => {
      expect(mapChargeWebhookMappedStatusToDbStatus('Unknown')).toBe('Pending');
      expect(mapChargeWebhookMappedStatusToDbStatus('Pending')).toBe('Pending');
      expect(mapChargeWebhookMappedStatusToDbStatus('')).toBe('Pending');
      expect(mapChargeWebhookMappedStatusToDbStatus(null)).toBe('Pending');
      expect(mapChargeWebhookMappedStatusToDbStatus(undefined)).toBe('Pending');
    });
  });

  describe('isSuccessfulPaymentRecordStatus', () => {
    it('treats Pending as not successful for payout-style checks', () => {
      expect(isSuccessfulPaymentRecordStatus('Pending')).toBe(false);
    });
    it('treats Completed as successful', () => {
      expect(isSuccessfulPaymentRecordStatus('Completed')).toBe(true);
    });
  });

  describe('normalizeInboundRecurringWebhookBody', () => {
    it('uses flattened root when envelope has empty nested data (DIME recurring failure)', () => {
      const raw = {
        event_type: 'recurring_payment_failed',
        data: {},
        recurring_payment_id: 815,
        transaction_error_code: '23',
        transaction_error: 'Token lookup failed.',
        amount: '824.0000'
      };
      const { eventType, data } = normalizeInboundRecurringWebhookBody(raw);
      expect(eventType).toBe('recurring_payment.failed');
      expect(data.transaction_error_code).toBe('23');
      expect(data.transaction_error).toBe('Token lookup failed.');
      expect(formatDimeRecurringFailureReasonForStorage(data)).toBe('[23] Token lookup failed.');
    });
    it('keeps populated nested envelope data when present', () => {
      const raw = {
        event_type: 'recurring_payment_failed',
        data: { recurring_payment_id: 1, transaction_error_code: '05', transaction_error: 'Declined.' }
      };
      const { data } = normalizeInboundRecurringWebhookBody(raw);
      expect(data.recurring_payment_id).toBe(1);
      expect(data.transaction_error).toBe('Declined.');
    });
  });

  describe('formatDimeRecurringFailureReasonForStorage', () => {
    it('prefers legacy failure_reason when present', () => {
      expect(
        formatDimeRecurringFailureReasonForStorage({
          failure_reason: '  Insufficient funds  ',
          transaction_error: 'IGNORED',
          transaction_error_code: '99'
        })
      ).toBe('Insufficient funds');
    });
    it('builds [code] message from transaction_error fields', () => {
      expect(
        formatDimeRecurringFailureReasonForStorage({
          transaction_error_code: '23',
          transaction_error: 'Token lookup failed.'
        })
      ).toBe('[23] Token lookup failed.');
    });
    it('falls back to status_code/status_text when transaction_error* omitted (thin retry payloads)', () => {
      expect(
        formatDimeRecurringFailureReasonForStorage({
          status_code: '51',
          status_text: 'DECLINE Issuer decline'
        })
      ).toBe('[51] DECLINE Issuer decline');
    });
    it('returns Unknown when empty', () => {
      expect(formatDimeRecurringFailureReasonForStorage({})).toBe('Unknown');
    });
  });

  describe('mapDimeSyncChargeResponseToDbStatus', () => {
    it('returns Pending for CC_CREDIT with pending:true even when status_code is 00', () => {
      expect(
        mapDimeSyncChargeResponseToDbStatus({
          transaction_type: 'CC',
          transaction_status: 'CC_CREDIT',
          status_code: '00',
          status_text: 'Approved',
          pending: true
        })
      ).toBe('Pending');
    });
    it('returns Pending for card charge without settlement dates', () => {
      expect(
        mapDimeSyncChargeResponseToDbStatus({
          transaction_type: 'CC',
          transaction_status: 'CC_CREDIT',
          status_code: '00',
          fund_date: null,
          settle_date: null
        })
      ).toBe('Pending');
    });
  });

  describe('formatDimeChargeFailureReasonForStorage', () => {
    it('prefers failure_reason when present', () => {
      expect(
        formatDimeChargeFailureReasonForStorage({
          failure_reason: '  Card declined  ',
          status_code: '05',
          status_text: 'DECLINE'
        })
      ).toBe('Card declined');
    });
    it('builds [code] status_text when failure_reason empty', () => {
      expect(
        formatDimeChargeFailureReasonForStorage({
          status_code: '05',
          status_text: 'Do not honor'
        })
      ).toBe('[05] Do not honor');
    });
    it('uses transaction_error like recurring helper', () => {
      expect(
        formatDimeChargeFailureReasonForStorage({
          transaction_error_code: '23',
          transaction_error: 'Lookup failed'
        })
      ).toBe('[23] Lookup failed');
    });
    it('returns empty string when no signals', () => {
      expect(formatDimeChargeFailureReasonForStorage({})).toBe('');
    });
    it('does not treat CC_CREDIT posted-credit label as a failure reason', () => {
      expect(
        formatDimeChargeFailureReasonForStorage({
          transaction_status: 'CC_CREDIT',
          pending: true
        })
      ).toBe('');
    });
  });

  describe('normalizeDimeRecurringProcessorTransactionId', () => {
    it('reads transaction_number snake case', () => {
      expect(normalizeDimeRecurringProcessorTransactionId({ transaction_number: 'FAKE-1' })).toBe('FAKE-1');
    });
    it('returns null when absent', () => {
      expect(normalizeDimeRecurringProcessorTransactionId({ amount: '1' })).toBe(null);
    });
  });

  describe('extractDimePaymentRetryAttemptFromPayload', () => {
    it('parses attempt_number integer string', () => {
      expect(extractDimePaymentRetryAttemptFromPayload({ attempt_number: '3' })).toBe(3);
    });
    it('prefers camelCase billingAttemptNumber', () => {
      expect(extractDimePaymentRetryAttemptFromPayload({ billingAttemptNumber: 2 })).toBe(2);
    });
    it('returns null when missing', () => {
      expect(extractDimePaymentRetryAttemptFromPayload({ status_text: 'Declined' })).toBe(null);
    });
  });
});
