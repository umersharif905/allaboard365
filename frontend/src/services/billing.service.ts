/**
 * Billing service - role-aware (TenantAdmin, SysAdmin; extensible for Agent, GroupAdmin).
 * Uses getBaseUrl(currentRole) to call the correct backend.
 */
import type { AxiosRequestConfig } from 'axios';
import type { PaymentBreakdownData } from '../types/paymentCommissionBreakdown.types';
import { apiService, withExplicitTenantScope } from './api.service';

export interface BillingRevenueResponse {
  totalRevenue: number;
  paymentCount: number;
}

export interface BillingProjectionResponse {
  projectedRevenue: number;
  enrollmentCount: number;
}

export interface BillingPaymentRow {
  paymentId: string;
  amount: number;
  paymentDate: string;
  status: string;
  paymentMethod: string;
  processor?: string | null;
  processingFee?: number;
  dimeProcessorFee?: number | null;
  dimeProcessorFeeComingSoon?: boolean;
  failureReason?: string | null;
  /** ACH returns / chargebacks — surfaced on agent billing detail modal when present */
  achReturnCode?: string | null;
  achReturnReason?: string | null;
  chargebackReason?: string | null;
  processorTransactionId?: string | null;
  /** Present for group invoice charges, enrollments, etc. */
  invoiceId?: string | null;
  /** Joined oe.Invoices columns (billing list + retry options parity). */
  linkedInvoiceNumber?: string | null;
  linkedInvoiceBillingPeriodStart?: string | null;
  linkedInvoiceBillingPeriodEnd?: string | null;
  linkedInvoiceStatus?: string | null;
  enrollmentId?: string | null;
  locationId?: string | null;
  nextBillingDate?: string | null;
  memberId?: string | null;
  groupId?: string | null;
  memberName?: string | null;
  groupName?: string | null;
  agentName?: string | null;
  agencyName?: string | null;
  productName?: string | null;
  /** When present (e.g. member payments API); tenant billing list may omit it. */
  transactionType?: string | null;
  /** Populated for some failed payments (DIME webhook / recurring failure insert). Retry chain. */
  attemptNumber?: number | null;
  consecutiveFailureCount?: number | null;
  /** True when at least one non-deleted oe.Commissions row exists for the payment. */
  commissionPaid?: boolean;
  /** Staff manual charge (charge-now / member-pay); may lack initiator on older rows. */
  isManualCharge?: boolean;
  initiatedByName?: string | null;
  recurringScheduleId?: string | null;
  createdBy?: string | null;
  /** Member portal user id when row is opened from member admin (self-pay vs staff). */
  memberUserId?: string | null;
  /** Precomputed charge source label (member admin mapper). */
  chargeSourceLabel?: string | null;
}

/** Failed payments: show "Retry failed (n)" when attempt &gt; 1; otherwise raw status. */
export function formatBillingPaymentStatusLabel(row: BillingPaymentRow): string {
  if (row.status !== 'Failed') return row.status;
  const n = row.attemptNumber;
  if (n != null && n > 1) {
    return `Retry failed (${n})`;
  }
  return 'Failed';
}

export interface BillingPaymentsResponse {
  data: BillingPaymentRow[];
  total: number;
}

export interface BillingPaymentCommissionRow {
  commissionId: string;
  agentId: string | null;
  agentName: string | null;
  agentEmail: string | null;
  agencyId: string | null;
  agencyName: string | null;
  amount: number;
  status: string;
  transactionType: string | null;
  periodStartDate: string | null;
  periodEndDate: string | null;
  createdDate: string | null;
  modifiedDate: string | null;
  householdId: string | null;
  groupId: string | null;
  enrollmentId: string | null;
  splitPartnerAgentId: string | null;
  splitPartnerName: string | null;
  splitPercentage: number | null;
  isPrimaryInSplit: boolean | null;
  originalCommissionId: string | null;
  appliedToBalance: number | null;
}

/** Amount totals by status bucket for the same filter set as GET /payments (all rows, not just the current page). */
export interface BillingPaymentsStatusSummary {
  failedAmount: number;
  pendingAmount: number;
  completedAmount: number;
  /** Agent billing: deduped unresolved-failed exposure only (excludes returned add-on in failedAmount). */
  unresolvedFailedDedupedAmount?: number;
}

export interface BillingFilterOptions {
  groups: { id: string; label: string; value: string }[];
  members: { id: string; label: string; value: string; email?: string }[];
  agents: { id: string; label: string; value: string; email?: string }[];
  agencies: { id: string; label: string; value: string }[];
}

export interface BillingFilterOptionsResponse {
  data: BillingFilterOptions;
}

export interface BillingPaymentsParams {
  status?: string;
  /** Same payment rows as audit unresolved-failed drilldown; ignores status and date range on the server. */
  unresolvedFailedOnly?: boolean;
  groupId?: string;
  memberId?: string;
  agentId?: string;
  agencyId?: string;
  /** Selling-agent scope (Agent billing): same values as commissions / agentFilterScope; use `me` for self-only. */
  salesAgentFilter?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
  /** 'paid' | 'unpaid' | undefined (shows all). Mirrors commission-paid badge on the row. */
  commissionPaid?: 'paid' | 'unpaid';
  /** Only payments with oe.Payments.InvoiceId IS NULL (ignored when unresolvedFailedOnly is true). Excludes Refunded when the status parameter is omitted (matches orphan audit). */
  noLinkedInvoice?: boolean;
}

export interface BillingRecurringRow {
  scheduleId: string;
  locationName: string;
  nextBillingDate: string | null;
  monthlyAmount: number;
  isActive: boolean;
  cancelledDate: string | null;
  processor: string;
  context: 'group' | 'individual';
  groupId?: string | null;
  groupName?: string | null;
  memberId?: string | null;
  memberName?: string | null;
  agentId?: string | null;
  agentName?: string | null;
}

