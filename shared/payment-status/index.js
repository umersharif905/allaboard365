'use strict';

/**
 * Vendored for Azure Functions deploy: the function app root has no repo parent, so
 * require('../../shared/payment-status') fails on Azure. Keep in sync with
 * ../../../shared/payment-status/index.js (repo root).
 *
 * Single source of truth for DIME → oe.Payments status mapping and
 * "did money actually succeed?" checks. Keep in sync with index.d.ts.
 *
 * Used by: backend (dimeService, enrollment routes), oe_payment_manager (webhooks, sync).
 * Frontend ESM copy: frontend/src/constants/paymentStatus.ts (keep in sync).
 */

/** Values that may appear in oe.Payments.Status for a successful capture */
const SUCCESSFUL_PAYMENT_RECORD_STATUSES_EXACT = Object.freeze([
  'Completed',
  'APPROVAL',
  'SUCCESS',
  'COMPLETED',
  'succeeded',
  'Approved',
  'PAID',
]);

/**
 * DIME returns status_text "APPROVAL" (noun) as often as "APPROVED" — both mean approved when code is 00.
 * ACH recurring/charge webhooks often send status_text "Success" with code 00 — treat as approved (not declined).
 */
function isDimeApprovedStatusText(statusText) {
  const t = String(statusText ?? '').toLowerCase();
  return (
    t.includes('approved') ||
    t.includes('approval') ||
    t.includes('success')
  );
}

/**
 * DIME approval rule (aligned with oe_payment_manager credit_card / ACH handlers):
 * status_code "00" AND status_text indicates approval (case-insensitive).
 */
function isDimeChargeApproved(data) {
  if (!data || typeof data !== 'object') return false;
  const code = data.status_code != null ? String(data.status_code).trim() : '';
  const text = data.status_text ?? data.statusText ?? '';
  return code === '00' && isDimeApprovedStatusText(text);
}

/**
 * recurring_payment_success may include status_code/text; if present and not approved, treat as decline.
 * If DIME omits both fields, keep legacy behavior (trust the event type).
 */
function shouldTreatRecurringSuccessWebhookAsDeclined(data) {
  if (!data || typeof data !== 'object') return false;
  const code = data.status_code != null ? String(data.status_code).trim() : '';
  const text = String(data.status_text ?? data.statusText ?? '').trim();
  if (!code && !text) return false;
  return !isDimeChargeApproved(data);
}

/**
 * DIME API includes `pending` on transaction payloads (e.g. ACH until settled).
 * true = not yet settled; false = not in a pending settlement state (per DIME).
 */
