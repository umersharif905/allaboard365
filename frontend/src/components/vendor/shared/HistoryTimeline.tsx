// frontend/src/components/vendor/shared/HistoryTimeline.tsx
// Read-only unified history timeline shared by the Case and Share Request
// workspaces. Fetches a normalized event stream from the backend aggregator
// (backend/services/historyTimelineService.js) and renders it as a vertical
// timeline. Events carrying `meta`/`ref` are clickable: clicking opens a
// detail modal, which can deep-link to the underlying record.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Activity,
  ChevronRight,
  CircleAlert,
  CirclePlus,
  ClipboardList,
  DollarSign,
  ExternalLink,
  GitBranch,
  Mail,
  MessageCircle,
  Package,
  Paperclip,
  StickyNote,
  Stethoscope,
  UserCheck,
  X,
} from 'lucide-react';
import type { IconComponent } from '../../../types/icon';
import { apiService } from '../../../services/api.service';
import Skeleton from '../ui/Skeleton';
import EmptyState from '../ui/EmptyState';

type TimelineCategory =
  | 'creation'
  | 'status'
  | 'assignment'
  | 'note'
  | 'document'
  | 'provider'
  | 'encounter'
  | 'form'
  | 'communication'
  | 'plan'
  | 'finance'
  | 'system';

interface TimelineMeta {
  label: string;
  value: string;
}

interface TimelineRef {
  kind: 'encounter' | 'form-submission' | 'form-template' | string;
  id: string;
}

interface TimelineEvent {
  id: string;
  category: TimelineCategory;
  occurredAt: string;
  actorName: string | null;
  title: string;
  detail: string | null;
  before: string | null;
  after: string | null;
  meta: TimelineMeta[] | null;
  ref: TimelineRef | null;
}

interface HistoryResponse {
  success: boolean;
  data: TimelineEvent[];
}

interface HistoryTimelineProps {
  entityType: 'case' | 'share-request';
  entityId: string;
  /** Bumps to force a refetch (e.g. after a claim/status mutation). */
  refreshKey?: number;
}

// Icon, accent color and filter-chip label for each category. Anything the
// backend sends that isn't listed here falls back to the `system` row.
const CATEGORY_META: Record<TimelineCategory, { Icon: IconComponent; accent: string; label: string }> = {
  creation:      { Icon: CirclePlus,    accent: 'text-oe-primary',  label: 'Created' },
  status:        { Icon: GitBranch,     accent: 'text-oe-primary',  label: 'Status' },
  assignment:    { Icon: UserCheck,     accent: 'text-amber-500',   label: 'Assignment' },
  note:          { Icon: StickyNote,    accent: 'text-gray-500',    label: 'Notes' },
  document:      { Icon: Paperclip,     accent: 'text-blue-500',    label: 'Documents' },
  provider:      { Icon: Stethoscope,   accent: 'text-teal-500',    label: 'Providers' },
  encounter:     { Icon: MessageCircle, accent: 'text-purple-500',  label: 'Encounters' },
  form:          { Icon: ClipboardList, accent: 'text-indigo-500',  label: 'Forms' },
  communication: { Icon: Mail,          accent: 'text-purple-500',  label: 'Communications' },
  plan:          { Icon: Package,       accent: 'text-emerald-600', label: 'Plan changes' },
  finance:       { Icon: DollarSign,    accent: 'text-oe-primary',  label: 'Finances' },
  system:        { Icon: Activity,      accent: 'text-gray-400',    label: 'System' },
};

const metaFor = (c: TimelineCategory) => CATEGORY_META[c] ?? CATEGORY_META.system;

// Deep-link target for an event's ref. Cases and Share Requests both live in
// the vendor portal, so links are always vendor-scoped.
const REF_LABEL: Record<string, string> = {
  encounter: 'Open encounter',
  'form-submission': 'Open submission',
  'form-template': 'Open form',
};

const refUrl = (ref: TimelineRef): string | null => {
  switch (ref.kind) {
    case 'encounter':
      return `/vendor/encounters/${ref.id}`;
    case 'form-submission':
      return `/vendor/sharing-forms/submissions/${ref.id}`;
    case 'form-template':
      return `/vendor/sharing-forms/template/${ref.id}/invitations`;
    default:
      return null;
  }
};

