'use strict';

/**
 * Single source of truth for DIME → oe.Payments status mapping and
 * "did money actually succeed?" checks. Keep in sync with index.d.ts.
 *
 * Used by: backend (dimeService, enrollment routes), oe_payment_manager (webhooks, sync).
 * Frontend ESM copy: frontend/src/constants/paymentStatus.ts (keep in sync).
 * Azure Functions vendored copy: oe_payment_manager/shared/payment-status/index.js (keep in sync).
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
  // DIME /api/transactions list uses transaction_status like CC_CREDIT / ACH_PAYMENT_CREDIT (posted credits), not "CC Approved".
  if (ts.includes('cc_credit') && !ts.includes('pending') && !ts.includes('rejected')) return 'Completed';
  if (
    ts.includes('ach_payment_credit') &&
    !ts.includes('pending') &&
    !ts.includes('rejected') &&
    !ts.includes('failed')
  ) {
    return 'Completed';
  }
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
 * Synchronous charge-card / charge-ach API responses. DIME often returns approval (status_code 00)
 * before settlement; card rows may include pending:true or CC_CREDIT without fund_date/settle_date.
 * Persist Pending until settled — do not mark invoices paid on the sync response alone.
 *
 * @param {Record<string, unknown>|null|undefined} data
 * @returns {string} oe.Payments.Status
 */
function mapDimeSyncChargeResponseToDbStatus(data) {
  if (!data || typeof data !== 'object') return 'Pending';

  const mapped = mapDimePayloadToPaymentRecordStatus(data);
  if (mapped === 'Failed' || mapped === 'Refunded' || mapped === 'Voided' || mapped === 'Canceled') {
    return mapChargeWebhookMappedStatusToDbStatus(mapped);
  }

  if (isDimePendingFlagTrue(data)) {
    return 'Pending';
  }

  const txType = String(data.transaction_type ?? data.transactionType ?? '').trim().toUpperCase();
  const ts = String(data.transaction_status ?? data.transactionStatus ?? '').toLowerCase();
  const fundDate = data.fund_date ?? data.fundDate;
  const settleDate = data.settle_date ?? data.settleDate;
  const hasSettlement =
    (fundDate != null && String(fundDate).trim() !== '') ||
    (settleDate != null && String(settleDate).trim() !== '');

  const isCardCharge = txType === 'CC' || ts.includes('cc_credit');
  if (isCardCharge && !hasSettlement) {
    return 'Pending';
  }

  return mapChargeWebhookMappedStatusToDbStatus(mapped);
}

/**
 * recurring_payment_success for ACH fires when the debit is initiated (status_code 00, often empty
 * transaction_status). Do not persist Completed until DIME reports a settled ACH credit label.
 *
 * @param {Record<string, unknown>|null|undefined} dimePayload
 * @returns {string} oe.Payments.Status value
 */
