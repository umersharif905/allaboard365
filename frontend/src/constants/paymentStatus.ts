/**
 * DIME / oe.Payments status helpers for the React app (ESM).
 * Keep logic aligned with repo root `shared/payment-status/index.js` (CommonJS for Node).
 */

export type DimeTransactionPayload = {
  status_code?: string | number | null;
  status_text?: string | null;
  statusCode?: string | number | null;
  statusText?: string | null;
  status?: string | null;
  transaction_status?: string | null;
  transactionStatus?: string | null;
  /** When true, transaction accepted but settlement still pending (e.g. ACH). */
  pending?: boolean | string | number | null;
};

export type PaymentRecordStatusCategory =
  | 'Completed'
  | 'Failed'
  | 'Pending'
  | 'Unknown'
  | 'Refunded'
  | 'Voided'
  | 'Canceled';

const SUCCESSFUL_PAYMENT_RECORD_STATUSES_EXACT: readonly string[] = [
  'Completed',
  'APPROVAL',
  'SUCCESS',
  'COMPLETED',
  'succeeded',
  'Approved',
  'PAID',
] as const;

export const SUCCESSFUL_PAYMENT_RECORD_STATUSES = SUCCESSFUL_PAYMENT_RECORD_STATUSES_EXACT;

/** DIME often sends status_text "APPROVAL" not "APPROVED" when code is 00; ACH may send "Success". */
function isDimeApprovedStatusText(statusText: string | null | undefined): boolean {
  const t = String(statusText ?? '').toLowerCase();
  return t.includes('approved') || t.includes('approval') || t.includes('success');
}

export function isDimeChargeApproved(data: DimeTransactionPayload | null | undefined): boolean {
  if (!data || typeof data !== 'object') return false;
  const code = data.status_code != null ? String(data.status_code).trim() : '';
  const text = data.status_text ?? data.statusText ?? '';
  return code === '00' && isDimeApprovedStatusText(text);
}

export function shouldTreatRecurringSuccessWebhookAsDeclined(
  data: DimeTransactionPayload | null | undefined
): boolean {
  if (!data || typeof data !== 'object') return false;
  const code = data.status_code != null ? String(data.status_code).trim() : '';
  const text = String(data.status_text ?? data.statusText ?? '').trim();
  if (!code && !text) return false;
  return !isDimeChargeApproved(data);
}

export function isDimePendingFlagTrue(data: DimeTransactionPayload | null | undefined): boolean {
  if (!data || typeof data !== 'object' || !Object.prototype.hasOwnProperty.call(data, 'pending')) {
    return false;
  }
  const p = data.pending;
  if (p === true) return true;
  if (p === false) return false;
  if (p == null) return false;
  const s = String(p).toLowerCase().trim();
  return s === 'true' || s === '1' || s === 'yes';
}

/** Webhooks: often `status_code` + `status_text`. List `/api/transactions`: often empty codes + `transaction_status` e.g. CC_CREDIT. */
export function mapDimePayloadToPaymentRecordStatus(
  data: DimeTransactionPayload | null | undefined,
  options: { transactionStatus?: string | null } = {}
): PaymentRecordStatusCategory | string {
  const transactionStatus = options.transactionStatus ?? data?.transaction_status ?? data?.transactionStatus;
  if (data && typeof data === 'object') {
    const tsEarly = String(transactionStatus || '').toLowerCase();
    if (tsEarly.includes('pending') || tsEarly.includes('processing')) return 'Pending';
    // A refund label wins over any status_code/text below: a settled refund can carry
    // an approval code, but it is money out, not a capture.
    if (tsEarly.includes('refund')) return 'Refunded';

    let code = data.status_code != null ? String(data.status_code).trim() : '';
    if (code === '0') code = '00';
    const text = String(data.status_text ?? data.statusText ?? '');
    if (code !== '' || text !== '') {
      if (code === '00' && isDimeApprovedStatusText(text)) return 'Completed';
      if (code === '00' && text === '') return 'Completed';
      if (code && code !== '00') return 'Failed';
    }
    if (isDimePendingFlagTrue(data)) return 'Pending';
  }
  const ts = String(transactionStatus || '').toLowerCase();
  // Refund labels (e.g. ACH_PAYMENT_REFUND, CC_REFUND) are money flowing OUT to the
  // member — distinct from a "returned"/failed debit. Map before the credit/approved
  // checks so a settled refund is not mistaken for a successful capture, and so these
  // rows do not fall through to Unknown (which left them stuck Pending forever).
  if (ts.includes('refund')) return 'Refunded';
  if (ts.includes('approved') || ts.includes('completed') || ts.includes('success') || ts.includes('settled')) {
    return 'Completed';
  }
  if (ts.includes('pending') || ts.includes('processing')) return 'Pending';
  if (ts.includes('failed') || ts.includes('declined') || ts.includes('returned') || ts.includes('rejected')) {
    return 'Failed';
  }
  if (ts.includes('cc_credit') && !ts.includes('pending') && !ts.includes('rejected')) return 'Completed';
  if (
    ts.includes('ach_payment_credit') &&
    !ts.includes('pending') &&
    !ts.includes('rejected') &&
    !ts.includes('failed')
  ) {
    return 'Completed';
  }
  if (ts === 'deposit') return 'Unknown';
  const statusMap: Record<string, PaymentRecordStatusCategory | string> = {
    completed: 'Completed',
    success: 'Completed',
    succeeded: 'Completed',
    failed: 'Failed',
    failure: 'Failed',
    pending: 'Pending',
    processing: 'Pending',
    refunded: 'Refunded',
    voided: 'Voided',
    canceled: 'Canceled',
    cancelled: 'Canceled',
  };
  const raw = data && typeof data === 'object' ? String(data.status || '').toLowerCase() : '';
  if (raw && statusMap[raw]) return statusMap[raw];
  return 'Unknown';
}

