// Header for the Support ticket detail page. Mirrors ShareRequestHeaderCard:
// - top assignment bar (Unassigned / Assigned-to-you / Assigned-to-other with
//   reassign/unclaim affordances)
// - 3-column meta grid (Membership / Ticket / Tracking)
// - status rendered as a colored <select> (pill) so users change status
//   with a single click. Colors come from STATUS_COLORS.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, CircleAlert, Mail, UserCheck, UserPlus, UserX } from 'lucide-react';
import { apiService } from '../../../services/api.service';
import TpaForwardPreviewModal from './TpaForwardPreviewModal';
import ComposeNewModal from '../inbox/ComposeNewModal';
import { useAuth } from '../../../contexts/AuthContext';
import {
  type CaseRow,
  type CaseStatus,
  CASE_STATUSES,
  STATUS_COLORS,
} from '../../../types/case.types';
import { useCaseTaxonomy } from '../../../hooks/useCaseTaxonomy';
import { getUserColorStyle } from '../../../types/userColor';
import Skeleton from '../ui/Skeleton';

interface CaseHeaderCardProps {
  caseId: string;
  /** Bumped externally whenever any claim or status mutation happens. */
  refreshVersion: number;
  /** Called after a mutation so other panels (rail) re-fetch. */
  onMutated: () => void;
}

interface DetailResp { success: boolean; data: CaseRow }
interface ClaimerOption {
  userId: string;
  firstName: string | null;
  lastName: string | null;
  claimedCount: number;
}
interface ClaimersResp { success: boolean; data: ClaimerOption[] }

type HeaderState =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; row: CaseRow };

const fmtDate = (value: string | null | undefined) => {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
};

const text = (v: string | null | undefined) => (v && v.trim() ? v : '—');

