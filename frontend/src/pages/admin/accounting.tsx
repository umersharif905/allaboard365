// File: frontend/src/pages/admin/accounting.tsx
import React, { useState, useEffect } from 'react';
import NACHAList from '../../components/accounting/NACHAList';
import NACHAWizard from '../../components/accounting/NACHAWizard';
import GenerateCommissionsPreviewModal from '../../components/accounting/GenerateCommissionsPreviewModal';
import CommissionSimulator from '../../components/commissions/CommissionSimulator';
import SharedHeader from '../../components/layout/SharedHeader';
import { useAccounting } from '../../hooks/useAccounting';
import { accountingService } from '../../services/AccountingService';
import { apiService } from '../../services/apiServices';
import { useAuth } from '../../contexts/AuthContext';

// @ts-ignore
import {
    Bar,
    BarChart,
    CartesianGrid,
    Legend,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis
} from 'recharts';

// Icons
import {
    AlertCircle,
    AlertTriangle,
    BarChart2,
    Calculator,
    CheckCircle,
    Clock,
    CreditCard,
    DollarSign,
    Download,
    Eye,
    Filter,
    Loader2,
    Receipt,
    RefreshCcw,
    TrendingUp,
    Users,
    XCircle
} from 'lucide-react';

// Types
interface FilterState {
  search: string;
  status: string;
  paymentMethod: string;
  tenantName: string;
  dateRange: string;
}

