// frontend/src/pages/vendor/VendorDashboard.tsx
//
// Back-office dashboard. Per GitHub issue #359, plus richer visuals:
//   - "Right now" highlight strip (3 small cards)
//   - "Your activity" stat cards
//   - "Back-office totals" stat cards
//   - 30-day daily volume line chart (SR + Cases)
//   - SR status breakdown (horizontal bars)
//   - Team workload (stacked bar per user)
//   - Recent share requests table

import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Briefcase,
  ClipboardCheck,
  ClipboardList,
  FileText,
  Home,
  Inbox,
  TrendingUp,
  Users
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import { apiService } from '../../services/api.service';

interface DailyPoint {
  date: string; // YYYY-MM-DD
  sr: number;
  cases: number;
}

interface StatusBreakdownRow {
  status: string;
  count: number;
}

interface TeamMember {
  userId: string;
  name: string;
  srClaimed: number;
  caseClaimed: number;
}

interface RecentShareRequest {
  id: string;
  requestNumber: string | null;
  status: string;
  submittedDate: string;
  totalBilledAmount: number | null;
  memberName: string | null;
  claimedByName: string | null;
}

interface DashboardStats {
  userStats: {
    shareRequestsWorked: number;
    casesWorked: number;
    openShareRequestsAssigned: number;
    openCasesAssigned: number;
    newFormSubmissions: number;
  };
  backOfficeStats: {
    totalShareRequests: number;
    totalCases: number;
    openShareRequests: number;
    openCases: number;
    shareRequestsOpenedThisWeek: number;
    enrolledHouseholds: number;
    enrolledLives: number;
  };
  today: {
    srOpenedToday: number;
    srUnclaimedOpen: number;
    srAvgClaimMinutes: number | null;
  };
  dailyVolume: DailyPoint[];
  srStatusBreakdown: StatusBreakdownRow[];
  caseStatusBreakdown: StatusBreakdownRow[];
  teamWorkload: TeamMember[];
  recentShareRequests: RecentShareRequest[];
}

interface StatCardProps {
  label: string;
  value: number | string;
  icon: React.ReactNode;
  onClick?: () => void;
  accent?: string;
  hint?: string;
}

