// frontend/src/pages/tenant-admin/TenantAdminDashboard.tsx
import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  Users,
  Building2,
  DollarSign,
  AlertCircle,
  Award,
  ArrowLeftRight,
  ChevronRight,
} from 'lucide-react';
import GroupTypeChangeRequestsModal from '../../components/groups/GroupTypeChangeRequestsModal';
import { GroupBadge } from '../../components/groups/GroupBadge';
import { usePendingGroupTypeChangeRequests } from '../../hooks/tenant-admin/usePendingGroupTypeChangeRequests';
import { TenantAdminService } from '../../services/tenant-admin/tenant-admin.service';
import type { TenantMetrics, TenantFinancialSummary } from '../../types/tenant-admin/tenant-admin.types';

function formatRequestDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

const TenantAdminDashboard: React.FC = () => {
  const [metrics, setMetrics] = useState<TenantMetrics | null>(null);
  const [financials, setFinancials] = useState<TenantFinancialSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showChangeRequestsModal, setShowChangeRequestsModal] = useState(false);
  const { pendingRequests, pendingCount } = usePendingGroupTypeChangeRequests();
  const previewRequests = pendingRequests.slice(0, 3);

  useEffect(() => {
    loadDashboardData();
  }, []);

  const loadDashboardData = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const [metricsResponse, financialsResponse] = await Promise.all([
        TenantAdminService.getTenantMetrics(),
        TenantAdminService.getFinancialSummary()
      ]);

      if (metricsResponse.success && metricsResponse.data) {
        setMetrics(metricsResponse.data);
      } else {
        console.warn('Metrics API returned unsuccessful response:', metricsResponse);
        // Set default metrics if API fails
        setMetrics({
          activeHouseholds: 0,
          groupHouseholds: 0,
          individualHouseholds: 0,
          memberCount: 0,
          groupCount: 0,
          activeEnrollments: 0,
          monthlyPremiumRevenue: 0,
          productSubscriptions: 0,
          quarterlyGrowth: 0,
          topAgents: [] as TenantMetrics['topAgents']
        });
      }

      if (financialsResponse.success && financialsResponse.data) {
        setFinancials(financialsResponse.data);
      } else {
        console.warn('Financials API returned unsuccessful response:', financialsResponse);
        // Set default financials if API fails
        setFinancials({
          monthlyRevenue: 0,
          quarterlyRevenue: 0,
          annualRevenue: 0,
          commissionsPaid: 0,
          outstandingCommissions: 0,
          profitMargin: 0,
          revenueByProduct: [],
          revenueByAgent: []
        });
      }
    } catch (err: any) {
      console.error('Failed to load dashboard data:', err);
      setError(err.message || 'Failed to load dashboard data');
      // Set default values on error so dashboard still renders
      setMetrics({
        activeHouseholds: 0,
        groupHouseholds: 0,
        individualHouseholds: 0,
        memberCount: 0,
        groupCount: 0,
        activeEnrollments: 0,
        monthlyPremiumRevenue: 0,
        productSubscriptions: 0,
        quarterlyGrowth: 0,
        topAgents: [] as TenantMetrics['topAgents']
      });
      setFinancials({
        monthlyRevenue: 0,
        quarterlyRevenue: 0,
        annualRevenue: 0,
        commissionsPaid: 0,
        outstandingCommissions: 0,
        profitMargin: 0,
        revenueByProduct: [],
        revenueByAgent: []
      });
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-96">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-96">
        <div className="text-center">
          <AlertCircle className="h-12 w-12 text-oe-error mx-auto mb-4" />
          <h3 className="text-lg font-medium text-oe-neutral-dark mb-2">Failed to Load Dashboard</h3>
          <p className="text-gray-600">{error}</p>
        </div>
      </div>
    );
  }

  const totalHouseholds = (metrics?.groupHouseholds || 0) + (metrics?.individualHouseholds || 0);
  const statCards = [
    {
      title: 'Enrolled Households',
      value: totalHouseholds,
      groupCount: metrics?.groupHouseholds || 0,
      individualCount: metrics?.individualHouseholds || 0,
      icon: Users,
      href: '/tenant-admin/members',
      showBreakdown: true
    },
    {
      title: 'Enrolled Groups',
      value: metrics?.groupCount || 0,
      icon: Building2,
      href: '/tenant-admin/groups'
    },
    {
      title: 'Monthly Revenue',
      value: `$${(financials?.monthlyRevenue || 0).toLocaleString()}`,
      change: `${metrics?.quarterlyGrowth || 0}% monthly growth`,
      changeType: (metrics?.quarterlyGrowth || 0) > 0 ? 'positive' as const : 'negative' as const,
      icon: DollarSign,
      href: undefined
    }
  ];

  const quickActions = [
    {
      title: 'Payout Vendors, Commissions, & Overrides',
      description: 'Go to accounting',
      icon: DollarSign,
      href: '/tenant-admin/accounting',
      color: 'blue'
    }
  ];

  return (
    <div className="w-full">
      {/* Main Content */}
      <div className="p-6 bg-oe-neutral-light">
        <div className="space-y-6">
          {/* Stats Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {statCards.map((stat, index) => {
              const Icon = stat.icon;
              const cardContent = (
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-600">{stat.title}</p>
                    <p className="text-2xl font-bold text-oe-neutral-dark mt-1">
                      {typeof stat.value === 'number' ? stat.value.toLocaleString() : stat.value}
                    </p>
                    {'showBreakdown' in stat && stat.showBreakdown && 'groupCount' in stat && 'individualCount' in stat && (
                      <p className="text-xs text-gray-500 mt-1">
                        <span className="font-medium text-gray-700">Group:</span> {(stat as { groupCount: number }).groupCount.toLocaleString()} · <span className="font-medium text-gray-700">Individual:</span> {(stat as { individualCount: number }).individualCount.toLocaleString()}
                      </p>
                    )}
                    {'change' in stat && stat.change != null && (
                      <p className={`text-xs mt-1 ${
                        (stat as { changeType?: string }).changeType === 'positive' ? 'text-oe-success' :
                        (stat as { changeType?: string }).changeType === 'negative' ? 'text-oe-error' : 'text-gray-500'
                      }`}>
                        {stat.change}
                      </p>
                    )}
                  </div>
                  <div className="p-3 bg-oe-light rounded-lg">
                    <Icon className="h-6 w-6 text-oe-primary" />
                  </div>
                </div>
              );

              if (stat.href) {
                return (
                  <Link
                    key={index}
                    to={stat.href}
                    className="bg-white p-6 rounded-lg shadow-sm border border-gray-200 hover:shadow-md transition-shadow duration-200"
                  >
                    {cardContent}
                  </Link>
                );
              }

              return (
                <div
                  key={index}
                  className="bg-white p-6 rounded-lg shadow-sm border border-gray-200"
                >
                  {cardContent}
                </div>
              );
            })}
          </div>

          {/* Pending group type change requests */}
          {pendingCount > 0 && (
            <div className="bg-white rounded-lg shadow-sm border border-red-200 p-6">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <ArrowLeftRight className="h-5 w-5 text-red-600 shrink-0" />
                    <h2 className="text-lg font-semibold text-oe-neutral-dark">
                      Pending Group Type Change Requests
                    </h2>
                    <span className="inline-flex min-w-[1.25rem] h-5 px-1.5 items-center justify-center rounded-full bg-red-500 text-white text-xs font-bold">
                      {pendingCount > 99 ? '99+' : pendingCount}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-gray-600">
                    Agents have requested to convert groups between Standard and List Bill.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowChangeRequestsModal(true)}
                  className="shrink-0 inline-flex items-center gap-1 px-4 py-2 text-sm font-medium text-white bg-oe-primary rounded-lg hover:bg-oe-dark transition-colors"
                >
                  Review requests
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-4 divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden">
                {previewRequests.map((request) => (
                  <div
                    key={request.RequestId}
                    className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between px-4 py-3 bg-gray-50/50"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {request.GroupName ?? request.GroupId}
                      </p>
                      <p className="text-sm text-gray-600 mt-0.5">
                        <span>{request.CurrentType}</span>
                        <span className="mx-1.5 text-gray-400">→</span>
                        <span>{request.RequestedType}</span>
                        {request.RequestedType === 'ListBill' && (
                          <span className="ml-2 inline-flex align-middle">
                            <GroupBadge type="ListBill" />
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="text-sm text-gray-500 shrink-0 sm:text-right">
                      <p>{request.RequestedByName ?? 'Unknown agent'}</p>
                      <p className="text-xs mt-0.5">{formatRequestDate(request.CreatedDate)}</p>
                    </div>
                  </div>
                ))}
              </div>
              {pendingCount > previewRequests.length && (
                <p className="mt-3 text-sm text-gray-500">
                  +{pendingCount - previewRequests.length} more pending request
                  {pendingCount - previewRequests.length === 1 ? '' : 's'}
                </p>
              )}
            </div>
          )}

          {/* Quick Actions */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-oe-neutral-dark mb-4">Quick Actions</h2>
            <div className="flex flex-wrap gap-4">
              {quickActions.map((action, index) => {
                const Icon = action.icon;
                const colorClasses = {
                  blue: 'bg-oe-light text-oe-primary hover:bg-oe-light',
                  green: 'bg-green-50 text-oe-success hover:bg-green-100',
                  purple: 'bg-purple-50 text-purple-600 hover:bg-purple-100',
                  orange: 'bg-orange-50 text-orange-600 hover:bg-orange-100'
                };

                return (
                  <Link
                    key={index}
                    to={action.href}
                    className="flex items-center gap-4 p-4 rounded-lg border border-gray-200 hover:border-gray-300 transition-colors duration-200 group min-w-0 flex-1 sm:flex-initial sm:min-w-[380px]"
                  >
                    <div className={`inline-flex flex-shrink-0 p-2 rounded-lg transition-colors duration-200 ${colorClasses[action.color as keyof typeof colorClasses]}`}>
                      <Icon className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="font-medium text-oe-neutral-dark group-hover:text-oe-primary whitespace-nowrap">
                        {action.title}
                      </h3>
                      <p className="text-sm text-gray-600 mt-0.5">{action.description}</p>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>

          {/* Top Performing Agents (revenue = total from oe.Payments) */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-oe-neutral-dark">Top Performing Agents</h2>
              <Award className="h-5 w-5 text-gray-400" />
            </div>
            {metrics?.topAgents && metrics.topAgents.length > 0 ? (
              <div className="space-y-3">
                {metrics.topAgents.map((agent, index) => (
                  <div key={agent.agentId} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-b-0">
                    <div className="flex items-center space-x-3 flex-1 min-w-0">
                      <div className="flex-shrink-0 w-6 h-6 rounded-full bg-oe-primary-light flex items-center justify-center">
                        <span className="text-xs font-semibold text-oe-primary-dark">{index + 1}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-oe-neutral-dark truncate">{agent.agentName}</p>
                        <p className="text-xs text-gray-500 truncate">{agent.agentEmail}</p>
                      </div>
                    </div>
                    <div className="flex items-center space-x-4 ml-4">
                      <div className="text-right">
                        <p className="text-xs text-gray-500">Households</p>
                        <p className="text-sm font-semibold text-oe-neutral-dark">{agent.activeHouseholds}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-gray-500">Revenue</p>
                        <p className="text-sm font-semibold text-oe-success">${agent.totalRevenue.toLocaleString()}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8">
                <Award className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                <p className="text-gray-600">No agent data available</p>
              </div>
            )}
          </div>
        </div>
      </div>
      <GroupTypeChangeRequestsModal
        isOpen={showChangeRequestsModal}
        onClose={() => setShowChangeRequestsModal(false)}
      />
    </div>
  );
};

export default TenantAdminDashboard;