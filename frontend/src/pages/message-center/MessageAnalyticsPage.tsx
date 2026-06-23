// File: MessageAnalyticsPage.tsx
// Path: frontend/src/pages/message-center/MessageAnalyticsPage.tsx

import React, { useState, useEffect } from 'react';
import { Mail, MessageSquare, AlertCircle, CheckCircle, Building2 } from 'lucide-react';
import { LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { messageAnalyticsService, MessageAnalytics } from '../../services/messageCenter.service';
import { useAuth } from '../../hooks/useAuth';
import { useTenants } from '../../hooks/useTenants';

// Types
interface TenantSummary {
  tenantId: string;
  tenantName: string;
  totalMessages: number;
  emailsSent: number;
  smsSent: number;
  failureRate: number;
  lastActivity: string;
}

const MessageAnalyticsPage: React.FC = () => {
  const [analytics, setAnalytics] = useState<MessageAnalytics | null>(null);
  const [selectedTenant, setSelectedTenant] = useState<string>('context');
  const [selectedPeriod, setSelectedPeriod] = useState<string>('30');
  const [dateRange, setDateRange] = useState({
    startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    endDate: new Date().toISOString().split('T')[0]
  });
  const [isLoading, setIsLoading] = useState(true);
  const { user } = useAuth();
  const activeTenantId = user?.currentTenantId || user?.tenantId || '';
  const currentRole = user?.currentRole || localStorage.getItem('currentRole');
  const isSysAdmin = currentRole === 'SysAdmin';
  const { data: tenants = [] } = useTenants(isSysAdmin);

  // Load analytics data
  const loadAnalytics = async () => {
    setIsLoading(true);
    try {
      const params: any = {
        startDate: dateRange.startDate,
        endDate: dateRange.endDate
      };
      
      if (isSysAdmin) {
        if (selectedTenant === '__ALL__') {
          params.allTenants = 'true';
        } else if (selectedTenant !== 'context' && selectedTenant) {
          params.tenantId = selectedTenant;
        }
      }
      
      const res = await messageAnalyticsService.getAnalytics(params);
      if (res.success) {
        setAnalytics(res.data);
      } else {
        console.error('Failed to load analytics:', res.message);
        setAnalytics(null);
      }
    } catch (e) {
      console.error('Failed to load analytics', e);
      setAnalytics(null);
    } finally {
      setIsLoading(false);
    }
  };

  // Set date range based on selected period
  const handlePeriodChange = (period: string) => {
    setSelectedPeriod(period);
    const endDate = new Date();
    const startDate = new Date();
    
    switch (period) {
      case '7':
        startDate.setDate(endDate.getDate() - 7);
        break;
      case '30':
        startDate.setDate(endDate.getDate() - 30);
        break;
      case '90':
        startDate.setDate(endDate.getDate() - 90);
        break;
      default:
        return; // Keep current custom range
    }
    
    setDateRange({
      startDate: startDate.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0]
    });
  };

  useEffect(() => {
    loadAnalytics();
  }, [selectedTenant, dateRange]);

  // Master's context-switch reset for SysAdmin
  useEffect(() => {
    if (!isSysAdmin) return;
    setSelectedTenant((prev) => (prev === '__ALL__' ? '__ALL__' : 'context'));
  }, [activeTenantId, isSysAdmin]);

  const pieChartData = analytics ? [
    { name: 'Sent', value: analytics.byStatus.sent, color: '#10b981' },
    { name: 'Failed', value: analytics.byStatus.failed, color: '#ef4444' }
  ] : [];

  const typeChartData = analytics ? [
    { name: 'Email', value: analytics.byType.email, color: '#3b82f6' },
    { name: 'SMS', value: analytics.byType.sms, color: '#10b981' }
  ] : [];


  if (isLoading) {
    return (
      <div className="p-6 max-w-7xl mx-auto">
        <div className="flex items-center justify-center h-64">
          <div className="text-gray-500">Loading analytics...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Message Analytics</h1>
        <p className="text-gray-600 mt-1">
          {isSysAdmin ? 'System-wide messaging performance and insights' : 'Your tenant messaging performance and insights'}
        </p>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg shadow p-4 mb-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {isSysAdmin && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Tenant Filter
              </label>
              <select
                value={selectedTenant}
                onChange={(e) => setSelectedTenant(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
              >
                <option value="context">Current tenant</option>
                <option value="__ALL__">All tenants</option>
                {tenants.map(tenant => (
                  <option key={tenant.TenantId} value={tenant.TenantId}>
                    {tenant.Name}
                  </option>
                ))}
              </select>
            </div>
          )}
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Time Period
            </label>
            <select
              value={selectedPeriod}
              onChange={(e) => handlePeriodChange(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
            >
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="custom">Custom range</option>
            </select>
          </div>
          
          {selectedPeriod === 'custom' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Date Range
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={dateRange.startDate}
                  onChange={(e) => setDateRange({ ...dateRange, startDate: e.target.value })}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                />
                <span className="text-gray-500">to</span>
                <input
                  type="date"
                  value={dateRange.endDate}
                  onChange={(e) => setDateRange({ ...dateRange, endDate: e.target.value })}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Key Metrics */}
      {analytics && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            <div className="bg-white p-4 rounded-lg shadow">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-600">Total Sent</p>
                  <p className="text-2xl font-semibold">{analytics.totalSent.toLocaleString()}</p>
                </div>
                <Mail className="h-8 w-8 text-blue-500" />
              </div>
            </div>
            <div className="bg-white p-4 rounded-lg shadow">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-600">Delivery Rate</p>
                  <p className="text-2xl font-semibold text-green-600">{analytics.deliveryRate}%</p>
                </div>
                <CheckCircle className="h-8 w-8 text-green-500" />
              </div>
            </div>
            <div className="bg-white p-4 rounded-lg shadow">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-600">Failed</p>
                  <p className="text-2xl font-semibold text-red-600">{analytics.totalFailed}</p>
                </div>
                <AlertCircle className="h-8 w-8 text-red-500" />
              </div>
            </div>
            <div className="bg-white p-4 rounded-lg shadow">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-600">Email / SMS</p>
                  <p className="text-2xl font-semibold text-oe-primary">
                    {analytics.byType.email.toLocaleString()} / {analytics.byType.sms.toLocaleString()}
                  </p>
                </div>
                <MessageSquare className="h-8 w-8 text-blue-500" />
              </div>
            </div>
          </div>

          {/* Charts Row 1 */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            {/* Daily Trend Chart */}
            <div className="bg-white rounded-lg shadow p-6">
              <h3 className="text-lg font-semibold mb-4">Daily Message Volume</h3>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={analytics.dailyStats}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" tickFormatter={(date: string) => new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="sent" stroke="#3b82f6" name="Sent" />
                  <Line type="monotone" dataKey="failed" stroke="#ef4444" name="Failed" />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Status Distribution */}
            <div className="bg-white rounded-lg shadow p-6">
              <h3 className="text-lg font-semibold mb-4">Message Status Distribution</h3>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={pieChartData}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={(entry: any) => `${entry.name}: ${entry.value}`}
                    outerRadius={80}
                    fill="#8884d8"
                    dataKey="value"
                  >
                    {pieChartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Message Type Distribution */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            <div className="bg-white rounded-lg shadow p-6">
              <h3 className="text-lg font-semibold mb-4">Message Types</h3>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={typeChartData}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={(entry: any) => `${entry.name}: ${entry.value.toLocaleString()}`}
                    outerRadius={80}
                    fill="#8884d8"
                    dataKey="value"
                  >
                    {typeChartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

        </>
      )}

      {/* Tenant Summary Table - Only show for SysAdmin */}
      {isSysAdmin && analytics?.tenantSummaries && analytics.tenantSummaries.length > 0 && (
        <div className="bg-white rounded-lg shadow">
          <div className="p-6 border-b border-gray-200">
            <h3 className="text-lg font-semibold">Tenant Summary</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Tenant
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Total Messages
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Email / SMS
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Failure Rate
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Last Activity
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {analytics.tenantSummaries.map((tenant) => (
                  <tr key={tenant.tenantId} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <Building2 className="h-5 w-5 text-gray-400 mr-3" />
                        <div>
                          <div className="text-sm font-medium text-gray-900">{tenant.tenantName}</div>
                          <div className="text-sm text-gray-500">{tenant.tenantId}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {tenant.totalMessages.toLocaleString()}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      <div className="flex items-center gap-2">
                        <Mail className="h-4 w-4 text-blue-500" />
                        {tenant.emailsSent.toLocaleString()}
                        <span className="mx-1">/</span>
                        <MessageSquare className="h-4 w-4 text-green-500" />
                        {tenant.smsSent.toLocaleString()}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`text-sm font-medium ${tenant.failureRate < 2 ? 'text-green-600' : 'text-red-600'}`}>
                        {tenant.failureRate}%
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {tenant.lastActivity ? new Date(tenant.lastActivity).toLocaleString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                      }) : 'N/A'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default MessageAnalyticsPage;