// File: CampaignsPage.tsx
// Path: frontend/src/pages/message-center/CampaignsPage.tsx

import { Copy, Edit, GitBranch, Plus, Search, Trash2, Users } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { toast } from '../../components/common/Toast';
import { useAuth } from '../../hooks/useAuth';
import { useTenants } from '../../hooks/useTenants';
import { campaignService, type Campaign } from '../../services/messageCenter.service';
import ScopePill from '../../components/messaging/ScopePill';
import ScopeFilterDropdown, { type ScopeFilter } from '../../components/messaging/ScopeFilterDropdown';
import type { CreateForValue } from '../../components/messaging/CreateForField';
import CampaignEditorModal from './CampaignEditorModal';

const triggerTypeLabels: Record<string, string> = {
  EnrollmentCompletion: 'Enrollment Completion',
  FirstDayOfCoverage: 'First Day of Coverage',
  DependentAdded: 'Dependent Added',
  PlanTermination: 'Plan Termination'
};

const triggerTypeBadgeColors: Record<string, string> = {
  EnrollmentCompletion: 'bg-blue-100 text-blue-800',
  FirstDayOfCoverage: 'bg-green-100 text-green-800',
  DependentAdded: 'bg-purple-100 text-purple-800',
  PlanTermination: 'bg-red-100 text-red-800'
};