const fmtDateTime = (v?: string) => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

// Small gray chip used for the before → after value pair on change rows.
const ValueChip = ({ value }: { value: string }) => (
  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-700">
    {value}
  </span>
);

const isClickable = (e: TimelineEvent) => !!(e.ref || (e.meta && e.meta.length));

const HistoryTimeline = ({ entityType, entityId, refreshKey = 0 }: HistoryTimelineProps) => {
  const navigate = useNavigate();
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<TimelineCategory | 'all'>('all');
  const [selected, setSelected] = useState<TimelineEvent | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const response = await apiService.get<HistoryResponse>(
          `/api/me/vendor/${entityType === 'case' ? 'cases' : 'share-requests'}/${entityId}/history`,
          signal ? { signal } : undefined
        );
        if (signal?.aborted) return;
        if (response.success) setEvents(response.data);
        else setError('Failed to load history');
      } catch (err) {
        if (signal?.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to load history');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [entityType, entityId]
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
    // load depends on entityType/entityId; refreshKey is a refetch trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, refreshKey]);

  // Close the detail modal on Escape.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  // Categories actually present, in CATEGORY_META declaration order, so the
  // filter chips only show what this entity has.
  const presentCategories = useMemo(() => {
    const seen = new Set(events.map((e) => e.category));
    return (Object.keys(CATEGORY_META) as TimelineCategory[]).filter((c) => seen.has(c));
  }, [events]);

  const visible = useMemo(
    () => (filter === 'all' ? events : events.filter((e) => e.category === filter)),
    [events, filter]
  );

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-gray-900">History</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Everything that has happened on this {entityType === 'case' ? 'ticket' : 'share request'}, newest first.
        </p>
      </div>

      {/* Category filter chips — client-side, only shows present categories. */}
      {!loading && !error && events.length > 0 && presentCategories.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          <FilterChip active={filter === 'all'} onClick={() => setFilter('all')} label="All" />
          {presentCategories.map((c) => (
            <FilterChip
              key={c}
              active={filter === c}
              onClick={() => setFilter(c)}
              label={metaFor(c).label}
            />
          ))}
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 text-red-600 text-sm">
          <CircleAlert className="h-4 w-4" />
          <span>{error}</span>
        </div>
      ) : events.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="No history yet"
          description={`Nothing has happened on this ${entityType === 'case' ? 'ticket' : 'share request'} yet.`}
          tone="subtle"
        />
      ) : visible.length === 0 ? (
        <p className="text-sm text-gray-500 py-6 text-center">No events in this category.</p>
      ) : (
        <ol className="relative space-y-0">
          {/* Vertical rail behind the timeline dots */}
          <span aria-hidden="true" className="absolute left-[15px] top-2 bottom-2 w-px bg-gray-200" />
          {visible.map((item) => {
            const { Icon, accent } = metaFor(item.category);
            const showPair = !!(item.before || item.after);
            const clickable = isClickable(item);
            return (
              <li key={item.id} className="relative">
                {clickable ? (
                  <button
                    type="button"
                    onClick={() => setSelected(item)}
                    className="w-full text-left pl-10 pr-7 py-3 rounded-md hover:bg-gray-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-oe-primary"
                  >
                    <TimelineRow item={item} Icon={Icon} accent={accent} showPair={showPair} />
                    <ChevronRight
                      aria-hidden="true"
                      className="absolute right-2 top-4 h-4 w-4 text-gray-300"
                    />
                  </button>
                ) : (
                  <div className="pl-10 pr-2 py-3">
                    <TimelineRow item={item} Icon={Icon} accent={accent} showPair={showPair} />
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {selected && (
        <DetailModal
          event={selected}
          onClose={() => setSelected(null)}
          onNavigate={(url) => {
            setSelected(null);
            navigate(url);
          }}
        />
      )}
    </div>
  );
};

interface TimelineRowProps {
  item: TimelineEvent;
  Icon: IconComponent;
  accent: string;
  showPair: boolean;
}

const TimelineRow = ({ item, Icon, accent, showPair }: TimelineRowProps) => (
  <>
    <span
      aria-hidden="true"
      className="absolute left-2 top-3.5 h-6 w-6 rounded-full bg-white border border-gray-200 flex items-center justify-center"
    >
      <Icon className={`h-3.5 w-3.5 ${accent}`} />
    </span>
    <div className="space-y-1">
      <p className="text-sm text-gray-800 leading-snug">{item.title}</p>

      {showPair && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {item.before && <ValueChip value={item.before} />}
          {item.before && item.after && <span className="text-gray-400">→</span>}
          {item.after && <ValueChip value={item.after} />}
        </div>
      )}

      {item.detail && (
        <p className="text-xs text-gray-500 whitespace-pre-wrap break-words">{item.detail}</p>
      )}

      <div className="text-[11px] text-gray-500 inline-flex items-center gap-1">
        {item.actorName ? (
          <>
            <UserCheck className="h-2.5 w-2.5" />
            <span className="font-medium text-gray-600">{item.actorName}</span>
          </>
        ) : (
          <span className="text-gray-400">System</span>
        )}
        <span className="text-gray-300">·</span>
        <span>{fmtDateTime(item.occurredAt)}</span>
      </div>
    </div>
  </>
);

interface DetailModalProps {
  event: TimelineEvent;
  onClose: () => void;
  onNavigate: (url: string) => void;
}

const DetailModal = ({ event, onClose, onNavigate }: DetailModalProps) => {
  const { Icon, accent, label } = metaFor(event.category);
  const url = event.ref ? refUrl(event.ref) : null;
  const linkLabel = event.ref ? REF_LABEL[event.ref.kind] || 'Open record' : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="bg-white rounded-lg border border-gray-200 shadow-xl w-full max-w-md max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-start justify-between gap-3 p-4 border-b border-gray-200">
          <div className="flex items-start gap-2">
            <span className="h-7 w-7 rounded-full bg-gray-50 border border-gray-200 flex items-center justify-center shrink-0">
              <Icon className={`h-4 w-4 ${accent}`} />
            </span>
            <div>
              <p className="text-sm font-semibold text-gray-900 leading-snug">{event.title}</p>
              <p className="text-xs text-gray-500 mt-0.5">{label}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-gray-400 hover:text-gray-600 shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 overflow-y-auto space-y-3">
          <p className="text-xs text-gray-500">
            {event.actorName ? <span className="font-medium text-gray-700">{event.actorName}</span> : 'System'}
            {' · '}
            {fmtDateTime(event.occurredAt)}
          </p>

          {(event.before || event.after) && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              {event.before && <ValueChip value={event.before} />}
              {event.before && event.after && <span className="text-gray-400">→</span>}
              {event.after && <ValueChip value={event.after} />}
            </div>
          )}

          {event.detail && (
            <p className="text-sm text-gray-700 whitespace-pre-wrap break-words">{event.detail}</p>
          )}

          {event.meta && event.meta.length > 0 && (
            <dl className="divide-y divide-gray-100 border border-gray-100 rounded-md">
              {event.meta.map((m) => (
                <div key={m.label} className="flex gap-3 px-3 py-2 text-xs">
                  <dt className="text-gray-500 w-28 shrink-0">{m.label}</dt>
                  <dd className="text-gray-800 break-words min-w-0">{m.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-gray-200">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded-md border border-gray-300 text-gray-700 bg-white hover:bg-gray-50"
          >
            Close
          </button>
          {url && (
            <button
              type="button"
              onClick={() => onNavigate(url)}
              className="px-3 py-1.5 text-sm rounded-md bg-oe-primary hover:bg-oe-dark text-white inline-flex items-center gap-1.5"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {linkLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

interface FilterChipProps {
  active: boolean;
  onClick: () => void;
  label: string;
}

const FilterChip = ({ active, onClick, label }: FilterChipProps) => (
  <button
    type="button"
    onClick={onClick}
    className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
      active
        ? 'bg-oe-primary text-white'
        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
    }`}
  >
    {label}
  </button>
);

export default HistoryTimeline;
