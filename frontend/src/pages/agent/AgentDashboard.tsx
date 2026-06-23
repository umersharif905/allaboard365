// frontend/src/pages/agent/AgentDashboard.tsx
import {
  AlertCircle,
  ArrowUpRight,
  CreditCard,
  DollarSign,
  Plus,
  UserPlus,
  Users
} from 'lucide-react';
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { BugReportModal } from '../../components/common/BugReportFAB';
import { useAgentDashboard } from '../../hooks/agent/useAgentDashboard';
import type { AgentMetrics } from '../../types/agent/agent.types';

function formatPaymentDate(d: string | undefined) {
  if (!d) return '';
  try {
    const x = new Date(d);
    if (isNaN(x.getTime())) return d;
    return x.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return d;
  }
}

const AgentDashboard: React.FC = () => {
  const { data, isLoading, isError, error } = useAgentDashboard();
  const [supportTicketOpen, setSupportTicketOpen] = useState(false);

  const metrics = data?.data as AgentMetrics | undefined;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-96">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary"></div>
      </div>
    );
  }

  const scopeSublabel =
    metrics?.metricsScope === 'agency' && metrics?.metricsScopeIncludesOtherAgents
      ? 'Includes entire agency'
      : metrics?.metricsScope === 'downline' && metrics?.metricsScopeIncludesOtherAgents
        ? 'Includes downline agents'
        : metrics?.metricsScope === 'agency' && !metrics?.metricsScopeIncludesOtherAgents
          ? 'Agency-wide view'
          : null;

  const statCards: Array<{
    title: string;
    value: string | number;
    icon: typeof Users;
    href: string;
    /** Omit scope line (downline/agency); use for metrics that are viewer-only */
    skipScopeSublabel?: boolean;
  }> = [
    {
      title: 'Active Households',
      value: metrics?.totalActiveHouseholds ?? 0,
      icon: Users,
      href: '/agent/members'
    },
    {
      title: 'Monthly Premium Volume',
      value: `$${(metrics?.monthlyPremiumAmount || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`,
      icon: DollarSign,
      href: '/agent/members'
    }
  ];

  const quickActions = [
    {
      title: 'Enroll New Member',
      icon: UserPlus,
      href: '/agent/members?openNewMember=1',
      color: 'blue'
    },
    {
      title: 'Create New Group',
      icon: Users,
      href: '/agent/groups',
      color: 'green'
    },
    {
      title: 'New Support Ticket',
      icon: Plus,
      color: 'orange',
      openSupportTicket: true
    }
  ];

  const recentCommissionPayments = metrics?.recentCommissionPayments?.length
    ? metrics.recentCommissionPayments
    : null;
  const legacyCommissions = !recentCommissionPayments?.length ? metrics?.recentCommissions : null;

  const recentBillingPayments = metrics?.recentBillingPayments || [];
  const unresolvedFailedPaymentCount = metrics?.unresolvedFailedPaymentCount ?? 0;

  return (
    <div className="p-6 space-y-6 bg-oe-neutral-light min-h-full">
      {isError && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
          <div className="flex items-start">
            <div className="flex-shrink-0">
              <AlertCircle className="h-5 w-5 text-red-400" />
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800">Error loading dashboard</h3>
              <p className="text-sm text-red-700 mt-1">{error?.message || 'Failed to load dashboard data'}</p>
            </div>
          </div>
        </div>
      )}

      {/* Agent identity header */}
      <div>
        <h1 className="text-2xl font-bold text-oe-neutral-dark">Dashboard</h1>
        {metrics?.agentCode && (
          <div className="mt-1 text-sm text-gray-500">
            Your Agent ID: <span className="font-mono">{metrics.agentCode}</span>
          </div>
        )}
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {statCards.map((stat, index) => {
          const Icon = stat.icon;
          return (
            <Link
              key={index}
              to={stat.href}
              className="bg-white p-6 rounded-lg shadow-sm border border-gray-200 hover:shadow-md transition-shadow duration-200"
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">{stat.title}</p>
                  {scopeSublabel && !stat.skipScopeSublabel ? (
                    <p className="text-xs text-gray-500 mt-0.5">{scopeSublabel}</p>
                  ) : null}
                  <p className="text-2xl font-bold text-oe-neutral-dark mt-1">{stat.value}</p>
                </div>
                <div className="p-3 bg-oe-light rounded-lg">
                  <Icon className="h-6 w-6 text-oe-primary" />
                </div>
              </div>
            </Link>
          );
        })}
      </div>

      {/* Quick Actions */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-oe-neutral-dark mb-4">Quick Actions</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {quickActions.map((action, index) => {
            const Icon = action.icon;
            const colorClasses = {
              blue: 'bg-oe-light text-oe-primary hover:bg-oe-light',
              green: 'bg-green-50 text-oe-success hover:bg-green-100',
              purple: 'bg-purple-50 text-purple-600 hover:bg-purple-100',
              orange: 'bg-orange-50 text-orange-600 hover:bg-orange-100'
            };

            const cardClassName =
              'p-4 rounded-lg border border-gray-200 hover:border-gray-300 transition-colors duration-200 group text-left w-full';

            if ('openSupportTicket' in action && action.openSupportTicket) {
              return (
                <button
                  key={index}
                  type="button"
                  onClick={() => setSupportTicketOpen(true)}
                  className={cardClassName}
                >
                  <div
                    className={`inline-flex p-2 rounded-lg mb-2 transition-colors duration-200 ${colorClasses[action.color as keyof typeof colorClasses]}`}
                  >
                    <Icon className="h-5 w-5" />
                  </div>
                  <h3 className="font-medium text-oe-neutral-dark group-hover:text-oe-primary">
                    {action.title}
                  </h3>
                </button>
              );
            }

            return (
              <Link
                key={index}
                to={(action as { href: string }).href}
                className={cardClassName}
              >
                <div className={`inline-flex p-2 rounded-lg mb-2 transition-colors duration-200 ${colorClasses[action.color as keyof typeof colorClasses]}`}>
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="font-medium text-oe-neutral-dark group-hover:text-oe-primary">
                  {action.title}
                </h3>
              </Link>
            );
          })}
        </div>
      </div>

      {/* Recent commissions & billing */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-oe-neutral-dark">Recent commissions</h2>
            <DollarSign className="h-5 w-5 text-gray-400" />
          </div>
          <div className="space-y-4">
            {recentCommissionPayments && recentCommissionPayments.length > 0 ? (
              recentCommissionPayments.map((row) => (
                <div
                  key={row.paymentId}
                  className="flex items-start justify-between gap-3 py-2 border-b border-gray-100 last:border-0"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-oe-neutral-dark truncate">
                      {row.memberName || '—'}
                    </p>
                    <p className="text-xs text-gray-500 truncate">
                      {[row.groupName, formatPaymentDate(row.paymentDate), row.status]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                    {row.sellingAgentName && row.isUplinePayment ? (
                      <p className="text-xs text-gray-500 truncate">Selling: {row.sellingAgentName}</p>
                    ) : null}
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-sm font-semibold text-oe-success">
                      +${row.commissionAmount.toFixed(2)}
                    </p>
                    <p className="text-xs text-gray-500">Payment ${row.amount.toFixed(2)}</p>
                  </div>
                </div>
              ))
            ) : legacyCommissions && legacyCommissions.length > 0 ? (
              legacyCommissions.map((c) => (
                <div
                  key={String((c as { commissionId?: string }).commissionId)}
                  className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0"
                >
                  <div>
                    <p className="text-sm font-medium text-oe-neutral-dark">
                      {(c as { memberName?: string }).memberName}
                    </p>
                    <p className="text-xs text-gray-500">{(c as { productName?: string }).productName}</p>
                  </div>
                  <span className="text-sm font-semibold text-oe-success">
                    +${Number((c as { amount?: number }).amount || 0).toFixed(2)}
                  </span>
                </div>
              ))
            ) : (
              <div className="text-center py-6">
                <DollarSign className="h-8 w-8 text-gray-300 mx-auto mb-2" />
                <p className="text-gray-500">No recent commission payments</p>
              </div>
            )}
          </div>
          <div className="mt-4 pt-4 border-t border-gray-200">
            <Link
              to="/agent/commissions"
              className="text-sm text-oe-primary hover:text-oe-dark font-medium flex items-center"
            >
              View all commissions
              <ArrowUpRight className="h-4 w-4 ml-1" />
            </Link>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-semibold text-oe-neutral-dark">Billing & payments</h2>
              {unresolvedFailedPaymentCount > 0 ? (
                <span
                  className="inline-flex items-center justify-center min-h-[1.5rem] min-w-[1.5rem] px-2 rounded-full bg-red-100 text-red-800 text-xs font-semibold"
                  title="Unresolved failed payments in your scope"
                >
                  {unresolvedFailedPaymentCount > 99 ? '99+' : unresolvedFailedPaymentCount}
                </span>
              ) : null}
            </div>
            <CreditCard className="h-5 w-5 text-gray-400 flex-shrink-0" />
          </div>
          <p className="text-xs text-gray-500 mb-3">
            Recent payment activity (same scope as commissions). Unresolved failures need attention.
          </p>
          <div className="space-y-4">
            {recentBillingPayments.length > 0 ? (
              recentBillingPayments.map((row) => (
                <div
                  key={row.paymentId}
                  className="flex items-start justify-between gap-3 py-2 border-b border-gray-100 last:border-0"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-oe-neutral-dark truncate">
                      {row.memberName || row.groupName || 'Payment'}
                    </p>
                    <p className="text-xs text-gray-500">
                      {[formatPaymentDate(row.paymentDate), row.status, row.paymentMethod]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </div>
                  <span className="text-sm font-semibold text-gray-900 flex-shrink-0">
                    ${row.amount.toFixed(2)}
                  </span>
                </div>
              ))
            ) : (
              <div className="text-center py-6">
                <CreditCard className="h-8 w-8 text-gray-300 mx-auto mb-2" />
                <p className="text-gray-500">No recent payments</p>
              </div>
            )}
          </div>
          <div className="mt-4 pt-4 border-t border-gray-200">
            <Link
              to="/agent/billing"
              className="text-sm text-oe-primary hover:text-oe-dark font-medium flex items-center"
            >
              Open billing
              <ArrowUpRight className="h-4 w-4 ml-1" />
            </Link>
          </div>
        </div>
      </div>

      <BugReportModal isOpen={supportTicketOpen} onClose={() => setSupportTicketOpen(false)} />
    </div>
  );
};

export default AgentDashboard;