export interface BillingRecurringParams {
  agentId?: string;
  groupId?: string;
  memberType?: 'all' | 'group' | 'individual';
}

export interface BillingFeeRow {
  paymentId: string;
  paymentDate: string;
  groupName: string | null;
  memberName: string | null;
  amount: number;
  processingFee: number;
  dimeProcessorFee?: number | null;
  dimeProcessorFeeComingSoon?: boolean;
  systemFee: number;
  totalFee: number;
}

export interface BillingFeesParams {
  status?: string;
  groupId?: string;
  memberId?: string;
  agentId?: string;
  agencyId?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
}

export interface BillingFeesTotals {
  totalAmount: number;
  totalProcessingFee: number;
  totalSystemFee: number;
  totalFees: number;
}

export interface PaymentAuditBuckets {
  netRate: number;
  overrideRate: number;
  commission: number;
  systemFees: number;
  processingFeeAmount: number;
  setupFee: number;
  productCommissionsJSON: string;
  productVendorAmountsJSON: string;
  productOwnerAmountsJSON: string;
}

export interface PaymentAuditTotals {
  computedSum: number;
  amount: number;
  amountDiff: number;
}

export interface PaymentAuditPayload {
  context: 'group' | 'household';
  asOfDate: string;
  billingPeriod?: { startDate: string; endDate: string } | null;
  identified?: { enrolledHouseholdsCount: number };
  warnings?: {
    enrollmentPremiumMismatches?: {
      count: number;
      rows: Array<{
        enrollmentId: string;
        memberId: string;
        householdId: string;
        productId: string;
        productName: string | null;
        effectiveDate: string | null;
        terminationDate: string | null;
        premiumAmount: number;
        netRate: number;
        overrideRate: number;
        commission: number;
        componentSum: number;
        diff: number;
      }>;
    };
  };
  payment: {
    PaymentId: string;
    TenantId: string;
    GroupId: string | null;
    HouseholdId: string | null;
    EnrollmentId: string | null;
    InvoiceId?: string | null;
    LocationId?: string | null;
    Amount: number;
    Status: string;
    PaymentDate: string | null;
    CreatedDate: string | null;
    ModifiedDate: string | null;
    Processor?: string | null;
    ProcessorTransactionId?: string | null;
    PaymentMethod?: string | null;
    RecurringScheduleId?: string | null;
    NetRate: number;
    OverrideRate: number;
    Commission: number;
    SystemFees: number;
    ProcessingFeeAmount: number;
    SetupFee: number;
    ProductCommissions: string | null;
    ProductVendorAmounts: string | null;
    ProductOwnerAmounts: string | null;
  };
  computed: PaymentAuditBuckets;
  totals: PaymentAuditTotals;
}

export interface PaymentAuditHouseholdBreakdownProductRow {
  productId: string | null;
  productName: string | null;
  isBundleProduct: boolean;
  enrollmentCount: number;
  premiumAmount: number;
  netRate: number;
  overrideRate: number;
  commission: number;
  componentSum: number;
  diff: number;
}

export interface PaymentAuditHouseholdBreakdownGroupHouseholdRow {
  householdId: string;
  primaryMember: { memberId: string | null; userId: string | null; name: string | null; email: string | null };
  flags?: {
    hasCreatedAfterEffective: boolean;
    createdAfterEffectiveCount: number;
    hasMultipleSystemFees?: boolean;
    hasMultipleProcessingFees?: boolean;
  };
  fees?: {
    systemFee: { count: number; amount: number };
    processingFee: { count: number; amount: number };
  };
  products: PaymentAuditHouseholdBreakdownProductRow[];
}

export interface PaymentAuditHouseholdEnrollmentLineItem {
  enrollmentId: string;
  memberId: string;
  memberName: string | null;
  relationshipType: string | null;
  memberSequence: number | null;
  householdId: string;
  groupId: string | null;
  enrollmentType: string | null;
  productId: string | null;
  productName: string | null;
  status: string | null;
  effectiveDate: string | null;
  terminationDate: string | null;
  createdDate: string | null;
  modifiedDate: string | null;
  premiumAmount: number;
  netRate: number;
  overrideRate: number;
  commission: number;
  componentSum: number;
  diff: number;
}

export type PaymentAuditHouseholdEnrollmentsPayload =
  | {
      context: 'group';
      groupId: string;
      householdId: string;
      billingPeriod: { startDate: string; endDate: string };
      enrollmentsCount: number;
      enrollments: PaymentAuditHouseholdEnrollmentLineItem[];
    }
  | {
      context: 'household';
      householdId: string;
      asOfDate: string;
      enrollmentsCount: number;
      enrollments: PaymentAuditHouseholdEnrollmentLineItem[];
    };

export interface DimePaymentStatusAuditRow {
  paymentId: string;
  amount: number;
  paymentDate: string;
  currentStatus: string;
  processorTransactionId: string;
  paymentMethod?: string;
  /** Group display name when payment is tied to a group */
  groupName?: string | null;
  /** Primary member name from household when individual */
  primaryMemberName?: string | null;
  /** Preformatted: group name, or "Individual: First Last" */
  payerLabel?: string | null;
  dbCanonical?: string;
  dimeCanonical?: string | null;
  dimeTransactionStatus?: string;
  newStatus?: string | null;
  inSync?: boolean;
  skipped?: boolean;
  skipReason?: string;
  error?: string | null;
  applied?: boolean;
}

export interface DimePaymentStatusAuditData {
  dryRun: boolean;
  tenantId: string;
  startDate: string | null;
  endDate: string | null;
  limit: number;
  examined: number;
  inSync: number;
  skipped: number;
  errors: number;
  wouldUpdate: number;
  updated: number;
  rows: DimePaymentStatusAuditRow[];
}

