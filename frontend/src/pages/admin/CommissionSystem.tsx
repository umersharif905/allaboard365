// frontend/src/pages/admin/CommissionSystem.tsx
import {
  Activity,
  Building,
  Database,
  Edit,
  Eye,
  Globe,
  Settings,
  TrendingUp,
} from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CommissionRulesManager } from '../../components/commissions/CommissionRulesManager';
import { RuleCreationWizard } from '../../components/commissions/RuleCreationWizard';
import SharedHeader from '../../components/layout/SharedHeader';
import { apiService } from '../../services/apiServices';

interface SystemCommissionMetrics {
  totalSystemCommissions: number;
  totalTenants: number;
  totalAgents: number;
  totalRules: number;
  pendingBatches: number;
  monthlyGrowth: number;
  ytdCommissions: number;
  avgCommissionPerTenant: number;
}

interface TenantCommissionSummary {
  tenantId: string;
  tenantName: string;
  totalCommissions: number;
  activeAgents: number;
  pendingAmount: number;
  status: string;
  lastProcessed: string;
}

interface SystemCommissionRule {
  ruleId: string;
  ruleName: string;
  tenantName: string;
  productName: string;
  commissionType: string;
  rate?: number;
  amount?: number;
  status: string;
  effectiveDate: string;
  createdBy: string;
}