const AdminAccounting: React.FC = () => {
  const { user } = useAuth();
  const isSysAdmin = user?.currentRole === 'SysAdmin';
  const [activeTab, setActiveTab] = useState<'payments' | 'commissions' | 'reports'>('commissions');
  const [showFilters, setShowFilters] = useState<boolean>(false);
  const [exportLoading, setExportLoading] = useState<boolean>(false);
  const [showNACHAWizard, setShowNACHAWizard] = useState<boolean>(false);
  const [showCommissionSimulator, setShowCommissionSimulator] = useState<boolean>(false);
  const [refreshNACHA, setRefreshNACHA] = useState<number>(0);
  const [autoOpenNachaId, setAutoOpenNachaId] = useState<string | undefined>();
  const [missingCommissionsCount, setMissingCommissionsCount] = useState<number | null>(null);
  const [loadingMissingCount, setLoadingMissingCount] = useState(false);
  const [resettingCommissions, setResettingCommissions] = useState(false);
  const [showGenerateCommissionsModal, setShowGenerateCommissionsModal] = useState(false);

  // Use accounting hook for data management
  const {
    payments,
    paymentSummary,
    paymentsLoading,
    paymentsError,
    commissions,
    revenueReports,
    reportsLoading,
    reportsError,
    filters,
    setFilters,
    clearFilters,
    refreshPayments,
    refreshReports,
    retryPayment,
    exportPayments,
    exportCommissions,
    exportReports
  } = useAccounting();
  
  const handleSearch = (searchTerm: string) => {
    setFilters({
      ...filters,
      search: searchTerm
    });
  };

  const handleNotificationClick = () => {
    console.log('Notifications clicked');
  };

  const handleFilterChange = (key: keyof FilterState, value: string): void => {
    setFilters({
      ...filters,
      [key]: value
    });
  };

  const handleRetryPayment = async (paymentId: string) => {
    try {
      const result = await retryPayment(paymentId);
      if (result.success) {
        alert('Payment retry successful!');
      } else {
        alert(`Payment retry failed: ${result.message}`);
      }
    } catch (error) {
      alert(`Error retrying payment: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handleExport = async (type: 'payments' | 'commissions' | 'reports', format: 'csv' | 'pdf' = 'csv') => {
    setExportLoading(true);
    try {
      let result;
      switch (type) {
        case 'payments':
          result = await exportPayments(format);
          break;
        case 'commissions':
          result = await exportCommissions(format);
          break;
        case 'reports':
          result = await exportReports(format, 'summary');
          break;
      }
      
      if (result.success) {
        // Create and download file
        const blob = new Blob([result.data], { type: format === 'csv' ? 'text/csv' : 'application/pdf' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = result.filename || `${type}-export.${format}`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
      }
    } catch (error) {
      alert(`Export failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setExportLoading(false);
    }
  };

  // Utility functions
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Completed':
      case 'Paid':
        return 'bg-green-100 text-green-800';
      case 'Failed':
        return 'bg-red-100 text-red-800';
      case 'Pending':
        return 'bg-yellow-100 text-yellow-800';
      case 'Processing':
        return 'bg-oe-light text-oe-dark';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'Completed':
      case 'Paid':
        return <CheckCircle size={16} className="text-green-600" />;
      case 'Failed':
        return <XCircle size={16} className="text-red-600" />;
      case 'Pending':
        return <AlertCircle size={16} className="text-yellow-600" />;
      default:
        return <Clock size={16} className="text-gray-600" />;
    }
  };

  const formatCurrency = (amount: number): string => {
    return accountingService.formatCurrency(amount);
  };

  const formatDate = (date: string): string => {
    return accountingService.formatDate(date);
  };

  // Fetch missing commissions count (SysAdmin only)
  const fetchMissingCommissionsCount = async () => {
    if (!isSysAdmin) return;
    
    setLoadingMissingCount(true);
    try {
      const response = await apiService.get<{ success: boolean; missingCount: number; message?: string }>('/api/commissions/missing');
      if (response.success) {
        setMissingCommissionsCount(response.missingCount);
      }
    } catch (error: any) {
      console.error('Failed to fetch missing commissions count:', error);
      setMissingCommissionsCount(null);
    } finally {
      setLoadingMissingCount(false);
    }
  };

  // Open generate-commissions preview modal (SysAdmin only); actual generation happens inside modal
  const handleGenerateMissingClick = () => {
    if (!isSysAdmin || !missingCommissionsCount || missingCommissionsCount === 0) return;
    setShowGenerateCommissionsModal(true);
  };

  // Reset all commissions (SysAdmin only)
  const handleResetCommissions = async () => {
    if (!isSysAdmin) return;

    // Confirmation dialog with warning
    const confirmed = window.confirm(
      '⚠️ WARNING: This will delete ALL commission records from the database. This is a destructive operation and cannot be undone.\n\nAre you absolutely sure you want to continue?'
    );

    if (!confirmed) return;

    try {
      setResettingCommissions(true);
      const response = await apiService.delete<{
        success: boolean;
        deletedCount: number;
        message?: string;
      }>('/api/commissions/reset', {
        params: {} // Use query params for DELETE
      });

      if (response.success) {
        alert(`Successfully deleted ${response.deletedCount} commission record(s). You can now regenerate commissions using the "Generate Missing Commissions" button.`);
        setMissingCommissionsCount(null); // Reset count - will be recalculated on next fetch
        // Refresh the missing count
        if (isSysAdmin && activeTab === 'commissions') {
          fetchMissingCommissionsCount();
        }
      } else {
        alert(`Error: ${response.message || 'Failed to reset commissions'}`);
      }
    } catch (error: any) {
      alert(`Failed to reset commissions: ${error.message || 'Unknown error'}`);
    } finally {
      setResettingCommissions(false);
    }
  };

  // Fetch missing count on mount if SysAdmin
  useEffect(() => {
    if (isSysAdmin && activeTab === 'commissions') {
      fetchMissingCommissionsCount();
    }
  }, [isSysAdmin, activeTab]);

  const chartColors = {
    primary: '#1f6db0',
    secondary: '#e74c3c',
    success: '#2ecc71',
    warning: '#f39c12',
    info: '#3498db'
  };

  // Loading state
  if (paymentsLoading && payments.length === 0) {
    return (
      <div className="flex h-screen bg-gray-50">
        {/* <AdminNavigation 
          sidebarOpen={sidebarOpen}
          setSidebarOpen={setSidebarOpen}
          onLogout={handleLogout}
          currentUser={{
            firstName: 'Admin',
            lastName: 'User',
            email: 'admin@openenroll.com',
            role: 'Admin'
          }}
        /> */}
        <div className="flex-1 flex flex-col">
          <SharedHeader 
            title="Accounting & Revenue"
            onSearch={handleSearch}
            onNotificationClick={handleNotificationClick}
            showSearch={true}
            showNotifications={true}
            notificationCount={3}
          />
          <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
              <Loader2 className="animate-spin h-8 w-8 text-oe-primary mx-auto mb-4" />
              <p className="text-gray-600">Loading accounting data...</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-gray-50">
      {/* <AdminNavigation 
        sidebarOpen={sidebarOpen}
        setSidebarOpen={setSidebarOpen}
        onLogout={handleLogout}
        currentUser={{
          firstName: 'Admin',
          lastName: 'User',
          email: 'admin@openenroll.com',
          role: 'Admin'
        }}
      /> */}

      <div className="flex-1 flex flex-col">
        <SharedHeader 
          title="Accounting & Revenue"
          onSearch={handleSearch}
          onNotificationClick={handleNotificationClick}
          showSearch={true}
          showNotifications={true}
          notificationCount={3}
        />
        
        <div className="flex-1 overflow-auto p-6">
          {/* Stats Cards */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-6">
            <div className="bg-white rounded-lg shadow p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">Total Revenue</p>
                  <p className="text-2xl font-bold">{formatCurrency(paymentSummary?.totalRevenue || 0)}</p>
                </div>
                <div className="bg-green-500 p-3 rounded-full text-white">
                  <DollarSign size={24} />
                </div>
              </div>
              <div className="text-sm mt-2">
                <span className="text-green-600">+{(paymentSummary?.monthlyGrowth || 0).toFixed(1)}%</span>
                <span className="text-gray-500 ml-1">from last month</span>
              </div>
            </div>
            
            <div className="bg-white rounded-lg shadow p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">Total Payments</p>
                  <p className="text-2xl font-bold">{paymentSummary?.totalPayments || 0}</p>
                </div>
                <div className="bg-oe-primary p-3 rounded-full text-white">
                  <CreditCard size={24} />
                </div>
              </div>
              <div className="text-sm mt-2">
                <span className="text-green-600">{paymentSummary?.successfulPayments || 0}</span>
                <span className="text-gray-500 ml-1">successful</span>
              </div>
            </div>
            
            <div className="bg-white rounded-lg shadow p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">Average Payment</p>
                  <p className="text-2xl font-bold">{formatCurrency(paymentSummary?.averagePayment || 0)}</p>
                </div>
                <div className="bg-purple-500 p-3 rounded-full text-white">
                  <TrendingUp size={24} />
                </div>
              </div>
              <div className="text-sm mt-2">
                <span className="text-oe-primary">{paymentSummary?.pendingPayments || 0}</span>
                <span className="text-gray-500 ml-1">pending</span>
              </div>
            </div>
            
            <div className="bg-white rounded-lg shadow p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">Failed Payments</p>
                  <p className="text-2xl font-bold">{paymentSummary?.failedPayments || 0}</p>
                </div>
                <div className="bg-red-500 p-3 rounded-full text-white">
                  <AlertCircle size={24} />
                </div>
              </div>
              <div className="text-sm mt-2">
                <span className="text-red-600">
                  {paymentSummary && paymentSummary.totalPayments > 0 
                    ? ((paymentSummary.failedPayments / paymentSummary.totalPayments) * 100).toFixed(1)
                    : 0}%
                </span>
                <span className="text-gray-500 ml-1">failure rate</span>
              </div>
            </div>
          </div>

          {/* Tab Navigation */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 mb-6">
            <div className="border-b border-gray-200">
              <nav className="flex space-x-0">
                <button
                  onClick={() => setActiveTab('payments')}
                  className={`flex-1 group relative px-6 py-4 text-center border-b-2 font-medium text-sm transition-all duration-200 ${
                    activeTab === 'payments'
                      ? 'border-oe-primary text-gray-900 font-semibold'
                      : 'border-transparent text-gray-700 hover:text-gray-900 hover:border-gray-300'
                  }`}
                  style={activeTab === 'payments' ? { 
                    backgroundColor: 'rgba(37, 99, 235, 0.08)',
                    borderBottomColor: 'var(--oe-primary, #2563EB)',
                    borderBottomWidth: '3px'
                  } : {}}
                >
                  <div className="flex items-center justify-center">
                    <Receipt size={16} className="mr-2" style={activeTab === 'payments' ? { color: 'var(--oe-primary, #2563EB)' } : { color: '#6B7280' }} />
                    <span className="font-semibold text-gray-900">Payments ({payments.length})</span>
                  </div>
                </button>
                <button
                  onClick={() => setActiveTab('commissions')}
                  className={`flex-1 group relative px-6 py-4 text-center border-b-2 font-medium text-sm transition-all duration-200 ${
                    activeTab === 'commissions'
                      ? 'border-oe-primary text-gray-900 font-semibold'
                      : 'border-transparent text-gray-700 hover:text-gray-900 hover:border-gray-300'
                  }`}
                  style={activeTab === 'commissions' ? { 
                    backgroundColor: 'rgba(37, 99, 235, 0.08)',
                    borderBottomColor: 'var(--oe-primary, #2563EB)',
                    borderBottomWidth: '3px'
                  } : {}}
                >
                  <div className="flex items-center justify-center">
                    <CreditCard size={16} className="mr-2" style={activeTab === 'commissions' ? { color: 'var(--oe-primary, #2563EB)' } : { color: '#6B7280' }} />
                    <span className="font-semibold text-gray-900">Commissions ({commissions.length})</span>
                  </div>
                </button>
                <button
                  onClick={() => setActiveTab('reports')}
                  className={`flex-1 group relative px-6 py-4 text-center border-b-2 font-medium text-sm transition-all duration-200 ${
                    activeTab === 'reports'
                      ? 'border-oe-primary text-gray-900 font-semibold'
                      : 'border-transparent text-gray-700 hover:text-gray-900 hover:border-gray-300'
                  }`}
                  style={activeTab === 'reports' ? { 
                    backgroundColor: 'rgba(37, 99, 235, 0.08)',
                    borderBottomColor: 'var(--oe-primary, #2563EB)',
                    borderBottomWidth: '3px'
                  } : {}}
                >
                  <div className="flex items-center justify-center">
                    <BarChart2 size={16} className="mr-2" style={activeTab === 'reports' ? { color: 'var(--oe-primary, #2563EB)' } : { color: '#6B7280' }} />
                    <span className="font-semibold text-gray-900">Reports</span>
                  </div>
                </button>
              </nav>
            </div>

            {/* Tab Content */}
            <div className="p-6">
              {activeTab === 'payments' && (
                <div>
                  {/* Payments Toolbar */}
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-4">
                      <button
                        onClick={() => setShowFilters(!showFilters)}
                        className="flex items-center px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                      >
                        <Filter size={16} className="mr-2" />
                        Filters
                      </button>
                      <button
                        onClick={() => refreshPayments()}
                        className="flex items-center px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                        disabled={paymentsLoading}
                      >
                        <RefreshCcw size={16} className={`mr-2 ${paymentsLoading ? 'animate-spin' : ''}`} />
                        Refresh
                      </button>
                    </div>
                    
                    <div className="flex items-center gap-4">
                      <span className="text-sm text-gray-600">
                        {payments.length} payments found
                      </span>
                      <button 
                        onClick={() => handleExport('payments', 'csv')}
                        disabled={exportLoading}
                        className="bg-oe-success text-white px-4 py-2 rounded-md hover:bg-green-700 transition-colors flex items-center disabled:opacity-50"
                      >
                        {exportLoading ? (
                          <Loader2 size={16} className="mr-2 animate-spin" />
                        ) : (
                          <Download size={16} className="mr-2" />
                        )}
                        Export
                      </button>
                    </div>
                  </div>

                  {/* Payments Filters */}
                  {showFilters && (
                    <div className="bg-gray-50 rounded-lg p-4 mb-6">
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                          <select
                            value={filters.status || ''}
                            onChange={(e) => handleFilterChange('status', e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                          >
                            <option value="">All Statuses</option>
                            <option value="Completed">Completed</option>
                            <option value="Pending">Pending</option>
                            <option value="Failed">Failed</option>
                            <option value="Processing">Processing</option>
                          </select>
                        </div>
                        
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Payment Method</label>
                          <select
                            value={filters.paymentMethod || ''}
                            onChange={(e) => handleFilterChange('paymentMethod', e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                          >
                            <option value="">All Methods</option>
                            <option value="CreditCard">Credit Card</option>
                            <option value="ACH">ACH</option>
                          </select>
                        </div>
                        
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Date Range</label>
                          <select
                            value={filters.dateRange || ''}
                            onChange={(e) => handleFilterChange('dateRange', e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                          >
                            <option value="">All Time</option>
                            <option value="7d">Last 7 Days</option>
                            <option value="30d">Last 30 Days</option>
                            <option value="90d">Last 90 Days</option>
                          </select>
                        </div>
                        
                        <div className="flex items-end">
                          <button
                            onClick={clearFilters}
                            className="w-full px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                          >
                            Clear Filters
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Error Display */}
                  {paymentsError && (
                    <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-6">
                      <div className="flex">
                        <AlertCircle className="h-5 w-5 text-red-400" />
                        <div className="ml-3">
                          <h3 className="text-sm font-medium text-red-800">Error Loading Payments</h3>
                          <p className="mt-2 text-sm text-red-700">{paymentsError}</p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Payments Table */}
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Member</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Product</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Amount</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Method</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Date</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {payments.map((payment) => (
                          <tr key={payment.PaymentId} className="hover:bg-gray-50">
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div>
                                <div className="text-sm font-medium text-gray-900">{payment.MemberName}</div>
                                <div className="text-sm text-gray-500">{payment.TenantName}</div>
                              </div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                              {payment.ProductName}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                              {formatCurrency(payment.Amount)}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div className="flex items-center">
                                {getStatusIcon(payment.Status)}
                                <span className={`ml-2 px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(payment.Status)}`}>
                                  {payment.Status}
                                </span>
                              </div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                              {payment.PaymentMethod}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                              {formatDate(payment.PaymentDate)}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                              <div className="flex items-center space-x-2">
                                <button className="text-oe-primary hover:text-oe-dark">
                                  <Eye size={16} />
                                </button>
                                {payment.Status === 'Failed' && (
                                  <button 
                                    onClick={() => handleRetryPayment(payment.PaymentId)}
                                    className="text-green-600 hover:text-green-900"
                                    title="Retry Payment"
                                  >
                                    <RefreshCcw size={16} />
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    
                    {payments.length === 0 && !paymentsLoading && (
                      <div className="text-center py-12">
                        <Receipt className="mx-auto h-12 w-12 text-gray-400" />
                        <h3 className="mt-2 text-sm font-medium text-gray-900">No payments found</h3>
                        <p className="mt-1 text-sm text-gray-500">Payments will appear here once transactions are processed.</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {activeTab === 'commissions' && (
                <div>
                  {/* Commissions/NACHA Toolbar */}
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => setShowNACHAWizard(true)}
                        className="bg-oe-primary text-white px-4 py-2 rounded-md hover:bg-oe-dark transition-colors flex items-center"
                      >
                        <CreditCard size={16} className="mr-2" />
                        New NACHA Payout
                      </button>
                      <button
                        onClick={() => setShowCommissionSimulator(true)}
                        className="bg-oe-primary text-white px-4 py-2 rounded-md hover:bg-oe-dark transition-colors flex items-center"
                      >
                        <Calculator size={16} className="mr-2" />
                        Commission Simulator
                      </button>
                      {isSysAdmin && (
                        <>
                          <button
                            onClick={fetchMissingCommissionsCount}
                            disabled={loadingMissingCount}
                            className="bg-gray-600 text-white px-4 py-2 rounded-md hover:bg-gray-700 transition-colors flex items-center disabled:opacity-50 disabled:cursor-not-allowed"
                            title="Refresh missing commissions count"
                          >
                            <RefreshCcw size={16} className={`mr-2 ${loadingMissingCount ? 'animate-spin' : ''}`} />
                            {loadingMissingCount ? 'Checking...' : 'Check Missing'}
                          </button>
                          {missingCommissionsCount !== null && missingCommissionsCount > 0 && (
                            <button
                              onClick={handleGenerateMissingClick}
                              disabled={loadingMissingCount}
                              className="bg-yellow-600 text-white px-4 py-2 rounded-md hover:bg-yellow-700 transition-colors flex items-center disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <AlertTriangle size={16} className="mr-2" />
                              {loadingMissingCount ? 'Loading...' : `Generate commissions (${missingCommissionsCount})`}
                            </button>
                          )}
                        </>
                      )}
                      {isSysAdmin && (
                        <button
                          onClick={handleResetCommissions}
                          disabled={resettingCommissions}
                          className="bg-red-600 text-white px-4 py-2 rounded-md hover:bg-red-700 transition-colors flex items-center disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <XCircle size={16} className="mr-2" />
                          {resettingCommissions ? 'Resetting...' : 'Reset All Commissions'}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Missing Commissions Warning (SysAdmin only) */}
                  {isSysAdmin && missingCommissionsCount !== null && missingCommissionsCount > 0 && (
                    <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                      <div className="flex items-center gap-2">
                        <AlertTriangle className="h-5 w-5 text-yellow-600" />
                        <div className="flex-1">
                          <h3 className="text-sm font-semibold text-yellow-800">
                            Missing Commissions Detected
                          </h3>
                          <p className="text-sm text-yellow-700 mt-1">
                            {missingCommissionsCount} invoice(s) found without commission rows. These commissions can be generated retroactively using the same logic as the commission trigger.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* NACHA Files List */}
                  <NACHAList refreshTrigger={refreshNACHA} autoOpenNachaId={autoOpenNachaId} />
                </div>
              )}

              {activeTab === 'reports' && (
                <div>
                  {/* Reports Header */}
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="text-lg font-semibold text-gray-900">Revenue Analytics</h3>
                    <div className="flex items-center gap-4">
                      <button
                        onClick={() => refreshReports()}
                        className="flex items-center px-4 py-2 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
                        disabled={reportsLoading}
                      >
                        <RefreshCcw size={16} className={`mr-2 ${reportsLoading ? 'animate-spin' : ''}`} />
                        Refresh
                      </button>
                      <button 
                        onClick={() => handleExport('reports', 'csv')}
                        disabled={exportLoading}
                        className="bg-oe-success text-white px-4 py-2 rounded-md hover:bg-green-700 transition-colors flex items-center disabled:opacity-50"
                      >
                        {exportLoading ? (
                          <Loader2 size={16} className="mr-2 animate-spin" />
                        ) : (
                          <Download size={16} className="mr-2" />
                        )}
                        Export
                      </button>
                    </div>
                  </div>

                  {/* Error Display */}
                  {reportsError && (
                    <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-6">
                      <div className="flex">
                        <AlertCircle className="h-5 w-5 text-red-400" />
                        <div className="ml-3">
                          <h3 className="text-sm font-medium text-red-800">Error Loading Reports</h3>
                          <p className="mt-2 text-sm text-red-700">{reportsError}</p>
                        </div>
                      </div>
                    </div>
                  )}

                  {revenueReports && (
                    <div className="space-y-6">
                      {/* Summary Cards */}
                      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                        <div className="bg-gradient-to-br from-blue-500 to-blue-600 rounded-lg p-6 text-white">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-oe-light">Total Revenue</p>
                              <p className="text-2xl font-bold">{formatCurrency(revenueReports.summary.totalRevenue)}</p>
                            </div>
                            <DollarSign size={32} className="text-oe-light" />
                          </div>
                        </div>
                        
                        <div className="bg-gradient-to-br from-green-500 to-green-600 rounded-lg p-6 text-white">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-green-100">Net Revenue</p>
                              <p className="text-2xl font-bold">{formatCurrency(revenueReports.summary.netRevenue)}</p>
                            </div>
                            <TrendingUp size={32} className="text-green-200" />
                          </div>
                        </div>
                        
                        <div className="bg-gradient-to-br from-purple-500 to-purple-600 rounded-lg p-6 text-white">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-purple-100">Commissions</p>
                              <p className="text-2xl font-bold">{formatCurrency(revenueReports.summary.totalCommissions)}</p>
                            </div>
                            <Users size={32} className="text-purple-200" />
                          </div>
                        </div>
                        
                        <div className="bg-gradient-to-br from-orange-500 to-orange-600 rounded-lg p-6 text-white">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-orange-100">Growth Rate</p>
                              <p className="text-2xl font-bold">+{revenueReports.summary.growthRate.toFixed(1)}%</p>
                            </div>
                            <BarChart2 size={32} className="text-orange-200" />
                          </div>
                        </div>
                      </div>

                      {/* Revenue Chart */}
                      <div className="bg-white border border-gray-200 rounded-lg p-6">
                        <div className="flex justify-between items-center mb-4">
                          <h4 className="text-lg font-semibold text-gray-700">Monthly Revenue Trend</h4>
                          <select className="p-2 border rounded text-sm">
                            <option>Last 12 Months</option>
                            <option>Last 6 Months</option>
                            <option>Year to Date</option>
                          </select>
                        </div>
                        <div className="h-80">
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={revenueReports.revenueByMonth.slice(0, 12)}>
                              <CartesianGrid strokeDasharray="3 3" vertical={false} />
                              <XAxis dataKey="month" />
                              <YAxis tickFormatter={(value: any) => `$${(value / 1000).toFixed(0)}K`} />
                              <Tooltip 
                                formatter={(value: any, name: string) => [formatCurrency(value), name]}
                                labelFormatter={(label: any) => `Month: ${label}`}
                              />
                              <Legend />
                              <Bar dataKey="revenue" name="Total Revenue" fill={chartColors.primary} />
                              <Bar dataKey="netRevenue" name="Net Revenue" fill={chartColors.success} />
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      </div>

                      {/* Revenue by Tenant & Product */}
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        {/* Top Tenants */}
                        <div className="bg-white border border-gray-200 rounded-lg p-6">
                          <h4 className="text-lg font-semibold text-gray-700 mb-4">Top Performing Tenants</h4>
                          <div className="space-y-4">
                            {revenueReports.revenueByTenant.slice(0, 5).map((tenant, index) => (
                              <div key={index} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                                <div>
                                  <p className="font-medium text-gray-900">{tenant.tenantName}</p>
                                  <p className="text-sm text-gray-500">{tenant.members} members • {tenant.products} products</p>
                                </div>
                                <div className="text-right">
                                  <p className="font-semibold text-gray-900">{formatCurrency(tenant.revenue)}</p>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* Top Products */}
                        <div className="bg-white border border-gray-200 rounded-lg p-6">
                          <h4 className="text-lg font-semibold text-gray-700 mb-4">Top Revenue Products</h4>
                          <div className="space-y-4">
                            {revenueReports.revenueByProduct.slice(0, 5).map((product, index) => (
                              <div key={index} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                                <div>
                                  <p className="font-medium text-gray-900">{product.productName}</p>
                                  <p className="text-sm text-gray-500">{product.subscriptions} subscriptions • Avg: {formatCurrency(product.averagePrice)}</p>
                                </div>
                                <div className="text-right">
                                  <p className="font-semibold text-gray-900">{formatCurrency(product.revenue)}</p>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>

                      {/* Top Agents */}
                      <div className="bg-white border border-gray-200 rounded-lg p-6">
                        <h4 className="text-lg font-semibold text-gray-700 mb-4">Top Commission Earners</h4>
                        <div className="overflow-x-auto">
                          <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gray-50">
                              <tr>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Agent</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Tenant</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Total Sales</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Commissions</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Avg Rate</th>
                              </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-200">
                              {revenueReports.commissionsByAgent.slice(0, 10).map((agent, index) => (
                                <tr key={index} className="hover:bg-gray-50">
                                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                                    {agent.agentName}
                                  </td>
                                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                    {agent.tenantName}
                                  </td>
                                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                                    {formatCurrency(agent.totalSales)}
                                  </td>
                                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-green-600">
                                    {formatCurrency(agent.totalCommissions)}
                                  </td>
                                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                    {agent.averageRate.toFixed(1)}%
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  )}

                  {!revenueReports && !reportsLoading && (
                    <div className="text-center py-12">
                      <BarChart2 className="mx-auto h-12 w-12 text-gray-400" />
                      <h3 className="mt-2 text-sm font-medium text-gray-900">No report data available</h3>
                      <p className="mt-1 text-sm text-gray-500">Revenue analytics will appear here once data is available.</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* NACHA Wizard Modal */}
      <NACHAWizard
        isOpen={showNACHAWizard}
        onClose={() => setShowNACHAWizard(false)}
        onSuccess={(generatedNACHA) => {
          setRefreshNACHA(prev => prev + 1);
          setShowNACHAWizard(false);
          if (generatedNACHA?.nachaId) {
            setAutoOpenNachaId(generatedNACHA.nachaId);
          }
        }}
      />

      {/* Commission Simulator Modal */}
      {showCommissionSimulator && (
        <CommissionSimulator onClose={() => setShowCommissionSimulator(false)} />
      )}

      {/* Generate commissions preview modal */}
      <GenerateCommissionsPreviewModal
        isOpen={showGenerateCommissionsModal}
        onClose={() => setShowGenerateCommissionsModal(false)}
        onGenerated={() => fetchMissingCommissionsCount()}
      />
    </div>
  );
};

export default AdminAccounting;