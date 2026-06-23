import { AlertCircle, CheckCircle, ChevronLeft, ChevronRight, Copy, Mail, Search, User, Users, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { apiService } from '../../services/api.service';
import { EnrollmentLinkTemplate, EnrollmentLinkTemplatesService } from '../../services/enrollment-link-templates.service';
import { ApiResponse } from '../../types/api.types';
import { Member } from '../../types/member.types';
import SearchableDropdown from '../common/SearchableDropdown';

interface BulkEnrollmentLinkModalProps {
  open: boolean;
  onClose: () => void;
  members: Member[];
  onLinkSent: () => void;
}


const BulkEnrollmentLinkModal: React.FC<BulkEnrollmentLinkModalProps> = ({
  open,
  onClose,
  members,
  onLinkSent
}) => {
  const { user } = useAuth();
  
  // Wizard state
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3>(1);
  
  // Step 1: Member Selection
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  
  // Step 2: Agent Selection
  const [agentSearchTerm, setAgentSearchTerm] = useState<string>('');
  const [availableAgents, setAvailableAgents] = useState<any[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [agentsLoading, setAgentsLoading] = useState(false);
  
  // Step 3: Template Selection
  const [templates, setTemplates] = useState<EnrollmentLinkTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  const [templatesLoading, setTemplatesLoading] = useState(false);
  
  // Final step
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);


  const goToNextStep = () => {
    if (currentStep < 3) {
      setCurrentStep((currentStep + 1) as 1 | 2 | 3);
    }
  };

  const goToPreviousStep = () => {
    if (currentStep > 1) {
      setCurrentStep((currentStep - 1) as 1 | 2 | 3);
    }
  };

  // Prepare template options for SearchableDropdown
  const templateOptions = templates.map(template => {
    let displayName = EnrollmentLinkTemplatesService.getDisplayTemplateName(template.TemplateName) || template.Description || 'Unnamed Template';
    let secondLine = '';
    
    // Add tenant name for SysAdmin
    if (user?.currentRole === 'SysAdmin' && template.TenantName) {
      secondLine += `(${template.TenantName})`;
    }
    
    // Add agent name for TenantAdmin and SysAdmin
    if ((user?.currentRole === 'TenantAdmin' || user?.currentRole === 'SysAdmin')) {
      if (template.AgentName) {
        secondLine += (secondLine ? ' - ' : '') + template.AgentName;
      } else {
        secondLine += (secondLine ? ' - ' : '') + 'No Agent';
      }
    }
    
    // Combine into multi-line format
    const multiLineLabel = secondLine ? `${displayName}\n${secondLine}` : displayName;
    
    return {
      id: template.TemplateId,
      label: multiLineLabel,
      value: template.TemplateId,
      description: template.Description
    };
  });
  
  // Member search state
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [filteredMembers, setFilteredMembers] = useState<Member[]>([]);
  const [searchLoading, setSearchLoading] = useState<boolean>(false);

  // Helper function to sort members by enrollment status
  const sortMembersByEnrollmentStatus = (membersList: Member[]) => {
    return [...membersList].sort((a, b) => {
      const aIsEnrolled = a.ActiveEnrollments && a.ActiveEnrollments > 0;
      const bIsEnrolled = b.ActiveEnrollments && b.ActiveEnrollments > 0;
      
      // Not enrolled members (false) should come before enrolled members (true)
      if (aIsEnrolled === bIsEnrolled) return 0;
      return aIsEnrolled ? 1 : -1;
    });
  };

  // Search members in database based on search term
  useEffect(() => {
    const searchMembers = async () => {
      if (searchTerm.trim() === '') {
        // Sort members so not enrolled appear first
        const sortedMembers = sortMembersByEnrollmentStatus(members);
        setFilteredMembers(sortedMembers);
        return;
      }

      try {
        setSearchLoading(true);
        
        // Determine the correct endpoint based on user role
        let endpoint = '/api/me/agent/members';
        if (user?.currentRole === 'TenantAdmin') {
          endpoint = '/api/me/tenant-admin/members';
        } else if (user?.currentRole === 'GroupAdmin') {
          endpoint = '/api/me/group-admin/members';
        } else if (user?.currentRole === 'SysAdmin') {
          endpoint = '/api/members';
        }

        // Search with query parameters
        const response = await apiService.get<ApiResponse<any>>(`${endpoint}?search=${encodeURIComponent(searchTerm)}&limit=50`);
        
        if (response.success) {
          const searchResults = Array.isArray(response.data) ? response.data : response.data?.members || [];
          // Sort results so not enrolled appear first
          const sortedResults = sortMembersByEnrollmentStatus(searchResults);
          setFilteredMembers(sortedResults);
        } else {
          console.error('Search failed:', response.message);
          setFilteredMembers([]);
        }
      } catch (error) {
        console.error('Error searching members:', error);
        setFilteredMembers([]);
      } finally {
        setSearchLoading(false);
      }
    };

    // Debounce search to avoid too many API calls
    const timeoutId = setTimeout(searchMembers, 300);
    return () => clearTimeout(timeoutId);
  }, [searchTerm, user?.currentRole, members]);

  // Load agents when step 2 is reached
  useEffect(() => {
    if (currentStep >= 2 && user?.currentRole) {
      loadAgents();
    }
  }, [currentStep, user?.currentRole, agentSearchTerm]);

  // Load templates when step 3 is reached and agent is selected
  useEffect(() => {
    if (currentStep >= 3 && selectedAgent && selectedMember) {
      loadTemplates();
    }
  }, [currentStep, selectedAgent, selectedMember]);

  // Fetch template products when template is selected

  // Reset wizard when modal closes
  useEffect(() => {
    if (!open) {
      setCurrentStep(1);
      setSelectedMember(null);
      setSelectedAgent('');
      setSelectedTemplate('');
      setAgentSearchTerm('');
      setSearchTerm('');
      setError(null);
      setSuccessMessage(null);
    }
  }, [open]);

  const loadTemplates = async () => {
    try {
      setTemplatesLoading(true);
      setError(null);
      
      if (!selectedMember || !selectedAgent) {
        console.log('⚠️ Cannot load templates: missing member or agent');
        setTemplates([]);
        return;
      }
      
      console.log('🔍 Loading enrollment link templates for:', {
        role: user?.currentRole,
        memberId: selectedMember.MemberId,
        memberName: `${selectedMember.FirstName} ${selectedMember.LastName}`,
        agentId: selectedAgent,
        isGroupMember: !!selectedMember.GroupId
      });
      
      // Determine template type based on member's GroupId
      const templateType = selectedMember.GroupId ? 'Group' : 'Individual';
      
      // Get templates based on user role and member type
      const response = await EnrollmentLinkTemplatesService.getTemplates(
        { 
          templateType: templateType,
          isActive: true
        },
        user?.currentRole
      );
      
      console.log('📡 Service response:', response);
      
      if ((response as any).success) {
        // Filter templates by agent and member type
        let filteredTemplates = (response.data?.data || []).filter((template: any) => 
          template.IsActive && 
          template.TemplateType === templateType &&
          template.AgentId === selectedAgent
        );
        
        console.log(`📋 Found ${templateType} templates for agent ${selectedAgent}:`, filteredTemplates);
        
        // Debug template names
        if (filteredTemplates.length > 0) {
          console.log('📋 Template name debugging:');
          filteredTemplates.forEach((template, index) => {
            console.log(`  Template ${index + 1}:`, {
              TemplateId: template.TemplateId,
              TemplateName: template.TemplateName,
              Description: template.Description,
              AgentId: template.AgentId,
              AgentName: template.AgentName,
              TenantName: template.TenantName
            });
          });
        }
        
        setTemplates(filteredTemplates);
        
        // Auto-select first template if available
        if (filteredTemplates.length > 0 && !selectedTemplate) {
          setSelectedTemplate(filteredTemplates[0].TemplateId);
        }
      } else {
        console.error('❌ Service error:', response.message);
        setError('Failed to load enrollment links');
      }
    } catch (error) {
      console.error('Error loading enrollment links:', error);
      setError('Failed to load enrollment links');
    } finally {
      setTemplatesLoading(false);
    }
  };

  // Load agents for assignment
  const loadAgents = async () => {
    try {
      setAgentsLoading(true);
      
      if (!user?.currentRole) {
        return;
      }

      // Only load agents for TenantAdmin and SysAdmin (Agent role doesn't need this)
      if (user.currentRole === 'Agent') {
        setAvailableAgents([]);
        return;
      }

      const response = await EnrollmentLinkTemplatesService.getAgents(
        undefined, // tenantId - will be determined by role
        user.currentRole,
        agentSearchTerm || undefined
      );

      if (response.success) {
        // Deduplicate agents by AgentId to prevent duplicate key warnings
        const agents = response.data || [];
        const uniqueAgents = Array.from(
          new Map(agents.map(agent => [agent.AgentId, agent])).values()
        );
        setAvailableAgents(uniqueAgents);
      }
    } catch (err) {
      console.error('Error loading agents:', err);
    } finally {
      setAgentsLoading(false);
    }
  };

  const copyLink = async () => {
    if (!selectedMember || !selectedTemplate) return;

    // Check if agent assignment is required
    if (!selectedAgent && user?.currentRole !== 'Agent') {
      setError('Please assign an agent to this template before creating the link.');
      return;
    }

    try {
      setLoading(true);
      setError(null);
      
      // Prepare the payload
      const payload: any = {
        templateId: selectedTemplate,
        memberId: selectedMember.MemberId,
        copyOnly: true // This prevents sending email/SMS, only returns the link
      };

      // Add agent assignment if needed
      if (selectedAgent) {
        payload.agentId = selectedAgent;
      }
      
      // Call the individual enrollment link API
      const response = await apiService.post('/api/me/enrollment-links/send-individual', payload);

      if ((response as any).success && (response as any).data?.enrollmentUrl) {
        // Copy to clipboard
        await navigator.clipboard.writeText((response as any).data.enrollmentUrl);
        setSuccessMessage(`Enrollment link copied to clipboard for ${selectedMember.FirstName} ${selectedMember.LastName}`);
        
        // Call the callback to notify parent component
        onLinkSent();
        
        // Close modal after a short delay
        setTimeout(() => {
          onClose();
        }, 2000);
      } else {
        throw new Error((response as any).message || 'Failed to generate enrollment link');
      }
    } catch (error) {
      console.error('Error generating enrollment link:', error);
      setError(error instanceof Error ? error.message : 'Failed to generate enrollment link');
    } finally {
      setLoading(false);
    }
  };

  const sendEmailLink = async () => {
    if (!selectedMember || !selectedTemplate) return;

    // Check if agent assignment is required
    if (!selectedAgent && user?.currentRole !== 'Agent') {
      setError('Please assign an agent to this template before sending the link.');
      return;
    }

    try {
      setLoading(true);
      setError(null);
      
      // Prepare the payload
      const payload: any = {
        templateId: selectedTemplate,
        memberId: selectedMember.MemberId,
        sendEmail: true
      };

      // Add agent assignment if needed
      if (selectedAgent) {
        payload.agentId = selectedAgent;
      }
      
      // Call the individual enrollment link API with email sending
      const response = await apiService.post('/api/me/enrollment-links/send-individual', payload);

      if ((response as any).success) {
        setSuccessMessage(`Enrollment link sent via email to ${selectedMember.FirstName} ${selectedMember.LastName}`);
        
        // Call the callback to notify parent component
        onLinkSent();
        
        // Close modal after a short delay
        setTimeout(() => {
          onClose();
        }, 2000);
      } else {
        throw new Error((response as any).message || 'Failed to send enrollment link');
      }
    } catch (error) {
      console.error('Error sending enrollment link:', error);
      setError(error instanceof Error ? error.message : 'Failed to send enrollment link');
    } finally {
      setLoading(false);
    }
  };

  const getMemberStatusInfo = (member: Member) => {
    const isEnrolled = member.ActiveEnrollments && member.ActiveEnrollments > 0;
    const isGroupMember = !!member.GroupId;
    
    return {
      isEnrolled,
      isGroupMember,
      enrollmentType: isGroupMember ? 'Group' : 'Individual',
      statusText: isEnrolled ? 'Already Enrolled' : 'Not Enrolled'
    };
  };



  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-6xl w-full mx-4 max-h-[95vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-gray-900">Send Enrollment Link</h2>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600"
            >
              <X size={24} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="p-6 pb-8 overflow-y-auto flex-1 min-h-0">
          {/* Success Message */}
          {successMessage && (
            <div className="mb-4 bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded flex items-center">
              <CheckCircle size={20} className="mr-2" />
              <span>{successMessage}</span>
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div className="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded flex items-center">
              <AlertCircle size={20} className="mr-2" />
              <span>{error}</span>
            </div>
          )}

          {/* Step Progress Indicator */}
          <div className="mb-8">
            <div className="flex items-center justify-center">
              <div className="flex items-center space-x-4">
                {/* Step 1 */}
                <div className={`flex items-center ${currentStep >= 1 ? 'text-oe-primary' : 'text-gray-400'}`}>
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                    currentStep >= 1 ? 'bg-oe-primary text-white' : 'bg-gray-200 text-gray-500'
                  }`}>
                    1
                  </div>
                  <span className="ml-2 text-sm font-medium">Select Member</span>
                </div>
                
                <div className={`w-8 h-0.5 ${currentStep >= 2 ? 'bg-oe-primary' : 'bg-gray-200'}`}></div>
                
                {/* Step 2 */}
                <div className={`flex items-center ${currentStep >= 2 ? 'text-oe-primary' : 'text-gray-400'}`}>
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                    currentStep >= 2 ? 'bg-oe-primary text-white' : 'bg-gray-200 text-gray-500'
                  }`}>
                    2
                  </div>
                  <span className="ml-2 text-sm font-medium">Select Agent</span>
                </div>
                
                <div className={`w-8 h-0.5 ${currentStep >= 3 ? 'bg-oe-primary' : 'bg-gray-200'}`}></div>
                
                {/* Step 3 */}
                <div className={`flex items-center ${currentStep >= 3 ? 'text-oe-primary' : 'text-gray-400'}`}>
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                    currentStep >= 3 ? 'bg-oe-primary text-white' : 'bg-gray-200 text-gray-500'
                  }`}>
                    3
                  </div>
                  <span className="ml-2 text-sm font-medium">Select Template</span>
                </div>
              </div>
            </div>
          </div>

          {/* Step 1: Member Selection */}
          {currentStep === 1 && (
            <div className="max-w-2xl mx-auto">
              
              {/* Search */}
              <div className="relative mb-6">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Search className="h-5 w-5 text-gray-400" />
                </div>
                <input
                  type="text"
                  placeholder="Search all members by name, email, or phone..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="block w-full pl-10 pr-10 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                />
                {searchLoading && (
                  <div className="absolute inset-y-0 right-0 pr-3 flex items-center">
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-oe-primary"></div>
                  </div>
                )}
              </div>

              {/* Member List */}
              <div className="border border-gray-200 rounded-md max-h-96 overflow-y-auto">
                {searchLoading ? (
                  <div className="p-4 text-center text-gray-500">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-oe-primary mx-auto mb-2"></div>
                    Searching members...
                  </div>
                ) : filteredMembers.length === 0 ? (
                  <div className="p-4 text-center text-gray-500">
                    {searchTerm.trim() ? 'No members found matching your search' : 'No members available'}
                  </div>
                ) : (
                  filteredMembers.map((member) => {
                    const statusInfo = getMemberStatusInfo(member);
                    return (
                      <div
                        key={member.MemberId}
                        onClick={() => {
                          setSelectedMember(member);
                          // Auto-advance to step 2 if member has agent or group agent
                          if (member.AgentId) {
                            setSelectedAgent(member.AgentId);
                            goToNextStep();
                          } else if (member.GroupId && member.GroupAgentId) {
                            setSelectedAgent(member.GroupAgentId);
                            goToNextStep();
                          } else {
                            goToNextStep();
                          }
                        }}
                        className={`p-4 border-b border-gray-100 cursor-pointer hover:bg-gray-50 transition-colors ${
                          selectedMember?.MemberId === member.MemberId ? 'bg-blue-50 border-blue-200' : ''
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center">
                            <div className={`w-10 h-10 rounded-full flex items-center justify-center mr-3 ${
                              statusInfo.isEnrolled ? 'bg-green-100' : 'bg-gray-100'
                            }`}>
                              {statusInfo.isGroupMember ? (
                                <Users size={16} className={statusInfo.isEnrolled ? 'text-green-600' : 'text-gray-600'} />
                              ) : (
                                <User size={16} className={statusInfo.isEnrolled ? 'text-green-600' : 'text-gray-600'} />
                              )}
                            </div>
                            <div>
                              <div className="font-medium text-gray-900">
                                {member.FirstName} {member.LastName}
                              </div>
                              <div className="text-sm text-gray-500">{member.Email}</div>
                              {member.GroupName && (
                                <div className="text-xs text-oe-primary">Group: {member.GroupName}</div>
                              )}
                              {member.AgentName && (
                                <div className="text-xs text-green-600">Agent: {member.AgentName}</div>
                              )}
                            </div>
                          </div>
                          <div className="text-right">
                            <div className={`text-sm px-2 py-1 rounded-full ${
                              statusInfo.isEnrolled 
                                ? 'bg-green-100 text-green-800' 
                                : 'bg-yellow-100 text-yellow-800'
                            }`}>
                              {statusInfo.statusText}
                            </div>
                            <div className="text-xs text-gray-500 mt-1">
                              {statusInfo.enrollmentType}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* Step 2: Agent Selection */}
          {currentStep === 2 && (
            <div className="max-w-2xl mx-auto">
              
              {/* Selected Member Info */}
              {selectedMember && (
                <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                  <h4 className="font-medium text-blue-900 mb-2">Selected Member</h4>
                  <div className="flex items-center">
                    <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center mr-3">
                      {getMemberStatusInfo(selectedMember).isGroupMember ? (
                        <Users size={14} className="text-oe-primary" />
                      ) : (
                        <User size={14} className="text-oe-primary" />
                      )}
                    </div>
                    <div>
                      <div className="font-medium text-blue-900">
                        {selectedMember.FirstName} {selectedMember.LastName}
                      </div>
                      <div className="text-sm text-oe-primary-dark">
                        {selectedMember.Email} • {getMemberStatusInfo(selectedMember).enrollmentType} Member
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Show existing agent, group agent, or agent selection */}
              {selectedMember?.AgentId && selectedMember?.AgentName ? (
                <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg">
                  <h4 className="font-medium text-green-900 mb-2">Current Agent</h4>
                  <div className="flex items-center">
                    <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center mr-3">
                      <User size={14} className="text-green-600" />
                    </div>
                    <div>
                      <div className="font-medium text-green-900">
                        {selectedMember.AgentName}
                      </div>
                      <div className="text-sm text-green-700">
                        {selectedMember.AgentEmail || 'No email available'}
                      </div>
                    </div>
                  </div>
                </div>
              ) : selectedMember?.GroupId && selectedMember?.GroupAgentId && selectedMember?.GroupAgentName ? (
                <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                  <h4 className="font-medium text-blue-900 mb-2">Group Agent (Auto-Assigned)</h4>
                  <div className="flex items-center">
                    <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center mr-3">
                      <Users size={14} className="text-oe-primary" />
                    </div>
                    <div>
                      <div className="font-medium text-blue-900">
                        {selectedMember.GroupAgentName}
                      </div>
                      <div className="text-sm text-oe-primary-dark">
                        {selectedMember.GroupAgentEmail || 'No email available'}
                      </div>
                      <div className="text-xs text-oe-primary mt-1">
                        Assigned from group: {selectedMember.GroupName}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mb-6">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Assign Agent (Required)
                  </label>
                  <SearchableDropdown
                    options={availableAgents.map(agent => ({
                      id: agent.AgentId,
                      label: `${agent.AgentName}${agent.TenantName ? ` (${agent.TenantName})` : ''}`,
                      value: agent.AgentId,
                      description: agent.Email
                    }))}
                    value={selectedAgent}
                    onChange={(value) => setSelectedAgent(value)}
                    placeholder="Select an agent..."
                    searchPlaceholder="Search agents by name or email..."
                    loading={agentsLoading}
                    className="w-full"
                    onSearch={setAgentSearchTerm}
                    useBackendSearch={true}
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    This member needs an agent assigned before sending enrollment links.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Step 3: Template Selection */}
          {currentStep === 3 && (
            <div className="max-w-2xl mx-auto">
              
              {/* Selected Member and Agent Info */}
              <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <h4 className="font-medium text-blue-900 mb-2">Member</h4>
                    <div className="flex items-center">
                      <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center mr-2">
                        {getMemberStatusInfo(selectedMember!).isGroupMember ? (
                          <Users size={12} className="text-oe-primary" />
                        ) : (
                          <User size={12} className="text-oe-primary" />
                        )}
                      </div>
                      <div>
                        <div className="font-medium text-blue-900 text-sm">
                          {selectedMember!.FirstName} {selectedMember!.LastName}
                        </div>
                        <div className="text-xs text-oe-primary-dark">
                          {getMemberStatusInfo(selectedMember!).enrollmentType} Member
                        </div>
                      </div>
                    </div>
                  </div>
                  <div>
                    <h4 className="font-medium text-blue-900 mb-2">Agent</h4>
                    <div className="flex items-center">
                      <div className="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center mr-2">
                        <User size={12} className="text-green-600" />
                      </div>
                      <div>
                        <div className="font-medium text-blue-900 text-sm">
                          {selectedMember!.AgentName || availableAgents.find(a => a.AgentId === selectedAgent)?.AgentName}
                        </div>
                        <div className="text-xs text-oe-primary-dark">
                          {selectedMember!.AgentEmail || availableAgents.find(a => a.AgentId === selectedAgent)?.Email}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Template Selection */}
              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Choose Enrollment Link Template
                </label>
                {templatesLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-oe-primary"></div>
                    <span className="ml-2 text-sm text-gray-500">Loading templates...</span>
                  </div>
                ) : templates.length === 0 ? (
                  <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                    <div className="flex items-center">
                      <AlertCircle className="h-5 w-5 text-yellow-600 mr-2" />
                      <div>
                        <p className="text-sm text-yellow-800 font-medium mb-1">
                          No {getMemberStatusInfo(selectedMember!).isGroupMember ? 'Group' : 'Individual'} templates found for this agent
                        </p>
                        <p className="text-xs text-yellow-700">
                          Please create a {getMemberStatusInfo(selectedMember!).isGroupMember ? 'Group' : 'Individual'}-type enrollment link for this agent first.
                        </p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <SearchableDropdown
                    options={templateOptions}
                    value={selectedTemplate}
                    onChange={(value) => setSelectedTemplate(value)}
                    placeholder="Choose a template..."
                    searchPlaceholder="Search templates by name or description..."
                    loading={templatesLoading}
                    className="w-full"
                    multiLine={true}
                  />
                )}
              </div>


            </div>
          )}

          {/* Extra space at bottom for dropdown visibility */}
          <div className="h-32"></div>
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-gray-200">
          <div className="flex items-center justify-between">
            {/* Back Button */}
            <div>
              {currentStep > 1 && (
                <button
                  onClick={goToPreviousStep}
                  className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors flex items-center"
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Back
                </button>
              )}
            </div>

            {/* Next/Continue Button */}
            <div>
              {currentStep < 3 ? (
                <button
                  onClick={() => {
                    if (currentStep === 2 && selectedAgent) {
                      goToNextStep();
                    } else if (currentStep === 1 && selectedMember) {
                      goToNextStep();
                    }
                  }}
                  disabled={
                    (currentStep === 1 && !selectedMember) ||
                    (currentStep === 2 && !selectedAgent)
                  }
                  className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors flex items-center"
                >
                  Continue
                  <ChevronRight className="h-4 w-4 ml-1" />
                </button>
              ) : (
                <div className="flex gap-3">
                  <button
                    onClick={copyLink}
                    disabled={loading || !selectedTemplate}
                    className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 disabled:bg-gray-50 disabled:text-gray-400 transition-colors flex items-center"
                  >
                    <Copy className="h-4 w-4 mr-2" />
                    Copy Link
                  </button>
                  <button
                    onClick={sendEmailLink}
                    disabled={loading || !selectedTemplate}
                    className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-400 transition-colors flex items-center"
                  >
                    <Mail className="h-4 w-4 mr-2" />
                    Send Email
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default BulkEnrollmentLinkModal;
