// File: frontend/src/pages/members/MembersPage.tsx
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SlidersHorizontal, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import SearchableDropdown from '../../components/common/SearchableDropdown';
import {
  AGENT_FILTER_SCOPE_AGENCY,
  AGENT_FILTER_SCOPE_DIRECT_DOWNLINE,
  AGENT_FILTER_SHOW_ALL,
  getInitialAgentFilterIdFromStorage,
  isAgentFilterScopeSentinel
} from '../../constants/agentFilterScope';
import BulkEnrollmentLinkModal from '../../components/shared/BulkEnrollmentLinkModal';
import IndividualEnrollmentLinkModal from '../../components/shared/IndividualEnrollmentLinkModal';
import MemberEdit from '../../components/shared/MemberEdit';
import QuickEnrollmentLinkModal from '../../components/shared/QuickEnrollmentLinkModal';
import { useAuth } from '../../hooks';
import { useDownlineAgentsForFilter } from '../../hooks/useDownlineAgentsForFilter';
import { useGroups } from '../../hooks/useGroups';
import { useMemberMetrics, useMembers } from '../../hooks/useMembers';
import { AgentService } from '../../services/agent/agent.service';
import { AgentsService } from '../../services/agents.service';
import { apiService } from '../../services/api.service';
import { MemberFilterState, MembersService } from '../../services/members.service';
import { SysAdminService } from '../../services/sysadmin/sysadmin.service';
import { TenantAdminAgentsService } from '../../services/tenant-admin/agents.service';
import { TenantAdminService } from '../../services/tenant-admin/tenant-admin.service';
import { Member, resolveHouseholdMemberId } from '../../types/member.types';
import { MemberEnrollmentLifecycleBadges } from '../../components/members/MemberEnrollmentLifecycleBadges';
import MemberManagementModal from './MemberManagementModal';
import MembersAddDependent from './MembersAddDependent';
import MembersAddHousehold from './MembersAddHousehold';

// Icons
import {
    AlertCircle,
    Baby,
    Building2,
    CheckCircle,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    DollarSign,
    Download,
    Eye,
    Grid,
    Heart, // Added household icons
    Home,
    List,
    Mail,
    Phone,
    Plus,
    Search,
    Send,
    User,
    UserCheck,
    Users
} from 'lucide-react';

// Define Enrollment interface that matches what MembersDetails.tsx expects
interface Enrollment {
  EnrollmentId: string;
  ProductName: string;
  ProductType: string;
  Status: string;
  EffectiveDate: string;
  TerminationDate?: string;
  Premium: number;
  PaymentFrequency: string;
}

// US States constant for reuse across all dropdowns
const US_STATES = [
  { value: 'AL', label: 'Alabama' },
  { value: 'AK', label: 'Alaska' },
  { value: 'AZ', label: 'Arizona' },
  { value: 'AR', label: 'Arkansas' },
  { value: 'CA', label: 'California' },
  { value: 'CO', label: 'Colorado' },
  { value: 'CT', label: 'Connecticut' },
  { value: 'DE', label: 'Delaware' },
  { value: 'FL', label: 'Florida' },
  { value: 'GA', label: 'Georgia' },
  { value: 'HI', label: 'Hawaii' },
  { value: 'ID', label: 'Idaho' },
  { value: 'IL', label: 'Illinois' },
  { value: 'IN', label: 'Indiana' },
  { value: 'IA', label: 'Iowa' },
  { value: 'KS', label: 'Kansas' },
  { value: 'KY', label: 'Kentucky' },
  { value: 'LA', label: 'Louisiana' },
  { value: 'ME', label: 'Maine' },
  { value: 'MD', label: 'Maryland' },
  { value: 'MA', label: 'Massachusetts' },
  { value: 'MI', label: 'Michigan' },
  { value: 'MN', label: 'Minnesota' },
  { value: 'MS', label: 'Mississippi' },
  { value: 'MO', label: 'Missouri' },
  { value: 'MT', label: 'Montana' },
  { value: 'NE', label: 'Nebraska' },
  { value: 'NV', label: 'Nevada' },
  { value: 'NH', label: 'New Hampshire' },
  { value: 'NJ', label: 'New Jersey' },
  { value: 'NM', label: 'New Mexico' },
  { value: 'NY', label: 'New York' },
  { value: 'NC', label: 'North Carolina' },
  { value: 'ND', label: 'North Dakota' },
  { value: 'OH', label: 'Ohio' },
  { value: 'OK', label: 'Oklahoma' },
  { value: 'OR', label: 'Oregon' },
  { value: 'PA', label: 'Pennsylvania' },
  { value: 'RI', label: 'Rhode Island' },
  { value: 'SC', label: 'South Carolina' },
  { value: 'SD', label: 'South Dakota' },
  { value: 'TN', label: 'Tennessee' },
  { value: 'TX', label: 'Texas' },
  { value: 'UT', label: 'Utah' },
  { value: 'VT', label: 'Vermont' },
  { value: 'VA', label: 'Virginia' },
  { value: 'WA', label: 'Washington' },
  { value: 'WV', label: 'West Virginia' },
  { value: 'WI', label: 'Wisconsin' },
  { value: 'WY', label: 'Wyoming' }
];

const EFFECTIVE_MONTH_OPTIONS = [
  { value: '', label: 'Any month' },
  { value: '1', label: 'January' },
  { value: '2', label: 'February' },
  { value: '3', label: 'March' },
  { value: '4', label: 'April' },
  { value: '5', label: 'May' },
  { value: '6', label: 'June' },
  { value: '7', label: 'July' },
  { value: '8', label: 'August' },
  { value: '9', label: 'September' },
  { value: '10', label: 'October' },
  { value: '11', label: 'November' },
  { value: '12', label: 'December' }
];

const EFFECTIVE_DAY_OPTIONS = [
  { value: '', label: 'Any day' },
  { value: '1', label: '1st' },
  ...Array.from({ length: 30 }, (_, i) => ({
    value: String(i + 2),
    label: String(i + 2)
  }))
];

