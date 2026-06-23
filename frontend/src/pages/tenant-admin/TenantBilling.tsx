import {
    Activity,
    AlertCircle,
    AlertTriangle,
    ArrowUpDown,
    BarChart3,
    Calendar,
    CheckCircle,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    ChevronUp,
    ClipboardCheck,
    ClipboardList,
    Clock,
    CreditCard,
    DollarSign,
    Mail,
    Eye,
    FileSearch,
    FileText,
    Filter,
    Loader2,
    Heart,
    RefreshCw,
    RotateCcw,
    Settings,
    Trash2,
    TrendingUp,
    Unlink,
    User,
    UserCheck,
    UserCircle,
    Users,
    X,
    Pencil,
    XCircle
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-hot-toast';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BillingAuditReportEmailsModal } from '../../components/billing/BillingAuditReportEmailsModal';
import { BillingRunAuditsModal } from '../../components/billing/BillingRunAuditsModal';
import BillingDriftModal from '../../components/billing/BillingDriftModal';
import { AdminPaymentDetailsModal } from '../../components/billing/AdminPaymentDetailsModal';
import { MissingRecurringOutreachModal } from '../../components/billing/MissingRecurringOutreachModal';
import { MissingRecurringSetupModal } from '../../components/billing/MissingRecurringSetupModal';
import { useBillingDrift } from '../../hooks/useBillingDrift';
import SearchableDropdown from '../../components/common/SearchableDropdown';
import RefundPaymentModal from '../../components/shared/RefundPaymentModal';
import TenantBillingCreditsTab from './TenantBillingCreditsTab';
import { householdCreditsService } from '../../services/householdCredits.service';
import { useAuth } from '../../contexts/AuthContext';
import { useInvoices } from '../../hooks/useInvoices';
import { invoicesService, type Invoice, type InvoiceAuditPayload } from '../../services/invoices.service';
import { apiService } from '../../services/api.service';
import {
    billingService,
    type BillingAuditMrrReconciliationData,
    type BillingAuditMrrReconciliationBucket,
    formatBillingPaymentStatusLabel,
    getPaymentMethodType,
    paymentMethodBadgeClasses,
    type BillingAuditReportLatest,
    type BillingAuditRunId,
    type BillingAuditRunResponse,
    type BillingAuditDrilldownType,
    type BillingAuditSummaryData,
    type BillingEnrollmentWizardPaymentErrorRow,
    type BillingFilterOptions,
    type BillingPaymentRow,
    type BillingPaymentWebhookErrorRow,
    type BillingPaymentsStatusSummary,
    type BillingRecurringRow,
    type PaymentAuditHouseholdBreakdownPayload,
    type PaymentAuditHouseholdEnrollmentLineItem,
    type PaymentAuditPayload
} from '../../services/billing.service';
import GroupsService from '../../services/groups.service';
import { Member } from '../../types/member.types';
import MemberManagementModal, { type MemberManagementModalTab } from '../members/MemberManagementModal';
import { FailedPaymentReasonBadge } from '../../components/billing/FailedPaymentReasonBadge';
import {
    compareAuditRows,
    formatPaymentMethodValiditySummary,
    MISSING_RECURRING_AUDIT_COLUMN_ORDER
} from '../../utils/auditRowsSort';
import { buildFailedPaymentStatusTitle } from '../../utils/billingPaymentFailureTooltip';

type AuditBreakdownTabId =
  | 'webhooks'
  | 'unresolved_failed'
  | 'orphan_payments'
  | 'missing_recurring'
  | 'bad_json'
  | 'payment_hold'
  | 'wizard';

const HIDDEN_AUDIT_DRILLDOWN_KEYS = new Set([
  'bucketkey',
  'groupid',
  'memberid',
  'householdid',
  'paymentid',
  'enrollmentid',
  'productid',
  'invoiceid',
  'agentid',
  'validpaymentmethodcount',
  'incompletepaymentmethodcount'
]);

function isHiddenAuditColumn(key: string): boolean {
  return HIDDEN_AUDIT_DRILLDOWN_KEYS.has(key.replace(/_/g, '').toLowerCase());
}

const AUDIT_DRILLDOWN_LABELS: Record<string, string> = {
  status: 'Status',
  amount: 'Amount',
  paymentDate: 'Payment date',
  paymentId: 'Payment ID',
  failureReason: 'Failure reason',
  processorTransactionId: 'Processor txn',
  groupName: 'Group',
  primaryMemberName: 'Member/Group',
  retryDate: 'Retry date',
  memberName: 'Member',
  memberEmail: 'Email',
  memberPhone: 'Phone',
  minEffectiveDate: 'Effective',
  isFutureEffective: 'Setup timing',
  totalPremium: 'Total premium',
  lastChargeAmount: 'Last charge',
  lastPaymentDate: 'Last payment',
  lastProcessorTransactionId: 'Last processor txn',
  lastRecurringScheduleId: 'Last schedule ref',
  effectiveDate: 'Effective',
  createdDate: 'Created',
  productName: 'Product',
  invalidJsonFields: 'Invalid JSON fields',
  enrollmentCount: 'Payment-hold enrollments',
  productNames: 'Products',
  failedCount: 'Failed payments',
  totalFailedAmount: 'Amount',
  latestPaymentDate: 'Latest failed (UTC)',
  paymentMethods: 'Payment methods',
  daysLate: 'Days overdue',
  householdId: 'Household'
};

const AUDIT_DRILLDOWN_COLUMN_ORDER: Partial<Record<AuditBreakdownTabId, string[]>> = {
  unresolved_failed: [
    'primaryMemberName',
    'paymentMethods',
    'daysLate',
    'failedCount',
    'totalFailedAmount',
    'latestPaymentDate'
  ],
  missing_recurring: [...MISSING_RECURRING_AUDIT_COLUMN_ORDER],
  bad_json: ['groupName', 'primaryMemberName', 'amount', 'paymentDate', 'invalidJsonFields'],
  payment_hold: ['memberName', 'groupName', 'enrollmentCount', 'productNames', 'status', 'effectiveDate', 'createdDate'],
  orphan_payments: [
    'paymentId',
    'primaryMemberName',
    'groupName',
    'amount',
    'paymentDate',
    'status',
    'householdId',
    'groupId'
  ]
};

function labelAuditColumn(key: string): string {
  if (AUDIT_DRILLDOWN_LABELS[key]) return AUDIT_DRILLDOWN_LABELS[key];
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

function formatAuditDrilldownCell(key: string, value: unknown, formatCurrency: (n: number) => string): React.ReactNode {
  if (value == null || value === '') return '—';
  const keyLower = key.toLowerCase();
  if (keyLower === 'dayslate') {
    const n = Number(value);
    return Number.isFinite(n) ? String(Math.max(0, Math.floor(n))) : '—';
  }
  if (
    keyLower === 'amount' ||
    keyLower === 'totalpremium' ||
    keyLower === 'lastchargeamount' ||
    keyLower.includes('amount')
  ) {
    const n = Number(value);
    return Number.isFinite(n) ? formatCurrency(n) : String(value);
  }
  if (
    keyLower.includes('date') ||
    keyLower === 'paymentdate' ||
    keyLower === 'latestpaymentdate' ||
    keyLower === 'retrydate' ||
    keyLower === 'lastpaymentdate'
  ) {
    const d = new Date(String(value));
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  if (keyLower === 'memberemail') {
    const s = String(value).trim();
    if (!s) return '—';
    return (
      <a href={`mailto:${encodeURIComponent(s)}`} className="text-blue-600 hover:text-blue-800 font-medium break-all">
        {s}
      </a>
    );
  }
  if (keyLower === 'memberphone') {
    const s = String(value).trim();
    if (!s) return '—';
    const d = s.replace(/\D/g, '');
    const href =
      d.length === 10 ? `tel:+1${d}` : d.length >= 11 ? `tel:+${d}` : `tel:${encodeURIComponent(s)}`;
    return (
      <a href={href} className="text-blue-600 hover:text-blue-800 font-medium whitespace-nowrap">
        {s}
      </a>
    );
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function auditStatusCellClass(status: string): string {
  const s = status.toLowerCase();
  if (s === 'failed' || s === 'overdue') return 'text-red-700 font-medium';
  if (s === 'pending' || s === 'sent' || s === 'paymenthold') return 'text-amber-700 font-medium';
  if (s === 'completed' || s === 'paid' || s === 'active') return 'text-green-700 font-medium';
  return 'text-gray-800';
}

function digitsOnlyPhone(s: string): string {
  return s.replace(/\D/g, '');
}

function isUsableMemberPhone(raw: string): boolean {
  return digitsOnlyPhone(raw).length >= 10;
}

function AuditDrilldownTable({
  rows,
  breakdownTab,
  formatCurrency,
  onMemberClick,
  onGroupClick,
  hideGroupNameColumn
}: {
  rows: Record<string, unknown>[];
  breakdownTab?: AuditBreakdownTabId | null;
  formatCurrency: (n: number) => string;
  onMemberClick?: (memberId: string, initialTab?: MemberManagementModalTab) => void;
  onGroupClick?: (groupId: string) => void;
  /** When true, omit Group column — group payments show the group name under Member/Group (primaryMemberName). */
  hideGroupNameColumn?: boolean;
}) {
  const [sortKey, setSortKey] = useState<string>('lastPaymentDate');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  /** Shape guard: unresolved-failed summary rows also carry payment-method counts; use missing-recurring-only fields. */
  const isMissingRecurringDrilldown =
    breakdownTab === 'missing_recurring' ||
    (rows.length > 0 && rows[0] !== undefined && 'lastRecurringScheduleId' in rows[0]);

  /** Failed-payment drilldown modal rows (per payment) — same payment-methods column + Billing link. */
  const isFailedPaymentDetailDrilldown =
    rows.length > 0 && rows[0] !== undefined && 'paymentId' in rows[0] && 'failureReason' in rows[0];

  useEffect(() => {
    if (breakdownTab === 'missing_recurring') {
      setSortKey('lastPaymentDate');
      setSortDir('asc');
    }
  }, [breakdownTab]);

  const displayRows = useMemo(() => {
    if (!isMissingRecurringDrilldown) return rows;
    return [...rows].sort((a, b) => compareAuditRows(a, b, sortKey, sortDir));
  }, [rows, isMissingRecurringDrilldown, sortKey, sortDir]);

  if (!rows.length) {
    return <p className="text-sm text-gray-500 py-4">No rows.</p>;
  }
  const sample = rows[0];
  const visibleFromRow = Object.keys(sample).filter((k) => {
    const norm = k.replace(/_/g, '').toLowerCase();
    if (
      breakdownTab === 'orphan_payments' &&
      (norm === 'paymentid' || norm === 'groupid' || norm === 'householdid')
    )
      return true;
    return !isHiddenAuditColumn(k);
  });
  const preferred = breakdownTab
    ? AUDIT_DRILLDOWN_COLUMN_ORDER[breakdownTab]
    : isMissingRecurringDrilldown
      ? [...MISSING_RECURRING_AUDIT_COLUMN_ORDER]
      : undefined;
  let keys = preferred
    ? [...preferred.filter((k) => k in sample), ...visibleFromRow.filter((k) => !preferred.includes(k))]
    : visibleFromRow;
  if (hideGroupNameColumn) {
    keys = keys.filter((k) => k.replace(/_/g, '').toLowerCase() !== 'groupname');
  }

  if (isMissingRecurringDrilldown) {
    keys = keys.filter((k) => {
      const n = k.replace(/_/g, '').toLowerCase();
      return n !== 'memberemail' && n !== 'groupname';
    });
  }

  if (isFailedPaymentDetailDrilldown && !preferred) {
    const order = [
      'primaryMemberName',
      'paymentMethods',
      'daysLate',
      'amount',
      'paymentDate',
      'failureReason',
      'processorTransactionId',
      'retryDate',
      'status',
      'groupName'
    ];
    keys = [...order.filter((k) => k in sample), ...keys.filter((k) => !order.includes(k))];
  }

  const sortableMissingRecurring = isMissingRecurringDrilldown;
  const sortableKeySet = new Set<string>(MISSING_RECURRING_AUDIT_COLUMN_ORDER);

  return (
    <div className="w-full min-w-0 max-w-full rounded-lg border border-gray-200">
      <div className="max-h-[70vh] overflow-auto overscroll-x-contain">
        <table className="min-w-max w-full divide-y divide-gray-200 text-sm">
        <thead className="bg-gray-50 sticky top-0">
          <tr>
            {keys.map((k) => {
              const isSortable = sortableMissingRecurring && sortableKeySet.has(k);
              return (
                <th
                  key={k}
                  className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap"
                >
                  {isSortable ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
                        else {
                          setSortKey(k);
                          setSortDir('asc');
                        }
                      }}
                      className="inline-flex items-center gap-1 font-medium uppercase tracking-wider text-gray-500 hover:text-gray-800"
                    >
                      {isMissingRecurringDrilldown && k === 'memberName'
                        ? 'Member/Group'
                        : labelAuditColumn(k)}
                      {sortKey === k ? (
                        sortDir === 'asc' ? (
                          <ChevronUp className="h-4 w-4 shrink-0" aria-hidden />
                        ) : (
                          <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
                        )
                      ) : (
                        <ArrowUpDown className="h-4 w-4 shrink-0 opacity-40" aria-hidden />
                      )}
                    </button>
                  ) : (
                    isMissingRecurringDrilldown && k === 'memberName' ? 'Member/Group' : labelAuditColumn(k)
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {displayRows.map((row, i) => (
            <tr key={i}>
              {keys.map((k) => {
                const raw = row[k];
                const isStatus = k.toLowerCase() === 'status';
                const isFailure = k.toLowerCase() === 'failurereason';
                const isInvalidJson = k.toLowerCase() === 'invalidjsonfields';
                const keyNorm = k.replace(/_/g, '').toLowerCase();
                const isPaymentMethodsCol =
                  keyNorm === 'paymentmethods' &&
                  (isMissingRecurringDrilldown || isFailedPaymentDetailDrilldown) &&
                  onMemberClick &&
                  'validPaymentMethodCount' in row;
                const memberIdVal = row.memberId ?? row.MemberId;
                const groupIdVal = row.groupId ?? row.GroupId;
                const memberId = memberIdVal != null && String(memberIdVal).trim() ? String(memberIdVal) : '';
                const groupId = groupIdVal != null && String(groupIdVal).trim() ? String(groupIdVal) : '';
                const groupNameVal = row.groupName ?? row.GroupName;
                const isGroupPaymentRow = Boolean(groupId);
                const isPrimaryMemberOrGroup = keyNorm === 'primarymembername';
                const isMissingRecurringMemberCol =
                  isMissingRecurringDrilldown && keyNorm === 'membername';
                const baseCell =
                  isMissingRecurringMemberCol && isGroupPaymentRow
                    ? formatAuditDrilldownCell(k, groupNameVal, formatCurrency)
                    : isPrimaryMemberOrGroup && isGroupPaymentRow
                      ? formatAuditDrilldownCell(k, groupNameVal, formatCurrency)
                      : formatAuditDrilldownCell(k, raw, formatCurrency);
                const isNameLinkMember =
                  onMemberClick &&
                  memberId &&
                  raw != null &&
                  String(raw).trim() !== '' &&
                  ((keyNorm === 'primarymembername' && !isGroupPaymentRow) ||
                    (keyNorm === 'membername' && !isGroupPaymentRow));
                const isNameLinkGroup =
                  onGroupClick &&
                  groupId &&
                  groupNameVal != null &&
                  String(groupNameVal).trim() !== '' &&
                  (keyNorm === 'groupname' ||
                    (keyNorm === 'primarymembername' && isGroupPaymentRow) ||
                    (isMissingRecurringMemberCol && isGroupPaymentRow));
                const pendingPmCount = Number(row.pendingPaymentMethodCount ?? 0);
                const hasPendingVault = pendingPmCount > 0;
                let inner: React.ReactNode = baseCell;
                if (isStatus && raw != null) {
                  inner = <span className={auditStatusCellClass(String(raw))}>{baseCell}</span>;
                } else if (isPaymentMethodsCol && memberId) {
                  // Amber attention color when there's a PendingProcessorVault row — ops needs
                  // to resolve it via the "Add to Processor" button in MemberPaymentsTab. Without
                  // a color cue these blend into the normal "no PM on file" rows and get missed.
                  const btnCls = hasPendingVault
                    ? 'text-amber-700 hover:text-amber-900 font-medium hover:underline text-left max-w-full'
                    : 'text-blue-600 hover:text-blue-800 font-medium hover:underline text-left max-w-full';
                  inner = (
                    <button
                      type="button"
                      onClick={() => onMemberClick!(memberId, 'payments')}
                      className={btnCls}
                      title={hasPendingVault ? 'Payment method is pending processor vault — click to open and retry Add to Processor' : undefined}
                    >
                      {formatPaymentMethodValiditySummary(row)}
                    </button>
                  );
                } else if (isNameLinkMember) {
                  inner = (
                    <button
                      type="button"
                      onClick={() => onMemberClick(memberId)}
                      className="text-blue-600 hover:text-blue-800 font-medium hover:underline text-left max-w-full"
                    >
                      {baseCell}
                    </button>
                  );
                } else if (isNameLinkGroup) {
                  inner = (
                    <button
                      type="button"
                      onClick={() => onGroupClick(groupId)}
                      className="text-blue-600 hover:text-blue-800 font-medium hover:underline text-left max-w-full"
                    >
                      {baseCell}
                    </button>
                  );
                }
                return (
                  <td
                    key={k}
                    className={`px-3 py-2 text-sm break-words max-w-[min(28rem,40vw)] ${
                      k.toLowerCase() === 'processortransactionid' ? 'font-mono text-xs' : ''
                    } ${!isStatus ? 'text-gray-800' : ''} ${isFailure || isInvalidJson ? 'text-red-700' : ''}`}
                  >
                    {inner}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

function getRowField(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null) return row[k];
  }
  return undefined;
}

function pickRowDateString(row: Record<string, unknown>): string | null {
  const v = getRowField(
    row,
    'latestPaymentDate',
    'LatestPaymentDate',
    'paymentDate',
    'PaymentDate',
    'createdDate',
    'CreatedDate',
    'effectiveDate',
    'EffectiveDate'
  ) as string | undefined;
  if (!v) return null;
  const d = String(v).split('T')[0];
  return d || null;
}

function parseAmountFromRow(row: Record<string, unknown>): number | null {
  const v = getRowField(row, 'amount', 'Amount', 'linkedAmount', 'totalPremium', 'TotalPremium');
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function auditRowMatchesFilters(
  row: Record<string, unknown>,
  f: {
    text: string;
    groupId: string;
    memberId: string;
    agentId: string;
    dateStart: string;
    dateEnd: string;
    amtMin: string;
    amtMax: string;
  }
): boolean {
  const text = f.text.trim().toLowerCase();
  if (text) {
    const blob = Object.values(row)
      .map((x) => (x == null ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x)))
      .join(' ')
      .toLowerCase();
    if (!blob.includes(text)) return false;
  }
  if (f.groupId) {
    const gid = String(getRowField(row, 'groupId', 'GroupId') ?? '');
    if (gid !== f.groupId) return false;
  }
  if (f.memberId) {
    const mid = String(getRowField(row, 'memberId', 'MemberId') ?? '');
    if (mid !== f.memberId) return false;
  }
  if (f.agentId) {
    const aid = String(getRowField(row, 'agentId', 'AgentId') ?? '');
    if (aid !== f.agentId) return false;
  }
  const ds = pickRowDateString(row);
  if (f.dateStart && ds && ds < f.dateStart) return false;
  if (f.dateEnd && ds && ds > f.dateEnd) return false;
  const amt = parseAmountFromRow(row);
  if (f.amtMin !== '' || f.amtMax !== '') {
    if (amt == null) return false;
    if (f.amtMin !== '' && Number(f.amtMin) > amt) return false;
    if (f.amtMax !== '' && Number(f.amtMax) < amt) return false;
  }
  return true;
}

const AUDIT_BREAKDOWN_TAB_CONFIG: { id: AuditBreakdownTabId; label: string }[] = [
  { id: 'webhooks', label: 'Webhook errors' },
  { id: 'unresolved_failed', label: 'Unresolved failed payments' },
  { id: 'orphan_payments', label: 'Orphan payments' },
  { id: 'missing_recurring', label: 'Missing recurring' },
  { id: 'bad_json', label: 'Bad JSON' },
  { id: 'payment_hold', label: 'Payment hold' },
  { id: 'wizard', label: 'Wizard payment failures' }
];

/** Payment status filter value: server applies audit "unresolved failed" rules (not a raw DB status). */
const PAYMENT_STATUS_UNRESOLVED_FAILED = '__unresolved_failed__';

const PAYMENT_STATUSES = [
  { value: '', label: 'All statuses' },
  { value: PAYMENT_STATUS_UNRESOLVED_FAILED, label: 'Unresolved failed payments' },
  { value: 'Completed', label: 'Completed' },
  { value: 'Refunded', label: 'Refunded' },
  { value: 'Failed', label: 'Failed' },
  { value: 'Pending', label: 'Pending' },
  { value: 'Returned', label: 'Returned' },
  { value: 'Voided', label: 'Voided' }
];

function getMonthRange(year: number, month: number): { startDate: string; endDate: string } {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10)
  };
}

/** Default transaction list: first through last day of the current calendar month. */
function getDefaultTransactionsDateRange(): { startDate: string; endDate: string } {
  const n = new Date();
  return getMonthRange(n.getFullYear(), n.getMonth() + 1);
}

const pad2 = (n: number) => String(n).padStart(2, '0');
function formatLocalYmd(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Parse a UTC date string into a local Date without timezone shift (for calendar dates like billing periods, due dates). */
function parseCalendarDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('T')[0].split('-');
  return new Date(Number(y), Number(m) - 1, Number(d));
}

function formatCalendarDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  const d = parseCalendarDate(dateStr);
  return Number.isNaN(d.getTime()) ? String(dateStr) : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Last 30 days inclusive (local dates) — default for audit webhook / wizard server filters. */
function getDefaultAuditServerFilterRange(): { start: string; end: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 30);
  return { start: formatLocalYmd(start), end: formatLocalYmd(end) };
}

/** From 1st of current month through today (local dates). */
function getMonthToDateAuditFilterRange(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end.getFullYear(), end.getMonth(), 1);
  return { start: formatLocalYmd(start), end: formatLocalYmd(end) };
}

interface Enrollment {
  EnrollmentId: string;
  ProductName: string;
  ProductType: string;
  Status: string;
  EffectiveDate: string;
  TerminationDate?: string;
  Premium: number;
  PaymentFrequency: string;
}

function formatInvoiceReminderChannels(hadEmail: boolean, hadSms: boolean): string {
  if (hadEmail && hadSms) return 'Email + SMS';
  if (hadEmail) return 'Email';
  if (hadSms) return 'SMS';
  return '—';
}

function buildInvoiceReminderTooltip(inv: Invoice): string {
  if (!inv.LastReminderSentAt) return '';
  const count = Number(inv.ReminderSendCount ?? 0);
  const hadEmail = Boolean(inv.LastReminderHadEmail);
  const hadSms = Boolean(inv.LastReminderHadSms);
  const channels = formatInvoiceReminderChannels(hadEmail, hadSms);
  const sentAt = new Date(inv.LastReminderSentAt);
  const when = Number.isNaN(sentAt.getTime())
    ? String(inv.LastReminderSentAt)
    : sentAt.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const channelSuffix = channels !== '—' ? ` (${channels})` : '';
  if (count > 0) {
    return `${count} notification${count !== 1 ? 's' : ''} sent. Last: ${when}${channelSuffix}.`;
  }
  return `Last reminder sent ${when}${channelSuffix}.`;
}

function InvoicePendingPaymentBadge({ inv }: { inv: Invoice }) {
  const count = Number(inv.PendingPaymentCount ?? 0);
  const amount = Number(inv.PendingPaymentAmount ?? 0);
  if (count <= 0 || amount <= 0) return null;

  const balance = Number(inv.BalanceDue ?? 0);
  const coversBalance = amount >= balance - 0.01;
  const methodLabel = inv.LatestPendingPaymentMethod
    ? getPaymentMethodType(inv.LatestPendingPaymentMethod).label
    : 'Payment';
  const initiated = inv.LatestPendingPaymentDate
    ? formatCalendarDate(inv.LatestPendingPaymentDate)
    : null;
  const isUnlinked = Boolean(inv.LatestPendingPaymentUnlinked);
  const tooltipParts = [
    count > 1
      ? `${count} pending payments totaling $${amount.toFixed(2)}`
      : `$${amount.toFixed(2)} pending ${methodLabel}`,
    initiated ? `Initiated ${initiated}` : null,
    coversBalance
      ? 'Should satisfy the open balance when settled.'
      : 'May only partially cover the open balance when settled.',
    isUnlinked
      ? 'Not linked to this invoice yet — links automatically once the payment settles.'
      : null,
  ].filter(Boolean);

  return (
    <span
      title={tooltipParts.join(' ')}
      className="inline-flex px-2 py-0.5 text-xs font-medium rounded-full bg-yellow-50 text-yellow-800 border border-yellow-200"
    >
      {methodLabel} ${amount.toFixed(2)} pending
      {coversBalance ? ' · covers balance' : ''}
    </span>
  );
}

function InvoiceLastReminderCell({ inv }: { inv: Invoice }) {
  if (!inv.LastReminderSentAt) return <>—</>;
  const tooltip = buildInvoiceReminderTooltip(inv);
  return (
    <div className="relative inline-block group">
      <span className="cursor-help border-b border-dotted border-gray-400" title={tooltip}>
        {formatCalendarDate(inv.LastReminderSentAt)}
      </span>
      {tooltip ? (
        <div
          role="tooltip"
          className="pointer-events-none absolute left-0 top-full z-50 mt-1 hidden w-max max-w-xs rounded-lg bg-gray-900 px-2.5 py-1.5 text-xs leading-snug text-white shadow-lg group-hover:block"
        >
          {tooltip}
        </div>
      ) : null}
    </div>
  );
}

function InvoiceStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    Paid: 'bg-green-100 text-green-800',
    Overdue: 'bg-red-100 text-red-800',
    Partial: 'bg-orange-100 text-orange-800',
    Unpaid: 'bg-yellow-100 text-yellow-800',
    Cancelled: 'bg-gray-100 text-gray-600',
  };
  return (
    <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${styles[status] || 'bg-gray-100 text-gray-600'}`}>
      {status}
    </span>
  );
}

function InvoiceAuditContent({ data, onCorrect, correcting }: {
  data: InvoiceAuditPayload;
  onCorrect: () => void;
  correcting: boolean;
}) {
  const { invoice, computed, totals } = data;

  const bucketLabels: { key: string; label: string }[] = [
    { key: 'NetRate', label: 'Net Rate (Vendor)' },
    { key: 'OverrideRate', label: 'Override Rate' },
    { key: 'Commission', label: 'Commission' },
    { key: 'SystemFees', label: 'System Fees' },
    { key: 'ProcessingFeeAmount', label: 'Processing Fee' },
    { key: 'SetupFee', label: 'Setup Fee' },
  ];

  const computedKeyMap: Record<string, string> = {
    NetRate: 'netRate', OverrideRate: 'overrideRate', Commission: 'commission',
    SystemFees: 'systemFees', ProcessingFeeAmount: 'processingFeeAmount', SetupFee: 'setupFee',
  };

  const allNull = bucketLabels.every(b => invoice[b.key as keyof typeof invoice] == null || invoice[b.key as keyof typeof invoice] === 0)
    && !invoice.ProductCommissions && !invoice.ProductVendorAmounts;

  const hasMismatch = Math.abs(totals.storedVsComputedDiff) > 0.01;

  return (
    <div className="space-y-4">
      <div className="bg-gray-50 rounded-lg p-3 text-sm space-y-1">
        <div className="flex justify-between">
          <span className="text-gray-500">Total Amount</span>
          <span className="font-medium text-gray-900">${totals.totalAmount.toFixed(2)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Stored Breakdown Sum</span>
          <span className={`font-medium ${allNull ? 'text-gray-400 italic' : 'text-gray-900'}`}>
            {allNull ? 'Not populated yet' : `$${totals.storedSum.toFixed(2)}`}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Computed Breakdown Sum</span>
          <span className="font-medium text-gray-900">${totals.computedSum.toFixed(2)}</span>
        </div>
        {!allNull && (
          <div className={`flex justify-between ${hasMismatch ? 'text-red-700 font-medium' : 'text-green-700'}`}>
            <span>Stored vs Computed Diff</span>
            <span>{hasMismatch ? `$${totals.storedVsComputedDiff.toFixed(2)}` : 'Match'}</span>
          </div>
        )}
        <div className={`flex justify-between ${Math.abs(totals.computedVsTotalDiff) > 0.01 ? 'text-amber-700' : 'text-green-700'}`}>
          <span>TotalAmount vs Computed</span>
          <span>{Math.abs(totals.computedVsTotalDiff) > 0.01 ? `$${totals.computedVsTotalDiff.toFixed(2)}` : 'Match'}</span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200">
              <th className="text-left py-2 pr-4 text-xs font-medium text-gray-500 uppercase">Bucket</th>
              <th className="text-right py-2 px-4 text-xs font-medium text-gray-500 uppercase">Stored</th>
              <th className="text-right py-2 px-4 text-xs font-medium text-gray-500 uppercase">Computed</th>
              <th className="text-right py-2 pl-4 text-xs font-medium text-gray-500 uppercase">Diff</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {bucketLabels.map(({ key, label }) => {
              const stored = Number((invoice as unknown as Record<string, unknown>)[key]) || 0;
              const comp = Number((computed as unknown as Record<string, unknown>)[computedKeyMap[key]]) || 0;
              const diff = Math.round((stored - comp) * 100) / 100;
              const hasDiff = Math.abs(diff) > 0.005;
              return (
                <tr key={key}>
                  <td className="py-1.5 pr-4 text-gray-700">{label}</td>
                  <td className={`py-1.5 px-4 text-right ${allNull && stored === 0 ? 'text-gray-400 italic' : 'text-gray-900'}`}>
                    {allNull && stored === 0 ? '—' : `$${stored.toFixed(2)}`}
                  </td>
                  <td className="py-1.5 px-4 text-right text-gray-900">${comp.toFixed(2)}</td>
                  <td className={`py-1.5 pl-4 text-right font-medium ${hasDiff ? 'text-red-600' : 'text-green-600'}`}>
                    {hasDiff ? `$${diff.toFixed(2)}` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {[
        { label: 'ProductCommissions', stored: invoice.ProductCommissions, comp: computed.productCommissionsJSON },
        { label: 'ProductVendorAmounts', stored: invoice.ProductVendorAmounts, comp: computed.productVendorAmountsJSON },
        { label: 'ProductOwnerAmounts', stored: invoice.ProductOwnerAmounts, comp: computed.productOwnerAmountsJSON },
      ].map(({ label, stored, comp }) => {
        const storedPretty = stored ? (() => { try { return JSON.stringify(JSON.parse(stored), null, 2); } catch { return stored; } })() : null;
        const compPretty = comp ? (() => { try { return JSON.stringify(JSON.parse(comp), null, 2); } catch { return comp; } })() : null;
        const jsonMatch = storedPretty === compPretty;
        return (
          <details key={label} className="text-sm">
            <summary className="cursor-pointer text-gray-700 hover:text-gray-900 font-medium flex items-center gap-1.5">
              {label}
              {!storedPretty ? (
                <span className="text-xs text-gray-400 font-normal">(not stored)</span>
              ) : jsonMatch ? (
                <CheckCircle className="h-3.5 w-3.5 text-green-500" />
              ) : (
                <AlertCircle className="h-3.5 w-3.5 text-red-500" />
              )}
            </summary>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs text-gray-500 mb-1">Stored</p>
                <pre className="text-xs bg-gray-50 rounded p-2 overflow-x-auto max-h-40 overflow-y-auto">{storedPretty || '—'}</pre>
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-1">Computed</p>
                <pre className="text-xs bg-gray-50 rounded p-2 overflow-x-auto max-h-40 overflow-y-auto">{compPretty || '—'}</pre>
              </div>
            </div>
          </details>
        );
      })}

      <div className="flex justify-end gap-3 pt-3 border-t border-gray-200">
        {(hasMismatch || allNull) && (
          <button
            onClick={onCorrect}
            disabled={correcting}
            className="px-4 py-2 text-sm font-medium text-white bg-oe-primary rounded-lg hover:bg-oe-dark disabled:opacity-50"
          >
            {correcting ? 'Correcting...' : allNull ? 'Populate Breakdowns' : 'Apply Correction'}
          </button>
        )}
        {!hasMismatch && !allNull && (
          <span className="inline-flex items-center gap-1.5 text-sm text-green-700 font-medium">
            <CheckCircle className="h-4 w-4" />
            All breakdowns match
          </span>
        )}
      </div>
    </div>
  );
}

function TenantInvoicesTab({ canLoadData, onMemberClick, onGroupClick, filterOptions }: {
  tenantId: string;
  canLoadData: boolean;
  onMemberClick?: (memberId: string) => void;
  onGroupClick?: (groupId: string) => void;
  filterOptions?: BillingFilterOptions | null;
}) {
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [groupIdFilter, setGroupIdFilter] = useState('');
  const [memberIdFilter, setMemberIdFilter] = useState('');
  const [overdueSortBy, setOverdueSortBy] = useState<'most_overdue' | 'highest_balance' | 'newest'>('most_overdue');
  const { data, isLoading, refetch } = useInvoices(
    {
      status: statusFilter || undefined,
      type: typeFilter || undefined,
      search: searchTerm || undefined,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      groupId: groupIdFilter || undefined,
      memberId: memberIdFilter || undefined,
      sortBy: statusFilter === 'Overdue' ? overdueSortBy : undefined,
    },
    canLoadData
  );
  const invoices: Invoice[] = data?.invoices || [];
  const invoiceSummary = data?.summary;

  const formatInvoiceMoney = (n: number) =>
    `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const [editingInvoice, setEditingInvoice] = useState<Invoice | null>(null);
  const [editPaidAmount, setEditPaidAmount] = useState('');
  const [editStatus, setEditStatus] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [invoiceResyncing, setInvoiceResyncing] = useState(false);

  const [auditInvoice, setAuditInvoice] = useState<Invoice | null>(null);
  const [auditData, setAuditData] = useState<InvoiceAuditPayload | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditCorrecting, setAuditCorrecting] = useState(false);
  const [backfilling, setBackfilling] = useState(false);

  const openAuditModal = async (inv: Invoice) => {
    setAuditInvoice(inv);
    setAuditData(null);
    setAuditError(null);
    setAuditLoading(true);
    try {
      const res = await invoicesService.getInvoiceAudit(inv.InvoiceId);
      if (res.success && res.data) {
        setAuditData(res.data);
      } else {
        setAuditError(res.message || 'Failed to load audit data');
      }
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : 'Failed to load audit data');
    } finally {
      setAuditLoading(false);
    }
  };

  const handleAuditCorrect = async () => {
    if (!auditInvoice) return;
    setAuditCorrecting(true);
    try {
      const res = await invoicesService.correctInvoiceBreakdowns(auditInvoice.InvoiceId);
      if (res.success && res.data) {
        setAuditData(res.data);
        toast.success('Invoice breakdowns corrected');
      } else {
        toast.error(res.message || 'Failed to correct breakdowns');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to correct breakdowns');
    } finally {
      setAuditCorrecting(false);
    }
  };

  const openEditModal = (inv: Invoice) => {
    setEditingInvoice(inv);
    setEditPaidAmount(String(Number(inv.PaidAmount).toFixed(2)));
    setEditStatus(inv.Status);
  };

  const handleEditSave = async () => {
    if (!editingInvoice) return;
    setEditSaving(true);
    try {
      const paidAmount = parseFloat(editPaidAmount);
      if (isNaN(paidAmount) || paidAmount < 0) {
        toast.error('Paid amount must be a valid non-negative number');
        setEditSaving(false);
        return;
      }
      await invoicesService.updateInvoice(editingInvoice.InvoiceId, { paidAmount, status: editStatus });
      toast.success('Invoice updated successfully');
      setEditingInvoice(null);
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update invoice');
    } finally {
      setEditSaving(false);
    }
  };

  const markAsFulfilled = () => {
    if (!editingInvoice) return;
    setEditPaidAmount(String(Number(editingInvoice.TotalAmount).toFixed(2)));
    setEditStatus('Paid');
  };

  const handleInvoiceResyncOpenMaintenance = async () => {
    if (!editingInvoice || editingInvoice.InvoiceType !== 'Individual') return;
    setInvoiceResyncing(true);
    try {
      const res = await invoicesService.resyncInvoiceOpenMaintenance(editingInvoice.InvoiceId);
      if (!res.success) {
        toast.error(res.message || 'Resync failed');
        return;
      }
      if (res.skipped) {
        toast(res.message || 'No changes applied for this invoice.', { icon: 'ℹ️' });
      } else {
        const d = res.data;
        const parts: string[] = [];
        if (d?.selfHeal?.linkedPayments) parts.push(`${d.selfHeal.linkedPayments} payment(s) linked`);
        if (d?.reconcile?.updated) parts.push('total recomputed');
        if (d?.dimeRecurringSynced) parts.push('DIME recurring synced');
        if (d?.dimeSyncError) parts.push(`DIME sync note: ${d.dimeSyncError}`);
        toast.success(parts.length ? `Invoice resynced: ${parts.join(' · ')}` : 'Invoice resync complete.');
      }
      const refreshed = await refetch();
      const invs = refreshed.data?.invoices;
      const next = invs?.find((i) => i.InvoiceId === editingInvoice.InvoiceId);
      if (next) {
        setEditingInvoice(next);
        setEditPaidAmount(String(Number(next.PaidAmount).toFixed(2)));
        setEditStatus(next.Status);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Resync failed');
    } finally {
      setInvoiceResyncing(false);
    }
  };

  const handleBackfillBreakdowns = async () => {
    setBackfilling(true);
    try {
      const res = await invoicesService.backfillBreakdowns();
      if (res.success && res.data) {
        const d = res.data;
        const total = d.phase1CopiedFromPayments + d.phase2Recomputed;
        if (total === 0 && d.remainingUnpopulated === 0) {
          toast.success('All invoice breakdowns are already populated');
        } else {
          toast.success(
            `Updated ${total} invoice${total !== 1 ? 's' : ''}: ${d.phase1CopiedFromPayments} from payments, ${d.phase2Recomputed} recomputed` +
            (d.phase2Errors > 0 ? ` (${d.phase2Errors} errors)` : '') +
            (d.remainingUnpopulated > 0 ? ` — ${d.remainingUnpopulated} still need attention` : '')
          );
        }
        refetch();
      } else {
        toast.error(res.message || 'Backfill failed');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Backfill failed');
    } finally {
      setBackfilling(false);
    }
  };

  if (!canLoadData) {
    return (
      <div className="rounded-lg bg-yellow-50 border border-yellow-200 text-yellow-800 p-4 flex items-center gap-2">
        <AlertCircle className="h-5 w-5 flex-shrink-0" />
        <span>Select a tenant to view invoices.</span>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Filter className="h-5 w-5 text-gray-500" />
        <input
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
          aria-label="Start date"
        />
        <span className="text-gray-500">to</span>
        <input
          type="date"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
          aria-label="End date"
        />
        <select
          value={statusFilter}
          onChange={(e) => {
            const next = e.target.value;
            setStatusFilter(next);
            if (next !== 'Overdue') setOverdueSortBy('most_overdue');
          }}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
        >
          <option value="">All Statuses</option>
          <option value="NotPaid">Not Paid</option>
          <option value="Unpaid">Unpaid</option>
          <option value="Partial">Partial</option>
          <option value="Paid">Paid</option>
          <option value="Overdue">Overdue (incl. partial balance)</option>
          <option value="Cancelled">Cancelled</option>
        </select>
        {statusFilter === 'Overdue' && (
          <>
            <select
              value={overdueSortBy}
              onChange={(e) => setOverdueSortBy(e.target.value as 'most_overdue' | 'highest_balance' | 'newest')}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
              aria-label="Overdue sort order"
            >
              <option value="most_overdue">Longest overdue first</option>
              <option value="highest_balance">Highest balance first</option>
              <option value="newest">Newest invoice first</option>
            </select>
            <span className="text-xs text-gray-600 max-w-xs">
              Past-due with open balance (Unpaid, Partial, or Overdue). Date range filters by due date; clear dates to see all.
            </span>
          </>
        )}
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
        >
          <option value="">All Types</option>
          <option value="Individual">Individual</option>
          <option value="Group">Group</option>
        </select>
        {filterOptions && (
          <>
            <SearchableDropdown
              options={filterOptions.groups}
              value={groupIdFilter}
              onChange={(v) => setGroupIdFilter(v || '')}
              placeholder="Group"
              className="min-w-[160px]"
            />
            <SearchableDropdown
              options={filterOptions.members}
              value={memberIdFilter}
              onChange={(v) => setMemberIdFilter(v || '')}
              placeholder="Member"
              className="min-w-[160px]"
              showEmail
            />
          </>
        )}
        <input
          type="text"
          placeholder="Search invoices..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 w-48"
        />
        <button
          type="button"
          onClick={() => {
            setStatusFilter('');
            setTypeFilter('');
            setSearchTerm('');
            setStartDate('');
            setEndDate('');
            setGroupIdFilter('');
            setMemberIdFilter('');
            setOverdueSortBy('most_overdue');
          }}
          className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm"
        >
          <RotateCcw className="h-4 w-4 inline mr-1" />
          Reset
        </button>
        <button
          type="button"
          onClick={handleBackfillBreakdowns}
          disabled={backfilling}
          className="px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark text-sm disabled:opacity-50 ml-auto"
        >
          {backfilling ? 'Backfilling...' : 'Backfill All Breakdowns'}
        </button>
      </div>

      {invoiceSummary && !isLoading && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Invoices</p>
            <p className="mt-1 text-xl font-bold tabular-nums text-gray-900">{invoiceSummary.invoiceCount}</p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Total billed</p>
            <p className="mt-1 text-xl font-bold tabular-nums text-gray-900">
              {formatInvoiceMoney(invoiceSummary.totalAmount)}
            </p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Total paid</p>
            <p className="mt-1 text-xl font-bold tabular-nums text-green-700">
              {formatInvoiceMoney(invoiceSummary.totalPaid)}
            </p>
          </div>
          <div
            className={`rounded-lg border px-4 py-3 ${
              statusFilter === 'Overdue' || invoiceSummary.totalBalanceDue > 0
                ? 'border-red-200 bg-red-50'
                : 'border-gray-200 bg-white'
            }`}
          >
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Balance due</p>
            <p
              className={`mt-1 text-xl font-bold tabular-nums ${
                invoiceSummary.totalBalanceDue > 0 ? 'text-red-800' : 'text-gray-900'
              }`}
            >
              {formatInvoiceMoney(invoiceSummary.totalBalanceDue)}
            </p>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        </div>
      ) : invoices.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <FileText className="h-12 w-12 mx-auto mb-3 text-gray-300" />
          <p>No invoices found</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Invoice #</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Member / Group</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Period</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Amount</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Paid</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Balance</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Due Date</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Last reminder</th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Payments</th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {invoices.map((inv) => {
                const memberName = inv.InvoiceType === 'Individual'
                  ? `${inv.MemberFirstName || ''} ${inv.MemberLastName || ''}`.trim() || '—'
                  : inv.GroupName || '—';
                const isClickable = inv.InvoiceType === 'Individual'
                  ? !!(inv.MemberId && onMemberClick)
                  : !!(inv.GroupId && onGroupClick);

                return (
                  <tr key={inv.InvoiceId} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">{inv.InvoiceNumber}</td>
                    <td className="px-4 py-3 text-sm">
                      {isClickable ? (
                        <button
                          type="button"
                          className="text-oe-primary hover:text-oe-dark hover:underline font-medium"
                          onClick={() => {
                            if (inv.InvoiceType === 'Individual' && inv.MemberId && onMemberClick) {
                              onMemberClick(inv.MemberId);
                            } else if (inv.GroupId && onGroupClick) {
                              onGroupClick(inv.GroupId);
                            }
                          }}
                        >
                          {memberName}
                        </button>
                      ) : (
                        <span className="text-gray-600">{memberName}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">{inv.InvoiceType}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {formatCalendarDate(inv.BillingPeriodStart)} – {formatCalendarDate(inv.BillingPeriodEnd)}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-900 text-right">${Number(inv.TotalAmount).toFixed(2)}</td>
                    <td className="px-4 py-3 text-sm text-gray-900 text-right">${Number(inv.PaidAmount).toFixed(2)}</td>
                    <td className="px-4 py-3 text-sm text-gray-900 text-right">${Number(inv.BalanceDue).toFixed(2)}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col items-start gap-1">
                        <InvoiceStatusBadge status={inv.Status} />
                        <InvoicePendingPaymentBadge inv={inv} />
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">{formatCalendarDate(inv.DueDate)}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">
                      <InvoiceLastReminderCell inv={inv} />
                    </td>
                    <td className="px-4 py-3 text-sm text-center text-gray-600">{inv.PaymentCount ?? 0}</td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex items-center justify-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => openAuditModal(inv)}
                          className="text-gray-400 hover:text-oe-primary"
                          title="Audit breakdowns"
                        >
                          <FileSearch className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => openEditModal(inv)}
                          className="text-gray-400 hover:text-gray-600"
                          title="Edit invoice"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Invoice Edit Modal */}
      {editingInvoice && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50" onClick={() => setEditingInvoice(null)}>
          <div className="relative top-20 mx-auto p-0 border w-[420px] shadow-lg rounded-lg bg-white" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-gray-200">
              <h3 className="text-lg font-medium text-gray-900">Edit Invoice</h3>
              <button onClick={() => setEditingInvoice(null)} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div className="bg-gray-50 rounded-lg p-3 text-sm space-y-1">
                <div className="flex justify-between">
                  <span className="text-gray-500">Invoice</span>
                  <span className="font-medium text-gray-900">{editingInvoice.InvoiceNumber}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Total Amount</span>
                  <span className="font-medium text-gray-900">${Number(editingInvoice.TotalAmount).toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Current Paid</span>
                  <span className="font-medium text-gray-900">${Number(editingInvoice.PaidAmount).toFixed(2)}</span>
                </div>
                {Number(editingInvoice.BalanceDue) > 0 && Number(editingInvoice.BalanceDue) < 1 && (
                  <div className="flex justify-between text-yellow-700">
                    <span>Remaining</span>
                    <span className="font-medium">${Number(editingInvoice.BalanceDue).toFixed(2)} (likely rounding)</span>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Paid Amount</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={editPaidAmount}
                  onChange={(e) => setEditPaidAmount(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                <select
                  value={editStatus}
                  onChange={(e) => setEditStatus(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:outline-none"
                >
                  <option value="Unpaid">Unpaid</option>
                  <option value="Partial">Partial</option>
                  <option value="Paid">Paid</option>
                  <option value="Overdue">Overdue (incl. partial balance)</option>
                  <option value="Cancelled">Cancelled</option>
                </select>
              </div>

              {editingInvoice.InvoiceType === 'Individual' && (
                <>
                  <button
                    type="button"
                    onClick={handleInvoiceResyncOpenMaintenance}
                    disabled={invoiceResyncing || editSaving}
                    className="w-full text-sm font-medium py-2 px-3 border border-gray-300 rounded-lg text-gray-800 bg-white hover:bg-gray-50 disabled:opacity-50 inline-flex items-center justify-center gap-2"
                  >
                    <RefreshCw className={`h-4 w-4 ${invoiceResyncing ? 'animate-spin' : ''}`} />
                    Resync status (nightly steps)
                  </button>
                  <p className="text-xs text-gray-500 -mt-2">
                    Links orphan payments, recomputes invoice total from enrollments, and syncs DIME recurring when the total
                    changes—the same maintenance the nightly job runs for open individual invoices.
                  </p>
                </>
              )}

              <button
                type="button"
                onClick={markAsFulfilled}
                className="w-full text-sm text-oe-primary hover:text-oe-dark font-medium py-1.5 border border-dashed border-oe-primary rounded-lg hover:bg-blue-50 transition-colors"
              >
                <CheckCircle className="h-4 w-4 inline mr-1.5" />
                Mark as Fully Paid
              </button>
            </div>
            <div className="flex justify-end gap-3 p-5 border-t border-gray-200">
              <button
                onClick={() => setEditingInvoice(null)}
                className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleEditSave}
                disabled={editSaving || invoiceResyncing}
                className="px-4 py-2 text-sm font-medium text-white bg-oe-primary rounded-lg hover:bg-oe-dark disabled:opacity-50"
              >
                {editSaving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Invoice Audit Modal */}
      {auditInvoice && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50" onClick={() => { setAuditInvoice(null); setAuditData(null); }}>
          <div className="relative top-10 mx-auto p-0 border w-[640px] shadow-lg rounded-lg bg-white mb-10" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-gray-200">
              <div>
                <h3 className="text-lg font-medium text-gray-900">Invoice Breakdown Audit</h3>
                <p className="text-sm text-gray-500 mt-0.5">{auditInvoice.InvoiceNumber} &middot; {auditInvoice.InvoiceType}</p>
              </div>
              <button onClick={() => { setAuditInvoice(null); setAuditData(null); }} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-5">
              {auditLoading ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
                  <span className="ml-2 text-sm text-gray-500">Loading audit data...</span>
                </div>
              ) : auditError ? (
                <div className="rounded-lg bg-red-50 border border-red-200 text-red-800 p-4 text-sm">
                  <AlertCircle className="h-4 w-4 inline mr-1.5" />
                  {auditError}
                </div>
              ) : auditData ? (
                <InvoiceAuditContent
                  data={auditData}
                  onCorrect={handleAuditCorrect}
                  correcting={auditCorrecting}
                />
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const TenantBilling: React.FC = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const currentRole = user?.currentRole || '';
  const isSysAdmin = currentRole === 'SysAdmin';
  const canCancelRecurringInProcessor = isSysAdmin || currentRole === 'TenantAdmin';

  const defaultAuditServerRange = useMemo(() => getDefaultAuditServerFilterRange(), []);

  const [searchParams, setSearchParams] = useSearchParams();
  const initialTabFromUrl = (() => {
    const t = searchParams.get('tab');
    return t === 'transactions' || t === 'recurring' || t === 'invoices' || t === 'credits' || t === 'audit' || t === 'overview'
      ? t
      : 'overview';
  })();
  const [activeTab, setActiveTab] = useState<'overview' | 'transactions' | 'recurring' | 'invoices' | 'credits' | 'audit'>(initialTabFromUrl);

  // Phase 1g.3: keep URL in sync so deep-links from BillingIntegrity work
  useEffect(() => {
    const current = searchParams.get('tab');
    if (current !== activeTab) {
      const next = new URLSearchParams(searchParams);
      next.set('tab', activeTab);
      setSearchParams(next, { replace: true });
    }
  }, [activeTab, searchParams, setSearchParams]);
  const [tenantId, setTenantId] = useState<string>('');
  const [tenantOptions, setTenantOptions] = useState<{ id: string; label: string; value: string }[]>([]);
  const [tenantsLoading, setTenantsLoading] = useState(false);

  const [revenue, setRevenue] = useState<{ totalRevenue: number; paymentCount: number } | null>(null);
  const [projection, setProjection] = useState<{ projectedRevenue: number; enrollmentCount: number } | null>(null);
  const [revenueYear, setRevenueYear] = useState(() => new Date().getFullYear());
  const [revenueMonth, setRevenueMonth] = useState(() => new Date().getMonth() + 1);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  const [payments, setPayments] = useState<BillingPaymentRow[]>([]);
  const [paymentsTotal, setPaymentsTotal] = useState(0);
  const [paymentsSummary, setPaymentsSummary] = useState<BillingPaymentsStatusSummary | null>(null);
  const [paymentsPage, setPaymentsPage] = useState(1);
  const [paymentsLimit] = useState(25);
  const [paymentsLoading, setPaymentsLoading] = useState(false);
  const [paymentsError, setPaymentsError] = useState<string | null>(null);
  const [filterOptions, setFilterOptions] = useState<BillingFilterOptions | null>(null);
  const [filterOptionsLoading, setFilterOptionsLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [groupIdFilter, setGroupIdFilter] = useState('');
  const [memberIdFilter, setMemberIdFilter] = useState('');
  const [agentIdFilter, setAgentIdFilter] = useState('');
  const [agencyIdFilter, setAgencyIdFilter] = useState('');
  const [commissionPaidFilter, setCommissionPaidFilter] = useState<'' | 'paid' | 'unpaid'>('');
  /** Payments with oe.Payments.InvoiceId IS NULL (tenant-admin/sysadmin/agent billing API). */
  const [noLinkedInvoiceOnly, setNoLinkedInvoiceOnly] = useState(false);
  const [paymentDetailModal, setPaymentDetailModal] = useState<BillingPaymentRow | null>(null);
  const [processorFeeModalPayment, setProcessorFeeModalPayment] = useState<BillingPaymentRow | null>(null);
  const [processorFeeDetail, setProcessorFeeDetail] = useState<{ ourProcessingFee: number; processorName: string | null; processorFee: number | null; processorFeeComingSoon?: boolean } | null>(null);
  const [processorFeeDetailLoading, setProcessorFeeDetailLoading] = useState(false);
  const [auditModalPayment, setAuditModalPayment] = useState<BillingPaymentRow | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditData, setAuditData] = useState<PaymentAuditPayload | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditConfirmMismatch, setAuditConfirmMismatch] = useState(false);
  const [auditCorrecting, setAuditCorrecting] = useState(false);
  const [showZeroSnapshotsConfirm, setShowZeroSnapshotsConfirm] = useState(false);
  const [zeroingSnapshots, setZeroingSnapshots] = useState(false);
  const [auditHouseholdsLoading, setAuditHouseholdsLoading] = useState(false);
  const [auditHouseholdsError, setAuditHouseholdsError] = useState<string | null>(null);
  const [auditHouseholds, setAuditHouseholds] = useState<PaymentAuditHouseholdBreakdownPayload | null>(null);
  const [auditHouseholdEnrollmentsOpenByHouseholdId, setAuditHouseholdEnrollmentsOpenByHouseholdId] = useState<Record<string, boolean>>({});
  const [auditHouseholdEnrollmentsLoadingByHouseholdId, setAuditHouseholdEnrollmentsLoadingByHouseholdId] = useState<Record<string, boolean>>({});
  const [auditHouseholdEnrollmentsErrorByHouseholdId, setAuditHouseholdEnrollmentsErrorByHouseholdId] = useState<Record<string, string | null>>({});
  const [auditHouseholdEnrollmentsByHouseholdId, setAuditHouseholdEnrollmentsByHouseholdId] = useState<Record<string, PaymentAuditHouseholdEnrollmentLineItem[]>>({});
  const [refundModalPayment, setRefundModalPayment] = useState<BillingPaymentRow | null>(null);
  const [transactionsStartDate, setTransactionsStartDate] = useState(() => getDefaultTransactionsDateRange().startDate);
  const [transactionsEndDate, setTransactionsEndDate] = useState(() => getDefaultTransactionsDateRange().endDate);

  const [recurringList, setRecurringList] = useState<BillingRecurringRow[]>([]);
  const [recurringStatusFilter, setRecurringStatusFilter] = useState<'active' | 'cancelled' | 'both'>('active');
  const [recurringLoading, setRecurringLoading] = useState(false);
  const [recurringError, setRecurringError] = useState<string | null>(null);
  const [recurringAgentId, setRecurringAgentId] = useState('');
  const [recurringGroupId, setRecurringGroupId] = useState('');
  const [recurringMemberType, setRecurringMemberType] = useState<'all' | 'group' | 'individual'>('all');
  const [scheduleToCancel, setScheduleToCancel] = useState<BillingRecurringRow | null>(null);
  const [cancelingSchedule, setCancelingSchedule] = useState(false);
  const [scheduleForStatusModal, setScheduleForStatusModal] = useState<BillingRecurringRow | null>(null);
  const [updatingScheduleStatus, setUpdatingScheduleStatus] = useState(false);
  const [webhookErrors, setWebhookErrors] = useState<BillingPaymentWebhookErrorRow[]>([]);
  const [webhookErrorsLoading, setWebhookErrorsLoading] = useState(false);
  const [webhookErrorsError, setWebhookErrorsError] = useState<string | null>(null);
  const [webhookErrorsLimit, setWebhookErrorsLimit] = useState(100);
  const [webhookErrorsStart, setWebhookErrorsStart] = useState(defaultAuditServerRange.start);
  const [webhookErrorsEnd, setWebhookErrorsEnd] = useState(defaultAuditServerRange.end);
  const [webhookErrorsResolutionStatus, setWebhookErrorsResolutionStatus] = useState<'unresolved' | 'resolved' | 'all'>('unresolved');
  const [webhookResolveLoadingById, setWebhookResolveLoadingById] = useState<Record<string, boolean>>({});

  const [wizardPayErrors, setWizardPayErrors] = useState<BillingEnrollmentWizardPaymentErrorRow[]>([]);
  const [wizardPayLoading, setWizardPayLoading] = useState(false);
  const [wizardPayError, setWizardPayError] = useState<string | null>(null);
  const [wizardPayLimit, setWizardPayLimit] = useState(100);
  const [wizardPayStart, setWizardPayStart] = useState(defaultAuditServerRange.start);
  const [wizardPayEnd, setWizardPayEnd] = useState(defaultAuditServerRange.end);

  const [auditSummary, setAuditSummary] = useState<BillingAuditSummaryData | null>(null);
  const [auditSummaryLoading, setAuditSummaryLoading] = useState(false);
  const [latestAuditReport, setLatestAuditReport] = useState<BillingAuditReportLatest | null>(null);
  const [latestReportLoading, setLatestReportLoading] = useState(false);

  const [runAuditsOpen, setRunAuditsOpen] = useState(false);
  const [creditsDetectionRunning, setCreditsDetectionRunning] = useState(false);
  const [billingDriftModalOpen, setBillingDriftModalOpen] = useState(false);
  const [auditReportEmailsModalOpen, setAuditReportEmailsModalOpen] = useState(false);
  const [runAuditsSelections, setRunAuditsSelections] = useState<Record<BillingAuditRunId, boolean>>({
    missing_recurring: true,
    failed_payments: true,
    dime_status: false,
    webhook_errors: true,
    payment_json_fees: false,
    enrollment_month_gaps: false,
    payment_hold_enrollments: false,
    mrr_compare: true,
    invoice_payout_integrity: true,
    orphan_payments: true
  });
  const [runAuditsStart, setRunAuditsStart] = useState(defaultAuditServerRange.start);
  const [runAuditsEnd, setRunAuditsEnd] = useState(defaultAuditServerRange.end);
  const [runAuditsDimeScope, setRunAuditsDimeScope] = useState<'calendar' | 'hours'>('calendar');
  const [runAuditsHoursBack, setRunAuditsHoursBack] = useState(168);
  const [runAuditsSuccessRecheckDays, setRunAuditsSuccessRecheckDays] = useState(0);
  const [runAuditsSecondaryLimit, setRunAuditsSecondaryLimit] = useState(0);
  const [runAuditsLimit, setRunAuditsLimit] = useState(500);
  const [runAuditsDryRun, setRunAuditsDryRun] = useState(true);
  const [runAuditsPersist, setRunAuditsPersist] = useState(false);
  const [runAuditsLoading, setRunAuditsLoading] = useState(false);
  const [runAuditsResult, setRunAuditsResult] = useState<BillingAuditRunResponse | null>(null);

  const [auditDrilldownModal, setAuditDrilldownModal] = useState<{
    title: string;
    mode: 'table' | 'mrr';
    rows?: Record<string, unknown>[];
  } | null>(null);
  const [auditDrilldownLoading, setAuditDrilldownLoading] = useState(false);
  const [mrrReconciliation, setMrrReconciliation] = useState<BillingAuditMrrReconciliationData | null>(null);
  const [mrrReconciliationLoading, setMrrReconciliationLoading] = useState(false);
  const [mrrReconciliationError, setMrrReconciliationError] = useState<string | null>(null);
  const [mrrReconciliationExpandedBucket, setMrrReconciliationExpandedBucket] = useState<string | null>(
    'NO_RECURRING_SETUP'
  );

  const [missingRecurringOutreachOpen, setMissingRecurringOutreachOpen] = useState(false);
  const [missingRecurringSetupOpen, setMissingRecurringSetupOpen] = useState(false);
  const [memberPortalLoginUrl, setMemberPortalLoginUrl] = useState('https://app.allaboard365.com/login');
  const [outreachTenantName, setOutreachTenantName] = useState<string | null>(null);
  const [outreachSupportEmail, setOutreachSupportEmail] = useState<string | null>(null);

  const [auditBreakdownTab, setAuditBreakdownTab] = useState<AuditBreakdownTabId>('webhooks');
  const [breakdownRows, setBreakdownRows] = useState<Record<string, unknown>[]>([]);
  const [breakdownLoading, setBreakdownLoading] = useState(false);
  const [breakdownError, setBreakdownError] = useState<string | null>(null);
  const [auditBreakdownText, setAuditBreakdownText] = useState('');
  const [auditBreakdownGroupId, setAuditBreakdownGroupId] = useState('');
  const [auditBreakdownMemberId, setAuditBreakdownMemberId] = useState('');
  const [auditBreakdownAgentId, setAuditBreakdownAgentId] = useState('');
  const [auditBreakdownDateStart, setAuditBreakdownDateStart] = useState(() => getDefaultAuditServerFilterRange().start);
  const [auditBreakdownDateEnd, setAuditBreakdownDateEnd] = useState(() => getDefaultAuditServerFilterRange().end);
  const [auditBreakdownAmtMin, setAuditBreakdownAmtMin] = useState('');
  const [auditBreakdownAmtMax, setAuditBreakdownAmtMax] = useState('');

  /** Per-payment rows for unresolved failed (same response as aggregated summary). */
  const [unresolvedFailedDetailRows, setUnresolvedFailedDetailRows] = useState<Record<string, unknown>[]>([]);
  const [unresolvedFailedModalBucketKey, setUnresolvedFailedModalBucketKey] = useState<string | null>(null);

  const [selectedMemberForModal, setSelectedMemberForModal] = useState<Member | null>(null);
  const [memberModalHousehold, setMemberModalHousehold] = useState<Member[]>([]);
  const [memberModalEnrollments, setMemberModalEnrollments] = useState<Enrollment[]>([]);
  const [memberModalEnrollmentsLoading, setMemberModalEnrollmentsLoading] = useState(false);
  const [memberModalInitialTab, setMemberModalInitialTab] = useState<MemberManagementModalTab | null>(null);

  const effectiveTenantId = isSysAdmin ? tenantId : (user as { tenantId?: string })?.tenantId || '';

  /** From last persisted billing audit run only (Run audits → persist). */
  const orphanPaymentsFromLatestReport = useMemo(() => {
    const results = latestAuditReport?.summary?.auditRun?.results as Record<string, unknown> | undefined;
    if (!results || !Object.prototype.hasOwnProperty.call(results, 'orphan_payments')) return undefined;
    const raw = results.orphan_payments as {
      completedNoInvoiceCount?: number;
      count?: number;
    };
    return {
      completed: Number(raw.completedNoInvoiceCount ?? raw.count ?? 0)
    };
  }, [latestAuditReport]);

  /** When live GET /audit-summary DIME fails or times out, mrr_compare may still succeed in Run audits; use saved report for display. */
  const mrrCompareFromLatestReport = useMemo(() => {
    const raw = latestAuditReport?.summary?.auditRun?.results?.mrr_compare as
      | {
          ok?: boolean;
          expectedEnrollmentMrr?: number;
          futureGroupDeferredMrr?: number;
          futureGroupDeferredEnrollmentCount?: number;
          dimeApiActiveMrr?: number | null;
          mrrDbMinusDimeApi?: number | null;
          mrrExpectedMinusDimeApi?: number | null;
          dimeApiMrrMeta?: BillingAuditSummaryData['dimeApiMrrMeta'];
        }
      | undefined;
    return raw?.ok ? raw : undefined;
  }, [latestAuditReport]);

  const mrrDisplay = useMemo(() => {
    if (!auditSummary) {
      return {
        expected: null as number | null,
        dime: null as number | null,
        diff: null as number | null,
        deferredFutureGroups: null as number | null,
        fromSavedAuditRun: false,
        metaForFooters: null as BillingAuditSummaryData['dimeApiMrrMeta'] | null | undefined
      };
    }
    const liveExpected = auditSummary.expectedEnrollmentMrr;
    const reportExpected = mrrCompareFromLatestReport?.expectedEnrollmentMrr;
    const expected = liveExpected != null ? liveExpected : reportExpected != null ? reportExpected : auditSummary.dbMrrTotal;
    const liveDeferredGroups = auditSummary.futureGroupDeferredMrr;
    const reportDeferredGroups = mrrCompareFromLatestReport?.futureGroupDeferredMrr;
    const deferredFutureGroups = liveDeferredGroups != null ? liveDeferredGroups : reportDeferredGroups ?? null;
    const liveDime = auditSummary.dimeApiActiveMrr;
    const reportDime = mrrCompareFromLatestReport?.dimeApiActiveMrr;
    const fromReport = liveDime == null && reportDime != null && mrrCompareFromLatestReport?.ok;
    const dime = liveDime != null ? liveDime : fromReport ? reportDime : null;
    let diff: number | null = null;
    if (liveDime != null && auditSummary.mrrExpectedMinusDimeApi != null) {
      diff = auditSummary.mrrExpectedMinusDimeApi;
    } else if (dime != null) {
      diff = Math.round((expected - dime) * 100) / 100;
    } else if (mrrCompareFromLatestReport?.mrrExpectedMinusDimeApi != null) {
      diff = mrrCompareFromLatestReport.mrrExpectedMinusDimeApi;
    } else if (mrrCompareFromLatestReport?.mrrDbMinusDimeApi != null) {
      diff = mrrCompareFromLatestReport.mrrDbMinusDimeApi;
    }
    const metaForFooters =
      liveDime != null ? auditSummary.dimeApiMrrMeta : mrrCompareFromLatestReport?.dimeApiMrrMeta ?? auditSummary.dimeApiMrrMeta;
    return { expected, dime, diff, deferredFutureGroups, fromSavedAuditRun: !!fromReport, metaForFooters };
  }, [auditSummary, mrrCompareFromLatestReport]);

  const mrrDateLabel = useMemo(() => {
    const c = auditSummary?.mrrDateContext;
    if (!c) return null;
    const fmtDate = (v?: string | null) => formatCalendarDate(v);
    const fmtDateTime = (v?: string | null) => {
      if (!v) return '—';
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? v : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    };
    return {
      dbRange: `${fmtDate(c.dbNextBillingDateMin)} - ${fmtDate(c.dbNextBillingDateMax)}`,
      dimeRange: `${fmtDate(c.dimeNextRunDateMin)} - ${fmtDate(c.dimeNextRunDateMax)}`,
      snapshotAt: fmtDateTime(c.snapshotAt || auditSummary?.generatedAt || null),
      dbCount: Number(c.dbActiveScheduleCount || 0),
      expectedAsOfDate: fmtDate(c.expectedAsOfDate || null),
      deferredFutureGroupMrr: Number(c.futureGroupDeferredMrr || 0),
      deferredFutureGroupCount: Number(c.futureGroupDeferredEnrollmentCount || 0)
    };
  }, [auditSummary]);

  const unresolvedFailedModalPayments = useMemo(() => {
    if (!unresolvedFailedModalBucketKey) return [];
    return unresolvedFailedDetailRows.filter(
      (r) => String(r.bucketKey ?? '') === unresolvedFailedModalBucketKey
    );
  }, [unresolvedFailedDetailRows, unresolvedFailedModalBucketKey]);

  useEffect(() => {
    if (!isSysAdmin) return;
    setTenantsLoading(true);
    apiService
      .get<{ success: boolean; data?: Array<{ TenantId: string; Name: string }> }>('/api/tenants?lightweight=true')
      .then((res) => {
        if (res.success && res.data) {
          setTenantOptions(
            res.data.map((t) => ({ id: t.TenantId, label: t.Name, value: t.TenantId }))
          );
          if (res.data.length === 1 && !tenantId) setTenantId(res.data[0].TenantId);
        }
      })
      .finally(() => setTenantsLoading(false));
  }, [isSysAdmin]);

  const loadOverview = useCallback(() => {
    if (!currentRole) return;
    if (isSysAdmin && !effectiveTenantId) return;
    setOverviewLoading(true);
    setOverviewError(null);
    const { startDate, endDate } = getMonthRange(revenueYear, revenueMonth);
    Promise.all([
      billingService.getRevenue(currentRole, startDate, endDate, isSysAdmin ? effectiveTenantId : undefined),
      billingService.getProjection(currentRole, isSysAdmin ? effectiveTenantId : undefined),
      billingService.getAuditSummary(currentRole, isSysAdmin ? effectiveTenantId : undefined)
    ])
      .then(([revRes, projRes, auditRes]) => {
        if (revRes.success && revRes.data) setRevenue(revRes.data);
        else setRevenue(null);
        if (projRes.success && projRes.data) setProjection(projRes.data);
        else setProjection(null);
        if (auditRes.success && auditRes.data) setAuditSummary(auditRes.data);
        else setAuditSummary(null);
        if (!revRes.success) setOverviewError(revRes.message || 'Failed to load revenue');
        if (!projRes.success) setOverviewError(projRes.message || 'Failed to load projection');
      })
      .catch((err) => {
        setOverviewError(err?.message || 'Failed to load overview');
        setRevenue(null);
        setProjection(null);
        setAuditSummary(null);
      })
      .finally(() => setOverviewLoading(false));
  }, [currentRole, isSysAdmin, effectiveTenantId, revenueYear, revenueMonth]);

  useEffect(() => {
    if (activeTab !== 'overview') return;
    loadOverview();
  }, [activeTab, loadOverview]);

  const loadFilterOptions = useCallback(() => {
    if (!currentRole || (isSysAdmin && !effectiveTenantId)) return;
    setFilterOptionsLoading(true);
    billingService
      .getFilterOptions(currentRole, isSysAdmin ? effectiveTenantId : undefined)
      .then((res) => {
        if (res.success && res.data) setFilterOptions(res.data);
        else setFilterOptions(null);
      })
      .finally(() => setFilterOptionsLoading(false));
  }, [currentRole, isSysAdmin, effectiveTenantId]);

  const getTransactionsDateRange = useCallback((): { startDate?: string; endDate?: string } => {
    if (transactionsStartDate && transactionsEndDate) {
      return { startDate: transactionsStartDate, endDate: transactionsEndDate };
    }
    return {};
  }, [transactionsStartDate, transactionsEndDate]);

  const loadPayments = useCallback(
    (
      override?: {
        page?: number;
        startDate?: string;
        endDate?: string;
        status?: string;
        groupId?: string;
        memberId?: string;
        agentId?: string;
        agencyId?: string;
        commissionPaid?: '' | 'paid' | 'unpaid';
      }
    ) => {
      if (!currentRole) return;
      if (isSysAdmin && !effectiveTenantId) return;
      setPaymentsLoading(true);
      setPaymentsError(null);
      const range =
        override?.startDate != null && override?.endDate != null
          ? { startDate: override.startDate, endDate: override.endDate }
          : getTransactionsDateRange();
      const { startDate, endDate } = range;
      const page = override?.page ?? paymentsPage;
      const unresolvedFailedOnly = statusFilter === PAYMENT_STATUS_UNRESOLVED_FAILED;
      const noLinkedInvoice =
        !unresolvedFailedOnly && noLinkedInvoiceOnly ? true : undefined;
      const status =
        override?.status !== undefined
          ? override.status || undefined
          : unresolvedFailedOnly
            ? undefined
            : statusFilter || undefined;
      const groupId = override?.groupId !== undefined ? override.groupId || undefined : groupIdFilter || undefined;
      const memberId = override?.memberId !== undefined ? override.memberId || undefined : memberIdFilter || undefined;
      const agentId = override?.agentId !== undefined ? override.agentId || undefined : agentIdFilter || undefined;
      const agencyId = override?.agencyId !== undefined ? override.agencyId || undefined : agencyIdFilter || undefined;
      const commissionPaidRaw =
        override?.commissionPaid !== undefined ? override.commissionPaid : commissionPaidFilter;
      const commissionPaid =
        commissionPaidRaw === 'paid' || commissionPaidRaw === 'unpaid' ? commissionPaidRaw : undefined;
      billingService
        .getPayments(
          currentRole,
          {
            status,
            unresolvedFailedOnly: unresolvedFailedOnly ? true : undefined,
            noLinkedInvoice,
            groupId,
            memberId,
            agentId,
            agencyId,
            commissionPaid,
            startDate,
            endDate,
            page,
            limit: paymentsLimit
          },
          isSysAdmin ? effectiveTenantId : undefined
        )
      .then((res) => {
        if (res.success && Array.isArray(res.data)) {
          setPayments(res.data);
          setPaymentsTotal(typeof res.total === 'number' ? res.total : res.data.length);
          if (res.summary) {
            setPaymentsSummary(res.summary);
          } else {
            setPaymentsSummary(null);
          }
        } else {
          setPayments([]);
          setPaymentsTotal(0);
          setPaymentsSummary(null);
          setPaymentsError(res.message || 'Failed to load payments');
        }
      })
      .catch((err) => {
        setPayments([]);
        setPaymentsTotal(0);
        setPaymentsSummary(null);
        setPaymentsError(err?.message || 'Failed to load payments');
      })
      .finally(() => setPaymentsLoading(false));
    },
    [
      currentRole,
      isSysAdmin,
      effectiveTenantId,
      statusFilter,
      groupIdFilter,
      memberIdFilter,
      agentIdFilter,
      agencyIdFilter,
      commissionPaidFilter,
      noLinkedInvoiceOnly,
      getTransactionsDateRange,
      paymentsPage,
      paymentsLimit
    ]
  );

  const resetTransactionsFilters = useCallback(() => {
    const r = getDefaultTransactionsDateRange();
    setTransactionsStartDate(r.startDate);
    setTransactionsEndDate(r.endDate);
    setStatusFilter('');
    setGroupIdFilter('');
    setMemberIdFilter('');
    setAgentIdFilter('');
    setAgencyIdFilter('');
    setCommissionPaidFilter('');
    setNoLinkedInvoiceOnly(false);
    setPaymentsPage(1);
  }, []);

  const loadRecurringPayments = useCallback(() => {
    if (!currentRole) return;
    if (isSysAdmin && !effectiveTenantId) return;
    setRecurringLoading(true);
    setRecurringError(null);
    billingService
      .getRecurringPayments(
        currentRole,
        {
          agentId: recurringAgentId || undefined,
          groupId: recurringGroupId || undefined,
          memberType: recurringMemberType
        },
        isSysAdmin ? effectiveTenantId : undefined
      )
      .then((res) => {
        if (res.success && Array.isArray(res.data)) setRecurringList(res.data);
        else setRecurringList([]);
        if (!res.success) setRecurringError(res.message || 'Failed to load recurring payments');
      })
      .catch((err) => {
        setRecurringList([]);
        setRecurringError(err?.message || 'Failed to load recurring payments');
      })
      .finally(() => setRecurringLoading(false));
  }, [
    currentRole,
    isSysAdmin,
    effectiveTenantId,
    recurringAgentId,
    recurringGroupId,
    recurringMemberType
  ]);

  const loadWebhookIntegrationErrors = useCallback(() => {
    if (!currentRole) return;
    if (isSysAdmin && !effectiveTenantId) return;
    setWebhookErrorsLoading(true);
    setWebhookErrorsError(null);
    billingService
      .getPaymentWebhookIntegrationErrors(
        currentRole,
        {
          limit: webhookErrorsLimit,
          startDate: webhookErrorsStart.trim() || undefined,
          endDate: webhookErrorsEnd.trim() || undefined,
          resolutionStatus: webhookErrorsResolutionStatus
        },
        isSysAdmin ? effectiveTenantId : undefined
      )
      .then((res) => {
        if (res.success && Array.isArray(res.data)) setWebhookErrors(res.data);
        else setWebhookErrors([]);
        if (!res.success) setWebhookErrorsError(res.message || 'Failed to load webhook errors');
      })
      .catch((err) => {
        setWebhookErrors([]);
        setWebhookErrorsError(err?.message || 'Failed to load webhook errors');
      })
      .finally(() => setWebhookErrorsLoading(false));
  }, [
    currentRole,
    isSysAdmin,
    effectiveTenantId,
    webhookErrorsLimit,
    webhookErrorsStart,
    webhookErrorsEnd,
    webhookErrorsResolutionStatus
  ]);

  const toggleWebhookErrorResolved = useCallback(
    async (row: BillingPaymentWebhookErrorRow, resolved: boolean) => {
      if (!currentRole) return;
      const id = row.integrationErrorId;
      setWebhookResolveLoadingById((prev) => ({ ...prev, [id]: true }));
      try {
        const res = await billingService.setPaymentWebhookIntegrationErrorResolved(
          currentRole,
          id,
          resolved,
          isSysAdmin ? effectiveTenantId : undefined
        );
        if (!res.success) {
          toast.error(res.message || 'Failed to update webhook error status');
          return;
        }
        setWebhookErrors((prev) => {
          // If current view only shows unresolved/resolved, remove row after status change.
          if (
            (webhookErrorsResolutionStatus === 'unresolved' && resolved) ||
            (webhookErrorsResolutionStatus === 'resolved' && !resolved)
          ) {
            return prev.filter((r) => r.integrationErrorId !== id);
          }
          return prev.map((r) =>
            r.integrationErrorId === id
              ? {
                  ...r,
                  resolved,
                  resolvedAt: resolved ? new Date().toISOString() : null
                }
              : r
          );
        });
        toast.success(resolved ? 'Marked resolved' : 'Marked unresolved');
      } catch (err) {
        toast.error((err as Error)?.message || 'Failed to update webhook error status');
      } finally {
        setWebhookResolveLoadingById((prev) => ({ ...prev, [id]: false }));
      }
    },
    [currentRole, isSysAdmin, effectiveTenantId, webhookErrorsResolutionStatus]
  );

  const loadEnrollmentWizardPaymentReports = useCallback(() => {
    if (!currentRole) return;
    if (isSysAdmin && !effectiveTenantId) return;
    setWizardPayLoading(true);
    setWizardPayError(null);
    billingService
      .getEnrollmentWizardPaymentReports(
        currentRole,
        {
          limit: wizardPayLimit,
          startDate: wizardPayStart.trim() || undefined,
          endDate: wizardPayEnd.trim() || undefined
        },
        isSysAdmin ? effectiveTenantId : undefined
      )
      .then((res) => {
        if (res.success && Array.isArray(res.data)) setWizardPayErrors(res.data);
        else setWizardPayErrors([]);
        if (!res.success) setWizardPayError(res.message || 'Failed to load enrollment wizard payment errors');
      })
      .catch((err) => {
        setWizardPayErrors([]);
        setWizardPayError(err?.message || 'Failed to load enrollment wizard payment errors');
      })
      .finally(() => setWizardPayLoading(false));
  }, [
    currentRole,
    isSysAdmin,
    effectiveTenantId,
    wizardPayLimit,
    wizardPayStart,
    wizardPayEnd
  ]);

  const loadAuditStrip = useCallback(() => {
    if (!currentRole) return;
    if (isSysAdmin && !effectiveTenantId) return;
    setAuditSummaryLoading(true);
    setLatestReportLoading(true);
    billingService
      .getAuditSummary(currentRole, isSysAdmin ? effectiveTenantId : undefined)
      .then((res) => {
        if (res.success && res.data) setAuditSummary(res.data);
        else setAuditSummary(null);
      })
      .catch(() => setAuditSummary(null))
      .finally(() => setAuditSummaryLoading(false));
    billingService
      .getLatestBillingAuditReport(currentRole, isSysAdmin ? effectiveTenantId : undefined)
      .then((res) => {
        if (res.success) setLatestAuditReport(res.data ?? null);
        else setLatestAuditReport(null);
      })
      .catch(() => setLatestAuditReport(null))
      .finally(() => setLatestReportLoading(false));
  }, [currentRole, isSysAdmin, effectiveTenantId]);

  const openRunAuditsModal = useCallback(() => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 30);
    setRunAuditsStart(start.toISOString().slice(0, 10));
    setRunAuditsEnd(end.toISOString().slice(0, 10));
    setRunAuditsResult(null);
    setRunAuditsOpen(true);
  }, []);

  const executeRunAudits = useCallback(async () => {
    if (!currentRole) return;
    if (isSysAdmin && !effectiveTenantId) return;
    const audits = (Object.keys(runAuditsSelections) as BillingAuditRunId[]).filter((id) => runAuditsSelections[id]);
    if (audits.length === 0) {
      toast.error('Select at least one audit');
      return;
    }
    const dimeCalendar = runAuditsSelections.dime_status && runAuditsDimeScope === 'calendar';
    const dimeHours = runAuditsSelections.dime_status && runAuditsDimeScope === 'hours';
    if (dimeCalendar && (!runAuditsStart || !runAuditsEnd)) {
      toast.error('Choose start and end dates for the Payment status vs DIME audit (calendar mode)');
      return;
    }
    if (dimeHours) {
      const hb = Number(runAuditsHoursBack);
      if (!Number.isFinite(hb) || hb < 1 || hb > 168) {
        toast.error('Hours back must be between 1 and 168 for the DIME status audit');
        return;
      }
    }
    setRunAuditsLoading(true);
    setRunAuditsResult(null);
    try {
      const hoursBackPayload =
        dimeHours ? Math.min(168, Math.max(1, Math.round(Number(runAuditsHoursBack) || 168))) : undefined;
      const res = await billingService.runBillingAudits(
        currentRole,
        {
          audits,
          startDate: runAuditsStart || undefined,
          endDate: runAuditsEnd || undefined,
          ...(hoursBackPayload != null ? { hoursBack: hoursBackPayload } : {}),
          ...(runAuditsSelections.dime_status
            ? {
                prioritizeSuccessfulFirst: true,
                successRecheckDays: Math.min(
                  366,
                  Math.max(0, Math.round(Number(runAuditsSuccessRecheckDays) || 0))
                ),
                secondaryLimit: Math.min(1000, Math.max(0, Math.round(Number(runAuditsSecondaryLimit) || 0)))
              }
            : {}),
          limit: runAuditsLimit,
          dryRun: runAuditsDryRun,
          persistReport: runAuditsPersist
        },
        isSysAdmin ? effectiveTenantId : undefined
      );
      if (res.success && res.data) {
        setRunAuditsResult(res.data);
        loadAuditStrip();
        toast.success(res.report?.reportId ? 'Audits finished; report saved.' : 'Audits finished.');
      } else {
        toast.error(res.message || 'Audit run failed');
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Audit run failed');
    } finally {
      setRunAuditsLoading(false);
    }
  }, [
    currentRole,
    effectiveTenantId,
    isSysAdmin,
    runAuditsSelections,
    runAuditsDimeScope,
    runAuditsHoursBack,
    runAuditsSuccessRecheckDays,
    runAuditsSecondaryLimit,
    runAuditsStart,
    runAuditsEnd,
    runAuditsLimit,
    runAuditsDryRun,
    runAuditsPersist,
    loadAuditStrip
  ]);

  const openMrrAuditModal = useCallback(() => {
    setAuditDrilldownLoading(false);
    setAuditDrilldownModal({ title: 'Enrollment MRR vs DIME Active recurring', mode: 'mrr' });
  }, []);

  const loadMrrReconciliation = useCallback(async () => {
    if (!currentRole) return;
    if (isSysAdmin && !effectiveTenantId) return;
    setMrrReconciliationLoading(true);
    setMrrReconciliationError(null);
    try {
      const res = await billingService.getAuditMrrReconciliation(
        currentRole,
        isSysAdmin ? effectiveTenantId : undefined
      );
      if (res.success && res.data) {
        setMrrReconciliation(res.data);
      } else {
        setMrrReconciliation(null);
        setMrrReconciliationError(res.message || 'Failed to load MRR reconciliation');
      }
    } catch (e: unknown) {
      setMrrReconciliation(null);
      setMrrReconciliationError(e instanceof Error ? e.message : 'Failed to load MRR reconciliation');
    } finally {
      setMrrReconciliationLoading(false);
    }
  }, [currentRole, isSysAdmin, effectiveTenantId]);

  const loadAuditBreakdownData = useCallback(
    async (tab: AuditBreakdownTabId) => {
      if (!currentRole) return;
      if (isSysAdmin && !effectiveTenantId) return;
      if (tab === 'webhooks') {
        loadWebhookIntegrationErrors();
        return;
      }
      if (tab === 'wizard') {
        loadEnrollmentWizardPaymentReports();
        return;
      }
      const drillMap: Record<
        'unresolved_failed' | 'missing_recurring' | 'bad_json' | 'payment_hold' | 'orphan_payments',
        BillingAuditDrilldownType
      > = {
        unresolved_failed: 'unresolved_failed_payments',
        missing_recurring: 'missing_recurring',
        bad_json: 'payment_json_invalid',
        payment_hold: 'payment_hold_enrollments',
        orphan_payments: 'orphan_payments'
      };
      const drillType = drillMap[tab];
      setBreakdownLoading(true);
      setBreakdownError(null);
      try {
        const res = await billingService.getAuditDrilldown(
          currentRole,
          drillType,
          isSysAdmin ? effectiveTenantId : undefined,
          500
        );
        if (res.success && res.data && Array.isArray(res.data.rows)) {
          setBreakdownRows(res.data.rows as Record<string, unknown>[]);
          const data = res.data as { detailRows?: Record<string, unknown>[] };
          if (drillType === 'unresolved_failed_payments' && Array.isArray(data.detailRows)) {
            setUnresolvedFailedDetailRows(data.detailRows);
          } else {
            setUnresolvedFailedDetailRows([]);
          }
        } else {
          setBreakdownRows([]);
          setUnresolvedFailedDetailRows([]);
          setBreakdownError(res.message || 'Failed to load');
        }
      } catch (e: unknown) {
        setBreakdownRows([]);
        setUnresolvedFailedDetailRows([]);
        setBreakdownError(e instanceof Error ? e.message : 'Failed to load');
      } finally {
        setBreakdownLoading(false);
      }
    },
    [currentRole, isSysAdmin, effectiveTenantId, loadWebhookIntegrationErrors, loadEnrollmentWizardPaymentReports]
  );

  useEffect(() => {
    if (!auditSummary || auditSummary.paymentJsonInvalidIncluded !== false) return;
    if (auditBreakdownTab === 'bad_json') setAuditBreakdownTab('webhooks');
  }, [auditSummary, auditBreakdownTab]);

  useEffect(() => {
    if (activeTab === 'transactions' || activeTab === 'recurring') loadFilterOptions();
  }, [activeTab, loadFilterOptions]);

  useEffect(() => {
    if (!auditDrilldownModal || auditDrilldownModal.mode !== 'mrr') return;
    void loadMrrReconciliation();
  }, [auditDrilldownModal, loadMrrReconciliation]);

  useEffect(() => {
    if (activeTab !== 'transactions') return;
    loadPayments();
  }, [activeTab, loadPayments]);

  useEffect(() => {
    if (!processorFeeModalPayment?.paymentId || !currentRole) return;
    setProcessorFeeDetail(null);
    setProcessorFeeDetailLoading(true);
    billingService
      .getProcessorFeeDetail(
        currentRole,
        processorFeeModalPayment.paymentId,
        isSysAdmin ? effectiveTenantId : undefined
      )
      .then((res) => {
        if (res.success && res.data) setProcessorFeeDetail(res.data);
        else setProcessorFeeDetail(null);
      })
      .catch(() => setProcessorFeeDetail(null))
      .finally(() => setProcessorFeeDetailLoading(false));
  }, [processorFeeModalPayment?.paymentId, currentRole, isSysAdmin, effectiveTenantId]);

  useEffect(() => {
    if (activeTab !== 'recurring') return;
    loadRecurringPayments();
  }, [activeTab, loadRecurringPayments]);

  const canLoadData = !isSysAdmin || !!effectiveTenantId;

  const { data: billingDriftSummary, isLoading: billingDriftLoading } = useBillingDrift({
    enabled: canLoadData && activeTab === 'audit',
    limit: 500
  });

  const auditBreakdownFilterObj = useMemo(
    () => ({
      text: auditBreakdownText,
      groupId: auditBreakdownGroupId,
      memberId: auditBreakdownMemberId,
      agentId: auditBreakdownAgentId,
      dateStart: auditBreakdownDateStart,
      dateEnd: auditBreakdownDateEnd,
      amtMin: auditBreakdownAmtMin,
      amtMax: auditBreakdownAmtMax
    }),
    [
      auditBreakdownText,
      auditBreakdownGroupId,
      auditBreakdownMemberId,
      auditBreakdownAgentId,
      auditBreakdownDateStart,
      auditBreakdownDateEnd,
      auditBreakdownAmtMin,
      auditBreakdownAmtMax
    ]
  );

  const filteredBreakdownRows = useMemo(() => {
    if (auditBreakdownTab === 'webhooks' || auditBreakdownTab === 'wizard') return [];
    return breakdownRows.filter((r) => auditRowMatchesFilters(r, auditBreakdownFilterObj));
  }, [auditBreakdownTab, breakdownRows, auditBreakdownFilterObj]);

  const missingRecurringManualEmails = useMemo(() => {
    if (auditBreakdownTab !== 'missing_recurring') return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const row of filteredBreakdownRows) {
      const email = String(getRowField(row, 'memberEmail', 'MemberEmail') ?? '')
        .trim()
        .toLowerCase();
      const rawEmail = String(getRowField(row, 'memberEmail', 'MemberEmail') ?? '').trim();
      if (!rawEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) continue;
      if (seen.has(email)) continue;
      seen.add(email);
      out.push(rawEmail);
    }
    return out;
  }, [auditBreakdownTab, filteredBreakdownRows]);

  const missingRecurringManualPhones = useMemo(() => {
    if (auditBreakdownTab !== 'missing_recurring') return [];
    const seenPhone = new Set<string>();
    const out: string[] = [];
    for (const row of filteredBreakdownRows) {
      const phone = String(getRowField(row, 'memberPhone', 'MemberPhone') ?? '').trim();
      if (!isUsableMemberPhone(phone)) continue;
      const key = digitsOnlyPhone(phone);
      if (seenPhone.has(key)) continue;
      seenPhone.add(key);
      out.push(phone);
    }
    return out;
  }, [auditBreakdownTab, filteredBreakdownRows]);

  const missingRecurringRowsWithoutEmail = useMemo(() => {
    if (auditBreakdownTab !== 'missing_recurring') return 0;
    return filteredBreakdownRows.filter((row) => {
      const raw = String(getRowField(row, 'memberEmail', 'MemberEmail') ?? '').trim();
      return !raw || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw);
    }).length;
  }, [auditBreakdownTab, filteredBreakdownRows]);

  const missingRecurringRowsWithoutPhone = useMemo(() => {
    if (auditBreakdownTab !== 'missing_recurring') return 0;
    return filteredBreakdownRows.filter((row) => {
      const raw = String(getRowField(row, 'memberPhone', 'MemberPhone') ?? '').trim();
      return !isUsableMemberPhone(raw);
    }).length;
  }, [auditBreakdownTab, filteredBreakdownRows]);

  const missingRecurringMemberIds = useMemo(() => {
    if (auditBreakdownTab !== 'missing_recurring') return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const row of filteredBreakdownRows) {
      const id = String(getRowField(row, 'memberId', 'MemberId') ?? '').trim();
      if (!id) continue;
      const key = id.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(id);
    }
    return out;
  }, [auditBreakdownTab, filteredBreakdownRows]);

  useEffect(() => {
    if (!effectiveTenantId || activeTab !== 'audit' || auditBreakdownTab !== 'missing_recurring') return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await billingService.getMemberPortalLoginUrl(
          currentRole,
          isSysAdmin ? effectiveTenantId : undefined
        );
        if (cancelled) return;
        if (res?.success && res.data?.memberPortalLoginUrl) {
          setMemberPortalLoginUrl(res.data.memberPortalLoginUrl);
          setOutreachTenantName(res.data.tenantName ?? null);
          setOutreachSupportEmail(res.data.supportEmail ?? null);
        }
      } catch {
        /* keep default app.allaboard365.com/login */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [effectiveTenantId, activeTab, auditBreakdownTab, currentRole, isSysAdmin]);

  const filteredWebhookRows = useMemo(() => {
    return webhookErrors.filter((r) => auditRowMatchesFilters({ ...r } as Record<string, unknown>, auditBreakdownFilterObj));
  }, [webhookErrors, auditBreakdownFilterObj]);

  const filteredWizardRows = useMemo(() => {
    return wizardPayErrors.filter((r) => auditRowMatchesFilters({ ...r } as Record<string, unknown>, auditBreakdownFilterObj));
  }, [wizardPayErrors, auditBreakdownFilterObj]);

  const groupBreakdownDropdownOptions = useMemo(() => {
    const all = { id: 'all', label: 'All groups', value: '' };
    return [all, ...(filterOptions?.groups.map((g) => ({ id: g.id, label: g.label, value: g.value })) ?? [])];
  }, [filterOptions]);

  const memberBreakdownDropdownOptions = useMemo(() => {
    const all = { id: 'all', label: 'All members', value: '' };
    return [
      all,
      ...(filterOptions?.members.map((m) => ({ id: m.id, label: m.label, value: m.value, email: m.email })) ?? [])
    ];
  }, [filterOptions]);

  const agentBreakdownDropdownOptions = useMemo(() => {
    const all = { id: 'all', label: 'All agents', value: '' };
    return [all, ...(filterOptions?.agents.map((a) => ({ id: a.id, label: a.label, value: a.value, email: a.email })) ?? [])];
  }, [filterOptions]);

  useEffect(() => {
    if (activeTab !== 'audit' || !canLoadData) return;
    loadAuditStrip();
  }, [activeTab, canLoadData, loadAuditStrip]);

  useEffect(() => {
    if (activeTab !== 'audit' || !canLoadData) return;
    void loadAuditBreakdownData(auditBreakdownTab);
  }, [activeTab, auditBreakdownTab, canLoadData, loadAuditBreakdownData]);

  useEffect(() => {
    if (activeTab !== 'audit' || !canLoadData) return;
    loadFilterOptions();
  }, [activeTab, canLoadData, loadFilterOptions]);
  const totalPages = Math.ceil(paymentsTotal / paymentsLimit) || 1;

  const formatDate = (d: string | null | undefined) =>
    d ? formatCalendarDate(d) : '—';
  const formatDateRecurring = (dateString: string | null | undefined) => {
    if (!dateString) return '—';
    const dateOnly = String(dateString).split('T')[0];
    const parts = dateOnly.split('-');
    if (parts.length === 3) {
      const y = Number(parts[0]);
      const m = Number(parts[1]) - 1;
      const d = Number(parts[2]);
      if (!Number.isNaN(y) && !Number.isNaN(m) && !Number.isNaN(d)) {
        return new Date(y, m, d).toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' });
      }
    }
    return formatDate(dateString);
  };
  const formatCurrency = (n: number) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Active': return 'bg-green-100 text-green-800';
      case 'Pending': return 'bg-yellow-100 text-yellow-800';
      case 'Terminated': return 'bg-red-100 text-red-800';
      case 'Inactive': return 'bg-gray-100 text-gray-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };
  const getRelationshipIcon = (relationshipType?: string) => {
    switch (relationshipType) {
      case 'P': return <UserCheck className="h-4 w-4 text-blue-600" />;
      case 'S': return <Heart className="h-4 w-4 text-pink-600" />;
      case 'C': return <User className="h-4 w-4 text-gray-600" />;
      default: return <UserCheck className="h-4 w-4 text-blue-600" />;
    }
  };
  const getRelationshipColor = (relationshipType?: string) => {
    switch (relationshipType) {
      case 'P': return 'bg-blue-100 text-blue-800';
      case 'S': return 'bg-pink-100 text-pink-800';
      case 'C': return 'bg-gray-100 text-gray-800';
      default: return 'bg-blue-100 text-blue-800';
    }
  };

  const openMemberManagementModal = useCallback(async (memberId: string, initialTab?: MemberManagementModalTab) => {
    if (!memberId) return;
    setMemberModalInitialTab(initialTab ?? null);
    setMemberModalEnrollmentsLoading(true);
    setSelectedMemberForModal(null);
    setMemberModalHousehold([]);
    setMemberModalEnrollments([]);
    try {
      const householdRes = await apiService.get<{ success: boolean; data: { member: Member; householdMembers: Member[] } }>(
        `/api/members/${memberId}/with-household`
      );
      if (householdRes.success && householdRes.data) {
        setSelectedMemberForModal(householdRes.data.member);
        setMemberModalHousehold(householdRes.data.householdMembers || []);
      }
      const [activeRes, pendingRes] = await Promise.all([
        apiService.get<{ success: boolean; data: Enrollment[] }>(`/api/enrollments?memberId=${memberId}&status=Active`),
        apiService.get<{ success: boolean; data: Enrollment[] }>(`/api/enrollments?memberId=${memberId}&status=Pending`)
      ]);
      const active = activeRes.success ? (activeRes.data || []) : [];
      const pending = pendingRes.success ? (pendingRes.data || []) : [];
      const combined = [...active, ...pending];
      const unique = combined.filter((e: Enrollment, i: number, self: Enrollment[]) =>
        self.findIndex((x) => (x.EnrollmentId || (x as any).enrollmentId) === (e.EnrollmentId || (e as any).enrollmentId)) === i
      );
      setMemberModalEnrollments(unique);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load member');
    } finally {
      setMemberModalEnrollmentsLoading(false);
    }
  }, []);

  const handleTransactionMemberOrGroupClick = useCallback(async (p: BillingPaymentRow) => {
    // Prefer group when both groupId and memberId exist (group payments may include primary member id)
    if (p.groupId) {
      if (currentRole === 'Agent') navigate(`/agent/groups/${p.groupId}`);
      else if (currentRole === 'TenantAdmin') navigate(`/tenant-admin/groups/${p.groupId}`);
      else navigate(`/admin/groups/${p.groupId}`);
    } else if (p.memberId) {
      await openMemberManagementModal(p.memberId);
    }
  }, [currentRole, navigate, openMemberManagementModal]);

  const navigateToGroupForBilling = useCallback(
    (groupId: string) => {
      if (!groupId) return;
      if (currentRole === 'Agent') navigate(`/agent/groups/${groupId}`);
      else if (currentRole === 'TenantAdmin') navigate(`/tenant-admin/groups/${groupId}`);
      else navigate(`/admin/groups/${groupId}`);
    },
    [currentRole, navigate]
  );

  const handleCancelRecurring = async () => {
    if (!scheduleToCancel) return;
    setCancelingSchedule(true);
    try {
      if (scheduleToCancel.context === 'group' && scheduleToCancel.groupId) {
        const result = await GroupsService.cancelScheduledPayment(scheduleToCancel.groupId, scheduleToCancel.scheduleId);
        if (result.success) {
          setScheduleToCancel(null);
          loadRecurringPayments();
          toast.success('Recurring payment canceled');
        } else toast.error(result.message || 'Failed to cancel');
      } else if (scheduleToCancel.context === 'individual' && scheduleToCancel.memberId) {
        const res = await apiService.post<{ success: boolean; message?: string }>('/api/payments/cancel-recurring-schedule', {
          memberId: scheduleToCancel.memberId,
          scheduleId: scheduleToCancel.scheduleId
        });
        if ((res as any)?.success) {
          setScheduleToCancel(null);
          loadRecurringPayments();
          toast.success('Recurring payment canceled');
        } else toast.error((res as any)?.message || 'Failed to cancel');
      } else {
        toast.error('Cannot cancel: missing group or member');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to cancel');
    } finally {
      setCancelingSchedule(false);
    }
  };

  const updateScheduleStatusInDb = async (row: BillingRecurringRow, isActive: boolean) => {
    if (row.context !== 'group' || !row.groupId) return;
    setScheduleForStatusModal(null);
    setUpdatingScheduleStatus(true);
    try {
      const result = await GroupsService.updateScheduledPaymentStatus(row.groupId, row.scheduleId, isActive);
      if (result.success) {
        loadRecurringPayments();
        toast.success('Status updated');
      } else toast.error(result.message || 'Failed to update');
    } finally {
      setUpdatingScheduleStatus(false);
    }
  };

  const openAuditModal = useCallback(async (p: BillingPaymentRow) => {
    if (!currentRole) return;
    setAuditModalPayment(p);
    setAuditConfirmMismatch(false);
    setShowZeroSnapshotsConfirm(false);
    setAuditLoading(true);
    setAuditError(null);
    setAuditData(null);
    setAuditHouseholds(null);
    setAuditHouseholdsError(null);
    setAuditHouseholdsLoading(false);
    setAuditHouseholdEnrollmentsOpenByHouseholdId({});
    setAuditHouseholdEnrollmentsLoadingByHouseholdId({});
    setAuditHouseholdEnrollmentsErrorByHouseholdId({});
    setAuditHouseholdEnrollmentsByHouseholdId({});
    try {
      const res = await billingService.getPaymentAudit(
        currentRole,
        p.paymentId,
        isSysAdmin ? effectiveTenantId : undefined
      );
      if (res.success && res.data) {
        setAuditData(res.data);
      } else {
        setAuditError(res.message || 'Failed to audit payment');
      }
    } catch (err: any) {
      setAuditError(err?.message || 'Failed to audit payment');
    } finally {
      setAuditLoading(false);
    }
  }, [currentRole, isSysAdmin, effectiveTenantId]);

  const toggleAuditHouseholdEnrollments = useCallback(async (householdId: string) => {
    if (!currentRole || !auditModalPayment) return;

    const isOpen = auditHouseholdEnrollmentsOpenByHouseholdId[householdId] === true;
    if (isOpen) {
      setAuditHouseholdEnrollmentsOpenByHouseholdId((prev) => ({ ...prev, [householdId]: false }));
      return;
    }

    setAuditHouseholdEnrollmentsOpenByHouseholdId((prev) => ({ ...prev, [householdId]: true }));

    if (auditHouseholdEnrollmentsByHouseholdId[householdId]) return;

    setAuditHouseholdEnrollmentsLoadingByHouseholdId((prev) => ({ ...prev, [householdId]: true }));
    setAuditHouseholdEnrollmentsErrorByHouseholdId((prev) => ({ ...prev, [householdId]: null }));
    try {
      const res = await billingService.getPaymentHouseholdEnrollments(
        currentRole,
        auditModalPayment.paymentId,
        householdId,
        isSysAdmin ? effectiveTenantId : undefined
      );
      if (res.success && res.data?.enrollments) {
        setAuditHouseholdEnrollmentsByHouseholdId((prev) => ({ ...prev, [householdId]: res.data!.enrollments || [] }));
      } else {
        setAuditHouseholdEnrollmentsErrorByHouseholdId((prev) => ({ ...prev, [householdId]: res.message || 'Failed to load household enrollments' }));
      }
    } catch (err: any) {
      setAuditHouseholdEnrollmentsErrorByHouseholdId((prev) => ({ ...prev, [householdId]: err?.message || 'Failed to load household enrollments' }));
    } finally {
      setAuditHouseholdEnrollmentsLoadingByHouseholdId((prev) => ({ ...prev, [householdId]: false }));
    }
  }, [
    currentRole,
    auditModalPayment,
    isSysAdmin,
    effectiveTenantId,
    auditHouseholdEnrollmentsOpenByHouseholdId,
    auditHouseholdEnrollmentsByHouseholdId
  ]);

  const loadAuditHouseholds = useCallback(async () => {
    if (!currentRole || !auditModalPayment) return;
    setAuditHouseholdsLoading(true);
    setAuditHouseholdsError(null);
    try {
      const res = await billingService.getPaymentHouseholdBreakdown(
        currentRole,
        auditModalPayment.paymentId,
        isSysAdmin ? effectiveTenantId : undefined
      );
      if (res.success && res.data) {
        setAuditHouseholds(res.data);
      } else {
        setAuditHouseholdsError(res.message || 'Failed to load household breakdown');
      }
    } catch (err: any) {
      setAuditHouseholdsError(err?.message || 'Failed to load household breakdown');
    } finally {
      setAuditHouseholdsLoading(false);
    }
  }, [currentRole, auditModalPayment, isSysAdmin, effectiveTenantId]);

  const correctAuditPayment = useCallback(async () => {
    if (!currentRole || !auditModalPayment) return;
    setAuditCorrecting(true);
    setAuditError(null);
    try {
      const res = await billingService.correctPayment(
        currentRole,
        auditModalPayment.paymentId,
        { confirmMismatch: auditConfirmMismatch === true },
        isSysAdmin ? effectiveTenantId : undefined
      );
      if (res.success && res.data) {
        setAuditData(res.data);
        toast.success('Payment values corrected (Amount unchanged)');
        loadPayments();
      } else {
        setAuditError(res.message || 'Failed to correct payment');
        toast.error(res.message || 'Failed to correct payment');
      }
    } catch (err: any) {
      const msg = err?.message || 'Failed to correct payment';
      setAuditError(msg);
      toast.error(msg);
    } finally {
      setAuditCorrecting(false);
    }
  }, [currentRole, auditModalPayment, auditConfirmMismatch, isSysAdmin, effectiveTenantId, loadPayments]);

  const confirmZeroEnrollmentSnapshots = useCallback(async () => {
    if (!currentRole || !auditModalPayment) return;
    setZeroingSnapshots(true);
    setAuditError(null);
    try {
      const res = await billingService.zeroPaymentEnrollmentSnapshots(
        currentRole,
        auditModalPayment.paymentId,
        isSysAdmin ? effectiveTenantId : undefined
      );
      if (res.success) {
        toast.success(`Zeroed NetRate/OverrideRate/Commission and JSON on ${res.data?.updated ?? 0} enrollment(s). PremiumAmount unchanged.`);
        setShowZeroSnapshotsConfirm(false);
        const auditRes = await billingService.getPaymentAudit(
          currentRole,
          auditModalPayment.paymentId,
          isSysAdmin ? effectiveTenantId : undefined
        );
        if (auditRes.success && auditRes.data) setAuditData(auditRes.data);
        loadPayments();
      } else {
        toast.error(res.message || 'Failed to zero payment snapshots');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to zero payment snapshots';
      setAuditError(msg);
      toast.error(msg);
    } finally {
      setZeroingSnapshots(false);
    }
  }, [currentRole, auditModalPayment, isSysAdmin, effectiveTenantId, loadPayments]);

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-lg border border-gray-200">
        {isSysAdmin && (
          <div className="p-6 border-b border-gray-200">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-gray-700">Tenant</label>
              <SearchableDropdown
                options={tenantOptions}
                value={tenantId}
                onChange={(value) => setTenantId(value || '')}
                placeholder={tenantsLoading ? 'Loading tenants...' : 'Select tenant'}
                disabled={tenantsLoading}
                className="min-w-[200px]"
              />
            </div>
          </div>
        )}

        <div className="px-6 pt-4 border-b border-gray-200">
          <nav className="flex space-x-0">
            <button
              type="button"
              className={`flex-1 px-6 py-4 text-center border-b-2 font-medium text-sm transition-all duration-200 ${
                activeTab === 'overview'
                  ? 'border-oe-primary text-gray-900 font-semibold bg-blue-50/80'
                  : 'border-transparent text-gray-700 hover:text-gray-900 hover:border-gray-300'
              }`}
              style={
                activeTab === 'overview'
                  ? { borderBottomColor: 'var(--oe-primary, #2563EB)', borderBottomWidth: '3px' }
                  : {}
              }
              onClick={() => setActiveTab('overview')}
            >
              <span className="font-semibold text-gray-900">Overview</span>
            </button>
            <button
              type="button"
              className={`flex-1 px-6 py-4 text-center border-b-2 font-medium text-sm transition-all duration-200 ${
                activeTab === 'transactions'
                  ? 'border-oe-primary text-gray-900 font-semibold bg-blue-50/80'
                  : 'border-transparent text-gray-700 hover:text-gray-900 hover:border-gray-300'
              }`}
              style={
                activeTab === 'transactions'
                  ? { borderBottomColor: 'var(--oe-primary, #2563EB)', borderBottomWidth: '3px' }
                  : {}
              }
              onClick={() => setActiveTab('transactions')}
            >
              <span className="font-semibold text-gray-900">Transactions</span>
            </button>
            <button
              type="button"
              className={`flex-1 px-6 py-4 text-center border-b-2 font-medium text-sm transition-all duration-200 ${
                activeTab === 'recurring'
                  ? 'border-oe-primary text-gray-900 font-semibold bg-blue-50/80'
                  : 'border-transparent text-gray-700 hover:text-gray-900 hover:border-gray-300'
              }`}
              style={
                activeTab === 'recurring'
                  ? { borderBottomColor: 'var(--oe-primary, #2563EB)', borderBottomWidth: '3px' }
                  : {}
              }
              onClick={() => setActiveTab('recurring')}
            >
              <span className="font-semibold text-gray-900">Recurring payments</span>
            </button>
            <button
              type="button"
              className={`flex-1 px-6 py-4 text-center border-b-2 font-medium text-sm transition-all duration-200 ${
                activeTab === 'invoices'
                  ? 'border-oe-primary text-gray-900 font-semibold bg-blue-50/80'
                  : 'border-transparent text-gray-700 hover:text-gray-900 hover:border-gray-300'
              }`}
              style={
                activeTab === 'invoices'
                  ? { borderBottomColor: 'var(--oe-primary, #2563EB)', borderBottomWidth: '3px' }
                  : {}
              }
              onClick={() => setActiveTab('invoices')}
            >
              <span className="font-semibold text-gray-900">Invoices</span>
            </button>
            <button
              type="button"
              className={`flex-1 px-6 py-4 text-center border-b-2 font-medium text-sm transition-all duration-200 ${
                activeTab === 'credits'
                  ? 'border-oe-primary text-gray-900 font-semibold bg-blue-50/80'
                  : 'border-transparent text-gray-700 hover:text-gray-900 hover:border-gray-300'
              }`}
              style={
                activeTab === 'credits'
                  ? { borderBottomColor: 'var(--oe-primary, #2563EB)', borderBottomWidth: '3px' }
                  : {}
              }
              onClick={() => setActiveTab('credits')}
            >
              <span className="font-semibold text-gray-900">Credits</span>
            </button>
            <button
              type="button"
              className={`flex-1 px-6 py-4 text-center border-b-2 font-medium text-sm transition-all duration-200 ${
                activeTab === 'audit'
                  ? 'border-oe-primary text-gray-900 font-semibold bg-blue-50/80'
                  : 'border-transparent text-gray-700 hover:text-gray-900 hover:border-gray-300'
              }`}
              style={
                activeTab === 'audit'
                  ? { borderBottomColor: 'var(--oe-primary, #2563EB)', borderBottomWidth: '3px' }
                  : {}
              }
              onClick={() => setActiveTab('audit')}
            >
              <span className="inline-flex items-center justify-center gap-2 font-semibold text-gray-900">
                <FileSearch className="h-4 w-4" />
                Audit
              </span>
            </button>
          </nav>
        </div>

        <div className="p-6">
          {activeTab === 'overview' && (
            <>
              {!canLoadData && (
                <div className="rounded-lg bg-yellow-50 border border-yellow-200 text-yellow-800 p-4 flex items-center gap-2">
                  <AlertCircle className="h-5 w-5 flex-shrink-0" />
                  <span>Select a tenant to view billing overview.</span>
                </div>
              )}
              {canLoadData && (
                <>
                  <div className="flex flex-wrap items-center gap-4 mb-6">
                    <div className="flex items-center gap-2">
                      <Calendar className="h-5 w-5 text-gray-500" />
                      <span className="text-sm font-medium text-gray-700">Period</span>
                    </div>
                    <select
                      value={revenueMonth}
                      onChange={(e) => setRevenueMonth(Number(e.target.value))}
                      className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                    >
                      {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => (
                        <option key={m} value={m}>
                          {new Date(2000, m - 1, 1).toLocaleString('default', { month: 'long' })}
                        </option>
                      ))}
                    </select>
                    <select
                      value={revenueYear}
                      onChange={(e) => setRevenueYear(Number(e.target.value))}
                      className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                    >
                      {[new Date().getFullYear(), new Date().getFullYear() - 1, new Date().getFullYear() - 2].map((y) => (
                        <option key={y} value={y}>{y}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={loadOverview}
                      disabled={overviewLoading}
                      className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50 text-sm"
                    >
                      {overviewLoading ? 'Loading...' : 'Apply'}
                    </button>
                  </div>
                  {overviewError && (
                    <div className="rounded-lg bg-red-50 border border-red-200 text-red-800 p-4 flex items-center gap-2 mb-4">
                      <AlertCircle className="h-5 w-5 flex-shrink-0" />
                      <span>{overviewError}</span>
                    </div>
                  )}
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    <div className="bg-white rounded-lg border border-gray-200 p-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium text-gray-600">Revenue (period)</p>
                          <p className="text-2xl font-bold text-gray-900 mt-1">
                            {overviewLoading ? '—' : formatCurrency(revenue?.totalRevenue ?? 0)}
                          </p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            {overviewLoading ? '—' : `${revenue?.paymentCount ?? 0} payments`}
                          </p>
                        </div>
                        <DollarSign className="h-8 w-8 text-green-600" />
                      </div>
                    </div>
                    <div className="bg-white rounded-lg border border-gray-200 p-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium text-gray-600">Next month (projected)</p>
                          <p className="text-2xl font-bold text-gray-900 mt-1">
                            {overviewLoading ? '—' : formatCurrency(projection?.projectedRevenue ?? 0)}
                          </p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            {overviewLoading ? '—' : `${projection?.enrollmentCount ?? 0} enrollments`}
                          </p>
                        </div>
                        <TrendingUp className="h-8 w-8 text-blue-600" />
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setActiveTab('transactions');
                        setStatusFilter(PAYMENT_STATUS_UNRESOLVED_FAILED);
                        setPaymentsPage(1);
                      }}
                      className={`text-left bg-white rounded-lg border p-4 transition-colors ${
                        auditSummary && auditSummary.unresolvedFailedPayments > 0
                          ? 'border-red-300 bg-red-50 ring-1 ring-red-200 hover:bg-red-100/90'
                          : 'border-gray-200 hover:bg-gray-50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 text-gray-500 text-xs font-medium uppercase tracking-wide">
                            <AlertTriangle
                              className={`h-4 w-4 flex-shrink-0 ${
                                auditSummary && auditSummary.unresolvedFailedPayments > 0 ? 'text-red-600' : 'text-amber-600'
                              }`}
                            />
                            Unresolved failed payments
                          </div>
                          <p
                            className={`mt-2 text-2xl font-bold tabular-nums ${
                              auditSummary && auditSummary.unresolvedFailedPayments > 0 ? 'text-red-800' : 'text-gray-900'
                            }`}
                          >
                            {overviewLoading ? '—' : auditSummary?.unresolvedFailedPayments ?? '—'}
                          </p>
                          <p
                            className={`mt-0.5 text-sm font-semibold tabular-nums ${
                              auditSummary && auditSummary.unresolvedFailedPayments > 0 ? 'text-red-900' : 'text-gray-600'
                            }`}
                          >
                            {overviewLoading
                              ? '—'
                              : `${formatCurrency(Number(auditSummary?.unresolvedFailedPaymentsAmount ?? 0))} total`}
                          </p>
                          <p className="mt-1 text-xs text-gray-500">Unique groups / households · open in Transactions</p>
                        </div>
                        <XCircle className="h-8 w-8 text-red-600 flex-shrink-0 opacity-90" />
                      </div>
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {activeTab === 'transactions' && (
            <>
              {!canLoadData && (
                <div className="rounded-lg bg-yellow-50 border border-yellow-200 text-yellow-800 p-4 flex items-center gap-2">
                  <AlertCircle className="h-5 w-5 flex-shrink-0" />
                  <span>Select a tenant to view transactions.</span>
                </div>
              )}
              {canLoadData && (
                <>
                  <div className="flex flex-wrap items-center gap-3 mb-4">
                    <Filter className="h-5 w-5 text-gray-500" />
                    <input
                      type="date"
                      value={transactionsStartDate}
                      onChange={(e) => setTransactionsStartDate(e.target.value)}
                      className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                      aria-label="Start date"
                    />
                    <span className="text-gray-500">to</span>
                    <input
                      type="date"
                      value={transactionsEndDate}
                      onChange={(e) => setTransactionsEndDate(e.target.value)}
                      className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                      aria-label="End date"
                    />
                    <select
                      value={statusFilter}
                      onChange={(e) => {
                        const v = e.target.value;
                        setStatusFilter(v);
                        if (v === PAYMENT_STATUS_UNRESOLVED_FAILED) setNoLinkedInvoiceOnly(false);
                      }}
                      className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                    >
                      {PAYMENT_STATUSES.map((s) => (
                        <option key={s.value || 'all'} value={s.value}>{s.label}</option>
                      ))}
                    </select>
                    {filterOptions && (
                      <>
                        <SearchableDropdown
                          options={filterOptions.groups}
                          value={groupIdFilter}
                          onChange={(v) => setGroupIdFilter(v || '')}
                          placeholder="Group"
                          className="min-w-[160px]"
                        />
                        <SearchableDropdown
                          options={filterOptions.members}
                          value={memberIdFilter}
                          onChange={(v) => setMemberIdFilter(v || '')}
                          placeholder="Member"
                          className="min-w-[160px]"
                          showEmail
                        />
                        <SearchableDropdown
                          options={filterOptions.agents}
                          value={agentIdFilter}
                          onChange={(v) => setAgentIdFilter(v || '')}
                          placeholder="Agent"
                          className="min-w-[160px]"
                          showEmail
                        />
                        <SearchableDropdown
                          options={filterOptions.agencies}
                          value={agencyIdFilter}
                          onChange={(v) => setAgencyIdFilter(v || '')}
                          placeholder="Agency"
                          className="min-w-[160px]"
                        />
                      </>
                    )}
                    <select
                      value={commissionPaidFilter}
                      onChange={(e) =>
                        setCommissionPaidFilter(e.target.value as '' | 'paid' | 'unpaid')
                      }
                      className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                      title="Filter by commission-paid status"
                    >
                      <option value="">Commission: All</option>
                      <option value="paid">Commission paid</option>
                      <option value="unpaid">Commission not paid</option>
                    </select>
                    <label className="inline-flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={noLinkedInvoiceOnly}
                        disabled={statusFilter === PAYMENT_STATUS_UNRESOLVED_FAILED}
                        onChange={(e) => {
                          const on = e.target.checked;
                          setNoLinkedInvoiceOnly(on);
                          if (on && statusFilter === PAYMENT_STATUS_UNRESOLVED_FAILED) setStatusFilter('');
                        }}
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      No linked invoice
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setPaymentsPage(1);
                        loadPayments({ page: 1 });
                      }}
                      disabled={paymentsLoading || filterOptionsLoading}
                      className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 text-sm"
                    >
                      {paymentsLoading ? 'Loading...' : 'Apply'}
                    </button>
                    <button
                      type="button"
                      onClick={resetTransactionsFilters}
                      disabled={paymentsLoading || filterOptionsLoading}
                      className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50 text-sm"
                    >
                      Reset
                    </button>
                  </div>
                  {statusFilter === PAYMENT_STATUS_UNRESOLVED_FAILED && (
                    <p className="text-sm text-gray-600 mb-4">
                      Showing unresolved failed payments (all time), same rules as the Audit tab. Date range does not apply.
                    </p>
                  )}
                  {noLinkedInvoiceOnly && statusFilter !== PAYMENT_STATUS_UNRESOLVED_FAILED && (
                    <p className="text-sm text-gray-600 mb-4">
                      Showing payments with no linked invoice (<code className="text-xs bg-gray-100 px-1 rounded">InvoiceId</code> is
                      null). Refunded rows are hidden unless you choose Status → Refunded. RecurringScheduled placeholders are always
                      excluded (same as the main list). Date range and other filters apply.
                    </p>
                  )}
                  <div className="mb-4">
                    {paymentsLoading ? (
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        {[0, 1, 2].map((k) => (
                          <div key={k} className="bg-white rounded-lg border border-gray-200 p-4 animate-pulse">
                            <div className="h-4 bg-gray-200 rounded w-24 mb-2" />
                            <div className="h-8 bg-gray-200 rounded w-32" />
                          </div>
                        ))}
                      </div>
                    ) : paymentsSummary ? (
                      <>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                          <div className="bg-white rounded-lg border border-gray-200 p-4">
                            <div className="flex items-center justify-between">
                              <div>
                                <p className="text-sm font-medium text-gray-600">Unresolved failed</p>
                                <p className="text-2xl font-bold text-red-700 mt-1">{formatCurrency(paymentsSummary.failedAmount)}</p>
                                <p className="text-xs text-gray-500 mt-1">
                                  Tenant-wide unresolved (matches Overview). Returned $ adds for the period and entity
                                  filters below, not the status dropdown.
                                </p>
                              </div>
                              <XCircle className="h-8 w-8 text-red-600" />
                            </div>
                          </div>
                          <div className="bg-white rounded-lg border border-gray-200 p-4">
                            <div className="flex items-center justify-between">
                              <div>
                                <p className="text-sm font-medium text-gray-600">Pending</p>
                                <p className="text-2xl font-bold text-yellow-700 mt-1">{formatCurrency(paymentsSummary.pendingAmount)}</p>
                              </div>
                              <Clock className="h-8 w-8 text-yellow-600" />
                            </div>
                          </div>
                          <div className="bg-white rounded-lg border border-gray-200 p-4">
                            <div className="flex items-center justify-between">
                              <div>
                                <p className="text-sm font-medium text-gray-600">Completed / other</p>
                                <p className="text-2xl font-bold text-green-700 mt-1">{formatCurrency(paymentsSummary.completedAmount)}</p>
                              </div>
                              <CheckCircle className="h-8 w-8 text-green-600" />
                            </div>
                          </div>
                        </div>
                        <p className="text-xs text-gray-500 mt-2">
                          Pending and Completed use the date range and group/member/agent/agency filters only — not the
                          status dropdown.
                        </p>
                      </>
                    ) : null}
                  </div>
                  {paymentsError && (
                    <div className="rounded-lg bg-red-50 border border-red-200 text-red-800 p-4 flex items-center gap-2 mb-4">
                      <AlertCircle className="h-5 w-5 flex-shrink-0" />
                      <span>{paymentsError}</span>
                    </div>
                  )}
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Date</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Member / Group</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Agent</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Agency</th>
                          <th className="px-4 py-2 text-right text-xs font-medium text-gray-700 uppercase">Processor fee</th>
                          <th className="px-4 py-2 text-right text-xs font-medium text-gray-700 uppercase">Amount</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Status</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Method</th>
                          <th className="px-4 py-2 text-right text-xs font-medium text-gray-700 uppercase">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {paymentsLoading ? (
                          <tr>
                            <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
                              Loading...
                            </td>
                          </tr>
                        ) : payments.length === 0 ? (
                          <tr>
                            <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
                              No payments found.
                            </td>
                          </tr>
                        ) : (
                          payments.map((p) => {
                            const isGroup = !!p.groupId;
                            const isMember = !!p.memberId;
                            const displayName = isGroup ? (p.groupName ?? '—') : (p.memberName ?? '—');
                            const canClick = (isMember || isGroup) && (p.memberId || p.groupId);
                            return (
                              <tr key={p.paymentId} className="hover:bg-gray-50">
                                <td className="px-4 py-2 text-sm text-gray-900 whitespace-nowrap">
                                  {formatDate(p.paymentDate)}
                                </td>
                                <td className="px-4 py-2 text-sm text-gray-900">
                                  {canClick ? (
                                    <button
                                      type="button"
                                      onClick={() => handleTransactionMemberOrGroupClick(p)}
                                      className="inline-flex items-center gap-2 text-left text-blue-600 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-500 rounded"
                                    >
                                      {isMember ? (
                                        <User className="h-4 w-4 flex-shrink-0 text-gray-500" />
                                      ) : (
                                        <Users className="h-4 w-4 flex-shrink-0 text-gray-500" />
                                      )}
                                      <span>{displayName}</span>
                                    </button>
                                  ) : (
                                    <span className="inline-flex items-center gap-2">
                                      {isMember ? <User className="h-4 w-4 flex-shrink-0 text-gray-400" /> : isGroup ? <Users className="h-4 w-4 flex-shrink-0 text-gray-400" /> : null}
                                      {displayName}
                                    </span>
                                  )}
                                </td>
                                <td className="px-4 py-2 text-sm text-gray-900">{p.agentName ?? '—'}</td>
                                <td className="px-4 py-2 text-sm text-gray-900">{p.agencyName ?? '—'}</td>
                                <td className="px-4 py-2 text-sm text-right">
                                  <button
                                    type="button"
                                    onClick={() => setProcessorFeeModalPayment(p)}
                                    className={`inline-flex items-center justify-end w-full text-right font-medium hover:underline focus:outline-none focus:ring-2 focus:ring-blue-500 rounded ${
                                      (() => {
                                        const dime = p.dimeProcessorFee ?? null;
                                        const ours = p.processingFee ?? 0;
                                        if (dime != null && dime > 0) {
                                          if (ours < dime) return 'text-yellow-600 bg-yellow-50';
                                          if (Math.abs(ours - dime) < 0.005) return 'text-blue-600 bg-blue-50';
                                          return 'text-green-600 bg-green-50';
                                        }
                                        return 'text-gray-600';
                                      })()
                                    }`}
                                  >
                                    {(p.processingFee ?? 0) > 0 ? formatCurrency(p.processingFee ?? 0) : '—'}
                                  </button>
                                </td>
                                <td className="px-4 py-2 text-sm text-right font-medium text-gray-900">
                                  {formatCurrency(p.amount)}
                                </td>
                                <td className="px-4 py-2">
                                  <div className="inline-flex items-center gap-1.5">
                                    {p.status === 'Failed' ? (
                                      <FailedPaymentReasonBadge
                                        reasonText={buildFailedPaymentStatusTitle(p.failureReason, p.consecutiveFailureCount, p.attemptNumber)}
                                        className="inline-flex px-2 py-1 text-xs font-semibold rounded-full cursor-pointer bg-red-100 text-red-800 border-0"
                                      >
                                        {formatBillingPaymentStatusLabel(p)}
                                      </FailedPaymentReasonBadge>
                                    ) : (
                                      <span
                                        className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                                          p.status === 'Completed'
                                            ? 'bg-green-100 text-green-800'
                                            : p.status === 'Refunded'
                                              ? 'bg-gray-100 text-gray-700'
                                              : p.status === 'Pending'
                                                ? 'bg-yellow-100 text-yellow-800'
                                                : 'bg-gray-100 text-gray-800'
                                        }`}
                                      >
                                        {formatBillingPaymentStatusLabel(p)}
                                      </span>
                                    )}
                                    {p.commissionPaid && (
                                      <span
                                        title="Commission paid"
                                        aria-label="Commission paid"
                                        className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-green-50 text-green-700 border border-green-200"
                                      >
                                        <CheckCircle className="h-3.5 w-3.5" />
                                      </span>
                                    )}
                                  </div>
                                </td>
                                <td className="px-4 py-2 text-sm text-gray-600">
                                  <span className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full ${paymentMethodBadgeClasses(getPaymentMethodType(p.paymentMethod).type)}`}>
                                    {getPaymentMethodType(p.paymentMethod).label}
                                  </span>
                                </td>
                                <td className="px-4 py-2 text-right">
                                  <div className="inline-flex items-center gap-2">
                                    <button
                                      type="button"
                                      onClick={() => setPaymentDetailModal(p)}
                                      className="inline-flex items-center px-3 py-1.5 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                                    >
                                      <Eye className="h-4 w-4 mr-1.5" />
                                      Details
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                  {paymentsTotal > 0 && (
                    <div className="flex items-center justify-between mt-4">
                      <p className="text-sm text-gray-600">
                        Showing {(paymentsPage - 1) * paymentsLimit + 1}–{Math.min(paymentsPage * paymentsLimit, paymentsTotal)} of {paymentsTotal}
                      </p>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setPaymentsPage((p) => Math.max(1, p - 1))}
                          disabled={paymentsPage <= 1 || paymentsLoading}
                          className="p-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                        >
                          <ChevronLeft className="h-5 w-5" />
                        </button>
                        <span className="text-sm text-gray-700">
                          Page {paymentsPage} of {totalPages}
                        </span>
                        <button
                          type="button"
                          onClick={() => setPaymentsPage((p) => Math.min(totalPages, p + 1))}
                          disabled={paymentsPage >= totalPages || paymentsLoading}
                          className="p-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                        >
                          <ChevronRight className="h-5 w-5" />
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}


          <AdminPaymentDetailsModal
            billingRow={paymentDetailModal}
            open={!!paymentDetailModal}
            onClose={() => setPaymentDetailModal(null)}
            currentRole={currentRole}
            effectiveTenantId={isSysAdmin ? effectiveTenantId : undefined}
            onRetrySuccess={() => loadPayments()}
            onRequestRefund={(row) => setRefundModalPayment(row)}
            onOpenAudit={(row) => void openAuditModal(row)}
          />

          {processorFeeModalPayment && (
            <div className="fixed inset-0 z-50 overflow-y-auto">
              <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20">
                <div className="fixed inset-0 bg-gray-500 bg-opacity-75" onClick={() => setProcessorFeeModalPayment(null)} />
                <div className="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6">
                  <h3 className="text-lg font-semibold text-gray-900">Processor fee</h3>
                  <p className="mt-1 text-sm text-gray-500">
                    {formatDate(processorFeeModalPayment.paymentDate)} · {formatCurrency(processorFeeModalPayment.amount)}
                    {(processorFeeModalPayment.memberName || processorFeeModalPayment.groupName) && (
                      <> · {processorFeeModalPayment.groupName || processorFeeModalPayment.memberName}</>
                    )}
                  </p>
                  <div className="mt-4 space-y-3">
                    {processorFeeDetailLoading ? (
                      <p className="text-sm text-gray-500">Loading...</p>
                    ) : processorFeeDetail ? (
                      <>
                        <div className="flex justify-between text-sm">
                          <span className="text-gray-600">
                            From processor{processorFeeDetail.processorName ? ` (${processorFeeDetail.processorName})` : ''}:
                          </span>
                          <span className="font-medium text-gray-900">
                            {processorFeeDetail.processorFeeComingSoon
                              ? 'Coming soon'
                              : processorFeeDetail.processorFee != null
                                ? formatCurrency(processorFeeDetail.processorFee)
                                : '—'}
                          </span>
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-gray-600">From our system (oe.Enrollments):</span>
                          <span className="font-medium text-gray-900">{formatCurrency(processorFeeDetail.ourProcessingFee)}</span>
                        </div>
                      </>
                    ) : (
                      <p className="text-sm text-gray-500">Could not load fee details.</p>
                    )}
                  </div>
                  <div className="mt-6 flex justify-end">
                    <button
                      type="button"
                      onClick={() => setProcessorFeeModalPayment(null)}
                      className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
                    >
                      Close
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          <RefundPaymentModal
            isOpen={!!refundModalPayment}
            onClose={() => setRefundModalPayment(null)}
            paymentId={refundModalPayment?.paymentId ?? ''}
            amount={refundModalPayment?.amount ?? 0}
            onSuccess={() => {
              loadPayments();
              setRefundModalPayment(null);
            }}
          />


          {auditModalPayment && (
            <div className="fixed inset-0 z-50 overflow-y-auto">
              <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20">
                <div className="fixed inset-0 bg-gray-500 bg-opacity-75" onClick={() => !auditCorrecting && !zeroingSnapshots && setAuditModalPayment(null)} />
                <div className="relative bg-white rounded-lg shadow-xl max-w-4xl w-full p-6">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h3 className="text-lg font-semibold text-gray-900">Payment audit</h3>
                      <p className="mt-1 text-sm text-gray-500">
                        {formatDate(auditModalPayment.paymentDate)} · {formatCurrency(auditModalPayment.amount)}
                        {(auditModalPayment.memberName || auditModalPayment.groupName) && (
                          <> · {auditModalPayment.groupName || auditModalPayment.memberName}</>
                        )}
                      </p>
                      <p className="mt-1 text-xs text-gray-400 font-mono">{auditModalPayment.paymentId}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => !auditCorrecting && !zeroingSnapshots && setAuditModalPayment(null)}
                      className="px-3 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
                    >
                      Close
                    </button>
                  </div>

                  {auditData?.payment && (
                    <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2 text-sm">
                      <div className="font-medium text-gray-900">Processor &amp; DIME</div>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[auto_1fr] sm:gap-x-4 sm:items-start">
                        <span className="text-gray-600">Processor</span>
                        <span className="font-mono text-gray-900 break-all">{auditData.payment.Processor ?? '—'}</span>
                        <span className="text-gray-600">Transaction ID</span>
                        <span className="font-mono text-gray-900 break-all">{auditData.payment.ProcessorTransactionId ?? '—'}</span>
                        <span className="text-gray-600">Payment method (stored)</span>
                        <span className="font-mono text-gray-900 break-all">{auditData.payment.PaymentMethod ?? '—'}</span>
                        <span className="text-gray-600">Recurring schedule</span>
                        <span className="font-mono text-gray-900 break-all">{auditData.payment.RecurringScheduleId ?? '—'}</span>
                      </div>
                    </div>
                  )}

                  <div className="mt-4">
                    {auditLoading ? (
                      <p className="text-sm text-gray-500">Loading audit...</p>
                    ) : auditError ? (
                      <div className="rounded-lg bg-red-50 border border-red-200 text-red-800 p-4 flex items-center gap-2">
                        <AlertCircle className="h-5 w-5 flex-shrink-0" />
                        <span>{auditError}</span>
                      </div>
                    ) : auditData ? (
                      <>
                        {(() => {
                          const storedSum =
                            (auditData.payment.NetRate || 0) +
                            (auditData.payment.OverrideRate || 0) +
                            (auditData.payment.Commission || 0) +
                            (auditData.payment.SystemFees || 0) +
                            (auditData.payment.ProcessingFeeAmount || 0) +
                            (auditData.payment.SetupFee || 0);
                          const computedVsStored = (auditData.totals.computedSum || 0) - storedSum;
                          return (
                            <div className="mb-4 rounded-lg bg-gray-50 border border-gray-200 p-3">
                              <div className="space-y-2 text-sm">
                                <div className="flex items-center justify-between gap-3">
                                  <span className="text-gray-600">Households accounted for</span>
                                  <span className="font-medium text-gray-900">{auditData.identified?.enrolledHouseholdsCount ?? 0}</span>
                                </div>
                                <div className="flex items-center justify-between gap-3">
                                  <span className="text-gray-600">Current Payment Sum</span>
                                  <span className="font-medium text-gray-900">{formatCurrency(storedSum)}</span>
                                </div>
                                <div className="flex items-center justify-between gap-3">
                                  <span className="text-gray-600">Current Enrollments Sum</span>
                                  <span className="font-medium text-gray-900">{formatCurrency(auditData.totals.computedSum)}</span>
                                </div>
                                <div className="flex items-center justify-between gap-3">
                                  <span className="text-gray-600">Difference (Enrollments − Payment)</span>
                                  <span className={`font-medium ${Math.abs(computedVsStored) < 0.005 ? 'text-gray-600' : computedVsStored > 0 ? 'text-green-700' : 'text-red-700'}`}>
                                    {formatCurrency(computedVsStored)}
                                  </span>
                                </div>
                                <div className="flex items-center justify-between gap-3">
                                  <span className="text-gray-600">Payment Amount</span>
                                  <span className="font-medium text-gray-900">{formatCurrency(auditData.totals.amount)}</span>
                                </div>
                                <div className="flex items-center justify-between gap-3">
                                  <span className="text-gray-600">Amount − Calculated</span>
                                  <span className={`font-medium ${auditData.totals.amountDiff === 0 ? 'text-gray-600' : 'text-yellow-700'}`}>
                                    {formatCurrency(auditData.totals.amountDiff)}
                                  </span>
                                </div>
                              </div>
                            </div>
                          );
                        })()}

                        <p className="text-xs text-gray-500 mb-4">
                          <strong>Zero out payment snapshots:</strong> Sets this payment&apos;s NetRate, OverrideRate, Commission, fee buckets, and JSON fields to 0/null on <strong>oe.Payments</strong>. Amount is unchanged. <strong>Only this payment</strong> is updated; no other payments or enrollments are affected.
                        </p>

                        {auditData.totals.amountDiff !== 0 && (
                          <div className="rounded-lg bg-yellow-50 border border-yellow-200 text-yellow-800 p-4 flex items-start gap-2 mb-4">
                            <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
                            <div className="text-sm">
                              <div className="font-medium">Calculated totals do not equal the payment Amount.</div>
                              <div className="mt-1">
                                Amount: <span className="font-medium">{formatCurrency(auditData.totals.amount)}</span> · Calculated sum:{' '}
                                <span className="font-medium">{formatCurrency(auditData.totals.computedSum)}</span> · Difference:{' '}
                                <span className="font-medium">{formatCurrency(auditData.totals.amountDiff)}</span>
                              </div>
                              <label className="mt-3 flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={auditConfirmMismatch}
                                  onChange={(e) => setAuditConfirmMismatch(e.target.checked)}
                                  className="h-4 w-4"
                                />
                                <span>I understand and want to correct bucket values anyway (Amount will not change).</span>
                              </label>
                            </div>
                          </div>
                        )}

                        {(auditData.warnings?.enrollmentPremiumMismatches?.count || 0) > 0 && (
                          <div className="rounded-lg bg-yellow-50 border border-yellow-200 text-yellow-800 p-4 flex items-start gap-2 mb-4">
                            <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
                            <div className="text-sm w-full">
                              <div className="font-medium">
                                Found {auditData.warnings?.enrollmentPremiumMismatches?.count} enrollments where NetRate + OverrideRate + Commission does not equal PremiumAmount.
                              </div>
                              <details className="mt-2">
                                <summary className="cursor-pointer text-sm font-medium text-yellow-900">Show details</summary>
                                <div className="mt-3 overflow-x-auto">
                                  <table className="min-w-full divide-y divide-yellow-200">
                                    <thead className="bg-yellow-50">
                                      <tr>
                                        <th className="px-3 py-2 text-left text-xs font-medium text-yellow-900 uppercase">Product</th>
                                        <th className="px-3 py-2 text-right text-xs font-medium text-yellow-900 uppercase">Premium</th>
                                        <th className="px-3 py-2 text-right text-xs font-medium text-yellow-900 uppercase">Net+Override+Comm</th>
                                        <th className="px-3 py-2 text-right text-xs font-medium text-yellow-900 uppercase">Diff</th>
                                        <th className="px-3 py-2 text-left text-xs font-medium text-yellow-900 uppercase">EnrollmentId</th>
                                      </tr>
                                    </thead>
                                    <tbody className="bg-white divide-y divide-yellow-100">
                                      {(auditData.warnings?.enrollmentPremiumMismatches?.rows || []).slice(0, 50).map((r) => (
                                        <tr key={r.enrollmentId}>
                                          <td className="px-3 py-2 text-sm text-yellow-900">{r.productName ?? r.productId}</td>
                                          <td className="px-3 py-2 text-sm text-right text-yellow-900">{formatCurrency(r.premiumAmount || 0)}</td>
                                          <td className="px-3 py-2 text-sm text-right text-yellow-900">{formatCurrency(r.componentSum || 0)}</td>
                                          <td className="px-3 py-2 text-sm text-right font-medium text-yellow-900">{formatCurrency(r.diff || 0)}</td>
                                          <td className="px-3 py-2 text-xs text-yellow-900 font-mono">{r.enrollmentId}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                  {(auditData.warnings?.enrollmentPremiumMismatches?.count || 0) > 50 && (
                                    <div className="mt-2 text-xs text-yellow-900">
                                      Showing first 50 rows.
                                    </div>
                                  )}
                                </div>
                              </details>
                            </div>
                          </div>
                        )}

                        <div className="overflow-x-auto">
                          <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gray-50">
                              <tr>
                                <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Bucket</th>
                                <th className="px-4 py-2 text-right text-xs font-medium text-gray-700 uppercase">Current</th>
                                <th className="px-4 py-2 text-right text-xs font-medium text-gray-700 uppercase">Calculated</th>
                                <th className="px-4 py-2 text-right text-xs font-medium text-gray-700 uppercase">Diff</th>
                              </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-200">
                              {([
                                ['NetRate', auditData.payment.NetRate, auditData.computed.netRate],
                                ['OverrideRate', auditData.payment.OverrideRate, auditData.computed.overrideRate],
                                ['Commission', auditData.payment.Commission, auditData.computed.commission],
                                ['SystemFees', auditData.payment.SystemFees, auditData.computed.systemFees],
                                ['ProcessingFeeAmount', auditData.payment.ProcessingFeeAmount, auditData.computed.processingFeeAmount],
                                ['SetupFee', auditData.payment.SetupFee, auditData.computed.setupFee]
                              ] as Array<[string, number, number]>).map(([label, stored, computed]) => {
                                const diff = (Number(computed) || 0) - (Number(stored) || 0);
                                return (
                                  <tr key={label}>
                                    <td className="px-4 py-2 text-sm text-gray-900">{label}</td>
                                    <td className="px-4 py-2 text-sm text-right text-gray-900">{formatCurrency(stored || 0)}</td>
                                    <td className="px-4 py-2 text-sm text-right text-gray-900">{formatCurrency(computed || 0)}</td>
                                    <td className="px-4 py-2 text-sm text-right font-medium">
                                      <span className={Math.abs(diff) < 0.005 ? 'text-gray-500' : diff > 0 ? 'text-green-700' : 'text-red-700'}>
                                        {formatCurrency(diff)}
                                      </span>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>

                        <details className="mt-4">
                          <summary className="cursor-pointer text-sm font-medium text-gray-700">Household breakdown</summary>
                          <div className="mt-3">
                            {!auditHouseholds && (
                              <button
                                type="button"
                                onClick={loadAuditHouseholds}
                                disabled={auditHouseholdsLoading}
                                className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50 text-sm"
                              >
                                {auditHouseholdsLoading ? 'Loading...' : 'Load household breakdown'}
                              </button>
                            )}
                            {auditHouseholdsError && (
                              <div className="mt-3 rounded-lg bg-red-50 border border-red-200 text-red-800 p-3 flex items-center gap-2">
                                <AlertCircle className="h-5 w-5 flex-shrink-0" />
                                <span className="text-sm">{auditHouseholdsError}</span>
                              </div>
                            )}
                            {auditHouseholds && auditHouseholds.context === 'group' && (
                              <div className="mt-3">
                                <div className="text-sm text-gray-700 mb-2">
                                  Households: <span className="font-medium text-gray-900">{auditHouseholds.householdsCount}</span>
                                </div>
                                <div className="space-y-3">
                                  {auditHouseholds.households.map((h) => (
                                    <div key={h.householdId} className="bg-white rounded-lg border border-gray-200">
                                      <div className="p-4 border-b border-gray-200">
                                        <div className="flex items-start justify-between gap-4">
                                          <div>
                                            <div className="flex items-center gap-2">
                                              {h.primaryMember?.memberId ? (
                                                <button
                                                  type="button"
                                                  onClick={() => openMemberManagementModal(h.primaryMember?.memberId as string)}
                                                  className="text-sm font-medium text-blue-600 hover:underline focus:outline-none focus:ring-2 focus:ring-blue-500 rounded text-left"
                                                >
                                                  {h.primaryMember?.name || '—'}
                                                </button>
                                              ) : (
                                                <div className="text-sm font-medium text-gray-900">{h.primaryMember?.name || '—'}</div>
                                              )}
                                              {h.flags?.hasCreatedAfterEffective === true && (
                                                <span
                                                  className="text-xs font-bold text-yellow-700"
                                                  title={`${h.flags?.createdAfterEffectiveCount || 0} enrollment(s) created after effective date`}
                                                >
                                                  !
                                                </span>
                                              )}
                                            </div>
                                            <div className="text-xs text-gray-500">{h.primaryMember?.email || ''}</div>
                                          </div>
                                          <div className="text-right">
                                            <div className="text-sm font-medium text-gray-900">
                                              {formatCurrency(
                                                (h.products || []).reduce((sum, p) => sum + (Number(p.premiumAmount) || 0), 0)
                                              )}
                                            </div>
                                            <div className="text-xs text-gray-500 font-mono">{h.householdId}</div>
                                            <div className="mt-2 space-y-1">
                                              <div className="flex items-center justify-end gap-2 text-xs text-gray-700">
                                                <span className="text-gray-500">Processing Fee</span>
                                                <span className="font-medium text-gray-900">{formatCurrency(h.fees?.processingFee?.amount ?? 0)}</span>
                                                <span className="text-gray-500">({h.fees?.processingFee?.count ?? 0})</span>
                                                {(h.fees?.processingFee?.count ?? 0) > 1 && (
                                                  <AlertTriangle className="h-4 w-4 text-yellow-700" title="Multiple processing fee enrollments in this period" />
                                                )}
                                              </div>
                                              <div className="flex items-center justify-end gap-2 text-xs text-gray-700">
                                                <span className="text-gray-500">System Fee</span>
                                                <span className="font-medium text-gray-900">{formatCurrency(h.fees?.systemFee?.amount ?? 0)}</span>
                                                <span className="text-gray-500">({h.fees?.systemFee?.count ?? 0})</span>
                                                {(h.fees?.systemFee?.count ?? 0) > 1 && (
                                                  <AlertTriangle className="h-4 w-4 text-yellow-700" title="Multiple system fee enrollments in this period" />
                                                )}
                                              </div>
                                            </div>
                                            <div className="mt-2">
                                              <button
                                                type="button"
                                                onClick={() => toggleAuditHouseholdEnrollments(h.householdId)}
                                                className="px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 text-xs"
                                              >
                                                {auditHouseholdEnrollmentsOpenByHouseholdId[h.householdId] ? 'Hide enrollments' : 'View enrollments'}
                                              </button>
                                            </div>
                                          </div>
                                        </div>
                                      </div>
                                      <div className="p-4 overflow-x-auto">
                                        <table className="min-w-full divide-y divide-gray-200">
                                          <thead className="bg-gray-50">
                                            <tr>
                                              <th className="px-3 py-2 text-left text-xs font-medium text-gray-700 uppercase">Product</th>
                                              <th className="px-3 py-2 text-right text-xs font-medium text-gray-700 uppercase">Premium</th>
                                              <th className="px-3 py-2 text-right text-xs font-medium text-gray-700 uppercase">Net</th>
                                              <th className="px-3 py-2 text-right text-xs font-medium text-gray-700 uppercase">Override</th>
                                              <th className="px-3 py-2 text-right text-xs font-medium text-gray-700 uppercase">Commission</th>
                                            </tr>
                                          </thead>
                                          <tbody className="bg-white divide-y divide-gray-200">
                                            {h.products.map((pr, idx) => {
                                              const mismatch = Math.abs(Number(pr.diff) || 0) > 0.01;
                                              return (
                                              <tr key={`${h.householdId}-${pr.productId ?? 'unknown'}-${idx}`}>
                                                <td className="px-3 py-2 text-sm text-gray-900">
                                                  {pr.productName ?? pr.productId ?? '—'}
                                                </td>
                                                <td
                                                  className={`px-3 py-2 text-sm text-right ${mismatch ? 'text-red-700 font-medium' : 'text-gray-900'}`}
                                                  title={mismatch ? `Mismatch: premium ${formatCurrency(pr.premiumAmount || 0)} vs components ${formatCurrency(pr.componentSum || 0)} (diff ${formatCurrency(pr.diff || 0)})` : undefined}
                                                >
                                                  {formatCurrency(pr.premiumAmount || 0)}
                                                </td>
                                                <td className="px-3 py-2 text-sm text-right text-gray-900">{formatCurrency(pr.netRate || 0)}</td>
                                                <td className="px-3 py-2 text-sm text-right text-gray-900">{formatCurrency(pr.overrideRate || 0)}</td>
                                                <td className="px-3 py-2 text-sm text-right text-gray-900">{formatCurrency(pr.commission || 0)}</td>
                                              </tr>
                                              );
                                            })}
                                          </tbody>
                                        </table>
                                      </div>

                                      {auditHouseholdEnrollmentsOpenByHouseholdId[h.householdId] && (
                                        <div className="p-4 border-t border-gray-200">
                                          {auditHouseholdEnrollmentsLoadingByHouseholdId[h.householdId] && (
                                            <div className="text-sm text-gray-600">Loading enrollments...</div>
                                          )}
                                          {auditHouseholdEnrollmentsErrorByHouseholdId[h.householdId] && (
                                            <div className="mt-2 rounded-lg bg-red-50 border border-red-200 text-red-800 p-3 flex items-center gap-2">
                                              <AlertCircle className="h-5 w-5 flex-shrink-0" />
                                              <span className="text-sm">{auditHouseholdEnrollmentsErrorByHouseholdId[h.householdId]}</span>
                                            </div>
                                          )}
                                          {!!auditHouseholdEnrollmentsByHouseholdId[h.householdId] && (
                                            <div className="overflow-x-auto">
                                              <table className="min-w-full divide-y divide-gray-200">
                                                <thead className="bg-gray-50">
                                                  <tr>
                                                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-700 uppercase">Member</th>
                                                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-700 uppercase">Type</th>
                                                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-700 uppercase">Product</th>
                                                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-700 uppercase">Effective</th>
                                                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-700 uppercase">Created</th>
                                                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-700 uppercase">Premium</th>
                                                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-700 uppercase">Net</th>
                                                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-700 uppercase">Override</th>
                                                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-700 uppercase">Comm</th>
                                                    <th className="px-3 py-2 text-right text-xs font-medium text-gray-700 uppercase">Diff</th>
                                                    <th className="px-3 py-2 text-left text-xs font-medium text-gray-700 uppercase">EnrollmentId</th>
                                                  </tr>
                                                </thead>
                                                <tbody className="bg-white divide-y divide-gray-200">
                                                  {auditHouseholdEnrollmentsByHouseholdId[h.householdId].map((e) => {
                                                    const createdAfterEffective =
                                                      !!e.createdDate &&
                                                      !!e.effectiveDate &&
                                                      String(e.createdDate).slice(0, 10) > String(e.effectiveDate).slice(0, 10);
                                                    const diff = Number(e.diff) || 0;
                                                    return (
                                                      <tr key={String(e.enrollmentId)}>
                                                        <td className="px-3 py-2 text-sm text-gray-900">
                                                          {e.memberId ? (
                                                            <button
                                                              type="button"
                                                              onClick={() => void openMemberManagementModal(e.memberId)}
                                                              className="font-medium text-left text-blue-600 hover:text-blue-800 hover:underline"
                                                            >
                                                              {e.memberName || '—'}
                                                            </button>
                                                          ) : (
                                                            <div className="font-medium">{e.memberName || '—'}</div>
                                                          )}
                                                          <div className="text-xs text-gray-500">
                                                            {e.relationshipType || ''}{e.memberSequence != null ? ` • #${e.memberSequence}` : ''}
                                                          </div>
                                                        </td>
                                                        <td className="px-3 py-2 text-sm text-gray-900">{e.enrollmentType || 'Product'}</td>
                                                        <td className="px-3 py-2 text-sm text-gray-900">{e.productName || e.productId || '—'}</td>
                                                        <td className="px-3 py-2 text-sm text-gray-900">{formatDate(e.effectiveDate)}</td>
                                                        <td className="px-3 py-2 text-sm text-gray-900">
                                                          <div className="flex items-center gap-2">
                                                            <span>{formatDate(e.createdDate)}</span>
                                                            {createdAfterEffective && (
                                                              <span className="text-xs font-bold text-yellow-700" title="Created after effective date">!</span>
                                                            )}
                                                          </div>
                                                        </td>
                                                        <td className="px-3 py-2 text-sm text-right text-gray-900">{formatCurrency(e.premiumAmount || 0)}</td>
                                                        <td className="px-3 py-2 text-sm text-right text-gray-900">{formatCurrency(e.netRate || 0)}</td>
                                                        <td className="px-3 py-2 text-sm text-right text-gray-900">{formatCurrency(e.overrideRate || 0)}</td>
                                                        <td className="px-3 py-2 text-sm text-right text-gray-900">{formatCurrency(e.commission || 0)}</td>
                                                        <td className={`px-3 py-2 text-sm text-right ${Math.abs(diff) < 0.01 ? 'text-gray-500' : diff > 0 ? 'text-red-700 font-medium' : 'text-green-700 font-medium'}`}>
                                                          {formatCurrency(diff)}
                                                        </td>
                                                        <td className="px-3 py-2 text-xs text-gray-600 font-mono">{String(e.enrollmentId)}</td>
                                                      </tr>
                                                    );
                                                  })}
                                                </tbody>
                                              </table>
                                            </div>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                            {auditHouseholds && auditHouseholds.context === 'household' && (
                              <div className="mt-3 bg-white rounded-lg border border-gray-200 p-4 overflow-x-auto">
                                <div className="text-sm text-gray-700 mb-2">
                                  Household: <span className="font-mono text-xs">{auditHouseholds.householdId}</span>
                                </div>
                                <div className="mb-3 space-y-1">
                                  <div className="flex items-center gap-2 text-xs text-gray-700">
                                    <span className="text-gray-500">Processing Fee</span>
                                    <span className="font-medium text-gray-900">{formatCurrency(auditHouseholds.fees?.processingFee?.amount ?? 0)}</span>
                                    <span className="text-gray-500">({auditHouseholds.fees?.processingFee?.count ?? 0})</span>
                                    {(auditHouseholds.fees?.processingFee?.count ?? 0) > 1 && (
                                      <AlertTriangle className="h-4 w-4 text-yellow-700" title="Multiple processing fee enrollments in this period" />
                                    )}
                                  </div>
                                  <div className="flex items-center gap-2 text-xs text-gray-700">
                                    <span className="text-gray-500">System Fee</span>
                                    <span className="font-medium text-gray-900">{formatCurrency(auditHouseholds.fees?.systemFee?.amount ?? 0)}</span>
                                    <span className="text-gray-500">({auditHouseholds.fees?.systemFee?.count ?? 0})</span>
                                    {(auditHouseholds.fees?.systemFee?.count ?? 0) > 1 && (
                                      <AlertTriangle className="h-4 w-4 text-yellow-700" title="Multiple system fee enrollments in this period" />
                                    )}
                                  </div>
                                </div>
                                <div className="mb-3">
                                  <button
                                    type="button"
                                    onClick={() => toggleAuditHouseholdEnrollments(auditHouseholds.householdId)}
                                    className="px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 text-xs"
                                  >
                                    {auditHouseholdEnrollmentsOpenByHouseholdId[auditHouseholds.householdId] ? 'Hide enrollments' : 'View enrollments'}
                                  </button>
                                </div>
                                <table className="min-w-full divide-y divide-gray-200">
                                  <thead className="bg-gray-50">
                                    <tr>
                                      <th className="px-3 py-2 text-left text-xs font-medium text-gray-700 uppercase">Product</th>
                                      <th className="px-3 py-2 text-right text-xs font-medium text-gray-700 uppercase">Premium</th>
                                      <th className="px-3 py-2 text-right text-xs font-medium text-gray-700 uppercase">Net</th>
                                      <th className="px-3 py-2 text-right text-xs font-medium text-gray-700 uppercase">Override</th>
                                      <th className="px-3 py-2 text-right text-xs font-medium text-gray-700 uppercase">Commission</th>
                                    </tr>
                                  </thead>
                                  <tbody className="bg-white divide-y divide-gray-200">
                                    {auditHouseholds.products.map((pr, idx) => {
                                      const mismatch = Math.abs(Number(pr.diff) || 0) > 0.01;
                                      return (
                                      <tr key={`${pr.productId ?? 'unknown'}-${idx}`}>
                                        <td className="px-3 py-2 text-sm text-gray-900">{pr.productName ?? pr.productId ?? '—'}</td>
                                        <td
                                          className={`px-3 py-2 text-sm text-right ${mismatch ? 'text-red-700 font-medium' : 'text-gray-900'}`}
                                          title={mismatch ? `Mismatch: premium ${formatCurrency(pr.premiumAmount || 0)} vs components ${formatCurrency(pr.componentSum || 0)} (diff ${formatCurrency(pr.diff || 0)})` : undefined}
                                        >
                                          {formatCurrency(pr.premiumAmount || 0)}
                                        </td>
                                        <td className="px-3 py-2 text-sm text-right text-gray-900">{formatCurrency(pr.netRate || 0)}</td>
                                        <td className="px-3 py-2 text-sm text-right text-gray-900">{formatCurrency(pr.overrideRate || 0)}</td>
                                        <td className="px-3 py-2 text-sm text-right text-gray-900">{formatCurrency(pr.commission || 0)}</td>
                                      </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>

                                {auditHouseholdEnrollmentsOpenByHouseholdId[auditHouseholds.householdId] && (
                                  <div className="mt-4 border-t border-gray-200 pt-4">
                                    {auditHouseholdEnrollmentsLoadingByHouseholdId[auditHouseholds.householdId] && (
                                      <div className="text-sm text-gray-600">Loading enrollments...</div>
                                    )}
                                    {auditHouseholdEnrollmentsErrorByHouseholdId[auditHouseholds.householdId] && (
                                      <div className="mt-2 rounded-lg bg-red-50 border border-red-200 text-red-800 p-3 flex items-center gap-2">
                                        <AlertCircle className="h-5 w-5 flex-shrink-0" />
                                        <span className="text-sm">{auditHouseholdEnrollmentsErrorByHouseholdId[auditHouseholds.householdId]}</span>
                                      </div>
                                    )}
                                    {!!auditHouseholdEnrollmentsByHouseholdId[auditHouseholds.householdId] && (
                                      <div className="overflow-x-auto">
                                        <table className="min-w-full divide-y divide-gray-200">
                                          <thead className="bg-gray-50">
                                            <tr>
                                              <th className="px-3 py-2 text-left text-xs font-medium text-gray-700 uppercase">Member</th>
                                              <th className="px-3 py-2 text-left text-xs font-medium text-gray-700 uppercase">Type</th>
                                              <th className="px-3 py-2 text-left text-xs font-medium text-gray-700 uppercase">Product</th>
                                              <th className="px-3 py-2 text-left text-xs font-medium text-gray-700 uppercase">Effective</th>
                                              <th className="px-3 py-2 text-left text-xs font-medium text-gray-700 uppercase">Created</th>
                                              <th className="px-3 py-2 text-right text-xs font-medium text-gray-700 uppercase">Premium</th>
                                              <th className="px-3 py-2 text-right text-xs font-medium text-gray-700 uppercase">Net</th>
                                              <th className="px-3 py-2 text-right text-xs font-medium text-gray-700 uppercase">Override</th>
                                              <th className="px-3 py-2 text-right text-xs font-medium text-gray-700 uppercase">Comm</th>
                                              <th className="px-3 py-2 text-right text-xs font-medium text-gray-700 uppercase">Diff</th>
                                              <th className="px-3 py-2 text-left text-xs font-medium text-gray-700 uppercase">EnrollmentId</th>
                                            </tr>
                                          </thead>
                                          <tbody className="bg-white divide-y divide-gray-200">
                                            {auditHouseholdEnrollmentsByHouseholdId[auditHouseholds.householdId].map((e) => {
                                              const createdAfterEffective =
                                                !!e.createdDate &&
                                                !!e.effectiveDate &&
                                                String(e.createdDate).slice(0, 10) > String(e.effectiveDate).slice(0, 10);
                                              const diff = Number(e.diff) || 0;
                                              return (
                                                <tr key={String(e.enrollmentId)}>
                                                  <td className="px-3 py-2 text-sm text-gray-900">
                                                    {e.memberId ? (
                                                      <button
                                                        type="button"
                                                        onClick={() => void openMemberManagementModal(e.memberId)}
                                                        className="font-medium text-left text-blue-600 hover:text-blue-800 hover:underline"
                                                      >
                                                        {e.memberName || '—'}
                                                      </button>
                                                    ) : (
                                                      <div className="font-medium">{e.memberName || '—'}</div>
                                                    )}
                                                    <div className="text-xs text-gray-500">
                                                      {e.relationshipType || ''}{e.memberSequence != null ? ` • #${e.memberSequence}` : ''}
                                                    </div>
                                                  </td>
                                                  <td className="px-3 py-2 text-sm text-gray-900">{e.enrollmentType || 'Product'}</td>
                                                  <td className="px-3 py-2 text-sm text-gray-900">{e.productName || e.productId || '—'}</td>
                                                  <td className="px-3 py-2 text-sm text-gray-900">{formatDate(e.effectiveDate)}</td>
                                                  <td className="px-3 py-2 text-sm text-gray-900">
                                                    <div className="flex items-center gap-2">
                                                      <span>{formatDate(e.createdDate)}</span>
                                                      {createdAfterEffective && (
                                                        <span className="text-xs font-bold text-yellow-700" title="Created after effective date">!</span>
                                                      )}
                                                    </div>
                                                  </td>
                                                  <td className="px-3 py-2 text-sm text-right text-gray-900">{formatCurrency(e.premiumAmount || 0)}</td>
                                                  <td className="px-3 py-2 text-sm text-right text-gray-900">{formatCurrency(e.netRate || 0)}</td>
                                                  <td className="px-3 py-2 text-sm text-right text-gray-900">{formatCurrency(e.overrideRate || 0)}</td>
                                                  <td className="px-3 py-2 text-sm text-right text-gray-900">{formatCurrency(e.commission || 0)}</td>
                                                  <td className={`px-3 py-2 text-sm text-right ${Math.abs(diff) < 0.01 ? 'text-gray-500' : diff > 0 ? 'text-red-700 font-medium' : 'text-green-700 font-medium'}`}>
                                                    {formatCurrency(diff)}
                                                  </td>
                                                  <td className="px-3 py-2 text-xs text-gray-600 font-mono">{String(e.enrollmentId)}</td>
                                                </tr>
                                              );
                                            })}
                                          </tbody>
                                        </table>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </details>

                        <details className="mt-4">
                          <summary className="cursor-pointer text-sm font-medium text-gray-700">Show JSON (stored vs computed)</summary>
                          <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-4">
                            <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
                              <div className="text-sm font-medium text-gray-900 mb-2">Stored JSON</div>
                              <div className="space-y-3">
                                <div>
                                  <div className="text-xs font-medium text-gray-600 mb-1">ProductVendorAmounts</div>
                                  <pre className="text-xs text-gray-700 whitespace-pre-wrap break-words">{auditData.payment.ProductVendorAmounts || '—'}</pre>
                                </div>
                                <div>
                                  <div className="text-xs font-medium text-gray-600 mb-1">ProductOwnerAmounts</div>
                                  <pre className="text-xs text-gray-700 whitespace-pre-wrap break-words">{auditData.payment.ProductOwnerAmounts || '—'}</pre>
                                </div>
                                <div>
                                  <div className="text-xs font-medium text-gray-600 mb-1">ProductCommissions</div>
                                  <pre className="text-xs text-gray-700 whitespace-pre-wrap break-words">{auditData.payment.ProductCommissions || '—'}</pre>
                                </div>
                              </div>
                            </div>
                            <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
                              <div className="text-sm font-medium text-gray-900 mb-2">Computed JSON (proposal)</div>
                              <div className="space-y-3">
                                <div>
                                  <div className="text-xs font-medium text-gray-600 mb-1">ProductVendorAmounts</div>
                                  <pre className="text-xs text-gray-700 whitespace-pre-wrap break-words">{auditData.computed.productVendorAmountsJSON}</pre>
                                </div>
                                <div>
                                  <div className="text-xs font-medium text-gray-600 mb-1">ProductOwnerAmounts</div>
                                  <pre className="text-xs text-gray-700 whitespace-pre-wrap break-words">{auditData.computed.productOwnerAmountsJSON}</pre>
                                </div>
                                <div>
                                  <div className="text-xs font-medium text-gray-600 mb-1">ProductCommissions</div>
                                  <pre className="text-xs text-gray-700 whitespace-pre-wrap break-words">{auditData.computed.productCommissionsJSON}</pre>
                                </div>
                              </div>
                            </div>
                          </div>
                        </details>

                        <div className="mt-6 flex items-center justify-between gap-3">
                          <div className="text-xs text-gray-500">
                            {auditData.context === 'group' && auditData.billingPeriod
                              ? <>Billing period: {formatDate(auditData.billingPeriod.startDate)}–{formatDate(auditData.billingPeriod.endDate)} · </>
                              : <>As-of date used: {auditData.asOfDate ? formatDate(auditData.asOfDate) : '—'} · </>}
                            Context: {auditData.context}
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setShowZeroSnapshotsConfirm(true)}
                              disabled={auditCorrecting || zeroingSnapshots}
                              className="px-2 py-1.5 text-xs rounded-lg border border-amber-300 text-amber-800 bg-amber-50 hover:bg-amber-100 disabled:opacity-50"
                            >
                              Zero out payment snapshots
                            </button>
                            <button
                              type="button"
                              onClick={correctAuditPayment}
                              disabled={auditCorrecting || zeroingSnapshots || (auditData.totals.amountDiff !== 0 && auditConfirmMismatch !== true)}
                              className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                            >
                              {auditCorrecting ? 'Correcting...' : 'Correct values'}
                            </button>
                          </div>
                        </div>
                        {showZeroSnapshotsConfirm && (
                          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
                            <p className="text-sm text-amber-900 font-medium mb-2">Zero out payment snapshot fields?</p>
                            <p className="text-sm text-amber-800 mb-3">
                              This will set <strong>NetRate</strong>, <strong>OverrideRate</strong>, <strong>Commission</strong>, fee buckets, and JSON fields on <strong>this payment&apos;s</strong> row in oe.Payments to zero or null. <strong>Amount will not be changed.</strong> Only this payment is updated; no other payments or enrollments are affected.
                            </p>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => confirmZeroEnrollmentSnapshots()}
                                disabled={zeroingSnapshots}
                                className="px-4 py-2 rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
                              >
                                {zeroingSnapshots ? 'Zeroing...' : 'Yes, zero them out'}
                              </button>
                              <button
                                type="button"
                                onClick={() => setShowZeroSnapshotsConfirm(false)}
                                disabled={zeroingSnapshots}
                                className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </>
                    ) : (
                      <p className="text-sm text-gray-500">No audit data.</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'recurring' && (
            <>
              {!canLoadData && (
                <div className="rounded-lg bg-yellow-50 border border-yellow-200 text-yellow-800 p-4 flex items-center gap-2">
                  <AlertCircle className="h-5 w-5 flex-shrink-0" />
                  <span>Select a tenant to view recurring payments.</span>
                </div>
              )}
              {canLoadData && (
                <>
                  <div className="flex flex-wrap items-center gap-3 mb-4">
                    <Filter className="h-5 w-5 text-gray-500" />
                    <select
                      value={recurringStatusFilter}
                      onChange={(e) => setRecurringStatusFilter(e.target.value as 'active' | 'cancelled' | 'both')}
                      className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                    >
                      <option value="active">Active</option>
                      <option value="cancelled">Cancelled</option>
                      <option value="both">Both</option>
                    </select>
                    <select
                      value={recurringMemberType}
                      onChange={(e) => setRecurringMemberType(e.target.value as 'all' | 'group' | 'individual')}
                      className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                    >
                      <option value="all">All (Group + Individual)</option>
                      <option value="group">Group only</option>
                      <option value="individual">Individual only</option>
                    </select>
                    {filterOptions && (
                      <>
                        <SearchableDropdown
                          options={filterOptions.agents}
                          value={recurringAgentId}
                          onChange={(v) => setRecurringAgentId(v || '')}
                          placeholder="Agent"
                          className="min-w-[160px]"
                          showEmail
                        />
                        <SearchableDropdown
                          options={filterOptions.groups}
                          value={recurringGroupId}
                          onChange={(v) => setRecurringGroupId(v || '')}
                          placeholder="Group"
                          className="min-w-[160px]"
                        />
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => loadRecurringPayments()}
                      disabled={recurringLoading}
                      className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 text-sm"
                    >
                      {recurringLoading ? 'Loading...' : 'Apply'}
                    </button>
                  </div>
                  {recurringError && (
                    <div className="rounded-lg bg-red-50 border border-red-200 text-red-800 p-4 flex items-center gap-2 mb-4">
                      <AlertCircle className="h-5 w-5 flex-shrink-0" />
                      <span>{recurringError}</span>
                    </div>
                  )}
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Type</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Location / Group / Member</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Status</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Processor</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Schedule ID</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Next billing date</th>
                          <th className="px-4 py-2 text-right text-xs font-medium text-gray-700 uppercase">Amount</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-700 uppercase">Agent</th>
                          <th className="px-4 py-2 text-right text-xs font-medium text-gray-700 uppercase">Action</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {recurringLoading ? (
                          <tr>
                            <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
                              Loading...
                            </td>
                          </tr>
                        ) : (() => {
                          const filteredRecurring = recurringStatusFilter === 'both'
                            ? recurringList
                            : recurringStatusFilter === 'active'
                              ? recurringList.filter((r) => r.isActive !== false)
                              : recurringList.filter((r) => r.isActive === false);
                          return filteredRecurring.length === 0 ? (
                            <tr>
                              <td colSpan={9} className="px-4 py-8 text-center text-gray-500">
                                No recurring payments found.
                              </td>
                            </tr>
                          ) : (
                            filteredRecurring.map((row) => (
                            <tr key={`${row.context}-${row.scheduleId}`} className={row.isActive === false ? 'bg-gray-50' : ''}>
                              <td className="px-4 py-2 text-sm text-gray-900">{row.context === 'group' ? 'Group' : 'Individual'}</td>
                              <td className="px-4 py-2 text-sm text-gray-900">
                                {row.context === 'group' ? (
                                  row.groupId ? (
                                    <button
                                      type="button"
                                      onClick={() => navigateToGroupForBilling(row.groupId!)}
                                      className="text-left text-blue-600 hover:text-blue-800 font-medium hover:underline"
                                    >
                                      {row.groupName ?? row.locationName}
                                    </button>
                                  ) : (
                                    <span>{row.groupName ?? row.locationName}</span>
                                  )
                                ) : row.memberId ? (
                                  <button
                                    type="button"
                                    onClick={() => void openMemberManagementModal(row.memberId!)}
                                    className="text-left text-blue-600 hover:text-blue-800 font-medium hover:underline"
                                  >
                                    {row.memberName ?? row.locationName}
                                  </button>
                                ) : (
                                  <span>{row.memberName ?? row.locationName}</span>
                                )}
                              </td>
                              <td className="px-4 py-2">
                                {row.isActive === false ? (
                                  <span className="inline-flex px-2 py-1 text-xs font-medium rounded-full bg-gray-200 text-gray-800">Cancelled</span>
                                ) : (
                                  <span className="inline-flex px-2 py-1 text-xs font-medium rounded-full bg-green-100 text-green-800">Active</span>
                                )}
                              </td>
                              <td className="px-4 py-2 text-sm text-gray-600">{row.processor ?? 'DIME'}</td>
                              <td className="px-4 py-2 text-xs text-gray-500 font-mono" title={row.scheduleId}>
                                {row.scheduleId.length > 16 ? `${row.scheduleId.slice(0, 8)}…` : row.scheduleId}
                              </td>
                              <td className="px-4 py-2 text-sm text-gray-600">
                                {row.isActive !== false ? formatDateRecurring(row.nextBillingDate) : (row.cancelledDate ? `Cancelled ${formatDateRecurring(row.cancelledDate)}` : '—')}
                              </td>
                              <td className="px-4 py-2 text-sm font-medium text-gray-900 text-right">{formatCurrency(row.monthlyAmount)}</td>
                              <td className="px-4 py-2 text-sm text-gray-600">{row.agentName ?? '—'}</td>
                              <td className="px-4 py-2 text-right">
                                <div className="flex items-center justify-end gap-2">
                                  {row.isActive !== false && canCancelRecurringInProcessor && (
                                    <button
                                      type="button"
                                      onClick={() => setScheduleToCancel(row)}
                                      className="inline-flex items-center px-3 py-1.5 border border-red-300 text-sm font-medium rounded-md text-red-700 bg-white hover:bg-red-50"
                                    >
                                      <Trash2 className="h-4 w-4 mr-1.5" />
                                      Cancel
                                    </button>
                                  )}
                                  {row.context === 'group' && isSysAdmin && (
                                    <button
                                      type="button"
                                      onClick={() => setScheduleForStatusModal(row)}
                                      disabled={updatingScheduleStatus}
                                      className="inline-flex items-center p-1.5 rounded-md text-gray-500 hover:bg-gray-100"
                                      title="Status options (DB only)"
                                    >
                                      <Settings className="h-4 w-4" />
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )));
                        })()}
                      </tbody>
                    </table>
                  </div>

                  {scheduleToCancel && (
                    <div className="fixed inset-0 z-50 overflow-y-auto">
                      <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20">
                        <div className="fixed inset-0 bg-gray-500 bg-opacity-75" onClick={() => !cancelingSchedule && setScheduleToCancel(null)} />
                        <div className="relative bg-white rounded-lg shadow-xl max-w-lg w-full p-6">
                          <h3 className="text-lg font-semibold text-gray-900">Cancel scheduled payment</h3>
                          <p className="mt-2 text-sm text-gray-500">
                            This will cancel the recurring payment in the payment processor and stop future charges.
                          </p>
                          <div className="mt-4 p-3 bg-gray-50 rounded-md">
                            <p className="text-sm font-medium text-gray-900">
                              {scheduleToCancel.context === 'group' ? scheduleToCancel.groupName : scheduleToCancel.memberName} · {scheduleToCancel.locationName}
                            </p>
                            <p className="text-xs text-gray-500 mt-1">
                              Next billing: {formatDateRecurring(scheduleToCancel.nextBillingDate)} · {formatCurrency(scheduleToCancel.monthlyAmount)}/month
                            </p>
                          </div>
                          <div className="mt-6 flex justify-end gap-3">
                            <button
                              type="button"
                              onClick={() => !cancelingSchedule && setScheduleToCancel(null)}
                              disabled={cancelingSchedule}
                              className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                            >
                              Keep
                            </button>
                            <button
                              type="button"
                              onClick={handleCancelRecurring}
                              disabled={cancelingSchedule}
                              className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
                            >
                              {cancelingSchedule ? 'Canceling...' : 'Cancel scheduled payment'}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {scheduleForStatusModal && scheduleForStatusModal.context === 'group' && scheduleForStatusModal.groupId && (
                    <div className="fixed inset-0 z-50 overflow-y-auto">
                      <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20">
                        <div className="fixed inset-0 bg-gray-500 bg-opacity-75" onClick={() => !updatingScheduleStatus && setScheduleForStatusModal(null)} />
                        <div className="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6">
                          <h3 className="text-lg font-semibold text-gray-900">Update schedule status (our records only)</h3>
                          <p className="mt-1 text-sm text-gray-500">This only updates our database. It does not change anything in the payment processor.</p>
                          <div className="mt-4 p-3 bg-gray-50 rounded-md">
                            <p className="text-sm font-medium text-gray-900">{scheduleForStatusModal.groupName ?? scheduleForStatusModal.locationName}</p>
                            <p className="text-xs text-gray-500 mt-1 font-mono">{scheduleForStatusModal.scheduleId}</p>
                          </div>
                          <div className="mt-4 space-y-2">
                            <button
                              type="button"
                              onClick={() => updateScheduleStatusInDb(scheduleForStatusModal, true)}
                              disabled={updatingScheduleStatus}
                              className="w-full px-3 py-2 rounded-md text-sm font-medium text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
                            >
                              Mark as active (DB only)
                            </button>
                            <button
                              type="button"
                              onClick={() => updateScheduleStatusInDb(scheduleForStatusModal, false)}
                              disabled={updatingScheduleStatus}
                              className="w-full px-3 py-2 rounded-md text-sm font-medium text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
                            >
                              Mark as cancelled (DB only)
                            </button>
                          </div>
                          <div className="mt-4 flex justify-end">
                            <button
                              type="button"
                              onClick={() => !updatingScheduleStatus && setScheduleForStatusModal(null)}
                              className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
                            >
                              Close
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {activeTab === 'invoices' && (
            <TenantInvoicesTab
              tenantId={tenantId}
              canLoadData={canLoadData}
              onMemberClick={(id) => void openMemberManagementModal(id)}
              onGroupClick={navigateToGroupForBilling}
              filterOptions={filterOptions}
            />
          )}

          {activeTab === 'credits' && (
            <TenantBillingCreditsTab
              canLoadData={canLoadData}
              onMemberClick={(id) => void openMemberManagementModal(id)}
              onGroupClick={navigateToGroupForBilling}
            />
          )}

          {activeTab === 'audit' && (
            <>
              {!canLoadData && (
                <div className="rounded-lg bg-yellow-50 border border-yellow-200 text-yellow-800 p-4 flex items-center gap-2">
                  <AlertCircle className="h-5 w-5 flex-shrink-0" />
                  <span>Select a tenant to run billing audits.</span>
                </div>
              )}
              {canLoadData && (
                <div className="space-y-6 min-w-0">
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-6 gap-3">
                    {auditSummaryLoading ? (
                      <div className="col-span-full animate-pulse h-24 rounded-lg bg-gray-100" />
                    ) : auditSummary ? (
                      <>
                        <button
                          type="button"
                          onClick={() => setAuditBreakdownTab('unresolved_failed')}
                          className={`text-left rounded-lg border p-4 transition-colors ${
                            auditSummary.unresolvedFailedPayments > 0
                              ? 'border-red-300 bg-red-50 ring-1 ring-red-200 hover:bg-red-100/90'
                              : 'border-gray-200 bg-white hover:bg-gray-50'
                          }`}
                        >
                          <div className="flex items-center gap-2 text-gray-500 text-xs font-medium uppercase tracking-wide">
                            <AlertTriangle
                              className={`h-4 w-4 ${auditSummary.unresolvedFailedPayments > 0 ? 'text-red-600' : 'text-amber-600'}`}
                            />
                            Unresolved Failed Payments
                          </div>
                          <p
                            className={`mt-2 text-2xl font-semibold ${
                              auditSummary.unresolvedFailedPayments > 0 ? 'text-red-800' : 'text-gray-900'
                            }`}
                          >
                            {auditSummary.unresolvedFailedPayments}
                          </p>
                          <p
                            className={`mt-1 text-sm font-semibold tabular-nums ${
                              auditSummary.unresolvedFailedPayments > 0 ? 'text-red-900' : 'text-gray-600'
                            }`}
                          >
                            {formatCurrency(Number(auditSummary.unresolvedFailedPaymentsAmount ?? 0))} total
                          </p>
                          <p className="mt-1 text-xs text-gray-500">Unique groups / households · click for list</p>
                        </button>
                        <button
                          type="button"
                          onClick={() => setAuditBreakdownTab('webhooks')}
                          className={`text-left rounded-lg border p-4 transition-colors ${
                            auditSummary.webhookErrors30d > 0
                              ? 'border-red-300 bg-red-50 ring-1 ring-red-200 hover:bg-red-100/90'
                              : 'border-gray-200 bg-white hover:bg-gray-50'
                          }`}
                        >
                          <div className="flex items-center gap-2 text-gray-500 text-xs font-medium uppercase tracking-wide">
                            <Activity className={`h-4 w-4 ${auditSummary.webhookErrors30d > 0 ? 'text-red-600' : 'text-gray-400'}`} />
                            Webhook errors
                          </div>
                          <p className="mt-1 text-xs text-gray-500">DIME handler failures · 30d</p>
                          <p
                            className={`mt-2 text-2xl font-semibold ${
                              auditSummary.webhookErrors30d > 0 ? 'text-red-800' : 'text-gray-900'
                            }`}
                          >
                            {auditSummary.webhookErrors30d}
                          </p>
                          <p className="mt-1 text-xs text-gray-500">Click for list</p>
                        </button>
                        <button
                          type="button"
                          onClick={() => setAuditBreakdownTab('missing_recurring')}
                          className={`text-left rounded-lg border p-4 transition-colors ${
                            auditSummary.missingRecurringCount > 0 || auditSummary.missingRecurringCount < 0
                              ? 'border-red-300 bg-red-50 ring-1 ring-red-200 hover:bg-red-100/90'
                              : 'border-gray-200 bg-white hover:bg-gray-50'
                          }`}
                        >
                          <div className="flex items-center gap-2 text-gray-500 text-xs font-medium uppercase tracking-wide">
                            <UserCircle
                              className={`h-4 w-4 ${
                                auditSummary.missingRecurringCount !== 0 ? 'text-red-600' : 'text-gray-400'
                              }`}
                            />
                            Miss. recurring
                          </div>
                          <p
                            className={`mt-2 text-2xl font-semibold ${
                              auditSummary.missingRecurringCount > 0 || auditSummary.missingRecurringCount < 0
                                ? 'text-red-800'
                                : 'text-gray-900'
                            }`}
                          >
                            {auditSummary.missingRecurringCount < 0 ? '—' : auditSummary.missingRecurringCount}
                          </p>
                          <p className="mt-1 text-xs text-gray-600">
                            {auditSummary.missingRecurringCount < 0
                              ? 'Premium impact: —'
                              : `Premium impact: ${formatCurrency(Number(auditSummary.missingRecurringTotalPremium || 0))}`}
                          </p>
                          <p className="mt-1 text-xs text-gray-500">Click for list</p>
                        </button>
                        <button
                          type="button"
                          onClick={() => setAuditBreakdownTab('payment_hold')}
                          className={`text-left rounded-lg border p-4 transition-colors ${
                            (auditSummary.paymentHoldEnrollmentCount ?? 0) > 0
                              ? 'border-red-300 bg-red-50 ring-1 ring-red-200 hover:bg-red-100/90'
                              : 'border-gray-200 bg-white hover:bg-gray-50'
                          }`}
                        >
                          <div className="flex items-center gap-2 text-gray-500 text-xs font-medium uppercase tracking-wide">
                            <Clock
                              className={`h-4 w-4 ${
                                (auditSummary.paymentHoldEnrollmentCount ?? 0) > 0 ? 'text-red-600' : 'text-gray-400'
                              }`}
                            />
                            Payment hold
                          </div>
                          <p
                            className={`mt-2 text-2xl font-semibold ${
                              (auditSummary.paymentHoldEnrollmentCount ?? 0) > 0 ? 'text-red-800' : 'text-gray-900'
                            }`}
                          >
                            {auditSummary.paymentHoldEnrollmentCount ?? 0}
                          </p>
                          <p className="mt-1 text-xs text-gray-500">Click for list</p>
                        </button>
                        <button
                          type="button"
                          onClick={() => setAuditBreakdownTab('orphan_payments')}
                          className={`text-left rounded-lg border p-4 transition-colors ${
                            (orphanPaymentsFromLatestReport?.completed ?? 0) > 0
                              ? 'border-amber-300 bg-amber-50 ring-1 ring-amber-200 hover:bg-amber-100/90'
                              : 'border-gray-200 bg-white hover:bg-gray-50'
                          }`}
                        >
                          <div className="flex items-center gap-2 text-gray-500 text-xs font-medium uppercase tracking-wide">
                            <Unlink
                              className={`h-4 w-4 ${
                                (orphanPaymentsFromLatestReport?.completed ?? 0) > 0 ? 'text-amber-700' : 'text-gray-400'
                              }`}
                            />
                            Orphan payments
                          </div>
                          <p className="mt-1 text-xs text-gray-500">Completed / Success, no invoice link</p>
                          <p
                            className={`mt-2 text-2xl font-semibold ${
                              (orphanPaymentsFromLatestReport?.completed ?? 0) > 0 ? 'text-amber-900' : 'text-gray-900'
                            }`}
                          >
                            {latestReportLoading
                              ? '—'
                              : orphanPaymentsFromLatestReport != null
                                ? orphanPaymentsFromLatestReport.completed
                                : '—'}
                          </p>
                          <p className="mt-1 text-xs text-gray-500">
                            {orphanPaymentsFromLatestReport == null && !latestReportLoading && latestAuditReport
                              ? 'Save a report with the Orphan payments audit for counts here.'
                              : 'Click to open the orphan list below (Transactions link there if you need the full grid).'}
                          </p>
                        </button>
                        {auditSummary.paymentJsonInvalidIncluded !== false ? (
                          <button
                            type="button"
                            onClick={() => setAuditBreakdownTab('bad_json')}
                            className={`text-left rounded-lg border p-4 transition-colors ${
                              (auditSummary.paymentJsonInvalidCount ?? 0) > 0
                                ? 'border-red-300 bg-red-50 ring-1 ring-red-200 hover:bg-red-100/90'
                                : 'border-gray-200 bg-white hover:bg-gray-50'
                            }`}
                          >
                            <div className="flex items-center gap-2 text-gray-500 text-xs font-medium uppercase tracking-wide">
                              <FileSearch
                                className={`h-4 w-4 ${
                                  (auditSummary.paymentJsonInvalidCount ?? 0) > 0 ? 'text-red-600' : 'text-gray-400'
                                }`}
                              />
                              Bad JSON
                            </div>
                            <p
                              className={`mt-2 text-2xl font-semibold ${
                                (auditSummary.paymentJsonInvalidCount ?? 0) > 0 ? 'text-red-800' : 'text-gray-900'
                              }`}
                            >
                              {auditSummary.paymentJsonInvalidCount ?? 0}
                            </p>
                            <p className="mt-1 text-xs text-gray-500">Click for list</p>
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => setBillingDriftModalOpen(true)}
                          className={`text-left rounded-lg border p-4 transition-colors ${
                            (billingDriftSummary?.summary.count ?? 0) > 0
                              ? 'border-yellow-300 bg-yellow-50 ring-1 ring-yellow-200 hover:bg-yellow-100/90'
                              : 'border-gray-200 bg-white hover:bg-gray-50'
                          }`}
                        >
                          <div className="flex items-center gap-2 text-gray-500 text-xs font-medium uppercase tracking-wide">
                            <AlertTriangle
                              className={`h-4 w-4 ${(billingDriftSummary?.summary.count ?? 0) > 0 ? 'text-yellow-700' : 'text-gray-400'}`}
                            />
                            Over-billed invoices
                          </div>
                          <p
                            className={`mt-2 text-2xl font-semibold ${
                              (billingDriftSummary?.summary.count ?? 0) > 0 ? 'text-yellow-900' : 'text-gray-900'
                            }`}
                          >
                            {billingDriftLoading ? '—' : (billingDriftSummary?.summary.count ?? 0)}
                          </p>
                          <p
                            className={`mt-1 text-sm font-semibold tabular-nums ${
                              (billingDriftSummary?.summary.count ?? 0) > 0 ? 'text-yellow-900' : 'text-gray-600'
                            }`}
                          >
                            {formatCurrency(Number(billingDriftSummary?.summary.totalSuggestedCredit ?? 0))} over-billed
                          </p>
                          <p className="mt-1 text-xs text-gray-500">
                            Mid-cycle plan changes · click to review &amp; credit
                          </p>
                        </button>
                        <button
                          type="button"
                          onClick={openMrrAuditModal}
                          className={`text-left rounded-lg border p-4 transition-colors xl:col-span-2 ${
                            mrrDisplay.dime != null &&
                            mrrDisplay.diff != null &&
                            Math.abs(mrrDisplay.diff) > 0.02
                              ? 'border-red-300 bg-red-50 ring-1 ring-red-200 hover:bg-red-100/90'
                              : 'border-gray-200 bg-white hover:bg-gray-50'
                          }`}
                        >
                          <div className="flex items-center gap-2 text-gray-500 text-xs font-medium uppercase tracking-wide">
                            <BarChart3
                              className={`h-4 w-4 ${
                                mrrDisplay.dime != null &&
                                mrrDisplay.diff != null &&
                                Math.abs(mrrDisplay.diff) > 0.02
                                  ? 'text-red-600'
                                  : 'text-gray-400'
                              }`}
                            />
                            Enrollment vs DIME (Active recurring)
                          </div>
                          <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
                            <div>
                              <p className="text-xs text-gray-500">Enrollment expected (active plans)</p>
                              <p className="text-lg font-semibold text-gray-900">
                                {formatCurrency(Number(mrrDisplay.expected ?? auditSummary.expectedEnrollmentMrr ?? auditSummary.dbMrrTotal))}
                              </p>
                            </div>
                            <div>
                              <p className="text-xs text-gray-500">DIME API (Active recurring)</p>
                              <p className="text-lg font-semibold text-gray-900">
                                {mrrDisplay.dime == null ? '—' : formatCurrency(mrrDisplay.dime)}
                              </p>
                            </div>
                            <div>
                              <p className="text-xs text-gray-500">Gap (enrollment − DIME Active)</p>
                              <p
                                className={`text-lg font-semibold ${
                                  mrrDisplay.diff != null && Math.abs(mrrDisplay.diff) > 0.02
                                    ? 'text-red-700'
                                    : 'text-gray-900'
                                }`}
                              >
                                {mrrDisplay.diff == null ? '—' : formatCurrency(mrrDisplay.diff)}
                              </p>
                            </div>
                          </div>
                          <p className="mt-2 text-xs text-gray-500">
                            {mrrDateLabel
                              ? `DB next billing: ${mrrDateLabel.dbRange} · DIME next run: ${mrrDateLabel.dimeRange}`
                              : 'Click for named breakdown (totals match gap)'}
                          </p>
                          {mrrDateLabel && (
                            <p className="mt-1 text-xs text-gray-500">
                              Snapshot: {mrrDateLabel.snapshotAt} · expected as-of {mrrDateLabel.expectedAsOfDate} ·{' '}
                              {mrrDateLabel.dbCount} active DB schedules
                            </p>
                          )}
                          {mrrDisplay.deferredFutureGroups != null && mrrDisplay.deferredFutureGroups > 0.005 && (
                            <p className="mt-1 text-xs text-amber-800">
                              Excluded for now: future-month group effective enrollments {formatCurrency(mrrDisplay.deferredFutureGroups)}.
                            </p>
                          )}
                          {mrrDisplay.fromSavedAuditRun && auditSummary.dimeApiMrrMeta?.unavailable && (
                            <p className="mt-1 text-xs text-amber-800">
                              Live DIME summary failed; showing totals from the last saved audit run (MRR compare).
                            </p>
                          )}
                          {mrrDisplay.metaForFooters?.timedOut && (
                            <p className="mt-1 text-xs text-amber-800">
                              DIME totals may be incomplete (time limit). Refresh the page to retry.
                            </p>
                          )}
                          {mrrDisplay.metaForFooters?.capped && (mrrDisplay.metaForFooters?.customersSkipped ?? 0) > 0 && (
                            <p className="mt-1 text-xs text-amber-800">
                              First {mrrDisplay.metaForFooters.customersChecked} customers checked (
                              {mrrDisplay.metaForFooters.customersSkipped} skipped by cap).
                            </p>
                          )}
                          {auditSummary.dimeApiMrrMeta?.unavailable && mrrDisplay.dime == null && (
                            <p className="mt-1 text-xs text-gray-500">
                              DIME API total unavailable{auditSummary.dimeApiMrrMeta.error ? ` (${auditSummary.dimeApiMrrMeta.error})` : ''}.
                            </p>
                          )}
                        </button>
                      </>
                    ) : (
                      <p className="col-span-full text-sm text-gray-500">Could not load audit summary.</p>
                    )}
                  </div>

                  <div className="bg-white rounded-lg border border-gray-200 p-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 flex-1">
                      <h2 className="text-sm font-medium text-gray-900 inline-flex items-center gap-2">
                        <ClipboardList className="h-4 w-4 text-gray-600" />
                        Last saved audit report
                      </h2>
                      {latestReportLoading ? (
                        <p className="mt-1 text-sm text-gray-500">Loading…</p>
                      ) : latestAuditReport?.runAtUtc ? (
                        <>
                          <p className="mt-1 text-sm text-gray-600">
                            {new Date(latestAuditReport.runAtUtc).toLocaleString(undefined, { timeZone: 'UTC' })} UTC ·{' '}
                            <span className="text-gray-500">{latestAuditReport.triggerName}</span>
                            {latestAuditReport.summary?.auditSummary && (
                              <span className="block sm:inline sm:ml-2 text-gray-700">
                                Failed {latestAuditReport.summary.auditSummary.unresolvedFailedPayments ?? '—'}, webhook err (30d){' '}
                                {latestAuditReport.summary.auditSummary.webhookErrors30d ?? '—'}, miss. recurring{' '}
                                {latestAuditReport.summary.auditSummary.missingRecurringCount ?? '—'}, payment hold{' '}
                                {latestAuditReport.summary.auditSummary.paymentHoldEnrollmentCount ?? '—'}, orphans (completed){' '}
                                {orphanPaymentsFromLatestReport != null ? orphanPaymentsFromLatestReport.completed : '—'}.
                              </span>
                            )}
                          </p>
                          {(() => {
                            const d = latestAuditReport.summary?.missingRecurringSinceLastReport;
                            if (!d) return null;
                            if (d.reason === 'no_prior_snapshot') {
                              return (
                                <p className="mt-2 text-xs text-gray-500">
                                  Missing recurring comparison vs the last report will appear after one more saved run (first snapshot
                                  in this format).
                                </p>
                              );
                            }
                            if (d.comparable !== true) return null;
                            const rc = d.resolvedCount ?? 0;
                            const nm = d.newlyMissingCount ?? 0;
                            if (rc === 0 && nm === 0) return null;
                            return (
                              <div className="mt-2 space-y-2">
                                {rc > 0 && (
                                  <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900">
                                    <span className="font-medium">Resolved since last report (missing recurring): {rc}</span>
                                    {d.previousRunAtUtc && (
                                      <span className="text-green-800">
                                        {' '}
                                        (vs{' '}
                                        {new Date(d.previousRunAtUtc).toLocaleString(undefined, { timeZone: 'UTC' })} UTC)
                                      </span>
                                    )}
                                    {Array.isArray(d.resolved) && d.resolved.length > 0 && (
                                      <p className="mt-1 text-xs text-green-800 leading-relaxed">
                                        {d.resolved
                                          .slice(0, 25)
                                          .map((r) => r.memberName || r.memberId)
                                          .join(', ')}
                                        {d.resolvedTruncated ? ' …' : ''}
                                      </p>
                                    )}
                                  </div>
                                )}
                                {nm > 0 && (
                                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                                    <span className="font-medium">New since last report (missing recurring): {nm}</span>
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                        </>
                      ) : (
                        <p className="mt-1 text-sm text-gray-500">No saved report yet.</p>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={openRunAuditsModal}
                        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold shadow-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 border border-blue-500/20"
                      >
                        <ClipboardCheck className="h-5 w-5 shrink-0" aria-hidden />
                        Run audits
                      </button>
                      <button
                        type="button"
                        onClick={loadAuditStrip}
                        className="px-3 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 text-sm"
                      >
                        Refresh summary
                      </button>
                      {(currentRole === 'TenantAdmin' || isSysAdmin) && (
                        <button
                          type="button"
                          onClick={() => setAuditReportEmailsModalOpen(true)}
                          className="inline-flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 text-sm"
                          title="Daily report email recipients"
                          aria-label="Configure daily billing audit report emails"
                        >
                          <Settings className="h-4 w-4 shrink-0 text-gray-600" aria-hidden />
                          Report emails
                        </button>
                      )}
                      {isSysAdmin && (
                        <button
                          type="button"
                          disabled={creditsDetectionRunning}
                          onClick={async () => {
                            setCreditsDetectionRunning(true);
                            try {
                              const res = await householdCreditsService.runDetectionNow();
                              const d = (res as unknown as { data?: { recognized?: number; householdsTouched?: number; applicationsCount?: number } })?.data
                                || { recognized: 0, householdsTouched: 0, applicationsCount: 0 };
                              toast.success(
                                `Credits detection: recognized ${d.recognized}, applied ${d.applicationsCount} across ${d.householdsTouched} household${d.householdsTouched === 1 ? '' : 's'}`
                              );
                            } catch (err) {
                              toast.error(err instanceof Error ? err.message : 'Failed to run credits detection');
                            } finally {
                              setCreditsDetectionRunning(false);
                            }
                          }}
                          className="inline-flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 text-sm disabled:opacity-60"
                          title="Detect overpayments and apply available credits to oldest unpaid invoices"
                          aria-label="Run credits detection now"
                        >
                          <RefreshCw className={`h-4 w-4 shrink-0 ${creditsDetectionRunning ? 'animate-spin' : ''}`} />
                          {creditsDetectionRunning ? 'Running…' : 'Run credits detection now'}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="border-t border-gray-200 pt-6 space-y-4 min-w-0">
                    <div>
                      <h2 className="text-lg font-medium text-gray-900 inline-flex items-center gap-2">
                        <Filter className="h-5 w-5 text-gray-600" />
                        Audit breakdowns
                      </h2>
                    </div>

                    <div className="flex flex-wrap gap-2" role="tablist" aria-label="Audit breakdown views">
                      {(
                        auditSummary?.paymentJsonInvalidIncluded === false
                          ? AUDIT_BREAKDOWN_TAB_CONFIG.filter((c) => c.id !== 'bad_json')
                          : AUDIT_BREAKDOWN_TAB_CONFIG
                      ).map(({ id, label }) => (
                        <button
                          key={id}
                          type="button"
                          role="tab"
                          aria-selected={auditBreakdownTab === id}
                          onClick={() => setAuditBreakdownTab(id)}
                          className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                            auditBreakdownTab === id
                              ? 'bg-blue-600 text-white border-blue-600'
                              : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    {auditBreakdownTab === 'webhooks' && (
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-end gap-3">
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Start date</label>
                            <input
                              type="date"
                              value={webhookErrorsStart}
                              onChange={(e) => setWebhookErrorsStart(e.target.value)}
                              className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">End date</label>
                            <input
                              type="date"
                              value={webhookErrorsEnd}
                              onChange={(e) => setWebhookErrorsEnd(e.target.value)}
                              className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Limit</label>
                            <select
                              value={webhookErrorsLimit}
                              onChange={(e) => setWebhookErrorsLimit(Number(e.target.value))}
                              className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                            >
                              {[50, 100, 200, 500].map((n) => (
                                <option key={n} value={n}>
                                  {n}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Resolution</label>
                            <select
                              value={webhookErrorsResolutionStatus}
                              onChange={(e) =>
                                setWebhookErrorsResolutionStatus(e.target.value as 'unresolved' | 'resolved' | 'all')
                              }
                              className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                            >
                              <option value="unresolved">Unresolved only</option>
                              <option value="resolved">Resolved only</option>
                              <option value="all">All</option>
                            </select>
                          </div>
                          <button
                            type="button"
                            onClick={loadWebhookIntegrationErrors}
                            disabled={webhookErrorsLoading}
                            className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 text-sm"
                          >
                            {webhookErrorsLoading ? 'Loading…' : 'Refresh from server'}
                          </button>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600">
                          <span>Quick range:</span>
                          <button
                            type="button"
                            className="text-blue-600 hover:text-blue-800 font-medium"
                            onClick={() => {
                              const r = getDefaultAuditServerFilterRange();
                              setWebhookErrorsStart(r.start);
                              setWebhookErrorsEnd(r.end);
                            }}
                          >
                            Last 30 days
                          </button>
                          <span className="text-gray-300">|</span>
                          <button
                            type="button"
                            className="text-blue-600 hover:text-blue-800 font-medium"
                            onClick={() => {
                              const r = getMonthToDateAuditFilterRange();
                              setWebhookErrorsStart(r.start);
                              setWebhookErrorsEnd(r.end);
                            }}
                          >
                            Month to date
                          </button>
                          <span className="text-gray-300">|</span>
                          <button
                            type="button"
                            className="text-blue-600 hover:text-blue-800 font-medium"
                            onClick={() => {
                              setWebhookErrorsStart('');
                              setWebhookErrorsEnd('');
                            }}
                          >
                            Clear dates (no range filter)
                          </button>
                        </div>
                      </div>
                    )}

                    {auditBreakdownTab === 'wizard' && (
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-end gap-3">
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Start date</label>
                            <input
                              type="date"
                              value={wizardPayStart}
                              onChange={(e) => setWizardPayStart(e.target.value)}
                              className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">End date</label>
                            <input
                              type="date"
                              value={wizardPayEnd}
                              onChange={(e) => setWizardPayEnd(e.target.value)}
                              className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                            />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Limit</label>
                            <select
                              value={wizardPayLimit}
                              onChange={(e) => setWizardPayLimit(Number(e.target.value))}
                              className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                            >
                              {[50, 100, 200, 500].map((n) => (
                                <option key={n} value={n}>
                                  {n}
                                </option>
                              ))}
                            </select>
                          </div>
                          <button
                            type="button"
                            onClick={loadEnrollmentWizardPaymentReports}
                            disabled={wizardPayLoading}
                            className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 text-sm"
                          >
                            {wizardPayLoading ? 'Loading…' : 'Refresh from server'}
                          </button>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600">
                          <span>Quick range:</span>
                          <button
                            type="button"
                            className="text-blue-600 hover:text-blue-800 font-medium"
                            onClick={() => {
                              const r = getDefaultAuditServerFilterRange();
                              setWizardPayStart(r.start);
                              setWizardPayEnd(r.end);
                            }}
                          >
                            Last 30 days
                          </button>
                          <span className="text-gray-300">|</span>
                          <button
                            type="button"
                            className="text-blue-600 hover:text-blue-800 font-medium"
                            onClick={() => {
                              const r = getMonthToDateAuditFilterRange();
                              setWizardPayStart(r.start);
                              setWizardPayEnd(r.end);
                            }}
                          >
                            Month to date
                          </button>
                          <span className="text-gray-300">|</span>
                          <button
                            type="button"
                            className="text-blue-600 hover:text-blue-800 font-medium"
                            onClick={() => {
                              setWizardPayStart('');
                              setWizardPayEnd('');
                            }}
                          >
                            Clear dates (no range filter)
                          </button>
                        </div>
                      </div>
                    )}

                    {auditBreakdownTab !== 'webhooks' && auditBreakdownTab !== 'wizard' && (
                      <div className="space-y-2">
                        {auditBreakdownTab === 'missing_recurring' && (
                          <div className="rounded-lg border border-blue-100 bg-blue-50/80 px-3 py-2 text-sm text-blue-950">
                            <p>
                              Bill-now households with no DIME recurring schedule, plus future-effective individuals (e.g. not yet
                              effective). Group members waiting on a group plan are excluded. The Miss. recurring card count is bill-now
                              only.
                            </p>
                          </div>
                        )}
                        {auditBreakdownTab === 'orphan_payments' && (
                          <div className="rounded-lg border border-amber-100 bg-amber-50/80 px-3 py-2 text-sm text-amber-950">
                            <p>
                              Successful charges only (Completed, Success, succeeded) with{' '}
                              <code className="text-xs bg-white/80 px-1 rounded">InvoiceId</code> null — excludes Refunded and
                              RecurringScheduled placeholders (same as Run audits → Orphan payments). Narrow with filters below. Fix
                              rows via SysAdmin <strong>Billing Integrity</strong> → <strong>Link completed</strong>.
                            </p>
                            <button
                              type="button"
                              onClick={() => {
                                setActiveTab('transactions');
                                if (statusFilter === PAYMENT_STATUS_UNRESOLVED_FAILED) setStatusFilter('');
                                setNoLinkedInvoiceOnly(true);
                                setPaymentsPage(1);
                              }}
                              className="mt-1 text-sm font-medium text-blue-700 hover:text-blue-900 underline"
                            >
                              Open Transactions with &quot;No linked invoice&quot; checked
                            </button>
                          </div>
                        )}
                        <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void loadAuditBreakdownData(auditBreakdownTab)}
                          disabled={breakdownLoading}
                          className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm disabled:opacity-50"
                        >
                          {breakdownLoading ? 'Loading…' : 'Reload list'}
                        </button>
                        {auditBreakdownTab === 'missing_recurring' && filteredBreakdownRows.length > 0 && (
                          <>
                            <button
                              type="button"
                              onClick={() => setMissingRecurringSetupOpen(true)}
                              disabled={missingRecurringMemberIds.length === 0}
                              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-300 text-gray-800 hover:bg-gray-50 text-sm disabled:opacity-50"
                            >
                              <CreditCard className="h-4 w-4 shrink-0" aria-hidden />
                              Set up recurring…
                            </button>
                            <button
                              type="button"
                              onClick={() => setMissingRecurringOutreachOpen(true)}
                              disabled={missingRecurringManualEmails.length === 0 && missingRecurringManualPhones.length === 0}
                              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-300 text-gray-800 hover:bg-gray-50 text-sm disabled:opacity-50"
                              title={
                                missingRecurringManualEmails.length === 0 && missingRecurringManualPhones.length === 0
                                  ? 'No usable email or phone on the filtered list'
                                  : undefined
                              }
                            >
                              <Mail className="h-4 w-4 shrink-0" aria-hidden />
                              Email / SMS…
                            </button>
                          </>
                        )}
                        <span className="text-xs text-gray-500">Up to 500 rows per request.</span>
                      </div>
                      </div>
                    )}

                    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-3">
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Filter this list</p>
                      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                        <div className="md:col-span-2 xl:col-span-3">
                          <label className="block text-sm font-medium text-gray-700 mb-1">Search text</label>
                          <input
                            type="search"
                            value={auditBreakdownText}
                            onChange={(e) => setAuditBreakdownText(e.target.value)}
                            placeholder="Message, id, JSON snippet…"
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Group</label>
                          <SearchableDropdown
                            options={groupBreakdownDropdownOptions}
                            value={auditBreakdownGroupId}
                            onChange={(v) => setAuditBreakdownGroupId(v)}
                            placeholder="All groups"
                            searchPlaceholder="Search groups…"
                            loading={filterOptionsLoading}
                            className="w-full"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Member</label>
                          <SearchableDropdown
                            options={memberBreakdownDropdownOptions}
                            value={auditBreakdownMemberId}
                            onChange={(v) => setAuditBreakdownMemberId(v)}
                            placeholder="All members"
                            searchPlaceholder="Search members…"
                            showEmail
                            loading={filterOptionsLoading}
                            className="w-full"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Agent</label>
                          <SearchableDropdown
                            options={agentBreakdownDropdownOptions}
                            value={auditBreakdownAgentId}
                            onChange={(v) => setAuditBreakdownAgentId(v)}
                            placeholder="All agents"
                            searchPlaceholder="Search agents…"
                            showEmail
                            loading={filterOptionsLoading}
                            className="w-full"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Row date from</label>
                          <input
                            type="date"
                            value={auditBreakdownDateStart}
                            onChange={(e) => setAuditBreakdownDateStart(e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Row date to</label>
                          <input
                            type="date"
                            value={auditBreakdownDateEnd}
                            onChange={(e) => setAuditBreakdownDateEnd(e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Amount min</label>
                          <input
                            type="number"
                            step="0.01"
                            value={auditBreakdownAmtMin}
                            onChange={(e) => setAuditBreakdownAmtMin(e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Amount max</label>
                          <input
                            type="number"
                            step="0.01"
                            value={auditBreakdownAmtMax}
                            onChange={(e) => setAuditBreakdownAmtMax(e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                          />
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600">
                          <span>Row date quick range:</span>
                          <button
                            type="button"
                            className="text-blue-600 hover:text-blue-800 font-medium"
                            onClick={() => {
                              const r = getDefaultAuditServerFilterRange();
                              setAuditBreakdownDateStart(r.start);
                              setAuditBreakdownDateEnd(r.end);
                            }}
                          >
                            Last 30 days
                          </button>
                          <span className="text-gray-300">|</span>
                          <button
                            type="button"
                            className="text-blue-600 hover:text-blue-800 font-medium"
                            onClick={() => {
                              const r = getMonthToDateAuditFilterRange();
                              setAuditBreakdownDateStart(r.start);
                              setAuditBreakdownDateEnd(r.end);
                            }}
                          >
                            Month to date
                          </button>
                          <span className="text-gray-300">|</span>
                          <button
                            type="button"
                            className="text-blue-600 hover:text-blue-800 font-medium"
                            onClick={() => {
                              setAuditBreakdownDateStart('');
                              setAuditBreakdownDateEnd('');
                            }}
                          >
                            Clear dates (no row-date filter)
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setAuditBreakdownText('');
                            setAuditBreakdownGroupId('');
                            setAuditBreakdownMemberId('');
                            setAuditBreakdownAgentId('');
                            const r = getDefaultAuditServerFilterRange();
                            setAuditBreakdownDateStart(r.start);
                            setAuditBreakdownDateEnd(r.end);
                            setAuditBreakdownAmtMin('');
                            setAuditBreakdownAmtMax('');
                          }}
                          className="text-sm text-blue-600 hover:text-blue-800 font-medium"
                        >
                          Clear filters
                        </button>
                      </div>
                    </div>

                    {auditBreakdownTab === 'webhooks' && webhookErrorsError && (
                      <div className="rounded-lg bg-red-50 border border-red-200 text-red-800 p-3 text-sm flex items-start gap-2">
                        <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
                        <span>{webhookErrorsError}</span>
                      </div>
                    )}
                    {auditBreakdownTab === 'wizard' && wizardPayError && (
                      <div className="rounded-lg bg-red-50 border border-red-200 text-red-800 p-3 text-sm flex items-start gap-2">
                        <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
                        <span>{wizardPayError}</span>
                      </div>
                    )}
                    {auditBreakdownTab !== 'webhooks' && auditBreakdownTab !== 'wizard' && breakdownError && (
                      <div className="rounded-lg bg-red-50 border border-red-200 text-red-800 p-3 text-sm flex items-start gap-2">
                        <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
                        <span>{breakdownError}</span>
                      </div>
                    )}

                    {auditBreakdownTab === 'webhooks' &&
                      (webhookErrorsLoading ? (
                        <div className="animate-pulse rounded-lg bg-gray-100 h-40" />
                      ) : webhookErrors.length === 0 ? (
                        <p className="text-sm text-gray-500">
                          No webhook errors for the selected date range (defaults to the last 30 days). Widen the range or clear dates and
                          refresh if you expect older rows.
                        </p>
                      ) : filteredWebhookRows.length === 0 ? (
                        <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                          No rows match the filters below ({webhookErrors.length} loaded).
                        </p>
                      ) : (
                        <div className="overflow-x-auto border border-gray-200 rounded-lg">
                          <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gray-50">
                              <tr>
                                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                  Time (UTC)
                                </th>
                                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                  Message
                                </th>
                                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                  DIME txn
                                </th>
                                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                  Linked payment
                                </th>
                                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                  State
                                </th>
                                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                  Detail
                                </th>
                                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                  Action
                                </th>
                              </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-200">
                              {filteredWebhookRows.map((row) => (
                                <tr key={row.integrationErrorId}>
                                  <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600">
                                    {row.createdDate ? formatDate(row.createdDate) : '—'}
                                  </td>
                                  <td className="px-4 py-3 text-sm text-gray-900 max-w-md">{row.message}</td>
                                  <td className="px-4 py-3 text-xs text-gray-600 font-mono max-w-[140px] break-all">
                                    {row.webhookTransactionId ?? '—'}
                                  </td>
                                  <td className="px-4 py-3 text-sm text-gray-800">
                                    {row.linkedPaymentId ? (
                                      <span>
                                        <span className="font-mono text-xs">{row.linkedPaymentId.slice(0, 8)}…</span>
                                        {row.linkedPaymentStatus && (
                                          <span className="block text-xs text-gray-500">{row.linkedPaymentStatus}</span>
                                        )}
                                        {row.linkedAmount != null && (
                                          <span className="block text-xs text-gray-600">{formatCurrency(row.linkedAmount)}</span>
                                        )}
                                      </span>
                                    ) : (
                                      '—'
                                    )}
                                  </td>
                                  <td className="px-4 py-3 text-sm">
                                    {row.resolved ? (
                                      <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-green-100 text-green-800">
                                        Resolved
                                      </span>
                                    ) : (
                                      <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-red-100 text-red-800">
                                        Unresolved
                                      </span>
                                    )}
                                  </td>
                                  <td className="px-4 py-3 text-xs text-gray-600 font-mono max-w-xl break-all" title={row.detailJson || ''}>
                                    {row.detailJson && row.detailJson.length > 280 ? `${row.detailJson.slice(0, 280)}…` : row.detailJson || '—'}
                                  </td>
                                  <td className="px-4 py-3 text-sm">
                                    <button
                                      type="button"
                                      onClick={() => void toggleWebhookErrorResolved(row, !row.resolved)}
                                      disabled={!!webhookResolveLoadingById[row.integrationErrorId]}
                                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors disabled:opacity-50 ${
                                        row.resolved
                                          ? 'border-gray-300 text-gray-700 hover:bg-gray-50'
                                          : 'border-green-300 text-green-700 hover:bg-green-50'
                                      }`}
                                    >
                                      {webhookResolveLoadingById[row.integrationErrorId]
                                        ? 'Saving…'
                                        : row.resolved
                                          ? 'Set unresolved'
                                          : 'Mark resolved'}
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ))}

                    {auditBreakdownTab === 'wizard' &&
                      (wizardPayLoading ? (
                        <div className="animate-pulse rounded-lg bg-gray-100 h-40" />
                      ) : wizardPayErrors.length === 0 ? (
                        <p className="text-sm text-gray-500">
                          No enrollment wizard payment errors for the selected date range (defaults to the last 30 days). Widen the range or
                          clear dates and refresh if you expect older rows.
                        </p>
                      ) : filteredWizardRows.length === 0 ? (
                        <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                          No rows match the filters below ({wizardPayErrors.length} loaded).
                        </p>
                      ) : (
                        <div className="overflow-x-auto border border-gray-200 rounded-lg">
                          <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gray-50">
                              <tr>
                                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                  Time (UTC)
                                </th>
                                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                  Message
                                </th>
                                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                  Source
                                </th>
                                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                  Detail
                                </th>
                              </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-200">
                              {filteredWizardRows.map((row) => (
                                <tr key={row.integrationErrorId}>
                                  <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600">
                                    {row.createdDate ? formatDate(row.createdDate) : '—'}
                                  </td>
                                  <td className="px-4 py-3 text-sm text-gray-900 max-w-md">{row.message}</td>
                                  <td className="px-4 py-3 text-xs text-gray-600 font-mono max-w-[200px] break-all">
                                    {row.source ?? '—'}
                                  </td>
                                  <td className="px-4 py-3 text-xs text-gray-600 font-mono max-w-xl break-all" title={row.detailJson || ''}>
                                    {row.detailJson && row.detailJson.length > 280 ? `${row.detailJson.slice(0, 280)}…` : row.detailJson || '—'}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ))}

                    {auditBreakdownTab !== 'webhooks' &&
                      auditBreakdownTab !== 'wizard' &&
                      (breakdownLoading ? (
                        <div className="animate-pulse rounded-lg bg-gray-100 h-40" />
                      ) : breakdownRows.length === 0 && !breakdownError ? (
                        <p className="text-sm text-gray-500">No rows returned.</p>
                      ) : filteredBreakdownRows.length === 0 && breakdownRows.length > 0 ? (
                        <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                          No rows match the filters below ({breakdownRows.length} loaded).
                        </p>
                      ) : auditBreakdownTab === 'unresolved_failed' ? (
                        <div className="space-y-3 min-w-0">
                          <p className="text-xs text-gray-600">
                            One row per group (when the payment is tied to a group) or per household (individual). Select failed payments to
                            open every payment row loaded for this run (up to 5,000 most recent failures tenant-wide).
                          </p>
                          <div className="w-full min-w-0 max-w-full rounded-lg border border-gray-200">
                            <div className="max-h-[70vh] overflow-auto overscroll-x-contain">
                            <table className="min-w-max w-full divide-y divide-gray-200 text-sm">
                              <thead className="bg-gray-50 sticky top-0">
                                <tr>
                                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                    Member/Group
                                  </th>
                                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
                                    Payment methods
                                  </th>
                                  <th
                                    className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap"
                                    title="Days from scheduled due date (Next billing) or failed charge date until today (UTC)"
                                  >
                                    Days overdue
                                  </th>
                                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                    Failed payments
                                  </th>
                                  <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                                    Amount
                                  </th>
                                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
                                    Latest failed (UTC)
                                  </th>
                                </tr>
                              </thead>
                              <tbody className="bg-white divide-y divide-gray-200">
                                {filteredBreakdownRows.map((row) => {
                                  const bk = String(row.bucketKey ?? '');
                                  const fc = Number(row.failedCount ?? 0);
                                  const gName = row.groupName != null ? String(row.groupName) : '';
                                  const pName = row.primaryMemberName != null ? String(row.primaryMemberName) : '';
                                  const gid = row.groupId != null && String(row.groupId).trim() ? String(row.groupId) : '';
                                  const mid = row.memberId != null && String(row.memberId).trim() ? String(row.memberId) : '';
                                  const latest = row.latestPaymentDate;
                                  const amt = Number(row.totalFailedAmount ?? 0);
                                  const late = Number(row.daysLate ?? 0);
                                  return (
                                    <tr key={bk || `${gid}-${mid}`}>
                                      <td className="px-3 py-2 text-gray-800">
                                        {gid ? (
                                          <button
                                            type="button"
                                            onClick={() => navigateToGroupForBilling(gid)}
                                            className="text-blue-600 hover:text-blue-800 font-medium hover:underline text-left"
                                          >
                                            {gName.trim() || 'Group'}
                                          </button>
                                        ) : mid && pName ? (
                                          <button
                                            type="button"
                                            onClick={() => void openMemberManagementModal(mid)}
                                            className="text-blue-600 hover:text-blue-800 font-medium hover:underline text-left"
                                          >
                                            {pName}
                                          </button>
                                        ) : (
                                          pName || '—'
                                        )}
                                      </td>
                                      <td className="px-3 py-2 text-gray-800 max-w-xs">
                                        {mid ? (
                                          <button
                                            type="button"
                                            onClick={() => void openMemberManagementModal(mid, 'payments')}
                                            className="text-blue-600 hover:text-blue-800 font-medium hover:underline text-left"
                                          >
                                            {formatPaymentMethodValiditySummary(row)}
                                          </button>
                                        ) : (
                                          formatPaymentMethodValiditySummary(row)
                                        )}
                                      </td>
                                      <td className="px-3 py-2 text-gray-800 text-right tabular-nums whitespace-nowrap">
                                        {Number.isFinite(late) ? String(Math.max(0, Math.floor(late))) : '—'}
                                      </td>
                                      <td className="px-3 py-2">
                                        <button
                                          type="button"
                                          onClick={() => bk && setUnresolvedFailedModalBucketKey(bk)}
                                          className="text-blue-600 hover:text-blue-800 font-medium hover:underline"
                                        >
                                          {fc} failed payment{fc === 1 ? '' : 's'}
                                        </button>
                                      </td>
                                      <td className="px-3 py-2 text-gray-800 text-right tabular-nums whitespace-nowrap">
                                        {formatCurrency(Number.isFinite(amt) ? amt : 0)}
                                      </td>
                                      <td className="px-3 py-2 text-gray-700 whitespace-nowrap">
                                        {latest
                                          ? formatAuditDrilldownCell('latestPaymentDate', latest, formatCurrency)
                                          : '—'}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <AuditDrilldownTable
                          rows={filteredBreakdownRows}
                          breakdownTab={auditBreakdownTab}
                          formatCurrency={formatCurrency}
                          onMemberClick={(id, tab) => void openMemberManagementModal(id, tab)}
                          onGroupClick={navigateToGroupForBilling}
                        />
                      ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {auditDrilldownModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4">
            <button
              type="button"
              className="fixed inset-0 bg-gray-500 bg-opacity-75"
              aria-label="Close"
              onClick={() => !auditDrilldownLoading && setAuditDrilldownModal(null)}
            />
            <div className="relative bg-white rounded-lg shadow-xl max-w-5xl w-full p-6 max-h-[90vh] overflow-y-auto z-10">
              <h3 className="text-lg font-semibold text-gray-900 pr-8">{auditDrilldownModal.title}</h3>
              {auditDrilldownModal.mode === 'mrr' && auditSummary ? (
                <div className="mt-4 space-y-4 text-sm text-gray-800">
                  <p className="text-gray-600">
                    Compares <strong>enrollment premium</strong> (active plans we expect to bill) to <strong>DIME Active recurring</strong> only.
                    The gap below is split into named members/groups; bucket amounts sum to the penny to the headline gap. Focus on{' '}
                    <strong>No recurring setup</strong> and <strong>DIME Failed / overdue</strong> for collections risk.
                  </p>
                  {mrrDateLabel && (
                    <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                      <p className="text-xs text-gray-700">
                        DB next billing window: <span className="font-medium">{mrrDateLabel.dbRange}</span>
                      </p>
                      <p className="text-xs text-gray-700">
                        DIME next run window: <span className="font-medium">{mrrDateLabel.dimeRange}</span>
                      </p>
                      <p className="text-xs text-gray-500 mt-1">
                        Snapshot: {mrrDateLabel.snapshotAt} ({mrrDateLabel.dbCount} active DB schedules)
                      </p>
                    </div>
                  )}
                  {mrrDisplay.fromSavedAuditRun && auditSummary.dimeApiMrrMeta?.unavailable && (
                    <p className="text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm">
                      Live DIME summary failed; DIME and difference below use the last saved audit run (MRR compare).
                    </p>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="rounded-lg border border-gray-200 p-4">
                      <p className="text-xs font-medium text-gray-500 uppercase">DB — Group</p>
                      <p className="text-xl font-semibold text-gray-900">{formatCurrency(Number(auditSummary.dbGroupMrr ?? 0))}</p>
                    </div>
                    <div className="rounded-lg border border-gray-200 p-4">
                      <p className="text-xs font-medium text-gray-500 uppercase">DB — Individual</p>
                      <p className="text-xl font-semibold text-gray-900">{formatCurrency(Number(auditSummary.dbIndividualMrr ?? 0))}</p>
                    </div>
                    <div className="rounded-lg border border-gray-200 p-4">
                      <p className="text-xs font-medium text-gray-500 uppercase">Enrollment expected (active plans)</p>
                      <p className="text-xl font-semibold text-gray-900">
                        {formatCurrency(Number(mrrDisplay.expected ?? auditSummary.expectedEnrollmentMrr ?? auditSummary.dbMrrTotal))}
                      </p>
                    </div>
                    <div className="rounded-lg border border-gray-200 p-4">
                      <p className="text-xs font-medium text-gray-500 uppercase">DIME API (Active recurring)</p>
                      <p className="text-xl font-semibold text-gray-900">
                        {mrrDisplay.dime == null ? '—' : formatCurrency(mrrDisplay.dime)}
                      </p>
                    </div>
                    <div
                      className={`rounded-lg border p-4 sm:col-span-2 ${
                        mrrDisplay.diff != null && Math.abs(mrrDisplay.diff) > 0.02
                          ? 'border-red-300 bg-red-50'
                          : 'border-gray-200'
                      }`}
                    >
                      <p className="text-xs font-medium text-gray-500 uppercase">Gap (enrollment − DIME Active)</p>
                      <p
                        className={`text-xl font-semibold ${
                          mrrDisplay.diff != null && Math.abs(mrrDisplay.diff) > 0.02 ? 'text-red-700' : 'text-gray-900'
                        }`}
                      >
                        {mrrDisplay.diff == null ? '—' : formatCurrency(mrrDisplay.diff)}
                      </p>
                    </div>
                    {(mrrDisplay.deferredFutureGroups != null && mrrDisplay.deferredFutureGroups > 0.005) && (
                      <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 sm:col-span-2">
                        <p className="text-xs font-medium text-yellow-800 uppercase">Excluded (future-month group effective enrollments)</p>
                        <p className="text-lg font-semibold text-yellow-900">
                          {formatCurrency(mrrDisplay.deferredFutureGroups)}
                          {mrrDateLabel && mrrDateLabel.deferredFutureGroupCount > 0 && (
                            <span className="text-yellow-800 font-normal text-sm ml-2">
                              ({mrrDateLabel.deferredFutureGroupCount} enrollment row
                              {mrrDateLabel.deferredFutureGroupCount === 1 ? '' : 's'})
                            </span>
                          )}
                        </p>
                      </div>
                    )}
                    <div className="rounded-lg border border-dashed border-gray-200 p-4 sm:col-span-2 bg-gray-50">
                      <p className="text-xs font-medium text-gray-500 uppercase">Schedule ID stored in DB (reference)</p>
                      <p className="text-lg font-semibold text-gray-800">
                        {formatCurrency(Number(auditSummary.processorLinkedMrr ?? 0))}
                        <span className="text-gray-500 font-normal text-sm ml-2">
                          (premium on rows that have a processor schedule ID saved)
                        </span>
                      </p>
                    </div>
                    <div className="rounded-lg border border-gray-200 p-4 sm:col-span-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-medium text-gray-500 uppercase">Why enrollment − DIME differs (named)</p>
                        <button
                          type="button"
                          onClick={() => void loadMrrReconciliation()}
                          disabled={mrrReconciliationLoading}
                          className="px-3 py-1.5 rounded-lg border border-gray-300 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                        >
                          {mrrReconciliationLoading ? 'Loading...' : 'Refresh'}
                        </button>
                      </div>
                      {mrrReconciliationError && (
                        <p className="mt-2 text-xs text-red-700">{mrrReconciliationError}</p>
                      )}
                      {mrrReconciliationLoading && !mrrReconciliation && (
                        <p className="mt-2 text-xs text-gray-500">Loading named breakdown...</p>
                      )}
                      {mrrReconciliation && (
                        <>
                          <p className="mt-2 text-xs text-gray-600">
                            Bucket total{' '}
                            <span className="font-semibold text-gray-900">
                              {formatCurrency(mrrReconciliation.bucketsTotal)}
                            </span>
                            {' · '}
                            Headline gap{' '}
                            <span className="font-semibold text-gray-900">
                              {mrrReconciliation.headline.difference != null
                                ? formatCurrency(mrrReconciliation.headline.difference)
                                : '—'}
                            </span>
                            {mrrReconciliation.totalsMatch && mrrReconciliation.headline.difference != null && (
                              <span className="ml-2 text-green-700 font-medium">(matches to the penny)</span>
                            )}
                          </p>
                          <p className="mt-1 text-xs text-red-800 font-medium">
                            Actionable (no setup + overdue): {formatCurrency(mrrReconciliation.actionableAmount)}/mo
                          </p>
                          <div className="mt-3 space-y-2">
                            {mrrReconciliation.buckets.map((bucket: BillingAuditMrrReconciliationBucket) => {
                              const expanded = mrrReconciliationExpandedBucket === bucket.key;
                              const borderClass =
                                bucket.severity === 'critical'
                                  ? 'border-red-200'
                                  : bucket.severity === 'info'
                                    ? 'border-amber-200'
                                    : 'border-gray-200';
                              const bgClass =
                                bucket.severity === 'critical'
                                  ? 'bg-red-50/50'
                                  : bucket.severity === 'info'
                                    ? 'bg-amber-50/50'
                                    : 'bg-gray-50/50';
                              return (
                                <div key={bucket.key} className={`rounded-lg border ${borderClass} ${bgClass}`}>
                                  <button
                                    type="button"
                                    className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left"
                                    onClick={() =>
                                      setMrrReconciliationExpandedBucket(expanded ? null : bucket.key)
                                    }
                                  >
                                    <div>
                                      <p className="text-sm font-semibold text-gray-900">{bucket.label}</p>
                                      <p className="text-xs text-gray-600 mt-0.5">{bucket.description}</p>
                                    </div>
                                    <div className="text-right shrink-0">
                                      <p className="text-sm font-semibold tabular-nums text-gray-900">
                                        {formatCurrency(bucket.amount)}
                                      </p>
                                      <p className="text-[11px] text-gray-500">
                                        {bucket.count} {bucket.count === 1 ? 'name' : 'names'}
                                      </p>
                                    </div>
                                  </button>
                                  {expanded && bucket.rows.length > 0 && (
                                    <div className="px-3 pb-3 max-h-56 overflow-auto border-t border-gray-200/80">
                                      <table className="min-w-full text-xs mt-2">
                                        <thead>
                                          <tr className="text-left text-gray-500">
                                            <th className="py-1 pr-2 font-medium">Name</th>
                                            <th className="py-1 pr-2 font-medium">Type</th>
                                            <th className="py-1 pr-2 font-medium text-right">Premium/mo</th>
                                            <th className="py-1 font-medium">Note</th>
                                          </tr>
                                        </thead>
                                        <tbody className="divide-y divide-gray-100">
                                          {bucket.rows.map((row) => (
                                            <tr key={`${bucket.key}-${row.householdId || row.groupId || row.name}`}>
                                              <td className="py-1.5 pr-2 text-gray-900 font-medium">{row.name}</td>
                                              <td className="py-1.5 pr-2 text-gray-600 capitalize">{row.contextType}</td>
                                              <td className="py-1.5 pr-2 text-right tabular-nums text-gray-900">
                                                {formatCurrency(row.monthlyPremium)}
                                              </td>
                                              <td className="py-1.5 text-gray-600">
                                                {row.effectiveDate ? `Eff. ${row.effectiveDate}` : row.detail || '—'}
                                                {row.dimeStatus ? ` · DIME ${row.dimeStatus}` : ''}
                                              </td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  )}
                                  {expanded && bucket.key === 'OTHER' && (
                                    <p className="px-3 pb-3 text-xs text-gray-600 border-t border-gray-200/80">
                                      Residual timing and premium-vs-schedule deltas; no member list.
                                    </p>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ) : auditDrilldownLoading ? (
                <div className="mt-4 animate-pulse h-48 rounded-lg bg-gray-100" />
              ) : (
                <div className="mt-4">
                  <AuditDrilldownTable
                    rows={auditDrilldownModal.rows || []}
                    breakdownTab={null}
                    formatCurrency={formatCurrency}
                    onMemberClick={(id, tab) => void openMemberManagementModal(id, tab)}
                    onGroupClick={navigateToGroupForBilling}
                  />
                </div>
              )}
              <div className="mt-6 flex justify-end">
                <button
                  type="button"
                  onClick={() => setAuditDrilldownModal(null)}
                  disabled={auditDrilldownLoading}
                  className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {unresolvedFailedModalBucketKey != null && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4">
            <button
              type="button"
              className="fixed inset-0 bg-gray-500 bg-opacity-75"
              aria-label="Close"
              onClick={() => setUnresolvedFailedModalBucketKey(null)}
            />
            <div className="relative bg-white rounded-lg shadow-xl max-w-5xl w-full p-6 max-h-[90vh] overflow-y-auto z-10">
              <div className="flex items-start justify-between gap-2 pr-2">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">Failed payments (this group / household)</h3>
                  <p className="mt-1 text-sm text-gray-600">
                    {unresolvedFailedModalPayments.length} payment row
                    {unresolvedFailedModalPayments.length === 1 ? '' : 's'} loaded for this bucket in the current request (tenant-wide
                    detail is capped).
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setUnresolvedFailedModalBucketKey(null)}
                  className="rounded-lg p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700 shrink-0"
                  aria-label="Close"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="mt-4">
                <AuditDrilldownTable
                  rows={unresolvedFailedModalPayments}
                  breakdownTab={null}
                  formatCurrency={formatCurrency}
                  onMemberClick={(id, tab) => void openMemberManagementModal(id, tab)}
                  onGroupClick={navigateToGroupForBilling}
                  hideGroupNameColumn
                />
              </div>
            </div>
          </div>
        </div>
      )}

      <MissingRecurringOutreachModal
        open={missingRecurringOutreachOpen}
        onClose={() => setMissingRecurringOutreachOpen(false)}
        tenantIdHeader={isSysAdmin ? effectiveTenantId : undefined}
        memberPortalLoginUrl={memberPortalLoginUrl}
        tenantName={outreachTenantName}
        supportEmail={outreachSupportEmail}
        manualEmails={missingRecurringManualEmails}
        manualPhones={missingRecurringManualPhones}
        rowsWithoutEmail={missingRecurringRowsWithoutEmail}
        rowsWithoutPhone={missingRecurringRowsWithoutPhone}
        onSent={(data) => {
          toast.success(
            `Sent ${data.emailsQueued} email(s), ${data.smsQueued} SMS. Est. SMS cost $${data.estimatedCost.toFixed(2)}`
          );
        }}
      />

      <MissingRecurringSetupModal
        open={missingRecurringSetupOpen}
        onClose={() => setMissingRecurringSetupOpen(false)}
        currentRole={currentRole}
        tenantId={isSysAdmin ? effectiveTenantId : undefined}
        memberIds={missingRecurringMemberIds}
        onComplete={() => {
          toast.success('Recurring setup run finished. Reloading list…');
          void loadAuditBreakdownData('missing_recurring');
        }}
      />

      <BillingAuditReportEmailsModal
        open={auditReportEmailsModalOpen}
        onClose={() => setAuditReportEmailsModalOpen(false)}
        currentRole={currentRole}
        tenantId={isSysAdmin ? effectiveTenantId : undefined}
      />

      <BillingDriftModal
        open={billingDriftModalOpen}
        onClose={() => setBillingDriftModalOpen(false)}
      />

      <BillingRunAuditsModal
        isOpen={runAuditsOpen}
        onClose={() => !runAuditsLoading && setRunAuditsOpen(false)}
        runAuditsSelections={runAuditsSelections}
        setRunAuditsSelections={setRunAuditsSelections}
        runAuditsStart={runAuditsStart}
        setRunAuditsStart={setRunAuditsStart}
        runAuditsEnd={runAuditsEnd}
        setRunAuditsEnd={setRunAuditsEnd}
        runAuditsDimeScope={runAuditsDimeScope}
        setRunAuditsDimeScope={setRunAuditsDimeScope}
        runAuditsHoursBack={runAuditsHoursBack}
        setRunAuditsHoursBack={setRunAuditsHoursBack}
        runAuditsSuccessRecheckDays={runAuditsSuccessRecheckDays}
        setRunAuditsSuccessRecheckDays={setRunAuditsSuccessRecheckDays}
        runAuditsSecondaryLimit={runAuditsSecondaryLimit}
        setRunAuditsSecondaryLimit={setRunAuditsSecondaryLimit}
        runAuditsLimit={runAuditsLimit}
        setRunAuditsLimit={setRunAuditsLimit}
        runAuditsDryRun={runAuditsDryRun}
        setRunAuditsDryRun={setRunAuditsDryRun}
        runAuditsPersist={runAuditsPersist}
        setRunAuditsPersist={setRunAuditsPersist}
        runAuditsLoading={runAuditsLoading}
        runAuditsResult={runAuditsResult}
        onRun={executeRunAudits}
      />


      {selectedMemberForModal && (
        <MemberManagementModal
          key={`${selectedMemberForModal.MemberId}-${memberModalInitialTab ?? 'overview'}`}
          member={selectedMemberForModal}
          householdMembers={memberModalHousehold}
          memberEnrollments={memberModalEnrollments}
          enrollmentsLoading={memberModalEnrollmentsLoading}
          initialTab={memberModalInitialTab ?? undefined}
          onClose={() => {
            setSelectedMemberForModal(null);
            setMemberModalHousehold([]);
            setMemberModalEnrollments([]);
            setMemberModalInitialTab(null);
          }}
          onEdit={() => {}}
          formatCurrency={formatCurrency}
          getStatusColor={getStatusColor}
          getRelationshipIcon={getRelationshipIcon}
          getRelationshipColor={getRelationshipColor}
          canEdit={false}
          canDelete={false}
        />
      )}
    </div>
  );
};

export default TenantBilling;