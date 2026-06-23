// EncountersList — the shared list used in Member / Ticket / Share-Request tabs.
// Header has an "Add encounter" button that opens EncounterNewModal pre-filled
// with the scope. Rows are expandable cards (full summary on expand, plus
// actions). For the dedicated /vendor/encounters dashboard we use the
// EncounterListRail + EncounterDetailCard pair instead.

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, MessageCircle, Plus, StickyNote, Mail } from 'lucide-react';
import { apiService } from '../../../services/api.service';
import {
  channelLabel,
  directionLabel,
  type EncounterRow,
  type EncounterScope,
} from '../../../types/encounter.types';
import EmptyState from '../ui/EmptyState';
import Skeleton from '../ui/Skeleton';
import EncounterNewModal from './EncounterNewModal';
import EncounterFollowUpBadge from './EncounterFollowUpBadge';
import { useMemberModalLauncher } from '../../../hooks/useMemberModalLauncher';

interface ListResp {
  success: boolean;
  data: EncounterRow[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

interface Props { scope: EncounterScope }

const fmtDateTime = (v?: string | null) => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const buildQuery = (scope: EncounterScope): string => {
  const p = new URLSearchParams();
  p.set('limit', '100');
  if (scope.kind === 'member')        p.set('memberId', scope.memberId);
  if (scope.kind === 'case') p.set('caseId', scope.caseId);
  if (scope.kind === 'shareRequest')  p.set('shareRequestId', scope.shareRequestId);
  return p.toString();
};

const EncountersList = ({ scope }: Props) => {
  const [rows, setRows] = useState<EncounterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  // Resolved scope is the prop scope but with memberId filled in for
  // share-request scopes that arrived without one (the SR tabs don't have
  // the SR's MemberId on hand). Used as the modal's prefill so the new
  // encounter starts with the member already selected.
  const [resolvedScope, setResolvedScope] = useState<EncounterScope>(scope);
  // Don't make the member name clickable when we're already viewing that
  // member's modal — opening their own modal again would just stack two
  // copies of the same thing.
  const { openMember, MemberModalElement } = useMemberModalLauncher();
  const memberClickable = scope.kind !== 'member';

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const resp = await apiService.get<ListResp>(
        `/api/me/vendor/encounters?${buildQuery(scope)}`,
        signal ? { signal } : undefined
      );
      if (signal?.aborted) return;
      if (resp.success) setRows(resp.data);
      else setError('load_failed');
    } catch (e) {
      if (signal?.aborted) return;
      console.error('EncountersList load failed', e);
      setError('load_failed');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load, refresh]);

  // Resolve the scope's memberId. For Member + ticket scopes the caller
  // already passed MemberId. For SR scopes we fetch the request once.
  useEffect(() => {
    if (scope.kind !== 'shareRequest' || scope.memberId) {
      setResolvedScope(scope);
      return;
    }
    const ac = new AbortController();
    void (async () => {
      try {
        const resp = await apiService.get<{ success: boolean; data: { MemberId?: string } }>(
          `/api/me/vendor/share-requests/${scope.shareRequestId}`,
          { signal: ac.signal }
        );
        if (ac.signal.aborted) return;
        if (resp.success && resp.data?.MemberId) {
          setResolvedScope({ ...scope, memberId: resp.data.MemberId });
        } else {
          setResolvedScope(scope);
        }
      } catch {
        setResolvedScope(scope);
      }
    })();
    return () => ac.abort();
  }, [scope]);

  const handleCreated = useCallback((row: EncounterRow) => {
    setShowNew(false);
    setRows((prev) => [row, ...prev]);
    setExpandedId(row.EncounterId);
  }, []);

  const handleArchive = useCallback(async (encounterId: string) => {
    if (!window.confirm('Archive this encounter?')) return;
    try {
      await apiService.delete(`/api/me/vendor/encounters/${encounterId}`);
      setRows((prev) => prev.filter((r) => r.EncounterId !== encounterId));
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Failed to archive');
    }
  }, []);

