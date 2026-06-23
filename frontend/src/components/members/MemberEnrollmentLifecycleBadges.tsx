import {
  Calendar,
  CheckCircle,
  Clock,
  Link2,
  LogIn,
  Send,
  UserPlus,
  UserX,
  XCircle,
  Package,
} from 'lucide-react';
import React from 'react';
import { Member } from '../../types/member.types';
import { formatRelativeTimeAgo } from '../../utils/formatRelativeTimeAgo';
import { getMemberEffectiveDateInfo } from '../../utils/memberEffectiveDateDisplay';

function enrollmentLinkSentAtRaw(m: Member): string | null | undefined {
  const row = m as Member & { enrollmentLinkSentAt?: string | null };
  return m.EnrollmentLinkSentAt ?? row.enrollmentLinkSentAt ?? null;
}

function enrollmentLifecycleVisual(enrollmentStatus: string | undefined) {
  if (!enrollmentStatus) return null;
  switch (enrollmentStatus) {
    case 'Enrolled':
      return {
        label: 'Enrolled',
        Icon: CheckCircle,
        className: 'bg-green-100 text-green-800 border border-green-200',
      };
    case 'Enrollment Link Sent':
      return {
        label: 'Enrollment Link Sent',
        Icon: Send,
        className: 'bg-blue-100 text-blue-800 border border-blue-200',
      };
    case 'Enrollment Link Used':
      return {
        label: 'Enrollment Link Used',
        Icon: Link2,
        className: 'bg-indigo-100 text-indigo-800 border border-indigo-200',
      };
    case 'Pending Login':
      return {
        label: 'Pending Login',
        Icon: LogIn,
        className: 'bg-yellow-100 text-yellow-900 border border-yellow-300',
      };
    case 'Pending Approval':
      return {
        label: 'Pending Approval',
        Icon: Clock,
        className: 'bg-amber-100 text-amber-800 border border-amber-200',
      };
    case 'Declined Coverage':
      return {
        label: 'Declined Coverage',
        Icon: XCircle,
        className: 'bg-red-100 text-red-800 border border-red-200',
      };
    case 'Pending Migration':
      return {
        label: 'Pending Migration',
        Icon: Package,
        className: 'bg-violet-100 text-violet-900 border border-violet-300',
      };
    case 'Terminated':
      return {
        label: 'Terminated',
        Icon: XCircle,
        className: 'bg-gray-200 text-gray-800 border border-gray-300',
      };
    case 'Not Enrolled':
      return {
        label: 'Not Enrolled',
        Icon: UserX,
        className: 'bg-gray-100 text-gray-700 border border-gray-200',
      };
    default:
      return {
        label: enrollmentStatus,
        Icon: UserX,
        className: 'bg-gray-100 text-gray-700 border border-gray-200',
      };
  }
}

function shouldShowEnrollmentLifecycleBadge(member: Member): boolean {
  const es = member.EnrollmentStatus;
  if (!es) return false;
  if (member.Status === 'Terminated' && es === 'Terminated') return false;
  return true;
}

type Props = {
  member: Member;
  getStatusColor: (status: string) => string;
  /** When false, omit the calendar "plan goes into effect in X days" chip (e.g. modal header). */
  showEffectiveDateBadge?: boolean;
  iconSizeClass?: string;
};

/**
 * Member record status (when not Active) + enrollment lifecycle + optional future-effective-date chip.
 */
