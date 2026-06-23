import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  Info,
  RefreshCw,
  Server,
  Shield,
  Zap,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { apiService } from '../../services/api.service';

interface AiReportRow {
  ReportId: string;
  AppServiceName: string;
  Priority: number;
  Category: string | null;
  Title: string;
  Summary: string;
  RawLogExcerpt: string | null;
  Recommendation: string | null;
  RunId: string;
  CreatedAt: string;
}

interface ReportStats {
  totalFindings: number;
  critical: number;
  warning: number;
  info: number;
  totalRuns: number;
  servicesMonitored: number;
}

interface ListResponse {
  success: boolean;
  data?: {
    rows: AiReportRow[];
    total: number;
    page: number;
    limit: number;
    stats: ReportStats;
    appServices: string[];
    migrationRequired?: boolean;
  };
  message?: string;
}

const PRIORITY_CONFIG: Record<number, { label: string; bg: string; text: string; border: string; icon: React.ReactNode }> = {
  1: { label: 'Critical', bg: 'bg-red-100', text: 'text-red-800', border: 'border-red-200', icon: <AlertCircle className="h-4 w-4" /> },
  2: { label: 'Warning', bg: 'bg-yellow-100', text: 'text-yellow-800', border: 'border-yellow-200', icon: <AlertTriangle className="h-4 w-4" /> },
  3: { label: 'Info', bg: 'bg-blue-100', text: 'text-blue-800', border: 'border-blue-200', icon: <Info className="h-4 w-4" /> },
};

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  Error: <AlertCircle className="h-4 w-4 text-red-500" />,
  Performance: <Zap className="h-4 w-4 text-yellow-500" />,
  Security: <Shield className="h-4 w-4 text-purple-500" />,
  Inconsistency: <AlertTriangle className="h-4 w-4 text-orange-500" />,
  Configuration: <Server className="h-4 w-4 text-gray-500" />,
};

