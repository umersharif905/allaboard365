// frontend/src/pages/enrollment-links/EnrollmentLinkTemplates.tsx
import {
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Copy,
    Edit,
    ExternalLink,
    Eye,
    FileText,
    Filter,
    MoreVertical,
    Plus,
    RefreshCw,
    Search,
    Send,
    Trash2,
    User,
    Users,
    X
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import ProfileCompletionNotice from '../../components/agent/ProfileCompletionNotice';
import W9RequirementNotice from '../../components/agent/W9RequirementNotice';
import SearchableDropdown from '../../components/common/SearchableDropdown';
import EnrollmentLinkWizard from '../../components/enrollment-wizard/EnrollmentLinkWizard';
import QuickEnrollmentLinkModal from '../../components/shared/QuickEnrollmentLinkModal';
import { useAuth } from '../../contexts/AuthContext';
import useAgentProfileCompletionRequirement from '../../hooks/agent/useAgentProfileCompletionRequirement';
import useAgentW9Requirement from '../../hooks/agent/useAgentW9Requirement';
import { useDownlineAgentsForFilter } from '../../hooks/useDownlineAgentsForFilter';
import {
    useAgentsForDropdown,
    useCreateEnrollmentLinkTemplate,
    useDeleteEnrollmentLinkTemplate,
    useEnrollmentLinkTemplateRoleConfig,
    useEnrollmentLinkTemplates,
    useUpdateEnrollmentLinkTemplate
} from '../../hooks/useEnrollmentLinkTemplates';
import { usePaymentProcessorStatus } from '../../hooks/usePaymentProcessorStatus';
import { apiService } from '../../services/api.service';
import {
    CreateTemplateRequest,
    EnrollmentLinkTemplate,
    EnrollmentLinkTemplateFilters,
    EnrollmentLinkTemplatesService,
    UpdateTemplateRequest
} from '../../services/enrollment-link-templates.service';

// Safari-safe clipboard copy. Returns true on success, false on failure.
// Safari rejects navigator.clipboard.writeText() when it's called after an
// `await` (the user-gesture window has expired). This helper tries the
// document.execCommand('copy') path first via a hidden textarea, which stays
// inside the gesture, then falls back to the modern Clipboard API.
async function robustCopy(text: string): Promise<boolean> {
  try {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(ua);

    if (isSafari) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '0';
        ta.setAttribute('readonly', '');
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, text.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) return true;
      } catch {
        // fall through
      }
    }

    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }

    // Last-ditch execCommand for non-Safari / insecure contexts
    const ta2 = document.createElement('textarea');
    ta2.value = text;
    ta2.style.position = 'fixed';
    ta2.style.left = '-9999px';
    ta2.style.top = '0';
    ta2.setAttribute('readonly', '');
    document.body.appendChild(ta2);
    ta2.focus();
    ta2.select();
    const ok2 = document.execCommand('copy');
    document.body.removeChild(ta2);
    return ok2;
  } catch {
    return false;
  }
}

// Manual copy fallback modal — shown when automatic clipboard write is blocked
// by the browser (most commonly Safari NotAllowedError after an async fetch).
// Renders a readonly input with the URL pre-selected so the user can Cmd+C.
interface ManualCopyModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  linkUrl: string;
}

const ManualCopyModal: React.FC<ManualCopyModalProps> = ({ isOpen, onClose, title, description, linkUrl }) => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setCopied(false);
      return;
    }
    const t = setTimeout(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        try {
          el.select();
          el.setSelectionRange(0, linkUrl.length);
        } catch {
          // noop
        }
      }
    }, 50);
    return () => clearTimeout(t);
  }, [isOpen, linkUrl]);

  if (!isOpen) return null;

  const handleCopyClick = async () => {
    const ok = await robustCopy(linkUrl);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      // Re-select so the user can press Cmd+C / Ctrl+C themselves
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[110] p-4">
      <div className="bg-white rounded-lg max-w-lg w-full">
        <div className="p-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>
          <p className="text-sm text-gray-600 mb-3">
            {description ||
              'Your browser blocked the automatic copy. The link is selected below — press Cmd+C (or Ctrl+C) to copy, or use the button.'}
          </p>
          <div className="flex items-stretch gap-2 mb-4">
            <input
              ref={inputRef}
              type="text"
              readOnly
              value={linkUrl}
              onFocus={(e) => {
                e.currentTarget.select();
              }}
              onClick={(e) => {
                e.currentTarget.select();
              }}
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono bg-gray-50 focus:ring-2 focus:ring-oe-primary focus:outline-none"
            />
            <button
              type="button"
              onClick={handleCopyClick}
              className="px-4 py-2 bg-oe-primary text-white rounded-lg text-sm font-medium hover:bg-oe-dark flex items-center gap-2 whitespace-nowrap"
            >
              <Copy className="h-4 w-4" />
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// Simple Modal Component
interface SimpleModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  size?: 'small' | 'medium' | 'large';
  children: React.ReactNode;
}

