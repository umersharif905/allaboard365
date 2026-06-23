import { AlertCircle, Copy, Mail, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useGroupPaymentValidation } from '../../hooks/useGroupPaymentValidation';
import { apiService } from '../../services/api.service';
import { EnrollmentLinkTemplate, EnrollmentLinkTemplatesService } from '../../services/enrollment-link-templates.service';
import { Member } from '../../types/member.types';
import SearchableDropdown from '../common/SearchableDropdown';

const NEW_TEMPLATE_VALUE = 'NEW_TEMPLATE';

interface IndividualEnrollmentLinkModalProps {
  open: boolean;
  onClose: () => void;
  member: Member;
  onLinkSent: () => void;
  /** When on localhost: options for link domain. Empty when not localhost. */
  linkBaseUrlOptions?: Array<{ label: string; value: string }>;
  /** Default link base URL when on localhost */
  defaultLinkBaseUrl?: string;
  /** When provided and no group templates exist, allow "Auto-create with group products" (group members only). Same logic as mass Send Links. */
  onCreateGroupTemplate?: () => Promise<string | null>;
}


const IndividualEnrollmentLinkModal: React.FC<IndividualEnrollmentLinkModalProps> = ({
  open,
  onClose,
  member,
  onLinkSent,
  linkBaseUrlOptions = [],
  defaultLinkBaseUrl = '',
  onCreateGroupTemplate
}) => {
  const { user } = useAuth();
  
  // Check if group has valid payment methods (only for group members)
  const { 
    data: paymentValidation = { hasValidPaymentMethod: false, paymentMethods: [] },
    isLoading: paymentLoading 
  } = useGroupPaymentValidation(member.GroupId || '');
  
  // Debug: Log when component renders
  console.log('🔧 IndividualEnrollmentLinkModal rendered with open:', open);
  console.log('🔧 IndividualEnrollmentLinkModal member:', member);
  console.log('🔧 IndividualEnrollmentLinkModal user:', user);
  
  // State
  const [templates, setTemplates] = useState<EnrollmentLinkTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [generatedLink, setGeneratedLink] = useState<string | null>(null);
  const [sendEmail, setSendEmail] = useState(true); // Email checked by default
  const [sendSMS, setSendSMS] = useState(false);
  const [attestSmsConsent, setAttestSmsConsent] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState<string>(member.PhoneNumber || '');
  const [selectedLinkBaseUrl, setSelectedLinkBaseUrl] = useState<string>(defaultLinkBaseUrl);
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [confirmInvalidateModal, setConfirmInvalidateModal] = useState<{
    show: boolean;
    action: 'copy' | 'send';
    body: Record<string, unknown>;
  } | null>(null);

  // Determine effective agent (use member's agent first, then group's agent)
  const effectiveAgentId = member.AgentId || member.GroupAgentId;
  const effectiveAgentName = member.AgentName || member.GroupAgentName;
  const effectiveAgentEmail = member.AgentEmail || member.GroupAgentEmail;

  // When no templates but auto-create is available, single option for dropdown
  const autoCreateTemplateOptions = [
    { id: NEW_TEMPLATE_VALUE, label: '✨ New Enrollment Link (Auto-create with group products)', value: NEW_TEMPLATE_VALUE, description: '' }
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

  // Load templates when modal opens or member changes
  useEffect(() => {
    if (open && user?.currentRole && member) {
      const templateType = member.GroupId ? 'Group' : 'Individual';
      console.log('🚀 IndividualEnrollmentLinkModal opened, loading', templateType, 'enrollment links...');
      console.log('👤 User context:', user);
      console.log('🎭 User currentRole:', user?.currentRole);
      console.log('👥 Member context:', member);
      loadTemplates();
      // Reset generated link when modal opens
      setGeneratedLink(null);
      setLinkCopied(false);
      // Reset phone number to member's current phone
      setPhoneNumber(member.PhoneNumber || '');
      if (defaultLinkBaseUrl && linkBaseUrlOptions.some(o => o.value === defaultLinkBaseUrl)) {
        setSelectedLinkBaseUrl(defaultLinkBaseUrl);
      }
    }
  }, [open, user?.currentRole, member, defaultLinkBaseUrl, linkBaseUrlOptions]);

  // When no templates and we have auto-create for group, select NEW_TEMPLATE so user can send/copy
  const canAutoCreateGroupTemplate = Boolean(member.GroupId && onCreateGroupTemplate);
  const showAutoCreateOption = templates.length === 0 && canAutoCreateGroupTemplate;
  useEffect(() => {
    if (showAutoCreateOption && selectedTemplate !== NEW_TEMPLATE_VALUE) {
      setSelectedTemplate(NEW_TEMPLATE_VALUE);
    }
  }, [showAutoCreateOption, selectedTemplate]);

  const loadTemplates = async () => {
    try {
      setTemplatesLoading(true);
      setError(null);
      
      // Determine template type based on member's GroupId
      const isGroupMember = !!member.GroupId;
      const templateType = isGroupMember ? 'Group' : 'Individual';
      
      console.log('🔍 Loading enrollment links for member:', {
        memberId: member.MemberId,
        memberName: `${member.FirstName} ${member.LastName}`,
        hasGroupId: isGroupMember,
        groupId: member.GroupId,
        agentId: effectiveAgentId,
        agentName: effectiveAgentName,
        templateType: templateType,
        userRole: user?.currentRole,
        filterStrategy: isGroupMember ? 'Using groupId (backend looks up AgentId)' : 'Using direct agentId'
      });
      
      // Get templates based on user role and member type
      // For group members: pass groupId and backend will look up AgentId from oe.Groups
      // For individual members: pass agentId directly
      const response = await EnrollmentLinkTemplatesService.getTemplates(
        { 
          templateType: templateType, 
          isActive: true,
          groupId: member.GroupId, // Backend will look up AgentId from oe.Groups.AgentId
          agentId: member.GroupId ? undefined : effectiveAgentId // For individual members, pass agentId directly
        },
        user?.currentRole
      );
      
      console.log('📡 Service response:', response);
      
      if (response.success) {
        // Templates should already be filtered by backend for the group's agent
        let filteredTemplates = (response.data?.data || []).filter((template: any) => 
          template.TemplateType === templateType && template.IsActive
        );
        
        console.log(`📋 Found ${templateType} enrollment links (backend filtered by ${isGroupMember ? 'group AgentId' : 'direct agentId'}):`, filteredTemplates);
        console.log('📋 Total enrollment links found:', response.data?.data?.length || 0);
        console.log(`📋 Filtered for agent: ${effectiveAgentName || 'No agent assigned'}`);
        
        // Debug template structure
        if (filteredTemplates.length > 0) {
          console.log('📋 First template structure:', filteredTemplates[0]);
          console.log('📋 TemplateName:', filteredTemplates[0].TemplateName);
          console.log('📋 Description:', filteredTemplates[0].Description);
          console.log('📋 AgentId:', filteredTemplates[0].AgentId);
          console.log('📋 AgentName:', filteredTemplates[0].AgentName);
        }
        
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


  const resolveTemplateId = async (): Promise<string> => {
    if (selectedTemplate && selectedTemplate !== NEW_TEMPLATE_VALUE) {
      return selectedTemplate;
    }
    if (selectedTemplate === NEW_TEMPLATE_VALUE && onCreateGroupTemplate) {
      setCreatingTemplate(true);
      try {
        const templateId = await onCreateGroupTemplate();
        if (!templateId) throw new Error('Failed to create enrollment link template');
        return templateId;
      } finally {
        setCreatingTemplate(false);
      }
    }
    throw new Error('Please select an enrollment link');
  };

  const copyLink = async () => {
    if (!selectedTemplate) {
      setError('Please select an enrollment template first');
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const templateIdToUse = await resolveTemplateId();
      if (selectedTemplate === NEW_TEMPLATE_VALUE) {
        await loadTemplates();
        setSelectedTemplate(templateIdToUse);
      }

      // Generate enrollment link using the same API as handleSendLink
      // Pass copyOnly: true to prevent sending email/SMS
      console.log('🔍 DEBUG: Generating enrollment link for copy...');
      
      // Omit linkBaseUrl when copying so backend returns existing non-expired link if any (instead of creating a new one and invalidating the previous)
      const body: Record<string, unknown> = {
        memberId: member.MemberId,
        templateId: templateIdToUse,
        groupId: member.GroupId,
        copyOnly: true // This prevents sending email/SMS, only returns the link
      };
      const result = await apiService.post('/api/me/enrollment-links/send-individual', body);
      
      console.log('🔍 DEBUG: Copy link API response:', result);

      if ((result as any).code === 'EXISTING_LINK_WOULD_BE_INVALIDATED') {
        setLoading(false);
        setConfirmInvalidateModal({
          show: true,
          action: 'copy',
          body: { ...body, confirmInvalidate: true }
        });
        return;
      }
      if ((result as any).success && (result as any).data?.enrollmentUrl) {
        const enrollmentUrl = (result as any).data.enrollmentUrl;
        const isExisting = (result as any).data?.isExisting || false;
        
        // Always store the link so it can be displayed and manually copied
        setGeneratedLink(enrollmentUrl);
        setError(null); // Clear any previous errors since we successfully got the link
        
        if (isExisting) {
          console.log('✅ Using existing non-expired enrollment link');
        }
        
        // Copy to clipboard using the most reliable method
        // The Clipboard API doesn't require explicit permission in secure contexts,
        // but we need to preserve the user gesture context or use a fallback
        try {
          await copyToClipboard(enrollmentUrl);
          // copyToClipboard sets linkCopied internally on success
        } catch (copyError) {
          // Even if automatic copy fails, the link is now visible for manual copy
          // Don't show an error - the link is displayed and can be copied manually
          console.warn('Automatic copy failed, but link is displayed for manual copy:', copyError);
          // Don't set error - the link generation was successful, only clipboard copy failed
          // The link is still displayed in the UI for manual copying
        }
      } else {
        throw new Error((result as any).message || 'Failed to generate enrollment link');
      }
    } catch (error: any) {
      console.error('Failed to generate enrollment link:', error);
      // Extract error message from API response
      let errorMessage = 'Failed to generate enrollment link';
      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (error?.response?.data?.message) {
        errorMessage = error.response.data.message;
      } else if (error?.message) {
        errorMessage = error.message;
      }
      // Only set error if the API call failed, not if clipboard copy failed
      setError(errorMessage);
      // Clear the generated link if API call failed
      setGeneratedLink(null);
    } finally {
      setLoading(false);
    }
  };

  // Helper function to copy text to clipboard with multiple fallback methods
  // Optimized for Safari compatibility
  const copyToClipboard = async (text: string): Promise<void> => {
    // Detect Safari
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    
    // Method 1: For Safari, prefer execCommand (more reliable)
    if (isSafari) {
      try {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        // Make it invisible but still focusable
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        textArea.style.top = '-999999px';
        textArea.style.opacity = '0';
        textArea.setAttribute('readonly', '');
        textArea.setAttribute('aria-hidden', 'true');
        // Safari-specific: ensure it's in the viewport
        textArea.style.width = '1px';
        textArea.style.height = '1px';
        document.body.appendChild(textArea);
        
        // Select and copy - Safari needs focus first
        textArea.focus();
        textArea.select();
        textArea.setSelectionRange(0, text.length); // For mobile devices
        
        const successful = document.execCommand('copy');
        document.body.removeChild(textArea);
        
        if (successful) {
          setLinkCopied(true);
          setTimeout(() => setLinkCopied(false), 2000);
          console.log('✅ Enrollment link copied to clipboard (Safari execCommand):', text);
          return;
        } else {
          throw new Error('execCommand copy returned false');
        }
      } catch (execError) {
        console.warn('⚠️ Safari execCommand failed, trying Clipboard API:', execError);
        // Fall through to Clipboard API
      }
    }
    
    // Method 2: Try modern Clipboard API (for non-Safari or if execCommand failed)
    if (navigator.clipboard && window.isSecureContext) {
      try {
        // For Safari, don't check permissions (can cause issues)
        if (!isSafari) {
          const permissionStatus = await navigator.permissions.query({ name: 'clipboard-write' as PermissionName }).catch(() => null);
          
          if (permissionStatus?.state === 'denied') {
            throw new Error('Clipboard permission denied. Please enable clipboard access in your browser settings.');
          }
        }
        
        await navigator.clipboard.writeText(text);
        setLinkCopied(true);
        setTimeout(() => setLinkCopied(false), 2000);
        console.log('✅ Enrollment link copied to clipboard (Clipboard API):', text);
        return;
      } catch (clipboardError: any) {
        // If clipboard API fails, fall through to execCommand fallback
        console.warn('⚠️ Clipboard API failed, trying execCommand fallback:', clipboardError);
        
        // If it's a permission error and not Safari, show helpful message
        if (!isSafari && (clipboardError?.message?.includes('not allowed') || 
            clipboardError?.message?.includes('permission') ||
            clipboardError?.name === 'NotAllowedError')) {
          // Fall through to execCommand fallback
        } else if (!isSafari) {
          throw clipboardError;
        }
      }
    }
    
    // Method 3: Fallback to execCommand (for non-Safari browsers or if Clipboard API failed)
    if (!isSafari) {
      try {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        textArea.style.top = '-999999px';
        textArea.style.opacity = '0';
        textArea.setAttribute('readonly', '');
        textArea.setAttribute('aria-hidden', 'true');
        document.body.appendChild(textArea);
        
        textArea.focus();
        textArea.select();
        textArea.setSelectionRange(0, text.length);
        
        const successful = document.execCommand('copy');
        document.body.removeChild(textArea);
        
        if (successful) {
          setLinkCopied(true);
          setTimeout(() => setLinkCopied(false), 2000);
          console.log('✅ Enrollment link copied to clipboard (execCommand fallback):', text);
          return;
        } else {
          throw new Error('execCommand copy returned false');
        }
      } catch (execError) {
        console.error('⚠️ execCommand fallback also failed:', execError);
        throw new Error('Unable to copy automatically. The link has been generated - please copy it manually.');
      }
    }
    
    // If all methods failed
    throw new Error('Unable to copy automatically. The link has been generated - please copy it manually.');
  };

  const handleSendLink = async () => {
    if (!selectedTemplate) {
      setError('Please select an enrollment link');
      return;
    }

    // Validate delivery methods
    if (!sendEmail && !sendSMS) {
      setError('Please select at least one delivery method (email or SMS)');
      return;
    }

    // Validate phone number if SMS is selected
    if (sendSMS && !member.PhoneNumber && !phoneNumber) {
      setError('Phone number is required when sending via SMS');
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const templateIdToUse = await resolveTemplateId();

      // Send individual enrollment link using apiService
      console.log('🔍 DEBUG: Sending enrollment link request...');
      
      const body: Record<string, unknown> = {
        memberId: member.MemberId,
        templateId: templateIdToUse,
        groupId: member.GroupId,
        deliveryPreferences: {
          sendEmail,
          sendSMS
        },
        phoneNumber: sendSMS && phoneNumber ? phoneNumber : undefined,
        attestSmsConsent: sendSMS ? attestSmsConsent : undefined
      };
      if (selectedLinkBaseUrl && selectedLinkBaseUrl.trim()) {
        body.linkBaseUrl = selectedLinkBaseUrl.trim();
      }
      const result = await apiService.post('/api/me/enrollment-links/send-individual', body);
      
      console.log('🔍 DEBUG: API response:', result);
      console.log('🔍 DEBUG: Response success:', (result as any).success);
      console.log('🔍 DEBUG: Response message:', (result as any).message);

      if ((result as any).code === 'EXISTING_LINK_WOULD_BE_INVALIDATED') {
        setLoading(false);
        setConfirmInvalidateModal({
          show: true,
          action: 'send',
          body: { ...body, confirmInvalidate: true }
        });
        return;
      }
      if ((result as any).success) {
        const isExisting = (result as any).data?.isExisting || false;
        if (isExisting) {
          console.log('✅ Using existing non-expired enrollment link');
        } else {
          console.log('✅ New enrollment link created and sent successfully:', (result as any).data);
        }
        onLinkSent();
        onClose();
      } else {
        console.error('❌ API Error:', result);
        const errorMessage = (result as any).message || 'Failed to send enrollment link';
        console.log('🔍 DEBUG: Setting error message:', errorMessage);
        setError(errorMessage);
      }
    } catch (error: any) {
      console.error('Error sending enrollment link:', error);
      console.error('Error type:', typeof error);
      console.error('Error instanceof Error:', error instanceof Error);
      console.error('Error object keys:', error && typeof error === 'object' ? Object.keys(error) : 'N/A');
      
      // Try to extract specific error message from the error object
      let errorMessage = 'Failed to send enrollment link';
      
      // Check if it's a clipboard permission error (shouldn't happen here, but just in case)
      if (error?.message?.includes('not allowed by the user agent') || 
          error?.message?.includes('permission denied') ||
          error?.message?.includes('clipboard')) {
        errorMessage = 'Browser security restriction: Please ensure you have granted clipboard permissions, or try using a different browser.';
      } else if (error instanceof Error) {
        errorMessage = error.message;
        console.log('🔍 DEBUG: Using Error.message:', errorMessage);
      } else if (typeof error === 'object' && error !== null) {
        // Check if it's an API response with a message
        if (error.message) {
          errorMessage = error.message;
          console.log('🔍 DEBUG: Using error.message:', errorMessage);
        } else if (error.response?.data?.message) {
          errorMessage = error.response.data.message;
          console.log('🔍 DEBUG: Using error.response.data.message:', errorMessage);
        } else if (error.response?.data?.error?.message) {
          errorMessage = error.response.data.error.message;
          console.log('🔍 DEBUG: Using error.response.data.error.message:', errorMessage);
        }
      }
      
      console.log('🔍 DEBUG: Final error message to display:', errorMessage);
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const confirmInvalidateAndProceed = async () => {
    if (!confirmInvalidateModal) return;
    const { action, body } = confirmInvalidateModal;
    setConfirmInvalidateModal(null);
    try {
      setLoading(true);
      setError(null);
      const result = await apiService.post('/api/me/enrollment-links/send-individual', body);
      if ((result as any).success && (result as any).data?.enrollmentUrl) {
        const enrollmentUrl = (result as any).data.enrollmentUrl;
        setGeneratedLink(enrollmentUrl);
        setError(null);
        if (action === 'send') {
          onLinkSent();
          onClose();
        } else {
          try {
            await copyToClipboard(enrollmentUrl);
          } catch (e) {
            console.warn('Copy failed after confirm:', e);
          }
        }
      } else {
        setError((result as any).message || (action === 'send' ? 'Failed to send enrollment link' : 'Failed to generate enrollment link'));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Something went wrong';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  if (!open) return null;

  return (
    <>
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div className="flex items-center">
            <Mail className="h-6 w-6 text-oe-primary mr-3" />
            <h2 className="text-xl font-semibold text-gray-900">
              Send {member.GroupId ? 'Group' : 'Individual'} Enrollment Link
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {/* Member Info */}
          <div className="mb-6 p-4 bg-gray-50 rounded-lg">
            <h3 className="font-medium text-gray-900 mb-2">Member Details</h3>
            <div className="space-y-1 text-sm text-gray-600">
              <p><strong>Name:</strong> {member.FirstName} {member.LastName}</p>
              <p><strong>Email:</strong> {member.Email}</p>
              <p><strong>Status:</strong> {member.Status}</p>
              {member.GroupName && (
                <p><strong>Group:</strong> {member.GroupName}</p>
              )}
              {member.TenantName && (
                <p><strong>Tenant:</strong> {member.TenantName}</p>
              )}
            </div>
          </div>

          {/* Agent Info - Show if agent assigned, warn if not */}
          {effectiveAgentId && effectiveAgentName ? (
            <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <h3 className="font-medium text-blue-900 mb-2">Assigned Agent</h3>
              <div className="space-y-1 text-sm text-blue-800">
                <p><strong>Agent:</strong> {effectiveAgentName}</p>
                <p><strong>Email:</strong> {effectiveAgentEmail || 'N/A'}</p>
              </div>
            </div>
          ) : (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
              <div className="flex items-start">
                <AlertCircle className="h-5 w-5 text-red-600 mr-2 mt-0.5 flex-shrink-0" />
                <div>
                  <h3 className="font-medium text-red-900 mb-1">No Agent Assigned</h3>
                  <p className="text-sm text-red-800">
                    This member must have an agent assigned before sending an enrollment link. 
                    Please edit the member to assign an agent first.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Payment Method Warning - Only for group members */}
          {member.GroupId && !paymentLoading && !paymentValidation.hasValidPaymentMethod && (
            <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
              <div className="flex items-start">
                <AlertCircle className="h-5 w-5 text-yellow-600 mr-2 mt-0.5 flex-shrink-0" />
                <div>
                  <h3 className="font-medium text-yellow-900 mb-1">Payment Method Required</h3>
                  <p className="text-sm text-yellow-800">
                    This group must have a valid payment method set up before sending enrollment links. 
                    Please add a payment method in the <strong>Billing</strong> tab first.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Error Display */}
          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
              <div className="flex items-start">
                <AlertCircle className="h-5 w-5 text-red-600 mr-2 mt-0.5 flex-shrink-0" />
                <div className="text-sm text-red-800">
                  <p className="font-medium mb-1">
                    {error.includes('already has active enrollments') 
                      ? 'Member Already Enrolled' 
                      : error.includes('declined coverage') || error.includes('MEMBER_DECLINED_COVERAGE')
                      ? 'Member Declined Coverage'
                      : 'Cannot Send Enrollment Link'
                    }
                  </p>
                  <p className="font-semibold">{error}</p>
                  {error.includes('already has active enrollments') && (
                    <p className="mt-2 text-xs text-red-700">
                      This member is already enrolled and cannot receive a new enrollment link.
                    </p>
                  )}
                  {(error.includes('declined coverage') || error.includes('MEMBER_DECLINED_COVERAGE')) && (
                    <p className="mt-2 text-xs text-red-700">
                      This member has declined coverage and is no longer eligible for enrollment links. The member's status is inactive due to declined coverage.
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Only show enrollment options if payment method is valid (for group members) or if individual member */}
          {(!member.GroupId || paymentValidation.hasValidPaymentMethod) && (
            <>
              {/* Template Selection */}
              <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Choose Link *
            </label>
            {templatesLoading ? (
              <div className="flex items-center justify-center py-4">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-oe-primary"></div>
                <span className="ml-2 text-sm text-gray-500">
                  Loading {member.GroupId ? 'Group' : 'Individual'} enrollment links{effectiveAgentId ? ` for ${effectiveAgentName}` : ''}...
                </span>
              </div>
            ) : templates.length === 0 && !showAutoCreateOption ? (
              <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                <div className="flex items-center">
                  <AlertCircle className="h-5 w-5 text-yellow-600 mr-2" />
                  <div>
                    <p className="text-sm text-yellow-800 font-medium mb-1">
                      {member.AgentId 
                        ? `No ${member.GroupId ? 'Group' : 'Individual'} enrollment links found for ${member.AgentName}`
                        : `No ${member.GroupId ? 'Group' : 'Individual'} enrollment links found`
                      }
                    </p>
                    <p className="text-xs text-yellow-700">
                      {member.AgentId 
                        ? `Please create a ${member.GroupId ? 'Group' : 'Individual'}-type enrollment link for ${member.AgentName} first.`
                        : `Please create a ${member.GroupId ? 'Group' : 'Individual'}-type enrollment link first.`
                      }
                    </p>
                  </div>
                </div>
              </div>
            ) : templates.length === 0 && showAutoCreateOption ? (
              <SearchableDropdown
                options={autoCreateTemplateOptions}
                value={selectedTemplate}
                onChange={(value) => setSelectedTemplate(value)}
                placeholder="Choose an enrollment link..."
                searchPlaceholder="Search templates..."
                loading={templatesLoading}
                className="w-full"
                multiLine={false}
              />
            ) : (
              <div>
                {member.AgentId && (
                  <div className="mb-2 p-2 bg-blue-50 border border-blue-200 rounded text-xs text-oe-primary-dark">
                    Showing enrollment links for {member.AgentName}
                  </div>
                )}
                <SearchableDropdown
                  options={templateOptions}
                  value={selectedTemplate}
                  onChange={(value) => setSelectedTemplate(value)}
                  placeholder="Choose an enrollment link..."
                  searchPlaceholder="Search templates by name, description, tenant, or agent..."
                  loading={templatesLoading}
                  className="w-full"
                  multiLine={true}
                />
              </div>
            )}
          </div>

          {/* Delivery Method Selection */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Delivery Method *
            </label>
            <div className="space-y-2">
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={sendEmail}
                  onChange={(e) => setSendEmail(e.target.checked)}
                  className="mr-2 h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
                />
                <span className="text-sm text-gray-700">Send via Email</span>
              </label>
              <label className="flex items-center">
                <input
                  type="checkbox"
                  checked={sendSMS}
                  onChange={(e) => setSendSMS(e.target.checked)}
                  className="mr-2 h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
                />
                <span className="text-sm text-gray-700">Send via Text Message (SMS)</span>
              </label>
              {!sendEmail && !sendSMS && (
                <p className="text-xs text-red-500 mt-1">
                  Please select at least one delivery method
                </p>
              )}
            </div>
            
            {/* Phone Number Input for SMS */}
            {sendSMS && (
              <div className="mt-3 space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Phone Number {!member.PhoneNumber && !phoneNumber ? '*' : ''}
                  </label>
                  <input
                    type="tel"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    placeholder="(555) 123-4567"
                    className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-oe-primary ${
                      sendSMS && !member.PhoneNumber && !phoneNumber ? 'border-red-500 focus:border-red-500' : 'border-gray-300 focus:border-oe-primary'
                    }`}
                    required={sendSMS && !member.PhoneNumber}
                  />
                  {sendSMS && !member.PhoneNumber && !phoneNumber && (
                    <p className="text-xs text-red-500 mt-1">Phone number required for SMS</p>
                  )}
                </div>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={attestSmsConsent}
                    onChange={(e) => setAttestSmsConsent(e.target.checked)}
                    className="mt-1 h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
                  />
                  <span className="text-sm text-gray-700">
                    I attest that this member has given prior consent to receive text messages.
                  </span>
                </label>
              </div>
            )}
          </div>

          {/* Link domain (localhost only) */}
          {linkBaseUrlOptions.length > 0 && (
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Link domain
              </label>
              <select
                value={selectedLinkBaseUrl || defaultLinkBaseUrl}
                onChange={(e) => setSelectedLinkBaseUrl(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary text-sm"
              >
                {linkBaseUrlOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Generated Link Display - Show when link is generated */}
          {generatedLink && (
            <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg">
              <div className="flex items-start mb-3">
                <AlertCircle className="h-5 w-5 text-green-600 mr-2 mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <p className="font-medium text-green-900 mb-1">
                    {linkCopied ? 'Link Copied!' : 'Enrollment Link Generated'}
                  </p>
                  <p className="text-sm text-green-800 mb-2">
                    {linkCopied 
                      ? 'The link has been copied to your clipboard. You can also copy it manually below if needed.'
                      : 'The enrollment link has been generated. Click the link below to select and copy it manually.'
                    }
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={generatedLink}
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                  className="flex-1 px-3 py-2 border border-green-300 rounded-md bg-white text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-green-500 cursor-text"
                  style={{ fontFamily: 'monospace' }}
                />
                <button
                  onClick={() => {
                    const input = document.querySelector(`input[value="${generatedLink}"]`) as HTMLInputElement;
                    if (input) {
                      input.select();
                      input.setSelectionRange(0, generatedLink.length);
                    }
                  }}
                  className="px-3 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors text-sm font-medium whitespace-nowrap"
                  title="Select all text"
                >
                  Select All
                </button>
              </div>
            </div>
          )}

            </>
          )}
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-gray-200">
          {/* Action Buttons Row */}
          <div className="flex items-center justify-center gap-3 mb-4">
            {selectedTemplate && (
              <button
                onClick={copyLink}
                disabled={loading || creatingTemplate || templatesLoading || !effectiveAgentId}
                className={`px-4 py-2 rounded-lg transition-colors flex items-center whitespace-nowrap ${
                  linkCopied 
                    ? 'bg-green-100 text-green-700' 
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                } disabled:bg-gray-50 disabled:text-gray-400 disabled:cursor-not-allowed`}
              >
                {loading ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-400 mr-2"></div>
                    Generating...
                  </>
                ) : creatingTemplate ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-400 mr-2"></div>
                    Creating template...
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4 mr-2" />
                    {linkCopied ? 'Copied!' : 'Copy Link'}
                  </>
                )}
              </button>
            )}
            <button
              onClick={handleSendLink}
              disabled={
                loading ||
                creatingTemplate ||
                templatesLoading ||
                !selectedTemplate ||
                !effectiveAgentId ||
                (!sendEmail && !sendSMS) ||
                (sendSMS && !member.PhoneNumber && !phoneNumber) ||
                (templates.length === 0 && !showAutoCreateOption)
              }
              className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors flex items-center whitespace-nowrap"
              title={
                !effectiveAgentId 
                  ? 'Agent must be assigned before sending enrollment link'
                  : 'Send enrollment link to member'
              }
            >
              {loading ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  Sending...
                </>
              ) : creatingTemplate ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                  Creating template...
                </>
              ) : (
                <>
                  <Mail className="h-4 w-4 mr-2" />
                  Send Enrollment Link
                </>
              )}
            </button>
          </div>
          
          {/* Cancel Button Row */}
          <div className="flex justify-center">
            <button
              onClick={onClose}
              className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
              disabled={loading || creatingTemplate}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>

    {/* Confirm when action would invalidate existing enrollment link */}
    {confirmInvalidateModal?.show && (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60]">
        <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-2">Replace enrollment link?</h3>
          <p className="text-gray-600 text-sm mb-4">
            Creating a new link will invalidate the current enrollment link for this member. Anyone with the old link will no longer be able to use it. Continue?
          </p>
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setConfirmInvalidateModal(null)}
              className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmInvalidateAndProceed}
              disabled={loading}
              className="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Please wait...' : 'Continue'}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
};

export default IndividualEnrollmentLinkModal;