export const MemberEnrollmentLifecycleBadges: React.FC<Props> = ({
  member,
  getStatusColor,
  showEffectiveDateBadge = true,
  iconSizeClass = 'h-3 w-3',
}) => {
  /** Avoid "Declined" (record) + "Declined Coverage" (enrollment) — show enrollment only. */
  const hideMemberStatusWhenRedundantWithLifecycle =
    member.Status === 'Declined' && member.EnrollmentStatus === 'Declined Coverage';
  const showMemberRecordStatus =
    member.Status !== 'Active' && !hideMemberStatusWhenRedundantWithLifecycle;
  const showLifecycleBase = shouldShowEnrollmentLifecycleBadge(member);
  const effectiveDateInfo = showEffectiveDateBadge ? getMemberEffectiveDateInfo(member) : null;
  const lifecycle = enrollmentLifecycleVisual(member.EnrollmentStatus);

  const addedAgo = member.CreatedDate ? formatRelativeTimeAgo(member.CreatedDate) : null;
  const addedTitle = member.CreatedDate ? new Date(member.CreatedDate).toLocaleString() : undefined;
  // Header: prefer a single timing/status chip — hide "Added" when link-sent, future-effective-date shows, or lifecycle shows Enrolled (Overview tab still lists Added).
  const showAddedChipInHeader =
    addedAgo != null &&
    member.EnrollmentStatus !== 'Enrollment Link Sent' &&
    member.EnrollmentStatus !== 'Enrolled' &&
    member.EnrollmentStatus !== 'Declined Coverage' &&
    !effectiveDateInfo?.text;
  // "Added · …" already conveys new member context; do not also show "Not Enrolled".
  const showLifecycleChip =
    showLifecycleBase &&
    !(effectiveDateInfo?.text && member.EnrollmentStatus === 'Enrolled') &&
    !(showAddedChipInHeader && member.EnrollmentStatus === 'Not Enrolled');
  const addedChip = showAddedChipInHeader ? (
    <span
      className="inline-flex items-center px-2 py-1 text-xs font-medium rounded-full bg-slate-100 text-slate-700 border border-slate-200"
      title={addedTitle}
    >
      <UserPlus className={`${iconSizeClass} mr-1 shrink-0`} aria-hidden />
      Added · {addedAgo}
    </span>
  ) : null;

  if (!showMemberRecordStatus && !showLifecycleChip && !effectiveDateInfo?.text) {
    if (member.Status === 'Active') {
      return (
        <>
          <span
            className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${getStatusColor('Active')}`}
          >
            Active
          </span>
          {addedChip}
        </>
      );
    }
    return null;
  }

  return (
    <>
      {showMemberRecordStatus && (
        <span
          className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(member.Status)}`}
        >
          {member.Status}
        </span>
      )}
      {showLifecycleChip && lifecycle && (() => {
        const LifecycleIcon = lifecycle.Icon;
        const sentRaw = enrollmentLinkSentAtRaw(member);
        const sentAgo =
          member.EnrollmentStatus === 'Enrollment Link Sent'
            ? formatRelativeTimeAgo(sentRaw ?? undefined)
            : null;
        const sentTitle =
          member.EnrollmentStatus === 'Enrollment Link Sent' && sentRaw
            ? new Date(sentRaw).toLocaleString()
            : undefined;
        return (
          <span
            className={`inline-flex items-center px-2 py-1 text-xs font-semibold rounded-full ${lifecycle.className}`}
            title={sentTitle}
          >
            <LifecycleIcon className={`${iconSizeClass} mr-1 shrink-0`} aria-hidden />
            <span>{lifecycle.label}</span>
            {sentAgo ? (
              <span className="ml-1 font-normal text-blue-900/85">· {sentAgo}</span>
            ) : null}
          </span>
        );
      })()}
      {effectiveDateInfo?.text && (
        <span
          className={`inline-flex items-center px-2 py-1 text-xs font-semibold rounded-full ${
            effectiveDateInfo.days <= 7
              ? 'bg-amber-100 text-amber-800 border border-amber-400'
              : effectiveDateInfo.days <= 30
                ? 'bg-blue-100 text-blue-800 border border-blue-400'
                : 'bg-indigo-100 text-indigo-800 border border-indigo-400'
          }`}
        >
          <Calendar className={`${iconSizeClass} mr-1 shrink-0`} aria-hidden />
          {effectiveDateInfo.text}
        </span>
      )}
      {addedChip}
    </>
  );
};