const CaseHeaderCard = ({ caseId, refreshVersion, onMutated }: CaseHeaderCardProps) => {
  const { typeLabel, subcategoryLabel } = useCaseTaxonomy();
  const { user } = useAuth();
  const currentUserId = user?.userId;
  const isVendorAdmin = Array.isArray(user?.roles) && user!.roles.includes('VendorAdmin');

  const [state, setState] = useState<HeaderState>({ state: 'loading' });
  const [claimBusy, setClaimBusy] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [forwardOpen, setForwardOpen] = useState(false);
  const [showCompose, setShowCompose] = useState(false);
  const [claimers, setClaimers] = useState<ClaimerOption[]>([]);
  // Keep last good payload across refetches so a quick ticket-switch doesn't blank the header.
  const lastGoodRef = useRef<HeaderState | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    let cancelled = false;
    setState(lastGoodRef.current ?? { state: 'loading' });

    (async () => {
      try {
        const resp = await apiService.get<DetailResp>(
          `/api/me/vendor/cases/${caseId}`,
          { signal: ac.signal }
        );
        if (cancelled || ac.signal.aborted) return;
        if (resp.success) {
          const ready: HeaderState = { state: 'ready', row: resp.data };
          lastGoodRef.current = ready;
          setState(ready);
        } else {
          setState({ state: 'error', message: 'Failed to load ticket' });
        }
      } catch (err) {
        if (cancelled || ac.signal.aborted) return;
        setState({
          state: 'error',
          message: err instanceof Error ? err.message : 'Failed to load ticket',
        });
      }
    })();
    return () => { cancelled = true; ac.abort(); };
  }, [caseId, refreshVersion]);

  // Lazy-load claimers when admin opens reassign.
  useEffect(() => {
    if (!reassignOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await apiService.get<ClaimersResp>('/api/me/vendor/cases/claimers');
        if (!cancelled && resp.success) setClaimers(resp.data);
      } catch {
        /* non-fatal */
      }
    })();
    return () => { cancelled = true; };
  }, [reassignOpen, refreshVersion]);


  const handleUnclaim = useCallback(async () => {
    setClaimBusy(true);
    try {
      await apiService.delete(`/api/me/vendor/cases/${caseId}/claim`);
      onMutated();
    } catch (err) {
       
      window.alert(err instanceof Error ? err.message : 'Failed to unassign');
    } finally {
      setClaimBusy(false);
    }
  }, [caseId, onMutated]);

  const handleReassign = useCallback(async (newUserId: string) => {
    if (!newUserId) return;
    setClaimBusy(true);
    setReassignOpen(false);
    try {
      await apiService.put(`/api/me/vendor/cases/${caseId}/claim`, { claimedByUserId: newUserId });
      onMutated();
    } catch (err) {
       
      window.alert(err instanceof Error ? err.message : 'Failed to reassign');
    } finally {
      setClaimBusy(false);
    }
  }, [caseId, onMutated]);

  const handleStatusChange = useCallback(async (next: CaseStatus) => {
    if (state.state !== 'ready') return;
    if (!next || next === state.row.Status) return;
    setStatusBusy(true);
    setStatusError(null);
    try {
      await apiService.put(`/api/me/vendor/cases/${caseId}/status`, { status: next });
      onMutated();
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Failed to update status');
    } finally {
      setStatusBusy(false);
    }
  }, [caseId, state, onMutated]);

  if (state.state === 'loading') {
    return (
      <div className="bg-white border-b border-gray-200 px-4 sm:px-6 py-4 shrink-0 space-y-3">
        <Skeleton className="h-5 w-40" />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
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

  const { row } = state;
  const memberFullName = `${row.MemberFirstName ?? ''} ${row.MemberLastName ?? ''}`.trim();
  const memberHref = row.MemberId ? `/vendor/members/${row.MemberId}` : undefined;
  const status = row.Status;
  const sc = STATUS_COLORS[status] ?? { bg: 'bg-gray-100', text: 'text-gray-800' };
  const canEditStatus = isVendorAdmin || (Array.isArray(user?.roles) && user!.roles.includes('VendorAgent'));

  const isClaimed = !!row.ClaimedByUserId;
  const isOwnClaim = isClaimed && row.ClaimedByUserId === currentUserId;
  const claimerName = isClaimed
    ? `${row.ClaimedByFirstName ?? ''} ${
        row.ClaimedByLastName ? `${row.ClaimedByLastName.charAt(0).toUpperCase()}.` : ''
      }`.trim() || 'another user'
    : null;
  const claimerColor = getUserColorStyle(row.ClaimedByColor);

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
      <option value="" disabled>Pick a user…</option>
      {claimers.map((c) => {
        const lastInitial = c.lastName ? `${c.lastName.charAt(0).toUpperCase()}.` : '';
        const label = `${c.firstName ?? ''} ${lastInitial} — (${c.claimedCount})`.trim();
        return (
          <option key={c.userId} value={c.userId} className={c.claimedCount === 0 ? 'text-gray-400' : ''}>
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

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowCompose(true)}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md bg-oe-primary text-white hover:bg-oe-dark"
          >
            <Mail className="h-3.5 w-3.5" />
            Email member
          </button>
          {row.ForwardingTarget && (
            <button
              type="button"
              onClick={() => setForwardOpen(true)}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md border border-oe-primary text-oe-dark bg-white hover:bg-oe-light"
            >
              <Mail className="h-3.5 w-3.5" />
              Generate Email Report
            </button>
          )}
        </div>
      </div>

      <ComposeNewModal
        open={showCompose}
        onClose={() => setShowCompose(false)}
        onSent={() => setShowCompose(false)}
        prefill={{
          to: row.MemberEmail ?? '',
          toName: memberFullName,
          memberId: row.MemberId,
          caseId,
          lockMember: true,
        }}
      />

      {row.ForwardingTarget && (
        <TpaForwardPreviewModal
          caseId={caseId}
          isOpen={forwardOpen}
          onClose={() => setForwardOpen(false)}
        />
      )}

      {/* Meta grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 lg:gap-6">
        <Column label="Membership">
          <Field label="Name" value={memberFullName || '—'} to={memberHref} />
          <Field label="Member #" value={row.MemberNumber} mono to={memberHref} />
          <Field label="Email" value={row.MemberEmail} />
          <Field label="Phone" value={row.MemberPhone} />
          <Field label="DOB" value={fmtDate(row.MemberDOB)} />
        </Column>

        <Column label="Ticket">
          <Field label="Case #" value={row.CaseNumber} mono />
          <Field
            label="Type"
            value={
              row.CaseSubcategory
                ? `${typeLabel(row.CaseType)} — ${subcategoryLabel(row.CaseSubcategory)}`
                : typeLabel(row.CaseType)
            }
          />
          <Field label="Submitted" value={fmtDate(row.SubmittedDate)} />
          <Field label="Title" value={row.Title} />
          <div className="text-sm text-gray-700 flex items-center gap-2 mt-0.5">
            <span className="text-gray-500 w-28 shrink-0">Status</span>
            {canEditStatus ? (
              <span className="relative inline-flex items-center">
                <select
                  value={status}
                  disabled={statusBusy}
                  onChange={(e) => handleStatusChange(e.target.value as CaseStatus)}
                  className={`appearance-none pl-2 pr-6 py-0.5 rounded-full text-xs font-medium border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-oe-primary disabled:opacity-60 ${sc.bg} ${sc.text}`}
                  aria-label="Change status"
                  title="Change status"
                >
                  {CASE_STATUSES.map((s) => (
                    <option key={s} value={s} className="bg-white text-gray-900">
                      {s}
                    </option>
                  ))}
                </select>
                <ChevronDown className={`h-3 w-3 absolute right-1.5 pointer-events-none ${sc.text}`} />
              </span>
            ) : (
              <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${sc.bg} ${sc.text}`}>
                <span className="h-1.5 w-1.5 rounded-full bg-current" />
                {status}
              </span>
            )}
            {statusBusy && <span className="text-[11px] text-gray-500">Saving…</span>}
            {statusError && (
              <span className="text-[11px] text-red-600 inline-flex items-center gap-1">
                <CircleAlert className="h-3 w-3" />
                {statusError}
              </span>
            )}
          </div>
        </Column>

        <Column label="Tracking">
          <Field
            label="Created by"
            value={`${row.CreatedByFirstName ?? ''} ${row.CreatedByLastName ?? ''}`.trim() || '—'}
          />
          <Field label="Created" value={fmtDate(row.CreatedDate)} />
          <Field label="Last modified" value={fmtDate(row.ModifiedDate)} />
          {row.CompletedDate && <Field label="Closed" value={fmtDate(row.CompletedDate)} />}
        </Column>
      </div>
    </header>
  );
};

interface ColumnProps { label: string; children: ReactNode }
const Column = ({ label, children }: ColumnProps) => (
  <div className="min-w-0">
    <div className="text-[11px] font-semibold uppercase tracking-wider text-oe-primary border-b border-oe-light pb-1 mb-2">
      {label}
    </div>
    <div className="space-y-1">{children}</div>
  </div>
);

interface FieldProps { label: string; value: string | null | undefined; mono?: boolean; to?: string }
const Field = ({ label, value, mono = false, to }: FieldProps) => {
  const hasValue = !!(value && value.trim());
  const cls = `truncate min-w-0 flex-1 ${mono ? 'font-mono text-[13px]' : ''}`;
  return (
    <div className="text-sm flex items-start gap-2 min-w-0">
      <span className="text-gray-500 w-28 shrink-0">{label}</span>
      {to && hasValue ? (
        <Link to={to} className={`${cls} text-oe-primary hover:text-oe-dark hover:underline`} title={text(value)}>
          {text(value)}
        </Link>
      ) : (
        <span className={`${cls} text-gray-900`} title={text(value)}>
          {text(value)}
        </span>
      )}
    </div>
  );
};

export default CaseHeaderCard;