/** CC/ACH charge webhooks: Completed / Failed (explicit) / terminal states; else Pending (including Unknown from mapper). */
export function mapChargeWebhookMappedStatusToDbStatus(
  mapped: PaymentRecordStatusCategory | string | null | undefined
): 'Completed' | 'Failed' | 'Pending' | 'Refunded' | 'Voided' | 'Canceled' {
  const m = mapped == null ? '' : String(mapped).trim();
  if (m === 'Completed') return 'Completed';
  if (m === 'Failed') return 'Failed';
  if (m === 'Refunded' || m === 'Voided' || m === 'Canceled') return m;
  return 'Pending';
}

/** ACH recurring_payment_success with empty transaction_status = initiated, not settled. */
export function mapRecurringSuccessWebhookToDbStatus(
  dimePayload: DimeTransactionPayload | Record<string, unknown> | null | undefined
): 'Completed' | 'Failed' | 'Pending' | 'Refunded' | 'Voided' | 'Canceled' {
  const txType = String(
    (dimePayload as Record<string, unknown>)?.transaction_type ??
      (dimePayload as Record<string, unknown>)?.transactionType ??
      ''
  )
    .trim()
    .toUpperCase();
  if (txType === 'ACH') {
    const ts = String(
      (dimePayload as Record<string, unknown>)?.transaction_status ??
        (dimePayload as Record<string, unknown>)?.transactionStatus ??
        ''
    ).trim();
    if (!ts) return 'Pending';
    const lower = ts.toLowerCase();
    if (lower.includes('pending') || lower.includes('processing')) return 'Pending';
  }
  const mapped = mapDimePayloadToPaymentRecordStatus(dimePayload as DimeTransactionPayload);
  return mapChargeWebhookMappedStatusToDbStatus(mapped);
}

export function mapDimeRowToPaymentRecordStatus(
  dimeStatus?: string | null,
  statusCode?: string | number | null,
  statusText?: string | null,
  transactionStatus?: string | null,
  rawListStatusFromApi?: string | null,
  pendingFromApi?: boolean | string | number | null
): PaymentRecordStatusCategory | string {
  const statusField =
    rawListStatusFromApi != null && String(rawListStatusFromApi).trim() !== ''
      ? rawListStatusFromApi
      : dimeStatus;
  const payload: DimeTransactionPayload = { status_code: statusCode, status_text: statusText, status: statusField };
  if (pendingFromApi !== undefined) payload.pending = pendingFromApi;
  return mapDimePayloadToPaymentRecordStatus(payload, { transactionStatus });
}

export function isSuccessfulPaymentRecordStatus(status: string | null | undefined): boolean {
  if (status == null || status === '') return false;
  const s = String(status).trim();
  if (SUCCESSFUL_PAYMENT_RECORD_STATUSES_EXACT.some((x) => x === s)) return true;
  const lower = s.toLowerCase();
  return (
    lower === 'completed' ||
    lower === 'approval' ||
    lower === 'success' ||
    lower === 'succeeded' ||
    lower === 'approved' ||
    lower === 'paid'
  );
}