  const handleCompleteFollowUp = useCallback(async (encounterId: string) => {
    try {
      await apiService.post(`/api/me/vendor/encounters/${encounterId}/follow-up/complete`, {});
      setRefresh((v) => v + 1);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Failed to complete follow-up');
    }
  }, []);

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Encounters</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Conversations with this {scope.kind === 'member' ? 'member' : scope.kind === 'case' ? 'case' : 'share request'}.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowNew(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg transition-colors"
        >
          <Plus className="h-4 w-4" />
          New encounter
        </button>
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20 w-full rounded" />)}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={MessageCircle}
          title={error ? "Couldn't load encounters" : 'No encounters yet'}
          description={error ? 'Try refreshing the page.' : 'Log the first conversation with the New Encounter button.'}
          tone="subtle"
        />
      ) : (
        <ul className="space-y-2">
          {rows.map((e) => {
            const expanded = expandedId === e.EncounterId;
            const occurred = e.OccurredAt || e.CreatedDate;
            const memberName = `${e.MemberFirstName || ''} ${e.MemberLastName || ''}`.trim();
            return (
              <li key={e.EncounterId} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setExpandedId(expanded ? null : e.EncounterId)}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter' || ev.key === ' ') {
                      ev.preventDefault();
                      setExpandedId(expanded ? null : e.EncounterId);
                    }
                  }}
                  className="w-full text-left p-3 hover:bg-gray-50/60 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-oe-primary"
                  aria-expanded={expanded}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                        <span className="font-mono font-semibold text-gray-700">{e.EncounterNumber}</span>
                        <span>·</span>
                        <span>{fmtDateTime(occurred)}</span>
                        {e.Channel && (<><span>·</span><span>{channelLabel(e.Channel)}</span></>)}
                        {e.Direction && (<><span>·</span><span>{directionLabel(e.Direction)}</span></>)}
                        {!e.MemberId && scope.kind !== 'member' && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-amber-100 text-amber-800">
                            No member
                          </span>
                        )}
                        <EncounterFollowUpBadge encounter={e} />
                      </div>
                      <p className={`text-sm text-gray-800 mt-1 ${expanded ? '' : 'line-clamp-2'} whitespace-pre-wrap`}>
                        {e.Summary}
                      </p>
                      {!expanded && (memberName || e.CreatedByName) && (
                        <div className="text-[11px] text-gray-500 mt-1">
                          {memberName && scope.kind !== 'member' && (
                            <>
                              For{' '}
                              {memberClickable && e.MemberId ? (
                                <button
                                  type="button"
                                  onClick={(ev) => {
                                    ev.stopPropagation();
                                    void openMember(e.MemberId as string);
                                  }}
                                  className="text-oe-dark hover:text-oe-primary underline-offset-2 hover:underline font-medium"
                                >
                                  {memberName}
                                </button>
                              ) : memberName}
                              {' · '}
                            </>
                          )}
                          By {e.CreatedByName || 'Unknown'}
                        </div>
                      )}
                    </div>
                    <ChevronDown className={`h-4 w-4 mt-1 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                  </div>
                </div>
                {expanded && (
                  <div className="px-3 pb-3 border-t border-gray-100 pt-3 space-y-2 text-xs text-gray-600">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1">
                      <div>
                        <span className="text-gray-500">Member: </span>
                        {memberName ? (
                          memberClickable && e.MemberId ? (
                            <button
                              type="button"
                              onClick={() => void openMember(e.MemberId as string)}
                              className="text-oe-dark hover:text-oe-primary underline-offset-2 hover:underline font-medium"
                            >
                              {memberName}
                            </button>
                          ) : memberName
                        ) : (
                          <span className="italic text-amber-700">No member</span>
                        )}
                      </div>
                      <div><span className="text-gray-500">By: </span>{e.CreatedByName || '—'}</div>
                      <div><span className="text-gray-500">Channel: </span>{channelLabel(e.Channel)}</div>
                      <div><span className="text-gray-500">Direction: </span>{directionLabel(e.Direction)}</div>
                      {e.PinnedCaseNumber && (
                        <div className="col-span-2"><span className="text-gray-500">Linked case: </span>{e.PinnedCaseNumber}</div>
                      )}
                      {e.PinnedShareRequestNumber && (
                        <div className="col-span-2">
                          <span className="text-gray-500">Linked SR: </span>
                          {e.ShareRequestId ? (
                            <Link
                              to={`/vendor/share-requests/${e.ShareRequestId}`}
                              onClick={(ev) => ev.stopPropagation()}
                              className="text-oe-dark hover:text-oe-primary underline-offset-2 hover:underline font-medium"
                            >
                              {e.PinnedShareRequestNumber}
                            </Link>
                          ) : e.PinnedShareRequestNumber}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center justify-end gap-2 pt-2">
                      {e.EmailThreadId && (
                        <Link
                          to={`/vendor/inbox/${e.EmailThreadId}`}
                          onClick={(ev) => ev.stopPropagation()}
                          className="mr-auto inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium border border-gray-300 rounded bg-white hover:bg-gray-50 text-oe-dark"
                        >
                          <Mail className="h-3.5 w-3.5" /> Go to email
                        </Link>
                      )}
                      {e.FollowUpDueDate && !e.FollowUpCompletedAt && (
                        <button
                          type="button"
                          onClick={() => handleCompleteFollowUp(e.EncounterId)}
                          className="px-2.5 py-1 text-xs border border-gray-300 rounded bg-white hover:bg-gray-50"
                        >
                          Mark follow-up done
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleArchive(e.EncounterId)}
                        className="px-2.5 py-1 text-xs text-red-600 hover:bg-red-50 rounded"
                      >
                        Archive
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <EncounterNewModal
        open={showNew}
        onClose={() => setShowNew(false)}
        onCreated={handleCreated}
        prefillScope={resolvedScope}
      />

      {MemberModalElement}

      {!loading && rows.length > 0 && (
        <p className="text-[11px] text-gray-400 inline-flex items-center gap-1">
          <StickyNote className="h-3 w-3" />
          {rows.length} encounter{rows.length === 1 ? '' : 's'}
        </p>
      )}
    </div>
  );
};

export default EncountersList;