export interface MemberMissingRecurringDimeRow {
  memberId: string;
  householdId: string;
  groupId: string | null;
  memberName: string | null;
  memberEmail?: string | null;
  memberPhone?: string | null;
  groupName: string | null;
  totalPremium: number;
  lastChargeAmount: number | null;
  lastPaymentDate: string | null;
  lastProcessorTransactionId: string | null;
  lastRecurringScheduleId: string | null;
}

export interface MembersMissingRecurringDimeData {
  tenantId: string;
  limit: number;
  count: number;
  rows: MemberMissingRecurringDimeRow[];
  fallbackWithoutIndividualRecurringTable?: boolean;
}

export interface SetupMissingRecurringDetail {
  memberId: string;
  householdId: string;
  memberName: string | null;
  outcome: string | null;
  invoiceId?: string;
  monthlyAmount?: number;
  projectedMonthlyAmount?: number;
  existingMonthlyAmount?: number | null;
  error?: string;
}

export interface SetupMissingRecurringResult {
  dryRun: boolean;
  attempted: number;
  created: number;
  alreadyCorrect: number;
  skipped: {
    group_billed: number;
    no_payment_method: number;
    no_billable_invoice: number;
  };
  failed: Array<{
    memberId: string;
    householdId: string;
    memberName: string | null;
    error: string;
  }>;
  details: SetupMissingRecurringDetail[];
}

/** Response body from payment manager POST /api/sync-payments (DimePaymentSync) */
export interface DimeListSyncStats {
  customersChecked?: number;
  customersWithTransactions?: number;
  totalTransactionsFound?: number;
  paymentsCreated?: number;
  paymentsUpdated?: number;
  paymentsSkipped?: number;
  individualPaymentsCreated?: number;
  syncSkippedCompletedToPending?: number;
  failedFromListCreated?: number;
  failedFromListSkipped?: number;
  errors?: unknown[];
  dryRunWouldCreate?: unknown[];
  dryRunWouldUpdate?: unknown[];
  dryRunWouldCreateFailed?: unknown[];
}

export interface DimeListSyncData {
  success?: boolean;
  message?: string;
  dryRun?: boolean;
  logRawStatus?: boolean;
  stats?: DimeListSyncStats;
  duration?: string;
  timestamp?: string;
  error?: string;
}

/** Rows from oe.SystemIntegrationErrors (DimeWebhookHandler payment_webhook failures) */
export interface BillingPaymentWebhookErrorRow {
  integrationErrorId: string;
  category: string;
  source: string;
  severity: string;
  tenantId: string | null;
  message: string;
  detailJson: string | null;
  createdDate: string | null;
  resolved?: boolean;
  resolvedAt?: string | null;
  resolvedByUserId?: string | null;
  webhookEventId?: number | null;
  webhookTransactionId?: string | null;
  linkedPaymentId?: string | null;
  linkedPaymentStatus?: string | null;
  linkedAmount?: number | null;
}

/** Rows from oe.SystemIntegrationErrors (enrollment wizard post-commit payment failures) */
export interface BillingEnrollmentWizardPaymentErrorRow {
  integrationErrorId: string;
  category: string;
  source: string;
  severity: string;
  tenantId: string | null;
  message: string;
  detailJson: string | null;
  createdDate: string | null;
}

/** GET /billing/audit-summary */
export interface BillingAuditSummaryData {
  unresolvedFailedPayments: number;
  /** Sum of Amount for unresolved failed payment rows (same filters as count). */
  unresolvedFailedPaymentsAmount?: number;
  /** DIME webhook handler processing failures logged to oe.SystemIntegrationErrors, last 30 days */
  webhookErrors30d: number;
  missingRecurringCount: number;
  /** Sum of totalPremium across missing-recurring rows (same snapshot as count). */
  missingRecurringTotalPremium?: number;
  /** Omitted in nightly batch summary when includePaymentJsonInvalid is false. */
  paymentJsonInvalidCount?: number | null;
  /** False when server skipped the bad-JSON count query (nightly / BILLING_UI_OMIT_PAYMENT_JSON_AUDIT). */
  paymentJsonInvalidIncluded?: boolean;
  dbMrrTotal: number;
  /** Expected premium from active product enrollments as-of today. */
  expectedEnrollmentMrr?: number;
  /** Future-month group enrollments excluded from expectedEnrollmentMrr baseline. */
  futureGroupDeferredMrr?: number;
  futureGroupDeferredEnrollmentCount?: number;
  /** Active group recurring schedule amounts (DB). */
  dbGroupMrr?: number;
  /** Active individual recurring schedule amounts (DB). */
  dbIndividualMrr?: number;
  /** Active schedule rows that have a DIME schedule id (subset of DB total). */
  processorLinkedMrr?: number;
  /** DB total minus DIME-linked — recurring $ on rows without a DIME schedule id. */
  mrrNotOnProcessor?: number;
  /** Sum of Active recurring amounts from DIME GET /api/recurring-payment/list (null if unavailable). */
  dimeApiActiveMrr?: number | null;
  /** DB total minus DIME API total (null if DIME unavailable). */
  mrrDbMinusDimeApi?: number | null;
  /** expectedEnrollmentMrr minus DIME API total (null if DIME unavailable). */
  mrrExpectedMinusDimeApi?: number | null;
  /** Details for DIME API aggregation (timeouts, caps, errors). */
  dimeApiMrrMeta?: {
    customersChecked?: number;
    scheduleRowsCounted?: number;
    apiCallFailures?: number;
    timedOut?: boolean;
    capped?: boolean;
    customersSkipped?: number;
    unavailable?: boolean;
    error?: string;
    nextRunDateMin?: string | null;
    nextRunDateMax?: string | null;
    snapshotAt?: string | null;
  } | null;
  mrrDateContext?: {
    snapshotAt?: string | null;
    expectedAsOfDate?: string | null;
    dbNextBillingDateMin?: string | null;
    dbNextBillingDateMax?: string | null;
    dbActiveScheduleCount?: number;
    expectedEnrollmentMrr?: number;
    futureGroupDeferredMrr?: number;
    futureGroupDeferredEnrollmentCount?: number;
    dimeNextRunDateMin?: string | null;
    dimeNextRunDateMax?: string | null;
    dimeSnapshotAt?: string | null;
  } | null;
  /** Product enrollments in oe.Enrollments.Status = PaymentHold (no payment row required). */
  paymentHoldEnrollmentCount?: number;
  generatedAt: string;
}

