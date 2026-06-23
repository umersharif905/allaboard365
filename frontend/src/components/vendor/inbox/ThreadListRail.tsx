// ThreadListRail — left list for /vendor/inbox. Quick filters (All / Needs
// reply / Unlinked), search, and a manual sync button. Rows show sender,
// subject, preview, time, and derived pills.
import { useEffect, useState } from 'react';
import { Inbox, Search, RefreshCw, ChevronLeft, ChevronRight, PenLine } from 'lucide-react';
import { inboxService } from '../../../services/inbox.service';
import { useAuth } from '../../../contexts/AuthContext';
import { isLikelyBounce } from '../../../types/email.types';
import type { EmailThread } from '../../../types/email.types';
import OwnerPill from './OwnerPill';

export type InboxQuickFilter = 'all' | 'members' | 'needs-reply' | 'unlinked';
export type InboxOwnerFilter = 'all' | 'mine' | 'unassigned';

export interface InboxFilters {
  q: string;
  quick: InboxQuickFilter;
  owner: InboxOwnerFilter;
  page: number;
  limit: number;
}

interface Props {
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  filters: InboxFilters;
  onFiltersChange: (next: InboxFilters) => void;
  refreshVersion: number;
  onCompose: () => void;
  className?: string;
}

const fmtWhen = (v?: string | null) => {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time; // today → just the time
  const datePart = d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== now.getFullYear() ? { year: '2-digit' } : {}),
  });
  return `${datePart}, ${time}`;
};

const QUICK_TABS: { key: InboxQuickFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'members', label: 'Members' },
  { key: 'needs-reply', label: 'Needs reply' },
  { key: 'unlinked', label: 'Unlinked' },
];


// Who the conversation is with: prefer the linked member's name, then the email
// sender's display name, then their address. Falls back to a neutral label.
const senderForRow = (t: EmailThread): string =>
  t.LinkedMemberName || t.CounterpartyName || t.CounterpartyAddress || 'No sender';

