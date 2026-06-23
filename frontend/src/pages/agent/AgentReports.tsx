// frontend/src/pages/agent/AgentReports.tsx
import {
  Activity,
  Calendar,
  CheckCircle,
  Clock,
  DollarSign,
  Download,
  Target,
  TrendingUp,
  Users
} from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { AgentService } from '../../services/agent/agent.service';

const AgentReports: React.FC = () => {
  const [activeTab, setActiveTab] = useState('pipeline');
  const [pipelineData, setPipelineData] = useState<any>(null);
  const [activityData, setActivityData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPeriod, setSelectedPeriod] = useState('month');

  useEffect(() => {
    if (activeTab === 'pipeline') {
      loadPipelineReport();
    } else {
      loadActivityReport();
    }
  }, [activeTab, selectedPeriod]);

  const loadPipelineReport = async () => {
    try {
      setLoading(true);
      const response = await AgentService.getSalesPipeline();
      if (response.success && response.data) {
        setPipelineData(response.data);
      }
    } catch (error) {
      console.error('Failed to load pipeline report:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadActivityReport = async () => {
    try {
      setLoading(true);
      const response = await AgentService.getActivityReport(selectedPeriod);
      if (response.success && response.data) {
        setActivityData(response.data);
      }
    } catch (error) {
      console.error('Failed to load activity report:', error);
    } finally {
      setLoading(false);
    }
  };

  const tabs = [
    { id: 'pipeline', name: 'Sales Pipeline', icon: Target },
    { id: 'activity', name: 'Activity Report', icon: Activity }
  ];

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded w-1/4 mb-4"></div>
          <div className="h-4 bg-gray-200 rounded w-1/2 mb-8"></div>
          <div className="h-96 bg-gray-200 rounded"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6 flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">Reports & Analytics</h1>
          <p className="text-gray-600">View your performance metrics and insights</p>
        </div>
        <div className="flex gap-2">
          <select
            value={selectedPeriod}
            onChange={(e) => setSelectedPeriod(e.target.value)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-transparent"
          >
            <option value="week">This Week</option>
            <option value="month">This Month</option>
            <option value="quarter">This Quarter</option>
            <option value="year">This Year</option>
          </select>
          <button className="bg-oe-primary text-white px-4 py-2 rounded-lg hover:bg-oe-primary-dark flex items-center">
            <Download className="h-4 w-4 mr-2" />
            Export
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-white rounded-lg border border-gray-200">
        <div className="border-b border-gray-200">
          <nav className="flex -mb-px">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`py-4 px-6 border-b-2 font-medium text-sm transition-colors duration-200 ${
                    activeTab === tab.id
                      ? 'border-oe-primary text-oe-primary'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  <Icon className="h-4 w-4 inline mr-2" />
                  {tab.name}
                </button>
              );
            })}
          </nav>
        </div>

        <div className="p-6">
          {activeTab === 'pipeline' ? (
            <PipelineReport data={pipelineData} />
          ) : (
            <ActivityReport data={activityData} />
          )}
        </div>
      </div>
    </div>
  );
};

// Pipeline Report Component
interface PipelineReportProps {
  data: any;
}

const PipelineReport: React.FC<PipelineReportProps> = ({ data }) => {
  if (!data) {
    return (
      <div className="text-center py-12">
        <Target className="h-12 w-12 text-gray-400 mx-auto mb-4" />
        <h3 className="text-lg font-medium text-gray-900 mb-2">No pipeline data available</h3>
        <p className="text-gray-600">Pipeline data will appear here once you have sales activities</p>
      </div>
    );
  }

  const stages = ['Prospect', 'Qualified', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost'];
  const totalLeads = stages.reduce((sum, stage) => sum + (data.stageBreakdown?.[stage]?.count || 0), 0);
  const totalValue = stages.reduce((sum, stage) => sum + (data.stageBreakdown?.[stage]?.value || 0), 0);

  return (
    <div className="space-y-6">
      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-gray-50 rounded-lg p-4">
          <div className="flex items-center">
            <Users className="h-5 w-5 text-oe-primary mr-2" />
            <span className="text-2xl font-semibold text-gray-900">{totalLeads}</span>
          </div>
          <p className="text-sm text-gray-600 mt-1">Total Leads</p>
        </div>
        <div className="bg-gray-50 rounded-lg p-4">
          <div className="flex items-center">
            <DollarSign className="h-5 w-5 text-green-600 mr-2" />
            <span className="text-2xl font-semibold text-gray-900">${totalValue.toLocaleString()}</span>
          </div>
          <p className="text-sm text-gray-600 mt-1">Total Value</p>
        </div>
        <div className="bg-gray-50 rounded-lg p-4">
          <div className="flex items-center">
            <TrendingUp className="h-5 w-5 text-oe-primary mr-2" />
            <span className="text-2xl font-semibold text-gray-900">
              {totalLeads > 0 ? ((data.stageBreakdown?.['Closed Won']?.count || 0) / totalLeads * 100).toFixed(1) : '0'}%
            </span>
          </div>
          <p className="text-sm text-gray-600 mt-1">Conversion Rate</p>
        </div>
      </div>

      {/* Pipeline Stages */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {stages.map((stage) => {
          const stageData = data.stageBreakdown?.[stage] || { count: 0, value: 0 };
          const percentage = totalLeads > 0 ? (stageData.count / totalLeads * 100).toFixed(1) : '0';
          
          return (
            <div key={stage} className="bg-white border border-gray-200 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-lg font-medium text-gray-900">{stage}</h3>
                <span className="text-sm text-gray-500">{percentage}%</span>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Leads:</span>
                  <span className="font-medium text-gray-900">{stageData.count}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">Value:</span>
                  <span className="font-medium text-gray-900">${stageData.value.toLocaleString()}</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div 
                    className="bg-oe-primary h-2 rounded-full transition-all duration-300" 
                    style={{ width: `${percentage}%` }}
                  ></div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Recent Activity */}
      {data.recentActivity && data.recentActivity.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Recent Pipeline Activity</h3>
          <div className="space-y-3">
            {data.recentActivity.slice(0, 5).map((activity: any, index: number) => (
              <div key={index} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-b-0">
                <div className="flex items-center">
                  <div className="w-2 h-2 bg-oe-primary rounded-full mr-3"></div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">{activity.leadName}</p>
                    <p className="text-xs text-gray-500">{activity.action}</p>
                  </div>
                </div>
                <span className="text-xs text-gray-500">
                  {new Date(activity.date).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// Activity Report Component
interface ActivityReportProps {
  data: any;
}

const ActivityReport: React.FC<ActivityReportProps> = ({ data }) => {
  if (!data) {
    return (
      <div className="text-center py-12">
        <Activity className="h-12 w-12 text-gray-400 mx-auto mb-4" />
        <h3 className="text-lg font-medium text-gray-900 mb-2">No activity data available</h3>
        <p className="text-gray-600">Activity data will appear here once you have sales activities</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Activity Summary */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-gray-50 rounded-lg p-4">
          <div className="flex items-center">
            <Calendar className="h-5 w-5 text-oe-primary mr-2" />
            <span className="text-2xl font-semibold text-gray-900">{data.totalActivities || 0}</span>
          </div>
          <p className="text-sm text-gray-600 mt-1">Total Activities</p>
        </div>
        <div className="bg-gray-50 rounded-lg p-4">
          <div className="flex items-center">
            <CheckCircle className="h-5 w-5 text-green-600 mr-2" />
            <span className="text-2xl font-semibold text-gray-900">{data.completedActivities || 0}</span>
          </div>
          <p className="text-sm text-gray-600 mt-1">Completed</p>
        </div>
        <div className="bg-gray-50 rounded-lg p-4">
          <div className="flex items-center">
            <Clock className="h-5 w-5 text-yellow-600 mr-2" />
            <span className="text-2xl font-semibold text-gray-900">{data.scheduledActivities || 0}</span>
          </div>
          <p className="text-sm text-gray-600 mt-1">Scheduled</p>
        </div>
        <div className="bg-gray-50 rounded-lg p-4">
          <div className="flex items-center">
            <TrendingUp className="h-5 w-5 text-oe-primary mr-2" />
            <span className="text-2xl font-semibold text-gray-900">
              {data.completionRate ? `${data.completionRate.toFixed(1)}%` : '0%'}
            </span>
          </div>
          <p className="text-sm text-gray-600 mt-1">Completion Rate</p>
        </div>
      </div>

      {/* Activity by Type */}
      {data.byType && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Activities by Type</h3>
          <div className="space-y-3">
            {Object.entries(data.byType).map(([type, count]: [string, any]) => (
              <div key={type} className="flex items-center justify-between">
                <div className="flex items-center">
                  <div className="w-3 h-3 bg-oe-primary rounded-full mr-3"></div>
                  <span className="text-sm font-medium text-gray-900">{type}</span>
                </div>
                <span className="text-sm text-gray-600">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Activities */}
      {data.recentActivities && data.recentActivities.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Recent Activities</h3>
          <div className="space-y-3">
            {data.recentActivities.slice(0, 10).map((activity: any, index: number) => (
              <div key={index} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-b-0">
                <div className="flex items-center">
                  <div className="w-2 h-2 bg-green-600 rounded-full mr-3"></div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">{activity.subject}</p>
                    <p className="text-xs text-gray-500">{activity.type} - {activity.contactName}</p>
                  </div>
                </div>
                <span className="text-xs text-gray-500">
                  {new Date(activity.date).toLocaleDateString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default AgentReports;

