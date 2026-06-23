// frontend/src/pages/vendor/VendorCallCenter.tsx
//
// Rebuilt Call Center for the vendor back office. Four tabs:
//   • Live      — who's on the line now, with auto member pull-up
//   • History   — call log with AI summaries + full transcripts + recordings
//   • My Stats  — per-agent (and vendor-wide) call statistics
//   • Reports   — VendorAdmin per-agent breakdown with date range + CSV export

import {
  AlertCircle,
  BarChart3,
  ChevronDown,
  ChevronRight,
  Clock,
  Download,
  FileText,
  Headphones,
  History as HistoryIcon,
  Loader2,
  PhoneCall,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  RadioTower,
  RefreshCw,
  Settings,
  User,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  vendorCallCenterService as svc,
  type ActiveCall,
  type AgentReportRow,
  type CallCenterConfig,
  type CallDetail,
  type CallListItem,
  type CallStats,
  type MemberContext,
} from '../../services/vendorCallCenter.service';
import { AttachToCase, AttachToShareRequest } from '../../components/vendor/encounters/AttachPicker';

type TabKey = 'live' | 'history' | 'stats' | 'reports';

const inputClass =
  'rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:border-oe-primary focus:ring-1 focus:ring-oe-primary';

// --------------------------------------------------------------------------
// formatters
// --------------------------------------------------------------------------
const fmtDuration = (s?: number | null): string => {
  if (!s || s < 0) return '0s';
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
};

const fmtDateTime = (iso?: string | null): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const fmtPhone = (p?: string | null): string => {
  if (!p) return '—';
  const digits = p.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return p;
};

const memberName = (first?: string | null, last?: string | null): string =>
  `${first || ''} ${last || ''}`.trim();

function agentDisplay(c: CallListItem) {
  const name = `${c.AgentFirstName || ''} ${c.AgentLastName || ''}`.trim();
  if (name) return <span>{name}</span>;
  if (c.AnsweredBy === 'AutoReceptionist') {
    return <span className="text-gray-600 italic">Auto Receptionist (AI)</span>;
  }
  if (c.AnsweredBy === 'CallQueue') {
    return <span className="text-gray-600 italic">Call Queue</span>;
  }
  if (c.AnsweredBy === 'CommonArea') {
    return <span className="text-gray-600 italic">Common Area Phone</span>;
  }
  if (c.AnsweredBy === 'SharedLineGroup') {
    return <span className="text-gray-600 italic">Shared Line</span>;
  }
  return <span className="text-gray-400">—</span>;
}

const directionIcon = (call: { CallType: string; CallStatus?: string }) => {
  if (call.CallType === 'Missed' || call.CallStatus === 'Missed') return <PhoneMissed size={16} className="text-red-500" />;
  if (call.CallType === 'Outbound') return <PhoneOutgoing size={16} className="text-oe-primary" />;
  return <PhoneIncoming size={16} className="text-oe-success" />;
};