function isDimePendingFlagTrue(data) {
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

/**
 * Map DIME transaction payload / sync row fields to a single oe.Payments.Status category.
 *
 * **Webhook / charge responses** often include `status_code` + `status_text` (e.g. 00 + Approved).
 * **`GET /api/transactions` (list)** often leaves those empty and uses `transaction_status` labels
 * such as `CC_CREDIT`, `ACH_PAYMENT_CREDIT`, `ACH_PAYMENT_CREDIT_PENDING` plus `pending` boolean.
 * Root `status` (e.g. Success) is used when present.
 */
function mapDimePayloadToPaymentRecordStatus(data, options = {}) {
  const transactionStatus = options.transactionStatus ?? data?.transaction_status ?? data?.transactionStatus;
  if (data && typeof data === 'object') {
    let code = data.status_code != null ? String(data.status_code).trim() : '';
    if (code === '0') code = '00';
    const text = String(data.status_text ?? data.statusText ?? '');
    if (code !== '' || text !== '') {
      if (code === '00' && isDimeApprovedStatusText(text)) return 'Completed';
      // List API often omits status_text when approved; 00 alone means success (same as webhook semantics).
      if (code === '00' && text === '') return 'Completed';
      if (code && code !== '00') return 'Failed';
    }
    if (isDimePendingFlagTrue(data)) return 'Pending';
  }
  const ts = String(transactionStatus || '').toLowerCase();
  if (ts.includes('approved') || ts.includes('completed') || ts.includes('success') || ts.includes('settled')) {
    return 'Completed';
  }
  if (ts.includes('pending') || ts.includes('processing')) return 'Pending';
  if (ts.includes('failed') || ts.includes('declined') || ts.includes('returned')) return 'Failed';
  // List API posted-credit labels (empty status_code/text is normal on list rows).
  if (ts.includes('cc_credit') && !ts.includes('pending')) return 'Completed';
  if (ts.includes('ach_payment_credit') && !ts.includes('pending')) return 'Completed';
  // Settlement / sweep lines in merchant activity — not a card/ACH charge row; do not map to Pending.
  if (ts === 'deposit') return 'Unknown';
  const statusMap = {
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
  // Do not default unknown labels to Pending (caused false Pending for CC_CREDIT before explicit rules).
  return 'Unknown';
}

/**
 * Map {@link mapDimePayloadToPaymentRecordStatus} output to what we persist on oe.Payments for CC/ACH charge webhooks.
 *
 * `mapDimePayloadToPaymentRecordStatus` returns **Failed** when (examples from DIME payloads / logs):
 * - `status_code` is set and not `00` (decline / error codes)
 * - `transaction_status` contains `failed`, `declined`, or `returned`
 * - root `status` maps to `failed` / `failure`
 *
 * Everything else that is not Completed — including **Unknown** (unrecognized labels) — becomes **Pending** here,
 * so in-flight ACH and ambiguous payloads are not mis-stored as Failed.
 * Refunded / Voided / Canceled pass through unchanged.
 */
function mapChargeWebhookMappedStatusToDbStatus(mapped) {
  const m = mapped == null ? '' : String(mapped).trim();
  if (m === 'Completed') return 'Completed';
  if (m === 'Failed') return 'Failed';
  if (m === 'Refunded' || m === 'Voided' || m === 'Canceled') return m;
  return 'Pending';
}

/**
 * Sync / list-transaction style: separate columns for legacy dime status + codes.
 * Same behavior as previous mapDimeStatusToPaymentStatus in DimePaymentSync.
 * @param rawListStatusFromApi DIME `status` on list rows (e.g. "Success") — must not be replaced by derive-only status.
 */
function mapDimeRowToPaymentRecordStatus(
  dimeStatus,
  statusCode = null,
  statusText = null,
  transactionStatus = null,
  rawListStatusFromApi = null,
  pendingFromApi = undefined
) {
  const statusField =
    rawListStatusFromApi != null && String(rawListStatusFromApi).trim() !== ''
      ? rawListStatusFromApi
      : dimeStatus;
  const payload = { status_code: statusCode, status_text: statusText, status: statusField };
  if (pendingFromApi !== undefined) payload.pending = pendingFromApi;
  return mapDimePayloadToPaymentRecordStatus(payload, { transactionStatus });
}

/** True if oe.Payments.Status indicates a successful capture (legacy values included). */
function isSuccessfulPaymentRecordStatus(status) {
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

const SUCCESSFUL_PAYMENT_RECORD_STATUSES_LOWER_SQL = Object.freeze([
  'completed',
  'approval',
  'success',
  'succeeded',
  'approved',
  'paid',
]);

function sqlSuccessfulPaymentOrderKeyExpr(columnRef) {
  const inList = SUCCESSFUL_PAYMENT_RECORD_STATUSES_LOWER_SQL.map((s) => `N'${s}'`).join(', ');
  return `(CASE WHEN LOWER(LTRIM(RTRIM(${columnRef}))) IN (${inList}) THEN 0 ELSE 1 END)`;
}

function sqlSuccessfulPaymentPredicate(columnRef) {
  const inList = SUCCESSFUL_PAYMENT_RECORD_STATUSES_LOWER_SQL.map((s) => `N'${s}'`).join(', ');
  return `(LOWER(LTRIM(RTRIM(${columnRef}))) IN (${inList}))`;
}

module.exports = {
  isDimeChargeApproved,
  shouldTreatRecurringSuccessWebhookAsDeclined,
  isDimePendingFlagTrue,
  mapDimePayloadToPaymentRecordStatus,
  mapChargeWebhookMappedStatusToDbStatus,
  mapDimeRowToPaymentRecordStatus,
  isSuccessfulPaymentRecordStatus,
  SUCCESSFUL_PAYMENT_RECORD_STATUSES: SUCCESSFUL_PAYMENT_RECORD_STATUSES_EXACT,
  SUCCESSFUL_PAYMENT_RECORD_STATUSES_LOWER_SQL,
  sqlSuccessfulPaymentOrderKeyExpr,
  sqlSuccessfulPaymentPredicate,
};
