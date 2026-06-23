// frontend/src/components/enrollment-wizard/steps/BasicInfoStep.tsx
import { Building, Building2, ChevronDown, Search, User, Users, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import SearchableDropdown from '../../common/SearchableDropdown';
import { useDownlineAgentsForFilter } from '../../../hooks/useDownlineAgentsForFilter';
import {
    useAgentsForDropdown,
    useTenantsForDropdown
} from '../../../hooks/useEnrollmentLinkTemplates';
import { useGroups } from '../../../hooks/useGroups';
import { WizardStepProps } from '../types/wizard.types';

const BasicInfoStep: React.FC<WizardStepProps> = ({
  data,
  onDataChange,
  isValid,
  editingAgentName,
  staticLinkMode = false,
  marketingLinkMode = false
}) => {
  const { user } = useAuth();
  const [tenantQuery, setTenantQuery] = useState('');
  const [agentQuery, setAgentQuery] = useState(editingAgentName || ''); // Initialize with editing name if provided
  const [agentSearchQuery, setAgentSearchQuery] = useState(''); // For backend search
  const [showTenantDropdown, setShowTenantDropdown] = useState(false);
  const [showAgentDropdown, setShowAgentDropdown] = useState(false);
  const [groupQuery, setGroupQuery] = useState('');
  const [showGroupDropdown, setShowGroupDropdown] = useState(false);
  
  // Refs for dropdown positioning
  const tenantDropdownRef = useRef<HTMLDivElement>(null);
  const agentDropdownRef = useRef<HTMLDivElement>(null);
  const groupDropdownRef = useRef<HTMLDivElement>(null);
  
  // Dropdown data with loading states
  const { data: tenants = [], isLoading: isLoadingTenants, isError: isTenantsError } = useTenantsForDropdown();
  const { data: agents = [], isLoading: isLoadingAgents, isError: isAgentsError } = useAgentsForDropdown(data.tenantId, agentSearchQuery);
  const { data: groupsData, isLoading: isLoadingGroups } = useGroups();
  const { data: downlineAgentOptions = [], isLoading: isLoadingDownlineAgents } = useDownlineAgentsForFilter();
  
  // Initialize query state with existing values when editing
  useEffect(() => {
    if (data.tenantId && tenants.length > 0) {
      const tenant = tenants.find(t => t.TenantId === data.tenantId);
      if (tenant) {
        setTenantQuery(tenant.TenantName || '');
      }
    }
  }, [data.tenantId, tenants]);
  
  // Update agent/agency name and agencyHasNoAgent when agents are loaded (for when user changes selection or when editing)
  useEffect(() => {
    if (data.agentId && agents.length > 0 && !editingAgentName) {
      const agent = agents.find(a => a.AgentId === data.agentId);
      if (agent) {
        const displayName = agent.Type === 'Agency'
          ? agent.AgentName  // For agencies, AgentName is actually the agency name
          : agent.AgencyName 
            ? `${agent.AgentName} (${agent.AgencyName})` 
            : agent.AgentName || agent.Email || '';
        setAgentQuery(displayName);
        // Sync agencyHasNoAgent for marketing/static link validation (agency with no admin agent)
        const adminIds = (agent as { AgencyAdminAgentIds?: string[] }).AgencyAdminAgentIds;
        const noAgent =
          agent.Type === 'Agency' &&
          !(adminIds && adminIds.length > 0) &&
          !(agent as { OwnerAgentId?: string | null }).OwnerAgentId;
        if (data.agencyHasNoAgent !== noAgent) {
          onDataChange({ agencyHasNoAgent: noAgent });
        }
      }
    }
  }, [data.agentId, data.agencyHasNoAgent, agents, editingAgentName, onDataChange]);

  // Auto-select agent for Agent role when using Tenant/Agent dropdown (AgencyOwner only)
  useEffect(() => {
    const isAgencyOwner = user?.currentRole === 'Agent' && (user?.roles as string[] | undefined)?.includes('AgencyOwner');
    if (user?.currentRole === 'Agent' && isAgencyOwner && agents.length > 0 && !data.agentId) {
      const currentAgent = agents.find((a: any) => a.Email === user?.email);
      if (currentAgent) {
        onDataChange({
          agentId: currentAgent.AgentId,
          touched: { ...data.touched, agentId: true }
        });
        const displayName = currentAgent.AgencyName
          ? `${currentAgent.AgentName} (${currentAgent.AgencyName})`
          : currentAgent.AgentName || currentAgent.Email || '';
        setAgentQuery(displayName);
      }
    }
  }, [user?.currentRole, user?.email, user?.roles, agents, data.agentId, onDataChange, data.touched]);

  // Debounce agent search for backend
  useEffect(() => {
    const timer = setTimeout(() => {
      // Only trigger backend search if query is at least 2 characters or empty (for initial load)
      if (agentQuery.length === 0 || agentQuery.length >= 2) {
        setAgentSearchQuery(agentQuery);
      }
    }, 300); // 300ms debounce

    return () => clearTimeout(timer);
  }, [agentQuery]);
  
  const filteredTenants = tenants.filter((t: any) => {
    const q = tenantQuery.toLowerCase();
    return (t.TenantName || '').toLowerCase().includes(q) || (t.TenantId || '').toLowerCase().includes(q);
  });
  
  // For frontend, we don't need additional filtering since backend handles search
  // Just display all returned agents
  const filteredAgents = agents;
  
  // For Agent role, find current agent info to display
  const currentAgent = user?.currentRole === 'Agent' ? agents.find(a => a.Email === user?.email) : null;

  // Initialize group query state with existing values when editing
  useEffect(() => {
    if (data.groupId && groupsData?.success && groupsData.data) {
      const groups = Array.isArray(groupsData.data) ? groupsData.data : [];
      const group = groups.find((g: any) => g.GroupId === data.groupId);
      if (group) {
        setGroupQuery(group.Name || '');
      }
    }
  }, [data.groupId, groupsData]);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (tenantDropdownRef.current && !tenantDropdownRef.current.contains(event.target as Node)) {
        setShowTenantDropdown(false);
      }
      if (agentDropdownRef.current && !agentDropdownRef.current.contains(event.target as Node)) {
        setShowAgentDropdown(false);
      }
      if (groupDropdownRef.current && !groupDropdownRef.current.contains(event.target as Node)) {
        setShowGroupDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleInputChange = (field: keyof typeof data, value: any) => {
    onDataChange({ [field]: value });
  };

  const handleFieldTouch = (field: 'templateName' | 'templateType' | 'tenantId' | 'agentId' | 'groupId') => {
    onDataChange({ 
      touched: { 
        ...data.touched, 
        [field]: true 
      } 
    });
  };

  // Handle tenant selection (for SysAdmin)
  const handleTenantChange = (tenantId: string, tenantName: string) => {
    console.log('🔍 BasicInfoStep - Setting tenant:', { tenantId, tenantName });
    onDataChange({ 
      tenantId,
      agentId: '', // Reset agent selection when tenant changes
      agencyHasNoAgent: false,
      touched: {
        ...data.touched,
        tenantId: true
      }
    });
    setTenantQuery(tenantName);
    setShowTenantDropdown(false);
  };

  // Handle group selection
  const handleGroupChange = (groupId: string, groupName: string) => {
    onDataChange({ 
      groupId,
      touched: {
        ...data.touched,
        groupId: true
      }
    });
    setGroupQuery(groupName);
    setShowGroupDropdown(false);
  };

  const clearGroup = () => {
    onDataChange({ 
      groupId: '',
      touched: {
        ...data.touched,
        groupId: true
      }
    });
    setGroupQuery('');
  };

  // Handle agent selection (option may include AgencyAdminAgentIds / OwnerAgentId for agency validation)
  const handleAgentChange = (agentId: string, agentName: string, agencyName?: string, option?: { Type?: string; OwnerAgentId?: string | null; AgencyAdminAgentIds?: string[] }) => {
    const hasAdmin =
      (option?.AgencyAdminAgentIds && option.AgencyAdminAgentIds.length > 0) || !!option?.OwnerAgentId;
    const agencyHasNoAgent = option?.Type === 'Agency' && !hasAdmin;
    onDataChange({ 
      agentId,
      agencyHasNoAgent: !!agencyHasNoAgent,
      touched: {
        ...data.touched,
        agentId: true
      }
    });
    const displayName = agencyName ? `${agentName} (${agencyName})` : agentName;
    setAgentQuery(displayName);
    setShowAgentDropdown(false);
  };

  // Clear tenant selection
  const clearTenant = () => {
    onDataChange({ 
      tenantId: '',
      agentId: '', // Reset agent selection when tenant changes
      touched: {
        ...data.touched,
        tenantId: true
      }
    });
    setTenantQuery('');
    setShowTenantDropdown(false);
  };

  // Clear agent selection
  const clearAgent = () => {
    onDataChange({ 
      agentId: '',
      agencyHasNoAgent: false,
      touched: {
        ...data.touched,
        agentId: true
      }
    });
    setAgentQuery('');
    setShowAgentDropdown(false);
  };

  const isSysAdmin = user?.currentRole === 'SysAdmin';
  const isTenantAdmin = user?.currentRole === 'TenantAdmin';
  const isAgent = user?.currentRole === 'Agent';
  const isAgencyOwner = isAgent && (user?.roles as string[] | undefined)?.includes('AgencyOwner');
  const showAgentDropdownSection = isSysAdmin || isTenantAdmin || isAgencyOwner;
  const agentDropdownDisabled = (isSysAdmin && !data.tenantId) || (isAgent && !isAgencyOwner);

  return (
    <div>
      <h3 className="text-lg font-medium text-gray-900 mb-1">Basic Information</h3>
      <p className="text-sm text-gray-600 mb-3">Provide basic details about your enrollment link template. Start by giving it a descriptive name.</p>

      {!isValid && (
        <div className="mb-4 bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-sm font-medium text-red-800 mb-1">Please complete the following:</p>
          <ul className="list-disc list-inside text-sm text-red-700">
            {!data.templateName.trim() && (
              <li>Link name is required</li>
            )}
            {isSysAdmin && !data.tenantId && (
              <li>Please select a tenant</li>
            )}
            {(isSysAdmin || isTenantAdmin || isAgencyOwner) && !data.agentId && (
              <li>Agent or agency selection is required</li>
            )}
            {!marketingLinkMode && data.templateType === 'Group' && !data.groupId && (
              <li>Group is required for Group enrollment templates</li>
            )}
            {(marketingLinkMode || staticLinkMode) && data.agencyHasNoAgent && (
              <li>There is no Agent Assigned to the selected agency. Add an agent to that agency or select a different agency.</li>
            )}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Link Name</label>
          <input
            type="text"
            value={data.templateName}
            onChange={(e) => handleInputChange('templateName', e.target.value)}
            onBlur={() => handleFieldTouch('templateName')}
            placeholder="Enter a descriptive name for your enrollment link"
            className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-oe-primary ${data.touched?.templateName && data.templateName.length === 0 ? 'border-red-300' : 'border-gray-300'}`}
          />
          {data.touched?.templateName && data.templateName.length === 0 && (
            <p className="text-xs text-red-600 mt-1">Link name is required</p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Link Type</label>
          <select
            value={data.templateType}
            onChange={(e) => {
              const newType = e.target.value as 'Individual' | 'Group';

              // When template type changes, filter out products that are not compatible with the new type
              // This ensures products selected for one type don't show when switching to another
              const filteredProducts = data.products.map(productSection => {
                // Keep the section structure but clear selected products
                // The ProductSectionCard will re-filter based on the new templateType
                return {
                  ...productSection,
                  specificProducts: [], // Clear selected products - they will be re-filtered based on new template type
                  specificBundles: [] // Clear selected bundles too
                };
              });

              // Clear groupId when switching to Individual, clear it when switching to Group (user must select)
              onDataChange({
                templateType: newType,
                groupId: newType === 'Individual' ? '' : data.groupId, // Clear if Individual, keep if Group (user will select)
                products: filteredProducts, // Update products with cleared selections
                touched: {
                  ...data.touched,
                  templateType: true,
                  groupId: newType === 'Group' ? false : data.touched?.groupId // Reset touched if switching to Group
                }
              });
            }}
            disabled={staticLinkMode || data.templateType === 'Group'}
            className={`w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary ${staticLinkMode || data.templateType === 'Group' ? 'bg-gray-50 cursor-not-allowed' : ''}`}
          >
            <option value="Individual">Individual Enrollment</option>
            {/* Group enrollment links are auto-managed via GroupProductsTab — only show for existing group templates */}
            {data.templateType === 'Group' && (
              <option value="Group">Group Enrollment</option>
            )}
          </select>
          <p className="text-xs text-gray-500 mt-1">
            {staticLinkMode
              ? 'Static links are only available for Individual enrollment'
              : data.templateType === 'Group'
              ? 'Group enrollment links are auto-managed. Products are driven by the group\'s assigned products.'
              : 'Individual for single person enrollment'}
          </p>
        </div>

        {data.templateType === 'Group' && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1 inline-flex items-center">
              <Users className="h-4 w-4 mr-1" /> Group {!marketingLinkMode && <span className="text-red-500 ml-1">*</span>}
            </label>
            {isLoadingGroups ? (
              <div className="flex items-center p-2 border border-gray-200 rounded-lg">
                <div className="h-4 w-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin mr-2" />
                <span className="text-sm text-gray-600">Loading groups...</span>
              </div>
            ) : (
              <div className="relative" ref={groupDropdownRef}>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <input
                    type="text"
                    value={groupQuery}
                    onChange={(e) => {
                      setGroupQuery(e.target.value);
                      setShowGroupDropdown(true);
                    }}
                    onFocus={() => setShowGroupDropdown(true)}
                    placeholder={marketingLinkMode ? 'Optional: select a specific group' : 'Search groups...'}
                    className={`w-full pl-9 pr-10 py-2 border rounded-lg focus:ring-2 focus:ring-oe-primary ${!marketingLinkMode && data.touched?.groupId && !data.groupId ? 'border-red-300' : 'border-gray-300'}`}
                  />
                  {data.groupId && (
                    <button
                      onClick={clearGroup}
                      className="absolute right-8 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    onClick={() => setShowGroupDropdown(!showGroupDropdown)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
                  >
                    <ChevronDown className={`h-4 w-4 transition-transform ${showGroupDropdown ? 'rotate-180' : ''}`} />
                  </button>
                </div>
                
                {/* Dropdown */}
                {showGroupDropdown && (
                  <div className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-auto">
                    {(() => {
                      const groups = groupsData?.success && groupsData.data ? (Array.isArray(groupsData.data) ? groupsData.data : []) : [];
                      const filteredGroups = groups.filter((g: any) => {
                        const q = groupQuery.toLowerCase();
                        const name = (g.Name || g.GroupName || '').toLowerCase();
                        return name.includes(q);
                      });
                      
                      return filteredGroups.length === 0 ? (
                        <div className="px-3 py-2 text-sm text-gray-500">No groups found</div>
                      ) : (
                        filteredGroups.map((group: any) => (
                          <button
                            key={group.GroupId}
                            onClick={() => handleGroupChange(group.GroupId, group.Name || group.GroupName || '')}
                            className="w-full text-left px-3 py-2 hover:bg-gray-100 focus:bg-gray-100 focus:outline-none"
                          >
                            <div className="font-medium text-gray-900">{group.Name || group.GroupName}</div>
                          </button>
                        ))
                      );
                    })()}
                  </div>
                )}
              </div>
            )}
            {!marketingLinkMode && data.touched?.groupId && !data.groupId && (
              <p className="text-xs text-red-600 mt-1">Group is required for Group enrollment templates</p>
            )}
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
          <textarea
            value={data.description}
            onChange={(e) => handleInputChange('description', e.target.value)}
            placeholder="Optional description for this template"
            rows={3}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
          />
        </div>

        {isSysAdmin && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1 inline-flex items-center">
              <Building2 className="h-4 w-4 mr-1" /> Tenant
            </label>
            {isLoadingTenants ? (
              <div className="flex items-center p-2 border border-gray-200 rounded-lg">
                <div className="h-4 w-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin mr-2" />
                <span className="text-sm text-gray-600">Loading tenants...</span>
              </div>
            ) : isTenantsError ? (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">Error loading tenants</div>
            ) : (
              <div className="relative" ref={tenantDropdownRef}>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <input
                    type="text"
                    value={tenantQuery}
                    onChange={(e) => {
                      setTenantQuery(e.target.value);
                      setShowTenantDropdown(true);
                    }}
                    onFocus={() => setShowTenantDropdown(true)}
                    placeholder="Search tenants..."
                    className={`w-full pl-9 pr-10 py-2 border rounded-lg focus:ring-2 focus:ring-oe-primary ${data.touched?.tenantId && !data.tenantId ? 'border-red-300' : 'border-gray-300'}`}
                  />
                  {data.tenantId && (
                    <button
                      onClick={clearTenant}
                      className="absolute right-8 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    onClick={() => setShowTenantDropdown(!showTenantDropdown)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
                  >
                    <ChevronDown className={`h-4 w-4 transition-transform ${showTenantDropdown ? 'rotate-180' : ''}`} />
                  </button>
                </div>
                
                {/* Dropdown */}
                {showTenantDropdown && (
                  <div className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-auto">
                    {filteredTenants.length === 0 ? (
                      <div className="px-3 py-2 text-sm text-gray-500">No tenants found</div>
                    ) : (
                      filteredTenants.map((tenant: any) => (
                        <button
                          key={tenant.TenantId}
                          onClick={() => handleTenantChange(tenant.TenantId, tenant.TenantName)}
                          className="w-full text-left px-3 py-2 hover:bg-gray-100 focus:bg-gray-100 focus:outline-none"
                        >
                          <div className="font-medium text-gray-900">{tenant.TenantName}</div>
                          <div className="text-xs text-gray-500">ID: {tenant.TenantId}</div>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {showAgentDropdownSection && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1 inline-flex items-center">
              <User className="h-4 w-4 mr-1" /> Agent or Agency <span className="text-red-500 ml-1">*</span>
            </label>
            {isSysAdmin && !data.tenantId ? (
              <div className="p-2 border border-gray-200 rounded-lg bg-gray-50 text-sm text-gray-600">Please select a tenant first</div>
            ) : isAgentsError ? (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">Error loading agents</div>
            ) : (
              <div className="relative" ref={agentDropdownRef}>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <input
                    type="text"
                    value={agentQuery}
                    onChange={(e) => {
                      setAgentQuery(e.target.value);
                      setShowAgentDropdown(true);
                    }}
                    onFocus={() => setShowAgentDropdown(true)}
                    onBlur={() => handleFieldTouch('agentId')}
                    placeholder="Search agents or agencies..."
                    disabled={agentDropdownDisabled}
                    readOnly={isAgent && !isAgencyOwner}
                    className={`w-full pl-9 pr-10 py-2 border rounded-lg focus:ring-2 focus:ring-oe-primary ${agentDropdownDisabled ? 'bg-gray-50 cursor-not-allowed' : ''} ${data.touched?.agentId && !data.agentId ? 'border-red-300' : 'border-gray-300'}`}
                  />
                  {isLoadingAgents && (
                    <div className="absolute right-12 top-1/2 -translate-y-1/2">
                      <div className="h-4 w-4 border-2 border-oe-primary border-t-transparent rounded-full animate-spin" />
                    </div>
                  )}
                  {data.agentId && !isAgent && (
                    <button
                      onClick={clearAgent}
                      className="absolute right-8 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600 disabled:opacity-50"
                      disabled={agentDropdownDisabled}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                  {!isAgent && (
                    <button
                      onClick={() => setShowAgentDropdown(!showAgentDropdown)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600 disabled:opacity-50"
                      disabled={agentDropdownDisabled}
                    >
                      <ChevronDown className={`h-4 w-4 transition-transform ${showAgentDropdown ? 'rotate-180' : ''}`} />
                    </button>
                  )}
                </div>
                
                {/* Dropdown */}
                {showAgentDropdown && !agentDropdownDisabled && (
                  <div className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-auto">
                    {filteredAgents.length === 0 && !isLoadingAgents ? (
                      <div className="px-3 py-2 text-sm text-gray-500">
                        {agentQuery.length > 0 && agentQuery.length < 2 ? 'Type at least 2 characters to search' : 'No agents found'}
                      </div>
                    ) : (
                      filteredAgents.map((agent: any) => (
                        <button
                          key={agent.AgentId}
                          onClick={() => handleAgentChange(agent.AgentId, agent.AgentName, agent.AgencyName, agent)}
                          className="w-full text-left px-3 py-2 hover:bg-gray-100 focus:bg-gray-100 focus:outline-none"
                        >
                          <div className="font-medium text-gray-900 flex items-center">
                            {agent.Type === 'Agency' ? (
                              <>
                                <Building className="h-4 w-4 mr-2 text-purple-600" />
                                {agent.AgentName}
                                <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
                                  Agency
                                </span>
                              </>
                            ) : (
                              <>
                                <User className="h-4 w-4 mr-2 text-oe-primary" />
                                {agent.AgentName}
                                {agent.AgencyName && (
                                  <span className="text-oe-primary ml-2">({agent.AgencyName})</span>
                                )}
                              </>
                            )}
                          </div>
                          <div className="text-xs text-gray-500 ml-6">
                            {agent.Email} {agent.AgentCode && `• ${agent.AgentCode}`}
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
            {agents.length === 0 && !isLoadingAgents && !isAgentsError && !data.agentId && (isTenantAdmin || (isSysAdmin && data.tenantId) || isAgencyOwner) && (
              <p className="text-xs text-amber-600 mt-1">No agents or agencies found for this tenant</p>
            )}
            {data.touched?.agentId && !data.agentId && (isSysAdmin || isTenantAdmin) && (
              <p className="text-xs text-red-600 mt-1">Agent or agency selection is required</p>
            )}
          </div>
        )}

        {/* Agent creating: choose "Create link for" (Me or downline). Default is Me. */}
        {isAgent && !editingAgentName && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1 inline-flex items-center">
              <User className="h-4 w-4 mr-1" /> Create link for
            </label>
            <SearchableDropdown
              options={downlineAgentOptions.map((opt) => ({ id: opt.id, label: opt.label, value: opt.value, email: opt.email }))}
              value={data.agentId || ''}
              onChange={(value) => onDataChange({ agentId: value || '', touched: { ...data.touched, agentId: true } })}
              placeholder="Yourself (default)"
              searchPlaceholder="Search agents..."
              loading={isLoadingDownlineAgents}
              useBackendSearch={false}
              showEmail={true}
              className="w-full max-w-md"
            />
            <p className="text-xs text-gray-500 mt-1">The enrollment link will be assigned to the selected agent. Default is you.</p>
          </div>
        )}
        {/* Agent editing: show who the template is for */}
        {isAgent && editingAgentName && (
          <div>
            <p className="text-sm font-medium text-gray-900 mb-1 inline-flex items-center"><User className="h-4 w-4 mr-1" /> Template is for</p>
            <div className="border border-gray-200 rounded-lg p-3">
              <p className="text-sm font-semibold">{editingAgentName}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default BasicInfoStep;
