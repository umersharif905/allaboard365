// InboxPage — Back Office email inbox. Rail + thread reader (+ Phase-2 AI slot
// inside the reader). Mirrors EncountersPage's rail/detail + URL-driven state.
//
// Routes:
//   /vendor/inbox        → rail visible, empty reader
//   /vendor/inbox/:id    → rail + thread reader
//
// Spec: docs/superpowers/specs/2026-06-02-back-office-email/design.md
import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Inbox } from 'lucide-react';
import ThreadListRail, { type InboxFilters, type InboxQuickFilter } from '../../components/vendor/inbox/ThreadListRail';
import ThreadReader from '../../components/vendor/inbox/ThreadReader';
import ComposeNewModal from '../../components/vendor/inbox/ComposeNewModal';
import type { EmailThreadDetail } from '../../types/email.types';

const DEFAULT_LIMIT = 25;
const isQuick = (v: string | null): v is InboxQuickFilter => v === 'all' || v === 'needs-reply' || v === 'unlinked';

const InboxPage = () => {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const filters = useMemo<InboxFilters>(() => {
    const quick = searchParams.get('filter');
    const owner = searchParams.get('owner');
    const pageRaw = parseInt(searchParams.get('page') ?? '1', 10);
    return {
      q: searchParams.get('q') ?? '',
      quick: isQuick(quick) ? quick : 'all',
      owner: owner === 'mine' || owner === 'unassigned' ? owner : 'all',
      page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
      limit: DEFAULT_LIMIT,
    };
  }, [searchParams]);

  const handleFiltersChange = useCallback((next: InboxFilters) => {
    setSearchParams((prev) => {
      const out = new URLSearchParams(prev);
      if (next.q) out.set('q', next.q); else out.delete('q');
      if (next.quick === 'all') out.delete('filter'); else out.set('filter', next.quick);
      if (next.owner === 'all') out.delete('owner'); else out.set('owner', next.owner);
      if (next.page === 1) out.delete('page'); else out.set('page', String(next.page));
      return out;
    }, { replace: true });
  }, [setSearchParams]);

  const handleSelect = useCallback((tid: string) => {
    navigate({ pathname: `/vendor/inbox/${tid}`, search: searchParams.toString() ? `?${searchParams.toString()}` : '' });
  }, [navigate, searchParams]);

  const handleBack = useCallback(() => {
    navigate({ pathname: '/vendor/inbox', search: searchParams.toString() ? `?${searchParams.toString()}` : '' });
  }, [navigate, searchParams]);

  const [refreshVersion, setRefreshVersion] = useState(0);
  const onChanged = useCallback(() => setRefreshVersion((v) => v + 1), []);

  const [showCompose, setShowCompose] = useState(false);
  const handleSent = useCallback((thread: EmailThreadDetail) => {
    setShowCompose(false);
    onChanged();
    navigate(`/vendor/inbox/${thread.ThreadId}`);
  }, [navigate, onChanged]);

  return (
    <div className="flex h-full min-h-0 bg-white overflow-hidden">
      <ThreadListRail
        selectedId={id}
        onSelect={handleSelect}
        filters={filters}
        onFiltersChange={handleFiltersChange}
        refreshVersion={refreshVersion}
        onCompose={() => setShowCompose(true)}
        className={id ? 'hidden md:flex' : 'flex'}
      />

      {id ? (
        <ThreadReader key={id} threadId={id} onBack={handleBack} onChanged={onChanged} />
      ) : (
        <main className="flex-1 min-w-0 hidden md:flex flex-col items-center justify-center text-center bg-gradient-to-b from-gray-50/40 to-white px-6">
          <div className="relative mb-5">
            <div className="absolute inset-0 rounded-full bg-oe-light blur-2xl opacity-70" />
            <div className="relative h-20 w-20 rounded-full bg-gradient-to-br from-oe-light to-white border border-oe-light flex items-center justify-center">
              <Inbox className="h-9 w-9 text-oe-primary" />
            </div>
          </div>
          <h2 className="text-lg font-semibold text-gray-900 mb-1.5">Select a conversation</h2>
          <p className="text-sm text-gray-500 max-w-sm leading-relaxed">
            Pick a thread to read it, reply as the care team, and link it to a share request or case.
          </p>
        </main>
      )}

      <ComposeNewModal open={showCompose} onClose={() => setShowCompose(false)} onSent={handleSent} />
    </div>
  );
};

export default InboxPage;
