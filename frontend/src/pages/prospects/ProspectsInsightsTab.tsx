// frontend/src/pages/prospects/ProspectsInsightsTab.tsx
// Insights dashboard for the Prospects page. Renders recharts visualizations of
// the /api/prospects/stats aggregates, scoped by the same agent/agency filters as
// the list. Brand colors are pulled from the oe-* CSS variables.

import { BarChart3, Filter, Layers, LineChart as LineChartIcon, Sparkles, UserCheck, Users, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useProspectStats } from '../../hooks/useProspects';
import { listProspectSources, PROSPECT_SOURCES, ProspectStatsParams } from '../../services/prospect.service';

// Lifecycle order for the funnel. Matches PROSPECT_STATUSES minus the terminal
// split (Closed/Lost shown last).
const STATUS_ORDER = ['New', 'Contacted', 'Proposal Sent', 'Closed', 'Lost'];

// Brand palette for series. Falls back to the oe defaults when no tenant theme
// has overridden the CSS variables.
const PALETTE = [
  'var(--oe-primary, #1f8dbf)',
  'var(--oe-primary-dark, #125e82)',
  'var(--oe-success, #4caf50)',
  'var(--oe-warning, #ffb300)',
  'var(--oe-secondary, #6366f1)',
  'var(--oe-error, #e53935)',
  '#94a3b8',
];

const colorForIndex = (i: number) => PALETTE[i % PALETTE.length];

const fmtMonthLabel = (yyyyMM: string): string => {
  // 'yyyy-MM' → 'MMM yy'
  const [y, m] = yyyyMM.split('-');
  if (!y || !m) return yyyyMM;
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
};

interface Props {
  /** Visibility scope threaded from the page toolbar. */
  scope?: ProspectStatsParams;
}