const AiInspectorReports: React.FC = () => {
  const navigate = useNavigate();
  const [rows, setRows] = useState<AiReportRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(25);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [migrationRequired, setMigrationRequired] = useState(false);
  const [stats, setStats] = useState<ReportStats>({ totalFindings: 0, critical: 0, warning: 0, info: 0, totalRuns: 0, servicesMonitored: 0 });
  const [appServices, setAppServices] = useState<string[]>([]);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  // Filters
  const [priorityFilter, setPriorityFilter] = useState<string>('');
  const [appServiceFilter, setAppServiceFilter] = useState<string>('');
  const [daysFilter, setDaysFilter] = useState<number>(7);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const q = new URLSearchParams({ page: String(page), limit: String(limit), days: String(daysFilter) });
    if (priorityFilter) q.set('priority', priorityFilter);
    if (appServiceFilter) q.set('appService', appServiceFilter);

    apiService
      .get<ListResponse>(`/api/me/sysadmin/ai-inspector-reports?${q.toString()}`)
      .then((res) => {
        if (res.success && res.data) {
          setRows(res.data.rows || []);
          setTotal(res.data.total ?? 0);
          setStats(res.data.stats || { totalFindings: 0, critical: 0, warning: 0, info: 0, totalRuns: 0, servicesMonitored: 0 });
          setAppServices(res.data.appServices || []);
          setMigrationRequired(res.data.migrationRequired === true);
        } else {
          setRows([]);
          setTotal(0);
          setError(res.message || 'Failed to load');
        }
      })
      .catch((e) => {
        setError(e?.message || 'Failed to load');
        setRows([]);
        setTotal(0);
      })
      .finally(() => setLoading(false));
  }, [page, limit, priorityFilter, appServiceFilter, daysFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <button
        type="button"
        onClick={() => navigate('/admin/dashboard')}
        className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900 mb-4"
      >
        <ChevronLeft className="h-4 w-4 mr-1" />
        Back to dashboard
      </button>

      <div className="flex items-center gap-3 mb-2">
        <Bot className="h-7 w-7 text-oe-primary" />
        <h1 className="text-2xl font-semibold text-gray-900">AI Inspector</h1>
      </div>
      <p className="text-gray-600 mb-6">
        Automated hourly analysis of all App Service logs using GPT. Findings are prioritized by severity.
      </p>

      {migrationRequired && (
        <div className="rounded-lg bg-yellow-50 border border-yellow-200 text-yellow-900 p-4 mb-4 flex gap-2">
          <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">Database migration required</p>
            <p className="text-sm mt-1">
              Run <code className="text-xs bg-yellow-100 px-1 rounded">sql-changes/2026-04-14-ai-inspector-reports-table.sql</code> to create{' '}
              <code className="text-xs bg-yellow-100 px-1 rounded">oe.AiInspectorReports</code>.
            </p>
          </div>
        </div>
      )}

      {/* Stats cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
        <StatCard label="Total Findings" value={stats.totalFindings} />
        <StatCard label="Critical" value={stats.critical} valueClass="text-red-600" />
        <StatCard label="Warning" value={stats.warning} valueClass="text-yellow-600" />
        <StatCard label="Info" value={stats.info} valueClass="text-blue-600" />
        <StatCard label="Runs" value={stats.totalRuns} />
        <StatCard label="Services" value={stats.servicesMonitored} />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <label className="text-sm font-medium text-gray-700">
          Priority
          <select
            value={priorityFilter}
            onChange={(e) => { setPage(1); setPriorityFilter(e.target.value); }}
            className="ml-2 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
          >
            <option value="">All</option>
            <option value="1">Critical</option>
            <option value="2">Warning</option>
            <option value="3">Info</option>
          </select>
        </label>

        <label className="text-sm font-medium text-gray-700">
          App Service
          <select
            value={appServiceFilter}
            onChange={(e) => { setPage(1); setAppServiceFilter(e.target.value); }}
            className="ml-2 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
          >
            <option value="">All</option>
            {appServices.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </label>

        <label className="text-sm font-medium text-gray-700">
          Time range
          <select
            value={daysFilter}
            onChange={(e) => { setPage(1); setDaysFilter(Number(e.target.value)); }}
            className="ml-2 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
          >
            <option value={1}>Last 24 hours</option>
            <option value={3}>Last 3 days</option>
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
          </select>
        </label>

        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50 text-sm"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 text-red-800 p-4 mb-4 flex items-center gap-2">
          <AlertCircle className="h-5 w-5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Findings list */}
      <div className="space-y-3">
        {loading && rows.length === 0 ? (
          <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
            Loading...
          </div>
        ) : rows.length === 0 ? (
          <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
            <Bot className="h-12 w-12 mx-auto mb-3 text-gray-300" />
            <p className="font-medium">No findings</p>
            <p className="text-sm mt-1">The AI Inspector hasn't flagged any issues in the selected time range.</p>
          </div>
        ) : (
          rows.map((r) => {
            const pConfig = PRIORITY_CONFIG[r.Priority] || PRIORITY_CONFIG[3];
            const isExpanded = expandedRow === r.ReportId;
            const catIcon = CATEGORY_ICONS[r.Category || ''] || CATEGORY_ICONS.Error;

            return (
              <div
                key={r.ReportId}
                className={`bg-white rounded-lg border ${r.Priority === 1 ? 'border-red-300' : 'border-gray-200'} overflow-hidden`}
              >
                <button
                  type="button"
                  onClick={() => setExpandedRow(isExpanded ? null : r.ReportId)}
                  className="w-full text-left p-4 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3 min-w-0">
                      <span className={`inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold rounded-full ${pConfig.bg} ${pConfig.text} shrink-0`}>
                        {pConfig.icon}
                        {pConfig.label}
                      </span>
                      <div className="min-w-0">
                        <h3 className="text-sm font-medium text-gray-900 truncate">{r.Title}</h3>
                        <div className="flex items-center gap-2 mt-1 text-xs text-gray-500">
                          {catIcon}
                          <span>{r.Category || 'Error'}</span>
                          <span className="text-gray-300">|</span>
                          <Server className="h-3 w-3" />
                          <span>{r.AppServiceName}</span>
                          <span className="text-gray-300">|</span>
                          <span>{r.CreatedAt ? new Date(r.CreatedAt).toLocaleString() : '—'}</span>
                        </div>
                      </div>
                    </div>
                    {isExpanded ? (
                      <ChevronUp className="h-5 w-5 text-gray-400 shrink-0" />
                    ) : (
                      <ChevronDown className="h-5 w-5 text-gray-400 shrink-0" />
                    )}
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t border-gray-200 p-4 space-y-4">
                    <div>
                      <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Summary</h4>
                      <p className="text-sm text-gray-800">{r.Summary}</p>
                    </div>

                    {r.Recommendation && (
                      <div>
                        <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Recommendation</h4>
                        <p className="text-sm text-blue-800 bg-blue-50 rounded-lg p-3">{r.Recommendation}</p>
                      </div>
                    )}

                    {r.RawLogExcerpt && (
                      <div>
                        <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Log Excerpt</h4>
                        <pre className="text-xs text-gray-700 bg-gray-50 rounded-lg p-3 overflow-x-auto max-h-48 overflow-y-auto font-mono whitespace-pre-wrap">
                          {r.RawLogExcerpt}
                        </pre>
                      </div>
                    )}

                    <div className="text-xs text-gray-400">
                      Run ID: {r.RunId}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Pagination */}
      {total > limit && (
        <div className="mt-4 flex items-center justify-between text-sm text-gray-600">
          <span>
            Page {page} of {totalPages} ({total} total)
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={page >= totalPages || loading}
              onClick={() => setPage((p) => p + 1)}
              className="px-3 py-1.5 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

const StatCard: React.FC<{ label: string; value: number; valueClass?: string }> = ({ label, value, valueClass }) => (
  <div className="bg-white rounded-lg border border-gray-200 p-4">
    <p className="text-xs font-medium text-gray-500 uppercase">{label}</p>
    <p className={`text-2xl font-semibold mt-1 ${valueClass || 'text-gray-900'}`}>{value}</p>
  </div>
);

export default AiInspectorReports;