const SimpleModal: React.FC<SimpleModalProps> = ({ isOpen, onClose, title, size = 'medium', children }) => {
  if (!isOpen) return null;

  const sizeClasses = {
    small: 'max-w-md',
    medium: 'max-w-2xl',
    large: 'max-w-4xl'
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className={`bg-white rounded-lg ${sizeClasses[size]} w-full max-h-[90vh] overflow-y-auto`}>
        <div className="p-6">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-xl font-semibold text-gray-900">{title}</h2>
            <button 
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600"
            >
              <X className="h-6 w-6" />
            </button>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
};

// Pagination Component
interface PaginationProps {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

const Pagination: React.FC<PaginationProps> = ({
  currentPage,
  totalPages,
  onPageChange,
  hasNextPage,
  hasPreviousPage
}) => {
  return (
    <div className="flex items-center justify-between px-4 py-3 bg-white border-t border-gray-200 sm:px-6">
      <div className="flex justify-between flex-1 sm:hidden">
        <button
          onClick={() => onPageChange(currentPage - 1)}
          disabled={!hasPreviousPage}
          className="relative inline-flex items-center px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Previous
        </button>
        <button
          onClick={() => onPageChange(currentPage + 1)}
          disabled={!hasNextPage}
          className="relative ml-3 inline-flex items-center px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Next
        </button>
      </div>
      <div className="hidden sm:flex sm:flex-1 sm:items-center sm:justify-between">
        <div>
          <p className="text-sm text-gray-700">
            Page <span className="font-medium">{currentPage}</span> of{' '}
            <span className="font-medium">{totalPages}</span>
          </p>
        </div>
        <div>
          <nav className="relative z-0 inline-flex rounded-md shadow-sm -space-x-px" aria-label="Pagination">
            <button
              onClick={() => onPageChange(currentPage - 1)}
              disabled={!hasPreviousPage}
              className="relative inline-flex items-center px-2 py-2 rounded-l-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              onClick={() => onPageChange(currentPage + 1)}
              disabled={!hasNextPage}
              className="relative inline-flex items-center px-2 py-2 rounded-r-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </nav>
        </div>
      </div>
    </div>
  );
};

// Main Component
const EnrollmentLinkTemplates: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const roleConfig = useEnrollmentLinkTemplateRoleConfig();
  const isAgent = user?.currentRole === 'Agent';
  const isTenantAdmin = user?.currentRole === 'TenantAdmin';
  const isAgencyOwner = isAgent && (user?.roles as string[] | undefined)?.includes('AgencyOwner');
  const { hasW9: agentHasW9, isLoading: checkingAgentW9 } = useAgentW9Requirement({ enabled: isAgent });
  const {
    isProfileComplete,
    nextMissing: nextMissingProfileItem,
    isLoading: checkingProfileCompletion
  } = useAgentProfileCompletionRequirement({
    enabled: isAgent && !checkingAgentW9,
    requirementScope: 'enrollment-links',
  });
  const canCreateEnrollmentLink = !isAgent || (
    !checkingAgentW9 &&
    !checkingProfileCompletion &&
    isProfileComplete
  );
  const showW9RequirementNotice = isAgent && (checkingAgentW9 || !agentHasW9);
  const showProfileCompletionNotice = isAgent && !showW9RequirementNotice && !checkingProfileCompletion && !isProfileComplete;
  
  // Filter and pagination states (exclude marketing links - they live on Marketing page)
  const [filters, setFilters] = useState<EnrollmentLinkTemplateFilters>({
    page: 1,
    limit: 20,
    searchTerm: '',
    templateType: 'Individual',
    isActive: true, // Active by default
    tenantName: '',
    agentId: '', // Filter by agent/agency
    viewDownline: false, // AgencyOwner: when true, list templates for self + all downline
    excludeHasMarketingLink: true
  });
  
  // Link scope for AgencyOwner: "My links" (default) vs "My agent downlines"
  const [linkScope, setLinkScope] = useState<'mine' | 'downline'>('mine');
  // When linkScope is 'downline', optional filter by a single agent (SearchableDropdown)
  const [downlineAgentSearchQuery, setDownlineAgentSearchQuery] = useState('');
  const [selectedDownlineAgentId, setSelectedDownlineAgentId] = useState('');
  
  // Agent/Agency filter state for SearchableDropdown
  const [agentSearchQuery, setAgentSearchQuery] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState('');
  // Plain Agent (non-AgencyOwner): filter by self or downline
  const [selectedAgentIdForFilter, setSelectedAgentIdForFilter] = useState('');
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const { data: downlineAgentOptions = [], isLoading: isLoadingDownlineAgents } = useDownlineAgentsForFilter();
  
  // Get tenant ID for agent filtering
  const tenantIdForAgentFilter = isTenantAdmin ? user?.currentTenantId : undefined;
  // For AgencyOwner downline filter we use same hook (returns self + downline when Agent + AgencyOwner)
  const downlineAgentDropdownEnabled = isAgencyOwner && linkScope === 'downline';
  const { data: agentOptions = [], isLoading: isLoadingAgents } = useAgentsForDropdown(
    tenantIdForAgentFilter ?? (downlineAgentDropdownEnabled ? '' : undefined),
    downlineAgentDropdownEnabled ? downlineAgentSearchQuery : agentSearchQuery
  );
  
  // When navigated from Agent Details modal with agentIdForEnrollmentLinks, set scope/filter
  const agentIdFromState = (location.state as { agentIdForEnrollmentLinks?: string } | null)?.agentIdForEnrollmentLinks;
  const sendLinkMemberFromState = (location.state as {
    sendLinkMember?: {
      memberId?: string;
      firstName?: string;
      lastName?: string;
      email?: string;
      phoneNumber?: string;
      agentId?: string;
    }
  } | null)?.sendLinkMember;
  useEffect(() => {
    if (!agentIdFromState) return;
    if (isAgencyOwner) {
      setLinkScope('downline');
      setSelectedDownlineAgentId(agentIdFromState);
    } else if (isTenantAdmin || user?.currentRole === 'SysAdmin') {
      setSelectedAgentId(agentIdFromState);
      setFilters(prev => ({ ...prev, agentId: agentIdFromState, page: 1 }));
    }
    navigate(location.pathname, { replace: true, state: {} });
  }, [agentIdFromState, isAgencyOwner, isTenantAdmin, user?.currentRole, navigate, location.pathname]);

  useEffect(() => {
    if (!sendLinkMemberFromState) return;
    setPrefillQuickSendMember({
      memberId: sendLinkMemberFromState.memberId,
      firstName: sendLinkMemberFromState.firstName,
      lastName: sendLinkMemberFromState.lastName,
      email: sendLinkMemberFromState.email,
      phoneNumber: sendLinkMemberFromState.phoneNumber,
      agentId: sendLinkMemberFromState.agentId
    });
    setShowQuickSendModal(true);
    navigate(location.pathname, { replace: true, state: {} });
  }, [sendLinkMemberFromState, navigate, location.pathname]);

  // Sync filters for AgencyOwner: viewDownline and agentId from linkScope / selectedDownlineAgentId
  useEffect(() => {
    if (!isAgencyOwner) return;
    setFilters(prev => ({
      ...prev,
      page: 1,
      viewDownline: linkScope === 'downline' && !selectedDownlineAgentId,
      agentId: linkScope === 'downline' && selectedDownlineAgentId ? selectedDownlineAgentId : ''
    }));
  }, [isAgencyOwner, linkScope, selectedDownlineAgentId]);

  // Sync filters for plain Agent (non-AgencyOwner): agentId from selectedAgentIdForFilter
  useEffect(() => {
    if (!isAgent || isAgencyOwner || isTenantAdmin || user?.currentRole === 'SysAdmin') return;
    setFilters(prev => ({
      ...prev,
      page: 1,
      agentId: selectedAgentIdForFilter || ''
    }));
  }, [isAgent, isAgencyOwner, isTenantAdmin, user?.currentRole, selectedAgentIdForFilter]);
  
  // Transform agent options for SearchableDropdown
  const agentDropdownOptions = agentOptions.map((agent) => {
    // For SysAdmin: show tenant name as sublabel (code field)
    // For TenantAdmin: no tenant name needed
    const label = agent.Type === 'Agency' 
      ? `${agent.AgentName} (Agency)`
      : agent.AgentName || agent.Email || 'Unknown';
    
    return {
      id: agent.AgentId,
      label: label,
      value: agent.AgentId,
      email: agent.Email,
      code: user?.currentRole === 'SysAdmin' ? agent.TenantName : undefined // Show tenant name for SysAdmin
    };
  });
  
  // Action menu state for 3-dots menu
  const [openActionMenuId, setOpenActionMenuId] = useState<string | null>(null);
  const [actionMenuPosition, setActionMenuPosition] = useState<{ x: number; y: number; maxHeight?: number } | null>(null);
  const actionMenuRefs = React.useRef<{ [key: string]: HTMLButtonElement | null }>({});
  
  // Data fetching
  const templatesQuery = useEnrollmentLinkTemplates(filters);
  const { 
    data: paginatedData, 
    isLoading: loading, 
    error: queryError, 
    refetch: loadTemplates 
  } = templatesQuery;
  
  // Check payment processor status
  const { data: paymentProcessorStatus } = usePaymentProcessorStatus();
  
  // Only show enrollment links (exclude templates that have a marketing link)
  const templates = (paginatedData?.data || []).filter(
    (t) => Number(t.HasMarketingLink) !== 1 && t.HasMarketingLink !== true
  );
  const pagination = paginatedData?.pagination;
  
  
  // Mutations
  const createMutation = useCreateEnrollmentLinkTemplate();
  const updateMutation = useUpdateEnrollmentLinkTemplate();
  const deleteMutation = useDeleteEnrollmentLinkTemplate();
  
  // Dialog states
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [viewDialogOpen, setViewDialogOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<EnrollmentLinkTemplate | null>(null);

  // Products lookup for the "View Details" modal — resolves productId/bundleId → Name.
  // The template JSON only stores IDs, so without this the modal can only show counts.
  const detailsTenantId = selectedTemplate?.TenantId;
  const { data: detailsProductLookup } = useQuery({
    queryKey: ['enrollment-link-template-details-products', user?.currentRole, detailsTenantId],
    enabled: viewDialogOpen && !!selectedTemplate && !!user?.currentRole,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      let endpoint: string;
      switch (user?.currentRole) {
        case 'SysAdmin':
          if (!detailsTenantId) return [] as Array<{ ProductId: string; Name: string }>;
          endpoint = `/api/tenants/${detailsTenantId}/products`;
          break;
        case 'TenantAdmin':
          endpoint = '/api/me/tenant-admin/products';
          break;
        case 'Agent':
          endpoint = '/api/me/agent/products?includeHidden=true';
          break;
        default:
          return [] as Array<{ ProductId: string; Name: string }>;
      }
      const response = await apiService.get<{ success: boolean; data?: any[] }>(endpoint);
      if (response?.success && Array.isArray(response.data)) {
        return response.data as Array<{ ProductId: string; Name: string }>;
      }
      return [] as Array<{ ProductId: string; Name: string }>;
    },
  });

  const productNameById = useMemo(() => {
    const map = new Map<string, string>();
    (detailsProductLookup || []).forEach((p: any) => {
      if (p?.ProductId) map.set(String(p.ProductId), p.Name || '');
    });
    return map;
  }, [detailsProductLookup]);
  const [showQuickSendModal, setShowQuickSendModal] = useState(false);
  const [templateForQuickSend, setTemplateForQuickSend] = useState<EnrollmentLinkTemplate | null>(null);
  const [prefillQuickSendMember, setPrefillQuickSendMember] = useState<{
    memberId?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phoneNumber?: string;
    agentId?: string;
  } | null>(null);
  const [groupTemplateMessage, setGroupTemplateMessage] = useState<{ template: EnrollmentLinkTemplate; groupId?: string } | null>(null);
  const [staticLinkMode, setStaticLinkMode] = useState(false);
  const [marketingLinkMode, setMarketingLinkMode] = useState(false);
  const [staticLinkCopyModal, setStaticLinkCopyModal] = useState<{ template: EnrollmentLinkTemplate; linkUrl: string } | null>(null);
  const [staticLinkCopiedFeedback, setStaticLinkCopiedFeedback] = useState(false);
  const [marketingLinkCopyModal, setMarketingLinkCopyModal] = useState<{ template: EnrollmentLinkTemplate; linkUrl: string } | null>(null);
  const [manualCopyModal, setManualCopyModal] = useState<{ linkUrl: string; title: string; description?: string } | null>(null);
  const [loadingStaticLinkUrl, setLoadingStaticLinkUrl] = useState(false);
  const [copiedTemplateId, setCopiedTemplateId] = useState<string | null>(null);
  const [copyingTemplateId, setCopyingTemplateId] = useState<string | null>(null);
  const [openingTemplateId, setOpeningTemplateId] = useState<string | null>(null);
  const [_loadingMarketingLinkUrl, setLoadingMarketingLinkUrl] = useState(false);
  // Success/error states
  const [success, setSuccess] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  // Handle action menu click - position dropdown below or above the 3-dots button depending on available space
  const ACTION_MENU_WIDTH = 192;
  const ACTION_MENU_GAP = 4;
  const ACTION_MENU_HEIGHT_ESTIMATE = 200;

  const handleActionMenuClick = (templateId: string, event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const newOpenId = openActionMenuId === templateId ? null : templateId;
    setOpenActionMenuId(newOpenId);

    if (newOpenId) {
      const button = actionMenuRefs.current[newOpenId];
      if (button) {
        const rect = button.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom - ACTION_MENU_GAP;
        const spaceAbove = rect.top - ACTION_MENU_GAP;

        let y: number;
        let maxHeight: number | undefined;

        if (spaceBelow >= ACTION_MENU_HEIGHT_ESTIMATE) {
          // Enough space below — open downward
          y = rect.bottom + ACTION_MENU_GAP;
          maxHeight = Math.max(120, spaceBelow);
        } else if (spaceAbove >= ACTION_MENU_HEIGHT_ESTIMATE) {
          // Not enough below, enough above — open upward, anchored to bottom of button
          y = rect.bottom - Math.min(ACTION_MENU_HEIGHT_ESTIMATE, spaceAbove);
          maxHeight = Math.max(120, spaceAbove);
        } else {
          // Neither direction has enough — pick whichever has more space
          if (spaceAbove > spaceBelow) {
            y = rect.bottom - Math.min(ACTION_MENU_HEIGHT_ESTIMATE, spaceAbove);
            maxHeight = Math.max(120, spaceAbove);
          } else {
            y = rect.bottom + ACTION_MENU_GAP;
            maxHeight = Math.max(120, spaceBelow);
          }
        }

        let x = rect.right - ACTION_MENU_WIDTH;
        if (x < ACTION_MENU_GAP) x = ACTION_MENU_GAP;
        if (x + ACTION_MENU_WIDTH > window.innerWidth - ACTION_MENU_GAP) x = window.innerWidth - ACTION_MENU_WIDTH - ACTION_MENU_GAP;
        setActionMenuPosition({ x, y, maxHeight });
      }
    } else {
      setActionMenuPosition(null);
    }
  };

  // Close action menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (openActionMenuId && actionMenuPosition) {
        const target = event.target as HTMLElement;
        if (!target.closest('[data-action-menu]') && !target.closest('[data-action-button]')) {
          setOpenActionMenuId(null);
          setActionMenuPosition(null);
        }
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [openActionMenuId, actionMenuPosition]);


  // Event Handlers
  const handleFilterChange = (field: keyof EnrollmentLinkTemplateFilters, value: any) => {
    setFilters(prev => ({
      ...prev,
      [field]: value,
      page: 1 // Reset to first page when filtering
    }));
    // Close action menu when filters change
    setOpenActionMenuId(null);
    setActionMenuPosition(null);
  };
  
  // Handle agent/agency filter change
  const handleAgentFilterChange = (agentId: string) => {
    setSelectedAgentId(agentId);
    handleFilterChange('agentId', agentId || '');
  };
  
  // Handle agent search for SearchableDropdown
  const handleAgentSearch = useCallback((query: string) => {
    setAgentSearchQuery(query);
  }, []);

  const handlePageChange = (page: number) => {
    setFilters(prev => ({ ...prev, page }));
  };

  const handleFixW9Requirement = () => {
    navigate('/agent/settings?guide=w9-upload#settings-w9-upload-action');
  };

  const handleFixProfileCompletion = () => {
    const targetId = nextMissingProfileItem?.targetId || 'settings-profile-edit-action';
    const params = new URLSearchParams();
    if (nextMissingProfileItem?.guide) {
      params.set('guide', nextMissingProfileItem.guide);
    }
    const search = params.toString();
    navigate(`/agent/settings${search ? `?${search}` : ''}#${targetId}`);
  };

  const handleFixLicenses = () => {
    setCreateDialogOpen(false);
    setEditDialogOpen(false);
    setStaticLinkMode(false);
    setMarketingLinkMode(false);
    navigate('/agent/settings?guide=license-edit#settings-licenses-edit-action');
  };

  const handleOpenCreateDialog = () => {
    if (!canCreateEnrollmentLink) {
      if (checkingAgentW9) {
        setMutationError('Checking your W-9 status. Please try again in a moment.');
      } else if (!agentHasW9) {
        setMutationError('Upload your W-9 in Settings before creating an enrollment link.');
      } else if (checkingProfileCompletion) {
        setMutationError('Checking W-9 and banking status. Please try again in a moment.');
      } else {
        setMutationError('Add your W-9 and banking information in Settings before creating an enrollment link.');
      }
      return;
    }

    setStaticLinkMode(false);
    setMarketingLinkMode(false);
    setCreateDialogOpen(true);
  };

  const handleCreate = async (formData: any) => {
    if (isAgent && !canCreateEnrollmentLink) {
      setCreateDialogOpen(false);
      if (checkingAgentW9) {
        setMutationError('Checking your W-9 status. Please try again in a moment.');
      } else if (!agentHasW9) {
        setMutationError('Upload your W-9 in Settings before creating an enrollment link.');
      } else if (checkingProfileCompletion) {
        setMutationError('Checking W-9 and banking status. Please try again in a moment.');
      } else {
        setMutationError('Add your W-9 and banking information in Settings before creating an enrollment link.');
      }
      return;
    }

    try {
      setMutationError(null);
      
      const createRequest: CreateTemplateRequest & { currentRole?: string } = {
        templateName: formData.templateName,
        templateType: formData.templateType,
        tenantId: formData.tenantId,
        agentId: formData.agentId,
        linkMetaData: typeof formData.linkMetaData === 'string' ? formData.linkMetaData : JSON.stringify(formData.linkMetaData),
        description: formData.description,
        ...(formData.templateType === 'Group' && { groupId: formData.groupId }), // Include groupId for Group templates
        currentRole: user?.currentRole // Pass the current role from frontend
      };
      
      const templateResult = await createMutation.mutateAsync(createRequest);
      
      // If in static link mode, create static link (Individual templates only)
      if (staticLinkMode && (user?.currentRole === 'Agent' || user?.currentRole === 'TenantAdmin') && templateResult?.templateId && formData.templateType === 'Individual') {
        try {
          if (user?.currentRole === 'Agent') {
            const staticLinkData = await apiService.post<{ success: boolean; data: { enrollmentUrl: string }; message?: string }>('/api/me/agent/enrollment-links/create-static', {
              templateId: templateResult.templateId
            });
            
            if (staticLinkData.success) {
              setSuccess(`Static enrollment link created! URL: ${staticLinkData.data.enrollmentUrl}`);
              loadTemplates();
            } else {
              setSuccess('Template created successfully, but failed to create static link');
            }
          } else if (user?.currentRole === 'TenantAdmin' && (formData.agentId || formData.agencyId)) {
            const agentOrAgencyId = formData.agentId || formData.agencyId;
            const staticLinkData = await apiService.post<{ success: boolean; data: { enrollmentUrl: string }; message?: string }>('/api/me/tenant-admin/enrollment-link-templates/create-static', {
              templateId: templateResult.templateId,
              agentId: agentOrAgencyId
            });
            
            if (staticLinkData.success) {
              setSuccess(`Static enrollment link created! URL: ${staticLinkData.data.enrollmentUrl}`);
              loadTemplates();
            } else {
              setSuccess('Template created successfully, but failed to create static link');
            }
          }
        } catch (staticLinkError) {
          console.error('Error creating static link:', staticLinkError);
          setSuccess('Template created successfully, but failed to create static link');
        }
      }
      // If in marketing link mode, create marketing link (Individual or Group templates)
      else if (marketingLinkMode && (user?.currentRole === 'Agent' || user?.currentRole === 'TenantAdmin') && templateResult?.templateId && (formData.templateType === 'Individual' || formData.templateType === 'Group')) {
        try {
          console.log('📍 Creating marketing link for template:', templateResult.templateId);
          
          if (user?.currentRole === 'Agent') {
            // Agent: create marketing link for themselves
            const marketingLinkData = await apiService.post<{ success: boolean; data: { enrollmentUrl: string }; message?: string }>('/api/me/agent/enrollment-links/create-marketing', {
              templateId: templateResult.templateId
            });
            
            if (marketingLinkData.success) {
              setSuccess(`Marketing enrollment link created! URL: ${marketingLinkData.data?.enrollmentUrl ?? ''}`);
            } else {
              setSuccess('Template created successfully, but failed to create marketing link');
            }
          } else if (user?.currentRole === 'TenantAdmin' && (formData.agentId || formData.agencyId)) {
            // Tenant Admin: create marketing link for selected agent or agency (send currentTenantId so backend uses switched tenant)
            const agentOrAgencyId = formData.agentId || formData.agencyId;
            const marketingLinkData = await apiService.post<{ success: boolean; data: { enrollmentUrl: string }; message?: string }>('/api/me/tenant-admin/enrollment-link-templates/create-marketing', {
              templateId: templateResult.templateId,
              agentId: agentOrAgencyId,
              currentTenantId: user?.currentTenantId
            });
            
            if (marketingLinkData.success) {
              setSuccess(`Marketing enrollment link created! URL: ${marketingLinkData.data?.enrollmentUrl ?? ''}`);
            } else {
              setSuccess('Template created successfully, but failed to create marketing link');
            }
          }
        } catch (marketingLinkError) {
          console.error('Error creating marketing link:', marketingLinkError);
          setSuccess('Template created successfully, but failed to create marketing link');
        }
      } else {
        setSuccess('Template created successfully');
      }
      setCreateDialogOpen(false);
      setStaticLinkMode(false);
      setMarketingLinkMode(false);
      loadTemplates(); // Refresh the list
      
    } catch (error) {
      console.error('Error creating template:', error);
      setMutationError(error instanceof Error ? error.message : 'Failed to create template');
    }
  };

  const handleEdit = async (formData: any) => {
    if (!selectedTemplate) return;
    
    try {
      setMutationError(null);
      
      const updateRequest: UpdateTemplateRequest = {
        templateName: formData.templateName,
        templateType: formData.templateType,
        linkMetaData: typeof formData.linkMetaData === 'string' ? formData.linkMetaData : JSON.stringify(formData.linkMetaData),
        description: formData.description,
        isActive: formData.isActive,
        ...(formData.agentId !== undefined && { agentId: formData.agentId }),
        ...(formData.groupId !== undefined && { groupId: formData.groupId }),
        ...(formData.tenantId !== undefined && { tenantId: formData.tenantId })
      };
      
      console.log('🔍 handleEdit - updateRequest:', updateRequest);
      
      await updateMutation.mutateAsync({
        templateId: selectedTemplate.TemplateId,
        templateData: updateRequest
      });
      
      setSuccess('Template updated successfully');
      setEditDialogOpen(false);
      setSelectedTemplate(null);
      setStaticLinkMode(false);
      loadTemplates(); // Refresh the list
      
    } catch (error) {
      console.error('Error updating template:', error);
      setMutationError(error instanceof Error ? error.message : 'Failed to update template');
    }
  };


  const handleDelete = async () => {
    if (!selectedTemplate) return;
    
    try {
      setMutationError(null);
      
      const result = await deleteMutation.mutateAsync(selectedTemplate.TemplateId);
      
      // Display the success message from the backend (includes enrollment link count if any were deleted)
      const successMessage = result?.message || 'Template deleted successfully';
      setSuccess(successMessage);
      setDeleteDialogOpen(false);
      setSelectedTemplate(null);
      
    } catch (error) {
      console.error('Error deleting template:', error);
      setMutationError(error instanceof Error ? error.message : 'Failed to delete template');
    }
  };

  const handleDuplicate = async (template: EnrollmentLinkTemplate) => {
    try {
      setMutationError(null);
      
      if (!user?.currentRole) {
        setMutationError('User role is required');
        return;
      }
      
      const result = await EnrollmentLinkTemplatesService.duplicateTemplate(template.TemplateId, user.currentRole);
      
      if (result.success) {
        setSuccess(`Template duplicated successfully: ${result.data?.templateName || 'New template'}`);
        // Refresh the templates list
        loadTemplates();
      } else {
        setMutationError(result.message || 'Failed to duplicate template');
      }
    } catch (error) {
      console.error('Error duplicating template:', error);
      setMutationError(error instanceof Error ? error.message : 'Failed to duplicate template');
    }
  };

  /** Resolve static enrollment URL for an Individual template (same logic as inline copy / open). */
  const fetchStaticLinkUrlForTemplate = useCallback(async (template: EnrollmentLinkTemplate): Promise<string | null> => {
    if (template.TemplateType !== 'Individual') return null;
    let url = '';
    if (user?.currentRole === 'Agent') {
      const agentResponse = await apiService.get<{ success: boolean; data?: any[] | any }>('/api/me/agent/enrollment-links/static');
      if (agentResponse.success && agentResponse.data) {
        const staticLinks = Array.isArray(agentResponse.data) ? agentResponse.data : [agentResponse.data];
        const matching = staticLinks.find((link: any) =>
          (link.templateId || link.TemplateId || link.EnrollmentLinkTemplateId) === template.TemplateId
        );
        if (matching) url = matching.enrollmentUrl || matching.linkUrl || matching.LinkUrl || '';
      }
      const agentOrAgencyIdForCopy = template.AgentId || template.AgencyId;
      if (!url && agentOrAgencyIdForCopy) {
        const res = await apiService.get<{ success: boolean; data?: any }>(
          `/api/me/tenant-admin/enrollment-link-templates/static-by-agent?agentId=${agentOrAgencyIdForCopy}&templateId=${template.TemplateId}`
        );
        if (res.success && res.data) url = res.data.enrollmentUrl || '';
      }
    } else if (user?.currentRole === 'TenantAdmin') {
      const agentOrAgencyIdForCopy = template.AgentId || template.AgencyId;
      if (agentOrAgencyIdForCopy) {
        const res = await apiService.get<{ success: boolean; data?: any }>(
          `/api/me/tenant-admin/enrollment-link-templates/static-by-agent?agentId=${agentOrAgencyIdForCopy}&templateId=${template.TemplateId}`
        );
        if (res.success && res.data) url = res.data.enrollmentUrl || '';
      }
    } else if (user?.currentRole === 'SysAdmin') {
      const agentOrAgencyIdForCopy = template.AgentId || template.AgencyId;
      if (agentOrAgencyIdForCopy) {
        const res = await apiService.get<{ success: boolean; data?: any }>(
          `/api/me/sysadmin/enrollment-link-templates/static-by-agent?agentId=${agentOrAgencyIdForCopy}&templateId=${template.TemplateId}`
        );
        if (res.success && res.data) url = res.data.enrollmentUrl || '';
      }
    }
    if (!url) {
      if (user?.currentRole === 'Agent') {
        const createRes = await apiService.post<{ success: boolean; data?: { enrollmentUrl: string } }>('/api/me/agent/enrollment-links/create-static', { templateId: template.TemplateId });
        if (createRes.success && createRes.data?.enrollmentUrl) url = createRes.data.enrollmentUrl;
      } else if (user?.currentRole === 'TenantAdmin') {
        const agentOrAgencyIdForCopy = template.AgentId || template.AgencyId;
        if (agentOrAgencyIdForCopy) {
          const createRes = await apiService.post<{ success: boolean; data?: { enrollmentUrl: string } }>('/api/me/tenant-admin/enrollment-link-templates/create-static', { templateId: template.TemplateId, agentId: agentOrAgencyIdForCopy });
          if (createRes.success && createRes.data?.enrollmentUrl) url = createRes.data.enrollmentUrl;
        }
      }
    }
    return url || null;
  }, [user?.currentRole]);

  /** Get or create static link URL for an Individual template, then show copy modal. */
  const handleCopyStaticLinkOption = async (template: EnrollmentLinkTemplate) => {
    if (template.TemplateType !== 'Individual') return;
    setOpenActionMenuId(null);
    setActionMenuPosition(null);
    setMutationError(null);
    setLoadingStaticLinkUrl(true);
    try {
      const url = await fetchStaticLinkUrlForTemplate(template);
      if (url) {
        setStaticLinkCopiedFeedback(false);
        setStaticLinkCopyModal({ template, linkUrl: url });
        loadTemplates();
      } else {
        setMutationError('Could not get or create static link.');
      }
    } catch (err) {
      console.error('Copy static link failed:', err);
      setMutationError(err instanceof Error ? err.message : 'Failed to copy static link.');
    } finally {
      setLoadingStaticLinkUrl(false);
    }
  };

  // UI Helper Functions
  const getTypeIcon = (templateType: string) => {
    return templateType === 'Individual' ? <User className="h-4 w-4" /> : <Users className="h-4 w-4" />;
  };

  // Handle sending individual enrollment link
  const handleSendLink = async (template: EnrollmentLinkTemplate) => {
    // Check payment processor status and show warning if needed
    if (!paymentProcessorStatus?.hasApiToken) {
      const proceed = window.confirm(
        '⚠️ Warning: Payment processor API token is not configured for this tenant.\n\n' +
        'Enrollment links may not work properly without payment processing setup.\n\n' +
        'Do you want to continue anyway?'
      );
      if (!proceed) {
        return;
      }
    }

    const hasMarketingLink = Number(template.HasMarketingLink) === 1 || template.HasMarketingLink === true;
    const agentOrAgencyId = template.AgencyId || template.AgentId;
    
    // If template has a marketing link, show Marketing Enrollment Link copy modal (not Quick Send)
    if (hasMarketingLink) {
      setLoadingMarketingLinkUrl(true);
      try {
        let marketingLinkUrl = '';
        
        console.log('🔍 Fetching marketing link for template:', {
          templateId: template.TemplateId,
          templateName: template.TemplateName,
          hasMarketingLink: template.HasMarketingLink,
          userRole: user?.currentRole
        });
        
        if (user?.currentRole === 'Agent') {
          // For Agent role: Get their own marketing links
          const agentResponse = await apiService.get<{ success: boolean; data?: any[] | any }>('/api/me/agent/enrollment-links/static');
          console.log('📊 Agent static links response:', agentResponse);
          if (agentResponse.success && agentResponse.data) {
            const links = Array.isArray(agentResponse.data) ? agentResponse.data : [agentResponse.data];
            console.log('📋 All links found:', links);
            const matchingLink = links.find((link: any) => 
              ((link.templateId && link.templateId === template.TemplateId) || 
               (link.TemplateId && link.TemplateId === template.TemplateId) ||
               (link.EnrollmentLinkTemplateId && link.EnrollmentLinkTemplateId === template.TemplateId)) &&
              (link.linkType === 'Marketing' || link.LinkType === 'Marketing')
            );
            console.log('🎯 Matching marketing link:', matchingLink);
            if (matchingLink) {
              marketingLinkUrl = matchingLink.enrollmentUrl || matchingLink.linkUrl || matchingLink.LinkUrl || '';
              console.log('✅ Found marketing link URL:', marketingLinkUrl);
            }
          }
          
          // If not found and template has an AgentId, try as agency owner
          if (!marketingLinkUrl && template.AgentId) {
            try {
              const agencyOwnerResponse = await apiService.get<{ success: boolean; data?: any }>(
                `/api/me/tenant-admin/enrollment-link-templates/static-by-agent?agentId=${template.AgentId}&templateId=${template.TemplateId}`
              );
              if (agencyOwnerResponse.success && agencyOwnerResponse.data) {
                // Check if it's a marketing link
                if (agencyOwnerResponse.data.linkType === 'Marketing' || agencyOwnerResponse.data.LinkType === 'Marketing') {
                  marketingLinkUrl = agencyOwnerResponse.data.enrollmentUrl || '';
                }
              }
            } catch (agencyError: any) {
              console.log('Agency owner check failed:', agencyError);
            }
          }
        } else if (user?.currentRole === 'TenantAdmin') {
          // For TenantAdmin, use static-by-agent with AgentId or AgencyId (backend resolves AgencyId to owner)
          const agentOrAgencyId = template.AgentId || template.AgencyId;
          if (agentOrAgencyId) {
            console.log('📞 Fetching marketing link via static-by-agent endpoint:', {
              agentOrAgencyId,
              templateId: template.TemplateId
            });
            const response = await apiService.get<{ success: boolean; data?: any }>(
              `/api/me/tenant-admin/enrollment-link-templates/static-by-agent?agentId=${agentOrAgencyId}&templateId=${template.TemplateId}`
            );
            console.log('📊 static-by-agent response:', response);
            if (response.success && response.data) {
              // Check if it's a marketing link
              if (response.data.linkType === 'Marketing' || response.data.LinkType === 'Marketing') {
                marketingLinkUrl = response.data.enrollmentUrl || '';
                console.log('✅ Found marketing link URL via static-by-agent:', marketingLinkUrl);
              }
            }
          } else {
            // Fallback to paginated endpoint if no agentId
            console.log('📞 Fetching marketing link via paginated static endpoint');
            const response = await apiService.get<{ success: boolean; data?: any[]; pagination?: any }>('/api/me/tenant-admin/enrollment-link-templates/static?page=1&limit=100');
            console.log('📊 Paginated static response:', response);
            if (response.success && response.data) {
              const links = Array.isArray(response.data) ? response.data : [response.data];
              console.log('📋 All links found:', links.length);
              console.log('🔍 Template ID we\'re looking for:', template.TemplateId);
              console.log('🔍 All links data:', links.map((l: any) => ({
                templateId: l.templateId,
                TemplateId: l.TemplateId,
                EnrollmentLinkTemplateId: l.EnrollmentLinkTemplateId,
                linkType: l.linkType,
                LinkType: l.LinkType,
                enrollmentUrl: l.enrollmentUrl
              })));
              const matchingLink = links.find((link: any) => {
                const templateMatch = (
                  (link.templateId && link.templateId === template.TemplateId) || 
                  (link.TemplateId && link.TemplateId === template.TemplateId) ||
                  (link.EnrollmentLinkTemplateId && link.EnrollmentLinkTemplateId === template.TemplateId)
                );
                const typeMatch = (link.linkType === 'Marketing' || link.LinkType === 'Marketing');
                console.log('🔍 Checking link:', {
                  templateId: link.templateId || link.TemplateId || link.EnrollmentLinkTemplateId,
                  linkType: link.linkType || link.LinkType,
                  templateMatch,
                  typeMatch,
                  matches: templateMatch && typeMatch
                });
                return templateMatch && typeMatch;
              });
              console.log('🎯 Matching marketing link:', matchingLink);
              if (matchingLink) {
                marketingLinkUrl = matchingLink.enrollmentUrl || matchingLink.linkUrl || matchingLink.LinkUrl || '';
                console.log('✅ Found marketing link URL via paginated endpoint:', marketingLinkUrl);
              }
            }
          }
        } else if (user?.currentRole === 'SysAdmin') {
          // For SysAdmin, use the sysadmin endpoint with agentId or agencyId and templateId
          const agentOrAgencyId = template.AgentId || template.AgencyId;
          if (agentOrAgencyId) {
            const response = await apiService.get<{ success: boolean; data?: any }>(
              `/api/me/sysadmin/enrollment-link-templates/static-by-agent?agentId=${agentOrAgencyId}&templateId=${template.TemplateId}`
            );
            if (response.success && response.data) {
              // Check if it's a marketing link
              if (response.data.linkType === 'Marketing' || response.data.LinkType === 'Marketing') {
                marketingLinkUrl = response.data.enrollmentUrl || '';
              }
            }
          } else {
            setMutationError('Agent or Agency ID not found for this template. Cannot retrieve marketing link.');
            setLoadingMarketingLinkUrl(false);
            return;
          }
        }
        
        // If still no URL (e.g. agency-assigned template, or link created but list not refreshed), try create-marketing (returns existing link if already exists)
        if (!marketingLinkUrl && agentOrAgencyId && (user?.currentRole === 'TenantAdmin' || user?.currentRole === 'Agent')) {
          try {
            let res: { success: boolean; data?: { enrollmentUrl: string }; message?: string };
            if (user?.currentRole === 'Agent') {
              res = await apiService.post<{ success: boolean; data?: { enrollmentUrl: string }; message?: string }>('/api/me/agent/enrollment-links/create-marketing', { templateId: template.TemplateId });
            } else {
              res = await apiService.post<{ success: boolean; data?: { enrollmentUrl: string }; message?: string }>('/api/me/tenant-admin/enrollment-link-templates/create-marketing', {
                templateId: template.TemplateId,
                agentId: agentOrAgencyId,
                currentTenantId: user?.currentTenantId
              });
            }
            if (res.success && res.data?.enrollmentUrl) marketingLinkUrl = res.data.enrollmentUrl;
          } catch (fallbackErr: any) {
            console.warn('Create-marketing fallback failed:', fallbackErr);
          }
        }

        if (marketingLinkUrl) {
          console.log('✅ Setting marketing link copy modal with URL:', marketingLinkUrl);
          setMarketingLinkCopyModal({ template, linkUrl: marketingLinkUrl });
          loadTemplates();
        } else {
          console.error('❌ Marketing link URL not found for template:', template.TemplateId);
          setMutationError('Marketing link URL not found. Please try refreshing the page.');
        }
      } catch (error) {
        console.error('Error fetching marketing link URL:', error);
        setMutationError('Failed to load marketing link URL. Please try again.');
      } finally {
        setLoadingMarketingLinkUrl(false);
      }
      return;
    }
    
    // "Send link" always uses member-info flow (Quick Send for Individual, group message for Group).
    // Static link modal is only shown when user explicitly chooses "Copy static link" in the dropdown.
    // If not marketing link, use existing flow
    if (template.TemplateType === 'Group') {
      // For group templates, use GroupId from the template (stored directly in database)
      // Fallback to parsing from LinkMetaData if GroupId is not available
      let groupId: string | undefined = template.GroupId;
      
      if (!groupId) {
        try {
          const metadata = JSON.parse(template.LinkMetaData);
          groupId = metadata.groupId;
        } catch (e) {
          // If parsing fails, groupId will remain undefined
          console.warn('Could not extract GroupId from template:', template.TemplateId);
        }
      }
      
      setGroupTemplateMessage({ template, groupId });
    } else {
      // For individual templates, open quick send modal
      setTemplateForQuickSend(template);
      setShowQuickSendModal(true);
    }
  };
  
  // Copy static link to clipboard (from modal)
  const handleCopyStaticLink = async () => {
    if (staticLinkCopyModal?.linkUrl) {
      // Check payment processor status and show warning if needed
      if (!paymentProcessorStatus?.hasApiToken) {
        const proceed = window.confirm(
          '⚠️ Warning: Payment processor API token is not configured for this tenant.\n\n' +
          'This static enrollment link may not work properly without payment processing setup.\n\n' +
          'Do you want to copy the link anyway?'
        );
        if (!proceed) {
          return;
        }
      }
      
      const ok = await robustCopy(staticLinkCopyModal.linkUrl);
      if (ok) {
        setStaticLinkCopiedFeedback(true);
        setTimeout(() => setStaticLinkCopiedFeedback(false), 2000);
      } else {
        setManualCopyModal({
          linkUrl: staticLinkCopyModal.linkUrl,
          title: 'Copy enrollment link',
          description:
            'Your browser blocked the automatic copy. The link is selected below — press Cmd+C (or Ctrl+C) to copy it manually.'
        });
      }
    }
  };

  // Inline copy link - copies static link directly to clipboard with inline "Copied!" feedback
  const handleInlineCopyLink = async (template: EnrollmentLinkTemplate) => {
    if (template.TemplateType !== 'Individual') return;
    setMutationError(null);
    setCopyingTemplateId(template.TemplateId);
    setLoadingStaticLinkUrl(true);
    try {
      const url = await fetchStaticLinkUrlForTemplate(template);
      if (url) {
        const ok = await robustCopy(url);
        setCopyingTemplateId(null);
        if (ok) {
          setCopiedTemplateId(template.TemplateId);
          setTimeout(() => setCopiedTemplateId(null), 2000);
        } else {
          setManualCopyModal({
            linkUrl: url,
            title: 'Copy enrollment link',
            description:
              'Your browser blocked the automatic copy. The link is selected below — press Cmd+C (or Ctrl+C) to copy it manually.'
          });
        }
        loadTemplates();
      } else {
        setCopyingTemplateId(null);
        setMutationError('Could not get or create static link.');
      }
    } catch (err) {
      console.error('Inline copy link failed:', err);
      setCopyingTemplateId(null);
      setMutationError(err instanceof Error ? err.message : 'Failed to copy link.');
    } finally {
      setLoadingStaticLinkUrl(false);
    }
  };

  /** Open static enrollment link in a new tab (same URL resolution as copy). */
  const handleOpenStaticLink = async (template: EnrollmentLinkTemplate) => {
    if (template.TemplateType !== 'Individual') return;
    setMutationError(null);
    setOpeningTemplateId(template.TemplateId);
    setLoadingStaticLinkUrl(true);
    try {
      const url = await fetchStaticLinkUrlForTemplate(template);
      if (url) {
        window.open(url, '_blank', 'noopener,noreferrer');
        loadTemplates();
      } else {
        setMutationError('Could not get or create static link.');
      }
    } catch (err) {
      console.error('Open static link failed:', err);
      setMutationError(err instanceof Error ? err.message : 'Failed to open link.');
    } finally {
      setOpeningTemplateId(null);
      setLoadingStaticLinkUrl(false);
    }
  };

  // Copy marketing link to clipboard
  const handleCopyMarketingLink = async () => {
    if (marketingLinkCopyModal?.linkUrl) {
      // Check payment processor status and show warning if needed
      if (!paymentProcessorStatus?.hasApiToken) {
        const proceed = window.confirm(
          '⚠️ Warning: Payment processor API token is not configured for this tenant.\n\n' +
          'This marketing enrollment link may not work properly without payment processing setup.\n\n' +
          'Do you want to copy the link anyway?'
        );
        if (!proceed) {
          return;
        }
      }
      
      const ok = await robustCopy(marketingLinkCopyModal.linkUrl);
      if (ok) {
        setSuccess('Marketing link copied to clipboard!');
        setMarketingLinkCopyModal(null);
      } else {
        setManualCopyModal({
          linkUrl: marketingLinkCopyModal.linkUrl,
          title: 'Copy marketing link',
          description:
            'Your browser blocked the automatic copy. The link is selected below — press Cmd+C (or Ctrl+C) to copy it manually.'
        });
      }
    }
  };

  // Navigate to group page
  const handleGoToGroup = (groupId?: string) => {
    if (!groupId) {
      setMutationError('Group ID not found. Please contact support.');
      setGroupTemplateMessage(null);
      return;
    }

    // Determine the correct route based on user role (with #members to open members section)
    let route = '';
    if (user?.currentRole === 'Agent') {
      route = `/agent/groups/${groupId}#members`;
    } else if (user?.currentRole === 'TenantAdmin') {
      route = `/tenant-admin/groups/${groupId}#members`;
    } else if (user?.currentRole === 'SysAdmin') {
      route = `/admin/groups/${groupId}#members`;
    } else {
      setMutationError('Unable to determine group page route for your role.');
      setGroupTemplateMessage(null);
      return;
    }

    navigate(route);
    setGroupTemplateMessage(null);
  };

  // Clear all filters
  const handleClearFilters = () => {
    setFilters({
      page: 1,
      limit: 20,
      searchTerm: '',
      templateType: 'Individual',
      isActive: true, // Reset to active by default
      tenantName: '',
      agentId: '',
      viewDownline: false,
      excludeHasMarketingLink: true
    });
    setSelectedAgentId('');
    setAgentSearchQuery('');
    setSelectedAgentIdForFilter('');
  };

  // Render Functions
  const renderFilters = () => (
    <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center">
          <Filter className="h-5 w-5 mr-2 text-gray-700" />
          <h3 className="text-lg font-medium text-gray-900">Filters</h3>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowAdvancedFilters((v) => !v)}
            className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            Advanced filters
            <ChevronDown className={`h-4 w-4 transition-transform ${showAdvancedFilters ? 'rotate-180' : ''}`} />
          </button>
          <button
            onClick={handleClearFilters}
            className="text-sm text-oe-primary hover:text-oe-primary-dark"
          >
            Clear All
          </button>
        </div>
      </div>
      
      {/* Agent + Individual/Group on one row when there's space */}
      <div className="flex flex-wrap items-end gap-4">
        {/* Plain Agent (non-AgencyOwner): single Agent filter */}
        {isAgent && !isAgencyOwner && !isTenantAdmin && user?.currentRole !== 'SysAdmin' && (
          <div className="min-w-0 flex-1 max-w-md">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Agent
            </label>
            <SearchableDropdown
              options={downlineAgentOptions.map((opt) => ({
                id: opt.id,
                label: opt.label,
                value: opt.value,
                email: opt.email
              }))}
              value={selectedAgentIdForFilter}
              onChange={(value) => setSelectedAgentIdForFilter(value)}
              placeholder="My links"
              searchPlaceholder="Search agents..."
              loading={isLoadingDownlineAgents}
              useBackendSearch={false}
              showEmail={true}
              className="w-full"
            />
          </div>
        )}
        {/* AgencyOwner: My links vs My agent downlines + optional agent filter */}
        {isAgencyOwner && (
          <div className="min-w-0 flex-1 p-4 bg-gray-50 rounded-lg border border-gray-200">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Link scope
            </label>
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <input
                  type="radio"
                  id="scope-mine"
                  name="linkScope"
                  checked={linkScope === 'mine'}
                  onChange={() => {
                    setLinkScope('mine');
                    setSelectedDownlineAgentId('');
                  }}
                  className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300"
                />
                <label htmlFor="scope-mine" className="text-sm text-gray-700">My links</label>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="radio"
                  id="scope-downline"
                  name="linkScope"
                  checked={linkScope === 'downline'}
                  onChange={() => setLinkScope('downline')}
                  className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300"
                />
                <label htmlFor="scope-downline" className="text-sm text-gray-700">My agent downlines</label>
              </div>
              {linkScope === 'downline' && (
                <div className="flex-1 min-w-[200px] max-w-md">
                  <SearchableDropdown
                    options={agentDropdownOptions}
                    value={selectedDownlineAgentId}
                    onChange={(value) => setSelectedDownlineAgentId(value)}
                    placeholder="All downline agents"
                    searchPlaceholder="Search agents..."
                    loading={isLoadingAgents}
                    onSearch={(q) => setDownlineAgentSearchQuery(q)}
                    useBackendSearch={false}
                    showEmail={true}
                    className="w-full"
                  />
                </div>
              )}
            </div>
          </div>
        )}
        {/* Agent/Agency Filter - TenantAdmin and SysAdmin */}
        {(isTenantAdmin || user?.currentRole === 'SysAdmin') && (
          <div className="min-w-0 flex-1 max-w-md">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Agent / Agency
            </label>
            <SearchableDropdown
              options={agentDropdownOptions}
              value={selectedAgentId}
              onChange={(value) => handleAgentFilterChange(value)}
              placeholder="All Agents / Agencies"
              searchPlaceholder="Search agents or agencies..."
              loading={isLoadingAgents}
              onSearch={handleAgentSearch}
              useBackendSearch={true}
              showEmail={true}
              showCode={user?.currentRole === 'SysAdmin'}
              className="w-full"
            />
          </div>
        )}
        {/* Individual only — Group enrollment links are managed via GroupProductsTab */}
      </div>

      {/* Advanced filters (Search by link name, Status) */}
      {showAdvancedFilters && (
        <div className="mt-4 pt-4 border-t border-gray-200 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Search Links
            </label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search by template name or description..."
                value={filters.searchTerm}
                onChange={(e) => handleFilterChange('searchTerm', e.target.value)}
                className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Status
            </label>
            <select
              value={filters.isActive?.toString() || ''}
              onChange={(e) => handleFilterChange('isActive', e.target.value === '' ? '' : e.target.value === 'true')}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            >
              <option value="">All Statuses</option>
              <option value="true">Active</option>
              <option value="false">Inactive</option>
            </select>
          </div>
        </div>
      )}

    </div>
  );


  const showStatusColumn = filters.isActive === false || filters.isActive === '';

  const renderTable = () => (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Link Name
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Type
              </th>
              {roleConfig.showTenantColumn && (
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Tenant
                </th>
              )}
              {roleConfig.showAgentColumn && (
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Agent / Agency
                </th>
              )}
              {showStatusColumn && (
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
              )}
              <th className="px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">
                <div className="flex justify-end pr-24">Actions</div>
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {loading ? (
              Array.from({ length: 5 }).map((_, index) => (
                <tr key={index}>
                  <td className="px-6 py-4">
                    <div className="animate-pulse">
                      <div className="h-4 bg-gray-200 rounded w-48 mb-2"></div>
                      <div className="h-3 bg-gray-200 rounded w-32"></div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="animate-pulse h-6 bg-gray-200 rounded w-20"></div>
                  </td>
                  {roleConfig.showTenantColumn && (
                    <td className="px-6 py-4">
                      <div className="animate-pulse h-4 bg-gray-200 rounded w-24"></div>
                    </td>
                  )}
                  {roleConfig.showAgentColumn && (
                    <td className="px-6 py-4">
                      <div className="animate-pulse h-4 bg-gray-200 rounded w-24"></div>
                    </td>
                  )}
                  <td className="px-6 py-4">
                    <div className="animate-pulse h-6 bg-gray-200 rounded w-16"></div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="animate-pulse flex justify-center">
                      <div className="h-8 w-8 bg-gray-200 rounded"></div>
                    </div>
                  </td>
                </tr>
              ))
            ) : templates.length === 0 ? (
              <tr>
                <td colSpan={2 + (roleConfig.showTenantColumn ? 1 : 0) + (roleConfig.showAgentColumn ? 1 : 0) + (showStatusColumn ? 1 : 0) + 1} className="px-6 py-12">
                  <div className="text-center">
                    <FileText className="mx-auto h-12 w-12 text-gray-400 mb-4" />
                    <h3 className="text-lg font-medium text-gray-900 mb-2">
                      No enrollment links found
                    </h3>
                    <p className="text-gray-600 mb-4">
                      {roleConfig.canCreateTemplates ? "Create your first enrollment link to get started" : "No enrollment links available"}
                    </p>
                    {roleConfig.canCreateTemplates && (
                      <>
                        <button
                          onClick={handleOpenCreateDialog}
                          disabled={!canCreateEnrollmentLink}
                          className={`px-4 py-2 rounded-lg transition-colors inline-flex items-center gap-2 focus:outline-none focus:ring-2 focus:ring-offset-2 ${
                            canCreateEnrollmentLink
                              ? 'bg-oe-primary text-white hover:bg-oe-dark focus:ring-oe-primary'
                              : 'bg-gray-300 text-gray-600 cursor-not-allowed focus:ring-gray-300'
                          }`}
                        >
                          <Plus className="h-4 w-4" />
                          New Enrollment Link
                        </button>
                        {isAgent && (
                          <div className="mt-3 max-w-sm mx-auto">
                            {showW9RequirementNotice ? (
                              <W9RequirementNotice
                                isChecking={checkingAgentW9}
                                isMissing={!agentHasW9}
                                targetLabel="enrollment links"
                                onFix={handleFixW9Requirement}
                              />
                            ) : (
                              <ProfileCompletionNotice
                                isChecking={checkingProfileCompletion}
                                isIncomplete={showProfileCompletionNotice}
                                onFix={handleFixProfileCompletion}
                                checkingLabel="Checking W-9 and banking..."
                                incompleteLabel="W-9 and banking required"
                              />
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ) : (
              templates.map((template) => (
                <tr key={template.TemplateId} className="hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <div>
                          <div className="text-sm font-medium text-gray-900" data-template-name={template.TemplateName}>
                            {EnrollmentLinkTemplatesService.getDisplayTemplateName(template.TemplateName)}
                          </div>
                          {template.TemplateType === 'Group' && (template.GroupName || template.GroupId) && (
                            <div className="text-xs text-gray-500 mt-0.5">
                              {template.GroupName || `Group`}
                            </div>
                          )}
                        </div>
                        {/* Marketing links are excluded from this page (excludeHasMarketingLink) - badge not shown here */}
                      </div>
                      {template.Description && (
                        <div className="text-sm text-gray-500 mt-1">
                          {template.Description}
                        </div>
                      )}
                    </div>
                  </td>
                  
                  <td className="px-6 py-4">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${EnrollmentLinkTemplatesService.getTypeColor(template.TemplateType)}`}>
                      {getTypeIcon(template.TemplateType)}
                      <span className="ml-1">{template.TemplateType}</span>
                    </span>
                  </td>
                  
                  {roleConfig.showTenantColumn && (
                    <td className="px-6 py-4 text-sm text-gray-900">
                      {template.TenantName}
                    </td>
                  )}
                  
                  {roleConfig.showAgentColumn && (
                    <td className="px-6 py-4 text-sm text-gray-900">
                      {template.AgentName || '-'}
                    </td>
                  )}
                  
                  {showStatusColumn && (
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${EnrollmentLinkTemplatesService.getStatusColor(template.IsActive)}`}>
                        {template.IsActive ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                  )}
                  
                  <td className="px-6 py-4">
                    <div className="flex items-center justify-end gap-2">
                      {/* Copy Link / Open Link - Individual templates only */}
                      {template.TemplateType === 'Individual' && (isAgent || isTenantAdmin || user?.currentRole === 'SysAdmin') && (
                        <>
                          <button
                            type="button"
                            onClick={() => handleInlineCopyLink(template)}
                            disabled={
                              copyingTemplateId === template.TemplateId ||
                              copiedTemplateId === template.TemplateId ||
                              openingTemplateId === template.TemplateId
                            }
                            className={`inline-flex items-center justify-center w-[90px] py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                              copiedTemplateId === template.TemplateId || copyingTemplateId === template.TemplateId
                                ? 'border-gray-200 bg-gray-50 text-gray-400 cursor-default'
                                : 'border-gray-300 text-gray-700 bg-white hover:bg-gray-50'
                            }`}
                          >
                            <Copy className="h-3.5 w-3.5 mr-1 flex-shrink-0" />
                            {copiedTemplateId === template.TemplateId ? 'Copied!' : copyingTemplateId === template.TemplateId ? 'Copying...' : 'Copy Link'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleOpenStaticLink(template)}
                            disabled={
                              openingTemplateId === template.TemplateId ||
                              copyingTemplateId === template.TemplateId ||
                              copiedTemplateId === template.TemplateId
                            }
                            className={`inline-flex items-center justify-center w-[90px] py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                              openingTemplateId === template.TemplateId
                                ? 'border-gray-200 bg-gray-50 text-gray-400 cursor-default'
                                : 'border-gray-300 text-gray-700 bg-white hover:bg-gray-50'
                            }`}
                          >
                            <ExternalLink className="h-3.5 w-3.5 mr-1 flex-shrink-0" />
                            {openingTemplateId === template.TemplateId ? 'Opening...' : 'Open Link'}
                          </button>
                        </>
                      )}

                      {/* Send Link - all templates */}
                      <button
                        onClick={async () => {
                          await handleSendLink(template);
                        }}
                        className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-lg text-white bg-oe-primary hover:bg-oe-dark transition-colors"
                      >
                        <Send className="h-3.5 w-3.5 mr-1" />
                        Send
                      </button>

                      {/* 3-dot menu for remaining actions */}
                      <div className="relative">
                        <button
                          ref={(el) => { actionMenuRefs.current[template.TemplateId] = el; }}
                          data-action-button
                          onClick={(e) => handleActionMenuClick(template.TemplateId, e)}
                          className="p-1 text-gray-400 hover:text-gray-600"
                          title="Actions"
                        >
                          <MoreVertical className="h-4 w-4" />
                        </button>

                        {/* Action Menu Dropdown - portal so not clipped by table/overflow; high z so in front */}
                        {openActionMenuId === template.TemplateId && actionMenuPosition && createPortal(
                          <div
                            data-action-menu
                            className="fixed w-48 bg-white rounded-lg shadow-lg border border-gray-200 z-[9999] overflow-y-auto"
                            style={{
                              top: actionMenuPosition.y,
                              left: actionMenuPosition.x,
                              ...(actionMenuPosition.maxHeight != null && { maxHeight: actionMenuPosition.maxHeight })
                            }}
                          >
                            <div className="py-1">
                              <button
                                onClick={() => {
                                  setSelectedTemplate(template);
                                  setViewDialogOpen(true);
                                  setOpenActionMenuId(null);
                                  setActionMenuPosition(null);
                                }}
                                className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 flex items-center gap-2"
                              >
                                <Eye className="h-4 w-4" />
                                View Details
                              </button>

                              {roleConfig.canEditTemplates && (
                                <>
                                  <button
                                    onClick={async () => {
                                      setOpenActionMenuId(null);
                                      setActionMenuPosition(null);
                                      await handleDuplicate(template);
                                    }}
                                    className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 flex items-center gap-2"
                                  >
                                    <Copy className="h-4 w-4" />
                                    Duplicate
                                  </button>
                                  <button
                                    onClick={() => {
                                      setSelectedTemplate(template);
                                      setEditDialogOpen(true);
                                      setOpenActionMenuId(null);
                                      setActionMenuPosition(null);
                                    }}
                                    className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 flex items-center gap-2"
                                  >
                                    <Edit className="h-4 w-4" />
                                    Edit
                                  </button>
                                </>
                              )}

                              {roleConfig.canDeleteTemplates && (
                                <>
                                  <div className="border-t border-gray-100 my-1"></div>
                                  <button
                                    onClick={() => {
                                      setSelectedTemplate(template);
                                      setDeleteDialogOpen(true);
                                      setOpenActionMenuId(null);
                                      setActionMenuPosition(null);
                                    }}
                                    className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 flex items-center gap-2"
                                  >
                                    <Trash2 className="h-4 w-4" />
                                    Delete Link
                                  </button>
                                </>
                              )}
                            </div>
                          </div>,
                          document.body
                        )}
                      </div>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      
      {/* Pagination */}
      {pagination && pagination.totalPages > 1 && (
        <Pagination
          currentPage={pagination.currentPage}
          totalPages={pagination.totalPages}
          onPageChange={handlePageChange}
          hasNextPage={pagination.hasNextPage}
          hasPreviousPage={pagination.hasPreviousPage}
        />
      )}
    </div>
  );


  // Main Render
  return (
    <div className="p-6">
      {/* Action Buttons */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <button
              onClick={() => loadTemplates()}
              disabled={loading}
              className="border border-gray-300 text-gray-700 px-4 py-2 rounded-lg hover:bg-gray-50 transition-colors flex items-center gap-2"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            
          </div>
          
          <div className="relative">
            {roleConfig.canCreateTemplates && (
              <>
                <button
                  onClick={handleOpenCreateDialog}
                  disabled={!canCreateEnrollmentLink}
                  className={`px-4 py-2 rounded-lg transition-colors flex items-center gap-2 focus:outline-none focus:ring-2 focus:ring-offset-2 ${
                    canCreateEnrollmentLink
                      ? 'bg-oe-primary text-white hover:bg-oe-dark focus:ring-oe-primary'
                      : 'bg-gray-300 text-gray-600 cursor-not-allowed focus:ring-gray-300'
                  }`}
                >
                  <Plus className="h-4 w-4" />
                  New Enrollment Link
                </button>
                {isAgent && (
                  showW9RequirementNotice ? (
                    <W9RequirementNotice
                      isChecking={checkingAgentW9}
                      isMissing={!agentHasW9}
                      targetLabel="enrollment links"
                      onFix={handleFixW9Requirement}
                      className="absolute top-full right-0 mt-1 z-10"
                    />
                  ) : (
                    <ProfileCompletionNotice
                      isChecking={checkingProfileCompletion}
                      isIncomplete={showProfileCompletionNotice}
                      onFix={handleFixProfileCompletion}
                      className="absolute top-full right-0 mt-1 z-10"
                      checkingLabel="Checking W-9 and banking..."
                      incompleteLabel="W-9 and banking required"
                    />
                  )
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Filters - Always visible */}
      {renderFilters()}

      {/* Table */}
      {renderTable()}

      {/* View Dialog */}
      <SimpleModal
        isOpen={viewDialogOpen}
        onClose={() => setViewDialogOpen(false)}
        title="Template Details"
        size="medium"
      >
        {selectedTemplate && (() => {
          let parsedMetadata;
          try {
            parsedMetadata = JSON.parse(selectedTemplate.LinkMetaData);
          } catch (error) {
            parsedMetadata = { household: {}, products: [] };
          }

          const products = parsedMetadata.products || [];

          const getProductTypeIcon = (productType: string) => {
            switch (productType?.toLowerCase()) {
              case 'medical':
              case 'healthcare':
                return '🏥';
              case 'dental':
                return '🦷';
              case 'vision':
                return '👁️';
              case 'life':
              case 'life insurance':
                return '❤️';
              case 'disability':
                return '♿';
              case 'accident':
                return '🚑';
              case 'critical illness':
                return '⚕️';
              case 'hospital indemnity':
                return '🏨';
              case 'telemedicine':
              case 'telemed':
                return '📱';
              default:
                return '📋';
            }
          };

          return (
            <div className="space-y-6">
              {/* Basic Information */}
              <div className="bg-gray-50 rounded-lg p-4">
                <h4 className="text-sm font-semibold text-gray-900 mb-3">Basic Information</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">
                      Link Name
                    </label>
                    <p className="text-sm text-gray-900">{EnrollmentLinkTemplatesService.getDisplayTemplateName(selectedTemplate.TemplateName)}</p>
                  </div>
                  
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">
                      Type
                    </label>
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${EnrollmentLinkTemplatesService.getTypeColor(selectedTemplate.TemplateType)}`}>
                      {getTypeIcon(selectedTemplate.TemplateType)}
                      <span className="ml-1">{selectedTemplate.TemplateType}</span>
                    </span>
                  </div>
                  
                  {roleConfig.showTenantColumn && (
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">
                        Tenant
                      </label>
                      <p className="text-sm text-gray-900">{selectedTemplate.TenantName}</p>
                    </div>
                  )}
                  
                  {roleConfig.showAgentColumn && selectedTemplate.AgentName && (
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">
                        Agent / Agency
                      </label>
                      <p className="text-sm text-gray-900">{selectedTemplate.AgentName}</p>
                    </div>
                  )}

                  {showStatusColumn && (
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">
                        Status
                      </label>
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${EnrollmentLinkTemplatesService.getStatusColor(selectedTemplate.IsActive)}`}>
                        {selectedTemplate.IsActive ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                  )}

                  
                  {selectedTemplate.Description && (
                    <div className="md:col-span-2">
                      <label className="block text-xs font-medium text-gray-500 mb-1">
                        Description
                      </label>
                      <p className="text-sm text-gray-900">{selectedTemplate.Description}</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Product Sections */}
              <div className="bg-gray-50 rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold text-gray-900">Product Sections</h4>
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
                    {products.length} {products.length === 1 ? 'section' : 'sections'}
                  </span>
                </div>
                {products.length > 0 ? (
                  <div className="space-y-2">
                    {products.map((product: any, index: number) => (
                      <div key={index} className="bg-white rounded-lg p-3 border border-gray-200">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center space-x-2 mb-1">
                              <span className="text-base">{getProductTypeIcon(product.productType)}</span>
                              <h5 className="text-sm font-medium text-gray-900">{product.page}</h5>
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                                {product.productType}
                              </span>
                            </div>
                            {product.description && (
                              <p className="text-xs text-gray-500 ml-6">{product.description}</p>
                            )}
                            <div className="text-xs text-gray-500 ml-6 mt-1">
                              {product.sectionType === 'bundles' ? (
                                product.includeAllBundles ? (
                                  <span className="text-green-600">✓ All bundles included</span>
                                ) : (
                                  <>
                                    <span>{product.specificBundles?.length || 0} specific bundles</span>
                                    {(product.specificBundles || []).length > 0 && (
                                      <ul className="list-disc list-inside mt-1 space-y-0.5">
                                        {(product.specificBundles as string[]).map((bundleId) => (
                                          <li key={bundleId} className="text-gray-700">
                                            {productNameById.get(String(bundleId)) || 'Unknown bundle'}
                                          </li>
                                        ))}
                                      </ul>
                                    )}
                                  </>
                                )
                              ) : (
                                product.includeAllProducts ? (
                                  <span className="text-green-600">✓ All products included</span>
                                ) : (
                                  <>
                                    <span>{product.specificProducts?.length || 0} specific products</span>
                                    {(product.specificProducts || []).length > 0 && (
                                      <ul className="list-disc list-inside mt-1 space-y-0.5">
                                        {(product.specificProducts as string[]).map((productId) => (
                                          <li key={productId} className="text-gray-700">
                                            {productNameById.get(String(productId)) || 'Unknown product'}
                                          </li>
                                        ))}
                                      </ul>
                                    )}
                                  </>
                                )
                              )}
                            </div>
                          </div>
                          <span className="text-xs text-gray-400 ml-4">#{index + 1}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-gray-500">No product sections configured</p>
                )}
              </div>

              {/* Creation/Modification Info */}
              <div className="bg-gray-50 rounded-lg p-4">
                <h4 className="text-sm font-semibold text-gray-900 mb-3">Metadata</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                  <div>
                    <label className="block font-medium text-gray-500 mb-1">Created</label>
                    <p className="text-gray-900">{EnrollmentLinkTemplatesService.formatDate(selectedTemplate.CreatedDate)}</p>
                    <p className="text-gray-500">by {selectedTemplate.CreatedByName}</p>
                  </div>
                  <div>
                    <label className="block font-medium text-gray-500 mb-1">Last Modified</label>
                    <p className="text-gray-900">{EnrollmentLinkTemplatesService.formatDate(selectedTemplate.ModifiedDate)}</p>
                    <p className="text-gray-500">by {selectedTemplate.ModifiedByName}</p>
                  </div>
                </div>
              </div>
              
              <div className="flex justify-end">
                <button
                  onClick={() => setViewDialogOpen(false)}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
                >
                  Close
                </button>
              </div>
            </div>
          );
        })()}
      </SimpleModal>

      {/* Delete Confirmation Dialog */}
      <SimpleModal
        isOpen={deleteDialogOpen}
        onClose={() => setDeleteDialogOpen(false)}
        title="Confirm Delete"
        size="small"
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-900">
            Are you sure you want to delete the template "{selectedTemplate ? EnrollmentLinkTemplatesService.getDisplayTemplateName(selectedTemplate.TemplateName) : ''}"?
          </p>
          
          {/* Warning about enrollment links - ALWAYS SHOW */}
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <div className="flex items-start">
              <div className="flex-shrink-0">
                <svg className="h-5 w-5 text-yellow-600" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.19-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                </svg>
              </div>
              <div className="ml-3">
                <h3 className="text-sm font-medium text-yellow-800">
                  ⚠️ Warning: Cascade Delete
                </h3>
                <div className="mt-2 text-sm text-yellow-700">
                  <p className="font-semibold">
                    All enrollment links using this template will be permanently deleted and become invalid immediately.
                  </p>
                </div>
              </div>
            </div>
          </div>
          
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-sm text-red-800 font-medium">
              ⛔ This action cannot be undone. The template and ALL associated enrollment links will be permanently deleted from the database.
            </p>
          </div>
          
          <div className="flex justify-end space-x-3">
            <button
              onClick={() => setDeleteDialogOpen(false)}
              className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
              className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50"
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete Link'}
            </button>
          </div>
        </div>
      </SimpleModal>

      {/* Create Dialog */}
      <SimpleModal
        isOpen={createDialogOpen}
        onClose={() => {
          setCreateDialogOpen(false);
          setStaticLinkMode(false);
          setMarketingLinkMode(false);
        }}
        title={staticLinkMode ? "Create Static Enrollment Link" : marketingLinkMode ? "Create Marketing Enrollment Link" : "Create Enrollment Link"}
        size="large"
      >
        <EnrollmentLinkWizard
          onSave={handleCreate}
          onCancel={() => {
            setCreateDialogOpen(false);
            setStaticLinkMode(false);
            setMarketingLinkMode(false);
          }}
          onFixLicenses={handleFixLicenses}
          staticLinkMode={staticLinkMode}
          marketingLinkMode={marketingLinkMode}
        />
      </SimpleModal>

      {/* Edit Dialog */}
      <SimpleModal
        isOpen={editDialogOpen}
        onClose={() => {
          setEditDialogOpen(false);
          setStaticLinkMode(false);
        }}
        title={staticLinkMode ? "Edit Static Enrollment Link" : "Edit Enrollment Link"}
        size="large"
      >
        {selectedTemplate && (
          <EnrollmentLinkWizard
            template={selectedTemplate}
            onSave={handleEdit}
            onCancel={() => {
              setEditDialogOpen(false);
              setStaticLinkMode(false);
              setMarketingLinkMode(false);
            }}
            onFixLicenses={handleFixLicenses}
            isEditing={true}
            staticLinkMode={staticLinkMode}
            marketingLinkMode={marketingLinkMode}
          />
        )}
      </SimpleModal>

      {/* Quick Send Modal for Individual Templates */}
      {showQuickSendModal && (
        <QuickEnrollmentLinkModal
          open={showQuickSendModal}
          onClose={() => {
            setShowQuickSendModal(false);
            setTemplateForQuickSend(null);
            setPrefillQuickSendMember(null);
          }}
          templateId={templateForQuickSend?.TemplateId}
          initialAgentId={templateForQuickSend?.AgentId || templateForQuickSend?.AgencyId || undefined}
          initialAgentName={templateForQuickSend?.AgentName || undefined}
          prefillMember={prefillQuickSendMember || undefined}
          onLinkSent={() => {
            setShowQuickSendModal(false);
            setTemplateForQuickSend(null);
            setPrefillQuickSendMember(null);
            setSuccess('Enrollment link sent successfully!');
            loadTemplates(); // Refresh templates list
          }}
        />
      )}

      {/* Group Template Message Modal */}
      {groupTemplateMessage && (
        <SimpleModal
          isOpen={!!groupTemplateMessage}
          onClose={() => setGroupTemplateMessage(null)}
          title="Group Enrollment Link"
          size="small"
        >
          <div className="space-y-4">
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <div className="flex items-start">
                <div className="flex-shrink-0">
                  <Users className="h-5 w-5 text-yellow-600" />
                </div>
                <div className="ml-3">
                  <h3 className="text-sm font-medium text-yellow-800">
                    Group Enrollment Link
                  </h3>
                  <div className="mt-2 text-sm text-yellow-700">
                    <p>
                      This link must be sent out from the group portal for this group.
                    </p>
                  </div>
                </div>
              </div>
            </div>
            
            <div className="flex justify-end space-x-3">
              <button
                onClick={() => setGroupTemplateMessage(null)}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
              >
                Cancel
              </button>
              {groupTemplateMessage.groupId ? (
                <button
                  onClick={() => handleGoToGroup(groupTemplateMessage.groupId)}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700"
                >
                  Take me there
                </button>
              ) : (
                <div className="px-4 py-2 text-sm text-gray-500">
                  Group ID not available
                </div>
              )}
            </div>
          </div>
        </SimpleModal>
      )}

      {/* Static Link Copy Modal */}
      {staticLinkCopyModal && (
        <SimpleModal
          isOpen={!!staticLinkCopyModal}
          onClose={() => {
            setStaticLinkCopyModal(null);
            setStaticLinkCopiedFeedback(false);
          }}
          title="Static Enrollment Link"
          size="small"
        >
          <div className="p-6">
            <div className="mb-4">
              <p className="text-sm text-gray-600 mb-2">
                Copy this static enrollment link to share with members:
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm break-all">
                  {staticLinkCopyModal.linkUrl}
                </code>
                <button
                  onClick={handleCopyStaticLink}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 flex items-center gap-2 whitespace-nowrap"
                >
                  <Copy className="h-4 w-4" />
                  {staticLinkCopiedFeedback ? 'Copied!' : 'Copy Link'}
                </button>
              </div>
            </div>
            <div className="flex justify-end">
              <button
                onClick={() => {
                  setStaticLinkCopyModal(null);
                  setStaticLinkCopiedFeedback(false);
                }}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
              >
                Close
              </button>
            </div>
          </div>
        </SimpleModal>
      )}

      {/* Marketing Link Copy Modal */}
      {marketingLinkCopyModal && (
        <SimpleModal
          isOpen={!!marketingLinkCopyModal}
          onClose={() => setMarketingLinkCopyModal(null)}
          title="Marketing Enrollment Link"
          size="small"
        >
          <div className="p-6">
            <div className="mb-4">
              <p className="text-sm text-gray-600 mb-2">
                Copy this marketing enrollment link to share on your website:
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm break-all">
                  {marketingLinkCopyModal.linkUrl}
                </code>
                <button
                  onClick={handleCopyMarketingLink}
                  className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 flex items-center gap-2 whitespace-nowrap"
                >
                  <Copy className="h-4 w-4" />
                  Copy Link
                </button>
              </div>
            </div>
            <div className="flex justify-end">
              <button
                onClick={() => setMarketingLinkCopyModal(null)}
                className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
              >
                Close
              </button>
            </div>
          </div>
        </SimpleModal>
      )}

      {/* Manual copy fallback modal — shown when automatic clipboard write is blocked */}
      {manualCopyModal && (
        <ManualCopyModal
          isOpen={!!manualCopyModal}
          onClose={() => setManualCopyModal(null)}
          title={manualCopyModal.title}
          description={manualCopyModal.description}
          linkUrl={manualCopyModal.linkUrl}
        />
      )}

      {/* Success / error toasts — fixed bottom so visible without scrolling long pages */}
      <div
        className="fixed bottom-6 left-1/2 z-[100] max-w-lg w-[calc(100%-2rem)] -translate-x-1/2 flex flex-col-reverse gap-3 pointer-events-none"
        aria-live="polite"
      >
        {(queryError || mutationError) && (
          <div
            role="alert"
            className="pointer-events-auto bg-red-50 border border-red-200 rounded-lg p-4 shadow-lg flex justify-between items-start gap-3"
          >
            <p className="text-sm font-medium text-red-800 flex-1 min-w-0 break-words">
              {queryError ? (queryError as Error).message : mutationError}
            </p>
            <button
              type="button"
              onClick={() => {
                if (queryError) loadTemplates();
                setMutationError(null);
              }}
              className="text-red-500 hover:text-red-700 flex-shrink-0"
              aria-label="Dismiss error"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        {success && (
          <div className="pointer-events-auto bg-green-50 border border-green-200 rounded-lg p-4 shadow-lg flex justify-between items-start gap-3">
            <p className="text-sm font-medium text-green-800 flex-1 min-w-0 break-words">{success}</p>
            <button
              type="button"
              onClick={() => setSuccess(null)}
              className="text-green-500 hover:text-green-700 flex-shrink-0"
              aria-label="Dismiss success message"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default EnrollmentLinkTemplates;