const StatCard: React.FC<StatCardProps> = ({ label, value, icon, onClick, accent, hint }) => {
  const interactive = !!onClick;
  const Cmp: React.ElementType = interactive ? 'button' : 'div';
  return (
    <Cmp
      type={interactive ? 'button' : undefined}
      onClick={onClick}
      className={`text-left bg-white rounded-lg border border-gray-200 p-6 shadow-sm ${
        interactive ? 'hover:border-oe-primary hover:shadow transition-all' : ''
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <div className={`p-2 rounded-lg text-white ${accent || 'bg-oe-primary'}`}>{icon}</div>
      </div>
      <div className="text-2xl font-semibold text-gray-900 mb-1">{value}</div>
      <div className="text-sm text-gray-600">{label}</div>
      {hint && <div className="text-xs text-gray-400 mt-1">{hint}</div>}
    </Cmp>
  );
};

const CardShell: React.FC<{ title: string; subtitle?: string; children: React.ReactNode }> = ({
  title,
  subtitle,
  children
}) => (
  <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
    <div className="px-6 py-4 border-b border-gray-200">
      <h3 className="text-base font-medium text-gray-900">{title}</h3>
      {subtitle && <p className="text-xs text-gray-500">{subtitle}</p>}
    </div>
    <div className="p-6">{children}</div>
  </div>
);

// Tailwind palette values (matches the rest of the back office)
const COLOR_OE_PRIMARY = '#1f8dbf';
const COLOR_INDIGO = '#6366f1';
const COLOR_AMBER = '#f59e0b';
const COLOR_GREEN = '#10b981';
const COLOR_PURPLE = '#a855f7';
const COLOR_GRAY = '#9ca3af';

const STATUS_BAR_COLORS: Record<string, string> = {
  New: COLOR_OE_PRIMARY,
  Acknowledged: COLOR_INDIGO,
  'In Review': COLOR_PURPLE,
  'Awaiting Member Info': COLOR_AMBER,
  'Awaiting Authorization': '#f97316',
  Processing: '#8b5cf6',
  Completed: COLOR_GREEN,
  Denied: '#ef4444',
  Withdrawn: COLOR_GRAY,
  Open: COLOR_OE_PRIMARY,
  'In Progress': COLOR_PURPLE,
  Pending: COLOR_AMBER,
  Closed: COLOR_GREEN
};

const formatShortDate = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const formatCurrency = (amount: number | null): string =>
  amount == null
    ? '—'
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount);

const VendorDashboard: React.FC = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        setLoading(true);
        setError(null);
        const resp = await apiService.get<{ success: boolean; data: DashboardStats }>(
          '/api/me/vendor/dashboard/stats'
        );
        if (cancelled) return;
        if (resp.success && resp.data) setStats(resp.data);
        else setError('Failed to load dashboard stats.');
      } catch (err) {
        if (!cancelled) {
          console.error('Error loading dashboard stats:', err);
          setError((err instanceof Error && err.message) || 'Failed to load dashboard stats.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <DashboardSkeleton />;
  }

  const us = stats?.userStats;
  const bs = stats?.backOfficeStats;
  const daily = stats?.dailyVolume || [];
  const srBreakdown = (stats?.srStatusBreakdown || []).slice().sort((a, b) => b.count - a.count);
  const caseBreakdown = (stats?.caseStatusBreakdown || []).slice().sort((a, b) => b.count - a.count);
  const team = stats?.teamWorkload || [];
  const recent = stats?.recentShareRequests || [];

  // Recharts data shaped for the daily-volume chart — drop the year for the
  // axis label to keep the X axis readable.
  const dailyChart = daily.map((d) => ({ ...d, label: formatShortDate(d.date) }));

  return (
    <div className="p-6 space-y-8 animate-fade-in-fast">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Dashboard</h1>
        <p className="text-gray-600">Overview of your activity and your team's back-office workload.</p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-800">{error}</div>
      )}

      {/* ---------- Your activity ---------- */}
      <section>
        <h2 className="text-lg font-medium text-gray-900 mb-3">Your activity</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
          <StatCard
            label="Share requests worked"
            value={us?.shareRequestsWorked ?? 0}
            icon={<ClipboardCheck className="h-6 w-6" />}
            accent="bg-oe-primary"
            onClick={() => navigate('/vendor/share-requests?claim=all&claimedBy=me')}
          />
          <StatCard
            label="Cases worked"
            value={us?.casesWorked ?? 0}
            icon={<Briefcase className="h-6 w-6" />}
            accent="bg-indigo-500"
            onClick={() => navigate('/vendor/cases?claim=all&claimedBy=me')}
          />
          <StatCard
            label="Open share requests assigned to you"
            value={us?.openShareRequestsAssigned ?? 0}
            icon={<ClipboardList className="h-6 w-6" />}
            accent="bg-amber-500"
            onClick={() => navigate('/vendor/share-requests?claim=claimed&claimedBy=me')}
          />
          <StatCard
            label="Open cases assigned to you"
            value={us?.openCasesAssigned ?? 0}
            icon={<Inbox className="h-6 w-6" />}
            accent="bg-purple-500"
            onClick={() => navigate('/vendor/cases?claim=claimed&claimedBy=me')}
          />
          <StatCard
            label="New form submissions (7d)"
            value={us?.newFormSubmissions ?? 0}
            icon={<FileText className="h-6 w-6" />}
            accent="bg-green-500"
            onClick={() => navigate('/vendor/sharing-forms/submissions')}
          />
        </div>
      </section>

      {/* ---------- Back-office totals ---------- */}
      <section>
        <h2 className="text-lg font-medium text-gray-900 mb-3">Back-office totals</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
          <StatCard
            label="Total share requests"
            value={bs?.totalShareRequests ?? 0}
            icon={<ClipboardList className="h-6 w-6" />}
            accent="bg-oe-primary"
            onClick={() => navigate('/vendor/share-requests')}
          />
          <StatCard
            label="Total cases"
            value={bs?.totalCases ?? 0}
            icon={<Briefcase className="h-6 w-6" />}
            accent="bg-indigo-500"
            onClick={() => navigate('/vendor/cases')}
          />
          <StatCard
            label="Open share requests"
            value={bs?.openShareRequests ?? 0}
            icon={<ClipboardList className="h-6 w-6" />}
            accent="bg-amber-500"
            onClick={() => navigate('/vendor/share-requests?claim=all')}
          />
          <StatCard
            label="Open cases"
            value={bs?.openCases ?? 0}
            icon={<Inbox className="h-6 w-6" />}
            accent="bg-purple-500"
            onClick={() => navigate('/vendor/cases?claim=all')}
          />
          <StatCard
            label="Share requests opened this week"
            value={bs?.shareRequestsOpenedThisWeek ?? 0}
            icon={<TrendingUp className="h-6 w-6" />}
            accent="bg-green-500"
            onClick={() => navigate('/vendor/share-requests?claim=all')}
          />
        </div>
      </section>

      {/* ---------- Enrollment reach ---------- */}
      <section>
        <h2 className="text-lg font-medium text-gray-900 mb-3">Enrollment reach</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
          <StatCard
            label="Households enrolled"
            value={bs?.enrolledHouseholds ?? 0}
            icon={<Home className="h-6 w-6" />}
            accent="bg-teal-500"
            hint="Distinct households on your plan"
            onClick={() => navigate('/vendor/members')}
          />
          <StatCard
            label="Total lives"
            value={bs?.enrolledLives ?? 0}
            icon={<Users className="h-6 w-6" />}
            accent="bg-cyan-600"
            hint="Everyone in those households"
            onClick={() => navigate('/vendor/members')}
          />
        </div>
      </section>

      {/* ---------- 30-day volume chart ---------- */}
      <section>
        <CardShell title="Volume — last 30 days" subtitle="Share requests submitted vs. cases opened per day">
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={dailyChart} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 11, fill: '#6b7280' }}
                  interval="preserveStartEnd"
                  minTickGap={20}
                />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#6b7280' }} width={32} />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
                  labelStyle={{ color: '#111827', fontWeight: 600 }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line
                  type="monotone"
                  dataKey="sr"
                  name="Share requests"
                  stroke={COLOR_OE_PRIMARY}
                  strokeWidth={2}
                  dot={{ r: 2 }}
                  activeDot={{ r: 4 }}
                />
                <Line
                  type="monotone"
                  dataKey="cases"
                  name="Cases"
                  stroke={COLOR_INDIGO}
                  strokeWidth={2}
                  dot={{ r: 2 }}
                  activeDot={{ r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardShell>
      </section>

      {/* ---------- Status breakdowns side by side ---------- */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CardShell title="Share requests by status" subtitle="All time, this vendor">
          {srBreakdown.length === 0 ? (
            <p className="text-sm text-gray-500">No share requests yet.</p>
          ) : (
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={srBreakdown}
                  layout="vertical"
                  margin={{ top: 6, right: 16, left: 8, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: '#6b7280' }} />
                  <YAxis
                    type="category"
                    dataKey="status"
                    tick={{ fontSize: 11, fill: '#374151' }}
                    width={140}
                  />
                  <Tooltip
                    contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
                  />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                    {srBreakdown.map((row) => (
                      <Cell
                        key={row.status}
                        fill={STATUS_BAR_COLORS[row.status] || COLOR_OE_PRIMARY}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardShell>

        <CardShell title="Cases by status" subtitle="All time, this vendor">
          {caseBreakdown.length === 0 ? (
            <p className="text-sm text-gray-500">No cases yet.</p>
          ) : (
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={caseBreakdown}
                  layout="vertical"
                  margin={{ top: 6, right: 16, left: 8, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: '#6b7280' }} />
                  <YAxis
                    type="category"
                    dataKey="status"
                    tick={{ fontSize: 11, fill: '#374151' }}
                    width={120}
                  />
                  <Tooltip
                    contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
                  />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                    {caseBreakdown.map((row) => (
                      <Cell key={row.status} fill={STATUS_BAR_COLORS[row.status] || COLOR_INDIGO} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardShell>
      </section>

      {/* ---------- Team workload ---------- */}
      <section>
        <CardShell
          title="Team workload"
          subtitle="Currently assigned open share requests and cases by teammate"
        >
          {team.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <Users className="h-4 w-4" />
              Nobody currently has anything assigned.
            </div>
          ) : (
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={team}
                  layout="vertical"
                  margin={{ top: 6, right: 16, left: 8, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: '#6b7280' }} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tick={{ fontSize: 11, fill: '#374151' }}
                    width={140}
                  />
                  <Tooltip
                    contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar
                    dataKey="srClaimed"
                    name="Share requests"
                    stackId="a"
                    fill={COLOR_OE_PRIMARY}
                    radius={[0, 0, 0, 0]}
                  />
                  <Bar
                    dataKey="caseClaimed"
                    name="Cases"
                    stackId="a"
                    fill={COLOR_INDIGO}
                    radius={[0, 4, 4, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardShell>
      </section>

      {/* ---------- Recent share requests ---------- */}
      <section>
        <CardShell title="Recent share requests" subtitle="Latest 8 submissions across all statuses">
          {recent.length === 0 ? (
            <p className="text-sm text-gray-500">No share requests yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase text-gray-500 border-b border-gray-200">
                    <th className="py-2 pr-4">Request</th>
                    <th className="py-2 pr-4">Member</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Assigned to</th>
                    <th className="py-2 pr-4">Billed</th>
                    <th className="py-2 pr-4">Submitted</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((sr) => {
                    const color = STATUS_BAR_COLORS[sr.status] || COLOR_GRAY;
                    return (
                      <tr
                        key={sr.id}
                        onClick={() => navigate(`/vendor/share-requests/${sr.id}`)}
                        className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer"
                      >
                        <td className="py-2 pr-4 font-medium text-oe-primary">
                          {sr.requestNumber || sr.id.slice(0, 8)}
                        </td>
                        <td className="py-2 pr-4 text-gray-700">{sr.memberName || '—'}</td>
                        <td className="py-2 pr-4">
                          <span
                            className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium text-white"
                            style={{ backgroundColor: color }}
                          >
                            {sr.status}
                          </span>
                        </td>
                        <td className="py-2 pr-4 text-gray-700">{sr.claimedByName || 'Unassigned'}</td>
                        <td className="py-2 pr-4 text-gray-700">{formatCurrency(sr.totalBilledAmount)}</td>
                        <td className="py-2 pr-4 text-gray-500">{formatShortDate(sr.submittedDate)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardShell>
      </section>
    </div>
  );
};

// --------------------------------------------------------------------------
// Loading skeleton — mirrors the live layout so the page doesn't reflow when
// data arrives. Uses the shared `animate-shimmer` keyframes (defined in
// tailwind.config.js) for a moving highlight, and `animate-fade-up` to
// stagger the bones in.
// --------------------------------------------------------------------------

const SHIMMER_BAR =
  'bg-gradient-to-r from-gray-100 via-gray-200 to-gray-100 bg-[length:1000px_100%] animate-shimmer';

const SkelBar: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div className={`${SHIMMER_BAR} rounded ${className}`} />
);

const FADE_UP =
  'opacity-0 animate-fade-up [animation-fill-mode:forwards]';

// Stat-card stagger delays (10 cards total — two rows of five). Hardcoded
// arbitrary-value classes so Tailwind's JIT picks them up at build time.
const STAT_DELAYS = [
  '[animation-delay:0ms]',
  '[animation-delay:40ms]',
  '[animation-delay:80ms]',
  '[animation-delay:120ms]',
  '[animation-delay:160ms]',
  '[animation-delay:200ms]',
  '[animation-delay:240ms]',
  '[animation-delay:280ms]',
  '[animation-delay:320ms]',
  '[animation-delay:360ms]'
];

const SkeletonStatCard: React.FC<{ delayClass?: string }> = ({ delayClass = '' }) => (
  <div className={`bg-white rounded-lg border border-gray-200 p-6 shadow-sm ${FADE_UP} ${delayClass}`}>
    <SkelBar className="h-10 w-10 mb-4" />
    <SkelBar className="h-7 w-20 mb-2" />
    <SkelBar className="h-4 w-32" />
  </div>
);

const SkeletonCardShell: React.FC<{
  titleWidth?: string;
  children: React.ReactNode;
  delayClass?: string;
}> = ({ titleWidth = 'w-40', children, delayClass = '' }) => (
  <div className={`bg-white rounded-lg border border-gray-200 shadow-sm ${FADE_UP} ${delayClass}`}>
    <div className="px-6 py-4 border-b border-gray-200">
      <SkelBar className={`h-4 ${titleWidth} mb-2`} />
      <SkelBar className="h-3 w-56" />
    </div>
    <div className="p-6">{children}</div>
  </div>
);

// Fake horizontal-bar chart silhouette.
const SkeletonHBars: React.FC<{ rows?: number }> = ({ rows = 6 }) => (
  <div className="space-y-3">
    {Array.from({ length: rows }).map((_, i) => (
      <div key={i} className="flex items-center gap-3">
        <SkelBar className="h-3 w-24 flex-shrink-0" />
        <SkelBar className={`h-3 ${['w-3/4', 'w-2/3', 'w-1/2', 'w-5/6', 'w-1/3', 'w-3/5'][i % 6]}`} />
      </div>
    ))}
  </div>
);

// Fake line-chart silhouette — an SVG polyline so it actually feels like a
// chart instead of a flat rectangle.
const SkeletonLineChart: React.FC = () => (
  <div className="h-72 w-full relative">
    <svg className="absolute inset-0 w-full h-full" viewBox="0 0 400 200" preserveAspectRatio="none">
      <defs>
        <linearGradient id="skel-line-gradient" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stopColor="#e5e7eb" />
          <stop offset="50%" stopColor="#d1d5db" />
          <stop offset="100%" stopColor="#e5e7eb" />
        </linearGradient>
      </defs>
      {[40, 80, 120, 160].map((y) => (
        <line key={y} x1="0" x2="400" y1={y} y2={y} stroke="#f3f4f6" strokeWidth="1" />
      ))}
      <polyline
        points="0,150 40,120 80,135 120,90 160,110 200,70 240,95 280,55 320,80 360,40 400,65"
        fill="none"
        stroke="url(#skel-line-gradient)"
        strokeWidth="3"
        strokeLinecap="round"
        className="animate-shimmer"
      />
      <polyline
        points="0,170 40,160 80,150 120,140 160,150 200,130 240,135 280,115 320,125 360,100 400,110"
        fill="none"
        stroke="url(#skel-line-gradient)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="6 4"
        className="animate-shimmer"
      />
    </svg>
  </div>
);

const DashboardSkeleton: React.FC = () => (
  <div className="p-6 space-y-8 animate-fade-in-fast">
    {/* Header */}
    <div>
      <SkelBar className="h-7 w-40 mb-2" />
      <SkelBar className="h-4 w-80" />
    </div>

    {/* Your activity */}
    <section>
      <SkelBar className="h-5 w-32 mb-3" />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        {STAT_DELAYS.slice(0, 5).map((d, i) => (
          <SkeletonStatCard key={`a-${i}`} delayClass={d} />
        ))}
      </div>
    </section>

    {/* Back-office totals */}
    <section>
      <SkelBar className="h-5 w-44 mb-3" />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        {STAT_DELAYS.slice(5, 10).map((d, i) => (
          <SkeletonStatCard key={`b-${i}`} delayClass={d} />
        ))}
      </div>
    </section>

    {/* 30-day volume */}
    <SkeletonCardShell titleWidth="w-56" delayClass="[animation-delay:500ms]">
      <SkeletonLineChart />
    </SkeletonCardShell>

    {/* Status breakdowns */}
    <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <SkeletonCardShell titleWidth="w-48" delayClass="[animation-delay:560ms]">
        <div className="h-64">
          <SkeletonHBars rows={6} />
        </div>
      </SkeletonCardShell>
      <SkeletonCardShell titleWidth="w-44" delayClass="[animation-delay:600ms]">
        <div className="h-64">
          <SkeletonHBars rows={4} />
        </div>
      </SkeletonCardShell>
    </section>

    {/* Team workload */}
    <SkeletonCardShell titleWidth="w-40" delayClass="[animation-delay:640ms]">
      <div className="h-64">
        <SkeletonHBars rows={5} />
      </div>
    </SkeletonCardShell>

    {/* Recent SR table */}
    <SkeletonCardShell titleWidth="w-52" delayClass="[animation-delay:680ms]">
      <div className="space-y-3">
        <div className="grid grid-cols-6 gap-4 pb-2 border-b border-gray-100">
          {Array.from({ length: 6 }).map((_, i) => (
            <Bar key={i} className="h-3 w-20" />
          ))}
        </div>
        {Array.from({ length: 6 }).map((_, row) => (
          <div key={row} className="grid grid-cols-6 gap-4 py-1.5">
            {Array.from({ length: 6 }).map((__, col) => (
              <Bar
                key={col}
                className={`h-3 ${
                  col === 2 ? 'w-20 rounded-full' : col === 0 ? 'w-16' : col === 4 ? 'w-12' : 'w-24'
                }`}
              />
            ))}
          </div>
        ))}
      </div>
    </SkeletonCardShell>
  </div>
);

export default VendorDashboard;
