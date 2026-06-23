/** DIME API / webhook payload fragment */
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

export const SUCCESSFUL_PAYMENT_RECORD_STATUSES: readonly string[];

export function normalizeInboundRecurringWebhookBody(
  raw: Record<string, unknown> | null | undefined
): { eventType: string; data: Record<string, unknown> };

export function isDimeChargeApproved(data: DimeTransactionPayload | null | undefined): boolean;

/** When status fields exist on a recurring "success" webhook but the charge was not approved */
export function shouldTreatRecurringSuccessWebhookAsDeclined(
  data: DimeTransactionPayload | null | undefined
): boolean;

/** True when DIME `pending` indicates settlement not complete. */
export function isDimePendingFlagTrue(data: DimeTransactionPayload | null | undefined): boolean;

export function mapDimePayloadToPaymentRecordStatus(
  data: DimeTransactionPayload | null | undefined,
  options?: { transactionStatus?: string | null }
): PaymentRecordStatusCategory | string;

/** CC/ACH charge webhooks: Completed / Failed (explicit) / terminal states; else Pending (including Unknown from mapper). */
export function mapChargeWebhookMappedStatusToDbStatus(
  mapped: PaymentRecordStatusCategory | string | null | undefined
): 'Completed' | 'Failed' | 'Pending' | 'Refunded' | 'Voided' | 'Canceled';

/** recurring_payment_success: ACH with empty transaction_status → Pending until settled. */
export function mapRecurringSuccessWebhookToDbStatus(
  dimePayload: DimeTransactionPayload | Record<string, unknown> | null | undefined
): 'Completed' | 'Failed' | 'Pending' | 'Refunded' | 'Voided' | 'Canceled';

export function mapDimeRowToPaymentRecordStatus(
  dimeStatus?: string | null,
  statusCode?: string | number | null,
  statusText?: string | null,
  transactionStatus?: string | null,
  /** DIME list row `status` (e.g. Success) — takes precedence over dimeStatus when set */
  rawListStatusFromApi?: string | null,
  pendingFromApi?: boolean | string | number | null
): PaymentRecordStatusCategory | string;

export function isSuccessfulPaymentRecordStatus(status: string | null | undefined): boolean;

/** Lowercase SQL literals used for success predicates / ORDER BY in billing queries. */
export const SUCCESSFUL_PAYMENT_RECORD_STATUSES_LOWER_SQL: readonly string[];

/** SQL fragment: CASE WHEN LOWER(Status) IN (...) THEN 0 ELSE 1 END for success-first ordering. */
export function sqlSuccessfulPaymentOrderKeyExpr(columnRef: string): string;

/** SQL fragment: LOWER(Status) IN (...) for “DB considers this payment successful”. */
export function sqlSuccessfulPaymentPredicate(columnRef: string): string;

/** Persist DIME recurring_payment_failed messaging (transaction_error + code, fallback failure_reason). */
export function formatDimeRecurringFailureReasonForStorage(
  data: Record<string, unknown> | null | undefined
): string;

/** CC/ACH charge failure webhooks: failure_reason or synthesized status / transaction_error text. */
export function formatDimeChargeFailureReasonForStorage(
  data: Record<string, unknown> | null | undefined
): string;

/** Correlation id on recurring failures when DIME sends a transaction identifier. */
export function normalizeDimeRecurringProcessorTransactionId(
  data: Record<string, unknown> | null | undefined
): string | null;

/** Billing / retry ordinal from webhook when column AttemptNumber is not yet available (optional). */
export function extractDimePaymentRetryAttemptFromPayload(
  data: Record<string, unknown> | null | undefined
): number | null;
