// FILE PATH: frontend/src/pages/groups/GroupsPage.tsx
// FIXED VERSION with proper URL handling and enhanced debugging

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
    AlertTriangle,
    ArrowLeftRight,
    Building,
    Calendar,
    ChevronRight,
    DollarSign,
    Download,
    LayoutGrid,
    List,
    Mail,
    MapPin,
    Phone,
    Plus,
    Search,
    SlidersHorizontal,
    User,
    UserCheck,
    Users,
    X,
    XCircle
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import W9RequirementNotice from '../../components/agent/W9RequirementNotice';
import GroupTypeChangeRequestsModal from '../../components/groups/GroupTypeChangeRequestsModal';
import { GroupBadge, PendingMigrationBadge } from '../../components/groups/GroupBadge';
import { useAgentPendingTypeChanges } from '../../hooks/agent/useAgentPendingTypeChanges';
import { usePendingGroupTypeChangeRequests } from '../../hooks/tenant-admin/usePendingGroupTypeChangeRequests';
import SearchableDropdown from '../../components/common/SearchableDropdown';
import {
  AGENT_FILTER_SCOPE_AGENCY,
  AGENT_FILTER_SCOPE_DIRECT_DOWNLINE,
  AGENT_FILTER_SHOW_ALL,
  getInitialAgentFilterIdFromStorage
} from '../../constants/agentFilterScope';
import { getTierLevelLabel } from '../../constants/form-options';
import { useAuth } from '../../contexts/AuthContext'; // Re-add useAuth
import useAgentW9Requirement from '../../hooks/agent/useAgentW9Requirement';
import { useCommissionLevels } from '../../hooks/useCommissionLevels';
import { useDownlineAgentsForFilter } from '../../hooks/useDownlineAgentsForFilter';
import { useGroups } from '../../hooks/useGroups';
import { AgentService } from '../../services/agent/agent.service'; // Using AgentService for mutations for now
import { AgentsService } from '../../services/agents.service';
import { apiService } from '../../services/api.service';
import { GroupOnboardingService } from '../../services/group-onboarding.service';
import { Group, GroupsService } from '../../services/groups.service';
import { buildGroupDetailPath } from '../../utils/groupRoutes';
import { SysAdminService } from '../../services/sysadmin/sysadmin.service';
import TenantAdminAgentsService from '../../services/tenant-admin/agents.service';
import { TenantAdminService } from '../../services/tenant-admin/tenant-admin.service';
import { downloadGroupsCsv } from '../../utils/groupsExport';
import { formatPhoneNumber } from '../../utils/payment-validation';
import GroupsAddGroup from './GroupsAddGroup';
import AgentManagementModal from '../tenant-admin/AgentManagementModal';

/** TenantAdminService can return { success: false } without throwing; ensure mutation fails so UI can show the API message. */
function assertGroupCreateSucceeded(result: { success?: boolean; message?: string; error?: { message?: string } }): void {
  if (result && result.success !== false) return;
  const msg =
    (typeof result?.message === 'string' && result.message.trim()) ||
    (result?.error && typeof result.error.message === 'string' && result.error.message.trim()) ||
    'Failed to create group';
  throw new Error(msg);
}

function parseGroupTypeFilterFromSearch(params: URLSearchParams): 'all' | 'Standard' | 'ListBill' {
  const g = params.get('groupType');
  if (g === 'Standard' || g === 'ListBill') return g;
  return 'all';
}

function agentPopoverTierLine(details: any, displayNameByLevel: Map<number, string>): string | null {
  if (!details || details.Type === 'Agency') return null;
  const tier = details.CommissionTierLevel;
  if (tier === undefined || tier === null) return null;
  const named =
    displayNameByLevel.get(Number(tier)) ||
    (typeof details.CommissionLevelName === 'string' && details.CommissionLevelName.trim()) ||
    getTierLevelLabel(tier);
  const s = typeof named === 'string' ? named.trim() : '';
  return s || null;
}

const GroupsAgentHoverPopoverContent: React.FC<{
  agentDetails: any;
  displayNameByLevel: Map<number, string>;
}> = ({ agentDetails, displayNameByLevel }) => {
  const agencyName =
    typeof agentDetails.AgencyName === 'string' && agentDetails.AgencyName.trim()
      ? agentDetails.AgencyName.trim()
      : null;
  const tierLine = agentPopoverTierLine(agentDetails, displayNameByLevel);
  const displayName =
    agentDetails.Name ??
    `${agentDetails.FirstName ?? ''} ${agentDetails.LastName ?? ''}`.trim();

  return (
    <div className="space-y-2 text-sm">
      <div className="font-medium text-gray-900">{displayName || 'Agent'}</div>
      {agencyName && (
        <div className="flex items-center text-gray-600">
          <Building className="h-3.5 w-3.5 mr-2 flex-shrink-0 text-gray-500" />
          <span>{agencyName}</span>
        </div>
      )}
      {tierLine && (
        <div className="flex items-center text-gray-600">
          <DollarSign className="h-3.5 w-3.5 mr-2 flex-shrink-0 text-gray-500" />
          <span>{tierLine}</span>
        </div>
      )}
      {agentDetails.Email && (
        <div className="flex items-center text-gray-600">
          <Mail className="h-3.5 w-3 mr-2 flex-shrink-0" />
          {agentDetails.Email}
        </div>
      )}
      {agentDetails.Phone && (
        <div className="flex items-center text-gray-600">
          <Phone className="h-3.5 w-3 mr-2 flex-shrink-0" />
          {formatPhoneNumber(agentDetails.Phone)}
        </div>
      )}
      {agentDetails.NPN && <div className="text-gray-500">NPN: {agentDetails.NPN}</div>}
    </div>
  );
};

// Notification component
const Notification: React.FC<{ message: string; severity: 'success' | 'error'; onDismiss: () => void }> = ({ message, severity, onDismiss }) => {
  if (!message) return null;

  const bgColor = severity === 'success' ? 'bg-green-100 border-green-400 text-green-700' : 'bg-red-100 border-red-400 text-red-700';

  return (
    <div className={`fixed top-5 right-5 ${bgColor} px-4 py-3 rounded-lg shadow-md z-[60] flex items-center`}>
      {severity === 'error' && <AlertTriangle className="h-5 w-5 mr-3" />}
      <span>{message}</span>
      <button onClick={onDismiss} className="ml-4">
        <XCircle className="h-5 w-5" />
      </button>
    </div>
  );
};


