// pages/vendor/ShareRequestDashboard.tsx
// Share Request Management Dashboard for Vendor Portal

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  FileText, 
  DollarSign, 
  TrendingUp, 
  Clock,
  Plus,
  ChevronRight
} from 'lucide-react';
import { apiService } from '../../services/api.service';
import Skeleton from '../../components/vendor/ui/Skeleton';
import { 
  ShareRequestDashboardStats, 
  ShareRequestStatus,
  STATUS_COLORS
} from '../../types/shareRequest.types';

const ShareRequestDashboard = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<ShareRequestDashboardStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadDashboardStats();
  }, []);

  const loadDashboardStats = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const response = await apiService.get<{ success: boolean; data: ShareRequestDashboardStats }>(
        '/api/me/vendor/share-requests/dashboard'
      );
      
      if (response.success) {
        setStats(response.data);
      } else {
        setError('Failed to load dashboard data');
      }
    } catch (err: any) {
      console.error('Error loading dashboard:', err);
      setError(err.message || 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2
    }).format(amount);
  };

  // Calculate total requests
  const totalRequests = stats 
    ? Object.values(stats.statusCounts).reduce((a, b) => a + b, 0) 
    : 0;

  // Status order for display. Mirrors the workflow progression so the
  // dashboard reads left-to-right from intake through terminal states.
  const statusOrder: ShareRequestStatus[] = [
    'New',
    'Acknowledged',
    'In Review',
    'Awaiting Member Info',
    'Awaiting Authorization',
    'Processing',
    'Completed',
    'Denied',
    'Withdrawn'
  ];

  if (loading) {
    return (
      <div className="p-6">
        <Skeleton className="h-8 w-1/4 mb-6" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-white rounded-lg border border-gray-200 p-6">
              <Skeleton className="h-4 w-1/2 mb-4" />
              <Skeleton className="h-8 w-3/4" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-800">{error}</p>
          <button
            onClick={loadDashboardStats}
            className="mt-2 text-red-600 hover:text-red-800 font-medium"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Share Requests</h1>
          <p className="text-gray-600">Dashboard overview of share request activity</p>
        </div>
        <button
          onClick={() => navigate('/vendor/share-requests/new')}
          className="btn-primary flex items-center"
        >
          <Plus className="h-5 w-5 mr-2" />
          New Request
        </button>
      </div>

      {/* Financial Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-gray-600 text-sm">Total Billed</span>
            <FileText className="h-5 w-5 text-oe-primary" />
          </div>
          <div className="text-2xl font-semibold text-gray-900">
            {formatCurrency(stats?.totalBills || 0)}
          </div>
          {(stats?.totalEstimates || 0) > 0 && (
            <div className="text-xs text-gray-500 mt-1">
              + {formatCurrency(stats?.totalEstimates || 0)} in estimates
            </div>
          )}
        </div>

        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-gray-600 text-sm">Total Discounts</span>
            <TrendingUp className="h-5 w-5 text-green-500" />
          </div>
          <div className="text-2xl font-semibold text-green-600">
            {formatCurrency(stats?.totalDiscounts || 0)}
          </div>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-gray-600 text-sm">UA Paid</span>
            <DollarSign className="h-5 w-5 text-purple-500" />
          </div>
          <div className="text-2xl font-semibold text-purple-600">
            {formatCurrency(stats?.totalUAPayments || 0)}
          </div>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-gray-600 text-sm">Total Paid</span>
            <DollarSign className="h-5 w-5 text-blue-500" />
          </div>
          <div className="text-2xl font-semibold text-oe-primary">
            {formatCurrency(stats?.totalPayments || 0)}
          </div>
          {(stats?.totalMemberPayments || 0) > 0 && (
            <div className="text-xs text-gray-500 mt-1">
              Member: {formatCurrency(stats?.totalMemberPayments || 0)}
            </div>
          )}
        </div>

        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-2">
            <span className="text-gray-600 text-sm">Balance Due</span>
            <Clock className="h-5 w-5 text-orange-500" />
          </div>
          <div className={`text-2xl font-semibold ${(stats?.totalBalance || 0) > 0 ? 'text-orange-600' : 'text-gray-900'}`}>
            {formatCurrency(stats?.totalBalance || 0)}
          </div>
        </div>
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Status Breakdown */}
        <div className="bg-white rounded-lg border border-gray-200">
          <div className="p-6 border-b border-gray-200">
            <h2 className="text-lg font-medium text-gray-900">Status Overview</h2>
            <p className="text-sm text-gray-600">Requests by current status</p>
          </div>
          <div className="p-6">
            <div className="space-y-3">
              {statusOrder.map((status) => {
                const count = stats?.statusCounts[status] || 0;
                const percentage = totalRequests > 0 ? (count / totalRequests) * 100 : 0;
                const colors = STATUS_COLORS[status];
                
                return (
                  <div key={status} className="flex items-center">
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium text-gray-900">{status}</span>
                        <span className="text-sm text-gray-600">{count}</span>
                      </div>
                      <div className="w-full bg-gray-100 rounded-full h-2">
                        <div
                          className={`h-2 rounded-full ${colors.bg.replace('100', '500')}`}
                          style={{ width: `${percentage}%` }}
                        ></div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            
            <div className="mt-6 pt-4 border-t border-gray-200">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-900">Total Requests</span>
                <span className="text-lg font-semibold text-gray-900">{totalRequests}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Quick Actions */}
        <div className="bg-white rounded-lg border border-gray-200">
          <div className="p-6 border-b border-gray-200">
            <h2 className="text-lg font-medium text-gray-900">Quick Actions</h2>
            <p className="text-sm text-gray-600">Common tasks and shortcuts</p>
          </div>
          <div className="p-6">
            <div className="space-y-3">
              <button
                onClick={() => navigate('/vendor/share-requests')}
                className="w-full flex items-center justify-between p-4 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
              >
                <div className="flex items-center">
                  <FileText className="h-5 w-5 text-oe-primary mr-3" />
                  <span className="font-medium text-gray-900">View All Requests</span>
                </div>
                <ChevronRight className="h-5 w-5 text-gray-400" />
              </button>

              <button
                onClick={() => navigate('/vendor/share-requests?status=New')}
                className="w-full flex items-center justify-between p-4 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
              >
                <div className="flex items-center">
                  <Clock className="h-5 w-5 text-yellow-600 mr-3" />
                  <span className="font-medium text-gray-900">New Requests</span>
                </div>
                <div className="flex items-center">
                  <span className={`px-2 py-1 text-xs font-semibold rounded-full bg-oe-light text-oe-dark mr-2`}>
                    {stats?.statusCounts['New'] || 0}
                  </span>
                  <ChevronRight className="h-5 w-5 text-gray-400" />
                </div>
              </button>

              <button
                onClick={() => navigate('/vendor/share-requests?status=In+Review')}
                className="w-full flex items-center justify-between p-4 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
              >
                <div className="flex items-center">
                  <TrendingUp className="h-5 w-5 text-indigo-600 mr-3" />
                  <span className="font-medium text-gray-900">In Review</span>
                </div>
                <div className="flex items-center">
                  <span className={`px-2 py-1 text-xs font-semibold rounded-full bg-indigo-100 text-indigo-800 mr-2`}>
                    {stats?.statusCounts['In Review'] || 0}
                  </span>
                  <ChevronRight className="h-5 w-5 text-gray-400" />
                </div>
              </button>

              <button
                onClick={() => navigate('/vendor/share-requests?status=Processing')}
                className="w-full flex items-center justify-between p-4 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
              >
                <div className="flex items-center">
                  <DollarSign className="h-5 w-5 text-purple-600 mr-3" />
                  <span className="font-medium text-gray-900">Processing</span>
                </div>
                <div className="flex items-center">
                  <span className={`px-2 py-1 text-xs font-semibold rounded-full bg-purple-100 text-purple-800 mr-2`}>
                    {stats?.statusCounts['Processing'] || 0}
                  </span>
                  <ChevronRight className="h-5 w-5 text-gray-400" />
                </div>
              </button>

              <button
                onClick={() => navigate('/vendor/providers')}
                className="w-full flex items-center justify-between p-4 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
              >
                <div className="flex items-center">
                  <FileText className="h-5 w-5 text-purple-600 mr-3" />
                  <span className="font-medium text-gray-900">Manage Providers</span>
                </div>
                <ChevronRight className="h-5 w-5 text-gray-400" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ShareRequestDashboard;