function mapRecurringSuccessWebhookToDbStatus(dimePayload) {
  const txType = String(
    dimePayload?.transaction_type ?? dimePayload?.transactionType ?? ''
  )
    .trim()
    .toUpperCase();
  if (txType === 'ACH') {
    const ts = String(
      dimePayload?.transaction_status ?? dimePayload?.transactionStatus ?? ''
    ).trim();
    if (!ts) {
      return 'Pending';
    }
    const lower = ts.toLowerCase();
    if (lower.includes('pending') || lower.includes('processing')) {
      return 'Pending';
    }
  }
  const mapped = mapDimePayloadToPaymentRecordStatus(dimePayload);
  return mapChargeWebhookMappedStatusToDbStatus(mapped);
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

/**
 * Lowercase set matching isSuccessfulPaymentRecordStatus after trim (CI collation-friendly SQL).
 * Keep aligned with the lower-branch checks in {@link isSuccessfulPaymentRecordStatus}.
 */
const SUCCESSFUL_PAYMENT_RECORD_STATUSES_LOWER_SQL = Object.freeze([
  'completed',
  'approval',
  'success',
  'succeeded',
  'approved',
  'paid',
]);

/**
 * SQL expression — 0 if status is successful per {@link isSuccessfulPaymentRecordStatus}, else 1.
 * Use in ORDER BY: successful rows first when combined with p.PaymentDate DESC.
 * @param {string} columnRef e.g. `p.Status`
 */
function sqlSuccessfulPaymentOrderKeyExpr(columnRef) {
  const inList = SUCCESSFUL_PAYMENT_RECORD_STATUSES_LOWER_SQL.map((s) => `N'${s}'`).join(', ');
  return `(CASE WHEN LOWER(LTRIM(RTRIM(${columnRef}))) IN (${inList}) THEN 0 ELSE 1 END)`;
}

/**
 * SQL predicate (boolean) — true when status matches {@link isSuccessfulPaymentRecordStatus} (trim + lower).
 * @param {string} columnRef e.g. `p.Status`
 */
function sqlSuccessfulPaymentPredicate(columnRef) {
  const inList = SUCCESSFUL_PAYMENT_RECORD_STATUSES_LOWER_SQL.map((s) => `N'${s}'`).join(', ');
  return `(LOWER(LTRIM(RTRIM(${columnRef}))) IN (${inList}))`;
}

/**
 * DIME recurring_payment_failed payloads (2025–2026+) send `transaction_error` + `transaction_error_code`.
 * Older samples used `failure_reason`. Prefer legacy when present so we do not overwrite a customized string.
 *
 * Stored shape examples: `[23] Lookup on supplied token failed...` or legacy free text.
 *
 * @param {Record<string, unknown>} data - raw `data` / webhook body subset from DIME
 * @returns {string}
 */
function formatDimeRecurringFailureReasonForStorage(data) {
  if (!data || typeof data !== 'object') return 'Unknown';
  const legacy = typeof data.failure_reason === 'string' ? data.failure_reason.trim() : '';
  if (legacy) return legacy;

  const errMsg = typeof data.transaction_error === 'string' ? data.transaction_error.trim() : '';
  const errCode = data.transaction_error_code != null ? String(data.transaction_error_code).trim() : '';

  const alt = typeof data.error_message === 'string' ? data.error_message.trim() : '';

  const body = errMsg || alt;
  if (body) {
    if (errCode) return `[${errCode}] ${body}`;
    return body;
  }
  if (errCode) return `[${errCode}] (no message from processor)`;

  // Retry / thinner recurring_failure payloads sometimes omit transaction_error* but still send
  // status_code + status_text (same pattern as charge webhooks — docs/dime-webhook-format.md).
  const chargeFallback = formatDimeChargeFailureReasonForStorage(data);
  if (chargeFallback) return chargeFallback;

  return 'Unknown';
}

/**
 * One-time CC / ACH charge webhooks: synthesize a single human-readable decline line when `failure_reason` is empty.
 * Align with fields DIME commonly sends (status_code, status_text, transaction_error, etc.).
 *
 * @param {Record<string, unknown>} data
 * @returns {string}
 */
function formatDimeChargeFailureReasonForStorage(data) {
  if (!data || typeof data !== 'object') return '';
  const legacy = typeof data.failure_reason === 'string' ? data.failure_reason.trim() : '';
  if (legacy) return legacy;

  const ret = typeof data.return_reason === 'string' ? data.return_reason.trim() : '';
  if (ret) return ret;
  const cb = typeof data.chargeback_reason === 'string' ? data.chargeback_reason.trim() : '';
  if (cb) return cb;

  const errMsg = typeof data.transaction_error === 'string' ? data.transaction_error.trim() : '';
  const errCode = data.transaction_error_code != null ? String(data.transaction_error_code).trim() : '';
  if (errMsg) {
    return errCode ? `[${errCode}] ${errMsg}` : errMsg;
  }
  if (errCode) return `[${errCode}] (no message from processor)`;

  const alt = typeof data.error_message === 'string' ? data.error_message.trim() : '';
  if (alt) return alt;

  let code = data.status_code != null ? String(data.status_code).trim() : '';
  if (code === '0') code = '00';
  const text = String(data.status_text ?? data.statusText ?? '').trim();
  if (code && text) return `[${code}] ${text}`;
  if (text) return text;
  if (code && code !== '00') return `Decline or error (processor code ${code})`;

  const ts = String(data.transaction_status ?? data.transactionStatus ?? '').trim();
  // Posted-credit labels (e.g. CC_CREDIT) mean money in — not a decline reason for Pending rows.
  if (ts && !isDimePostedCreditTransactionStatus(ts)) return ts;

  return '';
}

/** DIME list/sync labels for successful captures — must not be stored as FailureReason. */
function isDimePostedCreditTransactionStatus(transactionStatus) {
  const ts = String(transactionStatus || '').toLowerCase();
  if (!ts) return false;
  if (ts.includes('cc_credit') && !ts.includes('rejected') && !ts.includes('failed')) return true;
  if (
    ts.includes('ach_payment_credit') &&
    !ts.includes('pending') &&
    !ts.includes('rejected') &&
    !ts.includes('failed')
  ) {
    return true;
  }
  return false;
}

/**
 * Best-effort processor transaction correlation on recurring failures (often absent on declines).
 *
 * @param {Record<string, unknown>} data
 * @returns {string|null}
 */
function normalizeDimeRecurringProcessorTransactionId(data) {
  if (!data || typeof data !== 'object') return null;
  const id =
    data.transaction_id ??
    data.transactionNumber ??
    data.transaction_number ??
    data.processor_transaction_id ??
    null;
  if (id == null || String(id).trim() === '') return null;
  return String(id).trim();
}

/**
 * Some DIME webhook bodies include a billing / retry attempt ordinal (field names vary).
 * Use for member-facing copy (e.g. "retry attempt 3") when persisted AttemptNumber is not yet set.
 *
 * @param {Record<string, unknown>} data
 * @returns {number|null}
 */
function extractDimePaymentRetryAttemptFromPayload(data) {
  if (!data || typeof data !== 'object') return null;
  const keys = [
    'attempt_number',
    'attemptNumber',
    'billing_attempt_number',
    'billingAttemptNumber',
    'retry_attempt_number',
    'retryAttemptNumber',
    'recurrence_attempt',
    'recurrenceAttempt',
    'payment_attempt_number',
    'paymentAttemptNumber',
    'installment_attempt',
    'installmentAttempt'
  ];
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
    const v = data[k];
    if (v == null || v === '') continue;
    const n = parseInt(String(v).trim(), 10);
    if (Number.isFinite(n) && n >= 1) return n;
  }
  return null;
}

