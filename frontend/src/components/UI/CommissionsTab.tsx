import React, { useState, useEffect } from 'react';
import { TrendingUp, DollarSign, Award, Download, Filter, CheckCircle, Clock, User, FileText, Lock } from 'lucide-react';

import { API_CONFIG } from '../../config/api';
interface Commission {
  CommissionId: string;
  AgentId: string;
  AgentName: string;
  TenantName: string;
  MemberId: string;
  MemberName: string;
  ProductName: string;
  SaleAmount: number;
  CommissionRate: number;
  CommissionAmount: number;
  SaleDate: string;
  PayoutDate?: string;
  Status: 'Earned' | 'Paid' | 'Pending' | 'Cancelled' | 'Uninvoiced' | 'Reserved';
  PaymentMethod?: string;
}

interface Agent {
  AgentId: string;
  Name: string;
  Email: string;
  TenantName: string;
  DefaultCommissionRate: number;
  TotalEarned: number;
  TotalPaid: number;
  PendingAmount: number;
  ActiveMembers: number;
}

interface CommissionSummary {
  totalCommissions: number;
  totalPaid: number;
  totalPending: number;
  totalAgents: number;
  averageCommission: number;
  topAgent: {
    name: string;
    amount: number;
  };
  monthlyGrowth: number;
}

interface CommissionsTabProps {
  isActive: boolean;
}

