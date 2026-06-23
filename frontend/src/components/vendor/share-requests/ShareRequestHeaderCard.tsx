import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, CircleAlert, Mail, UserCheck, UserPlus, UserX } from 'lucide-react';
import { apiService } from '../../../services/api.service';
import { useAuth } from '../../../contexts/AuthContext';
import { shareRequestClaimService } from '../../../services/share-request-claim.service';
import { shareRequestStatusService } from '../../../services/share-request-status.service';
import {
  type ClaimerOption,
  type ShareRequest,
  type ShareRequestDetailResponse,
  type ShareRequestHeaderPlan,
  type ShareRequestHeaderPlanResponse,
  type ShareRequestStatus,
  SHARE_REQUEST_STATUSES,
  STATUS_COLORS,
} from '../../../types/shareRequest.types';
import { getUserColorStyle } from '../../../types/userColor';
import Skeleton from '../ui/Skeleton';
import ComposeNewModal from '../inbox/ComposeNewModal';
import ClosingNoteModal from './ClosingNoteModal';
import { requestForName } from '../../../utils/shareRequestPatient';

// Terminal statuses that prompt the care team for a member-facing closing note.
const TERMINAL_STATUSES: ShareRequestStatus[] = ['Completed', 'Denied', 'Withdrawn'];

interface ShareRequestHeaderCardProps {
  shareRequestId: string;
  /** Bumped by the workspace whenever any claim mutation occurs (rail or header). */
  claimVersion: number;
  /** Called after the header performs a claim mutation so other panels re-fetch. */
  onClaimMutated: () => void;
}

type HeaderState =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; request: ShareRequest; headerPlan: ShareRequestHeaderPlan | null };

const fmtDate = (value: string | null | undefined) => {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
};

const text = (value: string | null | undefined) => (value && value.trim() ? value : '—');

