import { AlertCircle, CheckCircle, Copy, Mail, MailCheck, X, Zap } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { usePaymentProcessorStatus } from '../../hooks/usePaymentProcessorStatus';
import { apiService } from '../../services/api.service';
import { EnrollmentLinkTemplate, EnrollmentLinkTemplatesService } from '../../services/enrollment-link-templates.service';
import SearchableDropdown from '../common/SearchableDropdown';
import AgentAssignment from './AgentAssignment';

const NEW_MEMBER_VALUE = 'NEW_MEMBER';

interface ExistingMemberOption {
  id: string;
  label: string;
  value: string;
  email?: string;
  code?: string;
}

interface QuickEnrollmentLinkModalProps {
  open: boolean;
  onClose: () => void;
  onLinkSent: () => void;
  templateId?: string; // Optional: pre-select a template
  initialAgentId?: string; // Optional: when opening for another agent's template (TenantAdmin/SysAdmin), auto-select this agent
  /** Display name for the template owner (agent or agency) — needed so AgentAssignment shows "Current Agent" instead of an empty dropdown */
  initialAgentName?: string;
  initialAgentEmail?: string;
  prefillMember?: {
    memberId?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phoneNumber?: string;
    agentId?: string;
  };
  /** When true with prefillMember (existing member), hide recipient dropdown and show read-only name/email */
  lockRecipient?: boolean;
}