const CommissionSystem: React.FC = () => {
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeTab, setActiveTab] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<SystemCommissionMetrics | null>(null);
  const [tenantSummaries, setTenantSummaries] = useState<TenantCommissionSummary[]>([]);
  const [showCreateWizard, setShowCreateWizard] = useState(false);
  const [filters, setFilters] = useState({
    tenantId: '',
    status: '',
    search: '',
  });

  // API calls - Note: apiService handles authentication automatically
  const fetchSystemMetrics = async (): Promise<SystemCommissionMetrics> => {
    try {
      const data = await apiService.get<{ metrics?: SystemCommissionMetrics } | SystemCommissionMetrics>('/api/admin/commissions/system-metrics');
      return (data && typeof data === 'object' && 'metrics' in data) ? (data as any).metrics : data as SystemCommissionMetrics;
    } catch (error: any) {
      throw new Error(error.message || `Failed to fetch system metrics: ${error.status || 'unknown'}`);
    }
  };

  const fetchTenantSummaries = async (): Promise<TenantCommissionSummary[]> => {
    try {
      const data = await apiService.get<{ summaries?: TenantCommissionSummary[]; data?: TenantCommissionSummary[] } | TenantCommissionSummary[]>('/api/admin/commissions/tenant-summaries');
      
      // Handle different response structures
      let summaries: TenantCommissionSummary[] = [];
      
      if (Array.isArray(data)) {
        summaries = data;
      } else if (data && typeof data === 'object') {
        if ('summaries' in data && Array.isArray((data as any).summaries)) {
          summaries = (data as any).summaries;
        } else if ('data' in data && Array.isArray((data as any).data)) {
          summaries = (data as any).data;
        } else {
          console.error('Unexpected response structure:', data);
          summaries = [];
        }
      }
      
      return summaries;
    } catch (error: any) {
      throw new Error(error.message || `Failed to fetch tenant summaries: ${error.status || 'unknown'}`);
    }
  };

  const fetchSystemRules = async (): Promise<SystemCommissionRule[]> => {
    try {
      const data = await apiService.get<{ rules?: SystemCommissionRule[] } | SystemCommissionRule[]>('/api/admin/commissions/system-rules');
      return (data && typeof data === 'object' && 'rules' in data) ? (data as any).rules : (data as SystemCommissionRule[]);
    } catch (error: any) {
      throw new Error(error.message || `Failed to fetch system rules: ${error.status || 'unknown'}`);
    }
  };

  // Handlers
  const handleLogout = () => {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('token');
    navigate('/login');
  };

  const handleSearch = (searchTerm: string) => {
    setFilters({ ...filters, search: searchTerm });
  };

  const handleNotificationClick = () => {
    console.log('Notifications clicked');
  };

  const handleRuleCreated = (newRule: any) => {
    console.log('New commission rule created:', newRule);
    // Show success message (you can replace this with a proper toast notification)
    alert('Commission rule created successfully!');
    
    // If we're on the Global Rules tab, trigger a refresh
    if (activeTab === 2) {
      // You might want to trigger a refresh of the CommissionRulesManager here
      // For now, we'll just reload the metrics
      fetchSystemMetrics().then(setMetrics).catch(console.error);
    }
  };

  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true);
        setError(null);
        
        const [metricsData, tenantData] = await Promise.all([
          fetchSystemMetrics(),
          fetchTenantSummaries(),
        ]);
        
        setMetrics(metricsData);
        setTenantSummaries(tenantData);
      } catch (err) {
        console.error('Error loading commission data:', err);
        setError(err instanceof Error ? err.message : 'Failed to load commission data');
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, []);

  const handleProcessAllBatches = async () => {
    try {
      await apiService.post('/api/admin/commissions/process-batches');
      console.log('Processing all pending batches...');
      // Refresh data after processing
      window.location.reload();
    } catch (err: any) {
      console.error('Error processing batches:', err);
      throw new Error(err.message || 'Failed to process batches');
    }
  };

  const handleViewTenantCommissions = (tenantId: string) => {
    navigate(`/admin/commissions/tenant/${tenantId}`);
  };

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case 'active':
        return 'text-green-600 bg-green-50';
      case 'processing':
        return 'text-yellow-600 bg-yellow-50';
      case 'inactive':
        return 'text-red-600 bg-red-50';
      default:
        return 'text-gray-600 bg-gray-50';
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(amount);
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const tabs = ['System Overview', 'Tenant Management', 'Global Rules', 'System Analytics'];

  if (loading) {
    return (
      <div className="flex h-screen bg-gray-50">
        {/* <AdminNavigation 
          sidebarOpen={sidebarOpen}
          setSidebarOpen={setSidebarOpen}
          onLogout={handleLogout}
          currentUser={{
            firstName: 'System',
            lastName: 'Admin',
            email: 'admin@openenroll.com',
            role: 'SysAdmin'
          }}
        /> */}
        <div className="flex-1 flex flex-col">
          <SharedHeader 
            title="Commission System"
            onSearch={handleSearch}
            onNotificationClick={handleNotificationClick}
            showSearch={true}
            showNotifications={true}
          />
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary mx-auto mb-4"></div>
              <p className="text-gray-600">Loading commission data...</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-screen bg-gray-50">
        {/* <AdminNavigation 
          sidebarOpen={sidebarOpen}
          setSidebarOpen={setSidebarOpen}
          onLogout={handleLogout}
          currentUser={{
            firstName: 'System',
            lastName: 'Admin',
            email: 'admin@openenroll.com',
            role: 'SysAdmin'
          }}
        /> */}
        <div className="flex-1 flex flex-col">
          <SharedHeader 
            title="Commission System"
            onSearch={handleSearch}
            onNotificationClick={handleNotificationClick}
            showSearch={true}
            showNotifications={true}
          />
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="text-red-600 mb-4">
                <Database size={64} className="mx-auto mb-2" />
                <h2 className="text-xl font-semibold">Commission System Error</h2>
              </div>
              <p className="text-gray-600 mb-4">{error}</p>
              <button 
                onClick={() => window.location.reload()}
                className="px-4 py-2 bg-oe-primary text-white rounded-md hover:bg-oe-dark"
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Admin Navigation Sidebar */}
      {/* <AdminNavigation 
        sidebarOpen={sidebarOpen}
        setSidebarOpen={setSidebarOpen}
        onLogout={handleLogout}
        currentUser={{
          firstName: 'System',
          lastName: 'Admin',
          email: 'admin@openenroll.com',
          role: 'SysAdmin'
        }}
      /> */}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col">
        {/* Shared Header */}
        <SharedHeader 
          title="Commission System"
          onSearch={handleSearch}
          onNotificationClick={handleNotificationClick}
          showSearch={true}
          showNotifications={true}
        />

        {/* Commission Content */}
        <div className="flex-1 overflow-auto p-6">
          {/* Header */}
          <div className="flex justify-between items-center mb-6">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">Commission System Management</h1>
              <p className="text-gray-600 mt-1">Global commission oversight and system administration</p>
            </div>
          </div>

          {/* System Metrics Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-6">
            <div className="bg-white p-6 rounded-lg shadow-sm border">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-600">Total System Commissions</p>
                  <p className="text-2xl font-bold text-gray-900">{formatCurrency(metrics?.totalSystemCommissions || 0)}</p>
                  <div className="flex items-center mt-2">
                    <TrendingUp size={16} className="text-green-500" />
                    <span className="text-sm text-gray-600 ml-1">
                      {metrics?.monthlyGrowth?.toFixed(1) || '0.0'}% system growth
                    </span>
                  </div>
                </div>
                <div className="text-oe-primary">
                  <Globe size={40} />
                </div>
              </div>
            </div>

            <div className="bg-white p-6 rounded-lg shadow-sm border">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-600">Active Tenants</p>
                  <p className="text-2xl font-bold text-gray-900">{metrics?.totalTenants || 0}</p>
                  <div className="flex items-center mt-2">
                    <Building size={16} className="text-oe-primary" />
                    <span className="text-sm text-gray-600 ml-1">
                      {metrics?.totalAgents || 0} total agents
                    </span>
                  </div>
                </div>
                <div className="text-green-500">
                  <Building size={40} />
                </div>
              </div>
            </div>

            <div className="bg-white p-6 rounded-lg shadow-sm border">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-600">Global Rules</p>
                  <p className="text-2xl font-bold text-gray-900">{metrics?.totalRules || 0}</p>
                  <div className="flex items-center mt-2">
                    <Settings size={16} className="text-purple-500" />
                    <span className="text-sm text-gray-600 ml-1">
                      Active configurations
                    </span>
                  </div>
                </div>
                <div className="text-purple-500">
                  <Settings size={40} />
                </div>
              </div>
            </div>

            <div className="bg-white p-6 rounded-lg shadow-sm border">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-600">Pending Batches</p>
                  <p className="text-2xl font-bold text-gray-900">{metrics?.pendingBatches || 0}</p>
                  <div className="flex items-center mt-2">
                    <Activity size={16} className="text-orange-500" />
                    <span className="text-sm text-gray-600 ml-1">
                      Awaiting processing
                    </span>
                  </div>
                </div>
                <div className="text-orange-500">
                  <Activity size={40} />
                </div>
              </div>
            </div>
          </div>

          {/* Tabs */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200">
            <div className="border-b border-gray-200">
              <nav className="flex space-x-0">
                {tabs.map((tab, index) => (
                  <button
                    key={index}
                    onClick={() => setActiveTab(index)}
                    className={`flex-1 group relative px-6 py-4 text-center border-b-2 font-medium text-sm transition-all duration-200 ${
                      activeTab === index
                        ? 'border-oe-primary text-gray-900 font-semibold'
                        : 'border-transparent text-gray-700 hover:text-gray-900 hover:border-gray-300'
                    }`}
                    style={activeTab === index ? { 
                      backgroundColor: 'rgba(37, 99, 235, 0.08)',
                      borderBottomColor: 'var(--oe-primary, #2563EB)',
                      borderBottomWidth: '3px'
                    } : {}}
                  >
                    <span className="font-semibold text-gray-900">{tab}</span>
                  </button>
                ))}
              </nav>
            </div>

            <div className="p-6">
              {activeTab === 0 && (
                <div>
                  <h3 className="text-lg font-semibold mb-4">System Overview</h3>
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div className="bg-gray-50 p-4 rounded-lg">
                      <h4 className="font-medium text-gray-900 mb-2">Year-to-Date Performance</h4>
                      <p className="text-2xl font-bold text-green-600">{formatCurrency(metrics?.ytdCommissions || 0)}</p>
                      <p className="text-sm text-gray-600 mt-1">Average per tenant: {formatCurrency(metrics?.avgCommissionPerTenant || 0)}</p>
                    </div>
                    <div className="bg-gray-50 p-4 rounded-lg">
                      <h4 className="font-medium text-gray-900 mb-2">System Health</h4>
                      <div className="flex items-center">
                        <div className="w-2 h-2 bg-green-500 rounded-full mr-2"></div>
                        <span className="text-sm text-gray-600">All systems operational</span>
                      </div>
                      <button
                        onClick={handleProcessAllBatches}
                        className="mt-2 px-3 py-1 bg-oe-primary text-white text-sm rounded hover:bg-oe-primary-dark"
                      >
                        Process Pending Batches
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 1 && (
                <div>
                  <h3 className="text-lg font-semibold mb-4">Tenant Commission Management</h3>
                  {tenantSummaries.length === 0 ? (
                    <div className="text-center py-12">
                      <Building size={48} className="mx-auto text-gray-400 mb-4" />
                      <p className="text-gray-600">No tenant data available</p>
                      <p className="text-sm text-gray-500 mt-2">Tenant commission summaries will appear here once available</p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Tenant
                            </th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Total Commissions
                            </th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Active Agents
                            </th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Pending Amount
                            </th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Status
                            </th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                              Actions
                            </th>
                          </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                          {tenantSummaries.map((tenant) => (
                            <tr key={tenant.tenantId}>
                              <td className="px-6 py-4 whitespace-nowrap">
                                <div className="text-sm font-medium text-gray-900">{tenant.tenantName}</div>
                                <div className="text-sm text-gray-500">Last processed: {formatDate(tenant.lastProcessed)}</div>
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                                {formatCurrency(tenant.totalCommissions)}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                                {tenant.activeAgents}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                                {formatCurrency(tenant.pendingAmount)}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                <span className={`px-2 py-1 text-xs font-medium rounded-full ${getStatusColor(tenant.status)}`}>
                                  {tenant.status}
                                </span>
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                                <button
                                  onClick={() => handleViewTenantCommissions(tenant.tenantId)}
                                  className="text-oe-primary hover:text-oe-dark mr-3"
                                >
                                  <Eye size={16} />
                                </button>
                                <button className="text-gray-600 hover:text-gray-900">
                                  <Edit size={16} />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 2 && (
                <CommissionRulesManager 
                  onCreateRule={() => setShowCreateWizard(true)}
                />
              )}

              {activeTab === 3 && (
                <div>
                  <h3 className="text-lg font-semibold mb-4">System Analytics</h3>
                  <div className="text-center py-12">
                    <Activity size={64} className="mx-auto text-gray-400 mb-4" />
                    <p className="text-gray-600">Advanced analytics and reporting dashboard</p>
                    <p className="text-sm text-gray-500 mt-2">Commission trends, performance metrics, and insights</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Rule Creation Wizard Modal */}
      <RuleCreationWizard
        open={showCreateWizard}
        onClose={() => setShowCreateWizard(false)}
        onRuleCreated={handleRuleCreated}
      />
    </div>
  );
};

export default CommissionSystem;