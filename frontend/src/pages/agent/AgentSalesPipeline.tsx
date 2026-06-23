// frontend/src/pages/agent/AgentSalesPipeline.tsx
import {
    AlertCircle,
    Building2,
    CheckCircle,
    DollarSign,
    Edit,
    Mail,
    Phone,
    Plus,
    TrendingUp,
    User
} from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { AgentService } from '../../services/agent/agent.service';

// Types
interface PipelineLead {
  id: string;
  name: string;
  company: string;
  email: string;
  phone: string;
  stage: 'Prospect' | 'Qualified' | 'Proposal' | 'Negotiation' | 'Closed Won' | 'Closed Lost';
  value: number;
  probability: number;
  lastContact: string;
  nextFollowUp: string;
  notes: string;
  assignedAgent: string;
}

interface PipelineStats {
  totalLeads: number;
  totalValue: number;
  weightedValue: number;
  conversionRate: number;
  averageDealSize: number;
  stageBreakdown: {
    [key: string]: { count: number; value: number };
  };
}

export const AgentSalesPipeline: React.FC = () => {
  // State
  const [leads, setLeads] = useState<PipelineLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<PipelineStats>({
    totalLeads: 0,
    totalValue: 0,
    weightedValue: 0,
    conversionRate: 0,
    averageDealSize: 0,
    stageBreakdown: {},
  });

  // Dialog states
  const [addLeadDialogOpen, setAddLeadDialogOpen] = useState(false);
  const [editLeadDialogOpen, setEditLeadDialogOpen] = useState(false);
  const [selectedLead, setSelectedLead] = useState<PipelineLead | null>(null);

  // Calculate pipeline stats
  const calculateStats = (leadsData: PipelineLead[]): PipelineStats => {
    const totalLeads = leadsData.length;
    const totalValue = leadsData.reduce((sum, lead) => sum + lead.value, 0);
    const weightedValue = leadsData.reduce((sum, lead) => sum + (lead.value * lead.probability / 100), 0);
    const closedWon = leadsData.filter(lead => lead.stage === 'Closed Won').length;
    const conversionRate = totalLeads > 0 ? (closedWon / totalLeads) * 100 : 0;
    const averageDealSize = totalLeads > 0 ? totalValue / totalLeads : 0;

    const stageBreakdown = leadsData.reduce((acc, lead) => {
      if (!acc[lead.stage]) {
        acc[lead.stage] = { count: 0, value: 0 };
      }
      acc[lead.stage].count++;
      acc[lead.stage].value += lead.value;
      return acc;
    }, {} as { [key: string]: { count: number; value: number } });

    return {
      totalLeads,
      totalValue,
      weightedValue,
      conversionRate,
      averageDealSize,
      stageBreakdown,
    };
  };

  // Fetch pipeline data
  const fetchPipelineData = async () => {
    try {
      setLoading(true);
      const response = await AgentService.getSalesPipeline();
      
      if (response.success && response.data) {
        setLeads(response.data.leads || []);
        setStats(calculateStats(response.data.leads || []));
      } else {
        console.error('Failed to fetch pipeline data:', response.message);
      }
    } catch (error) {
      console.error('Error fetching pipeline data:', error);
    } finally {
      setLoading(false);
    }
  };

  const getStageColor = (stage: string) => {
    switch (stage) {
      case 'Prospect':
        return 'bg-gray-100 text-gray-800';
      case 'Qualified':
        return 'bg-blue-100 text-blue-800';
      case 'Proposal':
        return 'bg-yellow-100 text-yellow-800';
      case 'Negotiation':
        return 'bg-purple-100 text-purple-800';
      case 'Closed Won':
        return 'bg-green-100 text-green-800';
      case 'Closed Lost':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getStageIcon = (stage: string) => {
    switch (stage) {
      case 'Prospect':
        return <User className="h-4 w-4" />;
      case 'Qualified':
        return <CheckCircle className="h-4 w-4" />;
      case 'Proposal':
        return <Building2 className="h-4 w-4" />;
      case 'Negotiation':
        return <TrendingUp className="h-4 w-4" />;
      case 'Closed Won':
        return <CheckCircle className="h-4 w-4" />;
      case 'Closed Lost':
        return <AlertCircle className="h-4 w-4" />;
      default:
        return <User className="h-4 w-4" />;
    }
  };

  const handleAddLead = () => {
    setAddLeadDialogOpen(true);
  };

  const handleEditLead = (lead: PipelineLead) => {
    setSelectedLead(lead);
    setEditLeadDialogOpen(true);
  };

  useEffect(() => {
    const initializePage = async () => {
      await fetchPipelineData();
    };

    initializePage();
  }, []);

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded w-1/4 mb-4"></div>
          <div className="h-4 bg-gray-200 rounded w-1/2 mb-8"></div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-24 bg-gray-200 rounded"></div>
            ))}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-96 bg-gray-200 rounded"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6 flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">Sales Pipeline</h1>
          <p className="text-gray-600">Track and manage your sales opportunities</p>
        </div>
        <button
          onClick={handleAddLead}
          className="bg-oe-primary text-white px-4 py-2 rounded-lg hover:bg-oe-primary-dark flex items-center"
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Lead
        </button>
      </div>

      {/* Pipeline Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex items-center">
            <User className="h-5 w-5 text-oe-primary mr-2" />
            <span className="text-2xl font-semibold text-gray-900">{stats.totalLeads}</span>
          </div>
          <p className="text-sm text-gray-600 mt-1">Total Leads</p>
        </div>
        
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex items-center">
            <DollarSign className="h-5 w-5 text-green-600 mr-2" />
            <span className="text-2xl font-semibold text-gray-900">
              ${stats.totalValue.toLocaleString()}
            </span>
          </div>
          <p className="text-sm text-gray-600 mt-1">Total Value</p>
        </div>
        
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex items-center">
            <TrendingUp className="h-5 w-5 text-oe-primary mr-2" />
            <span className="text-2xl font-semibold text-gray-900">
              ${stats.weightedValue.toLocaleString()}
            </span>
          </div>
          <p className="text-sm text-gray-600 mt-1">Weighted Value</p>
        </div>
        
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex items-center">
            <CheckCircle className="h-5 w-5 text-green-600 mr-2" />
            <span className="text-2xl font-semibold text-gray-900">{stats.conversionRate.toFixed(1)}%</span>
          </div>
          <p className="text-sm text-gray-600 mt-1">Conversion Rate</p>
        </div>
        
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex items-center">
            <Building2 className="h-5 w-5 text-orange-600 mr-2" />
            <span className="text-2xl font-semibold text-gray-900">
              ${stats.averageDealSize.toLocaleString()}
            </span>
          </div>
          <p className="text-sm text-gray-600 mt-1">Avg Deal Size</p>
        </div>
      </div>

      {/* Pipeline Stages */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {['Prospect', 'Qualified', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost'].map((stage) => (
          <div key={stage} className="bg-white rounded-lg border border-gray-200">
            <div className="p-4 border-b border-gray-200">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center">
                  {getStageIcon(stage)}
                  <h3 className="text-lg font-medium text-gray-900 ml-2">{stage}</h3>
                </div>
                <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getStageColor(stage)}`}>
                  {stats.stageBreakdown[stage]?.count || 0}
                </span>
              </div>
              <p className="text-sm text-gray-600">
                ${stats.stageBreakdown[stage]?.value.toLocaleString() || '0'}
              </p>
            </div>
            <div className="p-4">
              {leads
                .filter(lead => lead.stage === stage)
                .map((lead) => (
                  <div key={lead.id} className="mb-3 p-3 border border-gray-200 rounded-lg hover:bg-gray-50">
                    <div className="flex justify-between items-start mb-2">
                      <div>
                        <h4 className="text-sm font-medium text-gray-900">{lead.name}</h4>
                        <p className="text-xs text-gray-500">{lead.company}</p>
                      </div>
                      <span className="text-sm font-medium text-green-600">
                        ${lead.value.toLocaleString()}
                      </span>
                    </div>
                    <div className="flex gap-2 mb-2">
                      <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-blue-100 text-blue-800">
                        {lead.probability}%
                      </span>
                      <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-gray-100 text-gray-800">
                        {new Date(lead.nextFollowUp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </span>
                    </div>
                    <div className="flex gap-1">
                      <button
                        onClick={() => handleEditLead(lead)}
                        className="p-1 text-gray-400 hover:text-gray-600"
                      >
                        <Edit className="h-3 w-3" />
                      </button>
                      <button className="p-1 text-gray-400 hover:text-gray-600">
                        <Phone className="h-3 w-3" />
                      </button>
                      <button className="p-1 text-gray-400 hover:text-gray-600">
                        <Mail className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default AgentSalesPipeline;