const ThreadListRail = ({ selectedId, onSelect, filters, onFiltersChange, refreshVersion, onCompose, className = '' }: Props) => {
  const { user } = useAuth();
  const currentUserId = user?.userId;
  const [rows, setRows] = useState<EmailThread[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const [localRefresh, setLocalRefresh] = useState(0);
  const [searchInput, setSearchInput] = useState(filters.q);
  useEffect(() => { setSearchInput(filters.q); }, [filters.q]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput !== filters.q) onFiltersChange({ ...filters, q: searchInput, page: 1 });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true); setError(null);
    inboxService.listThreads({
      q: filters.q || undefined,
      needsReply: filters.quick === 'needs-reply' || undefined,
      unlinked: filters.quick === 'unlinked' || undefined,
      members: filters.quick === 'members' || undefined,
      owner: filters.owner,
      page: filters.page,
      limit: filters.limit,
    }, { signal: ac.signal })
      .then((resp) => {
        if (ac.signal.aborted) return;
        if (resp.success) { setRows(resp.data); setTotal(resp.pagination.total); setTotalPages(resp.pagination.totalPages); }
        else setError('Failed to load inbox');
      })
      .catch((err) => { if (!ac.signal.aborted) setError(err instanceof Error ? err.message : 'Failed to load inbox'); })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [filters.q, filters.quick, filters.owner, filters.page, filters.limit, refreshVersion, localRefresh]);

  // Background auto-refresh: re-read the list every 25s so newly-ingested mail
  // appears without a manual refresh. Silent — no loading flash, no error
  // surfacing (the foreground effect owns those) — and paused while the tab is
  // hidden. This is a DB read only; Graph ingestion is server-side / "Sync now".
  useEffect(() => {
    let active = true;
    const params = {
      q: filters.q || undefined,
      needsReply: filters.quick === 'needs-reply' || undefined,
      unlinked: filters.quick === 'unlinked' || undefined,
      members: filters.quick === 'members' || undefined,
      owner: filters.owner,
      page: filters.page,
      limit: filters.limit,
    };
    const tick = () => {
      if (document.hidden) return;
      inboxService.listThreads(params)
        .then((resp) => {
          if (!active || !resp.success) return;
          setRows(resp.data); setTotal(resp.pagination.total); setTotalPages(resp.pagination.totalPages);
        })
        .catch(() => { /* silent; surfaced on next foreground load */ });
    };
    const id = setInterval(tick, 25000);
    return () => { active = false; clearInterval(id); };
  }, [filters.q, filters.quick, filters.owner, filters.page, filters.limit]);

  const sync = async () => {
    setSyncing(true);
    try { await inboxService.sync(); }
    catch { /* surfaced via list error on next load */ }
    finally { setSyncing(false); setLocalRefresh((v) => v + 1); }
  };

  return (
    <aside className={`flex flex-col w-full md:w-80 md:min-w-80 md:max-w-80 border-r border-gray-200 bg-white min-h-0 ${className}`}>
      <div className="p-3 border-b border-gray-200">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Inbox className="h-4 w-4 text-oe-primary" />
            <h2 className="text-sm font-semibold text-gray-900">Inbox</h2>
            {total > 0 && <span className="text-xs text-gray-400">{total}</span>}
          </div>
          <div className="flex items-center gap-1.5">
            <button type="button" onClick={onCompose}
              className="inline-flex items-center gap-1 text-xs font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-md px-2.5 py-1.5">
              <PenLine className="h-3.5 w-3.5" /> New
            </button>
            <button type="button" onClick={sync} disabled={syncing} title="Sync now"
              className="text-gray-400 hover:text-oe-primary disabled:opacity-50 p-1">
              <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
        <div className="relative mb-2">
          <Search className="h-4 w-4 absolute left-2.5 top-2.5 text-gray-400" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search name, subject, email, message…"
            className="w-full text-sm border border-gray-300 rounded-md pl-8 pr-3 py-2 focus:outline-none focus:ring-2 focus:ring-oe-primary"
          />
        </div>
        <div className="flex gap-1.5">
          {QUICK_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => onFiltersChange({ ...filters, quick: t.key, page: 1 })}
              className={`text-xs px-2 py-1 rounded-full font-medium ${filters.quick === t.key ? 'bg-oe-light text-oe-dark' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {/* Ownership: My Inbox ↔ Shared (soft, nothing is locked). "Unassigned only"
            is a triage sub-option of Shared. */}
        <div className="mt-2 flex rounded-md bg-gray-100 p-0.5">
          <button
            type="button"
            onClick={() => onFiltersChange({ ...filters, owner: 'mine', page: 1 })}
            className={`flex-1 text-xs px-2 py-1 rounded font-medium transition-colors ${filters.owner === 'mine' ? 'bg-white text-oe-dark shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
          >
            My Inbox
          </button>
          <button
            type="button"
            onClick={() => onFiltersChange({ ...filters, owner: 'all', page: 1 })}
            className={`flex-1 text-xs px-2 py-1 rounded font-medium transition-colors ${filters.owner !== 'mine' ? 'bg-white text-oe-dark shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
          >
            Shared
          </button>
        </div>
        {filters.owner !== 'mine' && (
          <label className="mt-2 flex items-center gap-2 text-xs text-gray-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={filters.owner === 'unassigned'}
              onChange={(e) => onFiltersChange({ ...filters, owner: e.target.checked ? 'unassigned' : 'all', page: 1 })}
              className="h-3.5 w-3.5 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
            />
            Unassigned only
          </label>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && <div className="p-4 text-sm text-gray-400">Loading…</div>}
        {error && <div className="p-4 text-sm text-red-600">{error}</div>}
        {!loading && !error && rows.length === 0 && (
          <div className="p-6 text-center text-sm text-gray-400">No conversations yet.</div>
        )}
        {rows.map((t) => {
          const active = t.ThreadId === selectedId;
          const unread = t.UnreadCount > 0;
          const handled = !!t.ResolvedAt;
          const needsReply = t.NeedsReply && !handled; // handled threads leave the queue
          const strong = unread || needsReply; // bold the row when it wants attention
          // How long an unanswered thread has been waiting (days) — surfaces stale ones.
          const waitingDays = needsReply && t.LastMessageAt
            ? Math.floor((Date.now() - new Date(t.LastMessageAt).getTime()) / 86_400_000) : 0;
          const bounce = isLikelyBounce(t);
          const ref = t.LinkedShareRequestNumber || t.LinkedCaseNumber;
          const snippet = (t.LastPreview || '').trim();
          return (
            <button
              key={t.ThreadId}
              type="button"
              onClick={() => onSelect(t.ThreadId)}
              // Left accent bar carries the state (no "Needs reply" pill): active → primary,
              // needs-reply → amber, otherwise transparent so widths stay aligned.
              className={`w-full text-left px-4 py-3 border-b border-gray-100 hover:bg-gray-50 border-l-4 ${
                active ? 'bg-oe-light/40 border-l-oe-primary'
                  : needsReply ? 'border-l-amber-400'
                    : 'border-l-transparent'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className={`text-sm truncate ${strong ? 'font-semibold text-gray-900' : 'text-gray-800'}`}>{senderForRow(t)}</span>
                <span className="flex items-center gap-1.5 shrink-0">
                  {waitingDays >= 1 && (
                    <span className={`text-[10px] font-semibold ${waitingDays >= 3 ? 'text-red-600' : 'text-amber-600'}`} title={`Waiting ${waitingDays} day${waitingDays === 1 ? '' : 's'} for a reply`}>
                      {waitingDays}d
                    </span>
                  )}
                  <span className="text-[11px] text-gray-400">{fmtWhen(t.LastMessageAt)}</span>
                </span>
              </div>
              <div className={`text-sm truncate ${strong ? 'text-gray-900' : 'text-gray-700'}`}>{t.Subject || '(no subject)'}</div>
              <div className="text-xs truncate mt-0.5">
                {bounce ? (
                  <span className="text-red-600 font-medium">Delivery failed</span>
                ) : (
                  <span className="text-gray-400">
                    {t.LastDirection === 'outbound' && snippet ? '↩ ' : ''}{snippet || ' '}
                  </span>
                )}
              </div>
              {(ref || t.OwnerName || handled) && (
                <div className="mt-1 flex items-center gap-1.5">
                  {handled && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">✓ Handled</span>}
                  {ref && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">{ref}</span>}
                  {t.OwnerName && <OwnerPill name={t.OwnerName} color={t.OwnerColor} isMine={t.AssignedToUserId === currentUserId} />}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between px-3 py-2 border-t border-gray-200 text-xs text-gray-500">
          <button type="button" disabled={filters.page <= 1} onClick={() => onFiltersChange({ ...filters, page: filters.page - 1 })}
            className="inline-flex items-center gap-1 disabled:opacity-40"><ChevronLeft className="h-3 w-3" /> Prev</button>
          <span>Page {filters.page} / {totalPages}</span>
          <button type="button" disabled={filters.page >= totalPages} onClick={() => onFiltersChange({ ...filters, page: filters.page + 1 })}
            className="inline-flex items-center gap-1 disabled:opacity-40">Next <ChevronRight className="h-3 w-3" /></button>
        </div>
      )}
    </aside>
  );
};

export default ThreadListRail;