/** Copy webhook root fields minus envelope keys (flattened payloads / empty nested `data`). */
function stripDimeWebhookEnvelope(raw) {
  const data = { .../** @type {Record<string, unknown>} */ (raw) };
  delete data.event_type;
  delete data.eventType;
  delete data.type;
  delete data.data;
  return data;
}

/**
 * Normalize inbound DIME payloads from either OpenEnveloped `{ event_type, data }` posts or flattened
 * root-level payloads (`type`, `schedule_id`, `transaction_number`, …).
 * Keeps oe_payment_manager and backend aligned with docs/oe_payment_manager/dime-webhook-format.md.
 *
 * @param {Record<string, unknown>} raw
 * @returns {{ eventType: string; data: Record<string, unknown> }}
 */
function normalizeInboundRecurringWebhookBody(raw) {
  if (!raw || typeof raw !== 'object') return { eventType: '', data: {} };

  /** @type {string} */
  let eventType = '';
  /** @type {Record<string, unknown>} */
  let data = {};

  if (
    typeof raw.event_type === 'string' &&
    raw.event_type.trim() !== '' &&
    raw.data != null &&
    typeof raw.data === 'object'
  ) {
    eventType = raw.event_type.trim();
    const inner = { .../** @type {Record<string, unknown>} */ (raw.data) };
    /** DIME may send `{ event_type, data: {} }` with declines on the JSON root (`transaction_error*`). */
    data = Object.keys(inner).length > 0 ? inner : stripDimeWebhookEnvelope(raw);
  } else if (typeof raw.event_type === 'string' && raw.event_type.trim() !== '') {
    eventType = raw.event_type.trim();
    data = stripDimeWebhookEnvelope(raw);
  } else if (typeof raw.eventType === 'string' && raw.eventType.trim() !== '') {
    eventType = raw.eventType.trim();
    data = stripDimeWebhookEnvelope(raw);
  } else if (typeof raw.type === 'string' && raw.type.trim() !== '') {
    eventType = raw.type.trim();
    data = stripDimeWebhookEnvelope(raw);
  } else {
    if (
      raw.data &&
      typeof raw.data === 'object' &&
      Object.keys(/** @type {Record<string, unknown>} */ (raw.data)).length > 0
    ) {
      data = { .../** @type {Record<string, unknown>} */ (raw.data) };
    } else {
      data = stripDimeWebhookEnvelope(raw);
    }
  }

  if (eventType === 'recurring_payment_success') eventType = 'recurring_payment.success';
  if (eventType === 'recurring_payment_failed') eventType = 'recurring_payment.failed';

  return { eventType, data };
}

module.exports = {
  normalizeInboundRecurringWebhookBody,
  isDimeChargeApproved,
  shouldTreatRecurringSuccessWebhookAsDeclined,
  isDimePendingFlagTrue,
  mapDimePayloadToPaymentRecordStatus,
  mapChargeWebhookMappedStatusToDbStatus,
  mapDimeSyncChargeResponseToDbStatus,
  mapRecurringSuccessWebhookToDbStatus,
  mapDimeRowToPaymentRecordStatus,
  isSuccessfulPaymentRecordStatus,
  formatDimeRecurringFailureReasonForStorage,
  formatDimeChargeFailureReasonForStorage,
  isDimePostedCreditTransactionStatus,
  normalizeDimeRecurringProcessorTransactionId,
  extractDimePaymentRetryAttemptFromPayload,
  SUCCESSFUL_PAYMENT_RECORD_STATUSES: SUCCESSFUL_PAYMENT_RECORD_STATUSES_EXACT,
  SUCCESSFUL_PAYMENT_RECORD_STATUSES_LOWER_SQL,
  sqlSuccessfulPaymentOrderKeyExpr,
  sqlSuccessfulPaymentPredicate,
};