// --------------------------------------------------------------------------
// Page
// --------------------------------------------------------------------------
const VendorCallCenter: React.FC = () => {
  const navigate = useNavigate();
  const [config, setConfig] = useState<CallCenterConfig | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [tab, setTab] = useState<TabKey>('live');
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  useEffect(() => {
    svc.getConfig()
      .then(setConfig)
      .catch(() => setConfig(null))
      .finally(() => setLoadingConfig(false));
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      await svc.sync();
      setSyncMsg('Sync started — new calls will appear shortly.');
    } catch (err) {
      setSyncMsg(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  if (loadingConfig) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-500">
        <Loader2 className="animate-spin mr-2" size={20} /> Loading Call Center…
      </div>
    );
  }

  if (!config || !config.enabled || !config.configured) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <div className="bg-white rounded-lg border border-gray-200 p-10 text-center">
          <div className="mx-auto w-14 h-14 rounded-full bg-oe-light flex items-center justify-center mb-4">
            <PhoneCall className="text-oe-primary" size={28} />
          </div>
          <h2 className="text-xl font-semibold text-gray-900">Phone system not connected</h2>
          <p className="text-gray-500 mt-2 mb-6">
            {config?.isAdmin
              ? 'Connect your Zoom Phone line to start tracking calls, transcripts, and live activity.'
              : 'Ask a vendor administrator to connect the Zoom phone line to enable the Call Center.'}
          </p>
          {config?.isAdmin && (
            <button
              onClick={() => navigate('/vendor/zoom-settings')}
              className="inline-flex items-center gap-2 bg-oe-primary hover:bg-oe-dark text-white rounded-lg px-4 py-2 text-sm font-medium"
            >
              <Settings size={16} /> Go to Phone &amp; Zoom settings
            </button>
          )}
        </div>
      </div>
    );
  }

  const tabs: Array<{ key: TabKey; label: string; icon: React.ReactNode; adminOnly?: boolean }> = [
    { key: 'live', label: 'Live', icon: <RadioTower size={16} /> },
    { key: 'history', label: 'History', icon: <HistoryIcon size={16} /> },
    { key: 'stats', label: 'My Stats', icon: <BarChart3 size={16} /> },
    { key: 'reports', label: 'Reports', icon: <FileText size={16} />, adminOnly: true },
  ];
  const visibleTabs = tabs.filter((t) => !t.adminOnly || config.isAdmin);

  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-oe-light rounded-lg">
            <PhoneCall className="text-oe-primary" size={22} />
          </div>
          <h1 className="text-2xl font-semibold text-gray-900">Call Center</h1>
        </div>
        <div className="flex items-center gap-2">
          {syncMsg && <span className="text-xs text-gray-500">{syncMsg}</span>}
          <button
            onClick={handleSync}
            disabled={syncing}
            className="inline-flex items-center gap-2 border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-lg px-3 py-2 text-sm disabled:opacity-60"
          >
            {syncing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            Sync from Zoom
          </button>
          {config.isAdmin && (
            <button
              onClick={() => navigate('/vendor/zoom-settings')}
              className="inline-flex items-center gap-2 border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-lg px-3 py-2 text-sm"
            >
              <Settings size={16} /> Settings
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-1">
          {visibleTabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
                tab === t.key
                  ? 'border-oe-primary text-oe-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {tab === 'live' && <LiveTab />}
      {tab === 'history' && <HistoryTab />}
      {tab === 'stats' && <StatsTab isAdmin={config.isAdmin} />}
      {tab === 'reports' && config.isAdmin && <ReportsTab />}
    </div>
  );
};

// --------------------------------------------------------------------------
// Live tab
// --------------------------------------------------------------------------
const LiveTab: React.FC = () => {
  const [calls, setCalls] = useState<ActiveCall[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [expanded, setExpanded] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await svc.getLiveCalls();
      setCalls(data);
    } catch {
      /* keep last good state */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const poll = setInterval(() => void refresh(), 5000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [refresh]);

  if (loading) {
    return <div className="flex items-center text-gray-500 py-10"><Loader2 className="animate-spin mr-2" size={18} /> Loading live calls…</div>;
  }

  if (calls.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-10 text-center text-gray-500">
        <RadioTower className="mx-auto mb-3 text-gray-300" size={32} />
        No active calls right now. Live calls will appear here automatically.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {calls.map((call) => {
        const elapsed = Math.max(0, Math.floor((now - new Date(call.CallStartTime).getTime()) / 1000));
        const isExpanded = expanded === call.ActiveCallId;
        return (
          <div key={call.ActiveCallId} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <div className="p-4">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  {directionIcon(call)}
                  <span className="text-xs font-medium uppercase tracking-wide text-gray-500">{call.CallType}</span>
                  <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-green-50 text-green-700">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" /> {call.CallStatus}
                  </span>
                </div>
                <span className="inline-flex items-center gap-1 text-sm font-mono text-gray-700">
                  <Clock size={14} /> {fmtDuration(elapsed)}
                </span>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <div className="text-xs text-gray-400">Caller</div>
                  <div className="font-medium text-gray-900">{call.CallerName || fmtPhone(call.CallerNumber)}</div>
                  <div className="text-xs text-gray-500">{fmtPhone(call.CallerNumber)}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-400">Agent</div>
                  <div className="font-medium text-gray-900">{call.AgentName || '—'}</div>
                  {call.AgentExtension && <div className="text-xs text-gray-500">ext. {call.AgentExtension}</div>}
                </div>
              </div>

              {/* Member pull-up */}
              <div className="mt-3 rounded-lg bg-gray-50 border border-gray-100 p-3">
                {call.MemberId ? (
                  <>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <User size={16} className="text-oe-primary" />
                        <span className="font-medium text-gray-900">
                          {memberName(call.MemberFirstName, call.MemberLastName) || 'Member'}
                        </span>
                      </div>
                      <button
                        onClick={() => setExpanded(isExpanded ? null : call.ActiveCallId)}
                        className="inline-flex items-center gap-1 text-xs text-oe-primary hover:text-oe-dark"
                      >
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        Details
                      </button>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-3 text-xs text-gray-600">
                      {call.MemberEmail && <span>{call.MemberEmail}</span>}
                      <span className="inline-flex items-center gap-1">
                        <span className="px-1.5 py-0.5 rounded bg-oe-light text-oe-dark">{call.OpenCaseCount}</span> open cases
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <span className="px-1.5 py-0.5 rounded bg-oe-light text-oe-dark">{call.OpenShareRequestCount}</span> share requests
                      </span>
                    </div>
                    {isExpanded && <MemberContextPanel memberId={call.MemberId} />}
                  </>
                ) : (
                  <div className="flex items-center gap-2 text-sm text-gray-500">
                    <AlertCircle size={16} className="text-amber-500" />
                    No member matched to {fmtPhone(call.CallerNumber)}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

const MemberContextPanel: React.FC<{ memberId: string }> = ({ memberId }) => {
  const navigate = useNavigate();
  const [ctx, setCtx] = useState<MemberContext | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    svc.getMemberContext(memberId)
      .then(setCtx)
      .catch(() => setCtx(null))
      .finally(() => setLoading(false));
  }, [memberId]);

  if (loading) return <div className="mt-2 text-xs text-gray-400">Loading member details…</div>;
  if (!ctx) return <div className="mt-2 text-xs text-gray-400">Could not load member details.</div>;

  return (
    <div className="mt-3 space-y-3 border-t border-gray-200 pt-3">
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div><span className="text-gray-400">Phone:</span> {fmtPhone(ctx.member.Phone)}</div>
        <div><span className="text-gray-400">DOB:</span> {ctx.member.DateOfBirth || '—'}</div>
      </div>
      <button
        onClick={() => navigate(`/vendor/members/${memberId}`)}
        className="text-xs text-oe-primary hover:text-oe-dark"
      >
        Open full member profile →
      </button>

      <div>
        <div className="text-xs font-medium text-gray-500 mb-1">Open cases ({ctx.openCases.length})</div>
        {ctx.openCases.length === 0 ? (
          <div className="text-xs text-gray-400">None</div>
        ) : (
          <ul className="space-y-1">
            {ctx.openCases.map((c) => (
              <li key={c.CaseId}>
                <button
                  onClick={() => navigate(`/vendor/cases/${c.CaseId}`)}
                  className="text-xs text-oe-primary hover:text-oe-dark"
                >
                  {c.CaseNumber} — {c.Title || c.Status}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="text-xs font-medium text-gray-500 mb-1">Open share requests ({ctx.openShareRequests.length})</div>
        {ctx.openShareRequests.length === 0 ? (
          <div className="text-xs text-gray-400">None</div>
        ) : (
          <ul className="space-y-1">
            {ctx.openShareRequests.map((s) => (
              <li key={s.ShareRequestId}>
                <button
                  onClick={() => navigate(`/vendor/share-requests/${s.ShareRequestId}`)}
                  className="text-xs text-oe-primary hover:text-oe-dark"
                >
                  {s.RequestNumber} — {s.RequestTypeName || s.Status}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

// --------------------------------------------------------------------------
// History tab
// --------------------------------------------------------------------------
const HistoryTab: React.FC = () => {
  const navigate = useNavigate();
  const [calls, setCalls] = useState<CallListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [direction, setDirection] = useState('');
  const [scope, setScope] = useState<'all' | 'mine'>('all');
  const [matched, setMatched] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [offset, setOffset] = useState(0);
  const limit = 50;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await svc.getCalls({
        search: search || undefined,
        direction: direction || undefined,
        scope: scope === 'mine' ? 'mine' : undefined,
        matched: matched === 'matched' ? true : matched === 'unmatched' ? false : undefined,
        fromDate: fromDate || undefined,
        toDate: toDate || undefined,
        limit,
        offset,
      });
      setCalls(res.calls);
      setTotal(res.total);
    } catch {
      setCalls([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [search, direction, scope, matched, fromDate, toDate, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  // reset paging when filters change
  useEffect(() => {
    setOffset(0);
  }, [search, direction, scope, matched, fromDate, toDate]);

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          placeholder="Search number, name, or request #"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={`${inputClass} flex-1 min-w-[220px]`}
        />
        <select value={direction} onChange={(e) => setDirection(e.target.value)} className={inputClass}>
          <option value="">All directions</option>
          <option value="Inbound">Inbound</option>
          <option value="Outbound">Outbound</option>
          <option value="Missed">Missed</option>
          <option value="Voicemail">Voicemail</option>
        </select>
        <select value={matched} onChange={(e) => setMatched(e.target.value)} className={inputClass}>
          <option value="">Any match</option>
          <option value="matched">Matched to member</option>
          <option value="unmatched">Unmatched</option>
        </select>
        <select value={scope} onChange={(e) => setScope(e.target.value as 'all' | 'mine')} className={inputClass}>
          <option value="all">All agents</option>
          <option value="mine">My calls</option>
        </select>
        <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className={inputClass} />
        <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className={inputClass} />
      </div>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="flex items-center text-gray-500 p-10"><Loader2 className="animate-spin mr-2" size={18} /> Loading calls…</div>
        ) : calls.length === 0 ? (
          <div className="p-10 text-center text-gray-500">No calls match your filters.</div>
        ) : (
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="w-8" />
                <th className="px-3 py-2 text-left font-medium text-gray-500">Direction</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Caller</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Member</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Agent</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">Duration</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500">When</th>
                <th className="px-3 py-2 text-left font-medium text-gray-500" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {calls.map((c) => (
                <React.Fragment key={c.CallLogId}>
                  <tr className="hover:bg-gray-50">
                    <td className="pl-3">
                      <button onClick={() => setExpanded(expanded === c.CallLogId ? null : c.CallLogId)}>
                        {expanded === c.CallLogId ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </button>
                    </td>
                    <td className="px-3 py-2"><span className="inline-flex items-center gap-1">{directionIcon(c)} {c.CallType}</span></td>
                    <td className="px-3 py-2">
                      <div className="text-gray-900">{c.CallerName || fmtPhone(c.CallerNumber)}</div>
                      <div className="text-xs text-gray-400">{fmtPhone(c.CallerNumber)}</div>
                    </td>
                    <td className="px-3 py-2">
                      {c.MemberId ? (
                        <button
                          onClick={() => navigate(`/vendor/members/${c.MemberId}`)}
                          className="text-left text-oe-primary hover:text-oe-dark hover:underline"
                        >
                          {memberName(c.MemberFirstName, c.MemberLastName) || 'View member'}
                        </button>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">{agentDisplay(c)}</td>
                    <td className="px-3 py-2">{fmtDuration(c.CallDurationSeconds)}</td>
                    <td className="px-3 py-2 text-gray-600">{fmtDateTime(c.CallStartTime)}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1">
                        {c.HasRecording && <Headphones size={14} className="text-gray-400" aria-label="Recording available" />}
                        {c.HasTranscript && <FileText size={14} className="text-gray-400" />}
                        {c.AISummary && (
                          <img
                            src="/images/columbus.webp"
                            alt="Columbus summary"
                            title="Columbus summary available"
                            className="w-4 h-4 rounded-full object-cover"
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                  {expanded === c.CallLogId && (
                    <tr>
                      <td colSpan={8} className="bg-gray-50 px-6 py-4">
                        <CallDetailPanel call={c} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Paging */}
      {total > limit && (
        <div className="flex items-center justify-between text-sm text-gray-600">
          <span>
            {offset + 1}–{Math.min(offset + limit, total)} of {total}
          </span>
          <div className="flex gap-2">
            <button
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - limit))}
              className="border border-gray-300 rounded-lg px-3 py-1 disabled:opacity-50 hover:bg-gray-50"
            >
              Previous
            </button>
            <button
              disabled={offset + limit >= total}
              onClick={() => setOffset(offset + limit)}
              className="border border-gray-300 rounded-lg px-3 py-1 disabled:opacity-50 hover:bg-gray-50"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

const CallDetailPanel: React.FC<{ call: CallListItem }> = ({ call }) => {
  const navigate = useNavigate();
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [showTranscript, setShowTranscript] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [summary, setSummary] = useState<string | null>(call.AISummary);
  const [notes, setNotes] = useState(call.CallNotes || '');
  const [savingNotes, setSavingNotes] = useState(false);

  useEffect(() => {
    svc.getCall(call.CallLogId)
      .then((d) => {
        setDetail(d);
        if (d.AISummary) setSummary(d.AISummary);
        setNotes(d.CallNotes || '');
      })
      .catch(() => setDetail(null));
  }, [call.CallLogId]);

  const handleSummarize = async () => {
    setSummarizing(true);
    try {
      const res = await svc.generateSummary(call.CallLogId, !!summary);
      if (res.summary) setSummary(res.summary);
      else if (res.reason === 'no_transcript') setSummary(null);
    } catch {
      /* surfaced via status */
    } finally {
      setSummarizing(false);
    }
  };

  const handleSaveNotes = async () => {
    setSavingNotes(true);
    try {
      await svc.updateCall(call.CallLogId, { callNotes: notes });
    } finally {
      setSavingNotes(false);
    }
  };

  const refreshDetail = () => {
    svc.getCall(call.CallLogId)
      .then((d) => {
        setDetail(d);
        if (d.AISummary) setSummary(d.AISummary);
        setNotes(d.CallNotes || '');
      })
      .catch(() => {});
  };

  const hasTranscript = !!detail?.TranscriptText && detail.TranscriptText.trim().length > 0;

  return (
    <div className="space-y-3">
      {/* Panel header — refresh button */}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={refreshDetail}
          aria-label="Refresh"
          title="Refresh call details"
          className="inline-flex items-center justify-center p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Summary + transcript */}
      <div className="lg:col-span-2 space-y-4">
        <div>
          <div className="flex items-center justify-between mb-1">
            <h4 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
              <img
                src="/images/columbus.webp"
                alt="Columbus"
                className="w-5 h-5 rounded-full object-cover"
              />
              Columbus Summary
            </h4>
            <button
              onClick={handleSummarize}
              disabled={summarizing || (!hasTranscript && !summary)}
              className="text-xs text-oe-primary hover:text-oe-dark disabled:text-gray-300"
            >
              {summarizing ? 'Generating…' : summary ? 'Regenerate' : 'Generate'}
            </button>
          </div>
          {summary ? (
            <p className="text-sm text-gray-700 whitespace-pre-line leading-relaxed">{summary}</p>
          ) : (
            <p className="text-sm text-gray-400">
              {hasTranscript ? 'No summary yet — click Generate.' : 'No transcript available to summarize.'}
            </p>
          )}
        </div>

        {hasTranscript && (
          <div>
            <button
              onClick={() => setShowTranscript((v) => !v)}
              className="inline-flex items-center gap-1 text-sm text-gray-700 hover:text-gray-900"
            >
              {showTranscript ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              {showTranscript ? 'Hide' : 'View'} full transcript
            </button>
            {showTranscript && (
              <TranscriptChat raw={detail?.TranscriptText || ''} />
            )}
          </div>
        )}

        {call.HasRecording && <RecordingPlayer callLogId={call.CallLogId} />}
      </div>

      {/* Meta + notes */}
      <div className="space-y-3 text-sm">
        {call.MemberId && (
          <div>
            <div className="text-xs text-gray-400 mb-1">Member</div>
            <button
              onClick={() => navigate(`/vendor/members/${call.MemberId}`)}
              className="text-sm font-medium text-oe-primary hover:text-oe-dark hover:underline"
            >
              {memberName(call.MemberFirstName, call.MemberLastName) || 'View member'} →
            </button>
            {/* Reuses the Live tab's panel: open cases + open share requests, all linkable */}
            <MemberContextPanel memberId={call.MemberId} />
          </div>
        )}
        <div>
          <div className="text-xs text-gray-400">Status</div>
          <div className="text-gray-800">{call.CallStatus}</div>
        </div>
        {call.RequestNumber && (
          <div>
            <div className="text-xs text-gray-400">Linked request</div>
            <div className="text-gray-800">{call.RequestNumber}</div>
          </div>
        )}
        {detail?.EncounterId && (
          <div className="border border-gray-200 rounded-lg p-4 bg-gray-50">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-700">Encounter</span>
              <a
                href={`/vendor/encounters/${detail.EncounterId}`}
                className="text-sm text-oe-primary hover:text-oe-dark"
              >
                Open ↗
              </a>
            </div>
            <div className="space-y-2">
              <AttachToCase
                encounterId={detail.EncounterId}
                memberId={call.MemberId}
                currentCaseId={detail.EncounterCaseId}
                onAttached={refreshDetail}
              />
              <AttachToShareRequest
                encounterId={detail.EncounterId}
                memberId={call.MemberId}
                currentShareRequestId={detail.EncounterShareRequestId}
                onAttached={refreshDetail}
              />
            </div>
          </div>
        )}
        <div>
          <div className="text-xs text-gray-400 mb-1">Notes (shared with encounter)</div>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className={`${inputClass} w-full`}
            placeholder="Add a note about this call…"
          />
          <button
            onClick={handleSaveNotes}
            disabled={savingNotes}
            className="mt-1 text-xs bg-oe-primary hover:bg-oe-dark text-white rounded-lg px-3 py-1 disabled:opacity-60"
          >
            {savingNotes ? 'Saving…' : 'Save note'}
          </button>
        </div>
      </div>
    </div>
    </div>
  );
};

/**
 * Renders a Zoom transcript as a chat-style conversation. Zoom delivers
 * transcripts as a JSON blob with a `timeline[]` array of utterances; we
 * parse it and bubble each speaker. Falls back to a plain <pre> for plain
 * text transcripts or unparseable input.
 */
type TranscriptUtterance = { speaker: string; text: string; ts: string; zoomUserId?: string };

function parseZoomTranscript(raw: string): TranscriptUtterance[] | null {
  const trimmed = raw?.trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (!Array.isArray(obj?.timeline)) return null;
    return obj.timeline
      .map((e: any): TranscriptUtterance => ({
        speaker: e.username || e.users?.[0]?.username || 'Unknown',
        text: (e.text || e.raw_text || '').trim(),
        ts: (e.ts || '').split('.')[0],
        zoomUserId: e.zoom_userid || e.users?.[0]?.zoom_userid,
      }))
      .filter((u: TranscriptUtterance) => u.text.length > 0);
  } catch {
    return null;
  }
}

const TranscriptChat: React.FC<{ raw: string }> = ({ raw }) => {
  const utterances = parseZoomTranscript(raw);
  if (!utterances) {
    // Plain-text fallback
    return (
      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-gray-200 bg-white p-3 text-xs text-gray-700">
        {raw}
      </pre>
    );
  }
  // Decide which side each speaker sits on. First-seen speaker on the left,
  // the rest on the right. (Most calls have 2 speakers; for 3+, second-seen
  // and beyond all sit on the right with distinct accents.)
  const speakers = Array.from(new Set(utterances.map((u) => u.speaker)));
  const sideMap = new Map<string, 'left' | 'right'>();
  speakers.forEach((s, i) => sideMap.set(s, i === 0 ? 'left' : 'right'));

  return (
    <div className="mt-2 max-h-96 overflow-auto rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2">
      {utterances.map((u, idx) => {
        const side = sideMap.get(u.speaker) ?? 'left';
        const isLeft = side === 'left';
        return (
          <div key={idx} className={`flex ${isLeft ? 'justify-start' : 'justify-end'}`}>
            <div className={`max-w-[78%] ${isLeft ? '' : 'text-right'}`}>
              <div className={`text-xs ${isLeft ? 'text-gray-600' : 'text-oe-dark'} mb-0.5`}>
                <span className="font-medium">{u.speaker}</span>
                {u.ts && <span className="text-gray-400 ml-2">{u.ts}</span>}
              </div>
              <div
                className={`inline-block px-3 py-2 rounded-2xl text-sm leading-snug ${
                  isLeft
                    ? 'bg-white border border-gray-200 text-gray-800 rounded-tl-sm'
                    : 'bg-oe-light text-gray-800 rounded-tr-sm'
                }`}
              >
                {u.text}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

const RecordingPlayer: React.FC<{ callLogId: string }> = ({ callLogId }) => {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(false);
    try {
      const blob = await svc.getRecordingBlob(callLogId);
      setUrl(URL.createObjectURL(blob));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  if (url) return <audio controls src={url} className="w-full mt-2" />;
  return (
    <button
      onClick={load}
      disabled={loading}
      className="inline-flex items-center gap-1 text-sm text-oe-primary hover:text-oe-dark"
    >
      {loading ? <Loader2 size={15} className="animate-spin" /> : '🎧'}
      {error ? 'Recording unavailable' : loading ? 'Loading recording…' : 'Play recording'}
    </button>
  );
};

// --------------------------------------------------------------------------
// Stats tab
// --------------------------------------------------------------------------
const StatsTab: React.FC<{ isAdmin: boolean }> = ({ isAdmin }) => {
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [stats, setStats] = useState<CallStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    svc.getStats(scope, fromDate || undefined, toDate || undefined)
      .then(setStats)
      .catch(() => setStats(null))
      .finally(() => setLoading(false));
  }, [scope, fromDate, toDate]);

  const cards = useMemo(
    () =>
      stats
        ? [
            { label: 'Total calls', value: stats.TotalCalls },
            { label: 'Inbound', value: stats.Inbound },
            { label: 'Outbound', value: stats.Outbound },
            { label: 'Missed', value: stats.Missed },
            { label: 'Talk time', value: fmtDuration(stats.TotalDurationSeconds) },
            { label: 'Avg duration', value: fmtDuration(Math.round(stats.AvgDurationSeconds)) },
            { label: 'Members reached', value: stats.UniqueMembers },
            { label: 'With recording', value: stats.WithRecording },
            { label: 'With summary', value: stats.WithSummary },
          ]
        : [],
    [stats]
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select value={scope} onChange={(e) => setScope(e.target.value as 'mine' | 'all')} className={inputClass}>
          <option value="mine">My stats</option>
          {isAdmin && <option value="all">All agents</option>}
        </select>
        <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className={inputClass} />
        <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className={inputClass} />
      </div>

      {loading ? (
        <div className="flex items-center text-gray-500 py-10"><Loader2 className="animate-spin mr-2" size={18} /> Loading stats…</div>
      ) : !stats ? (
        <div className="text-gray-500">No stats available.</div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {cards.map((c) => (
            <div key={c.label} className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="text-2xl font-semibold text-gray-900">{c.value}</div>
              <div className="text-xs text-gray-500 mt-1">{c.label}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// --------------------------------------------------------------------------
// Reports tab (admin)
// --------------------------------------------------------------------------
const ReportsTab: React.FC = () => {
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [rows, setRows] = useState<AgentReportRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await svc.getAgentReport(fromDate || undefined, toDate || undefined));
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate]);

  useEffect(() => {
    void load();
  }, [load]);

  const agentLabel = (r: AgentReportRow) =>
    memberName(r.AgentFirstName, r.AgentLastName) || (r.AgentUserId ? 'Unknown agent' : 'Unattributed');

  const exportCsv = () => {
    const header = ['Agent', 'Total', 'Inbound', 'Outbound', 'Missed', 'Talk time (s)', 'Avg (s)', 'Members'];
    const lines = rows.map((r) =>
      [agentLabel(r), r.TotalCalls, r.Inbound, r.Outbound, r.Missed, r.TotalDurationSeconds, Math.round(r.AvgDurationSeconds), r.UniqueMembers].join(',')
    );
    const csv = [header.join(','), ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `call-report-${fromDate || 'all'}_${toDate || 'now'}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({
          calls: acc.calls + r.TotalCalls,
          duration: acc.duration + r.TotalDurationSeconds,
        }),
        { calls: 0, duration: 0 }
      ),
    [rows]
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className={inputClass} />
        <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className={inputClass} />
        <button onClick={() => void load()} className="inline-flex items-center gap-1 border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-lg px-3 py-2 text-sm">
          <RefreshCw size={15} /> Run report
        </button>
        <button
          onClick={exportCsv}
          disabled={rows.length === 0}
          className="inline-flex items-center gap-1 bg-oe-primary hover:bg-oe-dark text-white rounded-lg px-3 py-2 text-sm disabled:opacity-60"
        >
          <Download size={15} /> Export CSV
        </button>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="flex items-center text-gray-500 p-10"><Loader2 className="animate-spin mr-2" size={18} /> Building report…</div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center text-gray-500">No calls in this range.</div>
        ) : (
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-gray-500">Agent</th>
                <th className="px-4 py-2 text-right font-medium text-gray-500">Total</th>
                <th className="px-4 py-2 text-right font-medium text-gray-500">Inbound</th>
                <th className="px-4 py-2 text-right font-medium text-gray-500">Outbound</th>
                <th className="px-4 py-2 text-right font-medium text-gray-500">Missed</th>
                <th className="px-4 py-2 text-right font-medium text-gray-500">Talk time</th>
                <th className="px-4 py-2 text-right font-medium text-gray-500">Avg</th>
                <th className="px-4 py-2 text-right font-medium text-gray-500">Members</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r, i) => (
                <tr key={r.AgentUserId || `unattributed-${i}`} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-medium text-gray-900">{agentLabel(r)}</td>
                  <td className="px-4 py-2 text-right">{r.TotalCalls}</td>
                  <td className="px-4 py-2 text-right">{r.Inbound}</td>
                  <td className="px-4 py-2 text-right">{r.Outbound}</td>
                  <td className="px-4 py-2 text-right">{r.Missed}</td>
                  <td className="px-4 py-2 text-right">{fmtDuration(r.TotalDurationSeconds)}</td>
                  <td className="px-4 py-2 text-right">{fmtDuration(Math.round(r.AvgDurationSeconds))}</td>
                  <td className="px-4 py-2 text-right">{r.UniqueMembers}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-gray-50 font-medium">
              <tr>
                <td className="px-4 py-2">Total</td>
                <td className="px-4 py-2 text-right">{totals.calls}</td>
                <td colSpan={4} />
                <td className="px-4 py-2 text-right">{fmtDuration(totals.duration)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  );
};

export default VendorCallCenter;
