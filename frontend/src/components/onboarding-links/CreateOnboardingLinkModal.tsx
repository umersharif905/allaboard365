// frontend/src/components/onboarding-links/CreateOnboardingLinkModal.tsx
import { AlertCircle, X } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { apiService } from '../../services/api.service';
import { CreateOnboardingLinkRequest } from '../../services/onboardingLinks.service';
import { ApiResponse } from '../../types/index';
import SearchableDropdown from '../common/SearchableDropdown';

interface CreateOnboardingLinkModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (linkData: CreateOnboardingLinkRequest) => Promise<void>;
  currentRole?: string;
  initialData?: {
    agencyId?: string;
    agentId?: string;
  };
}


const CreateOnboardingLinkModal: React.FC<CreateOnboardingLinkModalProps> = ({
  isOpen,
  onClose,
  onCreate,
  currentRole = 'TenantAdmin',
  initialData
}) => {
  const [formData, setFormData] = useState({
    linkName: '',
    agencyId: initialData?.agencyId || '',
    agentId: initialData?.agentId || ''
  });
  
  const [agencies, setAgencies] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [agencySearch, setAgencySearch] = useState('');
  const [showAgencyDropdown, setShowAgencyDropdown] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAgents = useCallback(async (search: string = '') => {
    if (!formData.agencyId) {
      setAgents([]);
      return;
    }

    try {
      setLoadingAgents(true);
      const params = new URLSearchParams();
      params.append('agencyId', formData.agencyId);
      if (search) params.append('search', search);
      const url = `/api/me/tenant-admin/agencies/agents?${params.toString()}`;
      const agentsResponse = await apiService.get(url) as ApiResponse<any[]>;
      if (agentsResponse.success) {
        setAgents(agentsResponse.data || []);
      } else {
        setAgents([]);
      }
    } catch (err) {
      console.error('Error loading agents:', err);
      setAgents([]);
    } finally {
      setLoadingAgents(false);
    }
  }, [formData.agencyId]);

  const loadAgencies = async () => {
    try {
      // Use tenant-scoped endpoint so agency list respects current tenant / tenant switch
      const agenciesResponse = await apiService.get('/api/me/tenant-admin/agencies') as ApiResponse<any[]>;
      console.log('📋 Agencies loaded (tenant-scoped):', agenciesResponse.data);
      if (agenciesResponse.success) {
        const loadedAgencies = agenciesResponse.data || [];
        setAgencies(loadedAgencies);
        
        // If we have initialData with agencyId, set the search value and form data
        if (initialData?.agencyId) {
          const agency = loadedAgencies.find((a: any) => a.AgencyId === initialData.agencyId);
          if (agency) {
            setAgencySearch(agency.AgencyName || '');
            setFormData(prev => ({
              ...prev,
              agencyId: initialData.agencyId || prev.agencyId
            }));
          }
        }
        
        // If we have initialData with agentId, set the form data (agent search will be set after agents load)
        if (initialData?.agentId) {
          setFormData(prev => ({
            ...prev,
            agentId: initialData.agentId || prev.agentId
          }));
        }
      }
    } catch (err) {
      console.error('Error loading agencies:', err);
    }
  };

  // Load agencies when modal opens and set initial data
  useEffect(() => {
    if (isOpen) {
      loadAgencies();
    } else {
      setFormData({ linkName: '', agencyId: '', agentId: '' });
      setAgencySearch('');
      setAgents([]);
    }
  }, [isOpen]);

  // Preload agents when agency is selected (so upline dropdown has options; also for initialData.agentId)
  useEffect(() => {
    if (isOpen && formData.agencyId && currentRole === 'TenantAdmin') {
      loadAgents('');
    } else if (!formData.agencyId) {
      setAgents([]);
    }
  }, [isOpen, formData.agencyId, currentRole, loadAgents]);


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    console.log('📋 Form submission - formData:', formData);
    console.log('📋 Form submission - agencySearch:', agencySearch);
    
    if (!formData.linkName.trim()) {
      setError('Please enter a link name');
      return;
    }

    // Only validate agency/agent for TenantAdmin
    if (currentRole === 'TenantAdmin') {
      if (!formData.agencyId || !agencySearch) {
        console.log('❌ Validation failed - Agency:', { agencyId: formData.agencyId, agencySearch });
        setError('Please select an agency');
        return;
      }

      // Upline agent is optional - agents can be direct to agency
      // No validation needed for agentId
    }

    try {
      setLoading(true);
      setError(null);
      
      const linkData: CreateOnboardingLinkRequest = {
        linkName: formData.linkName
      };

      // Only include agency/agent for TenantAdmin (auto-populated on backend for Agent)
      if (currentRole === 'TenantAdmin') {
        linkData.agencyId = formData.agencyId;
        // Only include agentId if one was selected (optional - agents can be direct to agency)
        if (formData.agentId) {
          linkData.agentId = formData.agentId;
        }
      }
      
      console.log('✅ Creating link with:', linkData);
      
      await onCreate(linkData);
      
      // Reset form
      setFormData({
        linkName: '',
        agencyId: '',
        agentId: ''
      });
      setAgencySearch('');
      setAgents([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create onboarding link');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    if (!loading) {
      setFormData({
        linkName: '',
        agencyId: '',
        agentId: ''
      });
      setAgencySearch('');
      setShowAgencyDropdown(false);
      setAgents([]);
      setError(null);
      onClose();
    }
  };


  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">Create Onboarding Link</h2>
          <button
            onClick={handleClose}
            disabled={loading}
            className="text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-50"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {/* Error Message */}
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-lg flex items-center">
              <AlertCircle className="w-5 h-5 mr-2" />
              {error}
            </div>
          )}

          {/* Link Name */}
          <div>
            <label htmlFor="linkName" className="block text-sm font-medium text-gray-700 mb-1">
              Link Name *
            </label>
            <input
              type="text"
              id="linkName"
              value={formData.linkName}
              onChange={(e) => setFormData({ ...formData, linkName: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
              placeholder="e.g., Q1 2024 Agent Recruitment"
              required
              disabled={loading}
            />
            <p className="text-sm text-gray-500 mt-1">A descriptive name for this onboarding link</p>
          </div>

          {/* Agency Selection - Only for TenantAdmin */}
          {currentRole === 'TenantAdmin' && (
            <div className="relative">
              <label htmlFor="agencySearch" className="block text-sm font-medium text-gray-700 mb-1">
                Agency *
              </label>
              <input
                type="text"
                id="agencySearch"
                value={agencySearch}
                onChange={(e) => {
                  setAgencySearch(e.target.value);
                  setShowAgencyDropdown(true);
                }}
                onFocus={() => setShowAgencyDropdown(true)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
                placeholder="Search for an agency..."
                disabled={loading}
                required
                autoComplete="off"
              />
              {showAgencyDropdown && agencies.filter(a => 
                a.AgencyName?.toLowerCase().includes(agencySearch.toLowerCase())
              ).length > 0 && (
                <div className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                  {agencies
                    .filter(a => a.AgencyName?.toLowerCase().includes(agencySearch.toLowerCase()))
                    .map(agency => (
                      <div
                        key={agency.AgencyId}
                        onClick={() => {
                          setFormData((prev) => ({ ...prev, agencyId: agency.AgencyId, agentId: '' }));
                          setAgencySearch(agency.AgencyName);
                          setShowAgencyDropdown(false);
                          setAgents([]);
                        }}
                        className="px-3 py-2 hover:bg-gray-100 cursor-pointer"
                      >
                        {agency.AgencyName}
                      </div>
                    ))}
                </div>
              )}
              <p className="text-sm text-gray-500 mt-1">Select the agency for this onboarding link</p>
            </div>
          )}

          {/* Upline Agent Selection - Only for TenantAdmin */}
          {currentRole === 'TenantAdmin' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Upline Agent (Optional) {loadingAgents && <span className="text-xs text-gray-500 ml-2">(Searching…)</span>}
              </label>
              <SearchableDropdown
                options={agents.map((a: any) => {
                  const id = a.AgentId || a.UserId;
                  const label = [a.FirstName, a.LastName].filter(Boolean).join(' ') || a.Email || 'Unknown';
                  return {
                    id,
                    label,
                    value: id,
                    email: a.Email,
                    sublabel: a.AgencyName
                  };
                })}
                value={formData.agentId}
                onChange={(val) => setFormData((prev) => ({ ...prev, agentId: val }))}
                placeholder="Search for an upline agent or leave empty for direct to agency…"
                searchPlaceholder="Search agents…"
                loading={loadingAgents}
                disabled={loading || !formData.agencyId}
                useBackendSearch
                onSearch={(q) => formData.agencyId && loadAgents(q)}
                showEmail
                showSublabel
              />
              <p className="text-sm text-gray-500 mt-1">
                {!formData.agencyId
                  ? 'Please select an agency first'
                  : 'Optional: Leave empty to assign agent directly to agency, or select an upline agent'}
              </p>
            </div>
          )}

          {/* Info Box */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <div className="flex items-start">
              <div className="flex-shrink-0">
                <svg className="h-5 w-5 text-blue-400" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                </svg>
              </div>
              <div className="ml-3">
                {currentRole === 'Agent' ? (
                  <>
                    <h3 className="text-sm font-medium text-blue-800">
                      Auto-Populated Information
                    </h3>
                    <div className="mt-2 text-sm text-oe-primary-dark">
                      <p>This link will be created for your agency and assigned to you automatically.</p>
                      <p className="mt-1">After creating, you can add commission codes via the "View Details" button.</p>
                    </div>
                  </>
                ) : (
                  <>
                    <h3 className="text-sm font-medium text-blue-800">
                      Commission Codes
                    </h3>
                    <div className="mt-2 text-sm text-oe-primary-dark">
                      <p>After creating this link, you can add multiple commission codes (Apple, Peach, Lemon, etc.) and assign each to a specific commission rule.</p>
                      <p className="mt-1">Use the "View Details" button to manage commission codes for this link.</p>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>


          {/* Actions */}
          <div className="flex justify-end space-x-3 pt-6 border-t border-gray-200">
            <button
              type="button"
              onClick={handleClose}
              disabled={loading}
              className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="inline-flex items-center px-4 py-2 bg-[#1f8dbf] text-white rounded-lg hover:bg-[#1a7ba8] transition-colors disabled:opacity-50 text-sm font-medium"
            >
              {loading ? 'Creating...' : 'Create Link'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default CreateOnboardingLinkModal;