const norm = (s?: string | null) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const ShareRequestHeaderCard = ({
  shareRequestId,
  claimVersion,
  onClaimMutated,
}: ShareRequestHeaderCardProps) => {
  const { user } = useAuth();
  const currentUserId = user?.userId;
  const isVendorAdmin = Array.isArray(user?.roles) && user!.roles.includes('VendorAdmin');

  const [state, setState] = useState<HeaderState>({ state: 'loading' });
  const [claimBusy, setClaimBusy] = useState(false);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [claimers, setClaimers] = useState<ClaimerOption[]>([]);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  // Terminal status awaiting a member-facing closing note (modal open when set).
  const [pendingStatus, setPendingStatus] = useState<ShareRequestStatus | null>(null);
  // Keep last good payload across refetches so a quick SR-switch doesn't blank the header.
  const lastGoodRef = useRef<HeaderState | null>(null);
  // Bumps when the user updates their profile (PreferredColor) so the
  // header's "Claimed by you" pill repaints with the new hex.
  const [profileVersion, setProfileVersion] = useState(0);
  const [showCompose, setShowCompose] = useState(false);

  useEffect(() => {
    const handler = () => setProfileVersion((v) => v + 1);
    window.addEventListener('oe-user-profile-updated', handler);
    return () => window.removeEventListener('oe-user-profile-updated', handler);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    setState(lastGoodRef.current ?? { state: 'loading' });

    (async () => {
      try {
        const [detail, headerPlanResp] = await Promise.all([
          apiService.get<ShareRequestDetailResponse>(
            `/api/me/vendor/share-requests/${shareRequestId}`,
            { signal: controller.signal }
          ),
          apiService.get<ShareRequestHeaderPlanResponse>(
            `/api/me/vendor/share-requests/${shareRequestId}/header-plan`,
            { signal: controller.signal }
          ).catch(() => ({ success: false, data: null })),
        ]);

        if (cancelled || controller.signal.aborted) return;

        if (!detail.success) {
          setState({ state: 'error', message: 'Failed to load share request' });
          return;
        }

        const headerPlan = headerPlanResp.success ? headerPlanResp.data : null;
        const ready: HeaderState = {
          state: 'ready',
          request: detail.data,
          headerPlan,
        };
        lastGoodRef.current = ready;
        setState(ready);
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setState({
          state: 'error',
          message: err instanceof Error ? err.message : 'Failed to load share request',
        });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [shareRequestId, claimVersion, profileVersion]);

  // Lazy-load claimers when admin opens the reassign picker.
  // Also refresh whenever any claim mutation happens so counts stay fresh.
  useEffect(() => {
    if (!reassignOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await shareRequestClaimService.getClaimers();
        if (!cancelled) setClaimers(data);
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reassignOpen, claimVersion]);

  const handleUnclaim = useCallback(async () => {
    setClaimBusy(true);
    try {
      await shareRequestClaimService.unclaim(shareRequestId);
      onClaimMutated();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to unassign');
    } finally {
      setClaimBusy(false);
    }
  }, [shareRequestId, onClaimMutated]);

  const handleReassign = useCallback(
    async (targetUserId: string) => {
      if (!targetUserId) return;
      setClaimBusy(true);
      try {
        await shareRequestClaimService.reassign(shareRequestId, targetUserId);
        setReassignOpen(false);
        onClaimMutated();
      } catch (err) {
        window.alert(err instanceof Error ? err.message : 'Failed to reassign');
      } finally {
        setClaimBusy(false);
      }
    },
    [shareRequestId, onClaimMutated]
  );

  if (state.state === 'loading') {
    return (
      <div className="bg-white border-b border-gray-200 px-4 sm:px-6 py-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 lg:gap-6">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-36" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (state.state === 'error') {
    return (
      <div className="bg-white border-b border-gray-200 px-4 sm:px-6 py-4">
        <div className="flex items-center gap-2 text-sm text-red-600">
          <CircleAlert className="h-4 w-4" />
          <span>{state.message}</span>
        </div>
      </div>
    );
  }

  const { request, headerPlan } = state;
  const memberFullName = `${request.MemberFirstName ?? ''} ${request.MemberLastName ?? ''}`.trim();
  const memberHref = request.MemberId ? `/vendor/members/${request.MemberId}` : undefined;
  const status = request.Status;
  const statusColors = STATUS_COLORS[status] ?? STATUS_COLORS.New;
  const canEditStatus = isVendorAdmin || (Array.isArray(user?.roles) && user!.roles.includes('VendorAgent'));

  // Persist a status change. For terminal statuses, memberOutcomeNote carries the
  // care team's member-facing explanation (empty string clears it).
  const applyStatus = async (next: ShareRequestStatus, memberOutcomeNote?: string) => {
    setStatusBusy(true);
    setStatusError(null);
    try {
      await shareRequestStatusService.update(
        shareRequestId,
        memberOutcomeNote !== undefined ? { status: next, memberOutcomeNote } : { status: next }
      );
      setPendingStatus(null);
      // Refetch via the claim version channel — same channel used for claim
      // mutations, which is also what the workspace listens on. Avoids a
      // dedicated refresh prop.
      onClaimMutated();
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Failed to update status');
    } finally {
      setStatusBusy(false);
    }
  };

  const handleStatusChange = async (next: ShareRequestStatus) => {
    if (!next || next === status) return;
    // Terminal statuses prompt for a member-facing closing note before saving.
    if (TERMINAL_STATUSES.includes(next)) {
      setStatusError(null);
      setPendingStatus(next);
      return;
    }
    await applyStatus(next);
  };
  const planLabel = headerPlan?.PlanLabel ?? '—';
  const tier = headerPlan?.TierType ?? '—';
  const ua = headerPlan?.UAValue ?? '—';

  const isClaimed = !!request.ClaimedByUserId;
  const isOwnClaim = isClaimed && request.ClaimedByUserId === currentUserId;
  const claimerName = isClaimed
    ? `${request.ClaimedByFirstName ?? ''} ${
        request.ClaimedByLastName ? `${request.ClaimedByLastName.charAt(0).toUpperCase()}.` : ''
      }`.trim() || 'another user'
    : null;
  const claimerColor = getUserColorStyle(request.ClaimedByColor);

  const renderAssignSelect = (ariaLabel: string) => (
    <select
      autoFocus
      defaultValue=""
      onChange={(e) => handleReassign(e.target.value)}
      onBlur={() => setReassignOpen(false)}
      disabled={claimBusy}
      className="px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-oe-primary"
      aria-label={ariaLabel}
    >
      <option value="" disabled>
        Pick a user…
      </option>
      {claimers.map((c) => {
        const lastInitial = c.lastName ? `${c.lastName.charAt(0).toUpperCase()}.` : '';
        const label = `${c.firstName ?? ''} ${lastInitial} — (${c.claimedCount})`.trim();
        return (
          <option
            key={c.userId}
            value={c.userId}
            className={c.claimedCount === 0 ? 'text-gray-400' : ''}
          >
            {label}
          </option>
        );
      })}
    </select>
  );

  return (
    <header
      className="bg-white border-b border-gray-200 px-4 sm:px-6 py-4 shrink-0"
      aria-live="polite"
    >
      {/* Claim bar */}
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        {!isClaimed && (
          <>
            <span className="inline-flex items-center gap-1 text-gray-500">
              <UserPlus className="h-3.5 w-3.5" />
              Unassigned
            </span>
            {isVendorAdmin && (
              <>
                <button
                  type="button"
                  onClick={() => setReassignOpen((v) => !v)}
                  disabled={claimBusy}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md border border-oe-primary text-oe-dark bg-white hover:bg-oe-light disabled:opacity-50"
                >
                  <UserPlus className="h-3.5 w-3.5" />
                  {claimBusy ? 'Working…' : 'Assign…'}
                </button>
                {reassignOpen && renderAssignSelect('Assign to user')}
              </>
            )}
          </>
        )}

        {isClaimed && isOwnClaim && (
          <>
            <span
              style={claimerColor.style}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${claimerColor.className}`}
            >
              <UserCheck className="h-3.5 w-3.5" />
              Assigned to you
            </span>
            {isVendorAdmin && (
              <>
                <button
                  type="button"
                  onClick={() => setReassignOpen((v) => !v)}
                  disabled={claimBusy}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-oe-dark hover:bg-oe-light rounded disabled:opacity-50"
                >
                  Reassign…
                </button>
                {reassignOpen && renderAssignSelect('Reassign to user')}
                <button
                  type="button"
                  onClick={handleUnclaim}
                  disabled={claimBusy}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-gray-600 hover:text-red-600 hover:bg-red-50 rounded disabled:opacity-50"
                >
                  <UserX className="h-3.5 w-3.5" />
                  Unassign
                </button>
              </>
            )}
          </>
        )}

        {isClaimed && !isOwnClaim && (
          <>
            <span className="inline-flex items-center gap-1 text-gray-600">
              <span className="text-gray-500">Assigned to</span>
              <span
                style={claimerColor.style}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${claimerColor.className}`}
              >
                <UserCheck className="h-3.5 w-3.5" />
                {claimerName}
              </span>
            </span>
            {isVendorAdmin && (
              <>
                <button
                  type="button"
                  onClick={() => setReassignOpen((v) => !v)}
                  disabled={claimBusy}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-oe-dark hover:bg-oe-light rounded disabled:opacity-50"
                >
                  Reassign…
                </button>
                <button
                  type="button"
                  onClick={handleUnclaim}
                  disabled={claimBusy}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-gray-600 hover:text-red-600 hover:bg-red-50 rounded disabled:opacity-50"
                >
                  <UserX className="h-3.5 w-3.5" />
                  Unassign
                </button>
                {reassignOpen && renderAssignSelect('Reassign to user')}
              </>
            )}
          </>
        )}
        <button
          type="button"
          onClick={() => setShowCompose(true)}
          className="ml-auto inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md bg-oe-primary text-white hover:bg-oe-dark"
        >
          <Mail className="h-3.5 w-3.5" />
          Email member
        </button>
      </div>

      <ComposeNewModal
        open={showCompose}
        onClose={() => setShowCompose(false)}
        onSent={() => setShowCompose(false)}
        prefill={{
          to: request.MemberEmail ?? '',
          toName: memberFullName,
          memberId: request.MemberId,
          shareRequestId,
          lockMember: true,
        }}
      />

      <ClosingNoteModal
        open={pendingStatus !== null}
        status={pendingStatus}
        initialNote={request.MemberOutcomeNote ?? ''}
        busy={statusBusy}
        onClose={() => setPendingStatus(null)}
        onSubmit={(note) => {
          if (pendingStatus) void applyStatus(pendingStatus, note);
        }}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 lg:gap-6">
        <Column label="Membership">
          <RequestForField
            submissionPatient={request.PatientName}
            requestName={request.RequestName}
            primaryName={memberFullName}
            relation={request.PatientRelationToPrimary}
          />
          <Field label="Primary holder" value={memberFullName || '—'} to={memberHref} />
          <Field label="Member #" value={request.MemberNumber} to={memberHref} />
          <Field label="Phone" value={request.MemberPhone} />
          <Field label="Email" value={request.MemberEmail} />
        </Column>

        <Column label="Request">
          <Field label="Request" value={request.RequestNumber} mono />
          <Field label="Submitted" value={fmtDate(request.SubmittedDate)} />
          <Field label="Determination" value={request.Determination} />
          <div className="text-sm text-gray-700 flex items-center gap-2 mt-0.5">
            <span className="text-gray-500 w-28 shrink-0">Status</span>
            {canEditStatus ? (
              <span className="relative inline-flex items-center">
                <select
                  value={status}
                  disabled={statusBusy}
                  onChange={(e) => handleStatusChange(e.target.value as ShareRequestStatus)}
                  className={`appearance-none pl-2 pr-6 py-0.5 rounded-full text-xs font-medium border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-oe-primary disabled:opacity-60 ${statusColors.bg} ${statusColors.text}`}
                  aria-label="Change status"
                  title="Change status"
                >
                  {SHARE_REQUEST_STATUSES.map((s) => (
                    <option key={s} value={s} className="bg-white text-gray-900">
                      {s}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  className={`h-3 w-3 absolute right-1.5 pointer-events-none ${statusColors.text}`}
                />
              </span>
            ) : (
              <span
                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${statusColors.bg} ${statusColors.text}`}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
                {status}
              </span>
            )}
            {statusBusy && (
              <span className="text-[11px] text-gray-500">Saving…</span>
            )}
            {statusError && (
              <span className="text-[11px] text-red-600 inline-flex items-center gap-1">
                <CircleAlert className="h-3 w-3" />
                {statusError}
              </span>
            )}
          </div>
        </Column>

        <Column label="Current Plan">
          <Field label="Plan" value={planLabel} />
          <Field label="UA" value={ua} />
          <Field label="Tier" value={tier} />
          <Field label="Effective" value={fmtDate(headerPlan?.EffectiveDate)} />
        </Column>
      </div>
    </header>
  );
};

interface ColumnProps {
  label: string;
  children: ReactNode;
}
const Column = ({ label, children }: ColumnProps) => (
  <div className="min-w-0">
    <div className="text-[11px] font-semibold uppercase tracking-wider text-oe-primary border-b border-oe-light pb-1 mb-2">
      {label}
    </div>
    <div className="space-y-1">{children}</div>
  </div>
);

interface FieldProps {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  /** When provided and the value is present, render the value as a link. */
  to?: string;
}
const Field = ({ label, value, mono = false, to }: FieldProps) => {
  const hasValue = !!(value && value.trim());
  return (
    <div className="text-sm flex items-start gap-2 min-w-0">
      <span className="text-gray-500 w-28 shrink-0">{label}</span>
      {to && hasValue ? (
        <Link
          to={to}
          className={`truncate min-w-0 flex-1 text-oe-primary hover:text-oe-dark hover:underline ${mono ? 'font-mono text-[13px]' : ''}`}
          title={text(value)}
        >
          {text(value)}
        </Link>
      ) : (
        <span
          className={`text-gray-900 truncate min-w-0 flex-1 ${mono ? 'font-mono text-[13px]' : ''}`}
          title={text(value)}
        >
          {text(value)}
        </span>
      )}
    </div>
  );
};

// "Request for" — who the request is about. Shows the captured name when it looks
// like an actual person (the patient — often a dependent), otherwise falls back to
// the primary holder. Emphasised + relation badge when it differs from the primary.
interface RequestForFieldProps {
  submissionPatient?: string | null;
  requestName?: string | null;
  primaryName: string;
  relation?: string | null;
}
const RequestForField = ({ submissionPatient, requestName, primaryName, relation }: RequestForFieldProps) => {
  const name = requestForName({ patientName: submissionPatient, requestName, memberFirstName: primaryName }) || '—';
  const rel = (relation ?? '').trim().toLowerCase();
  const namesMatch = norm(name) === norm(primaryName);
  const isSelf = rel === 'self' || (!rel && namesMatch);
  const relLabel = rel && rel !== 'self' ? cap(rel) : !isSelf ? 'Dependent' : null;
  return (
    <div className="text-sm flex items-start gap-2 min-w-0">
      <span className="text-gray-500 w-28 shrink-0">Request for</span>
      <span className="min-w-0 flex-1 flex items-center gap-1.5">
        <span
          className={`truncate min-w-0 ${isSelf ? 'text-gray-900' : 'text-oe-dark font-semibold'}`}
          title={name}
        >
          {name}
        </span>
        {isSelf ? (
          <span className="shrink-0 text-xs text-gray-400">(self)</span>
        ) : relLabel ? (
          <span className="shrink-0 inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-oe-light text-oe-dark">
            {relLabel}
          </span>
        ) : null}
      </span>
    </div>
  );
};

export default ShareRequestHeaderCard;
