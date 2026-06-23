// EncountersPage — back-office Encounters dashboard. Rail + detail layout
// modeled after CaseWorkspace, but encounters don't have status workflow so
// the rail uses a 2-pill quick filter (All | Opened by me) plus an
// expandable filter dropdown for No-member / Open follow-ups / Channel.
//
// Routes:
//   /vendor/encounters       → rail visible, detail panel shows empty state
//   /vendor/encounters/:id   → rail visible, detail panel shows the encounter

import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, MessageCircle, Plus } from 'lucide-react';
import EncounterListRail, {
  type EncounterRailFilters,
  type EncounterRailQuickFilter,
} from '../../components/vendor/encounters/EncounterListRail';
import EncounterDetailCard from '../../components/vendor/encounters/EncounterDetailCard';
import EncounterNewModal from '../../components/vendor/encounters/EncounterNewModal';
import {
  ENCOUNTER_CHANNELS,
  type EncounterChannel,
  type EncounterRow,
} from '../../types/encounter.types';

const DEFAULT_LIMIT = 25;

const isQuick = (v: string | null): v is EncounterRailQuickFilter =>
  v === 'all' || v === 'mine';

const isChannel = (v: string | null): v is EncounterChannel =>
  !!v && (ENCOUNTER_CHANNELS as string[]).includes(v);

const isOn = (v: string | null) => v === '1' || v === 'true';

const EncountersPage = () => {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const filters = useMemo<EncounterRailFilters>(() => {
    const quick = searchParams.get('q-filter');
    const channel = searchParams.get('channel');
    const pageRaw = parseInt(searchParams.get('page') ?? '1', 10);
    const limitRaw = parseInt(searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10);
    return {
      q: searchParams.get('q') ?? '',
      quick: isQuick(quick) ? quick : 'all',
      channel: isChannel(channel) ? channel : undefined,
      noMember: isOn(searchParams.get('no-member')),
      followUp: isOn(searchParams.get('follow-up')),
      page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT,
    };
  }, [searchParams]);

  const handleFiltersChange = useCallback((next: EncounterRailFilters) => {
    setSearchParams((prev) => {
      const out = new URLSearchParams(prev);
      const setOrDelete = (k: string, v: string | undefined) => {
        if (v === undefined || v === '' || v === null) out.delete(k);
        else out.set(k, v);
      };
      setOrDelete('q', next.q || undefined);
      if (next.quick === 'all') out.delete('q-filter');
      else out.set('q-filter', next.quick);
      setOrDelete('channel', next.channel);
      if (next.noMember) out.set('no-member', '1'); else out.delete('no-member');
      if (next.followUp) out.set('follow-up', '1'); else out.delete('follow-up');
      if (next.page === 1) out.delete('page');
      else out.set('page', String(next.page));
      if (next.limit === DEFAULT_LIMIT) out.delete('limit');
      else out.set('limit', String(next.limit));
      return out;
    }, { replace: true });
  }, [setSearchParams]);

  const handleSelect = useCallback((eid: string) => {
    const next = new URLSearchParams(searchParams);
    navigate({
      pathname: `/vendor/encounters/${eid}`,
      search: next.toString() ? `?${next.toString()}` : '',
    });
  }, [navigate, searchParams]);

  const handleBack = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    navigate({
      pathname: '/vendor/encounters',
      search: next.toString() ? `?${next.toString()}` : '',
    });
  }, [navigate, searchParams]);

  const [refreshVersion, setRefreshVersion] = useState(0);
  const onChanged = useCallback(() => setRefreshVersion((v) => v + 1), []);

  const [showNew, setShowNew] = useState(false);
  const handleCreated = useCallback((row: EncounterRow) => {
    setShowNew(false);
    onChanged();
    navigate(`/vendor/encounters/${row.EncounterId}`);
  }, [navigate, onChanged]);

  const handleArchived = useCallback(() => {
    onChanged();
    handleBack();
  }, [onChanged, handleBack]);

  return (
    <div className="flex h-full min-h-0 bg-white overflow-hidden">
      <EncounterListRail
        selectedId={id}
        onSelect={handleSelect}
        filters={filters}
        onFiltersChange={handleFiltersChange}
        refreshVersion={refreshVersion}
        onNew={() => setShowNew(true)}
        className={id ? 'hidden md:flex' : 'flex'}
      />

      <main className={`flex-1 min-w-0 min-h-0 overflow-y-auto bg-gradient-to-b from-gray-50/40 to-white ${id ? 'block' : 'hidden md:block'}`}>
        {id ? (
          <>
            <button
              type="button"
              onClick={handleBack}
              className="md:hidden inline-flex items-center gap-2 px-4 py-2 text-sm text-gray-600 hover:text-gray-900 border-b border-gray-200 w-full"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to encounters
            </button>
            <EncounterDetailCard
              key={id}
              encounterId={id}
              onChanged={onChanged}
              onArchived={handleArchived}
            />
          </>
        ) : (
          <EncountersEmptyState onNew={() => setShowNew(true)} />
        )}
      </main>

      <EncounterNewModal
        open={showNew}
        onClose={() => setShowNew(false)}
        onCreated={handleCreated}
      />
    </div>
  );
};

const EncountersEmptyState = ({ onNew }: { onNew: () => void }) => (
  <div className="flex flex-col items-center justify-center text-center h-full py-16 px-6 animate-fade-in">
    <div className="relative mb-5">
      <div className="absolute inset-0 rounded-full bg-oe-light blur-2xl opacity-70" />
      <div className="relative h-20 w-20 rounded-full bg-gradient-to-br from-oe-light to-white border border-oe-light flex items-center justify-center shadow-soft">
        <MessageCircle className="h-9 w-9 text-oe-primary" />
      </div>
    </div>
    <h2 className="text-lg font-semibold text-gray-900 mb-1.5">Select an encounter</h2>
    <p className="text-sm text-gray-500 max-w-sm leading-relaxed">
      Pick an encounter from the list to view its details, follow-ups, and attachments.
    </p>
    <button
      type="button"
      onClick={onNew}
      className="mt-5 inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg transition-colors"
    >
      <Plus className="h-4 w-4" />
      New encounter
    </button>
    <p className="mt-6 text-xs text-gray-400 inline-flex items-center gap-1.5">
      <ArrowLeft className="h-3.5 w-3.5" />
      Use the list on the left
    </p>
  </div>
);

export default EncountersPage;