const QuickEnrollmentLinkModal: React.FC<QuickEnrollmentLinkModalProps> = ({
  open,
  onClose,
  onLinkSent,
  templateId,
  initialAgentId,
  initialAgentName,
  initialAgentEmail,
  prefillMember,
  lockRecipient = false
}) => {
  const recipientLocked = lockRecipient && !!prefillMember?.memberId;
  const { user } = useAuth();
  const { data: paymentProcessorStatus } = usePaymentProcessorStatus();
  
  // Form state
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [agentId, setAgentId] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<string>(templateId || '');
  const [sendEmail, setSendEmail] = useState(true); // Email checked by default
  const [sendSMS, setSendSMS] = useState(false);
  
  // Loading and error states
  const [loading, setLoading] = useState(false);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [memberEmail, setMemberEmail] = useState<string>('');
  const [selectedRecipient, setSelectedRecipient] = useState<string>(NEW_MEMBER_VALUE);
  const [selectedExistingMemberId, setSelectedExistingMemberId] = useState<string>('');
  const [memberOptions, setMemberOptions] = useState<ExistingMemberOption[]>([]);
  const [memberOptionsLoading, setMemberOptionsLoading] = useState(false);
  
  // Templates
  const [templates, setTemplates] = useState<EnrollmentLinkTemplate[]>([]);

  const selectedTemplateRow = useMemo(
    () => templates.find((t) => t.TemplateId === selectedTemplate),
    [templates, selectedTemplate]
  );

  /** Owner label for AgentAssignment (tenant-admin must show current agent without waiting for dropdown fetch) */
  const templateOwnerDisplayName =
    initialAgentName ||
    selectedTemplateRow?.AgentName ||
    '';

  const normId = (id: string | undefined) =>
    id ? String(id).replace(/[{}]/g, '').toLowerCase().trim() : '';

  /** Template / prop owner id — used to show "Current Agent" only when selection still matches owner */
  const templateOwnerId =
    initialAgentId || selectedTemplateRow?.AgentId || selectedTemplateRow?.AgencyId || '';

  const agentSelectionMatchesTemplateOwner =
    !!agentId &&
    !!templateOwnerId &&
    normId(agentId) === normId(String(templateOwnerId));

  const currentAgentLabelForAssignment =
    templateOwnerDisplayName && agentSelectionMatchesTemplateOwner ? templateOwnerDisplayName : undefined;

  /** Agent must be chosen in state (not inferred from initialAgentId alone) so clearing the dropdown blocks send */
  const adminNeedsAgent =
    user?.currentRole === 'TenantAdmin' || user?.currentRole === 'SysAdmin';
  const hasAgentSelected = Boolean(String(agentId || '').trim());
  const agentGateBlocked = adminNeedsAgent && !hasAgentSelected;

  /** TenantAdmin / SysAdmin: enrollment link template always belongs to an agent or agency — keep selection aligned */
  useEffect(() => {
    if (!open) return;
    const adminLike = user?.currentRole === 'TenantAdmin' || user?.currentRole === 'SysAdmin';
    if (!adminLike) return;
    if (!selectedTemplate || templates.length === 0) return;
    const t = templates.find((x) => x.TemplateId === selectedTemplate);
    const ownerId = t?.AgentId || t?.AgencyId;
    if (ownerId) {
      setAgentId(String(ownerId));
    }
  }, [open, user?.currentRole, selectedTemplate, templates]);

  const recipientOptions: ExistingMemberOption[] = [
    { id: NEW_MEMBER_VALUE, value: NEW_MEMBER_VALUE, label: 'New Member' },
    ...memberOptions
  ];
  
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

  // Load templates when modal opens or agent changes
  useEffect(() => {
    if (open && user?.currentRole) {
      loadTemplates();
    }
  }, [open, user?.currentRole, agentId, initialAgentId]);

  // Reset form when modal closes, or set template/agent when opened with templateId/initialAgentId
  useEffect(() => {
    if (!open) {
      setFirstName('');
      setLastName('');
      setEmail('');
      setPhoneNumber('');
      setAgentId('');
      setSelectedTemplate('');
      setSendEmail(true);
      setSendSMS(false);
      setError(null);
      setLinkCopied(false);
      setShowSuccessModal(false);
      setMemberEmail('');
      setSelectedRecipient(NEW_MEMBER_VALUE);
      setSelectedExistingMemberId('');
      setMemberOptions([]);
    } else {
      // When modal opens for another agent's template, auto-select that agent so templates load
      if (initialAgentId) {
        setAgentId(initialAgentId);
      } else if (prefillMember?.agentId) {
        setAgentId(prefillMember.agentId);
      }
      if (templateId) {
        setSelectedTemplate(templateId);
      }
      if (prefillMember?.memberId) {
        const name = `${prefillMember.firstName || ''} ${prefillMember.lastName || ''}`.trim() || prefillMember.email || 'Selected Member';
        setSelectedRecipient(prefillMember.memberId);
        setSelectedExistingMemberId(prefillMember.memberId);
        setFirstName(prefillMember.firstName || '');
        setLastName(prefillMember.lastName || '');
        setEmail(prefillMember.email || '');
        setPhoneNumber(prefillMember.phoneNumber || '');
        setMemberOptions([{
          id: prefillMember.memberId,
          value: prefillMember.memberId,
          label: name,
          email: prefillMember.email || ''
        }]);
      } else {
        setSelectedRecipient(NEW_MEMBER_VALUE);
        setSelectedExistingMemberId('');
      }
      loadMemberOptions('');
    }
  }, [open, templateId, initialAgentId, prefillMember]);

  const loadTemplates = async () => {
    try {
      setTemplatesLoading(true);
      setError(null);
      // When opened for another agent's template, use initialAgentId so first load works before state updates
      const effectiveAgentId = agentId || initialAgentId || '';
      
      // For TenantAdmin, we need an agent selected to load templates
      if (user?.currentRole === 'TenantAdmin' && !effectiveAgentId) {
        setTemplates([]);
        setTemplatesLoading(false);
        return;
      }
      
      const templateType = 'Individual'; // Always individual for quick links
      
      console.log('🔍 Loading enrollment links for quick link:', {
        templateType: templateType,
        agentId: effectiveAgentId,
        userRole: user?.currentRole,
      });
      
      // Get templates based on user role
      // For Agent role, don't pass agentId - backend will use the current user's agentId
      // For TenantAdmin, pass agentId to filter templates
      // For SysAdmin, can pass agentId if needed
      const response = await EnrollmentLinkTemplatesService.getTemplates(
        { 
          templateType: templateType, 
          isActive: true,
          agentId: (user?.currentRole === 'TenantAdmin' || user?.currentRole === 'SysAdmin') && effectiveAgentId 
            ? effectiveAgentId 
            : undefined // Don't pass agentId for Agent role - backend handles it
        },
        user?.currentRole
      );
      
      console.log('📡 Service response:', response);
      
      if (response.success) {
        let filteredTemplates = (response.data?.data || []).filter((template: any) => 
          template.TemplateType === templateType && template.IsActive
        );
        
        console.log(`📋 Found ${templateType} enrollment links:`, filteredTemplates);
        
        setTemplates(filteredTemplates);
        
        // Auto-select first template if available
        if (filteredTemplates.length > 0 && !selectedTemplate) {
          setSelectedTemplate(filteredTemplates[0].TemplateId);
        }
      } else {
        console.error('❌ Service error:', response.message);
        setError(response.message || 'Failed to load enrollment links');
      }
    } catch (error) {
      console.error('Error loading enrollment links:', error);
      setError(error instanceof Error ? error.message : 'Failed to load enrollment links');
    } finally {
      setTemplatesLoading(false);
    }
  };

  const loadMemberOptions = async (query: string = '') => {
    try {
      setMemberOptionsLoading(true);
      const response = await apiService.get<{ success: boolean; data?: any[] }>(
        `/api/me/enrollment-links/member-search?query=${encodeURIComponent(query)}`
      );

      const rows = Array.isArray(response?.data) ? response.data : [];
      const options = rows.map((m: any) => ({
        id: m.MemberId,
        value: m.MemberId,
        label: `${m.FirstName || ''} ${m.LastName || ''}`.trim() || m.Email || 'Unknown Member',
        email: m.Email || '',
        code: m.GroupId ? 'Group member' : (m.Status || '')
      }));
      setMemberOptions(options);
    } catch (err) {
      console.error('Failed to load existing members for quick send:', err);
      setMemberOptions([]);
    } finally {
      setMemberOptionsLoading(false);
    }
  };

  const resolveRecipient = async (input: { email: string; memberId?: string }) => {
    const response = await apiService.post<{ success: boolean; data?: any; message?: string }>(
      '/api/me/enrollment-links/resolve-recipient',
      input
    );
    if (!(response as any)?.success) {
      throw new Error((response as any)?.message || 'Failed to resolve recipient');
    }
    return (response as any).data;
  };

  const handleSubmit = async (copyToClipboard: boolean = false) => {
    // Validation
    if (!email) {
      setError('Email is required');
      return;
    }
    
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      setError('Please enter a valid email address');
      return;
    }
    
    // Validate delivery methods
    if (!sendEmail && !sendSMS) {
      setError('Please select at least one delivery method (email or SMS)');
      return;
    }
    
    // Validate phone number if SMS is selected
    if (sendSMS && !phoneNumber) {
      setError('Phone number is required when sending via SMS');
      return;
    }
    
    const effectiveAgentIdSubmit = String(agentId || '').trim();
    if (adminNeedsAgent && !effectiveAgentIdSubmit) {
      setError('Please select an agent');
      return;
    }

    // Template is required
    if (!selectedTemplate) {
      setError('Please select an enrollment link template');
      return;
    }
    
    try {
      setLoading(true);
      setError(null);
      setLinkCopied(false);

      // Resolve to existing member when available (manual email or selected existing member)
      const resolved = await resolveRecipient({
        email: email.trim(),
        memberId: selectedExistingMemberId || undefined
      });

      if (!resolved?.canSend) {
        setError(resolved?.reason || 'This recipient is not eligible for an enrollment link.');
        return;
      }

      let memberId = resolved?.member?.memberId as string | undefined;
      let createdMemberId: string | null = null;

      if (!memberId) {
        if (!firstName || !lastName) {
          setError('First name and last name are required for new members.');
          return;
        }
        const memberData: any = {
          firstName,
          lastName,
          email: email.trim(),
          phone: phoneNumber || undefined,
          relationshipType: 'P',
          confirmExistingUser: true
        };

        if (adminNeedsAgent && effectiveAgentIdSubmit) {
          memberData.agentId = effectiveAgentIdSubmit;
        }

        const memberResponse = await apiService.post<any>('/api/members', memberData);
        if (!memberResponse.success) {
          throw new Error(memberResponse.message || 'Failed to create member');
        }

        memberId = memberResponse.data?.memberId ||
                   memberResponse.data?.MemberId ||
                   memberResponse.memberId ||
                   memberResponse.MemberId;

        if (!memberId) {
          throw new Error('Member ID not returned from API. Please try again.');
        }
        createdMemberId = memberId;
      } else {
        setSelectedExistingMemberId(memberId);
      }

      if (!paymentProcessorStatus?.hasApiToken) {
        const proceed = window.confirm(
          '⚠️ Warning: Payment processor API token is not configured for this tenant.\n\n' +
          'Enrollment links may not work properly without payment processing setup.\n\n' +
          'Do you want to continue anyway?'
        );
        if (!proceed) {
          if (createdMemberId) {
            try {
              await apiService.delete(`/api/members/${createdMemberId}`);
            } catch (deleteError) {
              console.error('⚠️ Failed to delete member during rollback:', deleteError);
            }
          }
          return;
        }
      }

      try {
        const linkResponse = await apiService.post('/api/me/enrollment-links/send-individual', {
          memberId,
          templateId: selectedTemplate,
          groupId: null,
          deliveryPreferences: {
            sendEmail,
            sendSMS
          },
          phoneNumber: sendSMS && phoneNumber ? phoneNumber : undefined,
          attestSmsConsent: sendSMS ? true : undefined
        });

        if (!(linkResponse as any).success) {
          throw new Error((linkResponse as any).message || 'Failed to send enrollment link');
        }

        setMemberEmail(email);

        if (copyToClipboard && (linkResponse as any).data?.enrollmentUrl) {
          try {
            await navigator.clipboard.writeText((linkResponse as any).data.enrollmentUrl);
            setLinkCopied(true);
          } catch (copyError) {
            console.error('⚠️ Failed to copy link to clipboard:', copyError);
          }
        }

        setShowSuccessModal(true);
        onLinkSent();
      } catch (linkError) {
        if (createdMemberId) {
          try {
            await apiService.delete(`/api/members/${createdMemberId}`);
          } catch (deleteError) {
            console.error('❌ Failed to delete member during rollback:', deleteError);
          }
        }
        throw linkError;
      }
    } catch (err) {
      console.error('Error creating member and sending enrollment link:', err);
      
      let errorMessage = 'Failed to create member and send enrollment link';
      
      if (err instanceof Error) {
        // Check for email already exists error
        if (err.message.includes('already registered') || 
            err.message.includes('EMAIL_EXISTS') ||
            err.message.includes('duplicate key') || 
            err.message.includes('UNIQUE KEY constraint')) {
          errorMessage = 'A member with this email address already exists. Please use a different email address.';
        } else {
          errorMessage = err.message;
        }
      }
      
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleCloseSuccessModal = () => {
    setShowSuccessModal(false);
    onClose();
  };

  const sendActionsDisabled =
    loading ||
    templatesLoading ||
    templates.length === 0 ||
    !selectedTemplate ||
    agentGateBlocked ||
    !email?.trim() ||
    (!selectedExistingMemberId && (!firstName?.trim() || !lastName?.trim())) ||
    (!sendEmail && !sendSMS) ||
    (sendSMS && !phoneNumber?.trim());

  const getSendActionTooltip = (forCopy: boolean): string => {
    if (agentGateBlocked) return 'Please select an agent first';
    if (templates.length === 0) return 'No enrollment link templates available';
    if (!selectedTemplate) return 'Please select an enrollment link template';
    if (!email?.trim()) return 'Email is required';
    if (!selectedExistingMemberId && (!firstName?.trim() || !lastName?.trim())) {
      return 'First and last name are required for new members';
    }
    if (!sendEmail && !sendSMS) return 'Please select at least one delivery method';
    if (sendSMS && !phoneNumber?.trim()) return 'Phone number is required for SMS';
    if (loading || templatesLoading) return 'Please wait…';
    return forCopy
      ? 'Create member, send enrollment link, and copy link to clipboard'
      : 'Create member and send enrollment link';
  };

  if (!open) return null;

  console.log('🔍 QuickEnrollmentLinkModal render - showSuccessModal:', showSuccessModal, 'memberEmail:', memberEmail);

  return (
    <>
      {/* Success Modal */}
      {showSuccessModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-[80]">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full z-[81]">
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <div className="flex items-center">
                <div className="bg-green-100 p-2 rounded-full mr-3">
                  <MailCheck className="h-6 w-6 text-green-600" />
                </div>
                <h2 className="text-xl font-semibold text-gray-900">
                  Enrollment Link Sent!
                </h2>
              </div>
              <button
                onClick={handleCloseSuccessModal}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X className="h-6 w-6" />
              </button>
            </div>

            {/* Content */}
            <div className="p-6">
              <div className="mb-4">
                <p className="text-gray-700 mb-2">
                  The enrollment link has been successfully sent to:
                </p>
                <p className="font-medium text-gray-900">{memberEmail}</p>
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
                <div className="flex items-start">
                  <Mail className="h-5 w-5 text-oe-primary mr-2 mt-0.5 flex-shrink-0" />
                  <div className="text-sm text-blue-800">
                    <p className="font-medium mb-1">Important Reminder</p>
                    <p>
                      Please remind the member to check their email inbox, including their <strong>Spam/Junk folder</strong>, for the enrollment link.
                    </p>
                  </div>
                </div>
              </div>

              {linkCopied && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
                  <div className="flex items-center">
                    <CheckCircle className="h-5 w-5 text-green-600 mr-2 flex-shrink-0" />
                    <p className="text-sm text-green-800">
                      The enrollment link has also been copied to your clipboard.
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="p-6 border-t border-gray-200 flex justify-end">
              <button
                onClick={handleCloseSuccessModal}
                className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark transition-colors"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Modal - Hide when success modal is showing */}
      {!showSuccessModal && (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[70] p-4 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[90vh] flex flex-col my-auto overflow-visible z-[71]">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center">
            <Zap className="h-6 w-6 text-purple-600 mr-3" />
            <h2 className="text-xl font-semibold text-gray-900">
              {recipientLocked ? 'Send enrollment link' : 'New Member'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            disabled={loading}
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* Content - Scrollable but allow dropdown overflow */}
        <div className="p-6 flex-1 min-h-0 overflow-y-auto">

          {/* Form Fields */}
          <div className="space-y-4">
            {/* Recipient Selection */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Recipient
              </label>
              {recipientLocked ? (
                <div className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5">
                  <p className="text-sm font-medium text-gray-900">
                    {`${prefillMember?.firstName || ''} ${prefillMember?.lastName || ''}`.trim() || 'Member'}
                  </p>
                  {prefillMember?.email && (
                    <p className="text-sm text-gray-600 mt-0.5">{prefillMember.email}</p>
                  )}
                  {prefillMember?.phoneNumber && (
                    <p className="text-sm text-gray-600">{prefillMember.phoneNumber}</p>
                  )}
                  <p className="text-xs text-gray-500 mt-1">Sending link to this member</p>
                </div>
              ) : (
              <SearchableDropdown
                options={recipientOptions}
                value={selectedRecipient}
                onChange={(value, _label, option) => {
                  setSelectedRecipient(value || NEW_MEMBER_VALUE);
                  if (!value || value === NEW_MEMBER_VALUE) {
                    setSelectedExistingMemberId('');
                    return;
                  }
                  setSelectedExistingMemberId(value);
                  if (option?.email) setEmail(option.email);
                  const [fn = '', ...rest] = (option?.label || '').split(' ');
                  const ln = rest.join(' ').trim();
                  if (fn) setFirstName(fn);
                  if (ln) setLastName(ln);
                }}
                placeholder="Choose recipient..."
                searchPlaceholder="Search existing members..."
                loading={memberOptionsLoading}
                showEmail={true}
                useBackendSearch={true}
                onSearch={(query) => {
                  loadMemberOptions(query);
                }}
                className="w-full"
              />
              )}
              {!recipientLocked && (
              <p className="text-xs text-gray-500 mt-1">
                Choose an existing member, or select New Member to create one.
              </p>
              )}
            </div>

            {/* First Name */}
            {!recipientLocked && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                First Name {selectedExistingMemberId ? '' : <span className="text-red-500">*</span>}
              </label>
              <input
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                placeholder="John"
                required={!selectedExistingMemberId}
                disabled={loading}
              />
            </div>
            )}

            {/* Last Name */}
            {!recipientLocked && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Last Name {selectedExistingMemberId ? '' : <span className="text-red-500">*</span>}
              </label>
              <input
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                placeholder="Doe"
                required={!selectedExistingMemberId}
                disabled={loading}
              />
            </div>
            )}

            {/* Email */}
            {!recipientLocked && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Email <span className="text-red-500">*</span>
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                placeholder="john.doe@example.com"
                required
                disabled={loading || !!selectedExistingMemberId}
              />
              <p className="text-xs text-gray-500 mt-1">
                Existing emails are allowed. If the email already belongs to an eligible member, this sends to that member.
              </p>
            </div>
            )}

            {/* Phone Number */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Phone Number {sendSMS ? <span className="text-red-500">*</span> : ''}
              </label>
              <input
                type="tel"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-oe-primary ${
                  sendSMS && !phoneNumber ? 'border-red-500 focus:border-red-500' : 'border-gray-300 focus:border-oe-primary'
                }`}
                placeholder="(555) 123-4567"
                required={sendSMS}
                disabled={loading}
              />
              <p className="text-xs text-gray-500 mt-1">
                {sendSMS 
                  ? 'Phone number is required for SMS delivery' 
                  : 'Optional. Will be saved to member profile and can be used for SMS delivery.'}
              </p>
            </div>

            {/* Agent Selection - Only for TenantAdmin and SysAdmin */}
            {(user?.currentRole === 'TenantAdmin' || user?.currentRole === 'SysAdmin') && (
              <div>
                <AgentAssignment
                  value={agentId}
                  onChange={(id) => {
                    setAgentId(id);
                    setSelectedTemplate(''); // Reset template when agent changes
                  }}
                  label="Select Agent"
                  required={adminNeedsAgent}
                  currentAgentName={currentAgentLabelForAssignment}
                  currentAgentEmail={
                    agentSelectionMatchesTemplateOwner ? initialAgentEmail || undefined : undefined
                  }
                />
                <p className="text-xs text-gray-500 mt-1">
                  Select an agent to view their enrollment link templates
                </p>
              </div>
            )}

            {/* Delivery Method Selection */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Delivery Method <span className="text-red-500">*</span>
              </label>
              <div className="space-y-2">
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={sendEmail}
                    onChange={(e) => setSendEmail(e.target.checked)}
                    className="mr-2 h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
                    disabled={loading}
                  />
                  <span className="text-sm text-gray-700">Send via Email</span>
                </label>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={sendSMS}
                    onChange={(e) => setSendSMS(e.target.checked)}
                    className="mt-0.5 h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded flex-shrink-0"
                    disabled={loading}
                  />
                  <span>
                    <span className="block text-sm text-gray-700">Send as SMS</span>
                    <span className="block text-xs text-gray-500 mt-1 leading-snug">
                      By checking this you agree you have consent from this recipient to send them an SMS
                    </span>
                  </span>
                </label>
                {!sendEmail && !sendSMS && (
                  <p className="text-xs text-red-500 mt-1">
                    Please select at least one delivery method
                  </p>
                )}
              </div>
            </div>

            {/* Template Selection - Allow dropdown to overflow */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Choose Enrollment Link Template <span className="text-red-500">*</span>
              </label>
              {adminNeedsAgent && !hasAgentSelected ? (
                <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                  <div className="flex items-center">
                    <AlertCircle className="h-5 w-5 text-yellow-600 mr-2" />
                    <p className="text-sm text-yellow-800">
                      Please select an agent first to view their enrollment link templates
                    </p>
                  </div>
                </div>
              ) : templatesLoading ? (
                <div className="flex items-center justify-center py-4">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-oe-primary"></div>
                  <span className="ml-2 text-sm text-gray-500">
                    Loading enrollment links...
                  </span>
                </div>
              ) : templates.length === 0 ? (
                <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                  <div className="flex items-center">
                    <AlertCircle className="h-5 w-5 text-yellow-600 mr-2" />
                    <div>
                      <p className="text-sm text-yellow-800 font-medium mb-1">
                        No enrollment links found
                      </p>
                      <p className="text-xs text-yellow-700">
                        Please create an Individual-type enrollment link template first.
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <SearchableDropdown
                  options={templateOptions}
                  value={selectedTemplate}
                  onChange={(value) => setSelectedTemplate(value)}
                  placeholder="Choose an enrollment link template..."
                  searchPlaceholder="Search templates by name, description, tenant, or agent..."
                  loading={templatesLoading}
                  className="w-full"
                  multiLine={true}
                  maxHeight="400px"
                />
              )}
            </div>
          </div>
        </div>

        {/* Error — above footer so it stays visible without scrolling */}
        {error && (
          <div className="flex-shrink-0 px-6 py-3 border-t border-red-100 bg-red-50">
            <div className="flex items-start gap-2">
              <AlertCircle className="h-5 w-5 text-red-600 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-red-800 min-w-0">
                <p className="font-medium mb-0.5">Error</p>
                <p className="break-words">{error}</p>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="p-6 border-t border-gray-200 flex-shrink-0">
          <div className="flex justify-end gap-3">
            <button
              onClick={() => handleSubmit(false)}
              disabled={sendActionsDisabled}
              title={getSendActionTooltip(false)}
              className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors flex items-center"
            >
              {loading ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  Sending...
                </>
              ) : (
                <>
                  <Mail className="h-4 w-4 mr-2" />
                  Send Link
                </>
              )}
            </button>
            <button
              onClick={() => handleSubmit(true)}
              disabled={sendActionsDisabled}
              title={getSendActionTooltip(true)}
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors flex items-center"
            >
              {loading ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  Sending...
                </>
              ) : linkCopied ? (
                <>
                  <CheckCircle className="h-4 w-4 mr-2" />
                  Copied!
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4 mr-2" />
                  Copy & Send Link
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
      )}
    </>
  );
};

export default QuickEnrollmentLinkModal;