export default function CommissionsTab({ isActive }: CommissionsTabProps) {
  const [commissions, setCommissions] = useState<Commission[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [summary, setSummary] = useState<CommissionSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedCommissions, setSelectedCommissions] = useState<string[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [filters, setFilters] = useState({
    status: '',
    agentId: '',
    dateRange: '30d',
    search: ''
  });

  const apiCall = async (endpoint: string, options: RequestInit = {}): Promise<any> => {
    const token = localStorage.getItem('accessToken');
    const baseUrl = process.env.NODE_ENV === 'development' 
      ? API_CONFIG.BASE_URL 
      : API_CONFIG.BASE_URL;

    const response = await fetch(`${baseUrl}${endpoint}`, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...options.headers,
      },
      ...options,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Request failed' }));
      throw new Error(error.message || `HTTP ${response.status}`);
    }

    return await response.json();
  };

  const fetchCommissions = async () => {
    setLoading(true);
    try {
      const queryParams = new URLSearchParams();
      if (filters.status) queryParams.append('status', filters.status);
      if (filters.agentId) queryParams.append('agentId', filters.agentId);
      if (filters.dateRange) queryParams.append('dateRange', filters.dateRange);
      if (filters.search) queryParams.append('search', filters.search);

      const response = await apiCall(`/api/accounting/commissions?${queryParams.toString()}`);
      setCommissions(response.commissions || []);
      setAgents(response.agents || []);
      setSummary(response.summary || null);
    } catch (error) {
      console.error('Error fetching commissions:', error);
      setSampleData();
    } finally {
      setLoading(false);
    }
  };

  const setSampleData = () => {
    const sampleCommissions: Commission[] = [
      {
        CommissionId: '1',
        AgentId: 'agent1',
        AgentName: 'Jennifer Davis',
        TenantName: 'ABC Insurance Agency',
        MemberId: 'member1',
        MemberName: 'John Smith',
        ProductName: 'Premium Health Plan',
        SaleAmount: 2999.90,
        CommissionRate: 15.0,
        CommissionAmount: 449.99,
        SaleDate: '2024-06-15T10:30:00Z',
        PayoutDate: '2024-06-30T09:00:00Z',
        Status: 'Paid',
        PaymentMethod: 'Direct Deposit'
      },
      {
        CommissionId: '2',
        AgentId: 'agent2',
        AgentName: 'Robert Johnson',
        TenantName: 'XYZ Benefits Group',
        MemberId: 'member2',
        MemberName: 'Sarah Wilson',
        ProductName: 'Family Health Bundle',
        SaleAmount: 1850.00,
        CommissionRate: 12.0,
        CommissionAmount: 222.00,
        SaleDate: '2024-06-14T14:15:00Z',
        Status: 'Earned'
      },
      {
        CommissionId: '3',
        AgentId: 'agent1',
        AgentName: 'Jennifer Davis',
        TenantName: 'ABC Insurance Agency',
        MemberId: 'member3',
        MemberName: 'Mike Thompson',
        ProductName: 'Dental Coverage Plus',
        SaleAmount: 1250.00,
        CommissionRate: 15.0,
        CommissionAmount: 187.50,
        SaleDate: '2024-06-13T09:45:00Z',
        Status: 'Earned'
      }
    ];

    const sampleAgents: Agent[] = [
      {
        AgentId: 'agent1',
        Name: 'Jennifer Davis',
        Email: 'j.davis@abcinsurance.com',
        TenantName: 'ABC Insurance Agency',
        DefaultCommissionRate: 15.0,
        TotalEarned: 12450.00,
        TotalPaid: 9850.00,
        PendingAmount: 2600.00,
        ActiveMembers: 145
      },
      {
        AgentId: 'agent2',
        Name: 'Robert Johnson',
        Email: 'r.johnson@xyzbenefits.com',
        TenantName: 'XYZ Benefits Group',
        DefaultCommissionRate: 12.0,
        TotalEarned: 9870.00,
        TotalPaid: 8200.00,
        PendingAmount: 1670.00,
        ActiveMembers: 112
      },
      {
        AgentId: 'agent3',
        Name: 'Sarah Williams',
        Email: 's.williams@healthcorp.com',
        TenantName: 'HealthCorp Solutions',
        DefaultCommissionRate: 12.5,
        TotalEarned: 8950.00,
        TotalPaid: 7100.00,
        PendingAmount: 1850.00,
        ActiveMembers: 98
      }
    ];

    const sampleSummary: CommissionSummary = {
      totalCommissions: 58240.00,
      totalPaid: 45680.00,
      totalPending: 12560.00,
      totalAgents: 8,
      averageCommission: 285.50,
      topAgent: {
        name: 'Jennifer Davis',
        amount: 12450.00
      },
      monthlyGrowth: 12.3
    };

    setCommissions(sampleCommissions);
    setAgents(sampleAgents);
    setSummary(sampleSummary);
  };

  const processCommissionPayout = async () => {
    if (selectedCommissions.length === 0) {
      alert('Please select commissions to pay out');
      return;
    }

    try {
      await apiCall('/api/accounting/commissions/payout', {
        method: 'POST',
        body: JSON.stringify({ commissionIds: selectedCommissions })
      });
      
      await fetchCommissions();
      setSelectedCommissions([]);
      alert('Commission payout processed successfully');
    } catch (error) {
      console.error('Error processing commission payout:', error);
      alert('Failed to process commission payout');
    }
  };

  const updateCommissionRate = async (agentId: string, newRate: number) => {
    try {
      await apiCall(`/api/accounting/agents/${agentId}/commission-rate`, {
        method: 'PUT',
        body: JSON.stringify({ commissionRate: newRate })
      });
      
      await fetchCommissions();
      alert('Commission rate updated successfully');
    } catch (error) {
      console.error('Error updating commission rate:', error);
      alert('Failed to update commission rate');
    }
  };

  const exportCommissions = async (format: 'csv' | 'pdf') => {
    try {
      const queryParams = new URLSearchParams(filters);
      queryParams.append('format', format);
      
      // For now, create sample export data
      const exportData = format === 'csv' 
        ? 'Agent,Organization,Sale Amount,Commission Rate,Commission Amount,Status,Sale Date\nJennifer Davis,ABC Insurance,2999.90,15.0,449.99,Paid,2024-06-15'
        : 'PDF commission export data';
      
      const blob = new Blob([exportData], { 
        type: format === 'csv' ? 'text/csv' : 'application/pdf' 
      });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `commissions-${filters.dateRange}.${format}`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error('Error exporting commissions:', error);
      alert('Export failed - feature in development');
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'Paid':
        return <CheckCircle className="text-oe-success" size={18} />;
      case 'Earned':
        return <Clock className="text-oe-primary" size={18} />;
      case 'Pending':
        return <Clock className="text-oe-warning" size={18} />;
      case 'Cancelled':
        return <CheckCircle className="text-oe-error" size={18} />;
      case 'Uninvoiced':
        return <FileText className="text-amber-700" size={18} />;
      case 'Reserved':
        return <Lock className="text-violet-700" size={18} />;
      default:
        return <Clock className="text-gray-600" size={18} />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Paid':
        return 'bg-green-100 text-green-900 border border-green-200';
      case 'Earned':
        return 'bg-sky-100 text-sky-900 border border-sky-200';
      case 'Pending':
        return 'bg-yellow-100 text-yellow-900 border border-yellow-200';
      case 'Cancelled':
        return 'bg-red-100 text-red-900 border border-red-200';
      case 'Uninvoiced':
        return 'bg-amber-100 text-amber-950 border border-amber-300';
      case 'Reserved':
        return 'bg-violet-100 text-violet-900 border border-violet-200';
      default:
        return 'bg-gray-100 text-gray-900 border border-gray-200';
    }
  };

  useEffect(() => {
    if (isActive) {
      fetchCommissions();
    }
  }, [isActive, filters]);

  if (!isActive) return null;

  return (
    <div className="space-y-6">
      {/* Commission Summary Cards */}
      {summary && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <div className="bg-green-50 rounded-lg p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-oe-success text-sm font-medium">Total Commissions</p>
                <p className="text-2xl font-bold text-green-900">
                  ${summary.totalCommissions.toLocaleString()}
                </p>
                <p className="text-sm text-oe-success mt-1">
                  +{summary.monthlyGrowth}% this month
                </p>
              </div>
              <DollarSign className="text-oe-success" size={32} />
            </div>
          </div>

          <div className="bg-oe-light rounded-lg p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-oe-primary text-sm font-medium">Paid Out</p>
                <p className="text-2xl font-bold text-oe-dark">
                  ${summary.totalPaid.toLocaleString()}
                </p>
                <p className="text-sm text-oe-primary mt-1">
                  ${summary.averageCommission.toFixed(2)} average
                </p>
              </div>
              <CheckCircle className="text-oe-primary" size={32} />
            </div>
          </div>

          <div className="bg-yellow-50 rounded-lg p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-oe-warning text-sm font-medium">Pending Payout</p>
                <p className="text-2xl font-bold text-yellow-900">
                  ${summary.totalPending.toLocaleString()}
                </p>
                <p className="text-sm text-oe-warning mt-1">
                  Ready for processing
                </p>
              </div>
              <Clock className="text-oe-warning" size={32} />
            </div>
          </div>

          <div className="bg-purple-50 rounded-lg p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-purple-600 text-sm font-medium">Top Agent</p>
                <p className="text-lg font-bold text-purple-900">{summary.topAgent.name}</p>
                <p className="text-sm text-purple-600 mt-1">
                  ${summary.topAgent.amount.toLocaleString()} earned
                </p>
              </div>
              <Award className="text-purple-600" size={32} />
            </div>
          </div>
        </div>
      )}

      {/* Filters and Actions */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Filter size={16} className="text-gray-500" />
              <select
                value={filters.status}
                onChange={(e) => setFilters(prev => ({ ...prev, status: e.target.value }))}
                className="form-input text-sm"
              >
                <option value="">All Statuses</option>
                <option value="Earned">Earned</option>
                <option value="Paid">Paid</option>
                <option value="Pending">Pending</option>
                <option value="Cancelled">Cancelled</option>
              </select>
            </div>

            <select
              value={filters.agentId}
              onChange={(e) => setFilters(prev => ({ ...prev, agentId: e.target.value }))}
              className="form-input text-sm"
            >
              <option value="">All Agents</option>
              {agents.map((agent) => (
                <option key={agent.AgentId} value={agent.AgentId}>
                  {agent.Name}
                </option>
              ))}
            </select>

            <select
              value={filters.dateRange}
              onChange={(e) => setFilters(prev => ({ ...prev, dateRange: e.target.value }))}
              className="form-input text-sm"
            >
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="90d">Last 90 days</option>
              <option value="1y">Last year</option>
            </select>

            <input
              type="text"
              placeholder="Search commissions..."
              value={filters.search}
              onChange={(e) => setFilters(prev => ({ ...prev, search: e.target.value }))}
              className="form-input text-sm w-64"
            />
          </div>

          <div className="flex items-center gap-2">
            {selectedCommissions.length > 0 && (
              <button
                onClick={processCommissionPayout}
                className="bg-oe-success text-white px-4 py-2 rounded-md hover:bg-green-700 flex items-center text-sm"
              >
                <DollarSign size={16} className="mr-1" />
                Pay Out ({selectedCommissions.length})
              </button>
            )}
            <button
              onClick={() => exportCommissions('csv')}
              className="bg-oe-primary text-white px-3 py-2 rounded-md hover:bg-oe-dark flex items-center text-sm"
            >
              <Download size={16} className="mr-1" />
              Export CSV
            </button>
          </div>
        </div>
      </div>

      {/* Agents Overview */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200">
        <div className="p-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold">Agent Overview</h3>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 p-6">
          {agents.map((agent) => (
            <div key={agent.AgentId} className="bg-oe-neutral-light rounded-lg p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="bg-oe-light rounded-full p-2">
                    <User className="text-oe-primary" size={20} />
                  </div>
                  <div>
                    <h4 className="font-semibold text-oe-neutral-dark">{agent.Name}</h4>
                    <p className="text-sm text-gray-600">{agent.TenantName}</p>
                  </div>
                </div>
                <button
                  onClick={() => setSelectedAgent(agent)}
                  className="text-oe-primary hover:bg-oe-light px-2 py-1 rounded text-sm"
                >
                  Manage
                </button>
              </div>
              
              <div className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-sm text-gray-600">Commission Rate:</span>
                  <span className="text-sm font-bold text-oe-primary">
                    {agent.DefaultCommissionRate}%
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-gray-600">Total Earned:</span>
                  <span className="text-sm font-bold text-oe-success">
                    ${agent.TotalEarned.toLocaleString()}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-gray-600">Pending:</span>
                  <span className="text-sm font-bold text-oe-warning">
                    ${agent.PendingAmount.toLocaleString()}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-gray-600">Active Members:</span>
                  <span className="text-sm font-medium">{agent.ActiveMembers}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Commissions Table */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200">
        <div className="p-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold">Commission Transactions</h3>
        </div>

        {loading ? (
          <div className="p-8 text-center">
            <TrendingUp className="animate-pulse mx-auto mb-4 text-gray-400" size={32} />
            <p className="text-gray-600">Loading commissions...</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-oe-neutral-light">
                <tr>
                  <th className="text-left p-4 font-medium text-gray-700">
                    <input
                      type="checkbox"
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedCommissions(commissions.filter(c => c.Status === 'Earned').map(c => c.CommissionId));
                        } else {
                          setSelectedCommissions([]);
                        }
                      }}
                      className="rounded border-gray-300"
                    />
                  </th>
                  <th className="text-left p-4 font-medium text-gray-700">Agent</th>
                  <th className="text-left p-4 font-medium text-gray-700">Sale</th>
                  <th className="text-left p-4 font-medium text-gray-700">Commission</th>
                  <th className="text-left p-4 font-medium text-gray-700">Status</th>
                  <th className="text-left p-4 font-medium text-gray-700">Sale Date</th>
                </tr>
              </thead>
              <tbody>
                {commissions.map((commission) => (
                  <tr key={commission.CommissionId} className="border-b border-gray-200 hover:bg-oe-neutral-light">
                    <td className="p-4">
                      <input
                        type="checkbox"
                        checked={selectedCommissions.includes(commission.CommissionId)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedCommissions(prev => [...prev, commission.CommissionId]);
                          } else {
                            setSelectedCommissions(prev => prev.filter(id => id !== commission.CommissionId));
                          }
                        }}
                        disabled={commission.Status !== 'Earned'}
                        className="rounded border-gray-300"
                      />
                    </td>
                    <td className="p-4">
                      <div>
                        <p className="font-medium text-oe-neutral-dark">{commission.AgentName}</p>
                        <p className="text-sm text-gray-600">{commission.TenantName}</p>
                      </div>
                    </td>
                    <td className="p-4">
                      <div>
                        <p className="font-medium text-oe-neutral-dark">{commission.ProductName}</p>
                        <p className="text-sm text-gray-600">{commission.MemberName}</p>
                        <p className="text-sm font-bold text-oe-neutral-dark">
                          ${commission.SaleAmount.toFixed(2)}
                        </p>
                      </div>
                    </td>
                    <td className="p-4">
                      <div>
                        <p className="text-sm text-gray-600">{commission.CommissionRate}% rate</p>
                        <p className="font-bold text-oe-success">
                          ${commission.CommissionAmount.toFixed(2)}
                        </p>
                      </div>
                    </td>
                    <td className="p-4">
                      <div className="flex items-center gap-2">
                        {getStatusIcon(commission.Status)}
                        <span className={`inline-flex items-center px-3 py-1.5 rounded-full text-sm font-semibold ${getStatusColor(commission.Status)}`}>
                          {commission.Status}
                        </span>
                      </div>
                      {commission.PayoutDate && (
                        <p className="text-xs text-gray-500 mt-1">
                          Paid: {new Date(commission.PayoutDate).toLocaleDateString()}
                        </p>
                      )}
                    </td>
                    <td className="p-4">
                      <p className="text-sm text-oe-neutral-dark">
                        {new Date(commission.SaleDate).toLocaleDateString()}
                      </p>
                      <p className="text-xs text-gray-500">
                        {new Date(commission.SaleDate).toLocaleTimeString()}
                      </p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {commissions.length === 0 && (
              <div className="p-8 text-center">
                <TrendingUp size={48} className="mx-auto mb-4 text-gray-300" />
                <h3 className="text-lg font-medium text-oe-neutral-dark mb-2">No commissions found</h3>
                <p className="text-gray-600">No commission transactions match your current filters.</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Agent Management Modal */}
      {selectedAgent && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg max-w-md w-full">
            <div className="p-6 border-b border-gray-200">
              <div className="flex justify-between items-start">
                <h2 className="text-xl font-semibold">Manage Agent</h2>
                <button
                  onClick={() => setSelectedAgent(null)}
                  className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
                >
                  ×
                </button>
              </div>
            </div>

            <div className="p-6 space-y-4">
              <div>
                <h3 className="font-semibold text-oe-neutral-dark mb-2">{selectedAgent.Name}</h3>
                <p className="text-sm text-gray-600">{selectedAgent.Email}</p>
                <p className="text-sm text-gray-600">{selectedAgent.TenantName}</p>
              </div>

              <div className="space-y-3">
                <div className="flex justify-between">
                  <span className="text-sm text-gray-600">Current Commission Rate:</span>
                  <span className="font-bold text-oe-primary">
                    {selectedAgent.DefaultCommissionRate}%
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-gray-600">Total Earned:</span>
                  <span className="font-bold text-oe-success">
                    ${selectedAgent.TotalEarned.toLocaleString()}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-gray-600">Pending Amount:</span>
                  <span className="font-bold text-oe-warning">
                    ${selectedAgent.PendingAmount.toLocaleString()}
                  </span>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Update Commission Rate
                </label>
                <div className="flex gap-2">
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="50"
                    defaultValue={selectedAgent.DefaultCommissionRate}
                    className="flex-1 form-input text-sm"
                    id="newCommissionRate"
                  />
                  <button
                    onClick={() => {
                      const input = document.getElementById('newCommissionRate') as HTMLInputElement;
                      const newRate = parseFloat(input.value);
                      if (newRate && newRate > 0 && newRate <= 50) {
                        updateCommissionRate(selectedAgent.AgentId, newRate);
                        setSelectedAgent(null);
                      } else {
                        alert('Please enter a valid commission rate between 0.1% and 50%');
                      }
                    }}
                    className="bg-oe-primary text-white px-4 py-2 rounded-md hover:bg-oe-dark text-sm"
                  >
                    Update
                  </button>
                </div>
              </div>

              <div className="pt-4 border-t border-gray-200">
                <button
                  onClick={() => setSelectedAgent(null)}
                  className="w-full bg-gray-600 text-white px-4 py-2 rounded-md hover:bg-gray-700"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
