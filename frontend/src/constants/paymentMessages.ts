/**
 * Manual charge user messages. Keep aligned with shared/payment-messages/index.js
 */
import { isSuccessfulPaymentRecordStatus } from './paymentStatus';

export const PENDING_BANK_APPROVAL_MESSAGE =
  'Payment succeeded but is pending approval with your bank. Please give it 24-48 hours to fully process. Not to worry — your coverage will remain in effect.';

export type ManualChargeToastSeverity = 'success' | 'info';

/** Success toast for Completed vs pending bank approval for one-time charges. */
export function getManualChargeToastMessage(options: {
  paymentRecordStatus?: string | null;
  settledMessage: string;
}): { message: string; severity: ManualChargeToastSeverity } {
  if (isSuccessfulPaymentRecordStatus(String(options.paymentRecordStatus ?? ''))) {
    return { message: options.settledMessage, severity: 'success' };
  }
  return { message: PENDING_BANK_APPROVAL_MESSAGE, severity: 'info' };
}