// Main Groups Page Component
const GroupsPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { user } = useAuth(); // Re-add useAuth to get user for navigation
  const currentUserRole = user?.currentRole || '';
  const userRoles = user?.roles ?? [];
  const path = location.pathname;
  const isTenantAdminGroupsList =
    path.startsWith('/tenant-admin') &&
    (path === '/tenant-admin/groups' || path === '/tenant-admin/groups/');
  const canOpenAgentManagementModal =
    (path.startsWith('/tenant-admin') &&
      (userRoles.includes('TenantAdmin') || currentUserRole === 'TenantAdmin')) ||
    (path.startsWith('/admin') && (userRoles.includes('SysAdmin') || currentUserRole === 'SysAdmin'));
  const agentManagementModalRole =
    path.startsWith('/tenant-admin') &&
    (userRoles.includes('TenantAdmin') || currentUserRole === 'TenantAdmin')
      ? 'TenantAdmin'
      : path.startsWith('/admin') &&
          (userRoles.includes('SysAdmin') || currentUserRole === 'SysAdmin')
        ? 'SysAdmin'
        : currentUserRole;
  const isAgentPortal = currentUserRole === 'Agent';
  const showAgentFilter = currentUserRole === 'TenantAdmin' || currentUserRole === 'SysAdmin' || currentUserRole === 'Agent';
  const canExportGroups = currentUserRole === 'TenantAdmin' || currentUserRole === 'SysAdmin';
  const { hasW9: agentHasW9, isLoading: checkingAgentW9 } = useAgentW9Requirement({ enabled: isAgentPortal });
  const canCreateGroup = !isAgentPortal || (!checkingAgentW9 && agentHasW9);

  // Agent-only: which group rows have an approved-but-not-yet-applied
  // type-change request? Used to render the yellow action dot.
  const { groupIdsWithAction: groupIdsNeedingWizard } = useAgentPendingTypeChanges();
  const { pendingCount: pendingTypeChangeCount } = usePendingGroupTypeChangeRequests({
    enabled: isTenantAdminGroupsList,
  });
  const { displayNameByLevel } = useCommissionLevels();

  const goToGroup = useCallback((group: Group, hash?: string) => {
    navigate(buildGroupDetailPath(currentUserRole, group, hash));
  }, [navigate, currentUserRole]);

  const [searchTerm, setSearchTerm] = useState('');
  const [primaryFilter, setPrimaryFilter] = useState<'all' | 'pending' | 'enrolled'>('all');
  const [statusFilter, setStatusFilter] = useState('');
  const [groupTypeFilter, setGroupTypeFilter] = useState<'all' | 'Standard' | 'ListBill'>(() =>
    typeof window !== 'undefined'
      ? parseGroupTypeFilterFromSearch(new URLSearchParams(window.location.search))
      : 'all'
  );
  const [stateFilter, setStateFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState(
    () => getInitialAgentFilterIdFromStorage() || AGENT_FILTER_SHOW_ALL
  );
  const [productFilter, setProductFilter] = useState('');
  const [vendorFilter, setVendorFilter] = useState('');
  const [effectiveDateFilter, setEffectiveDateFilter] = useState(''); // YYYY-MM-DD; filter by month of this date
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [viewMode, setViewMode] = useState<'card' | 'list'>(() =>
    currentUserRole === 'TenantAdmin' ? 'list' : 'card'
  );
  // Default to list view when in tenant admin portal (handles auth loading after mount)
  useEffect(() => {
    if (currentUserRole === 'TenantAdmin') {
      setViewMode('list');
    }
  }, [currentUserRole]);
  const includeArchived = statusFilter === 'Archived';
  const agentIdForApi =
    currentUserRole === 'Agent' &&
    agentFilter &&
    agentFilter !== AGENT_FILTER_SHOW_ALL &&
    agentFilter !== AGENT_FILTER_SCOPE_AGENCY &&
    agentFilter !== AGENT_FILTER_SCOPE_DIRECT_DOWNLINE
      ? agentFilter
      : undefined;
  const groupsAgentScope =
    currentUserRole === 'Agent' && agentFilter === AGENT_FILTER_SHOW_ALL
      ? 'downline'
      : currentUserRole === 'Agent' && agentFilter === AGENT_FILTER_SCOPE_AGENCY
        ? 'agency'
        : currentUserRole === 'Agent' && agentFilter === AGENT_FILTER_SCOPE_DIRECT_DOWNLINE
          ? 'direct'
          : undefined;
  const productIdForApi = productFilter || undefined;
  const vendorIdForApi = vendorFilter || undefined;

  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    const parsed = parseGroupTypeFilterFromSearch(searchParams);
    setGroupTypeFilter((prev) => (prev === parsed ? prev : parsed));
  }, [searchParams]);

  const [showGroupTypeChangeRequestsModal, setShowGroupTypeChangeRequestsModal] = useState(false);

  useEffect(() => {
    if (!isTenantAdminGroupsList) return;
    const v = searchParams.get('changeRequests');
    if (v !== 'open' && v !== '1') return;
    setShowGroupTypeChangeRequestsModal(true);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('changeRequests');
        return next;
      },
      { replace: true }
    );
  }, [isTenantAdminGroupsList, searchParams, setSearchParams]);

  useEffect(() => {
    if (!isTenantAdminGroupsList && showGroupTypeChangeRequestsModal) {
      setShowGroupTypeChangeRequestsModal(false);
    }
  }, [isTenantAdminGroupsList, showGroupTypeChangeRequestsModal]);

  const groupTypeForApi: 'Standard' | 'ListBill' | undefined =
    groupTypeFilter === 'Standard' || groupTypeFilter === 'ListBill' ? groupTypeFilter : undefined;

  const setGroupTypeFilterAndUrl = (next: 'all' | 'Standard' | 'ListBill') => {
    setGroupTypeFilter(next);
    setSearchParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        if (next === 'all') n.delete('groupType');
        else n.set('groupType', next);
        return n;
      },
      { replace: true }
    );
  };

  const { data: groupsData, isLoading, isError, error } = useGroups(
    includeArchived,
    agentIdForApi,
    productIdForApi,
    vendorIdForApi,
    groupsAgentScope,
    groupTypeForApi
  );

  // Tenant / Agent: catalog filter — Group + Both + Individual (individual-market bundles can sit on groups)
  const { data: groupFilterProductsRaw = [] } = useQuery({
    queryKey: ['groupFilterProducts', currentUserRole],
    queryFn: async () => {
      if (currentUserRole === 'SysAdmin') {
        const res = await apiService.get<{ success: boolean; data: Array<{ ProductId: string; Name: string; IsBundle: number }> }>('/api/me/sysadmin/groups/products-for-filter');
        return res.success && res.data ? res.data : [];
      }
      if (currentUserRole === 'TenantAdmin' || currentUserRole === 'Agent') {
        const res = await apiService.get<{ success: boolean; data: any[] }>('/api/tenant/products?activeOnly=true');
        if (!res.success || !Array.isArray(res.data)) return [];
        const filtered = res.data.filter((p: any) => {
          const isHidden = p.IsHidden === true || p.IsHidden === 1 || p.isHidden === true || p.isHidden === 1;
          if (isHidden) return false;
          const st = (p.SalesType || p.salesType || '').toString().trim().toLowerCase();
          // Individual-market bundles/products can still be assigned to groups (e.g. ListBill).
          return st === 'group' || st === 'both' || st === 'individual';
        });
        const sorted = [...filtered].sort((a: any, b: any) => {
          const aBundle = a.IsBundle === 1 || a.IsBundle === true ? 1 : 0;
          const bBundle = b.IsBundle === 1 || b.IsBundle === true ? 1 : 0;
          if (bBundle !== aBundle) return bBundle - aBundle;
          return (a.Name || a.ProductName || '').localeCompare(b.Name || b.ProductName || '');
        });
        return sorted.map((p: any) => ({ ProductId: p.ProductId || p.productId, Name: p.Name || p.ProductName || '', IsBundle: p.IsBundle === 1 || p.IsBundle === true ? 1 : 0 }));
      }
      return [];
    },
    enabled: currentUserRole === 'TenantAdmin' || currentUserRole === 'Agent' || currentUserRole === 'SysAdmin',
  });

  const productOptions = useMemo(() => {
    return groupFilterProductsRaw.map((p: any) => ({
      id: p.ProductId,
      label: p.Name || p.ProductName || '',
      value: p.ProductId,
      sublabel: (p.IsBundle === 1 || p.IsBundle === true) ? 'Bundle' : 'Product',
    }));
  }, [groupFilterProductsRaw]);

  // Vendors for advanced filter (groups that have at least one product from this vendor)
  const { data: vendorsResponse } = useQuery({
    queryKey: ['vendorsForGroupFilter'],
    queryFn: async () => {
      const res = await apiService.get<{ success: boolean; data?: Array<{ Id: string; VendorName: string }>; pagination?: { total: number } }>('/api/vendors?limit=500');
      return res;
    },
    enabled: !!showAgentFilter,
  });
  const vendorOptions = useMemo(() => {
    const list = (vendorsResponse?.success && Array.isArray(vendorsResponse?.data)) ? vendorsResponse.data : [];
    return list.map((v: any) => ({
      id: v.Id || v.VendorId,
      label: v.VendorName || v.Name || '',
      value: v.Id || v.VendorId,
    }));
  }, [vendorsResponse]);
  
  console.log('[GroupsPage] Rendering component. Hook state:', {
    isLoading,
    isError,
    error,
    hasData: !!groupsData,
  });


  const groups: Group[] = (groupsData as any)?.data || [];

  // Helper: UTC date midnight (ms) for "today" so days-until matches backend GETUTCDATE()
  const getUtcDateMidnight = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const parseUtcDate = (dateStr: string | null | undefined): number | null => {
    const datePart = (dateStr ?? '').split('T')[0];
    if (!datePart || datePart.length < 10) return null;
    const [y, m, d] = datePart.split('-').map(Number);
    if (isNaN(y) || isNaN(m) || isNaN(d)) return null;
    return Date.UTC(y, m - 1, d);
  };

  // Helper function to calculate enrollment effective date info (UTC calendar days so "1 day" = tomorrow)
  const getEnrollmentEffectiveDateInfo = (group: Group) => {
    const todayUtc = getUtcDateMidnight(new Date());
    const earliestFutureUtc = parseUtcDate(group.EarliestFutureEffectiveDate || null);
    const earliestActiveUtc = parseUtcDate(group.EarliestActiveEffectiveDate || null);

    if (earliestFutureUtc == null) return null;
    const daysUntil = Math.round((earliestFutureUtc - todayUtc) / (1000 * 60 * 60 * 24));
    if (daysUntil < 0) return null;

    if (earliestActiveUtc != null) {
      const futureCount = group.FutureEffectiveDateCount || 0;
      return {
        text: futureCount > 0 ? `${futureCount} New Plan${futureCount !== 1 ? 's' : ''} start${futureCount === 1 ? 's' : ''} in ${daysUntil} day${daysUntil !== 1 ? 's' : ''}` : null,
        days: daysUntil,
        hasActivePlans: true
      };
    }
    return {
      text: `Plans start in ${daysUntil} day${daysUntil !== 1 ? 's' : ''}`,
      days: daysUntil,
      hasActivePlans: false
    };
  };

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [notification, setNotification] = useState({ open: false, message: '', severity: 'success' as 'success' | 'error' });
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(15);
  
  // Agent search state for TenantAdmin/SysAdmin; Agent role uses useDownlineAgentsForFilter
  const [agentOptions, setAgentOptions] = useState<Array<{ id: string; label: string; value: string; email?: string }>>([]);
  const [agentSearchLoading, setAgentSearchLoading] = useState(false);
  const { data: downlineAgentOptions = [], isLoading: isLoadingDownlineAgents, agencyWideFilterAvailable } =
    useDownlineAgentsForFilter({
      includeShowAllOption: true,
      agencyOwnerFilter: true
    });

  const isAgentWithAgencyOwner =
    currentUserRole === 'Agent' && (user?.currentRole === 'AgencyOwner' || agencyWideFilterAvailable);

  const defaultAgentFilterForPage =
    currentUserRole === 'Agent'
      ? isAgentWithAgencyOwner
        ? AGENT_FILTER_SCOPE_AGENCY
        : AGENT_FILTER_SHOW_ALL
      : '';
  const agentFilterIsNonDefault =
    currentUserRole === 'Agent' && agentFilter !== defaultAgentFilterForPage;

  useEffect(() => {
    if (user?.currentRole !== 'Agent') return;
    if (!agencyWideFilterAvailable) return;
    setAgentFilter((prev) => (prev === AGENT_FILTER_SHOW_ALL ? AGENT_FILTER_SCOPE_AGENCY : prev));
  }, [user?.currentRole, agencyWideFilterAvailable]);

  const agentFilterPlaceholderLabels = useMemo(() => {
    const agency = downlineAgentOptions.find((o) => o.value === AGENT_FILTER_SCOPE_AGENCY)?.label ?? 'All Agency Agents';
    const direct = downlineAgentOptions.find((o) => o.value === AGENT_FILTER_SCOPE_DIRECT_DOWNLINE)?.label ?? 'Direct downlines';
    const downline = downlineAgentOptions.find((o) => o.value === AGENT_FILTER_SHOW_ALL)?.label ?? 'Show all';
    return { agency, direct, downline };
  }, [downlineAgentOptions]);
  const [agentPopoverGroupId, setAgentPopoverGroupId] = useState<string | null>(null);
  const agentPopoverRef = useRef<HTMLDivElement>(null);
  const [agentManagementModalAgentId, setAgentManagementModalAgentId] = useState<string | null>(null);

  const groupForAgentPopover = (groupsData as any)?.data?.find((g: Group) => g.GroupId === agentPopoverGroupId);
  const agentIdForPopover = groupForAgentPopover?.AgentId;
  const { data: agentDetailsRes } = useQuery({
    queryKey: ['agentDetails', agentIdForPopover],
    queryFn: () => AgentsService.getAgentDetails(agentIdForPopover!, currentUserRole),
    enabled: !!agentIdForPopover && !!agentPopoverGroupId && (currentUserRole === 'Agent' || currentUserRole === 'TenantAdmin' || currentUserRole === 'SysAdmin'),
  });
  const agentDetails = agentDetailsRes?.success ? (agentDetailsRes as any).data : null;

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (agentPopoverRef.current && !agentPopoverRef.current.contains(e.target as Node)) {
        setAgentPopoverGroupId(null);
      }
    };
    if (agentPopoverGroupId) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [agentPopoverGroupId]);

  useEffect(() => {
    if (currentUserRole === 'TenantAdmin' || currentUserRole === 'SysAdmin') {
      setAgentFilter('');
    }
  }, [currentUserRole]);

  const createGroupMutation = useMutation({
    mutationFn: async (groupData: Partial<Group> & { createOnboardingLink?: boolean; logoFile?: File; existingLogoUrl?: string; userRole?: string; selectedProducts?: string[] }) => {
      // Handle logo upload first if there's a new logo file
      let logoUrl = groupData.existingLogoUrl;
      
      if (groupData.logoFile) {
        try {
          console.log('📤 Uploading logo file for group creation');
          const uploadResponse = await GroupsService.uploadGroupLogo('temp', groupData.logoFile);
          
          if (uploadResponse.success && (uploadResponse.data as any)?.[0]?.url) {
            logoUrl = (uploadResponse.data as any)[0].url;
            console.log('✅ Logo uploaded successfully:', logoUrl);
          } else {
            console.error('❌ Logo upload failed:', uploadResponse.message);
            throw new Error('Failed to upload logo');
          }
        } catch (error) {
          console.error('❌ Error uploading logo:', error);
          throw new Error('Failed to upload logo');
        }
      }
      
      // Remove frontend-only fields from group data and add logoUrl
      const { logoFile, existingLogoUrl, userRole, createOnboardingLink, ...cleanGroupData } = groupData;
      const finalGroupData = {
        ...cleanGroupData,
        ...(logoUrl && { logoUrl })
      };
      
      console.log('📋 Creating group with data:', finalGroupData);
      
      // Use role-specific service according to backend-system.md Pattern 1
      const currentRole = userRole || user?.currentRole;
      
      console.log('🔍 Using role-specific service for group creation:', currentRole);
      
      switch (currentRole) {
        case 'Agent': {
          const result = await AgentService.createGroup(finalGroupData);
          assertGroupCreateSucceeded(result);
          return result;
        }
        case 'TenantAdmin': {
          // Map the data to match TenantAdminService interface
          const tenantGroupData = {
            name: finalGroupData.Name || '',
            contactEmail: finalGroupData.ContactEmail || '',
            contactPhone: finalGroupData.ContactPhone || '',
            address: finalGroupData.Address || '',
            city: finalGroupData.City || '',
            state: finalGroupData.State || '',
            zip: finalGroupData.Zip || '',
            tenantId: finalGroupData.TenantId || '',
            agentId: finalGroupData.AgentId || '',
            selectedProducts: finalGroupData.selectedProducts || [], // Ensure selectedProducts is included
            ...finalGroupData
          };
          const tenantResult = await TenantAdminService.createTenantGroup(tenantGroupData);
          assertGroupCreateSucceeded(tenantResult);
          return tenantResult;
        }
        case 'SysAdmin': {
          const sysResult = await SysAdminService.createGroup(finalGroupData);
          assertGroupCreateSucceeded(sysResult);
          return sysResult;
        }
        default:
          console.warn('⚠️ Unknown role for group creation, falling back to Agent service:', currentRole);
          const fallback = await AgentService.createGroup(finalGroupData);
          assertGroupCreateSucceeded(fallback);
          return fallback;
      }
    },
    onSuccess: async (response: any, variables) => {
      queryClient.invalidateQueries({ queryKey: ['groups'] });
      setShowCreateModal(false);

      // Persist vendor network selections (per-vendor) once the group exists.
      // Stored in oe.GroupVendorNetworks; backend resolveIDCardVariant uses these to
      // pick the right ID card variant for each member at view/print time.
      if (response?.success && response?.data?.GroupId && (variables as any)?.vendorNetworkSelections) {
        try {
          await apiService.put(`/api/groups/${response.data.GroupId}/vendor-networks`, {
            selections: (variables as any).vendorNetworkSelections
          });
        } catch (vnErr) {
          console.error('❌ Failed to save vendor network selections post-create:', vnErr);
        }
      }

      const createdGroupId = response?.data?.GroupId;
      const initialEnrollmentPeriod = (variables as any)?.initialEnrollmentPeriod;
      if (response?.success && createdGroupId && initialEnrollmentPeriod) {
        try {
          const periodResult = await GroupsService.applyInitialEnrollmentPeriodAfterGroupCreate(
            createdGroupId,
            initialEnrollmentPeriod
          );
          if (!periodResult.success) {
            setNotification({
              open: true,
              message: `Group created but enrollment period could not be set: ${periodResult.message || 'Unknown error'}`,
              severity: 'error'
            });
          }
        } catch (periodErr) {
          console.error('❌ Failed to set initial enrollment period post-create:', periodErr);
          setNotification({
            open: true,
            message: 'Group created but enrollment period could not be set. Set it from Enrollment Links.',
            severity: 'error'
          });
        }
      }

      // Conditionally create onboarding link based on the flag
      if (response.success && response.data?.GroupId) {
        // Check if we should create the onboarding link
        const shouldCreateOnboardingLink = variables.createOnboardingLink !== false; // Default to true if not specified
        
        if (shouldCreateOnboardingLink) {
          try {
            // Create onboarding link and send email
            const onboardingResponse = await GroupOnboardingService.createOnboardingLink(
              response.data.GroupId,
              true, // Send email when creating onboarding link
              variables.ContactEmail || (variables as any).contactEmail // Use the email from the group creation form
            );
            
            if (onboardingResponse.success) {
              setNotification({ 
                open: true, 
                message: 'Group created and onboarding link sent successfully!', 
                severity: 'success' 
              });
            } else {
              setNotification({ 
                open: true, 
                message: `Group created but failed to send onboarding link: ${onboardingResponse.message}`, 
                severity: 'error' 
              });
            }
          } catch (error) {
            setNotification({ 
              open: true, 
              message: `Group created but failed to send onboarding link: ${error instanceof Error ? error.message : 'Unknown error'}`, 
              severity: 'error' 
            });
          }
        } else {
          // Group created without onboarding link
          setNotification({ 
            open: true, 
            message: 'Group created successfully! You can send the onboarding invite later from the group details page.', 
            severity: 'success' 
          });
        }
      } else {
        setNotification({ open: true, message: 'Group created successfully!', severity: 'success' });
      }
    },
  });

  const handleCreateGroup = async (groupData: any) => {
    if (isAgentPortal && (checkingAgentW9 || !agentHasW9)) {
      setShowCreateModal(false);
      setNotification({
        open: true,
        message: 'Upload your W-9 in Settings before creating a group.',
        severity: 'error'
      });
      return;
    }

    // Check if this is a "Create & Send Onboarding" request
    const isOnboardingRequest = groupData.createOnboardingLink;
    try {
      await createGroupMutation.mutateAsync({
        ...groupData,
        createOnboardingLink: isOnboardingRequest,
        userRole: user?.currentRole
      });
    } catch (err: unknown) {
      const msg =
        typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message: string }).message === 'string'
          ? (err as { message: string }).message
          : 'Failed to create group';
      setNotification({ open: true, message: msg, severity: 'error' });
      throw err;
    }
  };

  const handleOpenCreateGroup = () => {
    if (!canCreateGroup) {
      setNotification({
        open: true,
        message: checkingAgentW9
          ? 'Checking your W-9 status. Please try again in a moment.'
          : 'Upload your W-9 in Settings before creating a group.',
        severity: 'error'
      });
      return;
    }

    setShowCreateModal(true);
  };

  // Agent options for SysAdmin: derived from groups (unique AgentId + AgentName)
  const agentOptionsFromGroups = useMemo(() => {
    if (currentUserRole !== 'SysAdmin' || !groups.length) return [];
    const seen = new Set<string>();
    return groups
      .filter((g: Group) => g.AgentId && !seen.has(g.AgentId) && (seen.add(g.AgentId), true))
      .map((g: Group) => ({
        id: g.AgentId!,
        label: g.AgentName || g.AgentId || 'Unknown',
        value: g.AgentId!,
        email: undefined as string | undefined
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [currentUserRole, groups]);

  // Search for agents - Agent (AgencyOwner), TenantAdmin, or SysAdmin (client-side filter)
  const searchAgents = useCallback(async (query: string) => {
    if (currentUserRole === 'SysAdmin') {
      const q = (query || '').trim().toLowerCase();
      if (!q) {
        setAgentOptions(agentOptionsFromGroups);
        return;
      }
      setAgentOptions(
        agentOptionsFromGroups.filter(
          (a) => a.label.toLowerCase().includes(q) || (a.email && a.email.toLowerCase().includes(q))
        )
      );
      return;
    }

    if (currentUserRole === 'TenantAdmin') {
      try {
        setAgentSearchLoading(true);
        const response = await TenantAdminAgentsService.getAgentsAndAgencies({
          type: 'Agent',
          status: 'Active',
          search: query || undefined,
          page: 1,
          limit: query && query.trim().length >= 2 ? 50 : 20
        });
        if (response.success && response.data && Array.isArray(response.data)) {
          const agents = (response.data as any[])
            .filter((item: any) => item.Type === 'Agent')
            .map((item: any) => ({
              id: item.Id || item.id,
              label: item.Name || item.name || `${item.FirstName || ''} ${item.LastName || ''}`.trim(),
              value: item.Id || item.id,
              email: item.Email || item.email
            }));
          setAgentOptions(agents);
        } else {
          setAgentOptions([]);
        }
      } catch (error) {
        console.error('❌ Error loading agents (TenantAdmin):', error);
        setAgentOptions([]);
      } finally {
        setAgentSearchLoading(false);
      }
      return;
    }

    if (currentUserRole !== 'Agent') {
      setAgentOptions([]);
      return;
    }

    if (!query || query.trim().length === 0) {
      try {
        setAgentSearchLoading(true);
        const response = await AgentsService.getAgentsAndAgencies('Agent', {
          type: 'Agent',
          status: 'Active',
          page: 1,
          limit: 20
        });
        if (response.success && response.data && Array.isArray(response.data)) {
          const agents = (response.data as any[])
            .filter((item: any) => item.Type === 'Agent')
            .map((item: any) => ({
              id: item.Id || item.id,
              label: item.Name || item.name || `${item.FirstName || ''} ${item.LastName || ''}`.trim(),
              value: item.Id || item.id,
              email: item.Email || item.email
            }));
          setAgentOptions(agents);
        } else {
          setAgentOptions([]);
        }
      } catch (error) {
        console.error('❌ Error loading initial agents:', error);
        setAgentOptions([]);
      } finally {
        setAgentSearchLoading(false);
      }
      return;
    }

    if (query.length < 2) return;

    try {
      setAgentSearchLoading(true);
      const response = await AgentsService.getAgentsAndAgencies('Agent', {
        type: 'Agent',
        status: 'Active',
        page: 1,
        limit: 100
      });
      if (response.success && response.data && Array.isArray(response.data)) {
        const queryLower = query.toLowerCase();
        const agents = (response.data as any[])
          .filter((item: any) => {
            if (item.Type !== 'Agent') return false;
            const name = (item.Name || item.name || `${item.FirstName || ''} ${item.LastName || ''}`).toLowerCase();
            const email = (item.Email || item.email || '').toLowerCase();
            return name.includes(queryLower) || email.includes(queryLower);
          })
          .slice(0, 20)
          .map((item: any) => ({
            id: item.Id || item.id,
            label: item.Name || item.name || `${item.FirstName || ''} ${item.LastName || ''}`.trim(),
            value: item.Id || item.id,
            email: item.Email || item.email
          }));
        setAgentOptions(agents);
      } else {
        setAgentOptions([]);
      }
    } catch (error) {
      console.error('❌ Error searching agents:', error);
      setAgentOptions([]);
    } finally {
      setAgentSearchLoading(false);
    }
  }, [currentUserRole, agentOptionsFromGroups]);

  // Enhanced filtering logic
  const filteredGroups = useMemo(() => {
    return groups.filter((group: Group) => {
      if (searchTerm) {
        const searchLower = searchTerm.toLowerCase();
        const matchesName = group.Name?.toLowerCase().includes(searchLower);
        const matchesContact = group.PrimaryContact?.toLowerCase().includes(searchLower);
        const matchesEmail = group.ContactEmail?.toLowerCase().includes(searchLower);
        const matchesCity = group.City?.toLowerCase().includes(searchLower);
        const matchesState = group.State?.toLowerCase().includes(searchLower);
        const matchesBusinessType = group.BusinessType?.toLowerCase().includes(searchLower);

        if (!matchesName && !matchesContact && !matchesEmail && !matchesCity && !matchesState && !matchesBusinessType) {
          return false;
        }
      }

      if (primaryFilter === 'pending' && (group.ActiveEnrollments || 0) > 0) return false;
      if (primaryFilter === 'enrolled' && (group.ActiveEnrollments || 0) === 0) return false;

      if (statusFilter && group.Status !== statusFilter) {
        return false;
      }

      if (stateFilter && group.State !== stateFilter) {
        return false;
      }

      if (
        agentFilter &&
        agentFilter !== AGENT_FILTER_SHOW_ALL &&
        agentFilter !== AGENT_FILTER_SCOPE_AGENCY &&
        agentFilter !== AGENT_FILTER_SCOPE_DIRECT_DOWNLINE &&
        group.AgentId !== agentFilter
      ) {
        return false;
      }

      if (effectiveDateFilter) {
        const filterDate = new Date(effectiveDateFilter + 'T00:00:00');
        if (isNaN(filterDate.getTime())) return true;
        const filterYear = filterDate.getFullYear();
        const filterMonth = filterDate.getMonth();
        const parseDate = (dateStr: string | null | undefined): Date | null => {
          if (!dateStr) return null;
          const dateString = dateStr.includes('T') ? dateStr : `${dateStr}T00:00:00`;
          const parsed = new Date(dateString);
          return isNaN(parsed.getTime()) ? null : parsed;
        };
        const earliestFuture = parseDate(group.EarliestFutureEffectiveDate || null);
        const earliestActive = parseDate(group.EarliestActiveEffectiveDate || null);
        const inFilterMonth = (d: Date | null) =>
          d != null && d.getFullYear() === filterYear && d.getMonth() === filterMonth;
        if (!inFilterMonth(earliestFuture) && !inFilterMonth(earliestActive)) return false;
      }

      return true;
    });
  }, [groups, searchTerm, primaryFilter, statusFilter, stateFilter, agentFilter, effectiveDateFilter]);

  const totalItems = filteredGroups.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / itemsPerPage));
  const startIndex = totalItems === 0 ? 0 : (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const displayStart = totalItems === 0 ? 0 : startIndex + 1;
  const displayEnd = totalItems === 0 ? 0 : Math.min(endIndex, totalItems);
  const currentGroups = filteredGroups.slice(startIndex, Math.min(endIndex, totalItems));

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, primaryFilter, statusFilter, stateFilter, agentFilter, productFilter, effectiveDateFilter, groupTypeFilter, groups.length]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const handleItemsPerPageChange = (value: number) => {
    setItemsPerPage(value);
    setCurrentPage(1);
  };

  const handleExportGroups = () => {
    if (filteredGroups.length === 0) {
      setNotification({ open: true, message: 'No groups match the current filters to export.', severity: 'error' });
      return;
    }
    downloadGroupsCsv(filteredGroups);
    setNotification({
      open: true,
      message: `Exported ${filteredGroups.length} group${filteredGroups.length === 1 ? '' : 's'} to CSV.`,
      severity: 'success',
    });
  };

  const getUniqueStates = (): string[] => {
    const states = [...new Set(groups.map(g => g.State).filter(Boolean))] as string[];
    return states.sort();
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary"></div>
      </div>
    );
  }

  return (
    <>
      <div className="flex-1 flex flex-col">
        <Notification 
          message={notification.open ? notification.message : ''} 
          severity={notification.severity}
          onDismiss={() => setNotification({ ...notification, open: false })} 
        />
        
        {isError && <div className="p-4 m-4 bg-red-100 text-red-700 rounded">Error: {error.message}</div>}

        <div className="flex-1 overflow-auto p-6">
          {/* Quick Stats */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-6">
            <div className="bg-white rounded-lg p-6 shadow">
              <div className="flex items-center">
                <div className="p-2 bg-oe-light rounded-lg">
                  <Building className="h-5 w-5 text-oe-primary" />
                </div>
                <div className="ml-4">
                  <p className="text-sm font-medium text-gray-600">Total Groups</p>
                  <p className="text-2xl font-bold text-gray-900">{groups.length}</p>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-lg p-6 shadow">
              <div className="flex items-center">
                <div className="p-2 bg-green-100 rounded-lg">
                  <Users className="h-5 w-5 text-oe-success" />
                </div>
                <div className="ml-4">
                  <p className="text-sm font-medium text-gray-600">Total Members</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {groups.reduce((sum: number, group: Group) => sum + (group.TotalMembers || 0), 0)}
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-lg p-6 shadow">
              <div className="flex items-center">
                <div className="p-2 bg-yellow-100 rounded-lg">
                  <UserCheck className="h-5 w-5 text-oe-warning" />
                </div>
                <div className="ml-4">
                  <p className="text-sm font-medium text-gray-600">Enrolled Households</p>
                  <p className="text-2xl font-bold text-gray-900">
                    {groups.reduce((sum: number, group: Group) => sum + (group.ActiveEnrollments || 0), 0)}
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-lg p-6 shadow">
              <div className="flex items-center">
                <div className="p-2 bg-purple-100 rounded-lg">
                  <DollarSign className="h-5 w-5 text-purple-600" />
                </div>
                <div className="ml-4">
                  <p className="text-sm font-medium text-gray-600">Monthly Premium</p>
                  <p className="text-2xl font-bold text-gray-900">
                    ${groups.reduce((sum: number, group: Group) => sum + (group.MonthlyPremium || 0), 0).toLocaleString()}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Search + Create + Filters: one row each */}
          <div className="bg-white rounded-lg border border-gray-200 mb-6">
            <div className="p-6">
              {/* Search + Create Group on same row */}
              <div className="flex flex-wrap items-center gap-3 mb-4">
                <div className="flex-1 min-w-[200px]">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                    <input
                      type="text"
                      placeholder="Search groups by name, contact, email, city, state, or business type..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    />
                    {searchTerm && (
                      <button
                        onClick={() => setSearchTerm('')}
                        className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
                {canExportGroups && (
                  <button
                    type="button"
                    onClick={handleExportGroups}
                    disabled={filteredGroups.length === 0}
                    className="shrink-0 px-4 py-2 rounded-lg flex items-center space-x-2 border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Export filtered groups to CSV"
                  >
                    <Download className="h-4 w-4" />
                    <span>Export CSV</span>
                  </button>
                )}
                {isTenantAdminGroupsList && (
                  <div className="relative shrink-0">
                    <button
                      type="button"
                      onClick={() => setShowGroupTypeChangeRequestsModal(true)}
                      className="relative px-4 py-2 rounded-lg flex items-center space-x-2 border border-gray-300 text-gray-700 bg-white hover:bg-gray-50"
                    >
                      <ArrowLeftRight className="h-4 w-4" />
                      <span>Change Requests</span>
                      {pendingTypeChangeCount > 0 && (
                        <span
                          className="absolute -top-2 -right-2 min-w-[1.25rem] h-5 px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-xs font-bold shadow-sm"
                          aria-label={`${pendingTypeChangeCount} pending change request${pendingTypeChangeCount === 1 ? '' : 's'}`}
                        >
                          {pendingTypeChangeCount > 99 ? '99+' : pendingTypeChangeCount}
                        </span>
                      )}
                    </button>
                  </div>
                )}
                <div className="relative shrink-0">
                  <button
                    onClick={handleOpenCreateGroup}
                    disabled={!canCreateGroup}
                    className={`px-4 py-2 rounded-lg flex items-center space-x-2 ${
                      canCreateGroup
                        ? 'bg-oe-primary text-white hover:bg-oe-dark'
                        : 'bg-gray-300 text-gray-600 cursor-not-allowed'
                    }`}
                  >
                    <Plus className="h-4 w-4" />
                    <span>Create Group</span>
                  </button>
                  {isAgentPortal && (
                    <W9RequirementNotice
                      isChecking={checkingAgentW9}
                      isMissing={!agentHasW9}
                      targetLabel="groups"
                      onFix={() => navigate('/agent/settings?guide=w9-upload#settings-w9-upload-action')}
                      className="absolute top-full right-0 mt-1 z-10"
                    />
                  )}
                </div>
              </div>

              {/* All filters on one row (wraps) */}
              <div className="flex flex-wrap items-end gap-3">
                <select
                  value={primaryFilter}
                  onChange={(e) => setPrimaryFilter(e.target.value as 'all' | 'pending' | 'enrolled')}
                  className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary text-sm"
                >
                  <option value="all">All Groups</option>
                  <option value="pending">Pending Groups (0 enrollments)</option>
                  <option value="enrolled">Enrolled Groups (&gt;0 enrollments)</option>
                </select>
                {showAgentFilter && (
                  <div className="min-w-[180px]">
                    <SearchableDropdown
                      options={currentUserRole === 'Agent'
                        ? downlineAgentOptions.map((opt) => ({ id: opt.id, label: opt.label, value: opt.value, email: opt.email }))
                        : (currentUserRole === 'SysAdmin' ? (agentOptions.length ? agentOptions : agentOptionsFromGroups) : agentOptions)}
                      value={agentFilter || ''}
                      onChange={(value) => setAgentFilter(value)}
                      placeholder={
                        currentUserRole === 'Agent'
                          ? agentFilter === AGENT_FILTER_SCOPE_AGENCY
                            ? agentFilterPlaceholderLabels.agency
                            : agentFilter === AGENT_FILTER_SCOPE_DIRECT_DOWNLINE
                              ? agentFilterPlaceholderLabels.direct
                              : agentFilter === AGENT_FILTER_SHOW_ALL
                                ? agentFilterPlaceholderLabels.downline
                                : 'Me or specific agent'
                          : isAgentWithAgencyOwner
                            ? 'My groups'
                            : 'All agents'
                      }
                      searchPlaceholder="Type to search agents..."
                      loading={currentUserRole === 'Agent' ? isLoadingDownlineAgents : agentSearchLoading}
                      showEmail={true}
                      onSearch={currentUserRole === 'Agent' ? undefined : searchAgents}
                      useBackendSearch={currentUserRole !== 'Agent'}
                      className="w-full"
                    />
                  </div>
                )}
                {showAdvancedFilters && (
                  <>
                    <select
                      value={statusFilter}
                      onChange={(e) => setStatusFilter(e.target.value)}
                      className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary text-sm"
                    >
                      <option value="">Active groups</option>
                      <option value="Archived">Removed groups</option>
                    </select>
                    <select
                      value={stateFilter}
                      onChange={(e) => setStateFilter(e.target.value)}
                      className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary text-sm"
                    >
                      <option value="">All States</option>
                      {getUniqueStates().map((state, index) => (
                        <option key={`state-${state}-${index}`} value={state}>{state}</option>
                      ))}
                    </select>
                    <select
                      value={groupTypeFilter === 'all' ? '' : groupTypeFilter}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const next =
                          raw === '' ? 'all' : raw === 'Standard' || raw === 'ListBill' ? raw : 'all';
                        setGroupTypeFilterAndUrl(next);
                      }}
                      className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary text-sm"
                      title="Filter by group billing model"
                    >
                      <option value="">All groups</option>
                      <option value="ListBill">ListBill only</option>
                      <option value="Standard">Regular</option>
                    </select>
                    <div className="min-w-[200px]">
                      <SearchableDropdown
                        options={productOptions}
                        value={productFilter}
                        onChange={(value) => setProductFilter(value)}
                        placeholder="All products"
                        searchPlaceholder="Search products..."
                        showSublabel={true}
                        showEmailInSelection={true}
                        className="w-full"
                      />
                    </div>
                    <div className="min-w-[200px]">
                      <SearchableDropdown
                        options={vendorOptions}
                        value={vendorFilter}
                        onChange={(value) => setVendorFilter(value)}
                        placeholder="All vendors"
                        searchPlaceholder="Search vendors..."
                        className="w-full"
                      />
                    </div>
                    <div className="flex flex-col min-w-[160px]">
                      <label htmlFor="effective-date-filter" className="block text-xs font-medium text-gray-500 mb-0.5">Effective in month</label>
                      <input
                        id="effective-date-filter"
                        type="date"
                        value={effectiveDateFilter}
                        onChange={(e) => setEffectiveDateFilter(e.target.value)}
                        className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary text-sm"
                        title="Pick any date in the month to filter groups with plans effective that month"
                      />
                    </div>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => setShowAdvancedFilters((prev) => !prev)}
                  className={`inline-flex items-center px-3 py-2 text-sm rounded-lg border ${showAdvancedFilters ? 'bg-gray-100 border-gray-400 text-gray-800' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
                >
                  <SlidersHorizontal className="h-4 w-4 mr-2" />
                  {showAdvancedFilters ? 'Hide advanced' : 'Advanced filters'}
                </button>
                {(searchTerm ||
                  primaryFilter !== 'all' ||
                  statusFilter ||
                  stateFilter ||
                  groupTypeFilter !== 'all' ||
                  agentFilterIsNonDefault ||
                  (!!agentFilter && currentUserRole !== 'Agent') ||
                  productFilter ||
                  vendorFilter ||
                  effectiveDateFilter) && (
                  <button
                    onClick={() => {
                      setSearchTerm('');
                      setPrimaryFilter('all');
                      setStatusFilter('');
                      setStateFilter('');
                      setGroupTypeFilterAndUrl('all');
                      setAgentFilter(defaultAgentFilterForPage);
                      setProductFilter('');
                      setVendorFilter('');
                      setEffectiveDateFilter('');
                    }}
                    className="inline-flex items-center px-3 py-2 text-sm text-gray-600 hover:text-gray-800 border border-gray-300 rounded-lg hover:bg-gray-50"
                  >
                    <X className="h-3 w-3 mr-1" />
                    Clear filters
                  </button>
                )}
              </div>
            </div>
          </div>

          {filteredGroups.length > 0 && (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
              <div className="flex flex-wrap items-center gap-3 sm:gap-4">
                <span className="text-sm text-gray-700">
                  {totalItems === 0 ? '0 groups' : totalItems === 1 ? '1 group' : `Showing ${displayStart}–${displayEnd} of ${totalItems} groups`}
                </span>
                <div className="flex items-center space-x-2">
                  <span className="text-sm text-gray-700">Show</span>
                  <select
                    value={itemsPerPage}
                    onChange={(e) => handleItemsPerPageChange(Number(e.target.value))}
                    className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  >
                    <option value={15}>15</option>
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                  </select>
                </div>
                <div className="flex rounded-lg border border-gray-300 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setViewMode('card')}
                    className={`px-3 py-1.5 ${viewMode === 'card' ? 'bg-oe-primary text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
                    title="Card view"
                  >
                    <LayoutGrid className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode('list')}
                    className={`px-3 py-1.5 ${viewMode === 'list' ? 'bg-oe-primary text-white' : 'bg-white text-gray-700 hover:bg-gray-50'}`}
                    title="List view"
                  >
                    <List className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {totalPages > 1 && (
                <div className="flex items-center space-x-2">
                  <button
                    onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
                    disabled={currentPage === 1}
                    className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Previous
                  </button>
                  <span className="text-sm text-gray-700">
                    Page {currentPage} of {totalPages}
                  </span>
                  <button
                    onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))}
                    disabled={currentPage === totalPages}
                    className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Next
                  </button>
                </div>
              )}
            </div>
          )}

            <div className="overflow-x-auto pb-40">
              {/* Groups Cards Grid */}
              {filteredGroups.length === 0 ? (
                <div className="text-center py-12">
                  <Building className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                  <h3 className="text-lg font-medium text-gray-900 mb-2">No groups found</h3>
                  <p className="text-gray-600">
                    {searchTerm ||
                    primaryFilter !== 'all' ||
                    statusFilter ||
                    stateFilter ||
                    agentFilterIsNonDefault ||
                    (!!agentFilter && currentUserRole !== 'Agent') ||
                    productFilter ||
                    vendorFilter ||
                    effectiveDateFilter
                      ? 'Try adjusting your search terms or filters'
                      : 'Create your first group to get started'
                    }
                  </p>
                </div>
              ) : viewMode === 'list' ? (
                <div className="bg-white rounded-lg border border-gray-200 overflow-hidden pb-40">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Group</th>
                        <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Primary contact</th>
                        <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Agent</th>
                        <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Enrollments</th>
                        <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Monthly premium</th>
                        <th scope="col" className="relative px-6 py-3"><span className="sr-only">Actions</span></th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {currentGroups.map((group: Group) => (
                        <tr key={group.GroupId} className="hover:bg-gray-50">
                          <td className="px-6 py-4 whitespace-nowrap">
                            <div className="flex items-center">
                              <div className="h-10 w-10 flex-shrink-0">
                                {group.LogoUrl ? (
                                  <img src={group.LogoUrl} alt="" className="h-10 w-10 rounded-lg object-contain bg-gray-50" onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.nextElementSibling?.classList.remove('hidden'); }} />
                                ) : null}
                                <div className={`${group.LogoUrl ? 'hidden' : ''} h-10 w-10 bg-oe-light rounded-lg flex items-center justify-center`}>
                                  <Building className="h-5 w-5 text-oe-primary" />
                                </div>
                              </div>
                              <div className="ml-4">
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      goToGroup(group);
                                    }}
                                    className="text-sm font-medium text-gray-900 text-left hover:text-oe-primary hover:underline"
                                  >
                                    {group.Name}
                                  </button>
                                  {group.GroupType && <GroupBadge type={group.GroupType} />}
                                  {(group.IsPendingMigration || group.IsE123Migrated) && (
                                    <PendingMigrationBadge
                                      isE123Migrated={Boolean(group.IsE123Migrated)}
                                      pendingMemberCount={group.PendingMigrationMemberCount ?? 0}
                                    />
                                  )}
                                  {group.Status === 'Archived' && (
                                    <span className="inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded-full bg-stone-200 text-stone-800 border border-stone-400">
                                      Removed
                                    </span>
                                  )}
                                  {groupIdsNeedingWizard.has(group.GroupId.toUpperCase()) && (
                                    <span
                                      title="Conversion approved — finish in the wizard"
                                      className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium text-red-800 bg-red-100 border border-red-300 rounded-full"
                                    >
                                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500"></span>
                                      Action needed
                                    </span>
                                  )}
                                </div>
                                {group.BusinessType && <div className="text-sm text-gray-500">{group.BusinessType}</div>}
                                {(() => {
                                  const effectiveDateInfo = getEnrollmentEffectiveDateInfo(group);
                                  if (effectiveDateInfo?.text) {
                                    return (
                                      <span className={`inline-flex items-center mt-1 px-2 py-0.5 text-xs font-semibold rounded-full ${
                                        effectiveDateInfo.days <= 7
                                          ? 'bg-amber-100 text-amber-800 border border-amber-400'
                                          : effectiveDateInfo.days <= 30
                                          ? 'bg-blue-100 text-blue-800 border border-blue-400'
                                          : 'bg-indigo-100 text-indigo-800 border border-indigo-400'
                                      }`}>
                                        <Calendar className="h-3 w-3 mr-1 flex-shrink-0" />
                                        {effectiveDateInfo.text}
                                      </span>
                                    );
                                  }
                                  return null;
                                })()}
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4">
                            <div className="text-sm text-gray-900">{group.PrimaryContact || group.AdminName || '—'}</div>
                            {group.ContactEmail && <div className="text-sm text-gray-500">{group.ContactEmail}</div>}
                            {group.ContactPhone && (
                              <div className="text-sm text-gray-500">{formatPhoneNumber(group.ContactPhone)}</div>
                            )}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <div
                              className="relative"
                              ref={agentPopoverGroupId === group.GroupId ? agentPopoverRef : undefined}
                              onMouseEnter={() => {
                                if (group.AgentId) setAgentPopoverGroupId(group.GroupId);
                              }}
                              onMouseLeave={() => {
                                setAgentPopoverGroupId((prev) => (prev === group.GroupId ? null : prev));
                              }}
                            >
                              {group.AgentId ? (
                                <>
                                  <button
                                    type="button"
                                    onMouseDown={(e) => e.stopPropagation()}
                                    onClick={() => {
                                      if (canOpenAgentManagementModal) {
                                        setAgentPopoverGroupId(null);
                                        setAgentManagementModalAgentId(group.AgentId!);
                                      } else {
                                        setAgentPopoverGroupId(agentPopoverGroupId === group.GroupId ? null : group.GroupId);
                                      }
                                    }}
                                    className="text-sm font-medium text-oe-primary hover:text-oe-dark hover:underline"
                                  >
                                    {group.AgentName || 'View agent'}
                                    {group.AgentCode && (
                                      <span className="ml-2 text-xs font-mono text-gray-500">
                                        ({group.AgentCode})
                                      </span>
                                    )}
                                  </button>
                                  {agentPopoverGroupId === group.GroupId && (
                                    <div className="absolute left-0 top-full z-10 mt-1 w-72 rounded-lg border border-gray-200 bg-white py-3 px-4 shadow-lg">
                                      {agentDetails ? (
                                        <GroupsAgentHoverPopoverContent
                                          agentDetails={agentDetails}
                                          displayNameByLevel={displayNameByLevel}
                                        />
                                      ) : (
                                        <div className="text-sm text-gray-500">Loading…</div>
                                      )}
                                    </div>
                                  )}
                                </>
                              ) : (
                                <span className="text-sm text-gray-400">—</span>
                              )}
                            </div>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{group.ActiveEnrollments ?? 0}</td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">${(group.MonthlyPremium ?? 0).toLocaleString()}</td>
                          <td className="px-6 py-4 whitespace-nowrap text-right text-sm">
                            <button
                              onClick={() => {
                                goToGroup(group);
                              }}
                              className="text-oe-primary hover:text-oe-dark font-medium inline-flex items-center"
                            >
                              Manage Group
                              <ChevronRight className="h-4 w-4 ml-0.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 pb-40">
                  {currentGroups.map((group: Group) => (
                    <div key={group.GroupId} className="bg-white rounded-lg border border-gray-200 hover:shadow-md transition-shadow overflow-hidden flex flex-col h-full">
                      {/* Group Header */}
                      <div className="bg-gradient-to-r from-oe-light to-oe-light p-6 relative">
                        <div className="flex items-start justify-between">
                          <div className="flex items-center space-x-4">
                            <div className="h-16 w-16 flex-shrink-0">
                              {group.LogoUrl ? (
                                <img 
                                  src={group.LogoUrl} 
                                  alt={`${group.Name} logo`}
                                  className="h-full w-full rounded-lg object-contain bg-white p-1"
                                  onError={(e) => {
                                    e.currentTarget.style.display = 'none';
                                    e.currentTarget.nextElementSibling?.classList.remove('hidden');
                                  }}
                                />
                              ) : null}
                              <div className={`${group.LogoUrl ? 'hidden' : ''} h-full w-full bg-oe-light rounded-lg flex items-center justify-center`}>
                                <Building className="h-8 w-8 text-oe-primary" />
                              </div>
                            </div>
                            <div className="flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <h3 className="text-lg font-semibold text-gray-900">{group.Name}</h3>
                                {group.Status === 'Archived' && (
                                  <span className="inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded-full bg-stone-200 text-stone-800 border border-stone-400">
                                    Removed
                                  </span>
                                )}
                                {groupIdsNeedingWizard.has(group.GroupId.toUpperCase()) && (
                                  <span
                                    title="Conversion approved — finish in the wizard"
                                    className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium text-red-800 bg-red-100 border border-red-300 rounded-full"
                                  >
                                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500"></span>
                                    Action needed
                                  </span>
                                )}
                                {(group.IsPendingMigration || group.IsE123Migrated) && (
                                  <PendingMigrationBadge
                                    isE123Migrated={Boolean(group.IsE123Migrated)}
                                    pendingMemberCount={group.PendingMigrationMemberCount ?? 0}
                                  />
                                )}
                              </div>
                              {group.BusinessType && (
                                <p className="text-sm text-gray-600">{group.BusinessType}</p>
                              )}
                            </div>
                          </div>
                          
                          {/* Status Badges */}
                          <div className="flex flex-col items-end space-y-2">
                            {(() => {
                              const effectiveDateInfo = getEnrollmentEffectiveDateInfo(group);
                              const hasEffectiveDatePill = !!(effectiveDateInfo && effectiveDateInfo.text);
                              const isListBill = group.GroupType === 'ListBill';
                              const isRemoved = group.Status === 'Archived';

                              if (hasEffectiveDatePill || isListBill || isRemoved) {
                                return (
                                  <div className="flex items-center justify-end gap-2 flex-wrap">
                                    {hasEffectiveDatePill && (
                                      <span className={`inline-flex items-center px-2 py-1 text-xs font-semibold rounded-full transition-all duration-200 ${
                                        effectiveDateInfo.days <= 7
                                          ? 'bg-gradient-to-br from-amber-100 to-amber-200 text-amber-800 border border-amber-400 shadow-sm hover:shadow-md hover:-translate-y-0.5'
                                          : effectiveDateInfo.days <= 30
                                          ? 'bg-gradient-to-br from-blue-100 to-blue-200 text-blue-800 border border-blue-400 shadow-sm hover:shadow-md hover:-translate-y-0.5'
                                          : 'bg-gradient-to-br from-indigo-100 to-indigo-200 text-indigo-800 border border-indigo-400 shadow-sm hover:shadow-md hover:-translate-y-0.5'
                                      }`}>
                                        <Calendar className="h-3 w-3 mr-1" />
                                        {effectiveDateInfo.text}
                                      </span>
                                    )}
                                    {isListBill && <GroupBadge type="ListBill" />}
                                    {isRemoved && (
                                      <span className="inline-flex items-center px-2 py-1 text-xs font-semibold rounded-full bg-stone-200 text-stone-800 border border-stone-400">
                                        Removed
                                      </span>
                                    )}
                                  </div>
                                );
                              }

                              // Only show inactive status if group is inactive and no top pills are shown
                              if (group.Status !== 'Active') {
                                return (
                                  <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-gray-100 text-gray-800">
                                    {group.Status === 'Archived' ? 'Removed' : group.Status}
                                  </span>
                                );
                              }
                              return null;
                            })()}
                            {group.OnboardingStatus && (
                              <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                                group.OnboardingStatus === 'Onboarding Complete' 
                                  ? 'bg-green-100 text-green-800'
                                  : group.OnboardingStatus === 'Pending Onboarding'
                                  ? 'bg-yellow-100 text-yellow-800'
                                  : group.OnboardingStatus === 'Onboarding Expired'
                                  ? 'bg-red-100 text-red-800'
                                  : 'bg-gray-100 text-gray-800'
                              }`}>
                                {group.OnboardingStatus}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Group Details */}
                      <div className="p-6 flex flex-col h-full">
                        {/* Content Area - grows to push button to bottom */}
                        <div className="flex-grow space-y-4">
                          {/* Contact Information */}
                          <div className="space-y-2">
                            <div className="flex items-center text-sm">
                              <Users className="h-4 w-4 text-gray-400 mr-2" />
                              <span className="font-medium text-gray-700">Contact:</span>
                              <span className="text-gray-900 ml-2">{group.PrimaryContact || group.AdminName || 'Not set'}</span>
                            </div>
                            
                            {group.ContactEmail && (
                              <div className="flex items-center text-sm">
                                <Mail className="h-4 w-4 text-gray-400 mr-2" />
                                <span className="text-gray-900">{group.ContactEmail}</span>
                              </div>
                            )}
                            
                            {(() => {
                              const formattedPhone = group.ContactPhone ? formatPhoneNumber(group.ContactPhone) : '';
                              return formattedPhone && (
                                <div className="flex items-center text-sm">
                                  <Phone className="h-4 w-4 text-gray-400 mr-2" />
                                  <span className="text-gray-900">{formattedPhone}</span>
                                </div>
                              );
                            })()}
                            
                            {(group.City || group.State) && (
                              <div className="flex items-center text-sm">
                                <MapPin className="h-4 w-4 text-gray-400 mr-2" />
                                <span className="text-gray-900">{group.City}, {group.State}</span>
                              </div>
                            )}
                            {group.AgentId && (group.AgentName != null && group.AgentName !== '') && (
                              <div
                                className="relative inline-flex flex-wrap items-center text-sm max-w-full"
                                ref={agentPopoverGroupId === group.GroupId ? agentPopoverRef : undefined}
                                onMouseEnter={() => {
                                  if (group.AgentId) setAgentPopoverGroupId(group.GroupId);
                                }}
                                onMouseLeave={() => {
                                  setAgentPopoverGroupId((prev) => (prev === group.GroupId ? null : prev));
                                }}
                              >
                                <User className="h-4 w-4 text-gray-400 mr-2 flex-shrink-0" />
                                <span className="font-medium text-gray-700">Agent:</span>
                                <button
                                  type="button"
                                  onMouseDown={(e) => e.stopPropagation()}
                                  onClick={() => {
                                    if (canOpenAgentManagementModal) {
                                      setAgentPopoverGroupId(null);
                                      setAgentManagementModalAgentId(group.AgentId!);
                                    } else {
                                      setAgentPopoverGroupId(agentPopoverGroupId === group.GroupId ? null : group.GroupId);
                                    }
                                  }}
                                  className="text-gray-900 ml-2 text-left hover:text-oe-primary hover:underline font-normal"
                                >
                                  {group.AgentName}
                                  {group.AgentCode && (
                                    <span className="ml-2 text-xs font-mono text-gray-500">
                                      ({group.AgentCode})
                                    </span>
                                  )}
                                </button>
                                {agentPopoverGroupId === group.GroupId && (
                                  <div className="absolute left-0 top-full z-10 mt-1 w-72 rounded-lg border border-gray-200 bg-white py-3 px-4 shadow-lg">
                                    {agentDetails ? (
                                      <GroupsAgentHoverPopoverContent
                                        agentDetails={agentDetails}
                                        displayNameByLevel={displayNameByLevel}
                                      />
                                    ) : (
                                      <div className="text-sm text-gray-500">Loading…</div>
                                    )}
                                  </div>
                                )}
                              </div>
                            )}
                            {!group.AgentId && (group.AgentName != null && group.AgentName !== '') && (
                              <div className="flex items-center text-sm">
                                <User className="h-4 w-4 text-gray-400 mr-2" />
                                <span className="font-medium text-gray-700">Agent:</span>
                                <span className="text-gray-900 ml-2">{group.AgentName}</span>
                                {group.AgentCode && (
                                  <span className="ml-2 text-xs font-mono text-gray-500">
                                    ({group.AgentCode})
                                  </span>
                                )}
                              </div>
                            )}
                          </div>

                          {/* Metrics */}
                          <div className="grid grid-cols-2 gap-4 pt-4 border-t border-gray-100">
                            <div className="text-center">
                              <div className="flex items-center justify-center text-2xl font-bold text-gray-900">
                                <UserCheck className="h-5 w-5 text-oe-primary mr-1" />
                                {group.ActiveEnrollments || 0}
                              </div>
                              <p className="text-xs text-gray-500">Enrolled Households</p>
                            </div>
                            
                            <div className="text-center">
                              <div className="flex items-center justify-center text-2xl font-bold text-gray-900">
                                <DollarSign className="h-5 w-5 text-oe-success mr-1" />
                                {(group.MonthlyPremium || 0).toLocaleString()}
                              </div>
                              <p className="text-xs text-gray-500">Monthly Premium</p>
                            </div>
                          </div>

                          {/* Total Members */}
                          <div className="flex items-center justify-center text-sm text-gray-600 pt-2">
                            <Users className="h-4 w-4 mr-1" />
                            <span>{group.TotalMembers || 0} total members</span>
                          </div>
                        </div>

                        {/* Action Buttons - Fixed at bottom */}
                        <div className="flex space-x-2 pt-4 mt-auto">
                          <button
                            onClick={(e) => {
                              e.preventDefault();
                              goToGroup(group);
                            }}
                            className="flex-1 inline-flex items-center justify-center px-3 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 transition-colors"
                          >
                            Manage Group
                            <ChevronRight className="h-4 w-4 ml-1" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
          </div>
        </div>
      </div>
      <GroupsAddGroup
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSubmit={handleCreateGroup}
        mode="create"
      />
      {agentManagementModalAgentId && canOpenAgentManagementModal && (
        <AgentManagementModal
          agentId={agentManagementModalAgentId}
          isOpen={true}
          onClose={() => setAgentManagementModalAgentId(null)}
          onUpdate={() => {
            queryClient.invalidateQueries({ queryKey: ['groups'] });
          }}
          currentRole={agentManagementModalRole}
        />
      )}
      {isTenantAdminGroupsList && (
        <GroupTypeChangeRequestsModal
          isOpen={showGroupTypeChangeRequestsModal}
          onClose={() => setShowGroupTypeChangeRequestsModal(false)}
        />
      )}
    </>
  );
};

export default GroupsPage;