export interface BillingAuditMrrGapRow {
  contextType: 'group' | 'individual';
  scheduleRowId: string;
  groupId?: string | null;
  groupName?: string | null;
  householdId?: string | null;
  memberId?: string | null;
  memberName?: string | null;
  processorCustomerId?: string | null;
  dimeScheduleId?: string | null;
  monthlyAmount: number;
  nextBillingDate?: string | null;
  dimeStatus?: string | null;
  dimeAmount?: number | null;
  dimeNextRunDate?: string | null;
  likelyFutureStart?: boolean;
  reason: string;
  severity?: 'severe' | 'warning';
  causeKey?: string;
  causeLabel?: string;
}

export interface BillingAuditMrrGapData {
  generatedAt: string;
  totalActiveDbSchedules: number;
  rowsReturned: number;
  rowsTotal: number;
  apiFailures: number;
  dbGapAmount: number;
  likelyFutureStartAmount: number;
  severitySummary?: {
    severeCount: number;
    severeAmount: number;
    warningCount: number;
    warningAmount: number;
  };
  causeSummary?: Array<{
    causeKey: string;
    causeLabel: string;
    severity: 'severe' | 'warning';
    count: number;
    amount: number;
  }>;
  rows: BillingAuditMrrGapRow[];
}

export interface BillingAuditMrrReconciliationRow {
  memberId?: string | null;
  householdId?: string | null;
  groupId?: string | null;
  name: string;
  contextType: 'group' | 'individual';
  monthlyPremium: number;
  effectiveDate?: string | null;
  detail?: string | null;
  dimeScheduleId?: string | null;
  dimeStatus?: string | null;
}

export interface BillingAuditMrrReconciliationBucket {
  key: string;
  label: string;
  description: string;
  severity: 'critical' | 'info' | 'neutral';
  amount: number;
  count: number;
  rows: BillingAuditMrrReconciliationRow[];
}

export interface BillingAuditMrrReconciliationData {
  generatedAt: string;
  headline: {
    enrollmentExpectedMrr: number;
    dimeActiveRecurringMrr: number | null;
    difference: number | null;
    futureGroupDeferredMrr: number;
    futureGroupDeferredEnrollmentCount?: number;
  };
  buckets: BillingAuditMrrReconciliationBucket[];
  bucketsTotal: number;
  totalsMatch: boolean;
  actionableAmount: number;
  dimeApiMrrMeta?: BillingAuditSummaryData['dimeApiMrrMeta'];
  mrrDateContext?: BillingAuditSummaryData['mrrDateContext'];
}

/** GET /billing/audit-drilldown?type= */
export type BillingAuditDrilldownType =
  | 'unresolved_failed_payments'
  | 'webhook_errors_30d'
  | 'missing_recurring'
  | 'payment_hold_enrollments'
  | 'payment_json_invalid'
  | 'orphan_payments';

export type BillingAuditRunId =
  | 'missing_recurring'
  | 'failed_payments'
  | 'dime_status'
  | 'webhook_errors'
  | 'payment_json_fees'
  | 'enrollment_month_gaps'
  | 'payment_hold_enrollments'
  | 'mrr_compare'
  | 'invoice_payout_integrity'
  | 'orphan_payments';

export interface BillingAuditRunPayload {
  audits: BillingAuditRunId[];
  startDate?: string;
  endDate?: string;
  /** 1–168; only the Payment status vs DIME audit uses this (other audits still use startDate/endDate when applicable). */
  hoursBack?: number;
  /** Payment status vs DIME: success-first ordering (default true server-side). */
  prioritizeSuccessfulFirst?: boolean;
  /** Payment status vs DIME Pass B: look back this many days for older “succeeded” rows (0 = off). */
  successRecheckDays?: number;
  /** Payment status vs DIME Pass B: max rows when Pass B is on. */
  secondaryLimit?: number;
  limit?: number;
  dryRun?: boolean;
  persistReport?: boolean;
}

export interface BillingAuditRunResponse {
  tenantId: string;
  audits: string[];
  totalDurationMs: number;
  results: Record<string, Record<string, unknown>>;
}

/** Compared to the prior saved report for this tenant (missing recurring DIME). */
export interface BillingMissingRecurringSinceLastReport {
  comparable?: boolean;
  reason?: string;
  previousRunAtUtc?: string;
  previousMissingCount?: number;
  currentMissingCount?: number;
  resolvedCount?: number;
  resolved?: { memberId: string; memberName: string | null }[];
  resolvedTruncated?: boolean;
  newlyMissingCount?: number;
}

export interface BillingAuditReportLatest {
  reportId: string;
  tenantId: string | null;
  runAtUtc: string | null;
  triggerName: string;
  summary: {
    auditSummary?: BillingAuditSummaryData;
    auditRun?: BillingAuditRunResponse;
    tenantName?: string;
    runAt?: string;
    missingRecurringSinceLastReport?: BillingMissingRecurringSinceLastReport;
  } | null;
  detail: unknown | null;
  createdBy: string | null;
}