const CampaignsPage: React.FC = () => {
  const { user } = useAuth();
  const activeTenantId = user?.currentTenantId || user?.tenantId || '';
  const currentRole = user?.currentRole || localStorage.getItem('currentRole');
  const isSysAdmin = currentRole === 'SysAdmin';
  const { data: tenants = [] } = useTenants(isSysAdmin);

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [filteredCampaigns, setFilteredCampaigns] = useState<Campaign[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterTriggerType, setFilterTriggerType] = useState('All');
  const [filterStatus, setFilterStatus] = useState('All');
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  const [isLoading, setIsLoading] = useState(true);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editingCampaignId, setEditingCampaignId] = useState<string | null>(null);
  // SysAdmin-only "Create for" state — passed into the editor modal for new campaigns.
  const [createFor, setCreateFor] = useState<CreateForValue>({ mode: 'tenant', tenantId: '', vendorId: null });

  const loadCampaigns = useCallback(async () => {
    if (!user) return;
    setIsLoading(true);
    try {
      const params: { scope?: 'tenant' | 'vendor' } = {};
      if (isSysAdmin && scopeFilter !== 'all') {
        params.scope = scopeFilter;
      }
      const response = await campaignService.getCampaigns(params);
      if (response.success && response.data) {
        setCampaigns(response.data);
        setFilteredCampaigns(response.data);
      } else {
        setCampaigns([]);
        setFilteredCampaigns([]);
      }
    } catch (err) {
      console.error('Failed to load campaigns:', err);
      setCampaigns([]);
      setFilteredCampaigns([]);
    } finally {
      setIsLoading(false);
    }
  }, [user, activeTenantId, isSysAdmin, scopeFilter]);

  useEffect(() => {
    loadCampaigns();
  }, [loadCampaigns]);

  useEffect(() => {
    let filtered = campaigns;

    if (searchTerm) {
      filtered = filtered.filter(campaign =>
        campaign.campaignName?.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }

    if (filterTriggerType !== 'All') {
      filtered = filtered.filter(campaign => campaign.triggerType === filterTriggerType);
    }

    if (filterStatus !== 'All') {
      filtered = filtered.filter(campaign =>
        filterStatus === 'Active' ? campaign.isActive : !campaign.isActive
      );
    }

    setFilteredCampaigns(filtered);
  }, [campaigns, searchTerm, filterTriggerType, filterStatus]);

  const handleDelete = async (campaignId: string) => {
    if (!window.confirm('Are you sure you want to delete this campaign?')) return;
    try {
      const response = await campaignService.deleteCampaign(campaignId);
      if (response.success) {
        toast.success('Campaign deleted successfully');
        loadCampaigns();
      } else {
        toast.error('Failed to delete campaign');
      }
    } catch (err) {
      console.error('Failed to delete campaign:', err);
      toast.error('Failed to delete campaign');
    }
  };

  const handleDuplicate = async (campaignId: string) => {
    try {
      const response = await campaignService.duplicateCampaign(campaignId);
      if (response.success) {
        toast.success('Campaign duplicated successfully');
        loadCampaigns();
      } else {
        toast.error('Failed to duplicate campaign');
      }
    } catch (err) {
      console.error('Failed to duplicate campaign:', err);
      toast.error('Failed to duplicate campaign');
    }
  };

  const handleEdit = (campaignId: string) => {
    setEditingCampaignId(campaignId);
    // Initialize "Owned by" picker from the campaign's current scope so SysAdmin can reassign.
    const c = campaigns.find((x) => x.campaignId === campaignId);
    if (c) {
      if (c.vendorId) {
        setCreateFor({ mode: 'vendor', tenantId: '', vendorId: c.vendorId });
      } else {
        setCreateFor({ mode: 'tenant', tenantId: c.tenantId || '', vendorId: null });
      }
    }
    setIsEditorOpen(true);
  };

  const handleNewCampaign = () => {
    setEditingCampaignId(null);
    setCreateFor({ mode: 'tenant', tenantId: '', vendorId: null });
    setIsEditorOpen(true);
  };

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6 flex justify-between items-center">
        <h1 className="text-2xl font-semibold text-gray-900">Campaigns</h1>
        <button
          onClick={handleNewCampaign}
          className="flex items-center space-x-2 px-4 py-2 bg-[#1f8dbf] text-white rounded-lg hover:bg-[#175a7a]"
        >
          <Plus className="h-5 w-5" />
          <span>New Campaign</span>
        </button>
      </div>

      {/* Filter Bar */}
      <div className="mb-6 bg-white p-4 rounded-lg shadow-sm border border-gray-200">
        <div className="flex flex-wrap gap-4">
          <div className="flex-1 min-w-[200px]">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search campaigns..."
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
              />
            </div>
          </div>

          <div className="min-w-[200px]">
            <select
              value={filterTriggerType}
              onChange={(e) => setFilterTriggerType(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
            >
              <option value="All">All Trigger Types</option>
              <option value="EnrollmentCompletion">Enrollment Completion</option>
              <option value="PlanTermination">Plan Termination</option>
            </select>
          </div>

          <div className="min-w-[160px]">
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
            >
              <option value="All">All Statuses</option>
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
            </select>
          </div>

          {isSysAdmin && (
            <div className="min-w-[160px]">
              <ScopeFilterDropdown
                value={scopeFilter}
                onChange={setScopeFilter}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              />
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex justify-center items-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#1f8dbf]"></div>
        </div>
      ) : filteredCampaigns.length === 0 ? (
        <div className="text-center py-12">
          <GitBranch className="h-12 w-12 text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No campaigns found</h3>
          <p className="text-gray-500">
            {searchTerm || filterTriggerType !== 'All' || filterStatus !== 'All'
              ? 'Try adjusting your filters'
              : 'Get started by creating your first campaign'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredCampaigns.map((campaign) => (
            <div
              key={campaign.campaignId}
              className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 hover:shadow-md transition-shadow min-w-0 overflow-hidden flex flex-col"
            >
              <div className="flex justify-between items-start gap-2 mb-3 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`px-2 py-0.5 text-xs font-medium rounded-full whitespace-nowrap ${
                    triggerTypeBadgeColors[campaign.triggerType] ?? 'bg-gray-100 text-gray-700'
                  }`}>
                    {triggerTypeLabels[campaign.triggerType] ?? campaign.triggerType}
                  </span>
                </div>
                <div className="shrink-0">
                  <span className={`px-2 py-0.5 text-xs font-medium rounded-full whitespace-nowrap ${
                    campaign.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700'
                  }`}>
                    {campaign.isActive ? 'Active' : 'Inactive'}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2 mb-3 min-w-0">
                <h3 className="font-medium text-gray-900 truncate flex-1 min-w-0">{campaign.campaignName}</h3>
                <ScopePill vendorId={campaign.vendorId} />
              </div>

              <div className="flex items-center gap-4 text-sm text-gray-500 mb-3">
                <div className="flex items-center gap-1">
                  <GitBranch className="h-3.5 w-3.5 shrink-0" />
                  <span>{campaign.stepCount ?? 0} steps</span>
                </div>
                <div className="flex items-center gap-1">
                  <Users className="h-3.5 w-3.5 shrink-0" />
                  <span>{campaign.activeEnrollments ?? 0} active</span>
                </div>
              </div>

              <div className="flex items-center gap-1 pt-3 border-t border-gray-100 shrink-0 mt-auto">
                <button
                  onClick={() => handleEdit(campaign.campaignId)}
                  title="Edit"
                  className="flex-1 min-w-0 px-2 py-1.5 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded transition-colors flex items-center justify-center"
                >
                  <Edit className="h-4 w-4 shrink-0" />
                </button>
                <button
                  onClick={() => handleDuplicate(campaign.campaignId)}
                  title="Duplicate"
                  className="flex-1 min-w-0 px-2 py-1.5 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded transition-colors flex items-center justify-center"
                >
                  <Copy className="h-4 w-4 shrink-0" />
                </button>
                <button
                  onClick={() => handleDelete(campaign.campaignId)}
                  title="Delete"
                  className="flex-1 min-w-0 px-2 py-1.5 text-red-600 hover:text-red-900 hover:bg-red-100 rounded transition-colors flex items-center justify-center"
                >
                  <Trash2 className="h-4 w-4 shrink-0" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <CampaignEditorModal
        isOpen={isEditorOpen}
        onClose={() => { setIsEditorOpen(false); setEditingCampaignId(null); }}
        onSave={() => { setIsEditorOpen(false); setEditingCampaignId(null); loadCampaigns(); }}
        campaignId={editingCampaignId}
        tenantId={activeTenantId}
        isSysAdmin={isSysAdmin}
        tenants={tenants}
        createFor={createFor}
        onCreateForChange={setCreateFor}
      />
    </div>
  );
};

export default CampaignsPage;