export default function ProspectsInsightsTab({ scope = {} }: Props) {
  // Local filter state for the Insights controls row. The source filter uses a
  // combined token: '' = all, 'id:<uuid>' = a named ProspectSource (filtered by
  // SourceId), 'src:<text>' = a built-in/free-text source like Proposal/Quote
  // (filtered by the Source text). Empty date strings default server-side to the
  // trailing 12 months.
  const [sourceSel, setSourceSel] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // "Prospects per month" chart mode: stacked bars vs. a line per source.
  const [monthChartType, setMonthChartType] = useState<'bar' | 'line'>('bar');

  // Source dropdown options. Independent of the stats payload so the list is
  // available even before/while stats load.
  const { data: sourceList } = useQuery({
    queryKey: ['prospect-sources'],
    queryFn: listProspectSources,
  });

  const sourceId = sourceSel.startsWith('id:') ? sourceSel.slice(3) : '';
  const sourceText = sourceSel.startsWith('src:') ? sourceSel.slice(4) : '';

  // Built-in source options that don't have a named source row but still appear
  // on prospects (Proposal/Quote/Manual/ApiIngest/MightyWELL Website). Hide any
  // whose label collides with a named source so the list stays unambiguous.
  const builtInSources = useMemo(() => {
    const namedNames = new Set((sourceList ?? []).map((s) => s.name));
    return PROSPECT_SOURCES.filter((s) => !namedNames.has(s));
  }, [sourceList]);

  // Merge the page-level scope with the in-tab filters. Undefined keys are
  // dropped from the request (and threaded into the stats queryKey).
  const statsParams: ProspectStatsParams = useMemo(
    () => ({
      ...scope,
      ...(sourceId ? { sourceId } : {}),
      ...(sourceText ? { source: sourceText } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    }),
    [scope, sourceId, sourceText, from, to],
  );

  const { data, isLoading } = useProspectStats(statsParams);

  const selectedSourceName = useMemo(() => {
    if (sourceId) return (sourceList ?? []).find((s) => s.sourceId === sourceId)?.name ?? 'Selected source';
    if (sourceText) return sourceText;
    return null;
  }, [sourceList, sourceId, sourceText]);

  const hasRange = !!from || !!to;
  const clearRange = () => {
    setFrom('');
    setTo('');
  };

  const controls = (
    <div className="bg-white rounded-lg border border-gray-200 p-4" data-testid="insights-controls">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500 flex items-center gap-1">
            <Filter className="w-3.5 h-3.5" />
            Source
          </label>
          <select
            data-testid="insights-source-select"
            value={sourceSel}
            onChange={(e) => setSourceSel(e.target.value)}
            className="text-sm border border-gray-300 rounded-md px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-oe-primary/40 focus:border-oe-primary"
          >
            <option value="">All sources</option>
            {(sourceList ?? []).length > 0 && (
              <optgroup label="Your sources">
                {(sourceList ?? []).map((s) => (
                  <option key={s.sourceId} value={`id:${s.sourceId}`}>
                    {s.name}
                  </option>
                ))}
              </optgroup>
            )}
            {builtInSources.length > 0 && (
              <optgroup label="Built-in">
                {builtInSources.map((s) => (
                  <option key={s} value={`src:${s}`}>
                    {s}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500">From</label>
          <input
            type="date"
            data-testid="insights-from"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
            className="text-sm border border-gray-300 rounded-md px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-oe-primary/40 focus:border-oe-primary"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500">To</label>
          <input
            type="date"
            data-testid="insights-to"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
            className="text-sm border border-gray-300 rounded-md px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-oe-primary/40 focus:border-oe-primary"
          />
        </div>

        {hasRange && (
          <button
            type="button"
            onClick={clearRange}
            data-testid="insights-clear-range"
            className="inline-flex items-center gap-1 text-sm border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-md px-3 py-2"
          >
            <X className="w-3.5 h-3.5" />
            Clear
          </button>
        )}
      </div>
    </div>
  );

  // Distinct, ordered source list across the dataset (for stacked series + pie).
  const sources = useMemo(() => {
    const set = new Set<string>();
    (data?.bySource ?? []).forEach((s) => set.add(s.source));
    (data?.bySourceMonth ?? []).forEach((s) => set.add(s.source));
    return Array.from(set);
  }, [data]);

  // Pivot bySourceMonth → one row per month with a column per source. Every month
  // in the active window (trailing 12 months, or the selected from→to range) gets a
  // row, and every source is filled to 0 when it had nothing that month — so empty
  // months render as gaps-of-zero (continuous bars/lines), not missing points.
  const monthSeries = useMemo(() => {
    const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const parseMonth = (key: string) => {
      const [y, m] = key.split('-').map(Number);
      return new Date(Date.UTC(y, (m || 1) - 1, 1));
    };
    const firstOfMonth = (raw: string) => {
      const d = new Date(raw);
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    };

    // Window end (default: current month) and start (default: 11 months earlier).
    let end = to ? firstOfMonth(to) : firstOfMonth(new Date().toISOString());
    let start = from
      ? firstOfMonth(from)
      : new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 11, 1));

    // Expand the window to include any data months that fall outside it.
    (data?.bySourceMonth ?? []).forEach(({ month }) => {
      const d = parseMonth(month);
      if (d < start) start = d;
      if (d > end) end = d;
    });

    const counts = new Map<string, number>();
    (data?.bySourceMonth ?? []).forEach(({ month, source, count }) => {
      const k = `${month}|${source}`;
      counts.set(k, (counts.get(k) ?? 0) + count);
    });

    const rows: Record<string, number | string>[] = [];
    const cur = new Date(start);
    for (let guard = 0; cur <= end && guard < 240; guard++) {
      const key = monthKey(cur);
      const row: Record<string, number | string> = { month: key, label: fmtMonthLabel(key) };
      sources.forEach((src) => {
        row[src] = counts.get(`${key}|${src}`) ?? 0;
      });
      rows.push(row);
      cur.setUTCMonth(cur.getUTCMonth() + 1);
    }
    return rows;
  }, [data, from, to, sources]);

  const statusSeries = useMemo(() => {
    const byStatus = new Map((data?.byStatus ?? []).map((s) => [s.status, s.count]));
    const ordered = STATUS_ORDER.filter((s) => byStatus.has(s)).map((status) => ({
      status,
      count: byStatus.get(status) ?? 0,
    }));
    // Include any non-standard statuses the API returned, appended at the end.
    (data?.byStatus ?? []).forEach((s) => {
      if (!STATUS_ORDER.includes(s.status)) ordered.push({ status: s.status, count: s.count });
    });
    return ordered;
  }, [data]);

  const totals = data?.totals ?? { total: 0, newThisMonth: 0, sources: 0, enrolled: 0 };

  // Per-source summary. When a specific source is selected the stats payload is
  // already filtered to it server-side, so `totals.total` is that source's
  // total and summing the month buckets gives the count within the active
  // range (defaults to the trailing 12 months).
  const sourceSummary = useMemo(() => {
    if (!selectedSourceName) return null;
    const inRange = (data?.bySourceMonth ?? []).reduce((acc, b) => acc + b.count, 0);
    const total = data?.totals?.total ?? 0;
    const enrolled = data?.totals?.enrolled ?? 0;
    return {
      name: selectedSourceName,
      total,
      inRange,
      enrolled,
      conversion: total > 0 ? Math.round((enrolled / total) * 100) : 0,
    };
  }, [selectedSourceName, data]);

  const hasData =
    (data?.bySourceMonth?.length ?? 0) > 0 ||
    (data?.bySource?.length ?? 0) > 0 ||
    (data?.byStatus?.length ?? 0) > 0;

  if (isLoading) {
    return (
      <div className="space-y-6">
        {controls}
        <div
          data-testid="insights-loading"
          className="bg-white rounded-lg border border-gray-200 p-10 text-center text-gray-500"
        >
          Loading insights…
        </div>
      </div>
    );
  }

  if (!hasData) {
    return (
      <div className="space-y-6">
        {controls}
        <div
          data-testid="insights-empty"
          className="bg-white rounded-lg border border-gray-200 p-12 text-center"
        >
          <BarChart3 className="w-10 h-10 text-gray-300 mx-auto mb-3" />
          <h3 className="text-base font-medium text-gray-900">No insights yet</h3>
          <p className="text-sm text-gray-500 mt-1 max-w-md mx-auto">
            {sourceSel || hasRange
              ? 'No prospects match the selected source or date range. Try widening your filters.'
              : "Once prospects start coming in across your sources, you'll see trends, a source breakdown, and a status funnel here."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="insights-tab">
      {controls}

      {/* Per-source summary (only when a specific source is selected) */}
      {sourceSummary && (
        <div
          className="bg-white rounded-lg border border-gray-200 p-6"
          data-testid="insights-source-summary"
        >
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Filter className="w-4 h-4 text-oe-primary" />
            <span>
              Summary for <span className="font-medium text-gray-900">{sourceSummary.name}</span>
            </span>
          </div>
          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <p className="text-2xl font-semibold text-gray-900">{sourceSummary.total}</p>
              <p className="text-xs text-gray-500 mt-0.5">Total leads</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-gray-900">{sourceSummary.inRange}</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {hasRange ? 'In selected range' : 'Last 12 months'}
              </p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-oe-success">{sourceSummary.enrolled}</p>
              <p className="text-xs text-gray-500 mt-0.5">Enrollments</p>
            </div>
            <div>
              <p className="text-2xl font-semibold text-gray-900">{sourceSummary.conversion}%</p>
              <p className="text-xs text-gray-500 mt-0.5">Conversion</p>
            </div>
          </div>
        </div>
      )}

      {/* Metric cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={<Users className="w-5 h-5 text-oe-primary" />} label="Total leads" value={totals.total} />
        <StatCard icon={<Sparkles className="w-5 h-5 text-oe-dark" />} label="New this month" value={totals.newThisMonth} />
        <StatCard
          icon={<UserCheck className="w-5 h-5 text-oe-success" />}
          label="Enrollments"
          value={totals.enrolled}
          sublabel={totals.total > 0 ? `${Math.round((totals.enrolled / totals.total) * 100)}% conversion` : undefined}
        />
        <StatCard icon={<Layers className="w-5 h-5 text-oe-dark" />} label="Sources" value={totals.sources} />
      </div>

      {/* Prospects per month — toggle between stacked bars and a line per source */}
      <ChartCard
        title="Prospects per month"
        subtitle={monthChartType === 'bar' ? 'Last 12 months, stacked by source' : 'Last 12 months, trend per source'}
        testId="chart-by-month"
        action={
          <div className="inline-flex rounded-md border border-gray-300 overflow-hidden" role="group" aria-label="Chart type">
            <button
              type="button"
              data-testid="month-chart-bar"
              onClick={() => setMonthChartType('bar')}
              aria-pressed={monthChartType === 'bar'}
              aria-label="Bar chart"
              className={`px-2 py-1.5 ${monthChartType === 'bar' ? 'bg-oe-primary text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
            >
              <BarChart3 className="w-4 h-4" />
            </button>
            <button
              type="button"
              data-testid="month-chart-line"
              onClick={() => setMonthChartType('line')}
              aria-pressed={monthChartType === 'line'}
              aria-label="Line chart"
              className={`px-2 py-1.5 border-l border-gray-300 ${monthChartType === 'line' ? 'bg-oe-primary text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
            >
              <LineChartIcon className="w-4 h-4" />
            </button>
          </div>
        }
      >
        <ResponsiveContainer width="100%" height={300}>
          {monthChartType === 'bar' ? (
            <BarChart data={monthSeries} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#6b7280' }} tickLine={false} axisLine={{ stroke: '#e5e7eb' }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: '#6b7280' }} tickLine={false} axisLine={false} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {sources.map((src, i) => (
                <Bar key={src} dataKey={src} stackId="src" fill={colorForIndex(i)} radius={i === sources.length - 1 ? [4, 4, 0, 0] : undefined} />
              ))}
            </BarChart>
          ) : (
            <LineChart data={monthSeries} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#6b7280' }} tickLine={false} axisLine={{ stroke: '#e5e7eb' }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: '#6b7280' }} tickLine={false} axisLine={false} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {sources.map((src, i) => (
                <Line key={src} type="monotone" dataKey={src} stroke={colorForIndex(i)} strokeWidth={2} dot={{ r: 2 }} activeDot={{ r: 4 }} />
              ))}
            </LineChart>
          )}
        </ResponsiveContainer>
      </ChartCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Source breakdown */}
        <ChartCard title="Source breakdown" subtitle="All prospects by lead source" testId="chart-by-source">
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie
                data={data?.bySource ?? []}
                dataKey="count"
                nameKey="source"
                cx="50%"
                cy="50%"
                outerRadius={90}
                label={(entry: { source?: string; count?: number }) => `${entry.source}: ${entry.count}`}
              >
                {(data?.bySource ?? []).map((entry, i) => (
                  <Cell key={entry.source} fill={colorForIndex(i)} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Status funnel */}
        <ChartCard title="Status funnel" subtitle="Where prospects sit in the lifecycle" testId="chart-by-status">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={statusSeries} layout="vertical" margin={{ top: 8, right: 24, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" horizontal={false} />
              <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12, fill: '#6b7280' }} tickLine={false} axisLine={{ stroke: '#e5e7eb' }} />
              <YAxis type="category" dataKey="status" width={92} tick={{ fontSize: 12, fill: '#374151' }} tickLine={false} axisLine={false} />
              <Tooltip />
              <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                {statusSeries.map((entry, i) => (
                  <Cell key={entry.status} fill={colorForIndex(i)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, sublabel }: { icon: ReactNode; label: string; value: number; sublabel?: string }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <div className="flex items-center gap-2 text-sm text-gray-500">
        {icon}
        <span>{label}</span>
      </div>
      <p className="text-2xl font-semibold text-gray-900 mt-2">{value}</p>
      {sublabel && <p className="text-xs text-oe-success mt-0.5">{sublabel}</p>}
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  testId,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  testId?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6" data-testid={testId}>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
          {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}
