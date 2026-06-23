/**
 * Agent Management Modal Component
 * Displays detailed agent information in a modal with tabs.
 * Used by TenantAdmin, Agent (AgencyOwner), and other roles from AgentsPage.
 */

import {
    AlertCircle,
    AtSign,
    Building,
    ArrowRightLeft,
    CheckCircle,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Clock,
    CreditCard,
    DollarSign,
    Download,
    Edit,
    ExternalLink,
    Eye,
    FileText,
    FileUp,
    KeyRound,
    Link,
    LogOut,
    Mail,
    MapPin,
    Megaphone,
    Pencil,
    Phone,
    Plus,
    Trash2,
    TrendingUp,
    Upload,
    GraduationCap,
    User,
    Users,
    X,
    XCircle
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { authService } from '../../services/auth.service';
import { EnrollmentLinkTemplatesService } from '../../services/enrollment-link-templates.service';

import CommissionRulesModal from '../../components/agents/CommissionRulesModal';
import AgentCommunicationsTab from './tabs/AgentCommunicationsTab';
import CommissionStatusBadge from '../../components/accounting/CommissionStatusBadge';
import PaymentCommissionRulesModal from '../../components/accounting/PaymentCommissionRulesModal';
import RelatedCommissionsModal from '../../components/accounting/RelatedCommissionsModal';
import ChangeEmailModal from '../../components/shared/ChangeEmailModal';
import SetTemporaryPasswordModal from '../../components/shared/SetTemporaryPasswordModal';
import SearchableDropdown from '../../components/common/SearchableDropdown';
import { getTierLevelLabel, getTierName, LICENSE_TYPES } from '../../constants/form-options';
import { useCommissionLevels } from '../../hooks/useCommissionLevels';
import { MAX_DOCUMENT_UPLOAD_MB } from '../../constants/uploads';
import { formatAgentLifecycleStatusLabel } from '../../utils/agentStatusDisplay';
import { apiService } from '../../services/api.service';
import TenantAdminAgentsService, {
    AgentBankInfo,
    AgentDetails,
    type AgentTrainingProgress,
    AgentHierarchy,
    CreateDocumentRequest,
    CreateLicenseRequest
} from '../../services/tenant-admin/agents.service';
import { toast } from 'react-hot-toast';
import AgentTenantMigrationWizard from '../../components/admin/AgentTenantMigrationWizard';
import { useTenantsForDropdown } from '../../hooks/useEnrollmentLinkTemplates';

interface AgentManagementModalProps {
  agentId: string;
  isOpen: boolean;
  onClose: () => void;
  onUpdate?: () => void;
  availableAgencies?: any[];
  /** When provided (e.g. from AgentsPage), downline rows show Rules/Links/Edit/View like the agent portal */
  onViewCommissionRules?: (type: 'Agent' | 'Agency', id: string, name: string) => void;
  onViewLinks?: (type: 'Agent' | 'Agency', id: string, name: string) => void;
  /** Open "Add Downline" / manage onboarding links for this agent (e.g. from AgentsPage or tenant-admin) */
  onManageDownlineLinks?: (agentId: string, agentName: string) => void;
  onSelectAgent?: (agentId: string) => void;
  currentRole?: string;
  canManageAgencies?: boolean;
  /** When set, open to this tab */
  initialTab?: 'contact' | 'licenses' | 'documents' | 'banking' | 'commission' | 'commissions' | 'advances' | 'enrollment-links' | 'training' | 'sessions' | 'communications';
  /** When opening from Commissions tab, pass current user tier for Agent role (e.g. from AgentsPage). */
  currentUserTierLevel?: number | null;
  /**
   * SysAdmin on /admin/agents: tenant from page picker. API calls use this instead of
   * the SysAdmin user's profile/localStorage tenantId.
   */
  explicitTenantId?: string | null;
}

const AgentManagementModal: React.FC<AgentManagementModalProps> = ({ 
  agentId, 
  isOpen, 
  onClose,
  onUpdate,
  availableAgencies: propAvailableAgencies = [],
  onViewCommissionRules,
  onViewLinks,
  onManageDownlineLinks,
  onSelectAgent,
  currentRole: propCurrentRole,
  canManageAgencies: propCanManageAgencies = false,
  initialTab: propInitialTab,
  currentUserTierLevel: propCurrentUserTierLevel,
  explicitTenantId: propExplicitTenantId
}) => {
  const { user } = useAuth();
  const currentRole = propCurrentRole ?? user?.currentRole ?? 'Agent';
  const scopedTenantId =
    currentRole === 'SysAdmin' && propExplicitTenantId?.trim()
      ? propExplicitTenantId.trim()
      : undefined;
  // Tenant-configured commission level names — header tier pill uses this so
  // it matches the rest of the commission UI (simulator, breakdown modals).
  const { displayNameByLevel: tierLevelDisplayNames } = useCommissionLevels({
    tenantId: scopedTenantId
  });
  const { data: allTenants = [] } = useTenantsForDropdown();
  const [showTenantMigrationWizard, setShowTenantMigrationWizard] = useState(false);
  // State management
  const [agent, setAgent] = useState<AgentDetails | null>(null);
  const [downline, setDownline] = useState<AgentHierarchy[]>([]);
  const [upline, setUpline] = useState<AgentHierarchy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const [activeTab, setActiveTab] = useState<'contact' | 'licenses' | 'documents' | 'banking' | 'commission' | 'commissions' | 'advances' | 'enrollment-links' | 'training' | 'sessions' | 'communications'>('contact');
  const [enrollmentTemplates, setEnrollmentTemplates] = useState<any[]>([]);
  const [enrollmentTemplatesLoading, setEnrollmentTemplatesLoading] = useState(false);
  const [trainingProgress, setTrainingProgress] = useState<AgentTrainingProgress | null>(null);
  const [trainingLoading, setTrainingLoading] = useState(false);
  const [trainingError, setTrainingError] = useState<string | null>(null);
  const [trainingQuizPackageFilter, setTrainingQuizPackageFilter] = useState<string>('all');
  const navigate = useNavigate();
  const canManageAgencies = propCanManageAgencies;
  const isUplineView = currentRole === 'Agent' && !canManageAgencies;

  // Tab scroll state
  const tabScrollRef = useRef<HTMLDivElement>(null);
  const [tabCanScrollRight, setTabCanScrollRight] = useState(false);
  const [tabCanScrollLeft, setTabCanScrollLeft] = useState(false);

  const checkTabScroll = useCallback(() => {
    const el = tabScrollRef.current;
    if (!el) return;
    setTabCanScrollLeft(el.scrollLeft > 4);
    setTabCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    checkTabScroll();
    const el = tabScrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', checkTabScroll, { passive: true });
    const ro = new ResizeObserver(checkTabScroll);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', checkTabScroll); ro.disconnect(); };
  }, [checkTabScroll, agent]);
  const [isEditingContact, setIsEditingContact] = useState(false);
  const [contactForm, setContactForm] = useState({
    firstName: '',
    lastName: '',
    contactName: '', // For agencies
    email: '',
    phone: '',
    npn: '',
    businessName: '',
    idType: '',
    ssnOrTaxId: '',
    address: '',
    city: '',
    state: '',
    zipCode: '',
    commissionRole: ''
  });
  
  // Send password reset (footer action + Sessions tab)
  const [sendPasswordResetLoading, setSendPasswordResetLoading] = useState(false);
  const [sendPasswordResetMessage, setSendPasswordResetMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [setTempPasswordOpen, setSetTempPasswordOpen] = useState(false);

  // TenantAdmin-only: deactivate / reactivate the agent's account.
  // Sets oe.Agents.Status + oe.Users.Status to Active|Inactive via PUT /agents/:id.
  const [statusToggleConfirm, setStatusToggleConfirm] = useState<null | 'Inactive' | 'Active'>(null);
  const [statusToggling, setStatusToggling] = useState(false);
  const canToggleStatus = currentRole === 'TenantAdmin' || currentRole === 'SysAdmin';
  const [advancedActionsOpen, setAdvancedActionsOpen] = useState(false);
  const showAdvancedAgentActions =
    agent?.Type === 'Agent' &&
    (canToggleStatus || (currentRole === 'SysAdmin' && !!agent?.TenantId));

  const handleConfirmStatusToggle = async () => {
    if (!agentId || !statusToggleConfirm) return;
    setStatusToggling(true);
    try {
      const res = await TenantAdminAgentsService.updateAgent(agentId, { status: statusToggleConfirm });
      if (res.success) {
        const wasDeactivate = statusToggleConfirm === 'Inactive';
        toast.success(
          wasDeactivate
            ? 'Account deactivated. User can no longer log in.'
            : 'Account reactivated.'
        );
        setStatusToggleConfirm(null);
        // Refresh parent list so the new status is reflected.
        onUpdate?.();
        if (wasDeactivate) {
          // GET /agents/:id only returns Active rows. Reloading would 404 and
          // surface a stale "Agent or agency not found" error in the modal,
          // which conflicts with the success toast. Close the modal instead —
          // the deactivation is complete and there's nothing more to edit.
          onClose();
        } else {
          await loadAgentDetails();
        }
      } else {
        toast.error(res.message || 'Failed to update status.');
      }
    } catch (err: any) {
      toast.error(err?.message || 'Failed to update status.');
    } finally {
      setStatusToggling(false);
    }
  };

  // Hierarchy tab shows upline only (no downline section)
  
  // Hierarchy management state
  const [showChangeUplineModal, setShowChangeUplineModal] = useState(false);
  const [newUplineAgentId, setNewUplineAgentId] = useState<string>('');
  const [uplineDropdownOptions, setUplineDropdownOptions] = useState<{ id: string; label: string; value: string; email?: string }[]>([]);
  const [uplineSearchLoading, setUplineSearchLoading] = useState(false);
  const [selectedAgencyId, setSelectedAgencyId] = useState<string>('');
  // Cached downline count so we can tell the admin how many agents will move
  // when the agency is changed (cascade is applied server-side).
  const [downlineCount, setDownlineCount] = useState<number>(0);
  // Sub-modal-local error state so the error renders INSIDE the hierarchy
  // modal instead of on the parent (which would be hidden behind it).
  const [hierarchyError, setHierarchyError] = useState<string | null>(null);

  // When hierarchy modal opens, seed the agency selector with the current agency
  // and load the downline count for the cascade warning.
  useEffect(() => {
    if (showChangeUplineModal && agent?.AgencyId && !selectedAgencyId) {
      setSelectedAgencyId(agent.AgencyId);
    }
    if (showChangeUplineModal && agentId) {
      TenantAdminAgentsService.getAgentDownlineCount(agentId)
        .then(res => setDownlineCount(res?.data || 0))
        .catch(() => setDownlineCount(0));
    }
  }, [showChangeUplineModal, agent?.AgencyId, selectedAgencyId, agentId]);
  
  // Sub-modal states
  const [showAddLicenseModal, setShowAddLicenseModal] = useState(false);
  const [showAddDocumentModal, setShowAddDocumentModal] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadType, setUploadType] = useState<'license' | 'document'>('document');
  const [licenseForm, setLicenseForm] = useState<CreateLicenseRequest>({
    stateCode: '',
    licenseNumber: '',
    licenseType: '',
    expirationDate: '',
    issueDate: '',
    documentUrl: ''
  });
  
  const [documentForm, setDocumentForm] = useState<CreateDocumentRequest>({
    documentType: '',
    fileName: '',
    fileUrl: '',
    fileSize: 0,
    fileType: '',
    description: ''
  });

  const [bankForm, setBankForm] = useState({
    bankName: '',
    accountName: '',
    accountType: 'Checking',
    routingNumber: '',
    accountNumber: ''
  });

  const [existingBankInfo, setExistingBankInfo] = useState<AgentBankInfo | null>(null);
  const [showChangeEmailModal, setShowChangeEmailModal] = useState(false);

  // When modal opens with initialTab, switch to that tab
  useEffect(() => {
    if (isOpen && propInitialTab) {
      const tab = (propInitialTab === 'commission' ? 'commissions' : propInitialTab) as any;
      setActiveTab(tab);
    }
  }, [isOpen, propInitialTab]);

  // Load data when modal opens
  useEffect(() => {
    if (isOpen && agentId) {
      loadAgentDetails();
      // loadBankInfo will be called conditionally after agent details are loaded
    }
  }, [isOpen, agentId]);

  // Load agent details
  const loadAgentDetails = async () => {
    try {
      setLoading(true);
      setError(null);
      
      // Load agent details
      const detailsResponse = await TenantAdminAgentsService.getAgentDetails(agentId);
      
      if (detailsResponse.success && detailsResponse.data) {
        setAgent(detailsResponse.data);
        
        // Populate contact form for editing
        const agentData = detailsResponse.data;
        if (agentData.Type === 'Agency') {
          setContactForm({
            firstName: '',
            lastName: '',
            contactName: agentData.ContactName || '',
            email: agentData.Email || '',
            phone: agentData.Phone || '',
            npn: '',
            businessName: '',
            idType: '',
            ssnOrTaxId: '',
            address: agentData.Address || '',
            city: agentData.City || '',
            state: agentData.State || '',
            zipCode: agentData.ZipCode || '',
            commissionRole: agentData.CommissionRole || ''
          });
          
          // Populate ACH/bank form for agencies from the API response
          if (agentData.BankName || agentData.AccountHolderName || agentData.AchRoutingNumber || agentData.AchAccountNumber) {
            // ACH data is available from the API response - show the full
            // (decrypted) account number so tenant admins can view it.
            setBankForm({
              bankName: agentData.BankName || '',
              accountName: agentData.AccountHolderName || '',
              accountType: agentData.AccountType || 'Checking',
              routingNumber: agentData.AchRoutingNumber || '',
              accountNumber: agentData.AchAccountNumber || ''
            });
            
            // Set existing bank info for display
            if (agentData.AchAccountNumber) {
              setExistingBankInfo({
                BankInfoId: agentData.Id || '',
                AgentId: agentData.Id || '',
                BankName: agentData.BankName || '',
                AccountName: agentData.AccountHolderName || '',
                AccountType: (agentData.AccountType || 'Checking') as 'Checking' | 'Savings',
                RoutingNumber: agentData.AchRoutingNumber || '',
                AccountNumberLast4: agentData.AchAccountNumber.slice(-4) || '',
                Status: 'Active' as 'Active' | 'Inactive' | 'Pending',
                IsDefault: true,
                VerificationStatus: 'Verified' as 'Pending' | 'Verified' | 'Failed',
                CreatedDate: new Date().toISOString(),
                ModifiedDate: new Date().toISOString()
              });
            }
          } else {
            // No ACH data, reset form
            setBankForm({
              bankName: '',
              accountName: '',
              accountType: 'Checking',
              routingNumber: '',
              accountNumber: ''
            });
            setExistingBankInfo(null);
          }
        } else {
          setContactForm({
            firstName: agentData.FirstName || '',
            lastName: agentData.LastName || '',
            contactName: '',
            email: agentData.Email || '',
            phone: agentData.Phone || '',
            npn: agentData.NPN || '',
            businessName: agentData.BusinessName || '',
            idType: agentData.IDType || '',
            ssnOrTaxId: agentData.SSNOrTaxID || '',
            address: agentData.Address || '',
            city: agentData.City || '',
            state: agentData.State || '',
            zipCode: agentData.ZipCode || '',
            commissionRole: agentData.Role || 'Agent',
          });
        }
        
        // Load bank info only for Agents, not Agencies (agencies use data from API response above)
        if (detailsResponse.data.Type === 'Agent') {
          loadBankInfo();
        } else {
          // For agencies, default to 'contact' tab since agent-specific tabs won't be available
          if (['licenses', 'enrollment-links', 'training'].includes(activeTab)) {
            setActiveTab('contact');
          }
        }
      } else {
        throw new Error(detailsResponse.message || 'Failed to load agent details');
      }
      
      // Load hierarchy data - only for agents, not agencies
      if (detailsResponse.data?.Type === 'Agent') {
        // Load downline
        try {
          const downlineResponse = await TenantAdminAgentsService.getAgentDownline(agentId);
          if (downlineResponse.success && downlineResponse.data) {
            setDownline(downlineResponse.data);
          }
        } catch (downlineError) {
          setDownline([]);
        }

        // Load upline
        try {
          const uplineResponse = await TenantAdminAgentsService.getAgentUpline(agentId);
          if (uplineResponse.success && uplineResponse.data) {
            setUpline(uplineResponse.data);
          }
        } catch (uplineError) {
          setUpline([]);
        }
      } else {
        // Skip hierarchy load for agencies
        setDownline([]);
        setUpline([]);
      }
      
    } catch (err: any) {
      console.error('🔍 MODAL - Error loading agent details:', err);
      setError(err.message || 'Failed to load agent details');
    } finally {
      setLoading(false);
    }
  };

  // Load enrollment link templates when Enrollment Links tab is active (Agent type only)
  useEffect(() => {
    if (!isOpen || activeTab !== 'enrollment-links' || !agentId || agent?.Type !== 'Agent') return;
    const currentRole = user?.currentRole || 'Agent';
    let cancelled = false;
    setEnrollmentTemplatesLoading(true);
    EnrollmentLinkTemplatesService.getTemplates(
      {
        agentId,
        limit: 20,
        isActive: true,
        ...(currentRole === 'SysAdmin' && scopedTenantId
          ? { tenantName: scopedTenantId }
          : {})
      },
      currentRole
    )
      .then((res) => {
        if (cancelled) return;
        if (res.success && res.data?.data) {
          setEnrollmentTemplates(res.data.data);
        } else {
          setEnrollmentTemplates([]);
        }
      })
      .catch(() => {
        if (!cancelled) setEnrollmentTemplates([]);
      })
      .finally(() => {
        if (!cancelled) setEnrollmentTemplatesLoading(false);
      });
    return () => { cancelled = true; };
  }, [isOpen, activeTab, agentId, agent?.Type, user?.currentRole, scopedTenantId]);

  useEffect(() => {
    if (!isOpen) {
      setTrainingProgress(null);
      setTrainingError(null);
      setTrainingLoading(false);
      setTrainingQuizPackageFilter('all');
      setAdvancedActionsOpen(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || activeTab !== 'training' || !agentId || agent?.Type !== 'Agent') return;
    let cancelled = false;
    setTrainingLoading(true);
    setTrainingError(null);
    TenantAdminAgentsService.getAgentTrainingProgress(agentId)
      .then(res => {
        if (cancelled) return;
        if (res.success && res.data) {
          setTrainingProgress(res.data);
        } else {
          setTrainingProgress(null);
          setTrainingError(res.message || 'Failed to load training progress');
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setTrainingProgress(null);
          setTrainingError(e instanceof Error ? e.message : 'Failed to load training progress');
        }
      })
      .finally(() => {
        if (!cancelled) setTrainingLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, activeTab, agentId, agent?.Type]);

  const trainingQuizRowsFiltered = useMemo(() => {
    if (!trainingProgress?.libraryQuizzes?.length) return [];
    if (trainingQuizPackageFilter === 'all') return trainingProgress.libraryQuizzes;
    return trainingProgress.libraryQuizzes.filter(q => q.packageId === trainingQuizPackageFilter);
  }, [trainingProgress, trainingQuizPackageFilter]);

  const trainingQuizPackageOptions = useMemo(() => {
    if (!trainingProgress?.libraryQuizzes?.length) return [] as { id: string; title: string }[];
    const map = new Map<string, string>();
    trainingProgress.libraryQuizzes.forEach(q => {
      if (!map.has(q.packageId)) map.set(q.packageId, q.packageTitle);
    });
    return [...map.entries()].map(([id, title]) => ({ id, title }));
  }, [trainingProgress]);

  // Handle contact details editing
  const handleSaveContactDetails = async () => {
    if (!agentId || !agent) return;
    
    try {
      setLoading(true);
      setError(null);
      
      let response;
      if (agent.Type === 'Agency') {
        // Update agency
        response = await TenantAdminAgentsService.updateAgency(agentId, {
          agencyName: agent.Name || '', // Required field
          contactName: contactForm.contactName,
          contactEmail: contactForm.email,
          contactPhone: contactForm.phone,
          address: contactForm.address,
          city: contactForm.city,
          state: contactForm.state,
          zipCode: contactForm.zipCode,
          commissionRole: contactForm.commissionRole
        });
      } else {
        // Update agent
        response = await TenantAdminAgentsService.updateAgent(agentId, {
          firstName: contactForm.firstName,
          lastName: contactForm.lastName,
          email: contactForm.email,
          phone: contactForm.phone,
          npn: contactForm.npn,
          businessName: contactForm.businessName,
          idType: contactForm.idType,
          ssnOrTaxId: contactForm.ssnOrTaxId,
          address: contactForm.address,
          city: contactForm.city,
          state: contactForm.state,
          zipCode: contactForm.zipCode,
          commissionRole: contactForm.commissionRole
        });
      }
      
      if (response.success) {
        setIsEditingContact(false);
        await loadAgentDetails(); // Reload to get updated data
        onUpdate?.();
      } else {
        setError(response.message || 'Failed to update agent details');
      }
    } catch (err: any) {
      console.error('Error saving contact details:', err);
      setError(err.message || 'Failed to save contact details');
    } finally {
      setLoading(false);
    }
  };

  const handleCancelEdit = () => {
    // Reset form to original agent/agency data
    if (agent) {
      if (agent.Type === 'Agency') {
        setContactForm({
          firstName: '',
          lastName: '',
          contactName: agent.ContactName || '',
          email: agent.Email || '',
          phone: agent.Phone || '',
          npn: '',
          businessName: '',
          idType: '',
          ssnOrTaxId: '',
          address: agent.Address || '',
          city: agent.City || '',
          state: agent.State || '',
          zipCode: agent.ZipCode || '',
          commissionRole: agent.CommissionRole || ''
        });
      } else {
        setContactForm({
          firstName: agent.FirstName || '',
          lastName: agent.LastName || '',
          contactName: '',
          email: agent.Email || '',
          phone: agent.Phone || '',
          npn: agent.NPN || '',
          businessName: agent.BusinessName || '',
          idType: agent.IDType || '',
          ssnOrTaxId: agent.SSNOrTaxID || '',
          address: agent.Address || '',
          city: agent.City || '',
          state: agent.State || '',
          zipCode: agent.ZipCode || '',
          commissionRole: agent.Role || 'Agent',
        });
      }
    }
    setIsEditingContact(false);
  };

  // Helper function to mask SSN/Tax ID
  const maskSSNOrTaxID = (value: string, idType: string) => {
    if (!value) return '';
    if (idType === 'SSN' && value.length >= 4) {
      return '•••-••-' + value.slice(-4);
    }
    return value; // For EIN, show full value or implement masking as needed
  };

  // Load bank information - FIXED to handle 404 gracefully
  const loadBankInfo = async () => {
    if (!agentId) return;
    
    try {
      const response = await TenantAdminAgentsService.getBankInfo(agentId);
      
      if (response.success && response.data) {
        setExistingBankInfo(response.data);

        // Pre-populate form with existing data, including the full
        // (decrypted) account number so tenant admins can view it.
        const fullAccountNumber =
          (response.data as any)?.AccountNumber ||
          (response.data?.AccountNumberLast4 ? `••••${response.data.AccountNumberLast4}` : '');

        setBankForm(prev => ({
          ...prev,
          bankName: response.data?.BankName || '',
          accountName: response.data?.AccountName || '',
          accountType: response.data?.AccountType || 'Checking',
          routingNumber: response.data?.RoutingNumber || '',
          accountNumber: fullAccountNumber
        }));
      } else {
        setExistingBankInfo(null);
        // Don't set error for this case - it's normal to not have bank info
      }
    } catch (err: any) {
      // Error already logged by service - just clear existing bank info
      setExistingBankInfo(null);
      
      // Only set error if it's not a 404 (agent doesn't have bank info yet)
      if (err.response?.status !== 404) {
        setError(err.message || 'Failed to load bank information');
      }
    }
  };

  // Query agents by agency for upline dropdown (used by SearchableDropdown onSearch)
  const handleUplineAgentSearch = async (query: string) => {
    const agencyId = selectedAgencyId || agent?.AgencyId;
    if (!agencyId) {
      setUplineDropdownOptions([]);
      return;
    }
    try {
      setUplineSearchLoading(true);
      const response = await TenantAdminAgentsService.getAgentsByAgency(agencyId, query.trim() || undefined, 50);
      const list = (response.success && response.data ? response.data : []) as any[];
      const excludeAgentId = agentId;
      const options: { id: string; label: string; value: string; email?: string }[] = [
        { id: 'none', label: 'No upline (Top level)', value: 'none' }
      ];
      list.forEach((a: any) => {
        if (a.AgentId && a.AgentId !== excludeAgentId) {
          const name = `${(a.FirstName || '').trim()} ${(a.LastName || '').trim()}`.trim() || a.Email || `Agent ${a.AgentId}`;
          options.push({
            id: a.AgentId,
            label: name,
            value: a.AgentId,
            email: a.Email
          });
        }
      });
      setUplineDropdownOptions(options);
    } catch (err: any) {
      console.error('Error searching agents for upline:', err);
      setUplineDropdownOptions([{ id: 'none', label: 'No upline (Top level)', value: 'none' }]);
    } finally {
      setUplineSearchLoading(false);
    }
  };


  // Handle saving hierarchy edits. Supports any of:
  //   - Changing the agent's agency (cascades AgencyId to all downlines server-side)
  //   - Changing the agent's upline within the same agency
  //   - Both at once (agency change is applied first, then upline is set inside the new agency)
  const handleChangeUpline = async () => {
    const agencyChanged = !!selectedAgencyId && selectedAgencyId !== agent?.AgencyId;
    const uplineChanged = !!newUplineAgentId;

    if (!agencyChanged && !uplineChanged) {
      setHierarchyError('Select a new agency or a new upline agent before confirming');
      return;
    }

    try {
      setLoading(true);
      setHierarchyError(null);

      let cascadeMessage: string | null = null;

      if (agencyChanged) {
        const agencyResponse = await TenantAdminAgentsService.updateAgent(agentId, {
          agencyId: selectedAgencyId
        });
        if (!agencyResponse.success) {
          setHierarchyError(agencyResponse.message || 'Failed to update agency');
          return;
        }
        const cascaded = (agencyResponse.data as any)?.cascadedDownlineCount ?? 0;
        if (cascaded > 0) {
          cascadeMessage = `Moved ${cascaded} downline ${cascaded === 1 ? 'agent' : 'agents'} to the new agency.`;
        }
      }

      if (uplineChanged) {
        const uplineResponse = await TenantAdminAgentsService.updateAgentUpline(agentId, newUplineAgentId);
        if (!uplineResponse.success) {
          setHierarchyError(uplineResponse.message || 'Failed to change upline');
          return;
        }
      }

      await loadAgentDetails();
      setShowChangeUplineModal(false);
      setNewUplineAgentId('');
      setSelectedAgencyId('');
      setHierarchyError(null);
      if (cascadeMessage) {
        toast.success(cascadeMessage);
      } else if (agencyChanged || uplineChanged) {
        toast.success('Agent hierarchy updated');
      }
      if (onUpdate) onUpdate();
    } catch (error: any) {
      console.error('Error updating hierarchy:', error);
      setHierarchyError(error.message || 'Failed to update hierarchy');
    } finally {
      setLoading(false);
    }
  };

  // Handle file upload
  const handleFileUpload = async (file: File) => {
    try {
      setLoading(true);
      setError(null);
      
      // Create FormData - using the format expected by backend/routes/uploads.js
      const formData = new FormData();
      formData.append('files', file); // Backend expects 'files' array
      formData.append('fileType', uploadType === 'license' ? 'agents' : 'documents');
      formData.append('entityId', agentId);
      formData.append('category', uploadType === 'license' ? 'license' : 'document');
      formData.append('description', uploadType === 'license' ? 'License document' : 'Agent document');
      
      // Use apiService for FormData uploads
      const responseData = await apiService.post<{
        success: boolean;
        message?: string;
        url?: string;
        filename?: string;
        data?: Array<{ url: string; filename?: string }>;
        error?: { message: string } | string;
      }>('/api/uploads', formData);
      
      if (!responseData.success) {
        const errorData = typeof responseData.error === 'object' ? responseData.error : { message: typeof responseData.error === 'string' ? responseData.error : 'Upload failed' };
        throw new Error(errorData.message || 'Upload failed');
      }
      
      // For single file uploads, the URL is available at both responseData.url and responseData.data[0].url
      const uploadUrl = responseData.url || (responseData.data && responseData.data[0]?.url);
      
      if (uploadUrl) {
        // Update the appropriate form with the returned URL
        if (uploadType === 'license') {
          setLicenseForm((prev: CreateLicenseRequest) => ({ 
            ...prev, 
            documentUrl: uploadUrl 
          }));
        } else {
          setDocumentForm((prev: CreateDocumentRequest) => ({ 
            ...prev, 
            fileUrl: uploadUrl,
            fileName: file.name,
            fileSize: Math.round(file.size / 1024), // KB
            fileType: file.type
          }));
        }
        
        setShowUploadModal(false);
      } else {
        throw new Error(responseData.message || 'Upload failed - no URL returned');
      }
    } catch (err: any) {
      console.error('🔍 MODAL - Error uploading file:', err);
      setError(err.message || 'Failed to upload file');
    } finally {
      setLoading(false);
    }
  };

  // Handle adding license
  const handleAddLicense = async (e: React.FormEvent) => {
    e.preventDefault();
    
    try {
      setLoading(true);
      
      const response = await TenantAdminAgentsService.addLicense(agentId, licenseForm);
      
      if (response.success) {
        setShowAddLicenseModal(false);
        setLicenseForm({
          stateCode: '',
          licenseNumber: '',
          licenseType: '',
          expirationDate: '',
          issueDate: '',
          documentUrl: ''
        });
        
        // Reload agent details to get updated license info
        await loadAgentDetails();
        
        // Switch to licenses tab to show the new license
        setActiveTab('licenses');
        
        // Update parent component
        onUpdate?.();
      } else {
        console.error('🔍 MODAL - Failed to add license:', response.message);
        setError(response.message || 'Failed to add license');
      }
    } catch (err: any) {
      console.error('🔍 MODAL - Error adding license:', err);
      setError(err.message || 'Failed to add license');
    } finally {
      setLoading(false);
    }
  };

  // Handle removing license
  const handleRemoveLicense = async (licenseId: string) => {
    if (!confirm('Are you sure you want to remove this license?')) return;
    
    try {
      setLoading(true);
      
      const response = await TenantAdminAgentsService.removeLicense(agentId, licenseId);
      
      if (response.success) {
        await loadAgentDetails();
        onUpdate?.();
      } else {
        console.error('🔍 MODAL - Failed to remove license:', response.message);
        setError(response.message || 'Failed to remove license');
      }
    } catch (err: any) {
      console.error('🔍 MODAL - Error removing license:', err);
      setError(err.message || 'Failed to remove license');
    } finally {
      setLoading(false);
    }
  };

  // Handle adding document
  const handleAddDocument = async (e: React.FormEvent) => {
    e.preventDefault();
    
    try {
      setLoading(true);
      
      const response = await TenantAdminAgentsService.uploadDocument(agentId, documentForm);
      
      if (response.success) {
        setShowAddDocumentModal(false);
        setDocumentForm({
          documentType: '',
          fileName: '',
          fileUrl: '',
          fileSize: 0,
          fileType: '',
          description: ''
        });
        
        await loadAgentDetails();
        setActiveTab('documents');
        onUpdate?.();
      } else {
        console.error('🔍 MODAL - Failed to upload document:', response.message);
        setError(response.message || 'Failed to upload document');
      }
    } catch (err: any) {
      console.error('🔍 MODAL - Error uploading document:', err);
      setError(err.message || 'Failed to upload document');
    } finally {
      setLoading(false);
    }
  };

  // Handle saving bank info
  const handleSaveBankInfo = async (e: React.FormEvent) => {
    e.preventDefault();

    // If for any reason the account number is still showing the legacy
    // masked placeholder (e.g. decryption failed), block saving so we don't
    // overwrite the stored value with bullets.
    const isMaskedAccountNumber = bankForm.accountNumber.startsWith('••••');
    if (isMaskedAccountNumber && existingBankInfo) {
      setError('Please enter the full account number to update');
      return;
    }

    try {
      setLoading(true);
      setError(null);
      
      // For agencies, use updateAgency API; for agents, use saveBankInfo
      let response;
      if (agent?.Type === 'Agency') {
        response = await TenantAdminAgentsService.updateAgency(agentId, {
          agencyName: agent?.Name || '',
          contactEmail: agent?.Email || '',
          bankName: bankForm.bankName,
          accountHolderName: bankForm.accountName,
          accountType: bankForm.accountType as 'Checking' | 'Savings',
          achRoutingNumber: bankForm.routingNumber,
          achAccountNumber: bankForm.accountNumber
        });
      } else {
        response = await TenantAdminAgentsService.saveBankInfo(agentId, {
          bankName: bankForm.bankName,
          accountName: bankForm.accountName,
          accountType: bankForm.accountType as 'Checking' | 'Savings',
          routingNumber: bankForm.routingNumber,
          accountNumber: bankForm.accountNumber
        });
      }
      
      if (response.success) {
        // Reload agent details to repopulate the form with the saved
        // (full, decrypted) account number from the backend.
        await loadAgentDetails();
        
        // Update parent component
        onUpdate?.();
        
        // Clear any existing errors
        setError(null);
        
      } else {
        console.error('🔍 MODAL - Failed to save bank info:', response.message);
        setError(response.message || 'Failed to save bank information');
      }
    } catch (err: any) {
      console.error('🔍 MODAL - Error saving bank info:', err);
      setError(err.message || 'Failed to save bank information');
    } finally {
      setLoading(false);
    }
  };

  // Helper functions
  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'Active':
        return <CheckCircle className="h-5 w-5 text-green-500" />;
      case 'Inactive':
        return <XCircle className="h-5 w-5 text-red-500" />;
      default:
        return <Clock className="h-5 w-5 text-yellow-500" />;
    }
  };

  const getTypeIcon = (type: string) => {
    return type === 'Agent' ? 
      <User className="h-6 w-6 text-oe-primary" /> : 
      <Building className="h-6 w-6 text-purple-500" />;
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString();
  };

  const getLicenseStatus = (expirationDate?: string) => {
    if (!expirationDate) return { color: 'gray', text: 'No expiration' };
    
    const date = new Date(expirationDate);
    const now = new Date();
    const daysUntilExpiry = Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    
    if (daysUntilExpiry < 0) {
      return { color: 'red', text: 'Expired' };
    } else if (daysUntilExpiry < 30) {
      return { color: 'yellow', text: `Expires in ${daysUntilExpiry} days` };
    } else {
      return { color: 'green', text: 'Valid' };
    }
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Main Modal */}
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
        <div className="bg-white rounded-lg shadow-xl max-w-6xl w-full h-[85vh] overflow-hidden flex flex-col">
          {/* Modal Header */}
          <div className="flex items-center justify-between p-6 border-b">
            {agent ? (
              <div className="flex items-center">
                {getTypeIcon(agent.Type)}
                <div className="ml-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-xl font-bold text-gray-900">{agent.Name}</h2>
                    {agent.Type === 'Agent' && agent.CommissionTierLevel != null && (
                      <span
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-oe-primary border border-blue-100"
                        title="Commission level"
                      >
                        <DollarSign className="h-3 w-3" />
                        {tierLevelDisplayNames.get(Number(agent.CommissionTierLevel)) ||
                          (agent as any).CommissionLevelName ||
                          getTierLevelLabel(agent.CommissionTierLevel)}
                      </span>
                    )}
                  </div>
                  <p className="text-gray-600">
                    {agent.Type === 'Agent'
                      ? (agent.AgencyName || 'Agent')
                      : agent.Type}
                  </p>
                </div>
              </div>
            ) : (
              <h2 className="text-xl font-bold text-gray-900">Loading...</h2>
            )}
            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-6 w-6" />
              </button>
            </div>
          </div>

          {/* Error Message */}
          {error && (
            <div className="p-4 bg-red-50 border-b border-red-200">
              <div className="flex items-center">
                <AlertCircle className="h-5 w-5 text-red-500 mr-2" />
                <span className="text-red-700">{error}</span>
                <button
                  onClick={() => setError(null)}
                  className="ml-auto text-red-500 hover:text-red-700"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {loading ? (
            <div className="p-8 text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary mx-auto mb-4"></div>
              <p className="text-gray-600">Loading agent details...</p>
            </div>
          ) : agent ? (
            <>
              {/* Tabs */}
              <div className="border-b border-gray-200 relative">
                {tabCanScrollLeft && (
                  <button
                    type="button"
                    aria-label="Scroll tabs left"
                    onClick={() => tabScrollRef.current?.scrollBy({ left: -160, behavior: 'smooth' })}
                    className="absolute left-0 top-0 bottom-0 z-10 flex items-center px-1 bg-gradient-to-r from-white via-white to-transparent pointer-events-auto"
                  >
                    <ChevronLeft className="h-4 w-4 text-gray-400" />
                  </button>
                )}
                <nav
                  ref={tabScrollRef}
                  className="flex space-x-8 px-6 overflow-x-auto scrollbar-hide"
                  style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
                >
                  {[
                    { key: 'contact', label: 'Agent Info', icon: <Mail className="h-4 w-4" />, showForAll: true },
                    { key: 'commissions', label: 'Commissions', icon: <DollarSign className="h-4 w-4" />, showForAll: true },
                    { key: 'licenses', label: `Licenses (${agent.licenses?.length || 0})`, icon: <FileText className="h-4 w-4" />, showForAll: false },
                    { key: 'documents', label: 'Documents', icon: <FileUp className="h-4 w-4" />, showForAll: true },
                    { key: 'banking', label: 'Bank Information', icon: <CreditCard className="h-4 w-4" />, showForAll: false },
                    { key: 'enrollment-links', label: 'Enrollment Links', icon: <Link className="h-4 w-4" />, showForAll: false },
                    { key: 'training', label: 'Training', icon: <GraduationCap className="h-4 w-4" />, showForAll: false },
                    { key: 'sessions', label: 'Authentication', icon: <LogOut className="h-4 w-4" />, showForAll: false },
                    { key: 'communications', label: 'Communications', icon: <Megaphone className="h-4 w-4" />, showForAll: false },
                  ].filter(tab =>
                    (tab.showForAll || agent.Type === 'Agent') &&
                    (tab.key !== 'sessions' || (!!agent.UserId && (currentRole === 'TenantAdmin' || currentRole === 'SysAdmin'))) &&
                    (tab.key !== 'communications' || (!!agent.UserId && (currentRole === 'TenantAdmin' || currentRole === 'SysAdmin')))
                  ).map(tab => (
                    <button
                      key={tab.key}
                      onClick={() => setActiveTab(tab.key as any)}
                      className={`py-4 px-1 border-b-2 font-medium text-sm flex items-center space-x-2 whitespace-nowrap shrink-0 ${
                        activeTab === tab.key
                          ? 'border-oe-primary text-oe-primary'
                          : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                      }`}
                    >
                      {tab.icon}
                      <span>{tab.label}</span>
                    </button>
                  ))}
                </nav>
                {tabCanScrollRight && (
                  <button
                    type="button"
                    aria-label="Scroll tabs right"
                    onClick={() => tabScrollRef.current?.scrollBy({ left: 160, behavior: 'smooth' })}
                    className="absolute right-0 top-0 bottom-0 z-10 flex items-center px-1 bg-gradient-to-l from-white via-white to-transparent pointer-events-auto"
                  >
                    <ChevronRight className="h-4 w-4 text-gray-400" />
                  </button>
                )}
              </div>

              {/* Tab Content */}
              <div className="p-6 overflow-y-auto flex-1">
                {/* Contact Details Tab */}
                {activeTab === 'contact' && (
                  <div className="space-y-6">
                    {/* Profile picture (agents only) */}
                    {agent.Type === 'Agent' && (
                      <div className="flex items-center gap-4 pb-4 border-b border-gray-200">
                        <div className="w-20 h-20 rounded-full overflow-hidden bg-gray-100 border-2 border-gray-200 flex-shrink-0">
                          {agent.ProfileImageUrl ? (
                            <img src={agent.ProfileImageUrl} alt="" className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-2xl font-semibold text-gray-500">
                              {agent.FirstName?.[0] || agent.Name?.[0] || '?'}
                              {agent.LastName?.[0] || ''}
                            </div>
                          )}
                        </div>
                        <div>
                          <p className="text-lg font-semibold text-gray-900">{agent.Name}</p>
                          {agent.Email && <p className="text-sm text-gray-500">{agent.Email}</p>}
                        </div>
                      </div>
                    )}
                    {/* Edit/Save buttons */}
                    <div className="flex justify-between items-center">
                      <div></div>
                      <div className="flex space-x-2">
                        {!isEditingContact ? (
                          <button
                            onClick={() => setIsEditingContact(true)}
                            className="px-4 py-2 text-sm font-medium text-oe-primary bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-oe-primary"
                          >
                            <Edit className="h-4 w-4 mr-2 inline" />
                            Edit
                          </button>
                        ) : (
                          <>
                            <button
                              onClick={handleCancelEdit}
                              className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-50 border border-gray-200 rounded-lg hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-500"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={handleSaveContactDetails}
                              disabled={loading}
                              className="px-4 py-2 text-sm font-medium text-white bg-oe-primary border border-oe-primary rounded-lg hover:bg-oe-primary-dark focus:outline-none focus:ring-2 focus:ring-oe-primary disabled:opacity-50"
                            >
                              {loading ? 'Saving...' : 'Save Changes'}
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div>
                        <h3 className="text-lg font-semibold text-gray-900 mb-4">Basic Information</h3>
                        <div className="space-y-4">
                          {/* Name fields - different for agencies vs agents */}
                          {agent.Type === 'Agency' ? (
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-1">Contact Name</label>
                              {isEditingContact ? (
                                <input
                                  type="text"
                                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                                  value={contactForm.contactName}
                                  onChange={(e) => setContactForm(prev => ({ ...prev, contactName: e.target.value }))}
                                />
                              ) : (
                                <p className="mt-1 text-sm text-gray-900">{agent.ContactName || 'Not provided'}</p>
                              )}
                            </div>
                          ) : (
                            <div className="grid grid-cols-2 gap-4">
                              <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">First Name</label>
                                {isEditingContact ? (
                                  <input
                                    type="text"
                                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                                    value={contactForm.firstName}
                                    onChange={(e) => setContactForm(prev => ({ ...prev, firstName: e.target.value }))}
                                  />
                                ) : (
                                  <p className="mt-1 text-sm text-gray-900">{agent.FirstName || 'Not provided'}</p>
                                )}
                              </div>
                              <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Last Name</label>
                                {isEditingContact ? (
                                  <input
                                    type="text"
                                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                                    value={contactForm.lastName}
                                    onChange={(e) => setContactForm(prev => ({ ...prev, lastName: e.target.value }))}
                                  />
                                ) : (
                                  <p className="mt-1 text-sm text-gray-900">{agent.LastName || 'Not provided'}</p>
                                )}
                              </div>
                            </div>
                          )}
                          
                          {/* Email */}
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                            {isEditingContact ? (
                              <input
                                type="email"
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                                value={contactForm.email}
                                onChange={(e) => setContactForm(prev => ({ ...prev, email: e.target.value }))}
                              />
                            ) : (
                              <p className="mt-1 text-sm text-gray-900 flex items-center">
                                <Mail className="h-4 w-4 mr-2 text-gray-400" />
                                {agent.Email}
                                {agent.Type === 'Agent' && agent.UserId && (currentRole === 'TenantAdmin' || currentRole === 'SysAdmin') && (
                                  <button
                                    onClick={() => setShowChangeEmailModal(true)}
                                    className="ml-2 inline-flex items-center px-2 py-1 text-xs font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded transition-colors"
                                    title="Change email"
                                  >
                                    <Pencil className="h-3 w-3" />
                                  </button>
                                )}
                              </p>
                            )}
                          </div>
                          
                          {/* Phone */}
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
                            {isEditingContact ? (
                              <input
                                type="tel"
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                                value={contactForm.phone}
                                onChange={(e) => setContactForm(prev => ({ ...prev, phone: e.target.value }))}
                              />
                            ) : (
                              <p className="mt-1 text-sm text-gray-900 flex items-center">
                                <Phone className="h-4 w-4 mr-2 text-gray-400" />
                                {agent.Phone || 'Not provided'}
                              </p>
                            )}
                          </div>
                          
                          {/* Address */}
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Address</label>
                            {isEditingContact ? (
                              <input
                                type="text"
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                                value={contactForm.address}
                                onChange={(e) => setContactForm(prev => ({ ...prev, address: e.target.value }))}
                              />
                            ) : (
                              <p className="mt-1 text-sm text-gray-900 flex items-center">
                                <MapPin className="h-4 w-4 mr-2 text-gray-400" />
                                {agent.Address || 'Not provided'}
                              </p>
                            )}
                          </div>
                          
                          {/* City, State, Zip */}
                          {isEditingContact && (
                            <div className="grid grid-cols-3 gap-4">
                              <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">City</label>
                                <input
                                  type="text"
                                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                                  value={contactForm.city}
                                  onChange={(e) => setContactForm(prev => ({ ...prev, city: e.target.value }))}
                                />
                              </div>
                              <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">State</label>
                                <select
                                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                                  value={contactForm.state}
                                  onChange={(e) => setContactForm(prev => ({ ...prev, state: e.target.value }))}
                                >
                                  <option value="">Select State</option>
                                  {TenantAdminAgentsService.getStateOptions().map(state => (
                                    <option key={state.value} value={state.value}>{state.label}</option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Zip Code</label>
                                <input
                                  type="text"
                                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                                  value={contactForm.zipCode}
                                  onChange={(e) => setContactForm(prev => ({ ...prev, zipCode: e.target.value }))}
                                />
                              </div>
                            </div>
                          )}
                          
                          {/* Read-only address display when not editing */}
                          {!isEditingContact && agent.Address && (
                            <div>
                              <p className="mt-1 text-sm text-gray-900">
                                {agent.City}, {agent.State} {agent.ZipCode}
                              </p>
                            </div>
                          )}
                        </div>
                      </div>
                      
                      <div>
                        <h3 className="text-lg font-semibold text-gray-900 mb-4">Professional Information</h3>
                        <div className="space-y-4">
                          {/* Agent ID */}
                          {agent.Type === 'Agent' && (
                            <div className="space-y-1">
                              <label className="block text-sm font-medium text-gray-700">Agent ID</label>
                              <div className="block w-full rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-mono text-gray-700">
                                {agent.AgentCode || <span className="text-gray-400">— (not yet assigned)</span>}
                              </div>
                              <p className="text-xs text-gray-500">System-generated. Use this when referencing the agent in support tickets.</p>
                            </div>
                          )}

                          {/* NPN/EIN */}
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              {agent.Type === 'Agent' ? 'NPN' : 'EIN'}
                            </label>
                            {isEditingContact ? (
                              <input
                                type="text"
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                                value={contactForm.npn}
                                onChange={(e) => setContactForm(prev => ({ ...prev, npn: e.target.value }))}
                              />
                            ) : (
                              <p className="mt-1 text-sm text-gray-900">{agent.NPN || 'Not provided'}</p>
                            )}
                          </div>
                          
                          {/* Tax ID Type and Value */}
                          {agent.Type === 'Agent' && (
                            <>
                              <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Tax ID Type</label>
                                {isEditingContact ? (
                                  <select
                                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                                    value={contactForm.idType}
                                    onChange={(e) => setContactForm(prev => ({ ...prev, idType: e.target.value }))}
                                  >
                                    <option value="">Select Type</option>
                                    <option value="SSN">SSN</option>
                                    <option value="EIN">EIN</option>
                                  </select>
                                ) : (
                                  <p className="mt-1 text-sm text-gray-900">{agent.IDType || 'Not provided'}</p>
                                )}
                              </div>
                              
                              {/* Tax ID Value - NEW FIELD */}
                              <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">
                                  {agent.IDType === 'SSN' ? 'SSN' : agent.IDType === 'EIN' ? 'EIN' : 'Tax ID'}
                                </label>
                                {isEditingContact ? (
                                  <input
                                    type="text"
                                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                                    value={contactForm.ssnOrTaxId}
                                    onChange={(e) => setContactForm(prev => ({ ...prev, ssnOrTaxId: e.target.value }))}
                                    placeholder={contactForm.idType === 'SSN' ? 'XXX-XX-XXXX' : 'XX-XXXXXXX'}
                                  />
                                ) : (
                                  <p className="mt-1 text-sm text-gray-900">
                                    {agent.SSNOrTaxID ? maskSSNOrTaxID(agent.SSNOrTaxID, agent.IDType || '') : 'Not provided'}
                                  </p>
                                )}
                              </div>
                            </>
                          )}
                          
                          {/* Business Name */}
                          {agent.Type === 'Agent' && (
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-1">Business Name</label>
                              {isEditingContact ? (
                                <input
                                  type="text"
                                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                                  value={contactForm.businessName}
                                  onChange={(e) => setContactForm(prev => ({ ...prev, businessName: e.target.value }))}
                                />
                              ) : (
                                <p className="mt-1 text-sm text-gray-900">{agent.BusinessName || 'Not provided'}</p>
                              )}
                            </div>
                          )}
                          
                          {/* Commission Role - read-only (only TenantAdmin/SysAdmin set via Commission Settings) */}
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Commission Role</label>
                            <p className="mt-1 text-sm text-gray-900">{agent.Role || 'Agent'}</p>
                          </div>

                          {/* Status */}
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                            <div className="mt-1 flex items-center">
                              {getStatusIcon(agent.Status)}
                              <span className="ml-2 text-sm text-gray-900">{formatAgentLifecycleStatusLabel(agent.Status)}</span>
                            </div>
                          </div>
                          
                          {/* Agency */}
                          {agent.AgencyName && (
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-1">Agency</label>
                              <p className="mt-1 text-sm text-gray-900">{agent.AgencyName}</p>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {showAdvancedAgentActions && (
                      <div className="border border-gray-200 rounded-lg overflow-hidden">
                        <button
                          type="button"
                          onClick={() => setAdvancedActionsOpen((open) => !open)}
                          className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 text-left"
                          aria-expanded={advancedActionsOpen}
                        >
                          <span className="text-sm font-medium text-gray-900">Advanced</span>
                          <ChevronDown
                            className={`h-4 w-4 text-gray-500 transition-transform ${advancedActionsOpen ? 'rotate-180' : ''}`}
                          />
                        </button>
                        {advancedActionsOpen && (
                          <div className="px-4 py-4 border-t border-gray-200 space-y-4 bg-white">
                            <p className="text-xs text-gray-500">
                              Destructive or cross-tenant actions. Use with care.
                            </p>
                            <div className="flex flex-wrap gap-3">
                              {canToggleStatus && (
                                agent.Status === 'Active' ? (
                                  <button
                                    type="button"
                                    onClick={() => setStatusToggleConfirm('Inactive')}
                                    className="text-sm px-4 py-2 rounded-lg border border-red-300 text-red-700 bg-white hover:bg-red-50"
                                  >
                                    Deactivate account
                                  </button>
                                ) : agent.Status === 'Inactive' ? (
                                  <button
                                    type="button"
                                    onClick={() => setStatusToggleConfirm('Active')}
                                    className="text-sm px-4 py-2 rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50"
                                  >
                                    Reactivate account
                                  </button>
                                ) : null
                              )}
                              {currentRole === 'SysAdmin' && agent.TenantId && (
                                <button
                                  type="button"
                                  onClick={() => setShowTenantMigrationWizard(true)}
                                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50"
                                  title="Move agent and downline to another tenant"
                                >
                                  <ArrowRightLeft className="h-4 w-4" />
                                  Migrate tenant
                                </button>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Licenses Tab */}
                {activeTab === 'licenses' && agent.Type === 'Agent' && (
                  <div>
                    <div className="flex justify-between items-center mb-6">
                      <h3 className="text-lg font-semibold text-gray-900">
                        Licenses ({agent.licenses?.length || 0})
                      </h3>
                      <button
                        onClick={() => setShowAddLicenseModal(true)}
                        className="btn-primary flex items-center space-x-2"
                      >
                        <Plus className="h-4 w-4" />
                        <span>Add License</span>
                      </button>
                    </div>
                    
                    {agent.licenses && agent.licenses.length > 0 ? (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {agent.licenses.map((license: any) => {
                          const status = getLicenseStatus(license.ExpirationDate);
                          return (
                            <div key={license.LicenseId} className="border rounded-lg p-4">
                              <div className="flex justify-between items-start mb-3">
                                <div>
                                  <h4 className="font-medium text-gray-900">{license.StateCode}</h4>
                                  <p className="text-sm text-gray-600">{license.LicenseType || 'General'}</p>
                                </div>
                                <div className="flex items-center space-x-2">
                                  <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                                    status.color === 'green' ? 'bg-green-100 text-green-800' :
                                    status.color === 'yellow' ? 'bg-yellow-100 text-yellow-800' :
                                    'bg-red-100 text-red-800'
                                  }`}>
                                    {status.text}
                                  </span>
                                  <button
                                    onClick={() => handleRemoveLicense(license.LicenseId)}
                                    className="text-red-600 hover:text-red-800"
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </button>
                                </div>
                              </div>
                              
                              <div className="space-y-2 text-sm">
                                <div>
                                  <span className="font-medium text-gray-700">License #:</span>
                                  <span className="ml-2 text-gray-900">{license.LicenseNumber}</span>
                                </div>
                                {license.IssueDate && (
                                  <div>
                                    <span className="font-medium text-gray-700">Issued:</span>
                                    <span className="ml-2 text-gray-900">{formatDate(license.IssueDate)}</span>
                                  </div>
                                )}
                                {license.ExpirationDate && (
                                  <div>
                                    <span className="font-medium text-gray-700">Expires:</span>
                                    <span className="ml-2 text-gray-900">{formatDate(license.ExpirationDate)}</span>
                                  </div>
                                )}
                                {license.UploadedDocumentUrl && (
                                  <div>
                                    <a
                                      href={license.UploadedDocumentUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="inline-flex items-center text-oe-primary hover:text-oe-dark"
                                    >
                                      <FileText className="h-4 w-4 mr-1" />
                                      View Document
                                    </a>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="text-center py-8">
                        <FileText className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                        <p className="text-gray-600">No licenses added yet</p>
                        <p className="text-sm text-gray-500">Click "Add License" to get started</p>
                      </div>
                    )}
                  </div>
                )}

                {/* Documents Tab */}
                {activeTab === 'documents' && (
                  <div>
                    <div className="flex justify-between items-center mb-6">
                      <h3 className="text-lg font-semibold text-gray-900">Documents</h3>
                      <button
                        onClick={() => setShowAddDocumentModal(true)}
                        className="btn-primary flex items-center space-x-2"
                      >
                        <Plus className="h-4 w-4" />
                        <span>Upload Document</span>
                      </button>
                    </div>
                    
                    {agent.documents && agent.documents.length > 0 ? (
                      <div className="grid grid-cols-1 gap-4">
                        {agent.documents.map((document: any) => (
                          <div key={document.DocumentId} className="border rounded-lg p-4">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center space-x-3">
                                <FileText className="h-8 w-8 text-oe-primary" />
                                <div>
                                  <h4 className="font-medium text-gray-900">{document.FileName}</h4>
                                  <p className="text-sm text-gray-600">{document.DocumentType}</p>
                                  {document.Description && (
                                    <p className="text-sm text-gray-500">{document.Description}</p>
                                  )}
                                </div>
                              </div>
                              <div className="flex items-center space-x-2">
                                <div className="text-right text-sm text-gray-500">
                                  <div>{formatDate(document.CreatedDate)}</div>
                                  {document.FileSize && (
                                    <div>{Math.round(document.FileSize / 1024)} KB</div>
                                  )}
                                </div>
                                <a
                                  href={document.FileUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-oe-primary hover:text-oe-dark"
                                >
                                  <Download className="h-4 w-4" />
                                </a>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-center py-8">
                        <FileText className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                        <p className="text-gray-600">No documents uploaded yet</p>
                        <p className="text-sm text-gray-500">Click "Upload Document" to get started</p>
                      </div>
                    )}
                  </div>
                )}

                {/* Banking Tab - FIXED to handle missing bank info gracefully */}
                {activeTab === 'banking' && (
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900 mb-6">Bank Information for ACH Payments</h3>
                    
                    {/* Show existing bank info if available */}
                    {existingBankInfo && (
                      <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
                        <div className="flex items-center">
                          <CheckCircle className="h-5 w-5 text-green-500 mr-2" />
                          <div>
                            <p className="text-sm font-medium text-green-800">Bank Information on File</p>
                            <p className="text-sm text-green-700">
                              {existingBankInfo.BankName} - {existingBankInfo.AccountType} ••••{existingBankInfo.AccountNumberLast4}
                            </p>
                            <p className="text-xs text-green-600">
                              Status: {existingBankInfo.VerificationStatus} • Last updated: {formatDate(existingBankInfo.ModifiedDate)}
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                    
                    {/* Show empty state if no bank info */}
                    {!existingBankInfo && (
                      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
                        <div className="flex items-center">
                          <CreditCard className="h-5 w-5 text-blue-500 mr-2" />
                          <div>
                            <p className="text-sm font-medium text-blue-800">No Bank Information on File</p>
                            <p className="text-sm text-oe-primary-dark">
                              Add bank information to enable ACH commission payments
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                    
                    <form onSubmit={handleSaveBankInfo} className="space-y-6 max-w-2xl">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Bank Name *
                          </label>
                          <input
                            type="text"
                            required
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                            value={bankForm.bankName}
                            onChange={(e) => setBankForm((prev: typeof bankForm) => ({ ...prev, bankName: e.target.value }))}
                          />
                        </div>
                        
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Name on Account *
                          </label>
                          <input
                            type="text"
                            required
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                            value={bankForm.accountName}
                            onChange={(e) => setBankForm((prev: typeof bankForm) => ({ ...prev, accountName: e.target.value }))}
                          />
                        </div>
                      </div>
                      
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Account Type *
                        </label>
                        <select
                          required
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                          value={bankForm.accountType}
                          onChange={(e) => setBankForm((prev: typeof bankForm) => ({ ...prev, accountType: e.target.value }))}
                        >
                          <option value="Checking">Checking</option>
                          <option value="Savings">Savings</option>
                        </select>
                      </div>
                      
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Routing Number *
                        </label>
                        <input
                          type="text"
                          required
                          maxLength={9}
                          pattern="[0-9]{9}"
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                          value={bankForm.routingNumber}
                          onChange={(e) => setBankForm((prev: typeof bankForm) => ({ ...prev, routingNumber: e.target.value.replace(/\D/g, '') }))}
                          placeholder="9 digits"
                        />
                      </div>
                      
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Account Number *
                        </label>
                        <input
                          type="text"
                          required
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                          value={bankForm.accountNumber}
                          onChange={(e) => setBankForm((prev: typeof bankForm) => ({ ...prev, accountNumber: e.target.value }))}
                          placeholder="Enter account number"
                          style={{backgroundColor: '#ffffcc'}}
                        />
                      </div>
                      
                      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                        <div className="flex items-start">
                          <AlertCircle className="h-5 w-5 text-blue-500 mt-0.5 mr-2" />
                          <div className="text-sm text-oe-primary-dark">
                            <p className="font-medium">Secure Information</p>
                            <p>Your bank information is encrypted and stored securely. It will only be used for commission payments.</p>
                          </div>
                        </div>
                      </div>
                      
                      <div className="flex justify-end">
                        <button
                          type="submit"
                          disabled={loading}
                          className="btn-primary disabled:opacity-50"
                        >
                          {loading ? 'Saving...' : existingBankInfo ? 'Update Bank Information' : 'Save Bank Information'}
                        </button>
                      </div>
                    </form>
                  </div>
                )}

                {/* Commissions Tab - same content as Commission Settings modal, rendered inline */}
                {activeTab === 'commissions' && agent && (
                  <div className="space-y-6">
                    <CommissionRulesModal
                      isOpen={true}
                      embedded={true}
                      onClose={() => {}}
                      entityType={agent.Type}
                      entityId={agentId}
                      entityName={agent.Name}
                      onSave={(_, __, updates) => {
                        if (updates && agent) {
                          setAgent({ ...agent, ...updates });
                        }
                        onUpdate?.();
                      }}
                      uplineName={agent.Type === 'Agent' ? (agent.ParentAgent?.Name || agent.AgencyName || undefined) : undefined}
                      onConfigureUpline={(currentRole === 'TenantAdmin' || currentRole === 'SysAdmin') && agent.Type === 'Agent'
                        ? () => setShowChangeUplineModal(true)
                        : undefined}
                      currentUserTierLevel={currentRole === 'Agent' ? propCurrentUserTierLevel : undefined}
                      isViewingSelf={currentRole === 'Agent' && !!agent.UserId && !!user?.userId && agent.UserId === user.userId}
                      currentRole={currentRole}
                    />
                  </div>
                )}

                {/* Enrollment Links Tab - same UI as EnrollmentLinkTemplates.tsx link items */}
                {activeTab === 'enrollment-links' && agent.Type === 'Agent' && (() => {
                  const getTypeIcon = (templateType: string) =>
                    templateType === 'Individual' ? <User className="h-4 w-4" /> : <Users className="h-4 w-4" />;
                  return (
                    <div className="space-y-6">
                      <div className="flex justify-between items-center">
                        <div>
                          <h3 className="text-lg font-semibold text-gray-900">Enrollment Link Templates</h3>
                          <p className="text-sm text-gray-600 mt-1">Templates used to send enrollment links to members</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            const role = user?.currentRole || 'Agent';
                            const path = role === 'TenantAdmin' || role === 'SysAdmin' ? '/tenant-admin/enrollment-links' : '/agent/enrollment-links';
                            navigate(path, { state: { agentIdForEnrollmentLinks: agentId } });
                            onClose();
                          }}
                          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-oe-primary rounded-lg hover:bg-oe-primary-dark"
                        >
                          <ExternalLink className="h-4 w-4" />
                          View all enrollment links
                        </button>
                      </div>
                      {enrollmentTemplatesLoading ? (
                        <div className="flex items-center justify-center py-8">
                          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary" />
                        </div>
                      ) : enrollmentTemplates.length === 0 ? (
                        <div className="bg-gray-50 border border-gray-200 rounded-lg p-6 text-center">
                          <FileText className="h-12 w-12 text-gray-400 mx-auto mb-3 block" />
                          <p className="text-sm text-gray-600">No enrollment link templates for this agent</p>
                          <p className="text-xs text-gray-500 mt-1">Create templates from the Enrollment Links page</p>
                        </div>
                      ) : (
                        <div className="border border-gray-200 rounded-lg overflow-hidden">
                          <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gray-50">
                              <tr>
                                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
                                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
                                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                                <th scope="col" className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                              </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-200">
                              {enrollmentTemplates.map((t: any) => (
                                <tr key={t.TemplateId} className="hover:bg-gray-50">
                                  <td className="px-6 py-4">
                                    <div>
                                      <div className="flex items-center gap-2 flex-wrap">
                                        <div>
                                          <div className="text-sm font-medium text-gray-900" data-template-name={t.TemplateName}>
                                            {EnrollmentLinkTemplatesService.getDisplayTemplateName(t.TemplateName)}
                                          </div>
                                          {t.TemplateType === 'Group' && (t.GroupName || t.GroupId) && (
                                            <div className="text-xs text-gray-500 mt-0.5">
                                              {t.GroupName || 'Group'}
                                            </div>
                                          )}
                                        </div>
                                        {(Number(t.HasMarketingLink) === 1 || t.HasMarketingLink === true) && (
                                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
                                            <Megaphone className="h-3 w-3 mr-1" />
                                            Marketing Link
                                          </span>
                                        )}
                                      </div>
                                      {t.Description && (
                                        <div className="text-sm text-gray-500 mt-1">
                                          {t.Description}
                                        </div>
                                      )}
                                    </div>
                                  </td>
                                  <td className="px-6 py-4">
                                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${EnrollmentLinkTemplatesService.getTypeColor(t.TemplateType)}`}>
                                      {getTypeIcon(t.TemplateType)}
                                      <span className="ml-1">{t.TemplateType}</span>
                                    </span>
                                  </td>
                                  <td className="px-6 py-4">
                                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${EnrollmentLinkTemplatesService.getStatusColor(t.IsActive)}`}>
                                      {t.IsActive ? 'Active' : 'Inactive'}
                                    </span>
                                  </td>
                                  <td className="px-6 py-4 text-right">
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const role = user?.currentRole || 'Agent';
                                        const path = role === 'TenantAdmin' || role === 'SysAdmin' ? '/tenant-admin/enrollment-links' : '/agent/enrollment-links';
                                        navigate(path, { state: { agentIdForEnrollmentLinks: agentId } });
                                        onClose();
                                      }}
                                      className="text-oe-primary hover:text-oe-dark text-sm font-medium"
                                    >
                                      View
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* Training Tab — progress + quiz scores (loaded only when tab is active) */}
                {activeTab === 'training' && agent.Type === 'Agent' && (
                  <div className="space-y-6">
                    <div>
                      <h3 className="text-lg font-medium text-gray-900">Training progress</h3>
                      <p className="text-sm text-gray-600 mt-1">
                        Assigned library packages, product certification, and quiz scores for this agent.
                      </p>
                    </div>

                    {trainingLoading && (
                      <div className="flex items-center gap-2 text-gray-600">
                        <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-oe-primary" />
                        <span className="text-sm">Loading training…</span>
                      </div>
                    )}

                    {!trainingLoading && trainingError && (
                      <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{trainingError}</div>
                    )}

                    {!trainingLoading && !trainingError && trainingProgress && (
                      <>
                        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                          <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
                            <h4 className="text-sm font-semibold text-gray-900">Product certification</h4>
                            <p className="text-xs text-gray-500 mt-0.5">Latest quiz attempt per product (passing score shown).</p>
                          </div>
                          {trainingProgress.productTraining.length === 0 ? (
                            <p className="px-4 py-4 text-sm text-gray-600">No product training configured for this tenant.</p>
                          ) : (
                            <div className="overflow-x-auto">
                              <table className="min-w-full divide-y divide-gray-200 text-sm">
                                <thead className="bg-gray-50">
                                  <tr>
                                    <th className="px-4 py-2 text-left font-medium text-gray-700">Product</th>
                                    <th className="px-4 py-2 text-left font-medium text-gray-700">Passing</th>
                                    <th className="px-4 py-2 text-left font-medium text-gray-700">Score</th>
                                    <th className="px-4 py-2 text-left font-medium text-gray-700">Correct / Total</th>
                                    <th className="px-4 py-2 text-left font-medium text-gray-700">Status</th>
                                    <th className="px-4 py-2 text-left font-medium text-gray-700">Completed</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-100">
                                  {trainingProgress.productTraining.map(row => (
                                    <tr key={row.productId}>
                                      <td className="px-4 py-2 text-gray-900">{row.name}</td>
                                      <td className="px-4 py-2 text-gray-600">{row.passingScorePercent}%</td>
                                      <td className="px-4 py-2 text-gray-900">
                                        {row.lastScorePercent != null ? `${row.lastScorePercent}%` : '—'}
                                      </td>
                                      <td className="px-4 py-2 text-gray-600">
                                        {row.lastCorrectAnswers != null && row.lastTotalQuestions != null
                                          ? `${row.lastCorrectAnswers} / ${row.lastTotalQuestions}`
                                          : '—'}
                                      </td>
                                      <td className="px-4 py-2">
                                        {row.lastScorePercent == null ? (
                                          <span className="inline-flex px-2 py-0.5 text-xs font-medium rounded-full bg-gray-100 text-gray-700">
                                            Not started
                                          </span>
                                        ) : row.passed ? (
                                          <span className="inline-flex px-2 py-0.5 text-xs font-medium rounded-full bg-green-100 text-green-800">
                                            Passed
                                          </span>
                                        ) : (
                                          <span className="inline-flex px-2 py-0.5 text-xs font-medium rounded-full bg-yellow-100 text-yellow-800">
                                            Below passing
                                          </span>
                                        )}
                                      </td>
                                      <td className="px-4 py-2 text-gray-600 text-xs">
                                        {row.lastCompletedAt
                                          ? new Date(row.lastCompletedAt).toLocaleString()
                                          : '—'}
                                        {row.lastAttemptNumber != null ? (
                                          <span className="block text-gray-400">Attempt #{row.lastAttemptNumber}</span>
                                        ) : null}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>

                        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                          <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
                            <h4 className="text-sm font-semibold text-gray-900">Library packages</h4>
                            <p className="text-xs text-gray-500 mt-0.5">Modules assigned to this tenant for this agent.</p>
                          </div>
                          {trainingProgress.libraryPackages.length === 0 ? (
                            <p className="px-4 py-4 text-sm text-gray-600">No library packages assigned to this tenant.</p>
                          ) : (
                            <div className="divide-y divide-gray-100">
                              {trainingProgress.libraryPackages.map(pkg => (
                                <details key={pkg.packageId} className="group">
                                  <summary className="px-4 py-3 cursor-pointer list-none flex flex-wrap items-center justify-between gap-2 text-sm hover:bg-gray-50">
                                    <span className="font-medium text-gray-900">{pkg.title}</span>
                                    <span className="text-gray-600">
                                      {pkg.modulesCompleted} / {pkg.modulesTotal} modules
                                      {pkg.status ? (
                                        <span className="ml-2 text-xs text-gray-400">({pkg.status})</span>
                                      ) : null}
                                    </span>
                                  </summary>
                                  <ul className="px-4 pb-3 space-y-1 border-t border-gray-100 bg-gray-50/50">
                                    {pkg.modules.map(m => (
                                      <li
                                        key={`${pkg.packageId}-${m.moduleId}`}
                                        className="flex items-start justify-between gap-2 text-xs text-gray-700 py-1"
                                      >
                                        <span className={m.completed ? 'text-gray-500 line-through' : ''}>
                                          {m.required ? <span className="text-red-600 mr-1">*</span> : null}
                                          {m.title}
                                        </span>
                                        {m.completed ? (
                                          <span className="inline-flex items-center shrink-0 text-green-700">
                                            <CheckCircle className="h-3.5 w-3.5 mr-1" />
                                            {m.completedAt
                                              ? new Date(m.completedAt).toLocaleDateString()
                                              : 'Done'}
                                          </span>
                                        ) : (
                                          <span className="text-gray-400 shrink-0">Pending</span>
                                        )}
                                      </li>
                                    ))}
                                  </ul>
                                </details>
                              ))}
                            </div>
                          )}
                        </div>

                        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                          <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <h4 className="text-sm font-semibold text-gray-900">Library quiz scores</h4>
                              <p className="text-xs text-gray-500 mt-0.5">Section quizzes in assigned packages.</p>
                            </div>
                            {trainingQuizPackageOptions.length > 0 && (
                              <label className="flex items-center gap-2 text-xs text-gray-600">
                                <span className="whitespace-nowrap">Package</span>
                                <select
                                  className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                                  value={trainingQuizPackageFilter}
                                  onChange={e => setTrainingQuizPackageFilter(e.target.value)}
                                >
                                  <option value="all">All packages</option>
                                  {trainingQuizPackageOptions.map(opt => (
                                    <option key={opt.id} value={opt.id}>
                                      {opt.title}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            )}
                          </div>
                          {trainingQuizRowsFiltered.length === 0 ? (
                            <p className="px-4 py-4 text-sm text-gray-600">
                              {trainingProgress.libraryQuizzes.length === 0
                                ? 'No library quiz completions recorded.'
                                : 'No rows for this filter.'}
                            </p>
                          ) : (
                            <div className="overflow-x-auto">
                              <table className="min-w-full divide-y divide-gray-200 text-sm">
                                <thead className="bg-gray-50">
                                  <tr>
                                    <th className="px-4 py-2 text-left font-medium text-gray-700">Package</th>
                                    <th className="px-4 py-2 text-left font-medium text-gray-700">Module / Step</th>
                                    <th className="px-4 py-2 text-left font-medium text-gray-700">Score</th>
                                    <th className="px-4 py-2 text-left font-medium text-gray-700">Correct / Total</th>
                                    <th className="px-4 py-2 text-left font-medium text-gray-700">Completed</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-100">
                                  {trainingQuizRowsFiltered.map((q, idx) => (
                                    <tr key={`${q.packageId}-${q.quizId}-${q.completedAt ?? idx}`}>
                                      <td className="px-4 py-2 text-gray-900">{q.packageTitle}</td>
                                      <td className="px-4 py-2 text-gray-700">
                                        <div className="font-medium">{q.moduleTitle}</div>
                                        <div className="text-xs text-gray-500">{q.stepTitle}</div>
                                      </td>
                                      <td className="px-4 py-2 text-gray-900">
                                        {q.totalQuestions > 0 ? `${q.scorePercent}%` : '—'}
                                      </td>
                                      <td className="px-4 py-2 text-gray-600">
                                        {q.totalQuestions > 0 ? `${q.correctAnswers} / ${q.totalQuestions}` : '—'}
                                      </td>
                                      <td className="px-4 py-2 text-gray-600 text-xs">
                                        {q.completedAt ? new Date(q.completedAt).toLocaleString() : '—'}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Sessions Tab - password reset, change email, set temporary password (TenantAdmin/SysAdmin only) */}
                {activeTab === 'sessions' && agent.Type === 'Agent' && agent.UserId && (currentRole === 'TenantAdmin' || currentRole === 'SysAdmin') && (
                  <div className="p-6">
                    <h3 className="text-lg font-medium text-gray-900 mb-4">Account actions</h3>
                    <p className="text-sm text-gray-600 mb-4">
                      Manage this agent&apos;s login account. Changes apply to their portal sign-in.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={async () => {
                          if (!agent?.Email) return;
                          setSendPasswordResetMessage(null);
                          setSendPasswordResetLoading(true);
                          try {
                            await authService.requestPasswordReset(agent.Email);
                            setSendPasswordResetMessage({ type: 'success', text: 'Password reset email sent.' });
                          } catch (err: any) {
                            setSendPasswordResetMessage({
                              type: 'error',
                              text: err?.message || err?.response?.data?.message || 'Failed to send password reset email.'
                            });
                          } finally {
                            setSendPasswordResetLoading(false);
                          }
                        }}
                        disabled={sendPasswordResetLoading || !agent?.Email}
                        className="inline-flex items-center rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                      >
                        {sendPasswordResetLoading ? (
                          <>
                            <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600 inline-block mr-2" />
                            Sending...
                          </>
                        ) : (
                          <>
                            <Mail className="h-4 w-4 mr-2" />
                            Send password reset
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowChangeEmailModal(true)}
                        className="inline-flex items-center rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                      >
                        <AtSign className="h-4 w-4 mr-2" />
                        Change email
                      </button>
                      <button
                        type="button"
                        onClick={() => setSetTempPasswordOpen(true)}
                        className="inline-flex items-center rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                      >
                        <KeyRound className="h-4 w-4 mr-2" />
                        Set temporary password
                      </button>
                    </div>
                    {sendPasswordResetMessage && (
                      <div className={`mt-4 p-3 rounded-lg text-sm ${sendPasswordResetMessage.type === 'success' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
                        {sendPasswordResetMessage.text}
                      </div>
                    )}
                  </div>
                )}

                {/* Communications Tab — emails / SMS sent to this agent (TenantAdmin/SysAdmin only) */}
                {activeTab === 'communications' && agent.Type === 'Agent' && agent.UserId && (currentRole === 'TenantAdmin' || currentRole === 'SysAdmin') && (
                  <AgentCommunicationsTab userId={agent.UserId} />
                )}

              </div>

              {/* Footer: Send Password Reset */}
              {agent?.Email && (
                <div className="p-4 border-t border-gray-200 bg-gray-50 flex items-center justify-between flex-wrap gap-2">
                  <div className="text-sm text-gray-600">
                    {sendPasswordResetMessage?.type === 'success' && (
                      <span className="text-green-700">{sendPasswordResetMessage.text}</span>
                    )}
                    {sendPasswordResetMessage?.type === 'error' && (
                      <span className="text-red-700">{sendPasswordResetMessage.text}</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!agent?.Email) return;
                      setSendPasswordResetMessage(null);
                      setSendPasswordResetLoading(true);
                      try {
                        await authService.requestPasswordReset(agent.Email);
                        setSendPasswordResetMessage({ type: 'success', text: 'Password reset email sent.' });
                      } catch (err: any) {
                        setSendPasswordResetMessage({
                          type: 'error',
                          text: err?.message || err?.response?.data?.message || 'Failed to send password reset email.'
                        });
                      } finally {
                        setSendPasswordResetLoading(false);
                      }
                    }}
                    disabled={sendPasswordResetLoading}
                    className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {sendPasswordResetLoading ? 'Sending...' : 'Send Password Reset'}
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="p-8 text-center">
              <AlertCircle className="h-12 w-12 text-gray-400 mx-auto mb-4" />
              <p className="text-gray-600">Failed to load agent details</p>
            </div>
          )}
        </div>
      </div>

      {/* Add License Modal */}
      {showAddLicenseModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[80vh] overflow-y-auto">
            <div className="p-6">
              <h2 className="text-xl font-bold text-gray-900 mb-4">Add New License</h2>
              
              <form onSubmit={handleAddLicense} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    State *
                  </label>
                  <select
                    required
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    value={licenseForm.stateCode}
                    onChange={(e) => setLicenseForm((prev: CreateLicenseRequest) => ({ ...prev, stateCode: e.target.value }))}
                  >
                    <option value="">Select State</option>
                    {TenantAdminAgentsService.getStateOptions().map(state => (
                      <option key={state.value} value={state.value}>{state.label}</option>
                    ))}
                  </select>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    License Number *
                  </label>
                  <input
                    type="text"
                    required
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    value={licenseForm.licenseNumber}
                    onChange={(e) => setLicenseForm((prev: CreateLicenseRequest) => ({ ...prev, licenseNumber: e.target.value }))}
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    License Type
                  </label>
                  <select
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    value={licenseForm.licenseType}
                    onChange={(e) => setLicenseForm((prev: CreateLicenseRequest) => ({ ...prev, licenseType: e.target.value }))}
                  >
                    <option value="">Select Type</option>
                    {LICENSE_TYPES.map(type => (
                      <option key={type.value} value={type.value}>{type.label}</option>
                    ))}
                  </select>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Issue Date
                  </label>
                  <input
                    type="date"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    value={licenseForm.issueDate}
                    onChange={(e) => setLicenseForm((prev: CreateLicenseRequest) => ({ ...prev, issueDate: e.target.value }))}
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Expiration Date
                  </label>
                  <input
                    type="date"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    value={licenseForm.expirationDate}
                    onChange={(e) => setLicenseForm((prev: CreateLicenseRequest) => ({ ...prev, expirationDate: e.target.value }))}
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    License Document
                  </label>
                  {licenseForm.documentUrl ? (
                    <div className="flex items-center justify-between p-3 bg-gray-50 rounded-md">
                      <span className="text-sm text-gray-700">Document uploaded</span>
                      <button
                        type="button"
                        onClick={() => setLicenseForm((prev: CreateLicenseRequest) => ({ ...prev, documentUrl: '' }))}
                        className="text-red-600 hover:text-red-800"
                      >
                        Remove
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setUploadType('license');
                        setShowUploadModal(true);
                      }}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 flex items-center justify-center space-x-2"
                    >
                      <Upload className="h-4 w-4" />
                      <span>Upload Document</span>
                    </button>
                  )}
                </div>
                
                <div className="flex justify-end space-x-3 pt-4">
                  <button
                    type="button"
                    onClick={() => setShowAddLicenseModal(false)}
                    className="btn-secondary"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={loading}
                    className="btn-primary disabled:opacity-50"
                  >
                    {loading ? 'Adding...' : 'Add License'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Add Document Modal */}
      {showAddDocumentModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[80vh] overflow-y-auto">
            <div className="p-6">
              <h2 className="text-xl font-bold text-gray-900 mb-4">Upload Document</h2>
              
              <form onSubmit={handleAddDocument} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Document Type *
                  </label>
                  <select
                    required
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    value={documentForm.documentType}
                    onChange={(e) => setDocumentForm(prev => ({ ...prev, documentType: e.target.value }))}
                  >
                    <option value="">Select Type</option>
                    {TenantAdminAgentsService.getDocumentTypeOptions().map(type => (
                      <option key={type.value} value={type.value}>{type.label}</option>
                    ))}
                  </select>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Document File *
                  </label>
                  {documentForm.fileUrl ? (
                    <div className="flex items-center justify-between p-3 bg-gray-50 rounded-md">
                      <div>
                        <p className="text-sm font-medium text-gray-700">{documentForm.fileName}</p>
                        {documentForm.fileSize && documentForm.fileSize > 0 && (
                          <p className="text-xs text-gray-500">{documentForm.fileSize} KB</p>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => setDocumentForm(prev => ({ 
                          ...prev, 
                          fileUrl: '',
                          fileName: '',
                          fileSize: 0,
                          fileType: ''
                        }))}
                        className="text-red-600 hover:text-red-800"
                      >
                        Remove
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setUploadType('document');
                        setShowUploadModal(true);
                      }}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 flex items-center justify-center space-x-2"
                    >
                      <Upload className="h-4 w-4" />
                      <span>Upload File</span>
                    </button>
                  )}
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Description
                  </label>
                  <textarea
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    rows={3}
                    value={documentForm.description}
                    onChange={(e) => setDocumentForm(prev => ({ ...prev, description: e.target.value }))}
                    placeholder="Optional description of the document"
                  />
                </div>
                
                <div className="flex justify-end space-x-3 pt-4">
                  <button
                    type="button"
                    onClick={() => setShowAddDocumentModal(false)}
                    className="btn-secondary"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={loading || !documentForm.fileUrl}
                    className="btn-primary disabled:opacity-50"
                  >
                    {loading ? 'Uploading...' : 'Upload Document'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* File Upload Modal */}
      {showUploadModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[60vh] overflow-y-auto">
            <div className="p-6">
              <h2 className="text-xl font-bold text-gray-900 mb-4">
                Upload {uploadType === 'license' ? 'License Document' : 'File'}
              </h2>
              
              <div className="space-y-4">
                <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center">
                  <Upload className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                  <p className="text-sm text-gray-600 mb-2">
                    Click to upload or drag and drop
                  </p>
                  <p className="text-xs text-gray-500">
                    PDF, JPG, PNG up to {MAX_DOCUMENT_UPLOAD_MB}MB
                  </p>
                  <input
                    type="file"
                    className="hidden"
                    accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        handleFileUpload(file);
                      }
                    }}
                    id="file-upload"
                  />
                  <label
                    htmlFor="file-upload"
                    className="mt-4 inline-block btn-primary cursor-pointer"
                  >
                    Select File
                  </label>
                </div>
                
                <div className="flex justify-end space-x-3">
                  <button
                    type="button"
                    onClick={() => setShowUploadModal(false)}
                    className="btn-secondary"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Hierarchy Management Modal */}
      {showChangeUplineModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-[60]">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full">
            <div className="p-6">
              <h2 className="text-xl font-bold text-gray-900 mb-4">Edit Agent Hierarchy</h2>
              
              {hierarchyError && (
                <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                  {hierarchyError}
                </div>
              )}

              <div className="space-y-4">
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <h3 className="font-medium text-blue-900 mb-2">Current Setup</h3>
                  <p className="text-sm text-blue-800">
                    <strong>Agency:</strong> {agent?.AgencyName || 'Not assigned'}<br/>
                    <strong>Current Upline:</strong> {agent?.ParentAgent?.Name || 'None'}
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Change Agency
                  </label>
                  <select
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    value={selectedAgencyId || agent?.AgencyId || ''}
                    onChange={(e) => {
                      const newAgencyId = e.target.value;
                      setSelectedAgencyId(newAgencyId);
                      // Picking a different agency invalidates any upline picked from
                      // the prior agency, so reset the upline selection + options.
                      setNewUplineAgentId('');
                      setUplineDropdownOptions([]);
                    }}
                  >
                    <option value="">Select Agency...</option>
                    {propAvailableAgencies
                      .filter(agency => agency.Id && agency.Name) // Filter out agencies with null/missing data
                      .map((agency, index) => (
                        <option key={`agency-${agency.Id || index}`} value={agency.Id}>
                          {agency.Name}
                        </option>
                      ))}
                  </select>
                  <p className="text-xs text-gray-500 mt-1">
                    Switching agencies places this agent at the top level of the new agency.
                    {' '}You can optionally pick a new upline below.
                  </p>
                  {selectedAgencyId && selectedAgencyId !== agent?.AgencyId && downlineCount > 0 && (
                    <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                      <strong>Heads up:</strong> {downlineCount} downline {downlineCount === 1 ? 'agent will' : 'agents will'} also be moved to the new agency. Their reporting structure under this agent will stay intact.
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Change Upline Agent (Same Agency)
                  </label>
                  <SearchableDropdown
                    options={uplineDropdownOptions}
                    value={newUplineAgentId}
                    onChange={(value) => setNewUplineAgentId(value)}
                    placeholder="Search by name or email..."
                    searchPlaceholder="Type to search agents..."
                    useBackendSearch={true}
                    onSearch={handleUplineAgentSearch}
                    loading={uplineSearchLoading}
                    showEmail={true}
                    disabled={!selectedAgencyId && !agent?.AgencyId}
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Optional. Pick an agent in the (new) agency or &quot;No upline (Top level)&quot;.
                  </p>
                </div>
              </div>
              
              <div className="flex justify-end space-x-3 mt-6">
                <button
                  onClick={() => {
                    setShowChangeUplineModal(false);
                    setNewUplineAgentId('');
                    setSelectedAgencyId('');
                    setHierarchyError(null);
                  }}
                  className="btn-secondary"
                >
                  Cancel
                </button>
                <button
                  onClick={handleChangeUpline}
                  disabled={
                    loading ||
                    (
                      // Nothing to save: agency unchanged AND no upline picked
                      (!selectedAgencyId || selectedAgencyId === agent?.AgencyId) &&
                      !newUplineAgentId
                    )
                  }
                  className="btn-primary"
                >
                  {loading ? 'Saving...' : 'Confirm'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showTenantMigrationWizard && agent?.Type === 'Agent' && agent.TenantId && (
        <AgentTenantMigrationWizard
          isOpen={showTenantMigrationWizard}
          agentId={agentId}
          agentName={agent.Name}
          sourceTenantId={agent.TenantId}
          sourceTenantName={
            allTenants.find((t) => t.TenantId === agent.TenantId)?.TenantName || 'Current tenant'
          }
          onClose={() => setShowTenantMigrationWizard(false)}
          onCompleted={() => {
            setShowTenantMigrationWizard(false);
            onClose();
            onUpdate?.();
          }}
        />
      )}

      {agent?.Type === 'Agent' && agent.UserId && (
        <>
          <ChangeEmailModal
            isOpen={showChangeEmailModal}
            onClose={() => setShowChangeEmailModal(false)}
            userId={agent.UserId}
            currentEmail={agent.Email || contactForm.email}
            displayName={agent.Name}
            currentRole={currentRole}
            onSuccess={() => {
              loadAgentDetails();
              onUpdate?.();
              setShowChangeEmailModal(false);
            }}
          />
          <SetTemporaryPasswordModal
            isOpen={setTempPasswordOpen}
            onClose={() => setSetTempPasswordOpen(false)}
            userId={agent.UserId}
            displayName={agent.Name}
            currentRole={currentRole}
            onSuccess={() => {
              setSetTempPasswordOpen(false);
              loadAgentDetails();
              onUpdate?.();
            }}
          />
        </>
      )}

      {statusToggleConfirm && agent && canToggleStatus && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-[80]">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              {statusToggleConfirm === 'Inactive' ? 'Deactivate this account?' : 'Reactivate this account?'}
            </h3>
            {statusToggleConfirm === 'Inactive' ? (
              <div className="text-sm text-gray-700 space-y-2 mb-4">
                <p>
                  This will set <strong>{agent.Name}</strong> to <strong>Inactive</strong>. The user will not be able to log
                  in, and the account will be hidden from the active agent list.
                </p>
                <ul className="list-disc list-inside text-gray-700">
                  <li>Login is blocked while the account is Inactive</li>
                  <li>Hidden from default agent / agency-admin lists</li>
                  <li>Existing data, commissions, and history are preserved</li>
                  <li>You can reactivate later from this same screen</li>
                </ul>
              </div>
            ) : (
              <p className="text-sm text-gray-700 mb-4">
                This will set <strong>{agent.Name}</strong> back to <strong>Active</strong>. The user will be able to log in
                again and reappear in agent lists.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setStatusToggleConfirm(null)}
                disabled={statusToggling}
                className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmStatusToggle}
                disabled={statusToggling}
                className={
                  statusToggleConfirm === 'Inactive'
                    ? 'px-3 py-1.5 text-sm rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50'
                    : 'px-3 py-1.5 text-sm rounded-lg bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50'
                }
              >
                {statusToggling
                  ? 'Working...'
                  : statusToggleConfirm === 'Inactive'
                  ? 'Deactivate'
                  : 'Reactivate'}
              </button>
            </div>
          </div>
        </div>
      )}

    </>
  );
};

// Simple status icon for downline row (matches AgentsPage getStatusIcon)
const getStatusIconForRow = (status: string) => {
  switch (status) {
    case 'Active': return <CheckCircle className="h-4 w-4 text-green-500" />;
    case 'Inactive': return <XCircle className="h-4 w-4 text-red-500" />;
    default: return <AlertCircle className="h-4 w-4 text-yellow-500" />;
  }
};

// Downline Agent Row Component with Tier Level and Override Editing
// When onViewCommissionRules/onViewLinks/onSelectAgent are provided, row matches AgentsPage UI (Rules, Links, Edit, View)
// When canEditTierAndOverride is false (e.g. Agent role), tier/override section is hidden
interface DownlineAgentRowProps {
  member: AgentHierarchy;
  parentAgentId: string;
  onUpdateTierLevel: (agentId: string, tierLevel: number) => Promise<void>;
  onUpdateOverride?: (agentId: string, overrideType: 'Percent' | 'Flatrate', overridePercentage?: number, overrideAmount?: number) => Promise<void>;
  onViewCommissionRules?: (type: 'Agent' | 'Agency', id: string, name: string) => void;
  onViewLinks?: (type: 'Agent' | 'Agency', id: string, name: string) => void;
  onSelectAgent?: (agentId: string) => void;
  currentRole?: string;
  canManageAgencies?: boolean;
  getTierLevelLabel?: (tierLevel?: number | null) => string;
  canEditTierAndOverride?: boolean;
}

const DownlineAgentRow: React.FC<DownlineAgentRowProps> = ({ member, parentAgentId, onUpdateTierLevel, onUpdateOverride, onViewCommissionRules, onViewLinks, onSelectAgent, currentRole = 'Agent', canManageAgencies = false, getTierLevelLabel, canEditTierAndOverride = true }) => {
  const [isEditingTier, setIsEditingTier] = useState(false);
  const [isEditingOverride, setIsEditingOverride] = useState(false);
  const [tierLevel, setTierLevel] = useState<number>(member.CommissionTierLevel ?? 0);
  const [overrideType, setOverrideType] = useState<'Percent' | 'Flatrate'>(member.OverrideType || 'Percent');
  const [overridePercentage, setOverridePercentage] = useState<number>(member.OverridePercentage || 0);
  const [overrideAmount, setOverrideAmount] = useState<number>(member.OverrideAmount || 0);
  const [saving, setSaving] = useState(false);
  const [savingOverride, setSavingOverride] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const handleSaveTier = async () => {
    if (tierLevel !== -1 && tierLevel !== 0) {
      alert('Tier level must be 0 or -1');
      return;
    }
    setSaving(true);
    try {
      await onUpdateTierLevel(member.AgentId, tierLevel);
      setIsEditingTier(false);
    } catch (err) {
      console.error('Error saving tier level:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setTierLevel(member.CommissionTierLevel ?? 0);
    setIsEditingTier(false);
  };

  const handleSaveOverride = async () => {
    if (overrideType === 'Percent' && (overridePercentage < 0 || overridePercentage > 100)) {
      alert('Override percentage must be between 0 and 100');
      return;
    }
    if (overrideType === 'Flatrate' && overrideAmount < 0) {
      alert('Override amount must be greater than or equal to 0');
      return;
    }
    setSavingOverride(true);
    try {
      if (onUpdateOverride) {
        await onUpdateOverride(
          member.AgentId,
          overrideType,
          overrideType === 'Percent' ? overridePercentage : undefined,
          overrideType === 'Flatrate' ? overrideAmount : undefined
        );
      } else {
        await TenantAdminAgentsService.updateAgentOverride(
          parentAgentId,
          member.AgentId,
          overrideType,
          overrideType === 'Percent' ? overridePercentage : undefined,
          overrideType === 'Flatrate' ? overrideAmount : undefined
        );
      }
      setIsEditingOverride(false);
      // Reload downline to get updated data - will be handled by parent component
    } catch (err) {
      console.error('Error saving override:', err);
      alert('Failed to save override');
    } finally {
      setSavingOverride(false);
    }
  };

  const handleCancelOverride = () => {
    setOverrideType(member.OverrideType || 'Percent');
    setOverridePercentage(member.OverridePercentage || 0);
    setOverrideAmount(member.OverrideAmount || 0);
    setIsEditingOverride(false);
  };

  const hasPortalActions = onViewCommissionRules || onViewLinks || onSelectAgent;
  const commissionLevelName = (member as { CommissionLevelName?: string | null }).CommissionLevelName;
  const tierLabel =
    (commissionLevelName && String(commissionLevelName).trim()) ||
    (getTierLevelLabel
      ? getTierLevelLabel(member.CommissionTierLevel).replace(/^Level\s-?\d+(\.\d+)?:\s*/, '').trim()
      : getTierName(member.CommissionTierLevel ?? 0));
  const status = member.Status || 'Active';

  return (
    <div className="border rounded-lg overflow-hidden hover:bg-gray-50 transition-colors">
      {/* Main row: same layout as AgentsPage agent row (Users icon, name, tier badge, email, NPN, status, Rules/Links/Edit/View) */}
      <div className={`flex items-center justify-between p-3 ${hasPortalActions ? 'bg-gray-50' : ''} ${!hasPortalActions ? 'hover:bg-gray-50' : 'hover:bg-gray-100'}`}>
        <div className="flex items-center space-x-3">
          {member.Level > 0 && (
            <div className="flex items-center text-gray-400 shrink-0">
              {Array.from({ length: member.Level }).map((_, i) => (
                <ChevronRight key={i} className="h-4 w-4" />
              ))}
            </div>
          )}
          <Users className="h-4 w-4 text-oe-primary shrink-0" />
          <div>
            <div className="flex items-center space-x-2 flex-wrap">
              <span className="font-medium text-gray-900">{member.AgentName}</span>
              {member.CommissionTierLevel !== undefined && member.CommissionTierLevel !== null && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 border border-blue-200">
                  <DollarSign className="h-3 w-3 mr-1" />
                  {tierLabel}
                </span>
              )}
            </div>
            <div className="text-sm text-gray-500">{member.Email}</div>
          </div>
        </div>
        <div className="flex items-center space-x-4">
          {status !== 'Active' && (
            <div className="flex items-center space-x-1 text-sm text-gray-500">
              {getStatusIconForRow(status)}
              <span>{formatAgentLifecycleStatusLabel(status)}</span>
            </div>
          )}
          {hasPortalActions && (
            <div className="flex space-x-1">
              {currentRole !== 'Agent' && onViewCommissionRules && (
                <button
                  onClick={() => onViewCommissionRules('Agent', member.AgentId, member.AgentName)}
                  className="flex items-center space-x-1 text-gray-600 hover:text-oe-primary px-2 py-1 rounded transition-colors"
                  title="View Commission Rules"
                >
                  <DollarSign className="h-4 w-4" />
                  <span className="text-sm">Rules</span>
                </button>
              )}
              {onViewLinks && (
                <button
                  onClick={() => onViewLinks('Agent', member.AgentId, member.AgentName)}
                  className="flex items-center space-x-1 text-gray-600 hover:text-oe-primary px-2 py-1 rounded transition-colors"
                  title="View Onboarding Links"
                >
                  <Link className="h-4 w-4" />
                  <span className="text-sm">Links</span>
                </button>
              )}
              {canManageAgencies && onSelectAgent && (
                <button
                  onClick={() => onSelectAgent(member.AgentId)}
                  className="flex items-center space-x-1 text-gray-600 hover:text-gray-900 px-2 py-1 rounded transition-colors"
                  title="Edit agent"
                >
                  <Edit className="h-4 w-4" />
                  <span className="text-sm">Edit</span>
                </button>
              )}
              {onSelectAgent && (
                <button
                  onClick={() => onSelectAgent(member.AgentId)}
                  className="text-gray-600 hover:text-gray-900 p-1"
                  title="View Details"
                >
                  <Eye className="h-4 w-4" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {/* Tier / Override editing - only for TenantAdmin/SysAdmin (canEditTierAndOverride) */}
      {canEditTierAndOverride && (
      <div className="border-t border-gray-100 px-3 py-2 bg-white">
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="text-xs text-oe-primary hover:text-oe-dark font-medium"
        >
          {showAdvanced ? 'Hide' : 'Show'} tier & override
        </button>
        {showAdvanced && (
          <div className="mt-2 space-y-2 text-sm">
            <div>
              <span className="text-gray-600">Commission Role: </span>
              <span className="font-medium text-gray-700">{member.CommissionRole || 'Agent'}</span>
            </div>
            {isEditingTier ? (
              <div className="flex items-center space-x-2">
                <select
                  value={tierLevel}
                  onChange={(e) => setTierLevel(Number(e.target.value))}
                  className="text-xs px-2 py-1 border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-oe-primary"
                  disabled={saving}
                >
                  <option value={0}>0 (Agent)</option>
                  <option value={-1}>-1 (Associate)</option>
                </select>
                <button onClick={handleSaveTier} disabled={saving} className="text-xs px-2 py-1 bg-oe-primary text-white rounded hover:bg-oe-primary-dark disabled:opacity-50">{saving ? 'Saving...' : 'Save'}</button>
                <button onClick={handleCancel} disabled={saving} className="text-xs px-2 py-1 bg-gray-200 text-gray-700 rounded">Cancel</button>
              </div>
            ) : (
              <div className="text-gray-500">
                Commission level: {tierLabel}
                <button onClick={() => setIsEditingTier(true)} className="ml-2 text-oe-primary hover:text-oe-primary-dark" title="Edit tier level"><Edit className="h-3 w-3 inline" /></button>
              </div>
            )}
            {isEditingOverride ? (
              <div className="space-y-2">
                <div className="flex items-center space-x-2">
                  <select value={overrideType} onChange={(e) => setOverrideType(e.target.value as 'Percent' | 'Flatrate')} className="text-xs px-2 py-1 border border-gray-300 rounded" disabled={savingOverride}>
                    <option value="Percent">Percent</option>
                    <option value="Flatrate">Flatrate</option>
                  </select>
                  {overrideType === 'Percent' ? (
                    <div className="flex items-center space-x-1">
                      <input type="number" min="0" max="100" step="0.01" value={overridePercentage} onChange={(e) => setOverridePercentage(parseFloat(e.target.value) || 0)} className="text-xs w-20 px-2 py-1 border border-gray-300 rounded" disabled={savingOverride} />
                      <span className="text-xs text-gray-500">%</span>
                    </div>
                  ) : (
                    <div className="flex items-center space-x-1">
                      <span className="text-xs text-gray-500">$</span>
                      <input type="number" min="0" step="0.01" value={overrideAmount} onChange={(e) => setOverrideAmount(parseFloat(e.target.value) || 0)} className="text-xs w-24 px-2 py-1 border border-gray-300 rounded" disabled={savingOverride} />
                    </div>
                  )}
                </div>
                <div className="flex items-center space-x-2">
                  <button onClick={handleSaveOverride} disabled={savingOverride} className="text-xs px-2 py-1 bg-oe-primary text-white rounded disabled:opacity-50">{savingOverride ? 'Saving...' : 'Save'}</button>
                  <button onClick={handleCancelOverride} disabled={savingOverride} className="text-xs px-2 py-1 bg-gray-200 text-gray-700 rounded">Cancel</button>
                </div>
              </div>
            ) : (
              <div className="text-gray-500">
                {member.OverrideType === 'Flatrate' && member.OverrideAmount ? <>Override: ${member.OverrideAmount.toFixed(2)}</> : member.OverridePercentage && member.OverridePercentage > 0 ? <>Override: {member.OverridePercentage}%</> : <>No override</>}
                <button onClick={() => setIsEditingOverride(true)} className="ml-2 text-oe-primary hover:text-oe-primary-dark" title="Edit override"><Edit className="h-3 w-3 inline" /></button>
              </div>
            )}
          </div>
        )}
      </div>
      )}
    </div>
  );
};

export default AgentManagementModal;