/** List/detail API rows may expose this field as PascalCase, camelCase, or lowercase. */
function getHouseholdMemberIdFromApiRow(m: Record<string, unknown>): string | undefined {
  const candidates = [
    m.HouseholdMemberID,
    m.householdMemberId,
    m.householdmemberid,
    m.HouseholdMemberId,
  ];
  for (const v of candidates) {
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return undefined;
}

function normalizeMemberFromApi(row: Record<string, unknown>): Member {
  const hid = getHouseholdMemberIdFromApiRow(row);
  const r = row as Record<string, unknown>;
  const {
    householdMemberId: _a,
    householdmemberid: _b,
    HouseholdMemberId: _c,
    HouseholdMemberID: _d,
    ...rest
  } = r;
  return { ...(rest as object), HouseholdMemberID: hid } as Member;
}

// Role detection and user context
const getCurrentUser = () => {
  const storedRoles = localStorage.getItem('roles');
  const userType = storedRoles ? JSON.parse(storedRoles)[0] : null;
  const tenantId = localStorage.getItem('tenantId') || localStorage.getItem('TenantId');
  const userId = localStorage.getItem('userId') || localStorage.getItem('UserId');
  const userEmail = localStorage.getItem('userEmail') || localStorage.getItem('Email');

  console.log('🔑 getCurrentUser from localStorage:', { userType, tenantId, userId, userEmail });

  return {
    userType: userType || 'Unknown',
    tenantId: tenantId || null,
    userId: userId || null,
    email: userEmail || null
  };
};

const getRoleBasedTitle = (userType: string) => {
  switch (userType) {
    case 'SysAdmin':
      return 'System Members Management';
    case 'TenantAdmin':
      return 'Organization Members';
    case 'Agent':
      return 'My Members';
    case 'GroupAdmin':
      return 'Group Members';
    default:
      return 'Members Management';
  }
};

// Types are now imported from members.service.ts

// API service class is now imported from members.service.ts

const MembersPage: React.FC = () => {
  // const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('list');
  const [showAdvancedFilters, setShowAdvancedFilters] = useState<boolean>(false);
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  const [memberEditOpen, setMemberEditOpen] = useState(false);
  const [memberEditTarget, setMemberEditTarget] = useState<Member | null>(null);
  const [memberEnrollments, setMemberEnrollments] = useState<Enrollment[]>([]);
  const [enrollmentsLoading, setEnrollmentsLoading] = useState<boolean>(false);
  // Get current user info - MUST be declared before callbacks that use it
  const currentUser = getCurrentUser();
  // const pageTitle = getRoleBasedTitle(currentUser.userType); // Available if needed for page title
  
  // Get auth state
  const { user, isLoading: isAuthLoading } = useAuth();

  // Fetch groups for the dropdown
  const { data: groupsData } = useGroups();
  const groups: any[] = (groupsData as any)?.data || [];

  // Load initial groups into options when groups data is available
  useEffect(() => {
    if (groups && groups.length > 0) {
      const initialGroups = groups
        .slice(0, 20) // Show first 20 groups initially
        .map((group: any) => ({
          id: group.GroupId || group.id,
          label: group.Name || group.name || 'Unnamed Group',
          value: group.GroupId || group.id
        }));
      // Only update if we don't have options or if we have fewer options than groups
      if (groupOptions.length === 0 || groupOptions.length < initialGroups.length) {
        setGroupOptions(initialGroups);
      }
    }
  }, [groups]);

  // Search for groups - memoized to prevent re-render loops
  const searchGroups = useCallback(async (query: string) => {
    // If no query or empty query, show initial groups from useGroups hook
    if (!query || query.trim().length === 0) {
      if (groups && groups.length > 0) {
        const initialGroups = groups
          .slice(0, 20)
          .map((group: any) => ({
            id: group.GroupId || group.id,
            label: group.Name || group.name || 'Unnamed Group',
            value: group.GroupId || group.id
          }));
        setGroupOptions(initialGroups);
      } else {
        // If no groups from hook, try to fetch initial list
        try {
          setGroupSearchLoading(true);
          let response;
          switch (currentUser.userType) {
            case 'SysAdmin':
              response = await SysAdminService.getGroups();
              break;
            case 'TenantAdmin':
              response = await TenantAdminService.getTenantGroups({
                status: 'Active',
                limit: 20
              });
              break;
            case 'Agent':
              response = await AgentService.getMyAgentGroups();
              break;
            default:
              setGroupOptions([]);
              return;
          }
          if (response.success && response.data && Array.isArray(response.data)) {
            const initialGroups = response.data
              .slice(0, 20)
              .map((group: any) => ({
                id: group.GroupId || group.id,
                label: group.Name || group.name || 'Unnamed Group',
                value: group.GroupId || group.id
              }));
            setGroupOptions(initialGroups);
          }
        } catch (error) {
          console.error('Error loading initial groups:', error);
        } finally {
          setGroupSearchLoading(false);
        }
      }
      return;
    }

    // Minimum 2 characters for search
    if (query.length < 2) {
      return;
    }

    try {
      setGroupSearchLoading(true);
      let response;

      // Use appropriate service based on user role
      switch (currentUser.userType) {
        case 'SysAdmin':
          // For SysAdmin, we can search all groups or filter by tenant if needed
          response = await SysAdminService.getGroups();
          break;
        case 'TenantAdmin':
          response = await TenantAdminService.getTenantGroups({
            search: query,
            status: 'Active',
            limit: 20
          });
          break;
        case 'Agent':
          response = await AgentService.getMyAgentGroups();
          break;
        default:
          setGroupOptions([]);
          return;
      }

      if (response.success && response.data && Array.isArray(response.data)) {
        // Filter groups by search query if needed (for SysAdmin and Agent, we filter client-side)
        let filteredGroups = response.data;
        if (currentUser.userType === 'SysAdmin' || currentUser.userType === 'Agent') {
          const queryLower = query.toLowerCase();
          filteredGroups = response.data.filter((group: any) => {
            const name = (group.Name || group.name || '').toLowerCase();
            return name.includes(queryLower);
          });
        }

        const groupOptionsList = filteredGroups
          .slice(0, 20)
          .map((group: any) => ({
            id: group.GroupId || group.id,
            label: group.Name || group.name || 'Unnamed Group',
            value: group.GroupId || group.id
          }));
        setGroupOptions(groupOptionsList);
      } else {
        setGroupOptions([]);
      }
    } catch (error) {
      console.error('❌ Error searching groups:', error);
      setGroupOptions([]);
    } finally {
      setGroupSearchLoading(false);
    }
  }, [currentUser.userType, groups]);
  const [showAddModal, setShowAddModal] = useState<boolean>(false);
  const [showAddDependentModal, setShowAddDependentModal] = useState<boolean>(false);
  const [householdMembers, setHouseholdMembers] = useState<Member[]>([]); // For displaying dependents
  const [addMemberLoading, setAddMemberLoading] = useState<boolean>(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const [showEnrollmentLinkModal, setShowEnrollmentLinkModal] = useState<boolean>(false);
  const [selectedMemberForLink, setSelectedMemberForLink] = useState<Member | null>(null);
  const [showBulkEnrollmentModal, setShowBulkEnrollmentModal] = useState<boolean>(false);
  const [showQuickEnrollmentModal, setShowQuickEnrollmentModal] = useState<boolean>(false);
  /** When opening quick send from Member Management, lock recipient to that member (no navigation) */
  const [quickEnrollmentPrefill, setQuickEnrollmentPrefill] = useState<{
    memberId: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phoneNumber?: string;
    agentId?: string;
  } | null>(null);
  const [quickEnrollmentLockRecipient, setQuickEnrollmentLockRecipient] = useState(false);
  // selectedProductForProposal removed - proposals are no longer product-specific. Send Proposal moved to Marketing page.

  // EXPORT STATE
  const [exportLoading, setExportLoading] = useState<boolean>(false);
  
  // Log user info for debugging
  console.log('👤 MembersPage: Current user info:', { 
    fromLocalStorage: currentUser,
    fromAuthHook: user,
    isAuthLoading
  });

  // Replace FilterState with MemberFilterState from members.service.ts
  const [filters, setFilters] = useState<MemberFilterState>(() => ({
    search: '',
    // Default to no status filter so "Any" in the Enrollment status dropdown really does mean any —
    // otherwise Pending Payment / Terminated / etc. silently disappear from the list. The combined
    // Enrollment status dropdown lets the user narrow to Active/Pending Payment/Terminated explicitly.
    status: '',
    page: 1,
    limit: 10,
    tenantId: '',
    groupId: '',
    agentId: getInitialAgentFilterIdFromStorage(),
    agencyId: '',
    enrollmentType: '',
    state: '',
    // Default: primary members only (spouse/child in Advanced → Relationship → All Types)
    relationshipType: 'P',
    householdOnly: false,
    sortBy: 'CreatedDate', // Sort by creation date
    sortOrder: 'desc', // Most recent first
    enrollmentStatus: 'all', // Default: any enrollment status
    enrollmentLifecycleStatus: '',
    // Match metrics: group + individual billing (not SB-only)
    memberTypeFilter: 'all',
    productId: '',
    vendorId: '',
    effectiveDay: '',
    effectiveMonth: '',
    effectiveYear: ''
  }));

  useEffect(() => {
    const role = user?.currentRole;
    if (!role || role === 'Agent') return;
    setFilters((prev) =>
      prev.agentId === AGENT_FILTER_SHOW_ALL ||
      prev.agentId === AGENT_FILTER_SCOPE_AGENCY ||
      prev.agentId === AGENT_FILTER_SCOPE_DIRECT_DOWNLINE
        ? { ...prev, agentId: '' }
        : prev
    );
  }, [user?.currentRole]);

  /** Full visibility for header stats: agency if AgencyOwner or DB agency admin; else self + downline (server-side via scope=auto). */
  const globalMemberMetricsOpts = useMemo(() => {
    const role = user?.currentRole || currentUser.userType;
    if (role !== 'Agent' && role !== 'AgencyOwner') return {};
    return { scope: 'auto' as const };
  }, [user?.currentRole, currentUser.userType]);

  const {
    data: globalMetrics,
    refetch: refetchMetrics
  } = useMemberMetrics(globalMemberMetricsOpts);

  const headerStatsScopeLabel = useMemo(() => {
    const s = (globalMetrics as { statsScopeSublabel?: string } | undefined)?.statsScopeSublabel;
    if (s === 'agency') return 'Agency Total';
    if (s === 'downline') return 'You and your downlines';
    return null;
  }, [globalMetrics]);

  // State for agent and agency search
  const [agentOptions, setAgentOptions] = useState<Array<{ id: string; label: string; value: string; email?: string }>>([]);
  const [agencyOptions, setAgencyOptions] = useState<Array<{ id: string; label: string; value: string }>>([]);
  const [agentSearchLoading, setAgentSearchLoading] = useState(false);
  const [agencySearchLoading, setAgencySearchLoading] = useState(false);

  // State for groups search
  const [groupOptions, setGroupOptions] = useState<Array<{ id: string; label: string; value: string }>>([]);
  const [groupSearchLoading, setGroupSearchLoading] = useState(false);

  // Tenant dropdown options (SysAdmin only). Loaded once on mount via the lightweight tenants endpoint.
  const [tenantOptions, setTenantOptions] = useState<Array<{ TenantId: string; Name: string }>>([]);

  // Agent role: scope options + Me + agents (agency pool for Agency Owner when enabled)
  const { data: downlineAgentOptions = [], isLoading: isLoadingDownlineAgents, agencyWideFilterAvailable } =
    useDownlineAgentsForFilter({
      includeShowAllOption: true,
      agencyOwnerFilter: true
    });

  // oe.AgencyAdmins (agency-wide list): after downline-agents resolves, default filter to full agency.
  // AgencyOwner portal uses getInitialAgentFilterIdFromStorage + currentRole from storage.
  useEffect(() => {
    if (user?.currentRole !== 'Agent') return;
    if (!agencyWideFilterAvailable) return;
    setFilters((prev) =>
      prev.agentId === AGENT_FILTER_SHOW_ALL ? { ...prev, agentId: AGENT_FILTER_SCOPE_AGENCY } : prev
    );
  }, [user?.currentRole, agencyWideFilterAvailable]);

  const agentFilterPlaceholderLabels = useMemo(() => {
    const agency = downlineAgentOptions.find((o) => o.value === AGENT_FILTER_SCOPE_AGENCY)?.label ?? 'All Agency Agents';
    const direct = downlineAgentOptions.find((o) => o.value === AGENT_FILTER_SCOPE_DIRECT_DOWNLINE)?.label ?? 'Direct downlines';
    const downline = downlineAgentOptions.find((o) => o.value === AGENT_FILTER_SHOW_ALL)?.label ?? 'Show all';
    return { agency, direct, downline };
  }, [downlineAgentOptions]);

  // Products for advanced filter (members enrolled in this product)
  const currentUserRole = user?.currentRole || currentUser.userType;
  const { data: memberFilterProductsRaw = [] } = useQuery({
    queryKey: ['memberFilterProducts', currentUserRole],
    queryFn: async () => {
      if (currentUserRole === 'SysAdmin') {
        const res = await apiService.get<{ success: boolean; data: Array<{ ProductId: string; Name: string; IsBundle: number }> }>('/api/me/sysadmin/groups/products-for-filter');
        return res.success && res.data ? res.data : [];
      }
      if (['TenantAdmin', 'Agent', 'GroupAdmin'].includes(currentUserRole || '')) {
        const res = await apiService.get<{ success: boolean; data: any[] }>('/api/tenant/products?activeOnly=true');
        if (!res.success || !Array.isArray(res.data)) return [];
        const filtered = res.data.filter((p: any) => {
          const isHidden = p.IsHidden === true || p.IsHidden === 1 || p.isHidden === true || p.isHidden === 1;
          if (isHidden) return false;
          const st = (p.SalesType || p.salesType || '').toString().trim().toLowerCase();
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
    enabled: ['TenantAdmin', 'Agent', 'SysAdmin', 'GroupAdmin'].includes(currentUserRole || '') && showAdvancedFilters,
  });

  const productOptions = React.useMemo(() => {
    return memberFilterProductsRaw.map((p: any) => ({
      id: p.ProductId,
      label: p.Name || p.ProductName || '',
      value: p.ProductId,
      sublabel: (p.IsBundle === 1 || p.IsBundle === true) ? 'Bundle' : 'Product',
    }));
  }, [memberFilterProductsRaw]);

  // Vendors for advanced filter (members enrolled in products from this vendor)
  const { data: vendorsResponse } = useQuery({
    queryKey: ['vendorsForMemberFilter'],
    queryFn: async () => {
      const res = await apiService.get<{ success: boolean; data?: Array<{ Id: string; VendorName: string }>; pagination?: { total: number } }>('/api/vendors?limit=500');
      return res;
    },
    enabled: showAdvancedFilters,
  });

  const vendorOptions = React.useMemo(() => {
    const list = (vendorsResponse?.success && Array.isArray(vendorsResponse?.data)) ? vendorsResponse.data : [];
    return list.map((v: any) => ({
      id: v.Id || v.VendorId,
      label: v.VendorName || v.Name || '',
      value: v.Id || v.VendorId,
    }));
  }, [vendorsResponse]);

  const effectiveYearOptions = useMemo(() => {
    const y = new Date().getFullYear();
    const opts: { value: string; label: string }[] = [{ value: '', label: 'Any year' }];
    for (let yr = y - 5; yr <= y + 5; yr += 1) {
      opts.push({ value: String(yr), label: String(yr) });
    }
    return opts;
  }, []);

  // Load selected agent/agency/group names when filters are set
  useEffect(() => {
    const loadSelectedAgent = async () => {
      if (!['TenantAdmin', 'SysAdmin', 'Agent'].includes(currentUser.userType)) return;
      // Agent uses useDownlineAgentsForFilter options (Me + downline), so no need to load selected agent into agentOptions
      if (currentUser.userType === 'Agent') return;
      
      if (
        filters.agentId &&
        !isAgentFilterScopeSentinel(filters.agentId) &&
        agentOptions.find(opt => opt.value === filters.agentId) === undefined
      ) {
        try {
          let response;
          if (currentUser.userType === 'Agent') {
            // For AgencyOwner, try to get agent from AgentsService
            const agentsResponse = await AgentsService.getAgentsAndAgencies('Agent', {
              type: 'Agent',
              status: 'Active',
              page: 1,
              limit: 100
            });
            if (agentsResponse.success && agentsResponse.data) {
              const agent = agentsResponse.data.find((a: any) => 
                a.Id === filters.agentId && a.Type === 'Agent'
              );
              if (agent) {
                setAgentOptions([{
                  id: agent.Id,
                  label: agent.Name || 'Unknown Agent',
                  value: agent.Id,
                  email: agent.Email
                }]);
                return;
              }
            }
          } else {
            response = await TenantAdminAgentsService.getAgentDetails(filters.agentId);
            if (response.success && response.data) {
              const agent = response.data as any;
              setAgentOptions([{
                id: agent.Id || agent.id,
                label: agent.Name || agent.name || `${agent.FirstName || ''} ${agent.LastName || ''}`.trim(),
                value: agent.Id || agent.id,
                email: agent.Email || agent.email
              }]);
            }
          }
        } catch (error) {
          console.error('Error loading selected agent:', error);
        }
      }
    };

    const loadSelectedAgency = async () => {
      if (!['TenantAdmin', 'SysAdmin'].includes(currentUser.userType)) return;
      
      if (filters.agencyId && agencyOptions.find(opt => opt.value === filters.agencyId) === undefined) {
        try {
          const response = await TenantAdminAgentsService.getAgentDetails(filters.agencyId);
          if (response.success && response.data) {
            const agency = response.data as any;
            setAgencyOptions([{
              id: agency.Id || agency.id,
              label: agency.Name || agency.name,
              value: agency.Id || agency.id
            }]);
          }
        } catch (error) {
          console.error('Error loading selected agency:', error);
        }
      }
    };

    const loadSelectedGroup = () => {
      if (filters.groupId && groupOptions.find(opt => opt.value === filters.groupId) === undefined) {
        // Try to find the group in the groups data from useGroups hook
        const foundGroup = groups.find((group: any) => 
          (group.GroupId || group.id) === filters.groupId
        );
        if (foundGroup) {
          setGroupOptions([{
            id: foundGroup.GroupId || foundGroup.id,
            label: foundGroup.Name || foundGroup.name || 'Unnamed Group',
            value: foundGroup.GroupId || foundGroup.id
          }]);
        }
      }
    };

    loadSelectedAgent();
    loadSelectedAgency();
    loadSelectedGroup();
  }, [filters.agentId, filters.agencyId, filters.groupId, currentUser.userType, groups]);

  // Use the useMembers hook instead of manual fetching
  const { data, isLoading, isError, error, refetch } = useMembers(filters);
  
  console.log('📊 MembersPage: Received data from useMembers hook:', data);
  
  // Extract members and total from the hook's data - handle both array and object formats
  // For server-side pagination, we always expect {members, total} structure
  let members: Member[] = [];
  let totalMembers = 0;
  
  if (data) {
    // Handle object response ({members, total} structure) - preferred for server-side pagination
    if (data.members && Array.isArray(data.members)) {
      members = data.members;
      // Always use total from API for server-side pagination accuracy
      totalMembers = data.total ?? 0;
      console.log('📊 Detected object response format (server-side pagination):', { 
        membersCount: members.length, 
        total: totalMembers,
        page: filters.page,
        limit: filters.limit
      });
    } 
    // Handle array response (direct array of members) - fallback for client-side pagination
    else if (Array.isArray(data)) {
      members = data.map((row) => normalizeMemberFromApi(row as Record<string, unknown>) as Member);
      totalMembers = members.length;
      console.log('📊 Detected array response format (client-side pagination):', { membersCount: members.length });
    }
    // Handle unexpected format
    else {
      console.error('❌ Unexpected data format:', data);
    }
  }
  
  console.log('👥 MembersPage: Extracted members array:', members);
  console.log('🔢 MembersPage: Total members count:', totalMembers);

  // Members are filtered by status on the backend; no client-side status filtering needed
  const filteredMembers = members;
  /** Household + premium totals from the members list API (same filter set as the table). */
  const listSummary = useMemo(() => {
    if (!data || Array.isArray(data)) return null;
    return (data as { summary?: { householdCount?: number; monthlyPremiums?: number } }).summary ?? null;
  }, [data]);

  /** Filtered totals: primary households + premium (same definitions as header cards); member row count is separate (list can include dependents). */
  const filterTotals = useMemo(() => {
    if (!listSummary) return null;
    return {
      totalRevenue: Number(listSummary.monthlyPremiums ?? 0),
      householdCount: Number(listSummary.householdCount ?? 0)
    };
  }, [listSummary]);

  // Replace pagination state with derived values from filters and data
  const pagination = {
    page: filters.page || 1,
    limit: filters.limit || 10,
    total: totalMembers,
    totalPages: Math.ceil(totalMembers / (filters.limit || 10))
  };

  // Role-based permissions
  const canAddMembers = ['SysAdmin', 'TenantAdmin', 'Agent', 'GroupAdmin'].includes(currentUser.userType);
  const canDeleteMembers = ['SysAdmin', 'TenantAdmin'].includes(currentUser.userType);
  const canViewAllTenants = currentUser.userType === 'SysAdmin';
  const canViewAllGroups = ['SysAdmin', 'TenantAdmin'].includes(currentUser.userType);
  const canExportMembers = ['SysAdmin', 'TenantAdmin'].includes(currentUser.userType);

  // Load tenant dropdown options once for SysAdmin. Uses the existing lightweight tenants endpoint
  // (Active tenants, just id+name), which SysAdmin has access to. TenantAdmins don't need to filter
  // by tenant on this page — their queries are already tenant-scoped server-side.
  useEffect(() => {
    if (!canViewAllTenants) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await apiService.get<{ success: boolean; data: Array<{ TenantId: string; Name: string; Status?: string }> }>(
          '/api/tenants?lightweight=true'
        );
        if (cancelled) return;
        if (response?.success && Array.isArray(response.data)) {
          setTenantOptions(
            response.data
              .filter((t) => t && t.TenantId && t.Name)
              .map((t) => ({ TenantId: t.TenantId, Name: t.Name }))
          );
        }
      } catch (err) {
        console.error('Failed to load tenants for filter dropdown:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canViewAllTenants]);

  // Handle logout
  // const handleLogout = () => {
  //   // Clear all auth tokens
  //   localStorage.removeItem('accessToken');
  //   localStorage.removeItem('refreshToken');
  //   localStorage.removeItem('token');

  //   // Redirect to login page
  //   navigate('/login');
  // };

  // Debounced search to prevent excessive API calls
  const [searchValue, setSearchValue] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  
  // Debounce search input
  useEffect(() => {
    if (searchValue !== filters.search) {
      setIsSearching(true);
    }
    
    const timeoutId = setTimeout(() => {
      handleFilterChange('search', searchValue);
      setIsSearching(false);
    }, 500); // 500ms delay to reduce API calls

    return () => clearTimeout(timeoutId);
  }, [searchValue]);

  // Search for agents - memoized to prevent re-render loops
  const searchAgents = useCallback(async (query: string) => {
    // Allow search for TenantAdmin, SysAdmin, and Agent (AgencyOwner)
    if (!['TenantAdmin', 'SysAdmin', 'Agent'].includes(currentUser.userType)) {
      setAgentOptions([]);
      return;
    }

    // If no query or empty query, load initial results
    if (!query || query.trim().length === 0) {
      try {
        setAgentSearchLoading(true);
        let response;
        
        if (currentUser.userType === 'Agent') {
          // For AgencyOwner, use AgentsService which handles agency owner logic
          response = await AgentsService.getAgentsAndAgencies('Agent', {
            type: 'Agent',
            status: 'Active',
            page: 1,
            limit: 20
          });
        } else {
          // For TenantAdmin and SysAdmin, use TenantAdminAgentsService
          response = await TenantAdminAgentsService.getAgentsAndAgencies({
            type: 'Agent',
            status: 'Active',
            page: 1,
            limit: 20
          });
        }

        if (response.success && response.data && Array.isArray(response.data)) {
          const agents = response.data
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

    // Minimum 2 characters for search
    if (query.length < 2) {
      return;
    }

    try {
      setAgentSearchLoading(true);
      let response;
      
      if (currentUser.userType === 'Agent') {
        // For AgencyOwner, use AgentsService which handles agency owner logic
        // Filter client-side since the API doesn't support search param for agency owners
        response = await AgentsService.getAgentsAndAgencies('Agent', {
          type: 'Agent',
          status: 'Active',
          page: 1,
          limit: 100 // Get more results to filter client-side
        });
      } else {
        // For TenantAdmin and SysAdmin, use TenantAdminAgentsService
        response = await TenantAdminAgentsService.getAgentsAndAgencies({
          search: query,
          type: 'Agent',
          status: 'Active',
          page: 1,
          limit: 20
        });
      }

      if (response.success && response.data && Array.isArray(response.data)) {
        let agents = response.data.filter((item: any) => item.Type === 'Agent');
        
        // For AgencyOwner, filter client-side by search query
        if (currentUser.userType === 'Agent') {
          const queryLower = query.toLowerCase();
          agents = agents.filter((item: any) => {
            const name = (item.Name || item.name || `${item.FirstName || ''} ${item.LastName || ''}`).toLowerCase();
            const email = (item.Email || item.email || '').toLowerCase();
            return name.includes(queryLower) || email.includes(queryLower);
          });
        }
        
        const agentOptionsList = agents
          .slice(0, 20)
          .map((item: any) => ({
            id: item.Id || item.id,
            label: item.Name || item.name || `${item.FirstName || ''} ${item.LastName || ''}`.trim(),
            value: item.Id || item.id,
            email: item.Email || item.email
          }));
        setAgentOptions(agentOptionsList);
      } else {
        setAgentOptions([]);
      }
    } catch (error) {
      console.error('❌ Error searching agents:', error);
      setAgentOptions([]);
    } finally {
      setAgentSearchLoading(false);
    }
  }, [currentUser.userType]);

  // Search for agencies - memoized to prevent re-render loops
  const searchAgencies = useCallback(async (query: string) => {
    // Only allow search for TenantAdmin and SysAdmin
    if (!['TenantAdmin', 'SysAdmin'].includes(currentUser.userType)) {
      setAgencyOptions([]);
      return;
    }

    // If no query or empty query, load initial results
    if (!query || query.trim().length === 0) {
      try {
        setAgencySearchLoading(true);
        const response = await TenantAdminAgentsService.getAgentsAndAgencies({
          type: 'Agency',
          status: 'Active',
          page: 1,
          limit: 20
        });

        if (response.success && response.data && Array.isArray(response.data)) {
          const agencies = response.data
            .filter((item: any) => item.Type === 'Agency')
            .map((item: any) => ({
              id: item.Id || item.id,
              label: item.Name || item.name,
              value: item.Id || item.id
            }));
          setAgencyOptions(agencies);
        } else {
          setAgencyOptions([]);
        }
      } catch (error) {
        console.error('❌ Error loading initial agencies:', error);
        setAgencyOptions([]);
      } finally {
        setAgencySearchLoading(false);
      }
      return;
    }

    // Minimum 2 characters for search
    if (query.length < 2) {
      return;
    }

    try {
      setAgencySearchLoading(true);
      const response = await TenantAdminAgentsService.getAgentsAndAgencies({
        search: query,
        type: 'Agency',
        status: 'Active',
        page: 1,
        limit: 20
      });

      if (response.success && response.data && Array.isArray(response.data)) {
        const agencies = response.data
          .filter((item: any) => item.Type === 'Agency')
          .map((item: any) => ({
            id: item.Id || item.id,
            label: item.Name || item.name,
            value: item.Id || item.id
          }));
        setAgencyOptions(agencies);
      } else {
        setAgencyOptions([]);
      }
    } catch (error) {
      console.error('❌ Error searching agencies:', error);
      setAgencyOptions([]);
    } finally {
      setAgencySearchLoading(false);
    }
  }, [currentUser.userType]);

  // Handle search from header (keep existing) - removed unused callback

  // Replace fetchMembers with refetch from the hook
  // const fetchMembers = async () => { ... } - REMOVED

  // Metrics are now handled by the useMemberMetrics hook

  // Initial load
  useEffect(() => {
    if (!user) return;
    
    // Log current user information for debugging
    const userInfo = {
      roles: localStorage.getItem('roles'),
      currentRole: localStorage.getItem('currentRole'),
      userId: localStorage.getItem('userId'),
      email: localStorage.getItem('userEmail'),
      accessToken: localStorage.getItem('accessToken') ? 'Present' : 'Missing'
    };
    console.log('🔍 MembersPage: User Info on mount:', userInfo);
    console.log('🔍 MembersPage: Auth hook user info:', user);

    // Check specifically for GroupAdmin role
    if (userInfo.currentRole === 'GroupAdmin') {
      console.log('👮 GroupAdmin user detected, should use /api/me/group-admin/members endpoint');
      
      // Direct test of the group-admin endpoint
      const testGroupAdminEndpoint = async () => {
        try {
          console.log('🧪 Testing GroupAdmin members endpoint directly');
          const response = await apiService.get('/api/me/group-admin/members');
          console.log('🧪 Direct GroupAdmin endpoint test response:', response);
        } catch (error) {
          console.error('🧪 Direct GroupAdmin endpoint test failed:', error);
        }
      };
      
      testGroupAdminEndpoint();
    }
    // Check specifically for Agent role
    else if (userInfo.currentRole === 'Agent') {
      console.log('🧑‍💼 Agent user detected, should use /api/me/agent/members endpoint');
      
      // Direct test of the agent endpoint
      const testAgentEndpoint = async () => {
        try {
          console.log('🧪 Testing Agent members endpoint directly');
          const response = await apiService.get('/api/me/agent/members');
          console.log('🧪 Direct Agent endpoint test response:', response);
        } catch (error) {
          console.error('🧪 Direct Agent endpoint test failed:', error);
        }
      };
      
      testAgentEndpoint();
    }

    // No need to call fetchMembers or fetchMetrics, the hooks handle them
  }, [user]); // Update dependency to trigger when user changes

  // No need for the second useEffect that refetches when filters change,
  // the hook handles this automatically with the queryKey

  // Clear success message after 5 seconds (keep existing)
  useEffect(() => {
    if (successMessage) {
      const timer = setTimeout(() => {
        setSuccessMessage(null);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [successMessage]);

  // Open New Member modal when navigating from agent dashboard "Enroll New Member" (?openNewMember=1)
  useEffect(() => {
    if (searchParams.get('openNewMember') !== '1' || !canAddMembers) return;
    setQuickEnrollmentPrefill(null);
    setQuickEnrollmentLockRecipient(false);
    setShowQuickEnrollmentModal(true);
    setMutationError(null);
    const next = new URLSearchParams(searchParams);
    next.delete('openNewMember');
    setSearchParams(next, { replace: true });
  }, [searchParams, canAddMembers, setSearchParams]);

  // Open Member modal when navigating with ?openMemberId=... or ?householdId=...
  // (used by SysAdmin tools like the System Audit / Billing Integrity page).
  useEffect(() => {
    const openMemberId = searchParams.get('openMemberId');
    const householdId = searchParams.get('householdId');
    if (!openMemberId && !householdId) return;
    if (!members || (members as Member[]).length === 0) return;

    let target: Member | undefined;
    if (openMemberId) {
      target = (members as Member[]).find((m) => m.MemberId === openMemberId);
    } else if (householdId) {
      // Pick the primary member for that household (lowest MemberSequence, fallback to first match).
      const inHousehold = (members as Member[]).filter((m) => m.HouseholdId === householdId);
      target = inHousehold.sort((a, b) =>
        ((a as any).MemberSequence ?? 99) - ((b as any).MemberSequence ?? 99)
      )[0] || inHousehold[0];
    }

    if (target) {
      handleMemberSelect(target);
      const next = new URLSearchParams(searchParams);
      next.delete('openMemberId');
      next.delete('householdId');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, members]);

  // Reopen member modal if navigating back from modify plan
  useEffect(() => {
    const state = location.state as { reopenMemberId?: string } | null;
    if (state?.reopenMemberId && members) {
      // Find the member by ID
      const memberToOpen = members.find((m: Member) => m.MemberId === state.reopenMemberId);
      if (memberToOpen) {
        console.log('🔄 Reopening member modal for:', memberToOpen.FirstName, memberToOpen.LastName);
        // Invalidate enrollment queries to ensure fresh data is fetched
        queryClient.invalidateQueries({ queryKey: ['memberEnrollments', state.reopenMemberId] });
        queryClient.invalidateQueries({ queryKey: ['enrollments'] });
        queryClient.invalidateQueries({ queryKey: ['memberHousehold', state.reopenMemberId] });
        console.log('🔄 Invalidated queries for member:', state.reopenMemberId);
        // Small delay to ensure queries are invalidated before fetching
        setTimeout(() => {
          handleMemberSelect(memberToOpen);
        }, 100);
      }
      // Clear the state to prevent reopening on subsequent navigations
      window.history.replaceState({}, document.title);
    }
  }, [location.state, members, queryClient]);

  // Add keyboard shortcut for search (Ctrl+K or Cmd+K)
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
        event.preventDefault();
        const searchInput = document.querySelector('input[placeholder*="Search members"]') as HTMLInputElement;
        if (searchInput) {
          searchInput.focus();
          searchInput.select();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Update handleFilterChange to work with MemberFilterState
  const handleFilterChange = (key: keyof MemberFilterState, value: string | boolean | number): void => {
    setFilters(prev => ({
      ...prev,
      [key]: value,
      // Reset to first page when filters change
      ...(key !== 'page' ? { page: 1 } : {})
    }));
  };

  // Add pagination handler
  const handlePaginationChange = (newPage: number) => {
    if (newPage > 0) {
      handleFilterChange('page', newPage);
    }
  };

  // Keep handleMemberSelect but update error handling
  const handleMemberSelect = async (member: Member) => {
    setSelectedMember(member);
    setEnrollmentsLoading(true);
    setMutationError(null);

    try {
      // Invalidate queries first to ensure fresh data
      queryClient.invalidateQueries({ queryKey: ['memberEnrollments', member.MemberId] });
      queryClient.invalidateQueries({ queryKey: ['enrollments'] });
      queryClient.invalidateQueries({ queryKey: ['memberHousehold', member.MemberId] });
      queryClient.invalidateQueries({ queryKey: ['memberPaymentMethods', member.MemberId] });
      
      // Get member details and household members
      const householdResponse = await apiService.get<{ 
        success: boolean, 
        data: { 
          member: Member, 
          householdMembers: Member[] 
        } 
      }>(`/api/members/${member.MemberId}/with-household`);
      
      if (householdResponse.success) {
        setSelectedMember(householdResponse.data.member);
        setHouseholdMembers(householdResponse.data.householdMembers);
      }

      // Get enrollments - fetch both Active and Pending to include future effective enrollments
      const [activeResponse, pendingResponse] = await Promise.all([
        apiService.get<{ success: boolean; data: Enrollment[] }>(`/api/enrollments?memberId=${member.MemberId}&status=Active`),
        apiService.get<{ success: boolean; data: Enrollment[] }>(`/api/enrollments?memberId=${member.MemberId}&status=Pending`)
      ]);
      
      const activeEnrollments = activeResponse.success ? (activeResponse.data || []) : [];
      const pendingEnrollments = pendingResponse.success ? (pendingResponse.data || []) : [];
      
      // Combine and deduplicate by EnrollmentId
      const allEnrollments = [...activeEnrollments, ...pendingEnrollments];
      const uniqueEnrollments = allEnrollments.filter((enrollment: any, index, self) => 
        index === self.findIndex((e: any) => (e.EnrollmentId || e.enrollmentId) === (enrollment.EnrollmentId || enrollment.enrollmentId))
      );
      
      setMemberEnrollments(uniqueEnrollments);
      console.log('🔄 Refreshed enrollments:', { active: activeEnrollments.length, pending: pendingEnrollments.length, total: uniqueEnrollments.length });
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : 'Failed to load member details');
      console.error('Error fetching member details:', err);
      // If fetching enhanced details fails, fall back to the basic member info we already have
      setSelectedMember(member);
      setHouseholdMembers([]);
      setMemberEnrollments([]);
    } finally {
      setEnrollmentsLoading(false);
    }
  };

  const openMemberEdit = useCallback((m: Member) => {
    setMemberEditTarget(m);
    setMemberEditOpen(true);
  }, []);

  const closeMemberEdit = useCallback(() => {
    setMemberEditOpen(false);
    setMemberEditTarget(null);
  }, []);

  // const handleMemberUpdate = async (memberId: string, updates: Partial<Member>) => {
  //   try {
  //     await api.updateMember(memberId, updates);
  //     // Refresh the member list
  //     await fetchMembers();
  //     // Close the modal if updating the selected member
  //     if (selectedMember?.MemberId === memberId) {
  //       setSelectedMember(null);
  //     }
  //   } catch (err) {
  //     setError(err instanceof Error ? err.message : 'Failed to update member');
  //   }
  // };

  // Handle sending enrollment link to individual member
  const handleSendEnrollmentLink = async (member: Member) => {
    try {
      // Fetch fresh member data to ensure we have the latest agent information
      const response = await apiService.get<{ success: boolean; data: Member }>(`/api/members/${member.MemberId}`);
      
      if (response.success && response.data) {
        console.log('🔍 Fresh member data with agent info:', response.data);
        setSelectedMemberForLink(response.data);
      } else {
        // Fallback to the member data we have
        console.log('⚠️ Using existing member data (no fresh data available)');
        setSelectedMemberForLink(member);
      }
    } catch (error) {
      console.error('Error fetching fresh member data:', error);
      // Fallback to the member data we have
      setSelectedMemberForLink(member);
    }
    
    setShowEnrollmentLinkModal(true);
  };

  // Export members to CSV
  const handleExportMembers = async () => {
    try {
      setExportLoading(true);
      setMutationError(null);
      
      console.log('📊 Exporting members with filters:', filters);
      
      // Call export service with current filters (includes enrollmentStatus)
      const blob = await MembersService.exportMembers(filters);
      
      // Create download link
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const today = new Date().toISOString().split('T')[0];
      link.download = `members-export-${today}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      
      setSuccessMessage('Members exported successfully!');
      console.log('✅ Export completed successfully');
    } catch (error) {
      console.error('❌ Error exporting members:', error);
      setMutationError(error instanceof Error ? error.message : 'Failed to export members');
    } finally {
      setExportLoading(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Active':
        return 'bg-green-100 text-green-800';
      case 'Inactive':
        return 'bg-gray-100 text-gray-800';
      case 'Suspended':
        return 'bg-red-100 text-red-800';
      case 'Pending':
        return 'bg-yellow-100 text-yellow-800';
      case 'Pending Payment':
        return 'bg-amber-100 text-amber-800';
      case 'Pending Migration':
        return 'bg-violet-100 text-violet-900';
      case 'Terminated':
        return 'bg-gray-200 text-gray-700';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const formatCurrency = (amount: number): string => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(amount);
  };

  // Household helper functions
  const getRelationshipIcon = (relationshipType?: string) => {
    switch (relationshipType) {
      case 'P': return <UserCheck className="h-4 w-4 text-oe-primary" />;
      case 'S': return <Heart className="h-4 w-4 text-pink-600" />;
      case 'C': return <Baby className="h-4 w-4 text-green-600" />;
      default: return <User className="h-4 w-4 text-gray-600" />;
    }
  };

  const getRelationshipColor = (relationshipType?: string) => {
    switch (relationshipType) {
      case 'P': return 'bg-blue-100 text-blue-800';
      case 'S': return 'bg-pink-100 text-pink-800';
      case 'C': return 'bg-green-100 text-green-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  /** Show "Primary" chip only when the relationship filter can include non-primary members (not "Primary only"). */
  const showPrimaryRelationshipBadge = filters.relationshipType !== 'P';

  // Single "Enrollment status" dropdown drives three otherwise-independent filter fields:
  //   es:*      → filters.enrollmentStatus           (enrollment lifecycle: active/currently-effective/future)
  //   status:*  → filters.status                     (member record: Active/Pending Payment/Terminated)
  //   el:*      → filters.enrollmentLifecycleStatus  (journey: link sent / payment hold / etc.)
  // We treat them as mutually exclusive in the UI so the dropdown always reflects one concrete choice.
  const combinedMemberStatusFilterValue = useMemo(() => {
    if (filters.enrollmentLifecycleStatus) return `el:${filters.enrollmentLifecycleStatus}`;
    if (filters.status) return `status:${filters.status}`;
    if (filters.enrollmentStatus && filters.enrollmentStatus !== 'all') return `es:${filters.enrollmentStatus}`;
    return '';
  }, [filters.status, filters.enrollmentLifecycleStatus, filters.enrollmentStatus]);

  const handleCombinedMemberStatusFilter = useCallback((value: string) => {
    setFilters((prev) => {
      if (!value) {
        return { ...prev, status: '', enrollmentLifecycleStatus: '', enrollmentStatus: 'all', page: 1 };
      }
      if (value.startsWith('es:')) {
        const es = value.slice(3) as MemberFilterState['enrollmentStatus'];
        return { ...prev, status: '', enrollmentLifecycleStatus: '', enrollmentStatus: es ?? 'all', page: 1 };
      }
      if (value.startsWith('el:')) {
        const lifecycle = value.slice(3) as MemberFilterState['enrollmentLifecycleStatus'];
        return { ...prev, status: '', enrollmentStatus: 'all', enrollmentLifecycleStatus: lifecycle ?? '', page: 1 };
      }
      if (value.startsWith('status:')) {
        return { ...prev, status: value.slice(7), enrollmentLifecycleStatus: '', enrollmentStatus: 'all', page: 1 };
      }
      return { ...prev, page: 1 };
    });
  }, []);

  // Member Card Component
  const MemberCard: React.FC<{ member: Member }> = ({ member }) => (
    <div className="bg-white rounded-lg shadow-md hover:shadow-lg transition-shadow duration-200 overflow-hidden">
      <div className="p-4">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className={`w-12 h-12 rounded-full flex items-center justify-center ${
                member.Status === 'Terminated' && member.EnrollmentStatus !== 'Pending Migration' ? 'bg-red-100' : 'bg-oe-light'
            }`}>
              <User size={20} className={member.Status === 'Terminated' && member.EnrollmentStatus !== 'Pending Migration' ? 'text-red-600' : 'text-oe-primary'} />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3
                  className={`text-lg font-semibold flex items-center gap-2 flex-wrap min-w-0 ${
                    member.Status === 'Terminated' && member.EnrollmentStatus !== 'Pending Migration' ? 'text-gray-400' : 'text-oe-neutral-dark'
                  }`}
                >
                  <span>
                    {member.FirstName} {member.LastName}
                  </span>
                  {resolveHouseholdMemberId(member) ? (
                    <span
                      className="text-xs font-mono font-medium text-gray-800 bg-gray-100 border border-gray-200 px-2 py-0.5 rounded shrink-0"
                      title="Household member ID (display)"
                    >
                      {resolveHouseholdMemberId(member)}
                    </span>
                  ) : null}
                </h3>
                {showPrimaryRelationshipBadge && member.RelationshipType === 'P' && (
                  <span className={`px-2 py-1 text-xs rounded-full ${getRelationshipColor(member.RelationshipType)}`}>
                    {member.RelationshipDescription || 'Primary'}
                  </span>
                )}
                {(member.PaymentHoldEnrollmentCount ?? 0) > 0 && (
                  <span
                    className="inline-flex items-center px-2 py-1 text-xs font-semibold rounded-full bg-yellow-100 text-yellow-800 border border-yellow-300"
                    title="At least one enrollment is in PaymentHold (initial payment not completed)"
                  >
                    <AlertCircle className="h-3 w-3 mr-1" />
                    Enrollment payment hold ({member.PaymentHoldEnrollmentCount})
                  </span>
                )}
                <MemberEnrollmentLifecycleBadges member={member} getStatusColor={getStatusColor} />
              </div>
              <p className={`text-sm ${
                member.Status === 'Terminated' ? 'text-gray-400' : 'text-gray-500'
              }`}>
                {member.Email}
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-2 mb-4">
          {member.RelationshipType !== 'P' && (
            <div className="flex items-center text-xs text-gray-500">
              {getRelationshipIcon(member.RelationshipType)}
              <span className={`ml-1 px-2 py-1 text-xs rounded-full ${getRelationshipColor(member.RelationshipType)}`}>
                {member.RelationshipDescription || 'Primary'}
              </span>
            </div>
          )}
          {member.HouseholdId && member.PrimaryMemberName && member.RelationshipType !== 'P' && (
            <div className="flex items-center text-xs text-gray-500">
              <Home size={12} className="mr-1" />
              <span>Household: {member.PrimaryMemberName}</span>
            </div>
          )}
          {member.GroupName && (
            <div className="flex items-center text-xs text-gray-500">
              <Users size={12} className="mr-1" />
              <span>{member.GroupName}</span>
            </div>
          )}
          {member.AgentName && (
            <div className="flex items-center text-xs text-gray-500">
              <UserCheck size={12} className="mr-1" />
              <span>
                {member.AgentName}
                {member.AgencyName && ` (${member.AgencyName})`}
              </span>
            </div>
          )}
          {canViewAllTenants && (member.TenantName || member.TenantId) && (
            <div className="flex items-center text-xs text-gray-500" title="Tenant this member belongs to">
              <Building2 size={12} className="mr-1" />
              <span>{member.TenantName || member.TenantId}</span>
            </div>
          )}
        </div>

        <div className="mb-4 text-sm">
          <div>
            <span className="text-gray-500">Monthly Premium:</span>
            <p className="font-medium text-oe-success">{formatCurrency(member.MonthlyPremium || 0)}</p>
          </div>
        </div>

        <div className="flex gap-2">
          {member.EnrollmentStatus !== 'Enrolled' && member.Status !== 'Terminated' && (
            <button
              onClick={() => {
                setQuickEnrollmentPrefill({
                  memberId: member.MemberId,
                  firstName: member.FirstName,
                  lastName: member.LastName,
                  email: member.Email,
                  phoneNumber: member.PhoneNumber,
                });
                setQuickEnrollmentLockRecipient(true);
                setShowQuickEnrollmentModal(true);
              }}
              className="flex-1 inline-flex items-center justify-center px-3 py-2 text-sm font-medium rounded-md text-white bg-oe-primary hover:bg-oe-dark transition-colors"
              title="Send enrollment link"
            >
              <Send size={14} className="mr-1" />
              Send Link
            </button>
          )}
          <button
            onClick={() => handleMemberSelect(member)}
            className="flex-1 bg-oe-primary text-white px-3 py-2 rounded-md text-sm font-medium hover:bg-oe-dark transition-colors flex items-center justify-center"
          >
            <Eye size={14} className="mr-1" />
            View Details
          </button>
        </div>
      </div>
    </div>
  );

  // Member List Item Component
  const MemberListItem: React.FC<{ member: Member }> = ({ member }) => (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 hover:shadow-md transition-shadow duration-200">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4 flex-1 min-w-0">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${
                member.Status === 'Terminated' && member.EnrollmentStatus !== 'Pending Migration' ? 'bg-red-100' : 'bg-oe-light'
          }`}>
            <User size={16} className={member.Status === 'Terminated' && member.EnrollmentStatus !== 'Pending Migration' ? 'text-red-600' : 'text-oe-primary'} />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <h3
                className={`text-lg font-semibold flex items-center gap-2 flex-wrap min-w-0 ${
                  member.Status === 'Terminated' ? 'text-gray-400' : 'text-oe-neutral-dark'
                }`}
              >
                <span className="truncate">{member.FirstName} {member.LastName}</span>
                {resolveHouseholdMemberId(member) ? (
                  <span
                    className="text-xs font-mono font-medium text-gray-800 bg-gray-100 border border-gray-200 px-2 py-0.5 rounded shrink-0"
                    title="Household member ID (display)"
                  >
                    {resolveHouseholdMemberId(member)}
                  </span>
                ) : null}
              </h3>
              {showPrimaryRelationshipBadge && member.RelationshipType === 'P' && (
                <span className={`px-2 py-1 text-xs rounded-full ${getRelationshipColor(member.RelationshipType)}`}>
                  {member.RelationshipDescription || 'Primary'}
                </span>
              )}
              {(member.PaymentHoldEnrollmentCount ?? 0) > 0 && (
                <span
                  className="inline-flex items-center px-2 py-1 text-xs font-semibold rounded-full bg-yellow-100 text-yellow-800 border border-yellow-300"
                  title="At least one enrollment is in PaymentHold (initial payment not completed)"
                >
                  <AlertCircle className="h-3 w-3 mr-1" />
                  Enrollment payment hold ({member.PaymentHoldEnrollmentCount})
                </span>
              )}
              <MemberEnrollmentLifecycleBadges member={member} getStatusColor={getStatusColor} />
            </div>

            <div className="flex items-center gap-6 text-sm text-gray-500 flex-wrap">
              <div className="flex items-center min-w-0">
                <Mail size={12} className="mr-1 flex-shrink-0" />
                <span className="truncate">{member.Email}</span>
              </div>
              {member.PhoneNumber && (
                <div
                  className="flex items-center text-gray-500 cursor-default"
                  title={member.PhoneNumber}
                  aria-label={`Phone ${member.PhoneNumber}`}
                >
                  <Phone size={12} className="flex-shrink-0" />
                  <span className="sr-only">{member.PhoneNumber}</span>
                </div>
              )}
              {member.RelationshipType !== 'P' && (
                <div className="flex items-center">
                  {getRelationshipIcon(member.RelationshipType)}
                  <span className={`ml-1 px-2 py-1 text-xs rounded-full ${getRelationshipColor(member.RelationshipType)}`}>
                    {member.RelationshipDescription || 'Primary'}
                  </span>
                </div>
              )}
              {member.HouseholdId && member.PrimaryMemberName && member.RelationshipType !== 'P' && (
                <div className="flex items-center">
                  <Home size={12} className="mr-1" />
                  <span className="text-xs">HH: {member.PrimaryMemberName}</span>
                </div>
              )}
              {member.AgentName && (
                <div className="flex items-center">
                  <UserCheck size={12} className="mr-1" />
                  <span className="text-xs">
                    {member.AgentName}
                    {member.AgencyName && ` (${member.AgencyName})`}
                  </span>
                </div>
              )}
              {canViewAllTenants && (member.TenantName || member.TenantId) && (
                <div className="flex items-center" title="Tenant this member belongs to">
                  <Building2 size={12} className="mr-1" />
                  <span className="text-xs">{member.TenantName || member.TenantId}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4 flex-shrink-0 text-sm">
          <div className="text-right">
            <div className="text-gray-500 text-xs">Monthly Premium</div>
            <div className="font-medium text-oe-success">{formatCurrency(member.MonthlyPremium || 0)}</div>
          </div>
          <div className="flex items-center gap-2">
            {member.EnrollmentStatus !== 'Enrolled' && member.Status !== 'Terminated' ? (
              <button
                onClick={() => {
                  setQuickEnrollmentPrefill({
                    memberId: member.MemberId,
                    firstName: member.FirstName,
                    lastName: member.LastName,
                    email: member.Email,
                    phoneNumber: member.PhoneNumber,
                  });
                  setQuickEnrollmentLockRecipient(true);
                  setShowQuickEnrollmentModal(true);
                }}
                className="inline-flex items-center whitespace-nowrap px-3 py-2 text-sm font-medium rounded-md text-white bg-oe-primary hover:bg-oe-dark transition-colors"
                title="Send enrollment link"
              >
                <Send size={14} className="mr-1" />
                Send Link
              </button>
            ) : (
              <div className="invisible inline-flex items-center whitespace-nowrap px-3 py-2 text-sm font-medium">
                <Send size={14} className="mr-1" />
                Send Link
              </div>
            )}
            <button
              onClick={() => handleMemberSelect(member)}
              className="inline-flex items-center whitespace-nowrap bg-oe-primary text-white px-3 py-2 rounded-md text-sm font-medium hover:bg-oe-dark transition-colors"
            >
              <Eye size={14} className="mr-1" />
              Details
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  // Render loading state if auth is still loading
  if (isAuthLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="spinner-border text-primary mb-4" role="status">
            <span className="sr-only">Loading authentication...</span>
          </div>
          <h3 className="text-lg font-medium text-gray-900">
            Authenticating...
          </h3>
          <p className="text-gray-500">Please wait while we verify your credentials</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Main Content */}
      <div className="flex-1 flex flex-col">
        {/* Members Content */}
        <div className="flex-1 overflow-auto p-6">
          {/* Success Alert */}
          {successMessage && (
            <div className="mb-6 bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded relative">
              <div className="flex items-center">
                <CheckCircle size={20} className="mr-2" />
                <span>{successMessage}</span>
                <button
                  onClick={() => setSuccessMessage(null)}
                  className="absolute top-0 right-0 px-4 py-3"
                >
                  <X size={25} />
                </button>
              </div>
            </div>
          )}

          {/* Error Alert - Updated to show both query and mutation errors */}
          {(isError || mutationError) && (
            <div className="mb-6 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded relative">
              <div className="flex items-center">
                <AlertCircle size={20} className="mr-2" />
                <span>{error?.message || mutationError}</span>
                <button
                  onClick={() => setMutationError(null)}
                  className="absolute top-0 right-0 px-4 py-3"
                >
                  <X size={25} />
                </button>
              </div>
            </div>
          )}

          {/* Stats Cards — agency-wide scope; list defaults to Active primaries (relationship Primary, group+individual) */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
            <div className="bg-white rounded-lg shadow p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">Enrolled Households</p>
                  <p className="text-2xl font-bold">
                    {Number(globalMetrics?.enrolledHouseholdCount ?? 0).toLocaleString()}
                  </p>
                  {headerStatsScopeLabel && (
                    <p className="text-xs text-gray-400 mt-1">{headerStatsScopeLabel}</p>
                  )}
                </div>
                <div className="bg-oe-primary p-3 rounded-full text-white">
                  <Home size={24} />
                </div>
              </div>
            </div>

            <div className="bg-white rounded-lg shadow p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-500">Monthly Premium Volume</p>
                  <p className="text-2xl font-bold">{formatCurrency(Number(globalMetrics?.monthlyPremiums ?? 0))}</p>
                  {headerStatsScopeLabel && (
                    <p className="text-xs text-gray-400 mt-1">{headerStatsScopeLabel}</p>
                  )}
                </div>
                <div className="bg-purple-500 p-3 rounded-full text-white">
                  <DollarSign size={24} />
                </div>
              </div>
            </div>
          </div>

          {/* Search */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
            <div className="max-w-xl flex-1 relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Search className="h-5 w-5 text-gray-400" />
              </div>
              <input
                type="text"
                placeholder="Search by name, email, phone, or household member ID... (⌘K)"
                value={searchValue}
                onChange={(e) => setSearchValue(e.target.value)}
                className="block w-full pl-10 pr-10 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              />
              {searchValue && (
                <button
                  type="button"
                  onClick={() => setSearchValue('')}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600"
                >
                  <X className="h-5 w-5" />
                </button>
              )}
            </div>
            {isSearching && (
              <div className="flex items-center text-sm text-gray-500 shrink-0">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-oe-primary mr-2"></div>
                Searching...
              </div>
            )}
          </div>

          {/* Filters — core always visible; advanced collapsible */}
          <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
            <p className="text-sm font-medium text-gray-900 mb-3">Filters</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Enrollment status</label>
                <select
                  value={combinedMemberStatusFilterValue}
                  onChange={(e) => handleCombinedMemberStatusFilter(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                >
                  <option value="">Any</option>
                  <optgroup label="Enrollment">
                    <option value="es:activelyEnrolled">Actively Enrolled</option>
                    <option value="es:effectiveCurrently">Effective Currently</option>
                    <option value="es:futureEffective">Future Effective</option>
                  </optgroup>
                  <optgroup label="Member record">
                    <option value="status:Active">Active</option>
                    <option value="status:Pending Payment">Pending Payment</option>
                    <option value="status:Terminated">Terminated</option>
                  </optgroup>
                  <optgroup label="Enrollment journey">
                    <option value="el:enrollmentLinkSent">Enrollment link sent</option>
                    <option value="el:notEnrolled">Not enrolled</option>
                    <option value="el:noLinkSent">No link sent yet</option>
                    <option value="el:paymentHold">Enrollment payment hold</option>
                    <option value="el:pendingMigration">Pending migration (imported)</option>
                  </optgroup>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Group/Individual</label>
                <select
                  value={filters.memberTypeFilter || 'all'}
                  onChange={(e) => handleFilterChange('memberTypeFilter', e.target.value as 'individual' | 'group' | 'all')}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                >
                  <option value="individual">Individual</option>
                  <option value="group">Group</option>
                  <option value="all">Group & individual</option>
                </select>
              </div>
            </div>

            {currentUser.userType === 'Agent' && (
              <div className="mt-4 max-w-md">
                <label className="block text-sm font-medium text-gray-700 mb-1">Agent</label>
                <SearchableDropdown
                  options={downlineAgentOptions.map((opt) => ({ id: opt.id, label: opt.label, value: opt.value, email: opt.email }))}
                  value={filters.agentId || ''}
                  onChange={(value) => {
                    handleFilterChange('agentId', value);
                    if (value) handleFilterChange('agencyId', '');
                    setAgencyOptions([]);
                  }}
                  placeholder={
                    filters.agentId === AGENT_FILTER_SCOPE_AGENCY
                      ? agentFilterPlaceholderLabels.agency
                      : filters.agentId === AGENT_FILTER_SCOPE_DIRECT_DOWNLINE
                        ? agentFilterPlaceholderLabels.direct
                        : filters.agentId === AGENT_FILTER_SHOW_ALL
                          ? agentFilterPlaceholderLabels.downline
                          : 'Me or specific agent'
                  }
                  searchPlaceholder="Search agents..."
                  loading={isLoadingDownlineAgents}
                  showEmail={true}
                  useBackendSearch={false}
                  className="w-full"
                />
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => setShowAdvancedFilters((prev) => !prev)}
                className={`inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border transition-colors ${
                  showAdvancedFilters
                    ? 'bg-gray-100 border-gray-300 text-gray-900'
                    : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                }`}
                aria-expanded={showAdvancedFilters}
              >
                <SlidersHorizontal className="h-4 w-4" />
                Advanced filters
                <ChevronDown className={`h-4 w-4 transition-transform ${showAdvancedFilters ? 'rotate-180' : ''}`} />
              </button>
              <button
                type="button"
                onClick={() => {
                  setSearchValue('');
                  setFilters({
                    search: '',
                    status: '',
                    tenantId: '',
                    groupId: '',
                    agentId:
                      (user?.currentRole || currentUser.userType) === 'Agent'
                        ? agencyWideFilterAvailable
                          ? AGENT_FILTER_SCOPE_AGENCY
                          : AGENT_FILTER_SHOW_ALL
                        : '',
                    agencyId: '',
                    enrollmentType: '',
                    state: '',
                    relationshipType: 'P',
                    householdOnly: false,
                    page: 1,
                    limit: 10,
                    sortBy: 'CreatedDate',
                    sortOrder: 'desc',
                    enrollmentStatus: 'all',
                    enrollmentLifecycleStatus: '',
                    memberTypeFilter: 'all',
                    productId: '',
                    vendorId: '',
                    effectiveDay: '',
                    effectiveMonth: '',
                    effectiveYear: ''
                  });
                  setAgentOptions([]);
                  setAgencyOptions([]);
                  setGroupOptions([]);
                  if (groups && groups.length > 0) {
                    const initialGroups = groups
                      .slice(0, 20)
                      .map((group: any) => ({
                        id: group.GroupId || group.id,
                        label: group.Name || group.name || 'Unnamed Group',
                        value: group.GroupId || group.id
                      }));
                    setGroupOptions(initialGroups);
                  }
                }}
                className="text-sm text-gray-600 hover:text-gray-900 underline underline-offset-2"
              >
                Reset all filters
              </button>
            </div>

            {showAdvancedFilters && (
              <div className="mt-4 pt-4 border-t border-gray-200 space-y-4">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Narrow by location, organization, or product</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Relationship</label>
                    <select
                      value={filters.relationshipType}
                      onChange={(e) => handleFilterChange('relationshipType', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    >
                      <option value="">All Types</option>
                      <option value="P">Primary</option>
                      <option value="S">Spouse</option>
                      <option value="C">Child</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">State</label>
                    <select
                      value={filters.state}
                      onChange={(e) => handleFilterChange('state', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    >
                      <option value="">All states</option>
                      {US_STATES.map((state) => (
                        <option key={state.value} value={state.value}>{state.label}</option>
                      ))}
                    </select>
                  </div>

                  {canViewAllTenants && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Tenant</label>
                      <select
                        value={filters.tenantId}
                        onChange={(e) => handleFilterChange('tenantId', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      >
                        <option value="">All tenants</option>
                        {tenantOptions.map((t) => (
                          <option key={t.TenantId} value={t.TenantId}>{t.Name}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {canViewAllGroups && (
                    <div className="sm:col-span-2 lg:col-span-1">
                      <label className="block text-sm font-medium text-gray-700 mb-1">Group</label>
                      <SearchableDropdown
                        options={groupOptions}
                        value={filters.groupId || ''}
                        onChange={(value) => handleFilterChange('groupId', value)}
                        placeholder="Search for a group..."
                        searchPlaceholder="Type to search groups..."
                        loading={groupSearchLoading}
                        onSearch={searchGroups}
                        useBackendSearch={true}
                        className="w-full"
                      />
                    </div>
                  )}

                  {(currentUser.userType === 'TenantAdmin' || currentUser.userType === 'SysAdmin') && (
                    <>
                      <div className="sm:col-span-2 lg:col-span-2">
                        <label className="block text-sm font-medium text-gray-700 mb-1">Agent</label>
                        <SearchableDropdown
                          options={agentOptions}
                          value={filters.agentId || ''}
                          onChange={(value) => {
                            handleFilterChange('agentId', value);
                            if (value) {
                              handleFilterChange('agencyId', '');
                              setAgencyOptions([]);
                            }
                          }}
                          placeholder="Search for an agent..."
                          searchPlaceholder="Type to search agents..."
                          loading={agentSearchLoading}
                          showEmail={true}
                          onSearch={searchAgents}
                          useBackendSearch={true}
                          className="w-full"
                        />
                      </div>
                      <div className="sm:col-span-2 lg:col-span-2">
                        <label className="block text-sm font-medium text-gray-700 mb-1">Agency</label>
                        <SearchableDropdown
                          options={agencyOptions}
                          value={filters.agencyId || ''}
                          onChange={(value) => {
                            handleFilterChange('agencyId', value);
                            if (value) {
                              handleFilterChange('agentId', '');
                              setAgentOptions([]);
                            }
                          }}
                          placeholder="Search for an agency..."
                          searchPlaceholder="Type to search agencies..."
                          loading={agencySearchLoading}
                          onSearch={searchAgencies}
                          useBackendSearch={true}
                          className="w-full"
                        />
                      </div>
                    </>
                  )}

                  <div className="sm:col-span-2 lg:col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">Enrolled in product</label>
                    <SearchableDropdown
                      options={productOptions}
                      value={filters.productId || ''}
                      onChange={(value) => handleFilterChange('productId', value)}
                      placeholder="All products"
                      searchPlaceholder="Search products..."
                      showSublabel={true}
                      showEmailInSelection={true}
                      className="w-full"
                    />
                  </div>
                  <div className="sm:col-span-2 lg:col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">Enrolled with vendor</label>
                    <SearchableDropdown
                      options={vendorOptions}
                      value={filters.vendorId || ''}
                      onChange={(value) => handleFilterChange('vendorId', value)}
                      placeholder="All vendors"
                      searchPlaceholder="Search vendors..."
                      className="w-full"
                    />
                  </div>

                  <div className="sm:col-span-2 lg:col-span-3">
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Enrollment effective date</p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Day of month</label>
                        <select
                          value={filters.effectiveDay || ''}
                          onChange={(e) => handleFilterChange('effectiveDay', e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                        >
                          {EFFECTIVE_DAY_OPTIONS.map((o) => (
                            <option key={o.value === '' ? 'any-day' : o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Month</label>
                        <select
                          value={filters.effectiveMonth || ''}
                          onChange={(e) => handleFilterChange('effectiveMonth', e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                        >
                          {EFFECTIVE_MONTH_OPTIONS.map((o) => (
                            <option key={o.value === '' ? 'any-month' : o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Year</label>
                        <select
                          value={filters.effectiveYear || ''}
                          onChange={(e) => handleFilterChange('effectiveYear', e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                        >
                          {effectiveYearOptions.map((o) => (
                            <option key={o.value === '' ? 'any-year' : o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <p className="text-xs text-gray-500 mt-2">
                      Used as the as-of date for Enrollment status. If day is blank and month/year is selected, the filter uses the 1st of that month.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Toolbar: view + actions */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-6">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex border border-gray-300 rounded-md overflow-hidden">
                <button
                  type="button"
                  onClick={() => setViewMode('grid')}
                  className={`p-2 ${viewMode === 'grid' ? 'bg-oe-primary text-white' : 'text-gray-600 hover:bg-gray-50'}`}
                  title="Grid view"
                >
                  <Grid size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('list')}
                  className={`p-2 ${viewMode === 'list' ? 'bg-oe-primary text-white' : 'text-gray-600 hover:bg-gray-50'}`}
                  title="List view"
                >
                  <List size={16} />
                </button>
              </div>
              <div
                className="pl-1 min-h-[1.5rem] flex items-center"
                aria-live="polite"
                aria-label={
                  isLoading
                    ? 'Updating results'
                    : filterTotals
                      ? `${filterTotals.householdCount.toLocaleString()} households, ${formatCurrency(filterTotals.totalRevenue)} premium total, ${totalMembers.toLocaleString()} people in list`
                      : `${totalMembers.toLocaleString()} members found`
                }
              >
                {isLoading ? (
                  <span className="text-xs text-gray-500 flex items-center gap-2">
                    Updating…
                    <span className="inline-block h-3.5 w-3.5 border-2 border-oe-primary border-t-transparent rounded-full animate-spin" />
                  </span>
                ) : (
                  <div className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs sm:text-sm">
                    {filterTotals ? (
                      <>
                        <span className="inline-flex items-baseline gap-1">
                          <span className="tabular-nums font-semibold text-gray-900">{filterTotals.householdCount.toLocaleString()}</span>
                          <span className="text-gray-500">households</span>
                        </span>
                        <span className="text-gray-300 select-none" aria-hidden>
                          ·
                        </span>
                        <span className="inline-flex items-baseline gap-1">
                          <span className="tabular-nums font-semibold text-oe-primary">{formatCurrency(filterTotals.totalRevenue)}</span>
                          <span className="text-gray-500">premium total</span>
                        </span>
                        {totalMembers !== filterTotals.householdCount && (
                          <>
                            <span className="text-gray-300 select-none" aria-hidden>
                              ·
                            </span>
                            <span className="text-gray-500">
                              <span className="tabular-nums text-gray-700">{totalMembers.toLocaleString()}</span> people in list
                            </span>
                          </>
                        )}
                      </>
                    ) : (
                      <span className="inline-flex items-baseline gap-1">
                        <span className="tabular-nums font-semibold text-gray-900">{totalMembers.toLocaleString()}</span>
                        <span className="text-gray-500">members found</span>
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 justify-start sm:justify-end">
              {canExportMembers && (
                <button
                  type="button"
                  onClick={handleExportMembers}
                  disabled={exportLoading}
                  className="bg-oe-primary text-white px-4 py-2 rounded-lg hover:bg-oe-primary-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center text-sm"
                  title="Export members to CSV"
                >
                  <Download size={16} className="mr-1.5" />
                  {exportLoading ? 'Exporting…' : 'Export CSV'}
                </button>
              )}
              {/* Enrollment Link button hidden per request */}
              {canAddMembers && (
                <button
                  type="button"
                  onClick={() => {
                    setQuickEnrollmentPrefill(null);
                    setQuickEnrollmentLockRecipient(false);
                    setShowQuickEnrollmentModal(true);
                    setMutationError(null);
                  }}
                  className="px-4 py-2 text-sm font-medium text-white bg-gradient-to-r from-purple-600 to-indigo-600 rounded-lg hover:from-purple-700 hover:to-indigo-700 flex items-center"
                  title="Create member and send enrollment link immediately"
                >
                  <Plus size={16} className="mr-2" />
                  New Member
                </button>
              )}
            </div>
          </div>

          {/* Members Display - Show existing members even while loading */}
          <div className={
            viewMode === 'grid'
              ? "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6"
              : "space-y-4"
          }>
            {Array.isArray(filteredMembers) && filteredMembers.map((member) => (
              viewMode === 'grid'
                ? <MemberCard key={member.MemberId} member={member} />
                : <MemberListItem key={member.MemberId} member={member} />
            ))}
          </div>

          {/* Pagination — bottom */}
          {Array.isArray(members) && pagination.total > 0 && (
            <div className="mt-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 bg-white rounded-lg shadow-sm border border-gray-200 p-4">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <label className="text-sm text-gray-700">Show:</label>
                  <select
                    value={pagination.limit}
                    onChange={(e) => handleFilterChange('limit', parseInt(e.target.value))}
                    className="border border-gray-300 rounded-md px-2 py-1 text-sm focus:ring-2 focus:ring-oe-primary"
                  >
                    <option value={10}>10</option>
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                  <span className="text-sm text-gray-700">per page</span>
                </div>

                <div className="text-sm text-gray-700">
                  Rows {((pagination.page - 1) * pagination.limit) + 1}–
                  {Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total.toLocaleString()}
                </div>
              </div>

              {pagination.total > pagination.limit && (
                <div className="flex items-center gap-1 justify-center sm:justify-end">
                  <button
                    type="button"
                    onClick={() => handlePaginationChange(pagination.page - 1)}
                    disabled={pagination.page === 1}
                    className={`p-2 rounded-md ${pagination.page === 1
                      ? 'text-gray-400 cursor-not-allowed'
                      : 'text-gray-600 hover:bg-gray-100'
                      }`}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>

                  {(() => {
                    const totalPages = pagination.totalPages || Math.ceil(pagination.total / pagination.limit);
                    const currentPage = pagination.page;
                    const pages = [];

                    if (currentPage > 3) {
                      pages.push(1);
                      if (currentPage > 4) pages.push('...');
                    }

                    for (let i = Math.max(1, currentPage - 2); i <= Math.min(totalPages, currentPage + 2); i++) {
                      pages.push(i);
                    }

                    if (currentPage < totalPages - 2) {
                      if (currentPage < totalPages - 3) pages.push('...');
                      pages.push(totalPages);
                    }

                    return pages.map((page, index) => (
                      page === '...' ? (
                        <span key={index} className="px-2 py-1 text-gray-400">...</span>
                      ) : (
                        <button
                          key={page}
                          type="button"
                          onClick={() => handlePaginationChange(page as number)}
                          className={`px-3 py-1 rounded-md text-sm ${
                            page === currentPage
                              ? 'bg-oe-primary text-white'
                              : 'text-gray-600 hover:bg-gray-100'
                          }`}
                        >
                          {page}
                        </button>
                      )
                    ));
                  })()}

                  <button
                    type="button"
                    onClick={() => handlePaginationChange(pagination.page + 1)}
                    disabled={pagination.page >= (pagination.totalPages || Math.ceil(pagination.total / pagination.limit))}
                    className={`p-2 rounded-md ${pagination.page >= (pagination.totalPages || Math.ceil(pagination.total / pagination.limit))
                      ? 'text-gray-400 cursor-not-allowed'
                      : 'text-gray-600 hover:bg-gray-100'
                      }`}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Loading overlay when searching with existing results */}
          {isLoading && Array.isArray(filteredMembers) && filteredMembers.length > 0 && (
            <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <div className="flex items-center justify-center">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-oe-primary mr-2"></div>
                <span className="text-sm text-oe-primary-dark">Updating results...</span>
              </div>
            </div>
          )}

          {/* Initial loading state (when no members loaded yet) */}
          {isLoading && (!Array.isArray(filteredMembers) || filteredMembers.length === 0) && (
            <div className="flex items-center justify-center h-64">
              <div className="text-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary mx-auto mb-4"></div>
                <div className="text-lg text-gray-600">Loading members...</div>
              </div>
            </div>
          )}

          {/* No members message */}
          {!isLoading && Array.isArray(filteredMembers) && filteredMembers.length === 0 && (
            <div className="text-center py-12 bg-white rounded-lg shadow-sm">
              <Users size={48} className="mx-auto text-gray-400 mb-4" />
              <h3 className="text-lg font-medium text-oe-neutral-dark mb-2">No members found</h3>
              <p className="text-gray-600">
                No members match your search criteria or filters.
              </p>
            </div>
          )}

        </div>
      </div>

      {/* Member Management Modal with Tabs */}
      {selectedMember && (
        <MemberManagementModal
          member={selectedMember}
          householdMembers={householdMembers}
          memberEnrollments={memberEnrollments}
          enrollmentsLoading={enrollmentsLoading}
          onClose={() => setSelectedMember(null)}
          onSendEnrollmentLink={(m) => {
            setQuickEnrollmentPrefill({
              memberId: m.MemberId,
              firstName: m.FirstName,
              lastName: m.LastName,
              email: m.Email,
              phoneNumber: m.PhoneNumber,
              agentId: m.AgentId || m.GroupAgentId
            });
            setQuickEnrollmentLockRecipient(true);
            setMutationError(null);
            setShowQuickEnrollmentModal(true);
          }}
          onEdit={openMemberEdit}
          formatCurrency={formatCurrency}
          getStatusColor={getStatusColor}
          getRelationshipIcon={getRelationshipIcon}
          getRelationshipColor={getRelationshipColor}
          canEdit={canAddMembers}
          canDelete={canDeleteMembers}
          onRefresh={async () => {
            refetch();
            refetchMetrics();
            // Refresh enrollments when member modal is reopened
            if (selectedMember) {
              try {
                const enrollmentsResponse = await apiService.get<{ 
                  success: boolean, 
                  data: Enrollment[] 
                }>(`/api/enrollments?memberId=${selectedMember.MemberId}`);
                
                if (enrollmentsResponse.success) {
                  setMemberEnrollments(enrollmentsResponse.data);
                }
              } catch (err) {
                console.error('Error refreshing enrollments:', err);
              }
            }
          }}
          onRemoveComplete={() => {
            setSelectedMember(null);
          }}
        />
      )}

      {memberEditOpen && memberEditTarget && (
        <MemberEdit
          show={memberEditOpen}
          member={memberEditTarget}
          groupId={memberEditTarget.GroupId || undefined}
          onClose={closeMemberEdit}
          onSuccess={async () => {
            const editedId = memberEditTarget.MemberId;
            closeMemberEdit();
            await refetch();
            refetchMetrics();
            if (selectedMember?.MemberId === editedId) {
              await handleMemberSelect(selectedMember);
            }
          }}
          loading={addMemberLoading}
          setLoading={setAddMemberLoading}
          error={mutationError}
          setError={setMutationError}
          setSuccessMessage={setSuccessMessage}
          US_STATES={US_STATES}
        />
      )}

      {/* Add Household Modal */}
      {showAddModal && (
        <MembersAddHousehold
          show={showAddModal}
          onClose={() => setShowAddModal(false)}
          onSuccess={() => {
            refetch(); // Use refetch from the hook
            refetchMetrics(); // Use refetch from the metrics hook
          }}
          loading={addMemberLoading}
          setLoading={setAddMemberLoading}
          error={mutationError}
          setError={setMutationError}
          setSuccessMessage={setSuccessMessage}
          onSendEnrollmentLink={async (memberId, memberEmail, memberName) => {
            try {
              // Fetch fresh member data to ensure we have the latest agent information
              const response = await apiService.get<{ success: boolean; data: Member }>(`/api/members/${memberId}`);
              
              if (response.success && response.data) {
                console.log('🔍 Fresh member data with agent info:', response.data);
                setSelectedMemberForLink(response.data);
              } else {
                // Fallback to basic member data if API fails
                console.log('⚠️ Using basic member data (API failed)');
                const tempMember: Member = {
                  MemberId: memberId,
                  FirstName: memberName.split(' ')[0],
                  LastName: memberName.split(' ')[1] || '',
                  Email: memberEmail,
                  Status: 'Active',
                  UserId: '',
                  GroupId: '',
                  EnrollmentType: 'Individual',
                  CreatedDate: new Date().toISOString(),
                  ModifiedDate: new Date().toISOString(),
                  Tier: 'EE',
                  RelationshipType: 'P'
                } as Member;
                setSelectedMemberForLink(tempMember);
              }
            } catch (error) {
              console.error('Error fetching fresh member data:', error);
              // Fallback to basic member data
              const tempMember: Member = {
                MemberId: memberId,
                FirstName: memberName.split(' ')[0],
                LastName: memberName.split(' ')[1] || '',
                Email: memberEmail,
                Status: 'Active',
                UserId: '',
                GroupId: '',
                EnrollmentType: 'Individual',
                CreatedDate: new Date().toISOString(),
                ModifiedDate: new Date().toISOString(),
                Tier: 'EE',
                RelationshipType: 'P'
              } as Member;
              setSelectedMemberForLink(tempMember);
            }
            
            setShowEnrollmentLinkModal(true);
          }}
          US_STATES={US_STATES}
        />
      )}

      {/* Add Dependent Modal */}
      {showAddDependentModal && selectedMember && (
        <MembersAddDependent
          show={showAddDependentModal}
          selectedMember={selectedMember}
          onClose={() => setShowAddDependentModal(false)}
          onSuccess={async () => {
            await refetch(); // Use refetch from the hook
            await refetchMetrics();
            // Refresh the member details to show new dependent
            if (selectedMember) {
              try {
                const householdResponse = await apiService.get<{ 
                  success: boolean, 
                  data: { 
                    member: Member, 
                    householdMembers: Member[] 
                  } 
                }>(`/api/members/${selectedMember.MemberId}/with-household`);
                
                if (householdResponse.success) {
                  setSelectedMember(householdResponse.data.member);
                  setHouseholdMembers(householdResponse.data.householdMembers);
                }
              } catch (err) {
                console.error('Error refreshing member details after adding dependent:', err);
                setSelectedMember(null);
              }
            }
          }}
          loading={addMemberLoading}
          setLoading={setAddMemberLoading}
          error={mutationError}
          setError={setMutationError}
          setSuccessMessage={setSuccessMessage}
          US_STATES={US_STATES}
        />
      )}

      {/* Bulk Enrollment Link Modal */}
      {showBulkEnrollmentModal && (
        <BulkEnrollmentLinkModal
          open={showBulkEnrollmentModal}
          members={members}
          onClose={() => setShowBulkEnrollmentModal(false)}
          onLinkSent={() => {
            setShowBulkEnrollmentModal(false);
            refetch(); // Refresh member list to show updated enrollment status
            setSuccessMessage('Enrollment link sent successfully!');
          }}
        />
      )}

      {/* Individual Enrollment Link Modal */}
      {showEnrollmentLinkModal && selectedMemberForLink && (
        <IndividualEnrollmentLinkModal
          open={showEnrollmentLinkModal}
          member={selectedMemberForLink}
          onClose={() => {
            setShowEnrollmentLinkModal(false);
            setSelectedMemberForLink(null);
          }}
          onLinkSent={() => {
            setShowEnrollmentLinkModal(false);
            setSelectedMemberForLink(null);
            refetch(); // Refresh member list to show updated enrollment status
            setSuccessMessage('Enrollment link sent successfully!');
          }}
        />
      )}

      {/* Quick Enrollment Link Modal */}
      {showQuickEnrollmentModal && (
        <QuickEnrollmentLinkModal
          open={showQuickEnrollmentModal}
          prefillMember={quickEnrollmentPrefill || undefined}
          lockRecipient={quickEnrollmentLockRecipient}
          onClose={() => {
            setShowQuickEnrollmentModal(false);
            setQuickEnrollmentPrefill(null);
            setQuickEnrollmentLockRecipient(false);
            setMutationError(null);
          }}
          onLinkSent={() => {
            const sentFromLockedMember = quickEnrollmentLockRecipient;
            setShowQuickEnrollmentModal(false);
            setQuickEnrollmentPrefill(null);
            setQuickEnrollmentLockRecipient(false);
            refetch(); // Refresh member list to show new member
            refetchMetrics(); // Refresh metrics
            setSuccessMessage(
              sentFromLockedMember
                ? 'Enrollment link sent successfully!'
                : 'Member created and enrollment link sent successfully!'
            );
          }}
        />
      )}


    </div>
  );
};

export default MembersPage;