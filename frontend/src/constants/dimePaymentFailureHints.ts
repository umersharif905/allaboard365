/**
 * UI guidance for oe.Payments.FailureReason strings (often from DIME webhooks).
 * Keep aligned with persisted format from shared/payment-status formatDimeRecurringFailureReasonForStorage.
 */

const norm = (s: string | null | undefined) => String(s ?? '').trim().toLowerCase();

/** Optional second-line hint beneath the processor message (admin-facing). */
export function getStoredDimePaymentFailureUiHint(
  reason: string | null | undefined,
  paymentStatus?: string | null
): string | null {
  if (!reason || typeof reason !== 'string') return null;
  const r = reason.toLowerCase();
  if (
    (paymentStatus || '').toLowerCase() === 'pending' &&
    (r.includes('ach_payment_credit_pending') || (r.includes('ach_payment') && r.includes('pending')))
  ) {
    return 'ACH submitted successfully; funds are still settling at the bank. This is not a decline—status should move to Completed when DIME posts the settlement webhook or after the payment status audit sync.';
  }
  if (r.includes('[23]') || r.includes('lookup on the supplied token failed') || r.includes('taas resultcode: 400')) {
    return 'DIME code 23: saved card token could not be resolved. Use “Replace vault at processor” on the payment method row (Payments tab), or have the member re-add their card; then confirm the recurring schedule references that method before retrying.';
  }
  const isDeclineLine =
    /\b(decline)\b/.test(norm(reason)) ||
    r.includes('[05]') ||
    r.includes('[51]');
  if (isDeclineLine) {
    return 'Issuer decline: the bank or card brand rejected the transaction. Ask the member to verify funds/card controls or call the number on the back of their card.';
  }
  if (r.includes('[69]') && r.includes('duplicate invoice')) {
    return 'Duplicate invoice/reference at the processor—investigate idempotency or billing descriptors before retrying.';
  }
  if (r.includes('invalid routing number') || r.includes('[46]')) {
    return 'Bank account / ACH routing validation failed—the member likely needs corrected bank info or use a card until ACH is fixed.';
  }
  return null;
}
