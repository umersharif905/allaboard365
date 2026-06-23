// frontend/src/components/onboarding-links/OnboardingLinksPage.tsx
import { CheckCircle, Edit, Eye, Plus, Search, Trash2, Users, XCircle } from 'lucide-react';
import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { OnboardingLink, OnboardingLinksService } from '../../services/onboardingLinks.service';
import CreateOnboardingLinkModal from './CreateOnboardingLinkModal';
import EditOnboardingLinkModal from './EditOnboardingLinkModal';
import LinkDetailsModal from './LinkDetailsModal';
import LinkSessionsModal from './LinkSessionsModal';
import SearchableDropdown from '../common/SearchableDropdown';
import { TenantAdminService } from '../../services/tenant-admin/tenant-admin.service';

const OnboardingLinksPage: React.FC = () => {
  const { user } = useAuth();
  const currentRole = user?.currentRole || '';
  
  const [links, setLinks] = useState<OnboardingLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Filter states
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('active');
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [selectedAgencyId, setSelectedAgencyId] = useState<string>('');
  
  // Agent and Agency filter states (for TenantAdmin)
  const [agentOptions, setAgentOptions] = useState<any[]>([]);
  const [agencyOptions, setAgencyOptions] = useState<any[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [loadingAgencies, setLoadingAgencies] = useState(false);
  
  // Modal states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [showSessionsModal, setShowSessionsModal] = useState(false);
  const [selectedLink, setSelectedLink] = useState<OnboardingLink | null>(null);

  // Fetch agents for TenantAdmin filter dropdown
  const fetchAgents = useCallback(async (searchQuery: string = '') => {
    if (currentRole !== 'TenantAdmin') return;
    
    try {
      setLoadingAgents(true);
      const response = await TenantAdminService.getTenantAgents({ 
        status: 'Active', 
        type: 'Agent',
        search: searchQuery,
        limit: 50
      });
      
      if (response.success && response.data) {
        const options = response.data.map((agent: any) => ({
          id: agent.Id,
          label: agent.Name,
          value: agent.Id,
          email: agent.Email
        }));
        setAgentOptions(options);
      }
    } catch (error) {
      console.error('Error fetching agents:', error);
    } finally {
      setLoadingAgents(false);
    }
  }, [currentRole]);

  const handleAgentSearch = useCallback((query: string) => {
    fetchAgents(query);
  }, [fetchAgents]);

  // Fetch agencies for TenantAdmin filter dropdown
  const fetchAgencies = useCallback(async (searchQuery: string = '') => {
    if (currentRole !== 'TenantAdmin') return;
    
    try {
      setLoadingAgencies(true);
      const response = await TenantAdminService.getTenantAgents({ 
        status: 'Active', 
        type: 'Agency',
        search: searchQuery,
        limit: 50
      });
      
      if (response.success && response.data) {
        const options = response.data.map((agency: any) => ({
          id: agency.Id,
          label: agency.Name,
          value: agency.Id,
          email: agency.Email || ''
        }));
        setAgencyOptions(options);
      }
    } catch (error) {
      console.error('Error fetching agencies:', error);
    } finally {
      setLoadingAgencies(false);
    }
  }, [currentRole]);

  const handleAgencySearch = useCallback((query: string) => {
    fetchAgencies(query);
  }, [fetchAgencies]);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const linksResponse = await OnboardingLinksService.getOnboardingLinks(
        currentRole,
        currentRole === 'TenantAdmin' && selectedAgentId ? selectedAgentId : undefined,
        currentRole === 'TenantAdmin' && selectedAgencyId ? selectedAgencyId : undefined
      );

      if (linksResponse.success && linksResponse.data) {
        setLinks(linksResponse.data);
      } else {
        setError('Failed to load onboarding links');
      }
    } catch (err) {
      setError('An error occurred while loading data');
      console.error('Error loading onboarding links:', err);
    } finally {
      setLoading(false);
    }
  }, [currentRole, selectedAgentId, selectedAgencyId]);

  useEffect(() => {
    if (currentRole) {
      loadData();
      // Load agents and agencies for TenantAdmin
      if (currentRole === 'TenantAdmin') {
        fetchAgents();
        fetchAgencies();
      }
    }
  }, [currentRole, loadData, fetchAgents, fetchAgencies]);

  // Reload data when filters change
  useEffect(() => {
    if (currentRole) {
      loadData();
    }
  }, [selectedAgentId, selectedAgencyId]);

  // Filter links based on search term and status
  const filteredLinks = useMemo(() => {
    return links.filter(link => {
      // Search filter
      const matchesSearch = link.LinkName.toLowerCase().includes(searchTerm.toLowerCase());
      
      // Status filter (API may send BIT as boolean or 0/1; typings use boolean only)
      const activeVal = link.IsActive as boolean | number;
      let matchesStatus = true;
      if (statusFilter === 'active') {
        matchesStatus = activeVal === true || activeVal === 1;
      } else if (statusFilter === 'inactive') {
        matchesStatus = activeVal === false || activeVal === 0;
      }
      // 'all' status filter matches everything
      
      return matchesSearch && matchesStatus;
    });
  }, [links, searchTerm, statusFilter]);

  const handleCreateLink = async (linkData: any) => {
    try {
      const response = await OnboardingLinksService.createOnboardingLink(linkData, currentRole);
      if (response.success) {
        setShowCreateModal(false);
        await loadData(); // Refresh the list
      } else {
        throw new Error(response.message || 'Failed to create onboarding link');
      }
    } catch (err) {
      console.error('Error creating onboarding link:', err);
      throw err;
    }
  };

  const handleUpdateLink = async (linkId: string, linkData: any) => {
    try {
      const response = await OnboardingLinksService.updateOnboardingLink(linkId, linkData, currentRole);
      if (response.success) {
        setShowEditModal(false);
        await loadData(); // Refresh the list
      } else {
        throw new Error(response.message || 'Failed to update onboarding link');
      }
    } catch (err) {
      console.error('Error updating onboarding link:', err);
      throw err;
    }
  };

  const handleDeleteLink = async (linkId: string) => {
    if (!confirm('Are you sure you want to deactivate this onboarding link?')) {
      return;
    }

    try {
      const response = await OnboardingLinksService.deleteOnboardingLink(linkId, currentRole);
      if (response.success) {
        await loadData(); // Refresh the list
      } else {
        throw new Error(response.message || 'Failed to delete onboarding link');
      }
    } catch (err) {
      console.error('Error deleting onboarding link:', err);
      alert('Failed to delete onboarding link. Please try again.');
    }
  };

  const handleViewDetails = (link: OnboardingLink) => {
    setSelectedLink(link);
    setShowDetailsModal(true);
  };

  const handleViewSessions = (link: OnboardingLink) => {
    setSelectedLink(link);
    setShowSessionsModal(true);
  };

  const handleEditLink = (link: OnboardingLink) => {
    setSelectedLink(link);
    setShowEditModal(true);
  };

  const getStatusBadge = (link: OnboardingLink) => {
    if (link.IsActive) {
      return (
        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
          <CheckCircle className="w-3 h-3 mr-1" />
          Active
        </span>
      );
    } else {
      return (
        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800">
          <XCircle className="w-3 h-3 mr-1" />
          Inactive
        </span>
      );
    }
  };

  const getCommissionDisplay = (link: OnboardingLink) => {
    const count = link.CommissionCodeCount || 0;
    if (count === 0) {
      return 'No codes';
    } else if (count === 1) {
      return '1 code';
    } else {
      return `${count} codes`;
    }
  };

  const getRoleTitle = () => {
    switch (currentRole) {
      case 'Agent':
        return 'My Onboarding Links';
      case 'TenantAdmin':
        return 'Onboarding Links';
      default:
        return 'Onboarding Links';
    }
  };

  const getRoleDescription = () => {
    switch (currentRole) {
      case 'Agent':
        return 'Create and manage your agent recruitment links';
      case 'TenantAdmin':
        return 'Manage agent recruitment and onboarding links';
      default:
        return 'Manage agent recruitment and onboarding links';
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col h-screen bg-gray-50">
        <div className="flex-1 overflow-auto p-6">
          <div className="flex items-center justify-center h-64">
            <div className="text-gray-500">Loading onboarding links...</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <div className="flex-1 overflow-auto p-6">
        {/* Header */}
        <div className="flex justify-between items-center mb-6">
          <div>
            <p className="text-gray-600">{getRoleDescription()}</p>
          </div>
          {currentRole !== 'Agent' && (
            <button
              onClick={() => setShowCreateModal(true)}
              className="inline-flex items-center px-4 py-2 bg-[#1f8dbf] text-white rounded-lg hover:bg-[#1a7ba8] transition-colors text-sm font-medium"
            >
              <Plus className="w-4 h-4 mr-2" />
              Create Link
            </button>
          )}
        </div>

      {/* Error State */}
      {error && (
        <div className="mb-6 bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}


      {/* Filter Controls */}
      <div className="bg-white rounded-lg border border-gray-200 mb-6">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-medium text-gray-900">Onboarding Links</h2>
        </div>
        <div className="px-6 py-4">
          <div className="flex flex-col sm:flex-row gap-4">
            {/* Search Input */}
            <div className="flex-1">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
                <input
                  type="text"
                  placeholder="Search by link name..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                />
              </div>
            </div>
            
            {/* Agent Filter - Only for TenantAdmin */}
            {currentRole === 'TenantAdmin' && (
              <div className="sm:w-64">
                <SearchableDropdown
                  options={agentOptions}
                  value={selectedAgentId}
                  onChange={(value) => {
                    setSelectedAgentId(value);
                    setSelectedAgencyId(''); // Clear agency filter when agent is selected
                  }}
                  placeholder="Filter by agent..."
                  searchPlaceholder="Search agents by name or email..."
                  loading={loadingAgents}
                  showEmail={true}
                  multiLine={true}
                  className="w-full"
                  onSearch={handleAgentSearch}
                  useBackendSearch={true}
                />
              </div>
            )}
            
            {/* Agency Filter - Only for TenantAdmin */}
            {currentRole === 'TenantAdmin' && (
              <div className="sm:w-64">
                <SearchableDropdown
                  options={agencyOptions}
                  value={selectedAgencyId}
                  onChange={(value) => {
                    setSelectedAgencyId(value);
                    setSelectedAgentId(''); // Clear agent filter when agency is selected
                  }}
                  placeholder="Filter by agency..."
                  searchPlaceholder="Search agencies by name..."
                  loading={loadingAgencies}
                  showEmail={false}
                  multiLine={true}
                  className="w-full"
                  onSearch={handleAgencySearch}
                  useBackendSearch={true}
                />
              </div>
            )}
            
            {/* Status Filter */}
            <div className="sm:w-48">
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as 'all' | 'active' | 'inactive')}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              >
                <option value="active">Active Links</option>
                <option value="inactive">Inactive Links</option>
                <option value="all">All Links</option>
              </select>
            </div>
          </div>
          
          {/* Results Count */}
          <div className="mt-3 text-sm text-gray-600">
            Showing {filteredLinks.length} of {links.length} links
            {currentRole === 'TenantAdmin' && (selectedAgentId || selectedAgencyId) && (
              <span className="ml-2">
                (filtered by {selectedAgentId ? 'agent' : 'agency'})
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Links Table */}
      <div className="bg-white rounded-lg border border-gray-200">

        {filteredLinks.length === 0 ? (
          <div className="p-6 text-center">
            <Users className="w-12 h-12 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              {links.length === 0 ? 'No onboarding links yet' : 'No links match your filters'}
            </h3>
            <p className="text-gray-600 mb-4">
              {links.length === 0 
                ? (currentRole === 'Agent' 
                    ? 'Your tenant must setup onboarding link(s) for you.'
                    : 'Create your first onboarding link to start recruiting agents.')
                : 'Try adjusting your search term or status filter.'
              }
            </p>
            {links.length === 0 && currentRole !== 'Agent' && (
              <button
                onClick={() => setShowCreateModal(true)}
                className="inline-flex items-center px-4 py-2 bg-[#1f8dbf] text-white rounded-lg hover:bg-[#1a7ba8] transition-colors text-sm font-medium"
              >
                <Plus className="w-4 h-4 mr-2" />
                Create Your First Link
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Link Details
                  </th>
                  {currentRole === 'TenantAdmin' && (
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Agency/Agent
                    </th>
                  )}
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Usage Stats
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
                {filteredLinks.map((link) => (
                  <tr key={link.LinkId} className="hover:bg-gray-50">
                    <td className="px-6 py-4">
                      <div>
                        <div className="text-sm font-medium text-gray-900">{link.LinkName}</div>
                        <div className="text-sm text-gray-500">{getCommissionDisplay(link)}</div>
                      </div>
                    </td>
                    {currentRole === 'TenantAdmin' && (
                      <td className="px-6 py-4">
                        <div className="space-y-0.5">
                          {link.AgencyName && (
                            <div className="text-sm font-semibold text-gray-900">{link.AgencyName}</div>
                          )}
                          {link.AgentName && (
                            <div className="text-sm font-normal text-gray-600">{link.AgentName}</div>
                          )}
                          {!link.AgencyName && !link.AgentName && (
                            <div className="text-sm text-gray-400">—</div>
                          )}
                        </div>
                      </td>
                    )}
                    <td className="px-6 py-4">
                      <div className="text-sm text-gray-900">
                        {link.TotalSessions || 0} clicks, {link.CompletedSessions || 0} completions
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      {getStatusBadge(link)}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center space-x-2">
                        <button
                          onClick={() => handleViewDetails(link)}
                          className="text-gray-400 hover:text-gray-600 transition-colors"
                          title="View Details"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleViewSessions(link)}
                          className="text-gray-400 hover:text-gray-600 transition-colors"
                          title="View Sessions"
                        >
                          <Users className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleEditLink(link)}
                          className="text-gray-400 hover:text-gray-600 transition-colors"
                          title="Edit Link"
                        >
                          <Edit className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDeleteLink(link.LinkId)}
                          className="text-gray-400 hover:text-red-600 transition-colors"
                          title="Delete Link"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        </div>

      {/* Modals */}
      {showCreateModal && (
        <CreateOnboardingLinkModal
          isOpen={showCreateModal}
          onClose={() => setShowCreateModal(false)}
          onCreate={handleCreateLink}
          currentRole={currentRole}
        />
      )}

      {showEditModal && selectedLink && (
        <EditOnboardingLinkModal
          isOpen={showEditModal}
          onClose={() => setShowEditModal(false)}
          onUpdate={handleUpdateLink}
          link={selectedLink}
        />
      )}

      {showDetailsModal && selectedLink && (
        <LinkDetailsModal
          isOpen={showDetailsModal}
          onClose={() => {
            setShowDetailsModal(false);
            loadData(); // Refresh the list to show updated status
          }}
          link={selectedLink}
          currentRole={currentRole}
        />
      )}

      {showSessionsModal && selectedLink && (
        <LinkSessionsModal
          isOpen={showSessionsModal}
          onClose={() => setShowSessionsModal(false)}
          link={selectedLink}
          currentRole={currentRole}
        />
      )}
      </div>
    </div>
  );
};

export default OnboardingLinksPage;