export type PaymentAuditHouseholdBreakdownPayload =
  | {
      context: 'group';
      groupId: string;
      billingPeriod: { startDate: string; endDate: string };
      householdsCount: number;
      households: PaymentAuditHouseholdBreakdownGroupHouseholdRow[];
    }
  | {
      context: 'household';
      householdId: string;
      asOfDate: string;
      fees?: {
        systemFee: { count: number; amount: number };
        processingFee: { count: number; amount: number };
      };
      products: PaymentAuditHouseholdBreakdownProductRow[];
    };

export type PaymentMethodDisplayKind = 'Card' | 'ACH' | 'Recurring';

/** Tailwind-ish badge classes used on billing / member payment rails */
export function paymentMethodBadgeClasses(kind: PaymentMethodDisplayKind): string {
  switch (kind) {
    case 'ACH':
      return 'bg-sky-100 text-sky-800';
    case 'Recurring':
      return 'bg-violet-100 text-violet-900';
    default:
      return 'bg-gray-100 text-gray-800';
  }
}

/** ACH submitted to DIME but not yet settled — stored in FailureReason while Status is Pending. */
export function isAchSettlementPendingFailureReason(
  reason: string | null | undefined,
  status: string | null | undefined
): boolean {
  if ((status || '').trim().toLowerCase() !== 'pending') return false;
  const r = (reason || '').trim().toLowerCase();
  return r.includes('ach_payment_credit_pending') || (r.includes('ach_payment') && r.includes('pending'));
}

/** Staff-initiated charge-now / member-pay label for payment detail modals. */
export function formatManualChargeAttribution(row: {
  isManualCharge?: boolean;
  initiatedByName?: string | null;
}): string | null {
  if (!row.isManualCharge) return null;
  const name = (row.initiatedByName || '').trim();
  return name ? `Manual charge by ${name}` : 'Manual charge (initiator not recorded)';
}

/** Fields used to infer who initiated a payment charge. */
export type ChargeSourceInput = {
  paymentMethod?: string | null;
  enrollmentId?: string | null;
  recurringScheduleId?: string | null;
  createdBy?: string | null;
  createdByName?: string | null;
  initiatedByName?: string | null;
  isManualCharge?: boolean;
  /** Household member UserId — distinguishes member self-pay from staff. */
  memberUserId?: string | null;
};

/** Who initiated the charge: recurring, enrollment, member, staff, system, or manual. */
export function formatChargeSourceAttribution(input: ChargeSourceInput): string {
  const paymentMethodLow = String(input.paymentMethod || '').trim().toLowerCase();
  const hasRecurring =
    (input.recurringScheduleId != null && String(input.recurringScheduleId).trim() !== '') ||
    paymentMethodLow === 'recurring';

  if (hasRecurring) {
    return 'Automatic (recurring)';
  }

  const enrollmentId = input.enrollmentId;
  if (enrollmentId != null && String(enrollmentId).trim() !== '') {
    return 'Enrollment';
  }

  const createdBy = input.createdBy != null ? String(input.createdBy).trim() : '';
  const name = (input.createdByName || input.initiatedByName || '').trim();
  const memberUserId = input.memberUserId != null ? String(input.memberUserId).trim() : '';

  if (createdBy && memberUserId && createdBy.toLowerCase() === memberUserId.toLowerCase()) {
    return name ? `Member (${name})` : 'Member (self-service)';
  }

  if (createdBy) {
    return name ? `Staff: ${name}` : 'Staff (initiator not recorded)';
  }

  if (input.isManualCharge) {
    return 'Manual charge (initiator not recorded)';
  }

  return 'System';
}

/** Normalize raw PaymentMethod from DB to display type and label (Credit card vs ACH vs legacy Recurring). */
export function getPaymentMethodType(
  paymentMethod: string | null | undefined,
  householdPaymentMethodType?: string | null | undefined
): { type: PaymentMethodDisplayKind; label: string } {
  if (!paymentMethod && !householdPaymentMethodType) return { type: 'Card', label: '—' };
  const raw = String(paymentMethod || householdPaymentMethodType || '').trim();
  const low = raw.toLowerCase();

  if (low === 'dime' && householdPaymentMethodType) {
    return getPaymentMethodType(householdPaymentMethodType);
  }
  if (low === 'dime') {
    return { type: 'ACH', label: 'ACH (processor)' };
  }

  /** Legacy webhook shape: indicates schedule-settled debit, not necessarily a card rail */
  if (low === 'recurring') {
    return { type: 'Recurring', label: 'Recurring' };
  }

  if (low.includes('ach') || low.includes('bank') || low.includes('checking') || low.includes('savings')) {
    return { type: 'ACH', label: 'ACH' };
  }

  /** Credit rail — avoid matching "credit" inside unrelated strings too eagerly */
  if (
    low === 'creditcard' ||
    low === 'credit_card' ||
    low === 'credit card' ||
    low.includes('credit card') ||
    low.includes('credit_card') ||
    low.includes('card') ||
    low.includes('debit')
  ) {
    return { type: 'Card', label: 'Credit card' };
  }

  return { type: 'Card', label: 'Credit card' };
}

function getBaseUrl(currentRole: string): string {
  switch (currentRole) {
    case 'TenantAdmin':
      return '/api/me/tenant-admin/billing';
    case 'SysAdmin':
      return '/api/me/sysadmin/billing';
    case 'Agent':
      return '/api/me/agent/billing';
    case 'GroupAdmin':
      return '/api/me/group-admin/billing';
    default:
      throw new Error(`Billing not supported for role: ${currentRole}`);
  }
}

function buildQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const clean = Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  ) as Record<string, string | number | boolean>;
  const q = new URLSearchParams();
  Object.entries(clean).forEach(([k, v]) => q.set(k, String(v)));
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const billingService = {
  getRevenue(
    currentRole: string,
    startDate: string,
    endDate: string,
    tenantId?: string
  ): Promise<{ success: boolean; data?: BillingRevenueResponse; message?: string }> {
    const base = getBaseUrl(currentRole);
    const params: Record<string, string> = { startDate, endDate };
    if (currentRole === 'SysAdmin' && tenantId) params.tenantId = tenantId;
    return apiService.get(`${base}/revenue${buildQuery(params)}`);
  },

  getProjection(
    currentRole: string,
    tenantId?: string
  ): Promise<{ success: boolean; data?: BillingProjectionResponse; message?: string }> {
    const base = getBaseUrl(currentRole);
    const params: Record<string, string> = {};
    if (currentRole === 'SysAdmin' && tenantId) params.tenantId = tenantId;
    return apiService.get(`${base}/projection${buildQuery(params)}`);
  },

  getPayments(
    currentRole: string,
    params: BillingPaymentsParams,
    tenantId?: string
  ): Promise<{
    success: boolean;
    data?: BillingPaymentRow[];
    total?: number;
    summary?: BillingPaymentsStatusSummary;
    message?: string;
  }> {
    const base = getBaseUrl(currentRole);
    const q: Record<string, string | number | boolean | undefined> = { ...params };
    if (currentRole === 'SysAdmin' && tenantId) q.tenantId = tenantId;
    const response = apiService.get<{
      success: boolean;
      data: BillingPaymentRow[];
      total: number;
      summary?: BillingPaymentsStatusSummary;
    }>(`${base}/payments${buildQuery(q)}`);
    return response;
  },

  getFilterOptions(
    currentRole: string,
    tenantId?: string
  ): Promise<{ success: boolean; data?: BillingFilterOptions; message?: string }> {
    const base = getBaseUrl(currentRole);
    const params: Record<string, string> = {};
    if (currentRole === 'SysAdmin' && tenantId) params.tenantId = tenantId;
    return apiService.get(`${base}/filter-options${buildQuery(params)}`);
  },

  getRecurringPayments(
    currentRole: string,
    params: BillingRecurringParams,
    tenantId?: string
  ): Promise<{ success: boolean; data?: BillingRecurringRow[]; message?: string }> {
    const base = getBaseUrl(currentRole);
    const q: Record<string, string | undefined> = {
      agentId: params.agentId,
      groupId: params.groupId,
      memberType: params.memberType ?? 'all'
    };
    if (currentRole === 'SysAdmin' && tenantId) q.tenantId = tenantId;
    return apiService.get(`${base}/recurring-payments${buildQuery(q)}`);
  },

  getFees(
    currentRole: string,
    params: BillingFeesParams,
    tenantId?: string
  ): Promise<{
    success: boolean;
    data?: BillingFeeRow[];
    total?: number;
    totals?: BillingFeesTotals;
    message?: string;
  }> {
    const base = getBaseUrl(currentRole);
    const q: Record<string, string | number | undefined> = { ...params };
    if (currentRole === 'SysAdmin' && tenantId) q.tenantId = tenantId;
    return apiService.get(`${base}/fees${buildQuery(q)}`);
  },

  getProcessorFeeDetail(
    currentRole: string,
    paymentId: string,
    tenantId?: string
  ): Promise<{
    success: boolean;
    data?: {
      ourProcessingFee: number;
      processorName: string | null;
      processorFee: number | null;
      processorFeeComingSoon?: boolean;
    };
    message?: string;
  }> {
    const base = getBaseUrl(currentRole);
    const params: Record<string, string> = {};
    if (currentRole === 'SysAdmin' && tenantId) params.tenantId = tenantId;
    return apiService.get(`${base}/payments/${encodeURIComponent(paymentId)}/processor-fee-detail${buildQuery(params)}`);
  },

  getPaymentAudit(
    currentRole: string,
    paymentId: string,
    tenantId?: string
  ): Promise<{ success: boolean; data?: PaymentAuditPayload; message?: string; error?: any }> {
    const base = getBaseUrl(currentRole);
    const params: Record<string, string> = {};
    if (currentRole === 'SysAdmin' && tenantId) params.tenantId = tenantId;
    return apiService.get(`${base}/payments/${encodeURIComponent(paymentId)}/audit${buildQuery(params)}`);
  },

  getPaymentCommissions(
    currentRole: string,
    paymentId: string,
    tenantId?: string
  ): Promise<{
    success: boolean;
    data?: { commissions: BillingPaymentCommissionRow[]; totalAmount: number };
    message?: string;
    error?: any;
  }> {
    const base = getBaseUrl(currentRole);
    const params: Record<string, string> = {};
    if (currentRole === 'SysAdmin' && tenantId) params.tenantId = tenantId;
    return apiService.get(
      `${base}/payments/${encodeURIComponent(paymentId)}/commissions${buildQuery(params)}`
    );
  },

  /**
   * Same per-product / recipient allocation as accounting "commission breakdown" and NACHA generation
   * (`getPaymentBreakdownPreview` with existing commissions allowed). Not role-prefixed on the server.
   */
  getAccountingPaymentCommissionBreakdown(
    paymentId: string,
    explicitTenantId?: string | null
  ): Promise<{ success: boolean; data?: PaymentBreakdownData; message?: string }> {
    const scope = withExplicitTenantScope(explicitTenantId ?? undefined);
    return apiService.get<{ success: boolean; data?: PaymentBreakdownData; message?: string }>(
      `/api/accounting/commission-breakdown/payment/${encodeURIComponent(paymentId)}`,
      Object.keys(scope).length ? scope : undefined
    );
  },

  correctPayment(
    currentRole: string,
    paymentId: string,
    payload: { confirmMismatch?: boolean },
    tenantId?: string
  ): Promise<{ success: boolean; data?: PaymentAuditPayload; message?: string; error?: any }> {
    const base = getBaseUrl(currentRole);
    const params: Record<string, string> = {};
    if (currentRole === 'SysAdmin' && tenantId) params.tenantId = tenantId;
    return apiService.post(`${base}/payments/${encodeURIComponent(paymentId)}/correct${buildQuery(params)}`, payload);
  },

  zeroPaymentEnrollmentSnapshots(
    currentRole: string,
    paymentId: string,
    tenantId?: string
  ): Promise<{ success: boolean; data?: { updated: number }; message?: string; error?: any }> {
    const base = getBaseUrl(currentRole);
    const params: Record<string, string> = {};
    if (currentRole === 'SysAdmin' && tenantId) params.tenantId = tenantId;
    return apiService.post(
      `${base}/payments/${encodeURIComponent(paymentId)}/zero-enrollment-snapshots${buildQuery(params)}`,
      {}
    );
  },

  getPaymentHouseholdBreakdown(
    currentRole: string,
    paymentId: string,
    tenantId?: string
  ): Promise<{ success: boolean; data?: PaymentAuditHouseholdBreakdownPayload; message?: string; error?: any }> {
    const base = getBaseUrl(currentRole);
    const params: Record<string, string> = {};
    if (currentRole === 'SysAdmin' && tenantId) params.tenantId = tenantId;
    return apiService.get(`${base}/payments/${encodeURIComponent(paymentId)}/audit/households${buildQuery(params)}`);
  },

  getPaymentHouseholdEnrollments(
    currentRole: string,
    paymentId: string,
    householdId: string,
    tenantId?: string
  ): Promise<{ success: boolean; data?: PaymentAuditHouseholdEnrollmentsPayload; message?: string; error?: any }> {
    const base = getBaseUrl(currentRole);
    const params: Record<string, string> = {};
    if (currentRole === 'SysAdmin' && tenantId) params.tenantId = tenantId;
    return apiService.get(
      `${base}/payments/${encodeURIComponent(paymentId)}/audit/households/${encodeURIComponent(householdId)}/enrollments${buildQuery(params)}`
    );
  },

  dimePaymentStatusAudit(
    currentRole: string,
    body: { startDate?: string; endDate?: string; dryRun?: boolean; limit?: number },
    tenantId?: string
  ): Promise<{ success: boolean; data?: DimePaymentStatusAuditData; message?: string }> {
    const base = getBaseUrl(currentRole);
    const params: Record<string, string> = {};
    if (currentRole === 'SysAdmin' && tenantId) params.tenantId = tenantId;
    const config: AxiosRequestConfig = { timeout: 600000 };
    return apiService.post(`${base}/dime-payment-status-audit${buildQuery(params)}`, body, config);
  },

  dimeListSync(
    currentRole: string,
    body: { startDate: string; endDate: string; dryRun?: boolean; logRawStatus?: boolean },
    tenantId?: string
  ): Promise<{ success: boolean; data?: DimeListSyncData; message?: string }> {
    const base = getBaseUrl(currentRole);
    const params: Record<string, string> = {};
    if (currentRole === 'SysAdmin' && tenantId) params.tenantId = tenantId;
    const config: AxiosRequestConfig = { timeout: 600000 };
    return apiService.post(`${base}/dime-list-sync${buildQuery(params)}`, body, config);
  },

  getMembersMissingRecurringDime(
    currentRole: string,
    tenantId?: string,
    limit?: number
  ): Promise<{ success: boolean; data?: MembersMissingRecurringDimeData; message?: string }> {
    const base = getBaseUrl(currentRole);
    const q: Record<string, string | number> = {};
    if (currentRole === 'SysAdmin' && tenantId) q.tenantId = tenantId;
    if (limit != null) q.limit = limit;
    const config: AxiosRequestConfig = { timeout: 120000 };
    return apiService.get(`${base}/members-missing-recurring-dime${buildQuery(q)}`, config);
  },

  setupMissingRecurring(
    currentRole: string,
    body: { dryRun?: boolean; memberIds?: string[]; limit?: number },
    tenantId?: string
  ): Promise<{ success: boolean; data?: SetupMissingRecurringResult; message?: string }> {
    const base = getBaseUrl(currentRole);
    const payload =
      currentRole === 'SysAdmin' && tenantId
        ? { ...body, tenantId }
        : body;
    const config: AxiosRequestConfig = { timeout: 300000 };
    return apiService.post(`${base}/setup-missing-recurring`, payload, config);
  },

  getMemberPortalLoginUrl(
    currentRole: string,
    tenantId?: string
  ): Promise<{
    success: boolean;
    data?: { memberPortalLoginUrl: string; tenantName: string | null; supportEmail: string | null };
    message?: string;
  }> {
    const base = getBaseUrl(currentRole);
    const params: Record<string, string> = {};
    if (currentRole === 'SysAdmin' && tenantId) params.tenantId = tenantId;
    return apiService.get(`${base}/member-portal-login-url${buildQuery(params)}`);
  },

  getPaymentWebhookIntegrationErrors(
    currentRole: string,
    params: { startDate?: string; endDate?: string; limit?: number; resolutionStatus?: 'unresolved' | 'resolved' | 'all' },
    tenantId?: string
  ): Promise<{ success: boolean; data?: BillingPaymentWebhookErrorRow[]; message?: string }> {
    const base = getBaseUrl(currentRole);
    const q: Record<string, string | number | undefined> = {
      startDate: params.startDate,
      endDate: params.endDate,
      limit: params.limit,
      resolutionStatus: params.resolutionStatus
    };
    if (currentRole === 'SysAdmin' && tenantId) q.tenantId = tenantId;
    return apiService.get(`${base}/integration-errors${buildQuery(q)}`);
  },

  setPaymentWebhookIntegrationErrorResolved(
    currentRole: string,
    integrationErrorId: string,
    resolved: boolean,
    tenantId?: string
  ): Promise<{ success: boolean; data?: { integrationErrorId: string; resolved: boolean }; message?: string }> {
    const base = getBaseUrl(currentRole);
    const q: Record<string, string | undefined> = {};
    if (currentRole === 'SysAdmin' && tenantId) q.tenantId = tenantId;
    return apiService.post(
      `${base}/integration-errors/${encodeURIComponent(integrationErrorId)}/resolve${buildQuery(q)}`,
      { resolved }
    );
  },

  getEnrollmentWizardPaymentReports(
    currentRole: string,
    params: { startDate?: string; endDate?: string; limit?: number },
    tenantId?: string
  ): Promise<{ success: boolean; data?: BillingEnrollmentWizardPaymentErrorRow[]; message?: string }> {
    const base = getBaseUrl(currentRole);
    const q: Record<string, string | number | undefined> = {
      startDate: params.startDate,
      endDate: params.endDate,
      limit: params.limit
    };
    if (currentRole === 'SysAdmin' && tenantId) q.tenantId = tenantId;
    return apiService.get(`${base}/enrollment-wizard-payment-reports${buildQuery(q)}`);
  },

  getAuditSummary(
    currentRole: string,
    tenantId?: string
  ): Promise<{ success: boolean; data?: BillingAuditSummaryData; message?: string }> {
    const base = getBaseUrl(currentRole);
    const params: Record<string, string> = {};
    if (currentRole === 'SysAdmin' && tenantId) params.tenantId = tenantId;
    const config: AxiosRequestConfig = { timeout: 120000 };
    return apiService.get(`${base}/audit-summary${buildQuery(params)}`, config);
  },

  getAuditDrilldown(
    currentRole: string,
    type: BillingAuditDrilldownType,
    tenantId?: string,
    limit?: number
  ): Promise<{
    success: boolean;
    data?: { type: string; rows?: Record<string, unknown>[]; detailRows?: Record<string, unknown>[] };
    message?: string;
  }> {
    const base = getBaseUrl(currentRole);
    const q: Record<string, string | number> = { type };
    if (limit != null) q.limit = limit;
    if (currentRole === 'SysAdmin' && tenantId) q.tenantId = tenantId;
    return apiService.get(`${base}/audit-drilldown${buildQuery(q)}`);
  },

  getAuditMrrGap(
    currentRole: string,
    tenantId?: string,
    limit?: number
  ): Promise<{ success: boolean; data?: BillingAuditMrrGapData; message?: string }> {
    const base = getBaseUrl(currentRole);
    const q: Record<string, string | number> = {};
    if (limit != null) q.limit = limit;
    if (currentRole === 'SysAdmin' && tenantId) q.tenantId = tenantId;
    const config: AxiosRequestConfig = { timeout: 120000 };
    return apiService.get(`${base}/audit-mrr-gap${buildQuery(q)}`, config);
  },

  getAuditMrrReconciliation(
    currentRole: string,
    tenantId?: string
  ): Promise<{ success: boolean; data?: BillingAuditMrrReconciliationData; message?: string }> {
    const base = getBaseUrl(currentRole);
    const q: Record<string, string> = {};
    if (currentRole === 'SysAdmin' && tenantId) q.tenantId = tenantId;
    const config: AxiosRequestConfig = { timeout: 120000 };
    return apiService.get(`${base}/audit-mrr-reconciliation${buildQuery(q)}`, config);
  },

  runBillingAudits(
    currentRole: string,
    body: BillingAuditRunPayload,
    tenantId?: string
  ): Promise<{
    success: boolean;
    data?: BillingAuditRunResponse;
    report?: { reportId: string | null; runAtUtc: string | null };
    message?: string;
  }> {
    const base = getBaseUrl(currentRole);
    const params: Record<string, string> = {};
    if (currentRole === 'SysAdmin' && tenantId) params.tenantId = tenantId;
    const config: AxiosRequestConfig = { timeout: 3600000 };
    const payload =
      currentRole === 'SysAdmin' && tenantId ? { ...body, tenantId } : body;
    return apiService.post(`${base}/audit-run${buildQuery(params)}`, payload, config);
  },

  getLatestBillingAuditReport(
    currentRole: string,
    tenantId?: string
  ): Promise<{ success: boolean; data?: BillingAuditReportLatest | null; message?: string }> {
    const base = getBaseUrl(currentRole);
    const params: Record<string, string> = {};
    if (currentRole === 'SysAdmin' && tenantId) params.tenantId = tenantId;
    return apiService.get(`${base}/audit-reports/latest${buildQuery(params)}`);
  },

  getAuditReportRecipients(
    currentRole: string,
    tenantId?: string
  ): Promise<{ success: boolean; data?: { emails: string }; message?: string }> {
    const base = getBaseUrl(currentRole);
    const params: Record<string, string> = {};
    if (currentRole === 'SysAdmin' && tenantId) params.tenantId = tenantId;
    return apiService.get(`${base}/audit-report-recipients${buildQuery(params)}`);
  },

  putAuditReportRecipients(
    currentRole: string,
    tenantId: string | undefined,
    emails: string
  ): Promise<{ success: boolean; data?: { emails: string }; message?: string }> {
    const base = getBaseUrl(currentRole);
    const body =
      currentRole === 'SysAdmin' && tenantId ? { tenantId, emails } : { emails };
    return apiService.put(`${base}/audit-report-recipients`, body);
  }
};
