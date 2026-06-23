// File: frontend/src/pages/groups/GroupDetails.tsx
import {
    ArrowBack as ArrowBackIcon,
    Assessment as AssessmentIcon,
    CreditCard as BillingIcon,
    Business as BusinessIcon,
    CalendarMonth as CalendarIcon,
    CheckCircle as CheckCircleIcon,
    Checklist as ChecklistIcon,
    AccountBalance as ContributionsIcon,
    Delete as DeleteIcon,
    Description as DocumentsIcon,
    Edit as EditIcon,
    Email as EmailIcon,
    ErrorOutline as ErrorOutlineIcon,
    Event as EventIcon,
    FileDownload as FileDownloadIcon,
    LocationOn as LocationIcon,
    People as PeopleIcon,
    Phone as PhoneIcon,
    ShoppingCart as ProductsIcon,
    Rule as RuleIcon,
    Send as SendIcon,
    Tag as TagIcon,
    ManageAccounts as UsersIcon
} from '@mui/icons-material';
import {
    Alert,
    AlertTitle,
    alpha,
    Box,
    Button,
    Card,
    CardContent,
    Chip,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogContentText,
    DialogTitle,
    Divider,
    FormControl,
    Grid,
    IconButton,
    InputLabel,
    List,
    ListItem,
    ListItemIcon,
    ListItemText,
    MenuItem,
    Paper,
    Select,
    Skeleton,
    Slide,
    SlideProps,
    Snackbar,
    Stack,
    Tab,
    Tabs,
    TextField,
    Tooltip,
    Typography,
    useTheme
} from '@mui/material';
import { useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useBranding } from '../../contexts/BrandingContext';
import { formatPhoneNumber } from '../../utils/payment-validation';
import { buildGroupDetailPath, getGroupRouteIdentifier } from '../../utils/groupRoutes';
import GroupContributionsTab from './GroupContributionsTab';
import GroupMembersTab from './GroupMembersTab';
import GroupProductsTab from './GroupProductsTab';
import GroupSetupTab from './GroupSetupTab';
import GroupVendorGroupIdsTab from './GroupVendorGroupIdsTab';

// Import Phase 3 components
import { AlertCircle, CheckCircle, Edit2, FileSignature, SlidersHorizontal, Tag, X as XIcon } from 'lucide-react';
import NewGroupFormCertificationSignModal from '../../components/groups/NewGroupFormCertificationSignModal';
import UserManagement from '../../components/user-management/UserManagement';
import { useGroupCertification } from '../../hooks/useGroupCertification';
import { useGroupDetails } from '../../hooks/useGroupDetails'; // Import the hook
import { useGroupResolve } from '../../hooks/useGroupResolve';
import { apiService } from '../../services/api.service'; // Import the API service for product updates
import { GroupProductsService } from '../../services/group-products.service'; // Import the group products service
import { GroupsService, GroupTerminationPreviewData } from '../../services/groups.service'; // Import the service for updates
import { ApiResponse } from '../../types/api.types'; // Import the ApiResponse type
import GroupsAddGroup from '../groups/GroupsAddGroup';
import GroupAdvancedTab from './GroupAdvancedTab';
import GroupBillingTab from './GroupBillingTab';
import GroupDocumentsTab from './GroupDocumentsTab';
import GroupLocationsTab from './GroupLocationsTab';
import GroupSettingsTab from './GroupSettingsTab';
import { GroupBadge, PendingMigrationBadge } from '../../components/groups/GroupBadge';
import { useAgentPendingTypeChanges } from '../../hooks/agent/useAgentPendingTypeChanges';

// Types
interface GroupDetails {
  GroupId: string;
  Name: string;
  TaxIdNumber?: string;
  Status: 'Active' | 'Inactive' | 'Pending' | 'Archived';
  AdminName?: string;
  AdminEmail?: string;
  AdminPhone?: string;
  BillingType?: 'Monthly' | 'Quarterly' | 'Annual';
  TotalMembers: number;
  ActiveEnrollments: number;
  MonthlyPremium: number;
  CreatedDate: string;
  ModifiedDate?: string;
  TenantId: string;
  TenantCustomDomain?: string;
  Address?: string;
  City?: string;
  State?: string;
  Zip?: string;
  ContactTitle?: string;
  PrimaryContact: string;
  ContactEmail?: string;
  ContactPhone?: string;
  TenantName?: string;
  // Additional fields from Group interface
  Address2?: string;
  ContactPhone2?: string;
  FaxNumber?: string;
  Website?: string;
  BusinessType?: string;
  CreditCardNumber?: string;
  CreditCardType?: string;
  CreditCardExpiry?: string;
  CreditCardName?: string;
  ACHBankName?: string;
  ACHAccountType?: string;
  ACHRoutingNumber?: string;
  ACHAccountNumber?: string;
  ACHAccountName?: string;
  LogoUrl?: string;
  DocumentsFolder?: string;
  AgentName?: string;
  AgentId?: string;
  AgentUserId?: string;
  MinimumHirePeriod?: number;
  AllAboardMasterGroupId?: string | null;
}

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

// Snackbar notification type
type NotificationSeverity = 'success' | 'error' | 'warning' | 'info';

interface NotificationState {
  open: boolean;
  message: string;
  severity: NotificationSeverity;
  title?: string;
}

// Slide transition for Snackbar
function SlideTransition(props: SlideProps) {
  return <Slide {...props} direction="down" />;
}

const TabPanel: React.FC<TabPanelProps> = ({ children, value, index, ...other }) => {
  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`group-tabpanel-${index}`}
      aria-labelledby={`group-tab-${index}`}
      {...other}
    >
      {value === index && <Box sx={{ p: 3, width: '100%', maxWidth: '100%', overflowX: 'auto' }}>{children}</Box>}
    </div>
  );
};

const GroupDetails: React.FC<{ hideBackButton?: boolean; groupId?: string }> = ({ hideBackButton = false, groupId: propGroupId }) => {
  const { identifier: paramIdentifier } = useParams<{ identifier: string }>();
  // If a direct groupId prop is provided (e.g. GroupAdmin path), use it without resolution
  const { groupId: resolvedGroupId, isLoading: isResolvingSlug } = useGroupResolve(
    propGroupId ? undefined : paramIdentifier
  );
  const groupId = propGroupId || resolvedGroupId;
  const navigate = useNavigate();
  const location = useLocation();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { colors } = useBranding();

  // Roles that can delete a group: Agent, TenantAdmin, SysAdmin (not GroupAdmin)
  const canDeleteGroup = user?.currentRole && ['Agent', 'TenantAdmin', 'SysAdmin'].includes(user.currentRole);
  
  // Ref to track if we're updating hash internally to prevent loops
  const isInternalHashUpdate = useRef(false);
  
  // State (activeTab initialized from hash to avoid double mount - see getInitialActiveTab below)
  const [showEditModal, setShowEditModal] = useState(false);
  const [editProductsOnly, setEditProductsOnly] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [terminationPreview, setTerminationPreview] = useState<GroupTerminationPreviewData | null>(null);
  const [terminationPreviewLoading, setTerminationPreviewLoading] = useState(false);
  const [terminationPreviewError, setTerminationPreviewError] = useState<string | null>(null);
  const [showRestoreDialog, setShowRestoreDialog] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);
  // const [tenants, setTenants] = useState<any[]>([]);

  // Check if user has access to onboarding features
  const canAccessOnboarding = user?.roles?.some((role: string) => 
    ['Agent', 'TenantAdmin', 'SysAdmin', 'GroupAdmin'].includes(role)
  );

  // Check if user has access to eligibility rules (administrative settings)
  const canAccessEligibilityRules = user?.roles?.some((role: string) => 
    ['Agent', 'TenantAdmin', 'SysAdmin', 'GroupAdmin'].includes(role)
  );

  // Vendors tab: only TenantAdmin and SysAdmin (Agent/GroupAdmin sign certification from Details tab)
  const showVendorsTab = user?.roles?.some((role: string) => ['TenantAdmin', 'SysAdmin'].includes(role));
  // Users tab: Agent/TenantAdmin/SysAdmin/GroupAdmin (defined early for TAB_ORDER)
  const showUsersTab = user?.roles?.some((role: string) => ['Agent', 'TenantAdmin', 'SysAdmin', 'GroupAdmin'].includes(role));
  // Advanced tab: only TenantAdmin and SysAdmin (bulk change effective date, etc.)
  const showAdvancedTab = user?.roles?.some((role: string) => ['TenantAdmin', 'SysAdmin'].includes(role));

  const roles = (user?.roles || []) as string[];
  const canSignAsAgent = roles.some((r) => ['SysAdmin', 'TenantAdmin', 'Agent'].includes(r));
  const canSignAsGroupAdmin = roles.some((r) => ['SysAdmin', 'TenantAdmin', 'GroupAdmin'].includes(r));

  // Tab order and indices (computed early for hash-based initial tab)
  const TAB_ORDER = [
    'setup',
    'details',
    'members',
    'products',
    'contributions',
    'billing',
    'locations',
    'documents',
    ...(showVendorsTab ? ['groupIds'] : []),
    ...(showUsersTab ? ['users'] : []),
    ...(canAccessEligibilityRules ? ['settings'] : []),
    ...(showAdvancedTab ? ['advanced'] : []),
  ] as const;
  const TAB_INDICES = TAB_ORDER.reduce((acc, key, idx) => {
    (acc as Record<string, number>)[key] = idx;
    return acc;
  }, {} as Record<string, number>);

  // Initialize active tab from URL hash before first render to avoid double mount
  const getInitialActiveTab = () => {
    const hash = location.hash.replace('#', '');
    if (!hash) return 0;
    const targetIndex = TAB_INDICES[hash];
    return targetIndex !== undefined && targetIndex >= 0 ? targetIndex : 0;
  };

  // State
  const [activeTab, setActiveTab] = useState(getInitialActiveTab);

  // Snackbar notification state
  const [notification, setNotification] = useState<NotificationState>({
    open: false,
    message: '',
    severity: 'info'
  });

  // AllAboard Master Group ID inline-edit state
  const [masterGroupIdEditing, setMasterGroupIdEditing] = useState(false);
  const [masterGroupIdValue, setMasterGroupIdValue] = useState('');
  const [masterGroupIdSaving, setMasterGroupIdSaving] = useState(false);
  const [masterGroupIdValidation, setMasterGroupIdValidation] = useState<{
    available?: boolean;
    message?: string;
    checking?: boolean;
  }>({});

  // Monthly billing summary state
  const [monthlyBillSummary, setMonthlyBillSummary] = useState<{
    lastMonthBill: { amount: number; paymentDate: string; billingPeriodStart: string; billingPeriodEnd: string; } | null;
    nextMonthBill: { scheduledAmount: number; billingDate: string; lastUpdated: string; } | null;
  }>({ lastMonthBill: null, nextMonthBill: null });
  const [billingLoading, setBillingLoading] = useState(true);

  // Data fetching with the new hook
  const { data: groupData, isLoading: loading, isError, error: fetchError, refetch } = useGroupDetails(groupId);
  
  // Handle case where groupData might be the API response object instead of the data
  // This should not happen, but we'll handle it defensively
  const group = (groupData as any)?.data ? (groupData as any).data : groupData;

  // Canonicalize group URL to AllAboard master ID when available (UUID or legacy slug → 000042).
  useEffect(() => {
    if (propGroupId || !paramIdentifier || !group?.GroupId) return;
    const preferred = getGroupRouteIdentifier(group);
    const current = decodeURIComponent(paramIdentifier);
    if (!preferred || current.toLowerCase() === preferred.toLowerCase()) return;
    navigate(
      `${buildGroupDetailPath(user?.currentRole, group)}${location.search}${location.hash}`,
      { replace: true }
    );
  }, [
    propGroupId,
    paramIdentifier,
    group,
    user?.currentRole,
    location.search,
    location.hash,
    navigate,
  ]);

  // For agents: surface "approved type-change request, wizard not yet run"
  // as a banner below the group header so they don't have to dig through
  // email to discover it.
  const { findForGroup: findPendingTypeChange } = useAgentPendingTypeChanges();
  const pendingTypeChange = findPendingTypeChange(group?.GroupId);

  useEffect(() => {
    if (!showDeleteDialog || !group?.GroupId) return;
    let cancelled = false;
    setTerminationPreviewLoading(true);
    setTerminationPreviewError(null);
    setTerminationPreview(null);
    GroupsService.getGroupTerminationPreview(group.GroupId)
      .then((res) => {
        if (cancelled) return;
        if (res.success && res.data) {
          setTerminationPreview(res.data);
        } else {
          setTerminationPreviewError(res.message || 'Failed to load termination preview');
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : 'Failed to load termination preview';
        setTerminationPreviewError(msg);
      })
      .finally(() => {
        if (!cancelled) setTerminationPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showDeleteDialog, group?.GroupId]);
  
  // State for payment notifications
  const [hasFailedPayments, setHasFailedPayments] = useState(false);
  const [paymentNotificationLoading, setPaymentNotificationLoading] = useState(true);
  
  // State for New Group Form modal
  const [showNewGroupFormModal, setShowNewGroupFormModal] = useState(false);
  const [newGroupFormVendors, setNewGroupFormVendors] = useState<Array<{ VendorId: string; Id: string; VendorName: string; HasNewGroupFormConfig: boolean; Email?: string }>>([]);
  const [newGroupFormVendorsLoading, setNewGroupFormVendorsLoading] = useState(false);
  const [newGroupFormEmailOverrides, setNewGroupFormEmailOverrides] = useState<Record<string, string>>({});
  const [newGroupFormDownloading, setNewGroupFormDownloading] = useState(false);
  const [newGroupFormDownloadingTxt, setNewGroupFormDownloadingTxt] = useState(false);
  const [newGroupFormSending, setNewGroupFormSending] = useState<string | null>(null);
  // 2-step flow: step 'select' | 'review'; when 'review', show resolved values and allow edit before generate
  const [newGroupFormStep, setNewGroupFormStep] = useState<'select' | 'review'>('select');
  const [newGroupFormPreviewVendorId, setNewGroupFormPreviewVendorId] = useState<string | null>(null);
  const [newGroupFormPreviewData, setNewGroupFormPreviewData] = useState<{ formTitle: string; fields: Array<{ key: string; label: string; value: string; missing: boolean; fieldType?: string }>; vendorName: string } | null>(null);
  const [newGroupFormPreviewLoading, setNewGroupFormPreviewLoading] = useState(false);
  const [newGroupFormEditedValues, setNewGroupFormEditedValues] = useState<Record<string, string>>({});
  const getNewGroupFormFieldStateKey = (f: { key: string }, index: number) => `${f.key}__${index}`;
  const buildNewGroupFormOverridesPayload = () => {
    const byIndex: Record<number, string> = {};
    const byKey: Record<string, string> = {};
    (newGroupFormPreviewData?.fields || []).forEach((f, index) => {
      if (f.fieldType === 'labelHeader') return;
      const stateKey = getNewGroupFormFieldStateKey(f, index);
      const edited = newGroupFormEditedValues[stateKey] ?? '';
      byIndex[index] = edited;
      if (byKey[f.key] === undefined) byKey[f.key] = edited;
    });
    return { ...byKey, __byIndex: byIndex };
  };

  // History of generated/sent forms for tracking and mark-as-sent
  const [newGroupFormHistory, setNewGroupFormHistory] = useState<Array<{ id: string; vendorId: string; vendorName: string; actionType: 'Download' | 'Email'; occurredAt: string; recipientEmail?: string; markedAsSent: boolean }>>([]);
  const [newGroupFormHistoryLoading, setNewGroupFormHistoryLoading] = useState(false);
  const [newGroupFormHistoryPatching, setNewGroupFormHistoryPatching] = useState<string | null>(null);
  const [newGroupFormHistoryDeleting, setNewGroupFormHistoryDeleting] = useState<string | null>(null);
  const [newGroupFormHistoryDownloading, setNewGroupFormHistoryDownloading] = useState<string | null>(null);
  const [newGroupFormHistoryDeleteConfirmId, setNewGroupFormHistoryDeleteConfirmId] = useState<string | null>(null);
  const [showSendEmailModal, setShowSendEmailModal] = useState(false);

  // New Group Form certification (Agent / Group Admin sign on Details tab; TenantAdmin can also see status on Vendors tab)
  const { data: certification, isLoading: certificationLoading, refetch: refetchCertification } = useGroupCertification(groupId);
  const [signModalRole, setSignModalRole] = useState<'agent' | 'group-admin' | null>(null);
  const [signSubmitting, setSignSubmitting] = useState(false);

  // State for onboarding status
  const [onboardingStatus, setOnboardingStatus] = useState<{ isOnboarded: boolean } | null>(null);
  const [onboardingStatusLoading, setOnboardingStatusLoading] = useState(true);
  // Full onboarding detail for Users tab (current link, recipient, etc.)
  const [onboardingDetail, setOnboardingDetail] = useState<{
    isOnboarded: boolean;
    currentLink?: {
      status: string;
      recipientEmail?: string;
      recipientName?: string;
      createdDate?: string;
      expiresAt?: string;
    };
    completedDate?: string;
  } | null>(null);
  const [onboardingDetailLoading, setOnboardingDetailLoading] = useState(false);
  const [onboardingSendResendLoading, setOnboardingSendResendLoading] = useState(false);
  const [onboardingSendModalOpen, setOnboardingSendModalOpen] = useState(false);
  const [onboardingSendEmail, setOnboardingSendEmail] = useState('');
  const [onboardingSendFirstName, setOnboardingSendFirstName] = useState('');
  const [onboardingSendLastName, setOnboardingSendLastName] = useState('');
  const [onboardingSendLinkBaseUrl, setOnboardingSendLinkBaseUrl] = useState<string>('');

  // Link domain options for localhost (same as group users modal)
  const onboardingLinkBaseUrlOptions = React.useMemo(() => {
    if (typeof window === 'undefined') return [];
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    if (!isLocalhost) return [];
    const options: Array<{ label: string; value: string }> = [
      { label: `Current (${window.location.origin})`, value: window.location.origin },
      { label: 'Production (https://app.allaboard365.com)', value: 'https://app.allaboard365.com' },
    ];
    const tenantDomain = (group as any)?.TenantCustomDomain;
    if (tenantDomain && String(tenantDomain).trim().length > 0) {
      options.push({ label: `Tenant (https://${tenantDomain})`, value: `https://${tenantDomain}` });
    }
    return options;
  }, [group]);

  const onboardingDefaultLinkBaseUrl = React.useMemo(() => {
    if (onboardingLinkBaseUrlOptions.length === 0) return '';
    const tenantDomain = (group as any)?.TenantCustomDomain;
    if (tenantDomain && String(tenantDomain).trim().length > 0) return `https://${tenantDomain}`;
    return 'https://app.allaboard365.com';
  }, [onboardingLinkBaseUrlOptions, group]);

  // Get setup status directly from group data
  const setupStatus = (group as any)?.SetupStatus ? {
    isSetupComplete: (group as any).SetupStatus === 'Complete',
    steps: [], // We don't need detailed steps if setup is complete
    completionPercentage: (group as any).SetupStatus === 'Complete' ? 100 : 0
  } : {
    isSetupComplete: false,
    steps: [],
    completionPercentage: 0
  };

  // UTC date helpers so "1 day" = tomorrow (matches backend GETUTCDATE())
  const getUtcDateMidnight = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const parseUtcDate = (dateStr: string | null | undefined): number | null => {
    const datePart = (dateStr ?? '').split('T')[0];
    if (!datePart || datePart.length < 10) return null;
    const [y, m, d] = datePart.split('-').map(Number);
    if (isNaN(y) || isNaN(m) || isNaN(d)) return null;
    return Date.UTC(y, m - 1, d);
  };

  // Helper function to calculate enrollment effective date info (UTC calendar days so "1 day" = tomorrow)
  const getEnrollmentEffectiveDateInfo = (group: any) => {
    const todayUtc = getUtcDateMidnight(new Date());
    const earliestFutureUtc = parseUtcDate(group?.EarliestFutureEffectiveDate ?? null);
    const earliestActiveUtc = parseUtcDate(group?.EarliestActiveEffectiveDate ?? null);

    if (earliestFutureUtc == null) return null;
    const daysUntil = Math.round((earliestFutureUtc - todayUtc) / (1000 * 60 * 60 * 24));
    if (daysUntil < 0) return null;

    if (earliestActiveUtc != null) {
      const futureCount = group?.FutureEffectiveDateCount || 0;
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


  // Fetch monthly billing summary only when Details tab is active (defer to reduce initial load)
  React.useEffect(() => {
    if (activeTab !== TAB_INDICES.details || !groupId) return;
    const fetchMonthlySummary = async () => {
      try {
        setBillingLoading(true);
        const response = await GroupsService.getGroupMonthlySummary(groupId);
        if (response.success && response.data) {
          setMonthlyBillSummary(response.data);
        }
      } catch (error) {
        console.error('Error fetching monthly billing summary:', error);
      } finally {
        setBillingLoading(false);
      }
    };
    fetchMonthlySummary();
  }, [groupId, activeTab, TAB_INDICES.details]);

  // Check for failed payments to show notification badge
  React.useEffect(() => {
    const checkFailedPayments = async () => {
      if (!groupId) return;
      
      try {
        setPaymentNotificationLoading(true);
        const response = await apiService.get<ApiResponse<any[]>>(`/api/payments/group/${groupId}`);
        
        if (response.success && response.data) {
          // Only flag actual failure statuses (not pending/sent which are normal)
          const failureStatuses = ['Failed', 'Returned', 'Voided'];
          const recentPayments = response.data.slice(0, 5); // Check last 5 payments
          const hasRecentFailures = recentPayments.some((payment: any) => 
            payment.Status && failureStatuses.includes(payment.Status)
          );
          setHasFailedPayments(hasRecentFailures);
        }
      } catch (error) {
        console.error('Error checking failed payments:', error);
      } finally {
        setPaymentNotificationLoading(false);
      }
    };

    checkFailedPayments();
  }, [groupId]);

  // Check onboarding status (used for Users tab bar and Setup shortcut; Agent/TenantAdmin/SysAdmin/GroupAdmin)
  const checkOnboardingStatus = React.useCallback(async () => {
    if (!groupId || !canAccessOnboarding) {
      setOnboardingStatusLoading(false);
      return;
    }
    try {
      setOnboardingStatusLoading(true);
      const { GroupOnboardingService } = await import('../../services/group-onboarding.service');
      const response = await GroupOnboardingService.getOnboardingStatus(groupId);
      if (response.success && response.data) {
        setOnboardingStatus({ isOnboarded: response.data.isOnboarded || false });
      }
    } catch (error) {
      console.error('Error checking onboarding status:', error);
      setOnboardingStatus({ isOnboarded: false });
    } finally {
      setOnboardingStatusLoading(false);
    }
  }, [groupId, canAccessOnboarding]);

  React.useEffect(() => {
    checkOnboardingStatus();
  }, [checkOnboardingStatus]);

  // Fetch full onboarding detail when Users tab is active (for status + resend)
  const fetchOnboardingDetail = React.useCallback(async () => {
    if (!groupId || !canAccessOnboarding) return;
    try {
      setOnboardingDetailLoading(true);
      const { GroupOnboardingService } = await import('../../services/group-onboarding.service');
      const response = await GroupOnboardingService.getOnboardingStatus(groupId);
      if (response.success && response.data) {
        setOnboardingDetail(response.data);
      } else {
        setOnboardingDetail(null);
      }
    } catch (error) {
      console.error('Error fetching onboarding detail:', error);
      setOnboardingDetail(null);
    } finally {
      setOnboardingDetailLoading(false);
    }
  }, [groupId, canAccessOnboarding]);

  // Prefill send onboarding modal from primary contact and link domain when opened
  React.useEffect(() => {
    if (onboardingSendModalOpen && group) {
      const primaryEmail = group.AdminEmail || group.ContactEmail || '';
      const primaryName = (group.AdminName || group.PrimaryContact || '').trim();
      const nameParts = primaryName ? primaryName.split(/\s+/) : [];
      setOnboardingSendEmail(primaryEmail);
      setOnboardingSendFirstName(nameParts[0] || '');
      setOnboardingSendLastName(nameParts.slice(1).join(' ') || '');
      if (onboardingDefaultLinkBaseUrl) {
        setOnboardingSendLinkBaseUrl(onboardingDefaultLinkBaseUrl);
      }
    }
  }, [onboardingSendModalOpen, group, onboardingDefaultLinkBaseUrl]);

  const sendOnboardingLinkToRecipient = React.useCallback(async (email: string, firstName: string, lastName: string, linkBaseUrl?: string) => {
    if (!group?.GroupId || !canAccessOnboarding) return;
    const contactName = [firstName, lastName].filter(Boolean).join(' ').trim() || undefined;
    if (!email?.trim()) {
      showNotification('Email is required.', 'warning');
      return;
    }
    try {
      setOnboardingSendResendLoading(true);
      const { GroupOnboardingService } = await import('../../services/group-onboarding.service');
      const response = await GroupOnboardingService.createOnboardingLink(
        group.GroupId,
        true,
        email.trim(),
        contactName,
        linkBaseUrl?.trim() || undefined
      );
      if (response.success) {
        showNotification(
          onboardingDetail?.currentLink ? 'Onboarding link resent successfully.' : 'Onboarding link sent successfully.',
          'success'
        );
        setOnboardingSendModalOpen(false);
        checkOnboardingStatus();
        fetchOnboardingDetail();
      } else {
        showNotification(response.message || 'Failed to send onboarding link', 'error');
      }
    } catch (error) {
      showNotification(error instanceof Error ? error.message : 'Failed to send link', 'error');
    } finally {
      setOnboardingSendResendLoading(false);
    }
  }, [group?.GroupId, canAccessOnboarding, onboardingDetail?.currentLink, checkOnboardingStatus, fetchOnboardingDetail]);

  // Show notification helper
  const showNotification = (message: string, severity: NotificationSeverity = 'info', title?: string) => {
    setNotification({
      open: true,
      message,
      severity,
      title
    });
  };

  // Handle close notification
  const handleCloseNotification = (_event?: React.SyntheticEvent | Event, reason?: string) => {
    if (reason === 'clickaway') {
      return;
    }
    setNotification(prev => ({ ...prev, open: false }));
  };

  const goBack = () => {
    const path = window.location.pathname;
    const newPath = path.substring(0, path.lastIndexOf('/'));
    navigate(newPath);
  };

  const handleUpdateGroup = async (groupData: any) => {
    if (!group) return;
    try {
      // Create a copy of the data for modification
      let updatedData = {...groupData};
      
      // Group admins cannot reassign the group's agent from this UI; agents/agency can (backend validates assignability).
      // Use currentRole (not roles) so TenantAdmin/SysAdmin can update agent even if they also have Agent role.
      if (user?.currentRole === 'GroupAdmin') {
        console.log('🛡️ Removing agent fields for GroupAdmin');
        delete updatedData.AgentId;
        delete updatedData.AgentName;
        delete updatedData.AgentUserId;
        delete updatedData.agentId;
        console.log('🔒 Update payload after removing restricted fields:', updatedData);
      }
      
      // Handle logo upload first if there's a new logo file
      if (groupData.logoFile) {
        try {
          console.log('📤 Uploading logo file for group update');
          const uploadResponse = await GroupsService.uploadGroupLogo(group.GroupId, groupData.logoFile);
          
          if (uploadResponse.success && (uploadResponse.data as any)?.[0]?.url) {
            updatedData.logoUrl = (uploadResponse.data as any)[0].url;
            console.log('✅ Logo uploaded successfully for update:', (uploadResponse.data as any)[0].url);
          } else {
            console.error('❌ Logo upload failed:', uploadResponse.message);
            showNotification('Failed to upload logo', 'error');
            return;
          }
        } catch (error) {
          console.error('❌ Error uploading logo:', error);
          showNotification('Failed to upload logo', 'error');
          return;
        }
      }

      console.log('📋 Final update data before sending to backend:', updatedData);
      const result = await GroupsService.updateGroup(group.GroupId, updatedData);

      // Handle product updates if selectedProducts are provided
      if (groupData.selectedProducts && Array.isArray(groupData.selectedProducts)) {
        try {
          console.log('📦 Updating product assignments for group:', group.GroupId);
          
          // Get current products to determine what needs to be added/removed
          const currentProductsResponse = await GroupProductsService.getGroupProducts(group.GroupId);
          const currentProductIds = currentProductsResponse.success && currentProductsResponse.data?.groupProducts 
            ? currentProductsResponse.data.groupProducts
                .filter((gp: any) => gp.IsActive)
                .map((gp: any) => gp.ProductId)
            : [];
          
          const newProductIds = groupData.selectedProducts;
          
          // Create updates for products that need to be added
          const productsToAdd = newProductIds.filter((id: string) => !currentProductIds.includes(id));
          const productsToRemove = currentProductIds.filter((id: string) => !newProductIds.includes(id));
          
          const updates = [
            ...productsToAdd.map((productId: string) => ({ productId, IsAssigned: true })),
            ...productsToRemove.map((productId: string) => ({ productId, IsAssigned: false }))
          ];
          
          if (updates.length > 0) {
            await apiService.put(`/api/groups/${group.GroupId}/products`, { updates });
            console.log('✅ Successfully updated product assignments');
            // Re-adding a previously deleted product flips IsHidden=false on the
            // existing GroupProduct row; invalidate so the active list refetches and
            // the "Products with Active Enrollments" section drops the row.
            await queryClient.invalidateQueries({
              queryKey: ['groupProducts', group.GroupId],
            });
            await queryClient.invalidateQueries({
              queryKey: ['group-hidden-with-enrollments', group.GroupId],
            });
          }

          // Sync enrollment link templates for this group to the new product set
          const currentRole = user?.currentRole;
          if (currentRole && ['Agent', 'TenantAdmin', 'SysAdmin'].includes(currentRole)) {
            try {
              const { EnrollmentLinkTemplatesService } = await import('../../services/enrollment-link-templates.service');
              const syncRes = await EnrollmentLinkTemplatesService.syncGroupProducts(group.GroupId, newProductIds, currentRole);
              if (syncRes.success && (syncRes.data as any)?.updatedCount > 0) {
                console.log('✅ Synced enrollment link templates to group products:', (syncRes.data as any).updatedCount);
              }
            } catch (syncErr) {
              console.error('❌ Error syncing enrollment link templates:', syncErr);
              // Don't fail the group update
            }
          }
        } catch (productError) {
          console.error('❌ Error updating product assignments:', productError);
          // Don't fail the group update if product assignment fails
        }
      }

      // Persist vendor network selections (defaults => omit; null => clear).
      // We do this AFTER products so any newly added vendors have a valid link in oe.GroupProducts.
      if (groupData.vendorNetworkSelections && typeof groupData.vendorNetworkSelections === 'object') {
        try {
          await apiService.put(`/api/groups/${group.GroupId}/vendor-networks`, {
            selections: groupData.vendorNetworkSelections
          });
        } catch (vnErr) {
          console.error('❌ Error saving vendor network selections:', vnErr);
          // Non-fatal; surface as a soft warning so the group save itself succeeds
          showNotification('Group saved, but vendor network selections failed to persist.', 'warning');
        }
      }

      if (result.success) {
        setShowEditModal(false);
        refetch(); // Use refetch from the hook
        showNotification('Group updated successfully!', 'success');
      } else {
        showNotification(`Failed to update group: ${result.message || 'An unknown error occurred.'}`, 'error');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
      showNotification(`Error updating group: ${errorMessage}`, 'error');
    }
  };
  
  // Utility functions
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Active':
        return 'success';
      case 'Inactive':
        return 'error';
      case 'Pending':
        return 'warning';
      case 'Archived':
        return 'info';
      default:
        return 'info';
    }
  };

  // Format date in UTC to avoid timezone conversion issues
  const formatDateUTC = (dateString: string | null | undefined): string => {
    if (!dateString) {
      return 'N/A';
    }
    try {
      // Extract just the date part from ISO string (YYYY-MM-DD)
      const datePart = dateString.split('T')[0];
      // Parse as local date to avoid timezone shift
      const [year, month, day] = datePart.split('-').map(Number);
      
      // Validate the date components
      if (isNaN(year) || isNaN(month) || isNaN(day) || year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
        console.error('Invalid date components:', { year, month, day, dateString });
        return 'Invalid Date';
      }
      
      const date = new Date(year, month - 1, day);
      
      // Check if the date is valid
      if (isNaN(date.getTime())) {
        console.error('Invalid date created:', { year, month, day, dateString });
        return 'Invalid Date';
      }
      
      return format(date, 'MMM dd, yyyy');
    } catch (error) {
      console.error('Error formatting date:', error, dateString);
      return 'Invalid Date';
    }
  };

  // Safe date formatter that handles invalid dates
  const formatDateSafe = (dateString: string | null | undefined): string => {
    if (!dateString) {
      return 'N/A';
    }
    try {
      const date = new Date(dateString);
      if (isNaN(date.getTime())) {
        console.error('Invalid date string:', dateString);
        return 'Invalid Date';
      }
      return format(date, 'MMM dd, yyyy');
    } catch (error) {
      console.error('Error formatting date:', error, dateString);
      return 'Invalid Date';
    }
  };

  const handleEditGroup = () => {
    setEditProductsOnly(false);
    setShowEditModal(true);
  };

  const handleAddProductFromTab = () => {
    setEditProductsOnly(true);
    setShowEditModal(true);
  };

  const fetchNewGroupFormHistory = React.useCallback(async () => {
    if (!groupId) return;
    setNewGroupFormHistoryLoading(true);
    try {
      const res = await apiService.get<{ success: boolean; data?: Array<{ id: string; vendorId: string; vendorName: string; actionType: string; occurredAt: string; recipientEmail?: string; markedAsSent: boolean }> }>(`/api/groups/${groupId}/new-group-form/history`);
      const list = (res?.data && Array.isArray(res.data) ? res.data : []) as Array<{ id: string; vendorId: string; vendorName: string; actionType: string; occurredAt: string; recipientEmail?: string; markedAsSent: boolean }>;
      setNewGroupFormHistory(list.map((r) => ({ ...r, actionType: r.actionType as 'Download' | 'Email' })));
    } catch {
      setNewGroupFormHistory([]);
    } finally {
      setNewGroupFormHistoryLoading(false);
    }
  }, [groupId]);

  // Fetch vendors and history when new group form modal opens
  useEffect(() => {
    if (!showNewGroupFormModal || !groupId) return;
    let cancelled = false;
    setNewGroupFormVendorsLoading(true);
    apiService.get<{ success: boolean; data?: Array<{ VendorId: string; Id: string; VendorName: string; HasNewGroupFormConfig: boolean }> }>(`/api/groups/${groupId}/vendors`)
      .then((res) => {
        if (cancelled) return;
        const list = (res?.data && Array.isArray(res.data) ? res.data : []) as Array<{ VendorId: string; Id: string; VendorName: string; HasNewGroupFormConfig: boolean }>;
        const withForm = list.filter((v) => v.HasNewGroupFormConfig);
        setNewGroupFormVendors(withForm);
        setNewGroupFormEmailOverrides({});
      })
      .catch((err) => {
        if (!cancelled) setNewGroupFormVendors([]);
        console.error('Error fetching group vendors for new group form:', err);
      })
      .finally(() => {
        if (!cancelled) setNewGroupFormVendorsLoading(false);
      });
    fetchNewGroupFormHistory();
    return () => { cancelled = true; };
  }, [showNewGroupFormModal, groupId, fetchNewGroupFormHistory]);

  const openNewGroupFormReviewStep = async (vendorId: string) => {
    if (!groupId) return;
    setNewGroupFormPreviewVendorId(vendorId);
    setNewGroupFormPreviewLoading(true);
    setNewGroupFormPreviewData(null);
    setNewGroupFormEditedValues({});
    try {
      const res = await apiService.get<{ success: boolean; formTitle?: string; fields?: Array<{ key: string; label: string; value: string; missing: boolean; fieldType?: string; defaultValue?: string }>; vendorName?: string; defaultEmail?: string }>(`/api/groups/${groupId}/new-group-form/preview/${vendorId}`);
      if (res?.success && res?.fields) {
        setNewGroupFormPreviewData({
          formTitle: res.formTitle || 'New Group Form',
          fields: res.fields,
          vendorName: res.vendorName || 'Vendor'
        });
        const initial: Record<string, string> = {};
        res.fields.forEach((f, index) => {
          const val = (f.value != null && String(f.value).trim() !== '') ? String(f.value).trim() : '';
          const next = val || (f.defaultValue ?? '');
          if (f.fieldType === 'labelHeader') return;
          initial[getNewGroupFormFieldStateKey(f, index)] = next;
        });
        setNewGroupFormEditedValues(initial);
        setNewGroupFormEmailOverrides((prev) => ({
          ...prev,
          [vendorId]: (res.defaultEmail ?? prev[vendorId] ?? '').trim()
        }));
        setNewGroupFormStep('review');
      } else {
        showNotification('Failed to load form preview', 'error');
      }
    } catch (e) {
      showNotification((e as any)?.response?.data?.message || (e as Error)?.message || 'Failed to load preview', 'error');
    } finally {
      setNewGroupFormPreviewLoading(false);
    }
  };

  const handleCertificationSign = async (signatureData: string) => {
    if (!groupId || !signModalRole) return;
    setSignSubmitting(true);
    try {
      const path = signModalRole === 'agent'
        ? `/api/groups/${groupId}/new-group-form/certification/agent`
        : `/api/groups/${groupId}/new-group-form/certification/group-admin`;
      await apiService.post(path, { signatureData });
      await refetchCertification();
      setSignModalRole(null);
      showNotification('Signature saved.', 'success');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string }; status?: number } })?.response?.data?.message || (err as Error)?.message || 'Failed to save signature';
      showNotification(msg, 'error');
    } finally {
      setSignSubmitting(false);
    }
  };

  const formatCertDate = (iso: string | null) => {
    if (!iso) return null;
    try {
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, { dateStyle: 'medium' });
    } catch {
      return iso;
    }
  };

  const handleGenerateNewGroupFormPdf = async () => {
    if (!groupId || !newGroupFormPreviewVendorId) return;
    setNewGroupFormDownloading(true);
    try {
      const response = await apiService.post<Blob>(`/api/groups/${groupId}/new-group-form/generate/${newGroupFormPreviewVendorId}`, { fieldOverrides: buildNewGroupFormOverridesPayload(), format: 'pdf' }, { responseType: 'blob' });
      const blob = response instanceof Blob ? response : (response as any)?.data;
      if (!blob) throw new Error('No PDF returned');
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const safeName = (group?.Name || 'Group').replace(/[^a-zA-Z0-9]/g, '_');
      const safeVendor = (newGroupFormPreviewData?.vendorName || 'Vendor').replace(/[^a-zA-Z0-9]/g, '_');
      link.download = `NewGroupForm-${safeName}-${safeVendor}.pdf`;
      link.click();
      window.URL.revokeObjectURL(url);
      showNotification('Download started', 'success');
      fetchNewGroupFormHistory();
    } catch (e) {
      showNotification((e as Error)?.message || 'Download failed', 'error');
    } finally {
      setNewGroupFormDownloading(false);
    }
  };

  const handleGenerateNewGroupFormTxt = async () => {
    if (!groupId || !newGroupFormPreviewVendorId) return;
    setNewGroupFormDownloadingTxt(true);
    try {
      const response = await apiService.post<Blob>(`/api/groups/${groupId}/new-group-form/generate/${newGroupFormPreviewVendorId}`, { fieldOverrides: buildNewGroupFormOverridesPayload(), format: 'txt' }, { responseType: 'blob' });
      const blob = response instanceof Blob ? response : (response as any)?.data;
      if (!blob) throw new Error('No file returned');
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const safeName = (group?.Name || 'Group').replace(/[^a-zA-Z0-9]/g, '_');
      const safeVendor = (newGroupFormPreviewData?.vendorName || 'Vendor').replace(/[^a-zA-Z0-9]/g, '_');
      link.download = `NewGroupForm-${safeName}-${safeVendor}.txt`;
      link.click();
      window.URL.revokeObjectURL(url);
      showNotification('Download started', 'success');
      fetchNewGroupFormHistory();
    } catch (e) {
      showNotification((e as Error)?.message || 'Download failed', 'error');
    } finally {
      setNewGroupFormDownloadingTxt(false);
    }
  };

  const handleSendNewGroupFormEmailFromReview = async () => {
    if (!groupId || !newGroupFormPreviewVendorId) return;
    setNewGroupFormSending(newGroupFormPreviewVendorId);
    try {
      const recipientEmail = newGroupFormEmailOverrides[newGroupFormPreviewVendorId]?.trim() || undefined;
      await apiService.post(`/api/groups/${groupId}/new-group-form/send-email`, { vendorId: newGroupFormPreviewVendorId, recipientEmail, fieldOverrides: buildNewGroupFormOverridesPayload() });
      showNotification('Email sent successfully', 'success');
      setShowSendEmailModal(false);
      fetchNewGroupFormHistory();
    } catch (e) {
      showNotification((e as any)?.response?.data?.message || (e as Error)?.message || 'Send failed', 'error');
    } finally {
      setNewGroupFormSending(null);
    }
  };

  const handleNewGroupFormHistoryMarkSent = async (historyId: string, markedAsSent: boolean) => {
    if (!groupId) return;
    setNewGroupFormHistoryPatching(historyId);
    try {
      await apiService.patch(`/api/groups/${groupId}/new-group-form/history/${historyId}`, { markedAsSent });
      setNewGroupFormHistory((prev) => prev.map((h) => (h.id === historyId ? { ...h, markedAsSent } : h)));
    } catch {
      showNotification('Failed to update sent status', 'error');
    } finally {
      setNewGroupFormHistoryPatching(null);
    }
  };

  const handleNewGroupFormHistoryDelete = async (historyId: string) => {
    if (!groupId) return;
    setNewGroupFormHistoryDeleting(historyId);
    setNewGroupFormHistoryDeleteConfirmId(null);
    try {
      await apiService.delete(`/api/groups/${groupId}/new-group-form/history/${historyId}`);
      setNewGroupFormHistory((prev) => prev.filter((h) => h.id !== historyId));
      showNotification('History entry removed.', 'success');
    } catch {
      showNotification('Failed to delete history entry', 'error');
    } finally {
      setNewGroupFormHistoryDeleting(null);
    }
  };

  const handleNewGroupFormHistoryRedownload = async (h: { id: string; vendorId: string; vendorName: string }) => {
    if (!groupId) return;
    setNewGroupFormHistoryDownloading(h.id);
    try {
      const response = await apiService.post<Blob>(`/api/groups/${groupId}/new-group-form/generate/${h.vendorId}`, { fieldOverrides: {}, format: 'pdf' }, { responseType: 'blob' });
      const blob = response instanceof Blob ? response : (response as any)?.data;
      if (!blob) throw new Error('No PDF returned');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(group?.GroupName || 'group').replace(/[^a-zA-Z0-9-_]/g, '-')}-${h.vendorName.replace(/[^a-zA-Z0-9-_]/g, '-')}-form.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      showNotification('PDF downloaded.', 'success');
    } catch {
      showNotification('Failed to re-download form', 'error');
    } finally {
      setNewGroupFormHistoryDownloading(null);
    }
  };

  const handleConfirmRestoreGroup = async () => {
    if (!group?.GroupId) return;
    setRestoreLoading(true);
    try {
      const result = await GroupsService.restoreGroup(group.GroupId);
      if (result.success) {
        setShowRestoreDialog(false);
        await queryClient.invalidateQueries({ queryKey: ['groups'] });
        await queryClient.invalidateQueries({ queryKey: ['groupDetails', group.GroupId] });
        await refetch();
        showNotification(result.message || 'Group restored successfully.', 'success');
      } else {
        showNotification(result.message || 'Failed to restore group.', 'error');
      }
    } catch (error) {
      const err = error as { response?: { data?: { message?: string } }; message?: string };
      const message = err?.response?.data?.message || err?.message || 'An unexpected error occurred.';
      showNotification(message, 'error');
    } finally {
      setRestoreLoading(false);
    }
  };

  const handleConfirmDeleteGroup = async () => {
    if (!group?.GroupId) return;
    setDeleteLoading(true);
    try {
      const result = await GroupsService.deleteGroup(group.GroupId);
      if (result.success) {
        setShowDeleteDialog(false);
        setTerminationPreview(null);
        setTerminationPreviewError(null);
        queryClient.invalidateQueries({ queryKey: ['groups'] });
        queryClient.invalidateQueries({ queryKey: ['groupDetails', group.GroupId] });
        showNotification(result.message || 'Group terminated successfully.', 'success');
        goBack();
      } else {
        showNotification(result.message || 'Failed to remove group.', 'error');
      }
    } catch (error) {
      const err = error as { response?: { data?: { message?: string } }; message?: string };
      const message = err?.response?.data?.message || err?.message || 'An unexpected error occurred.';
      showNotification(message, 'error');
    } finally {
      setDeleteLoading(false);
    }
  };

  // Onboarding incomplete: show bar on Users tab and ! on tab (Agent/TenantAdmin/SysAdmin/GroupAdmin)
  const onboardingIncomplete = canAccessOnboarding && onboardingStatus && !onboardingStatus.isOnboarded && !onboardingStatusLoading;

  // Fetch full onboarding detail when Users tab is active (for status + resend)
  React.useEffect(() => {
    if (activeTab === TAB_INDICES.users && canAccessOnboarding && groupId) {
      fetchOnboardingDetail();
    }
  }, [activeTab, canAccessOnboarding, groupId, fetchOnboardingDetail]);

  // Map tab index to hash name (accounting for dynamic tab indices)
  const getHashFromTabIndex = (index: number): string => {
    return TAB_ORDER[index] || 'setup';
  };
  
  // Update hash when tab changes (but not when hash changes to prevent loops)
  useEffect(() => {
    const hashName = getHashFromTabIndex(activeTab);
    const currentHash = location.hash.replace('#', '');
    // Only update hash if it's different from what we're setting
    if (hashName && currentHash !== hashName) {
      isInternalHashUpdate.current = true;
      window.history.replaceState(null, '', `${location.pathname}#${hashName}`);
      // Reset the flag after a short delay to allow hash change to propagate
      setTimeout(() => {
        isInternalHashUpdate.current = false;
      }, 0);
    }
  }, [activeTab, location.pathname]);
  
  // Update active tab when hash changes externally (e.g., browser back/forward or direct navigation)
  useEffect(() => {
    // Skip if this is our own hash update
    if (isInternalHashUpdate.current) {
      return;
    }
    
    const hash = location.hash.replace('#', '');
    if (hash) {
      const targetIndex = TAB_INDICES[hash as keyof typeof TAB_INDICES];
      if (targetIndex !== undefined && targetIndex !== -1) {
        setActiveTab(targetIndex);
      }
    }
  }, [location.hash]); // Only depend on hash, not activeTab, to prevent loops

  const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
    setActiveTab(newValue);
  };

  // Update active tab when setup status changes
  React.useEffect(() => {
    if (setupStatus.isSetupComplete !== undefined && !setupStatus.isSetupComplete && activeTab === TAB_INDICES.setup) {
      // Keep on setup tab if not complete
    }
  }, [setupStatus.isSetupComplete, activeTab]);


  // Show loading spinner while fetching group data (optional - can be removed for faster UX)
  // if (loading) {
  //   return (
  //     <Box sx={{ p: 3, display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '400px' }}>
  //       <Stack alignItems="center" spacing={2}>
  //         <CircularProgress size={40} />
  //         <Typography variant="body1" color="text.secondary">
  //           Loading group information...
  //         </Typography>
  //       </Stack>
  //     </Box>
  //   );
  // }

  // Show error if no tenant ID could be retrieved
  if (!user && !loading) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="error" sx={{ borderRadius: 2 }}>
          Unable to retrieve tenant information. Please refresh the page or contact support.
        </Alert>
        <Button
          onClick={goBack}
          variant="contained"
          sx={{ 
            mt: 2, 
            textTransform: 'none',
            bgcolor: 'var(--oe-primary)',
            '&:hover': {
              bgcolor: 'var(--oe-primary-dark)',
            },
          }}
        >
          Back to Groups
        </Button>
      </Box>
    );
  }

  if (loading || isResolvingSlug) {
    return (
      <Box sx={{ p: 3 }}>
        <Grid container spacing={3}>
          <Grid size={12}>
            <Skeleton variant="rectangular" height={60} sx={{ borderRadius: 2 }} />
          </Grid>
          <Grid size={12}>
            <Skeleton variant="rectangular" height={200} sx={{ borderRadius: 2 }} />
          </Grid>
          <Grid size={12}>
            <Skeleton variant="rectangular" height={400} sx={{ borderRadius: 2 }} />
          </Grid>
        </Grid>
      </Box>
    );
  }

  const errorToDisplay = fetchError ? (fetchError as Error).message : null;

  if (isError || !group) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert 
          severity="error" 
          sx={{ 
            borderRadius: 2,
            mb: 2,
          }}
        >
          {errorToDisplay || 'Group not found'}
        </Alert>
        <Button
          onClick={goBack}
          variant="contained"
          sx={{ 
            textTransform: 'none',
            bgcolor: 'var(--oe-primary)',
            '&:hover': {
              bgcolor: 'var(--oe-primary-dark)',
            },
          }}
        >
          Back
        </Button>
      </Box>
    );
  }

  return (
    <Box sx={{ width: '100%', height: '100%' }} style={{ zoom: '80%' }}>
      <Box sx={{ p: 3 }}>
      {group.Status === 'Archived' && (
        <Alert severity="warning" sx={{ borderRadius: 2, mb: 2 }}>
          <AlertTitle>Removed group</AlertTitle>
          This group has been removed from your active list. You can still review details and history below.
        </Alert>
      )}
      {/* Header */}
      <Grid container spacing={3} sx={{ mb: 3 }}>
        <Grid size={12}>
          
          <Grid container alignItems="center" justifyContent="space-between">
            <Grid size={{ xs: 12, md: 'grow' }}>
              <Stack direction="row" alignItems="center" spacing={2} sx={{ flexWrap: 'wrap', rowGap: 1, minWidth: 0 }}>
                {!hideBackButton && (
                  <Tooltip title="Back to Groups">
                    <IconButton 
                      onClick={goBack}
                      sx={{
                        bgcolor: alpha(colors.primary, 0.1),
                        '&:hover': {
                          bgcolor: alpha(colors.primary, 0.2),
                        },
                      }}
                    >
                      <ArrowBackIcon />
                    </IconButton>
                  </Tooltip>
                )}
                
                {/* Group Logo */}
                <Box
                  sx={{
                    width: 64,
                    height: 64,
                    borderRadius: 2,
                    border: `2px solid ${theme.palette.divider}`,
                    overflow: 'hidden',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    bgcolor: alpha(colors.primary, 0.05),
                    flexShrink: 0,
                  }}
                >
                  {group.LogoUrl ? (
                    <img 
                      src={group.LogoUrl} 
                      alt={`${group.Name} logo`}
                      style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'contain',
                        padding: '8px',
                      }}
                      onError={(e) => {
                        console.error('🔍 Group logo failed to load:', group.LogoUrl);
                        e.currentTarget.style.display = 'none';
                        const nextElement = e.currentTarget.nextElementSibling as HTMLElement;
                        if (nextElement) {
                          nextElement.style.display = 'flex';
                        }
                      }}
                    />
                  ) : null}
                  <Box
                    sx={{
                      display: group.LogoUrl ? 'none' : 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: '100%',
                      height: '100%',
                    }}
                  >
                    <BusinessIcon sx={{ fontSize: '2rem', color: alpha(colors.primary, 0.6) }} />
                  </Box>
                </Box>

                <Box sx={{ minWidth: 0 }}>
                  <Stack direction="row" alignItems="center" flexWrap="wrap" gap={1} sx={{ rowGap: 0.5 }}>
                    <Typography variant="h4" sx={{ fontWeight: 700, color: theme.palette.text.primary, wordBreak: 'break-word' }}>
                      {group.Name}
                    </Typography>
                    {group.Status === 'Archived' && (
                      <Chip label="Removed" color="warning" sx={{ fontWeight: 700 }} />
                    )}
                  </Stack>
                  {group.GroupType === 'ListBill' && (
                    <Box sx={{ mt: 0.75 }}>
                      <GroupBadge type="ListBill" size="md" />
                    </Box>
                  )}
                  {(group.IsPendingMigration || group.IsE123Migrated) && (
                    <Box sx={{ mt: 0.75 }}>
                      <PendingMigrationBadge
                        size="md"
                        isE123Migrated={Boolean(group.IsE123Migrated)}
                        pendingMemberCount={group.PendingMigrationMemberCount ?? 0}
                      />
                    </Box>
                  )}
                </Box>
                {(() => {
                  const effectiveDateInfo = getEnrollmentEffectiveDateInfo(group);
                  const chips: React.ReactNode[] = [];
                  if (effectiveDateInfo && effectiveDateInfo.text) {
                    chips.push(
                      <Chip
                        key="eff"
                        icon={<EventIcon />}
                        label={effectiveDateInfo.text}
                        sx={{
                          fontWeight: 600,
                          background: effectiveDateInfo.days <= 7 
                            ? 'linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)'
                            : effectiveDateInfo.days <= 30
                            ? 'linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%)'
                            : 'linear-gradient(135deg, #e0e7ff 0%, #c7d2fe 100%)',
                          color: effectiveDateInfo.days <= 7 
                            ? '#92400e'
                            : effectiveDateInfo.days <= 30
                            ? '#1e40af'
                            : '#4338ca',
                          border: `1px solid ${effectiveDateInfo.days <= 7 ? '#fbbf24' : effectiveDateInfo.days <= 30 ? '#60a5fa' : '#818cf8'}`,
                          boxShadow: effectiveDateInfo.days <= 7 
                            ? '0 2px 4px rgba(245, 158, 11, 0.2)'
                            : effectiveDateInfo.days <= 30
                            ? '0 2px 4px rgba(37, 99, 235, 0.15)'
                            : '0 2px 4px rgba(99, 102, 241, 0.15)',
                          '&:hover': {
                            boxShadow: effectiveDateInfo.days <= 7 
                              ? '0 4px 8px rgba(245, 158, 11, 0.3)'
                              : effectiveDateInfo.days <= 30
                              ? '0 4px 8px rgba(37, 99, 235, 0.25)'
                              : '0 4px 8px rgba(99, 102, 241, 0.25)',
                            transform: 'translateY(-1px)',
                          },
                          transition: 'all 0.2s ease',
                        }}
                      />
                    );
                  }
                  if (group.Status !== 'Active' && group.Status !== 'Archived') {
                    chips.push(
                      <Chip
                        key="st"
                        label={group.Status}
                        color={getStatusColor(group.Status) as any}
                        sx={{ fontWeight: 600 }}
                      />
                    );
                  }
                  if (chips.length === 0) return null;
                  return (
                    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ alignItems: 'center' }}>
                      {chips}
                    </Stack>
                  );
                })()}
              </Stack>
            </Grid>
            <Grid size={{ xs: 12, md: 'auto' }}>
              <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
                {user?.currentRole !== 'GroupAdmin' && (
                  <Button
                    variant="contained"
                    fullWidth
                    startIcon={<EditIcon />}
                    disabled={group.Status === 'Archived'}
                    onClick={handleEditGroup}
                    sx={{
                      textTransform: 'none',
                      fontWeight: 600,
                      borderRadius: 2,
                      px: 3,
                      py: 1.5,
                      bgcolor: 'var(--oe-primary)',
                      '&:hover': { bgcolor: 'var(--oe-primary-dark)' }
                    }}
                  >
                    Edit Group
                  </Button>
                )}
                {canDeleteGroup && group.Status === 'Archived' && user?.currentRole !== 'GroupAdmin' && (
                  <Button
                    variant="outlined"
                    fullWidth
                    color="success"
                    onClick={() => setShowRestoreDialog(true)}
                    sx={{
                      textTransform: 'none',
                      fontWeight: 600,
                      borderRadius: 2,
                      px: 3,
                      py: 1.5
                    }}
                  >
                    Restore group
                  </Button>
                )}
              </Stack>
            </Grid>
          </Grid>
        </Grid>
      </Grid>


      {/* Approved type-change request awaiting wizard run (agent-only) */}
      {pendingTypeChange && (
        <div className="mb-4 p-4 bg-red-50 border border-red-300 rounded-lg flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-red-800">
              Conversion approved — finish in the wizard
            </h3>
            <p className="mt-1 text-sm text-red-700">
              Your request to change <strong>{pendingTypeChange.GroupName}</strong> from{' '}
              <strong>{pendingTypeChange.CurrentType}</strong> to{' '}
              <strong>{pendingTypeChange.RequestedType}</strong> has been approved.
              Members aren't moved until you run the conversion wizard.
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate(`${buildGroupDetailPath(user?.currentRole, {
              GroupId: pendingTypeChange.GroupId,
              AllAboardMasterGroupId: group?.AllAboardMasterGroupId,
            })}/type-change/wizard`)}
            className="flex-shrink-0 px-4 py-2 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg transition-colors"
          >
            Continue to wizard
          </button>
        </div>
      )}

      {/* Tabs */}
      <Paper
        sx={{
          borderRadius: 2,
          border: `1px solid ${theme.palette.divider}`,
          overflow: 'hidden',
        }}
      >
        <Tabs
          value={activeTab}
          onChange={handleTabChange}
          indicatorColor="primary"
          textColor="primary"
          variant="scrollable"
          scrollButtons="auto"
          allowScrollButtonsMobile
          TabIndicatorProps={{
            style: { display: 'none' } // Hide default JS-calculated indicator
          }}
          sx={{
            borderBottom: `1px solid ${theme.palette.divider}`,
            bgcolor: alpha(colors.primary, 0.02),
            '& .MuiTabs-flexContainer': {
              gap: 0,
            },
            '& .MuiTab-root': {
              textTransform: 'none',
              fontWeight: 500,
              minHeight: 64,
              borderBottom: '2px solid transparent', // Default border
              '&.Mui-selected': {
                fontWeight: 600,
                color: 'var(--oe-primary)',
                borderBottom: '2px solid var(--oe-primary)', // CSS-based active border that respects zoom
              },
            },
          }}
        >
        {/* Setup Tab - Always show */}
        <Tab
          icon={<ChecklistIcon />}
          iconPosition="start"
          label="Setup"
          id={`group-tab-${TAB_INDICES.setup}`}
          aria-controls={`group-tabpanel-${TAB_INDICES.setup}`}
        />
          <Tab
            icon={<BusinessIcon />}
            iconPosition="start"
            label="Details"
            id={`group-tab-${TAB_INDICES.details}`}
            aria-controls={`group-tabpanel-${TAB_INDICES.details}`}
          />
          <Tab
            icon={<PeopleIcon />}
            iconPosition="start"
            label="Members"
            id={`group-tab-${TAB_INDICES.members}`}
            aria-controls={`group-tabpanel-${TAB_INDICES.members}`}
          />
          <Tab
            icon={<ProductsIcon />}
            iconPosition="start"
            label="Products"
            id={`group-tab-${TAB_INDICES.products}`}
            aria-controls={`group-tabpanel-${TAB_INDICES.products}`}
          />
          <Tab
            icon={<ContributionsIcon />}
            iconPosition="start"
            label="Contributions"
            id={`group-tab-${TAB_INDICES.contributions}`}
            aria-controls={`group-tabpanel-${TAB_INDICES.contributions}`}
          />
          <Tab
            icon={
              <div className="relative">
                <BillingIcon />
                {hasFailedPayments && !paymentNotificationLoading && (
                  <span className="absolute -top-1 -right-1 h-3 w-3 bg-red-500 rounded-full flex items-center justify-center">
                    <span className="text-white text-xs font-bold">!</span>
                  </span>
                )}
              </div>
            }
            iconPosition="start"
            label="Billing"
            id={`group-tab-${TAB_INDICES.billing}`}
            aria-controls={`group-tabpanel-${TAB_INDICES.billing}`}
          />
          <Tab
            icon={<LocationIcon />}
            iconPosition="start"
            label="Locations"
            id={`group-tab-${TAB_INDICES.locations}`}
            aria-controls={`group-tabpanel-${TAB_INDICES.locations}`}
          />
          <Tab
            icon={<DocumentsIcon />}
            iconPosition="start"
            label="Documents"
            id={`group-tab-${TAB_INDICES.documents}`}
            aria-controls={`group-tabpanel-${TAB_INDICES.documents}`}
          />
          {/* Vendors tab - only TenantAdmin and SysAdmin; Agent/GroupAdmin sign from Details tab */}
          {showVendorsTab && (
            <Tab
              icon={<TagIcon />}
              iconPosition="start"
              label="Vendors"
              id={`group-tab-${TAB_INDICES.groupIds}`}
              aria-controls={`group-tabpanel-${TAB_INDICES.groupIds}`}
            />
          )}
          {/* Users Tab - show for Agent/TenantAdmin/SysAdmin/GroupAdmin */}
          {showUsersTab && (
            <Tab
              icon={<UsersIcon />}
              iconPosition="start"
              label="Users"
              id={`group-tab-${TAB_INDICES.users}`}
              aria-controls={`group-tabpanel-${TAB_INDICES.users}`}
            />
          )}
          {/* Settings Tab - Only show for authorized roles */}
          {canAccessEligibilityRules && (
            <Tab
              icon={<RuleIcon />}
              iconPosition="start"
              label="Settings"
              id={`group-tab-${TAB_INDICES.settings}`}
              aria-controls={`group-tabpanel-${TAB_INDICES.settings}`}
            />
          )}
          {/* Advanced Tab - TenantAdmin and SysAdmin only */}
          {showAdvancedTab && (
            <Tab
              icon={<SlidersHorizontal size={20} />}
              iconPosition="start"
              label="Advanced"
              id={`group-tab-${TAB_INDICES.advanced}`}
              aria-controls={`group-tabpanel-${TAB_INDICES.advanced}`}
            />
          )}
        </Tabs>

        {/* Tab Panels */}
        {/* Setup Tab Panel - Always show */}
        <TabPanel value={activeTab} index={TAB_INDICES.setup}>
          {group && groupId ? (
            <GroupSetupTab 
              groupId={groupId} 
              groupName={group.Name} 
              groupData={group}
              onTabChange={setActiveTab}
              setupStatus={(group as any).SetupStatus}
              isActive={activeTab === TAB_INDICES.setup}
              onboardingIncomplete={!!onboardingIncomplete}
              onGoToUsersForOnboarding={() => setActiveTab(TAB_INDICES.users)}
              onEditGroup={handleEditGroup}
            getTabIndexForStep={(stepId: string) => {
              // Map step IDs from useGroupSetupStatus to tab indices (must match TAB_ORDER)
              const tabMap: Record<string, number> = {
                'asaSigning': TAB_INDICES.products,
                'banking': TAB_INDICES.billing,
                'billing': TAB_INDICES.billing,
                'members': TAB_INDICES.members,
                'enrollments': TAB_INDICES.members,
                'products': TAB_INDICES.products,
                'contributions': TAB_INDICES.contributions,
                'contributionRules': TAB_INDICES.contributions,
                'locations': TAB_INDICES.locations,
                'documents': TAB_INDICES.documents,
                'onboarding': TAB_INDICES.users ?? TAB_INDICES.setup,
                'businessInfo': TAB_INDICES.details,
                'eligibilityRules': TAB_INDICES.settings ?? TAB_INDICES.setup
              };
              const index = tabMap[stepId] ?? TAB_INDICES.setup;
              const safeIndex = typeof index === 'number' && index >= 0 ? index : TAB_INDICES.setup;
              return safeIndex;
            }}
            />
          ) : (
            <Box sx={{ p: 3, display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '400px' }}>
              <CircularProgress />
            </Box>
          )}
        </TabPanel>

        {/* Details Tab Panel */}
        <TabPanel value={activeTab} index={TAB_INDICES.details}>
          {/* Group Information - moved from above */}
          <Card sx={{ borderRadius: 2, border: `1px solid ${theme.palette.divider}` }}>
            <CardContent sx={{ p: 3 }}>
              <Typography variant="h6" sx={{ fontWeight: 600, mb: 3 }}>
                Group Information
              </Typography>
              
              <Grid container spacing={4}>
                {/* Basic Information */}
                <Grid size={{ xs: 12, md: 4 }}>
                  <Stack spacing={2}>
                    <Box>
                      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                        <BusinessIcon sx={{ color: 'var(--oe-primary)' }} />
                        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                          Basic Information
                        </Typography>
                      </Stack>
                      <Divider sx={{ mb: 2 }} />
                      <Stack spacing={1.5}>
                        <Box>
                          <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                            EIN
                          </Typography>
                          <Typography variant="body2" sx={{ fontWeight: 500 }}>
                            {group.TaxIdNumber || 'Not provided'}
                          </Typography>
                        </Box>
                        <Box>
                          <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                            Status
                          </Typography>
                          <Box sx={{ mt: 0.5 }}>
                            {(() => {
                              const effectiveDateInfo = getEnrollmentEffectiveDateInfo(group);
                              if (effectiveDateInfo && effectiveDateInfo.text) {
                                return (
                                  <Chip
                                    icon={<EventIcon sx={{ fontSize: '0.875rem' }} />}
                                    label={effectiveDateInfo.text}
                                    size="small"
                                    sx={{
                                      fontWeight: 500,
                                      background: effectiveDateInfo.days <= 7 
                                        ? 'linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)'
                                        : effectiveDateInfo.days <= 30
                                        ? 'linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%)'
                                        : 'linear-gradient(135deg, #e0e7ff 0%, #c7d2fe 100%)',
                                      color: effectiveDateInfo.days <= 7 
                                        ? '#92400e'
                                        : effectiveDateInfo.days <= 30
                                        ? '#1e40af'
                                        : '#4338ca',
                                      border: `1px solid ${effectiveDateInfo.days <= 7 ? '#fbbf24' : effectiveDateInfo.days <= 30 ? '#60a5fa' : '#818cf8'}`,
                                      boxShadow: effectiveDateInfo.days <= 7 
                                        ? '0 1px 3px rgba(245, 158, 11, 0.2)'
                                        : effectiveDateInfo.days <= 30
                                        ? '0 1px 3px rgba(37, 99, 235, 0.15)'
                                        : '0 1px 3px rgba(99, 102, 241, 0.15)',
                                    }}
                                  />
                                );
                              }
                              // Only show inactive status if group is inactive
                              if (group.Status !== 'Active') {
                                return (
                                  <Chip
                                    label={group.Status}
                                    color={getStatusColor(group.Status) as any}
                                    size="small"
                                    sx={{ fontWeight: 500 }}
                                  />
                                );
                              }
                              return null;
                            })()}
                          </Box>
                        </Box>
                        <Box>
                          <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                            Created Date
                          </Typography>
                          <Typography variant="body2" sx={{ fontWeight: 500 }}>
                            {formatDateSafe(group.CreatedDate)}
                          </Typography>
                        </Box>
                      </Stack>
                    </Box>
                  </Stack>
                </Grid>
                
                {/* Primary Contact */}
                <Grid size={{ xs: 12, md: 4 }}>
                  <Stack spacing={2}>
                    <Box>
                      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                        <PeopleIcon sx={{ color: 'var(--oe-primary)' }} />
                        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                          Primary Contact
                        </Typography>
                      </Stack>
                      <Divider sx={{ mb: 2 }} />
                      <Stack spacing={1.5}>
                        <Box>
                          <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                            Administrator
                          </Typography>
                          <Typography variant="body2" sx={{ fontWeight: 500 }}>
                            {group.AdminName || group.PrimaryContact || 'Not assigned'}
                          </Typography>
                        </Box>
                        {(group.AdminEmail || group.ContactEmail) && (
                          <Box>
                            <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                              Email
                            </Typography>
                            <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 0.5 }}>
                              <EmailIcon sx={{ fontSize: '1rem', color: theme.palette.text.secondary }} />
                              <Typography variant="body2" sx={{ color: 'var(--oe-primary)' }}>
                                {group.AdminEmail || group.ContactEmail}
                              </Typography>
                            </Stack>
                          </Box>
                        )}
                        {(group.AdminPhone || group.ContactPhone) && (() => {
                          const phoneNumber = group.AdminPhone || group.ContactPhone || '';
                          const formattedPhone = formatPhoneNumber(phoneNumber);
                          return formattedPhone ? (
                            <Box>
                              <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                                Phone
                              </Typography>
                              <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 0.5 }}>
                                <PhoneIcon sx={{ fontSize: '1rem', color: theme.palette.text.secondary }} />
                                <Typography variant="body2" sx={{ color: 'var(--oe-primary)' }}>
                                  {formattedPhone}
                                </Typography>
                              </Stack>
                            </Box>
                          ) : null;
                        })()}
                      </Stack>
                    </Box>
                  </Stack>
                </Grid>
                
                {/* Agent Information */}
                {group.AgentId && (
                  <Grid size={{ xs: 12, md: 4 }}>
                    <Stack spacing={2}>
                      <Box>
                        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                          <BusinessIcon sx={{ color: 'var(--oe-primary)' }} />
                          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                            Agent
                          </Typography>
                        </Stack>
                        <Divider sx={{ mb: 2 }} />
                        <Stack spacing={1.5}>
                          <Box>
                            <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                              Agent Name
                            </Typography>
                            <Typography variant="body2" sx={{ fontWeight: 600, color: 'var(--oe-primary)' }}>
                              {group.AgentName || 'Agent Member'}
                            </Typography>
                          </Box>
                          {(group as any).AgentCode && (
                            <Box>
                              <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                                Agent ID
                              </Typography>
                              <Typography variant="body2" sx={{ fontFamily: 'monospace', color: theme.palette.text.primary }}>
                                {(group as any).AgentCode}
                              </Typography>
                            </Box>
                          )}
                          {((group as any).AgentEmail || (group as any).AgentUserEmail) && (
                            <Box>
                              <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                                Email
                              </Typography>
                              <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 0.5 }}>
                                <EmailIcon sx={{ fontSize: '1rem', color: theme.palette.text.secondary }} />
                                <Typography variant="body2" sx={{ color: 'var(--oe-primary)' }}>
                                  {(group as any).AgentEmail || (group as any).AgentUserEmail}
                                </Typography>
                              </Stack>
                            </Box>
                          )}
                          {(group as any).AgentPhone && (
                            <Box>
                              <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                                Phone
                              </Typography>
                              <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 0.5 }}>
                                <PhoneIcon sx={{ fontSize: '1rem', color: theme.palette.text.secondary }} />
                                <Typography variant="body2" sx={{ color: 'var(--oe-primary)' }}>
                                  {formatPhoneNumber((group as any).AgentPhone)}
                                </Typography>
                              </Stack>
                            </Box>
                          )}
                        </Stack>
                      </Box>
                    </Stack>
                  </Grid>
                )}

                {/* Group Info Confirmation — only when at least one vendor form for this group has signature fields */}
                {certification?.signaturesRequired === true && (
                <Grid size={{ xs: 12 }}>
                  <Card sx={{ borderRadius: 2, border: `1px solid ${theme.palette.divider}`, mt: 2 }}>
                    <CardContent sx={{ p: 3 }}>
                      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                        <FileSignature style={{ width: 20, height: 20, color: 'var(--oe-primary)' }} />
                        <Typography variant="h6" sx={{ fontWeight: 600 }}>
                          Group Info Confirmation
                        </Typography>
                      </Stack>
                      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                        Sign to certify that the group information in the generated document is accurate and correct. Each role can sign from their portal; the document will show both signatures and dates when generated. Your signature is reused for all vendor forms that require it (one sign covers every vendor).
                      </Typography>
                      {certificationLoading ? (
                        <Typography variant="body2" color="text.secondary">Loading…</Typography>
                      ) : (
                        <Grid container spacing={2}>
                          <Grid size={{ xs: 12, sm: 6 }}>
                            <Box sx={{ p: 2, bgcolor: alpha(theme.palette.background.paper, 0.5), borderRadius: 1, border: `1px solid ${theme.palette.divider}` }}>
                              <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1}>
                                <Typography variant="body2" fontWeight={500}>Agent Signature</Typography>
                                <Stack direction="row" alignItems="center" spacing={1}>
                                  {certification?.agentHasSignature ? (
                                    <Typography variant="body2" color="success.main">Signed {formatCertDate(certification.agentSignedAt) ?? ''}</Typography>
                                  ) : (
                                    <Typography variant="body2" color="text.secondary">Not signed</Typography>
                                  )}
                                  {canSignAsAgent && (
                                    <Button size="small" variant="outlined" onClick={() => setSignModalRole('agent')}>
                                      {certification?.agentHasSignature ? 'Re-sign' : 'Sign'}
                                    </Button>
                                  )}
                                </Stack>
                              </Stack>
                            </Box>
                          </Grid>
                          <Grid size={{ xs: 12, sm: 6 }}>
                            <Box sx={{ p: 2, bgcolor: alpha(theme.palette.background.paper, 0.5), borderRadius: 1, border: `1px solid ${theme.palette.divider}` }}>
                              <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1}>
                                <Typography variant="body2" fontWeight={500}>Group Admin Signature</Typography>
                                <Stack direction="row" alignItems="center" spacing={1}>
                                  {certification?.groupAdminHasSignature ? (
                                    <Typography variant="body2" color="success.main">Signed {formatCertDate(certification.groupAdminSignedAt) ?? ''}</Typography>
                                  ) : (
                                    <Typography variant="body2" color="text.secondary">Not signed</Typography>
                                  )}
                                  {canSignAsGroupAdmin && (
                                    <Button size="small" variant="outlined" onClick={() => setSignModalRole('group-admin')}>
                                      {certification?.groupAdminHasSignature ? 'Re-sign' : 'Sign'}
                                    </Button>
                                  )}
                                </Stack>
                              </Stack>
                            </Box>
                          </Grid>
                        </Grid>
                      )}
                    </CardContent>
                  </Card>
                </Grid>
                )}
                
                {/* Metrics */}
                <Grid size={{ xs: 12 }}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 2 }}>
                    Metrics
                  </Typography>
                  
                  <Grid container spacing={2}>
                    {/* Total Members */}
                    <Grid size={{ xs: 6, sm: 6 }}>
                      <Box
                        sx={{
                          backgroundColor: alpha(theme.palette.background.paper, 0.5),
                          borderRadius: 2,
                          p: 3,
                          border: `1px solid ${alpha(theme.palette.divider, 0.1)}`,
                          transition: 'all 0.3s ease',
                          '&:hover': {
                            transform: 'translateY(-1px)',
                            boxShadow: theme.shadows[2],
                          }
                        }}
                      >
                        <Stack direction="row" alignItems="center" justifyContent="space-between">
                          <Stack direction="row" alignItems="center" spacing={2}>
                            <Box
                              sx={{
                                width: 48,
                                height: 48,
                                borderRadius: 2,
                                backgroundColor: alpha(colors.primary, 0.1),
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                            >
                              <PeopleIcon sx={{ color: 'var(--oe-primary)', fontSize: '1.5rem' }} />
                            </Box>
                            <Box>
                              <Typography variant="body2" sx={{ color: theme.palette.text.secondary, fontWeight: 500 }}>
                                Total Members
                              </Typography>
                            </Box>
                          </Stack>
                          <Typography variant="h4" sx={{ fontWeight: 700, color: 'var(--oe-primary)' }}>
                            {group.TotalMembers || 0}
                          </Typography>
                        </Stack>
                      </Box>
                    </Grid>

                    {/* Active Enrollments */}
                    <Grid size={{ xs: 6, sm: 6 }}>
                      <Box
                        sx={{
                          backgroundColor: alpha(theme.palette.background.paper, 0.5),
                          borderRadius: 2,
                          p: 3,
                          border: `1px solid ${alpha(theme.palette.divider, 0.1)}`,
                          transition: 'all 0.3s ease',
                          '&:hover': {
                            transform: 'translateY(-1px)',
                            boxShadow: theme.shadows[2],
                          }
                        }}
                      >
                        <Stack direction="row" alignItems="center" justifyContent="space-between">
                          <Stack direction="row" alignItems="center" spacing={2}>
                            <Box
                              sx={{
                                width: 48,
                                height: 48,
                                borderRadius: 2,
                                backgroundColor: alpha('#10b981', 0.1),
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                            >
                              <AssessmentIcon sx={{ color: '#10b981', fontSize: '1.5rem' }} />
                            </Box>
                            <Box>
                              <Typography variant="body2" sx={{ color: theme.palette.text.secondary, fontWeight: 500 }}>
                                Actively Enrolled Members
                              </Typography>
                            </Box>
                          </Stack>
                          <Typography variant="h4" sx={{ fontWeight: 700, color: '#10b981' }}>
                            {group.ActiveEnrollments || 0}
                          </Typography>
                        </Stack>
                      </Box>
                    </Grid>

                    {/* Last Month's Bill */}
                    <Grid size={{ xs: 6, sm: 6 }}>
                      <Box
                        sx={{
                          backgroundColor: alpha(theme.palette.background.paper, 0.5),
                          borderRadius: 2,
                          p: 3,
                          border: `1px solid ${alpha(theme.palette.divider, 0.1)}`,
                          transition: 'all 0.3s ease',
                          '&:hover': {
                            transform: 'translateY(-1px)',
                            boxShadow: theme.shadows[2],
                          }
                        }}
                      >
                        <Stack spacing={1.5}>
                          <Stack direction="row" alignItems="center" spacing={2}>
                            <Box
                              sx={{
                                width: 48,
                                height: 48,
                                borderRadius: 2,
                                backgroundColor: alpha('#10b981', 0.1),
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                            >
                              <CheckCircleIcon sx={{ color: '#10b981', fontSize: '1.5rem' }} />
                            </Box>
                            <Box sx={{ flex: 1 }}>
                              <Typography variant="body2" sx={{ color: theme.palette.text.secondary, fontWeight: 500 }}>
                                Last Month's Bill
                              </Typography>
                              {billingLoading ? (
                                <Skeleton width={80} height={32} />
                              ) : monthlyBillSummary.lastMonthBill ? (
                                <>
                                  <Typography variant="h4" sx={{ fontWeight: 700, color: '#10b981' }}>
                                    ${monthlyBillSummary.lastMonthBill.amount.toFixed(2)}
                                  </Typography>
                                  <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                                    Paid {formatDateUTC(monthlyBillSummary.lastMonthBill.paymentDate)}
                                  </Typography>
                                </>
                              ) : (
                                <Typography variant="h4" sx={{ fontWeight: 700, color: theme.palette.text.secondary }}>
                                  N/A
                                </Typography>
                              )}
                            </Box>
                          </Stack>
                        </Stack>
                      </Box>
                    </Grid>

                    {/* Next Month's Bill */}
                    <Grid size={{ xs: 6, sm: 6 }}>
                      <Box
                        sx={{
                          backgroundColor: alpha(theme.palette.background.paper, 0.5),
                          borderRadius: 2,
                          p: 3,
                          border: `1px solid ${alpha(theme.palette.divider, 0.1)}`,
                          transition: 'all 0.3s ease',
                          '&:hover': {
                            transform: 'translateY(-1px)',
                            boxShadow: theme.shadows[2],
                          }
                        }}
                      >
                        <Stack spacing={1.5}>
                          <Stack direction="row" alignItems="center" spacing={2}>
                            <Box
                              sx={{
                                width: 48,
                                height: 48,
                                borderRadius: 2,
                                backgroundColor: alpha(colors.primary, 0.1),
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                            >
                              <CalendarIcon sx={{ color: 'var(--oe-primary)', fontSize: '1.5rem' }} />
                            </Box>
                            <Box sx={{ flex: 1 }}>
                              <Typography variant="body2" sx={{ color: theme.palette.text.secondary, fontWeight: 500 }}>
                                Next Month's Bill
                              </Typography>
                              {billingLoading ? (
                                <Skeleton width={80} height={32} />
                              ) : monthlyBillSummary.nextMonthBill ? (
                                <>
                                  <Typography variant="h4" sx={{ fontWeight: 700, color: 'var(--oe-primary)' }}>
                                    ${monthlyBillSummary.nextMonthBill.scheduledAmount.toFixed(2)}
                                  </Typography>
                                  <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                                    Due {formatDateUTC(monthlyBillSummary.nextMonthBill.billingDate)}
                                  </Typography>
                                </>
                              ) : (
                                <Typography variant="h4" sx={{ fontWeight: 700, color: theme.palette.text.secondary }}>
                                  N/A
                                </Typography>
                              )}
                            </Box>
                          </Stack>
                        </Stack>
                      </Box>
                    </Grid>
                  </Grid>
                </Grid>
              </Grid>
            </CardContent>
          </Card>

          {/* AllAboard Master Group ID – SysAdmin / TenantAdmin only */}
          {user?.roles?.some((r: string) => ['SysAdmin', 'TenantAdmin'].includes(r)) && (
            <div className="mt-4 bg-white rounded-lg border border-gray-200 p-5">
              <div className="flex items-center gap-2 mb-3">
                <Tag className="h-4 w-4 text-oe-primary" />
                <span className="text-sm font-semibold text-gray-800">AllAboard Master Group ID</span>
                {!masterGroupIdEditing && (
                  <button
                    onClick={() => {
                      setMasterGroupIdValue(group.AllAboardMasterGroupId || '');
                      setMasterGroupIdValidation({});
                      setMasterGroupIdEditing(true);
                    }}
                    className="ml-auto flex items-center gap-1 text-xs text-oe-primary hover:text-oe-dark transition-colors"
                  >
                    <Edit2 className="h-3.5 w-3.5" />
                    Edit
                  </button>
                )}
              </div>

              {!masterGroupIdEditing ? (
                <p className="text-sm text-gray-700 font-mono">
                  {group.AllAboardMasterGroupId || (
                    <span className="text-gray-400 italic">Not set</span>
                  )}
                </p>
              ) : (
                <div className="space-y-2">
                  <input
                    type="text"
                    value={masterGroupIdValue}
                    onChange={(e) => {
                      const v = e.target.value.replace(/\D/g, '').slice(0, 6);
                      setMasterGroupIdValue(v);
                      setMasterGroupIdValidation({});
                    }}
                    onBlur={async () => {
                      const v = masterGroupIdValue.trim();
                      if (!v || v === (group.AllAboardMasterGroupId || '')) {
                        setMasterGroupIdValidation({});
                        return;
                      }
                      setMasterGroupIdValidation({ checking: true });
                      const res = await GroupsService.validateMasterGroupId(v, group.GroupId);
                      if (res.success && res.data) {
                        setMasterGroupIdValidation({
                          available: res.data.available,
                          message: res.data.available
                            ? 'Available'
                            : `Already used by "${res.data.conflictingGroupName || res.data.conflictingGroupId}"`,
                        });
                      } else {
                        setMasterGroupIdValidation({ available: false, message: res.message || 'Validation failed' });
                      }
                    }}
                    placeholder="e.g. 000042"
                    maxLength={6}
                    inputMode="numeric"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  />
                  <p className="text-xs text-gray-500">
                    Exactly 6 digits, unique per tenant. Used in enrollment URLs instead of the group GUID.
                  </p>
                  {masterGroupIdValidation.checking && (
                    <p className="text-xs text-gray-400">Checking availability…</p>
                  )}
                  {!masterGroupIdValidation.checking && masterGroupIdValidation.available === true && (
                    <p className="flex items-center gap-1 text-xs text-oe-success">
                      <CheckCircle className="h-3.5 w-3.5" /> {masterGroupIdValidation.message}
                    </p>
                  )}
                  {!masterGroupIdValidation.checking && masterGroupIdValidation.available === false && (
                    <p className="flex items-center gap-1 text-xs text-red-600">
                      <AlertCircle className="h-3.5 w-3.5" /> {masterGroupIdValidation.message}
                    </p>
                  )}
                  <div className="flex gap-2 pt-1">
                    <button
                      disabled={masterGroupIdSaving || masterGroupIdValidation.available === false}
                      onClick={async () => {
                        const v = masterGroupIdValue.trim() || null;
                        setMasterGroupIdSaving(true);
                        const res = await GroupsService.updateMasterGroupId(group.GroupId, v);
                        setMasterGroupIdSaving(false);
                        if (res.success) {
                          setMasterGroupIdEditing(false);
                          queryClient.invalidateQueries({ queryKey: ['groupDetails', groupId] });
                        } else {
                          setMasterGroupIdValidation({ available: false, message: res.message || 'Save failed' });
                        }
                      }}
                      className="px-3 py-1.5 text-xs bg-oe-primary hover:bg-oe-dark text-white rounded-lg disabled:opacity-50 transition-colors"
                    >
                      {masterGroupIdSaving ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      onClick={() => {
                        setMasterGroupIdEditing(false);
                        setMasterGroupIdValidation({});
                      }}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-lg transition-colors"
                    >
                      <XIcon className="h-3 w-3" /> Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </TabPanel>

        <TabPanel value={activeTab} index={TAB_INDICES.members}>
          <GroupMembersTab groupId={group.GroupId} groupName={group.Name} groupData={group} />
        </TabPanel>

        <TabPanel value={activeTab} index={TAB_INDICES.products}>
          <GroupProductsTab groupId={group.GroupId} groupName={group.Name} groupType={group.GroupType} onAddProduct={handleAddProductFromTab} />
        </TabPanel>

        <TabPanel value={activeTab} index={TAB_INDICES.contributions}>
          <GroupContributionsTab groupId={group.GroupId} groupName={group.Name} />
        </TabPanel>

        {/* Phase 3 Component: Billing Tab */}
        <TabPanel value={activeTab} index={TAB_INDICES.billing}>
          <GroupBillingTab 
            groupId={group.GroupId} 
            groupName={group.Name} 
          />
        </TabPanel>

        {/* Locations Tab */}
        <TabPanel value={activeTab} index={TAB_INDICES.locations}>
          <GroupLocationsTab 
            groupId={group.GroupId} 
            groupName={group.Name} 
          />
        </TabPanel>

        {/* Phase 3 Component: Documents Tab */}
        <TabPanel value={activeTab} index={TAB_INDICES.documents}>
          <GroupDocumentsTab 
            groupId={group.GroupId} 
            groupName={group.Name} 
          />
        </TabPanel>

        {/* Vendors tab (Group IDs + New Group Form) - only for TenantAdmin/SysAdmin */}
        {showVendorsTab && (
        <TabPanel value={activeTab} index={TAB_INDICES.groupIds}>
          <GroupVendorGroupIdsTab
            groupId={group.GroupId}
            groupName={group.Name}
            onOpenNewGroupForm={() => setShowNewGroupFormModal(true)}
          />
        </TabPanel>
        )}

        {/* Users Tab */}
        {showUsersTab && (
          <TabPanel value={activeTab} index={TAB_INDICES.users}>
            {/* Onboarding link status and resend (Agent/TenantAdmin/SysAdmin/GroupAdmin) */}
            {canAccessOnboarding && (
              <Card sx={{ borderRadius: 2, border: `1px solid ${theme.palette.divider}`, mb: 2 }}>
                <CardContent sx={{ p: 3 }}>
                  <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={2}>
                    <Box>
                      <Typography variant="h6" sx={{ fontWeight: 600, mb: 0.5 }}>
                        Onboarding link
                      </Typography>
                      <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
                        Send or resend the group onboarding link. Recipient is prefilled from the primary contact; you can change it to send to someone else.
                      </Typography>
                    </Box>
                    {onboardingDetailLoading ? (
                      <CircularProgress size={28} />
                    ) : (
                      <Stack direction="row" alignItems="center" spacing={2} flexWrap="wrap">
                        {onboardingDetail?.isOnboarded ? (
                          <Chip
                            icon={<CheckCircleIcon />}
                            label="Onboarding complete"
                            color="success"
                            size="medium"
                            sx={{ fontWeight: 500 }}
                          />
                        ) : onboardingDetail?.currentLink ? (
                          <>
                            <Chip
                              label={
                                onboardingDetail.currentLink.status === 'Active'
                                  ? 'Link sent'
                                  : onboardingDetail.currentLink.status === 'Expired'
                                  ? 'Link expired'
                                  : onboardingDetail.currentLink.status === 'Used'
                                  ? 'Used'
                                  : onboardingDetail.currentLink.status
                              }
                              color={
                                onboardingDetail.currentLink.status === 'Active'
                                  ? 'primary'
                                  : onboardingDetail.currentLink.status === 'Used'
                                  ? 'success'
                                  : 'default'
                              }
                              size="medium"
                              variant="outlined"
                              sx={{ fontWeight: 500 }}
                            />
                            {(onboardingDetail.currentLink.recipientEmail || onboardingDetail.currentLink.recipientName) && (
                              <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
                                {onboardingDetail.currentLink.recipientName || onboardingDetail.currentLink.recipientEmail}
                                {onboardingDetail.currentLink.recipientEmail && onboardingDetail.currentLink.recipientName
                                  ? ` (${onboardingDetail.currentLink.recipientEmail})`
                                  : ''}
                              </Typography>
                            )}
                            <Button
                              variant="contained"
                              size="small"
                              startIcon={<SendIcon />}
                              disabled={onboardingSendResendLoading}
                              onClick={() => setOnboardingSendModalOpen(true)}
                              sx={{ textTransform: 'none', fontWeight: 600 }}
                            >
                              Resend link
                            </Button>
                          </>
                        ) : (
                          <Button
                            variant="contained"
                            size="small"
                            startIcon={<SendIcon />}
                            disabled={onboardingSendResendLoading}
                            onClick={() => setOnboardingSendModalOpen(true)}
                            sx={{ textTransform: 'none', fontWeight: 600 }}
                          >
                            Send onboarding link
                          </Button>
                        )}
                      </Stack>
                    )}
                  </Stack>
                </CardContent>
              </Card>
            )}
            {onboardingIncomplete && (
              <Box sx={{ mb: 2 }}>
                <Alert
                  severity="warning"
                  sx={{ borderRadius: 2 }}
                  action={
                    <Button
                      color="inherit"
                      size="small"
                      onClick={async () => {
                        try {
                          const { GroupOnboardingService } = await import('../../services/group-onboarding.service');
                          const res = await GroupOnboardingService.markOnboardingComplete(group.GroupId);
                          if (res.success) {
                            showNotification('Onboarding marked as complete', 'success');
                            checkOnboardingStatus();
                          } else {
                            showNotification(res.message || 'Failed to mark complete', 'error');
                          }
                        } catch (e) {
                          showNotification(e instanceof Error ? e.message : 'Failed to mark complete', 'error');
                        }
                      }}
                    >
                      Mark as complete
                    </Button>
                  }
                >
                  <AlertTitle>Onboarding not complete</AlertTitle>
                  Complete the group onboarding flow or mark as complete to clear this notice.
                </Alert>
              </Box>
            )}
            {user?.currentRole === 'GroupAdmin' ? (
              <UserManagement
                titleOverride="Group Admin Users"
                descriptionOverride="Manage group administrator accounts for this group"
                validRolesOverride={['GroupAdmin']}
                fixedRoles={['GroupAdmin']}
                hideRoleFilter
              />
            ) : (
              <UserManagement
                baseUrlOverride={`/api/groups/${group.GroupId}/user-management`}
                titleOverride="Group Admin Users"
                descriptionOverride="Manage group administrator accounts for this group"
                validRolesOverride={['GroupAdmin']}
                fixedRoles={['GroupAdmin']}
                linkBaseUrlOptions={(() => {
                  const isLocalhost = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
                  if (!isLocalhost) return [];
                  const options: Array<{ label: string; value: string }> = [
                    { label: `Current (${window.location.origin})`, value: window.location.origin },
                    { label: 'Production (https://app.allaboard365.com)', value: 'https://app.allaboard365.com' },
                  ];
                  const tenantDomain = (group as any)?.TenantCustomDomain;
                  if (tenantDomain && String(tenantDomain).trim().length > 0) {
                    options.push({ label: `Tenant Custom Domain (https://${tenantDomain})`, value: `https://${tenantDomain}` });
                  }
                  return options;
                })()}
                defaultLinkBaseUrl={(() => {
                  const isLocalhost = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
                  if (!isLocalhost) return undefined;
                  const tenantDomain = (group as any)?.TenantCustomDomain;
                  if (tenantDomain && String(tenantDomain).trim().length > 0) return `https://${tenantDomain}`;
                  return 'https://app.allaboard365.com';
                })()}
                hideRoleFilter
              />
            )}
          </TabPanel>
        )}

        {/* Phase 3 Component: Settings Tab - Only show for authorized roles */}
        {canAccessEligibilityRules && (
          <TabPanel value={activeTab} index={TAB_INDICES.settings}>
            {group && groupId ? (
              <GroupSettingsTab
                groupId={groupId}
                groupName={group.Name}
                groupType={group.GroupType}
                currentSettings={{
                  MinimumHirePeriod: typeof group.MinimumHirePeriod === 'number' ? group.MinimumHirePeriod : undefined,
                  AllowPlanModifications: (group as any).AllowPlanModifications === true || (group as any).AllowPlanModifications === 1,
                  AllowMidMonthEffective: (group as any).AllowMidMonthEffective === true || (group as any).AllowMidMonthEffective === 1
                }}
                onSettingsUpdated={refetch}
              />
            ) : (
              <Box sx={{ p: 3, display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '400px' }}>
                <CircularProgress />
              </Box>
            )}
          </TabPanel>
        )}

        {/* Advanced Tab - TenantAdmin and SysAdmin only */}
        {showAdvancedTab && (
          <TabPanel value={activeTab} index={TAB_INDICES.advanced}>
            {group && groupId ? (
              <GroupAdvancedTab
                groupId={groupId}
                groupName={group.Name}
                onTerminateClick={canDeleteGroup && group?.Status !== 'Archived' ? () => setShowDeleteDialog(true) : undefined}
              />
            ) : (
              <Box sx={{ p: 3, display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '400px' }}>
                <CircularProgress />
              </Box>
            )}
          </TabPanel>
        )}
      </Paper>

      {/* Remove group confirmation dialog */}
      {signModalRole && (
        <NewGroupFormCertificationSignModal
          title={signModalRole === 'agent' ? 'Agent Signature' : 'Group Admin Signature'}
          onConfirm={handleCertificationSign}
          onClose={() => setSignModalRole(null)}
          loading={signSubmitting}
        />
      )}

      <Dialog
        open={showDeleteDialog}
        onClose={() => {
          if (!deleteLoading) {
            setShowDeleteDialog(false);
            setTerminationPreview(null);
            setTerminationPreviewError(null);
          }
        }}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>Terminate group</DialogTitle>
        <DialogContent>
          {terminationPreviewLoading && (
            <Box display="flex" justifyContent="center" py={3}>
              <CircularProgress />
            </Box>
          )}
          {terminationPreviewError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {terminationPreviewError}
            </Alert>
          )}
          {!terminationPreviewLoading && terminationPreview && (
            <>
              <DialogContentText sx={{ mb: 2 }}>
                Review the checklist below. Confirm only when you are ready to terminate this group. The group will be soft-deleted (status <strong>Archived</strong>) and removed from the active groups list; recurring group billing in DIME will be cancelled.
              </DialogContentText>
              <List dense disablePadding>
                <ListItem alignItems="flex-start">
                  <ListItemIcon sx={{ minWidth: 40, mt: 0.5 }}>
                    {terminationPreview.enrollmentsMissingTerminationDate === 0 ? (
                      <CheckCircleIcon color="success" />
                    ) : (
                      <ErrorOutlineIcon color="error" />
                    )}
                  </ListItemIcon>
                  <ListItemText
                    primary="Enrollment termination dates"
                    secondary={
                      terminationPreview.enrollmentsMissingTerminationDate === 0
                        ? 'Every enrollment in this group has a TerminationDate set.'
                        : `${terminationPreview.enrollmentsMissingTerminationDate} enrollment(s) still have no TerminationDate. Set dates on all enrollments before terminating the group.`
                    }
                  />
                </ListItem>
                <ListItem alignItems="flex-start">
                  <ListItemIcon sx={{ minWidth: 40, mt: 0.5 }}>
                    <ChecklistIcon color={terminationPreview.householdsWithFutureTermination.length > 0 ? 'info' : 'disabled'} />
                  </ListItemIcon>
                  <ListItemText
                    primary="Future-dated terminations"
                    secondary={
                      terminationPreview.householdsWithFutureTermination.length === 0
                        ? 'No enrollments are terminated on a future date, or all current term dates are in the past.'
                        : `Some households have coverage ending on a future date. Those members may keep access to benefits until that date; the group will still be terminated now. Affected: ${terminationPreview.householdsWithFutureTermination
                            .map(
                              (h) =>
                                `${h.primaryMemberName}${h.latestTerminationDate ? ` (latest term ${format(new Date(h.latestTerminationDate), 'MMM d, yyyy')})` : ''}`
                            )
                            .join('; ')}.`
                    }
                  />
                </ListItem>
                <ListItem alignItems="flex-start">
                  <ListItemIcon sx={{ minWidth: 40, mt: 0.5 }}>
                    <BillingIcon color={terminationPreview.recurringPayments.length > 0 ? 'warning' : 'disabled'} />
                  </ListItemIcon>
                  <ListItemText
                    primary="Recurring payments (DIME + database)"
                    secondary={
                      terminationPreview.recurringPayments.length === 0
                        ? 'No active recurring group payment schedules to cancel.'
                        : `The following schedule(s) will be cancelled in DIME and marked inactive in AllAboard365: ${terminationPreview.recurringPayments
                            .map(
                              (p) =>
                                `${p.locationName} — $${p.monthlyAmount.toFixed(2)}/mo (schedule ${p.scheduleId})${p.nextBillingDate ? `, next ${p.nextBillingDate}` : ''}`
                            )
                            .join('; ')}`
                    }
                  />
                </ListItem>
              </List>
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setShowDeleteDialog(false);
              setTerminationPreview(null);
              setTerminationPreviewError(null);
            }}
            disabled={deleteLoading}
          >
            Cancel
          </Button>
          <Button
            onClick={handleConfirmDeleteGroup}
            color="error"
            variant="contained"
            disabled={
              deleteLoading ||
              terminationPreviewLoading ||
              !!terminationPreviewError ||
              !terminationPreview?.canTerminate
            }
          >
            {deleteLoading ? <CircularProgress size={24} /> : 'Confirm termination'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={showRestoreDialog}
        onClose={() => !restoreLoading && setShowRestoreDialog(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Restore group</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This sets the group status back to <strong>Active</strong>. It will appear in the active groups list again. Recurring DIME schedules are not recreated automatically; set up billing again if needed.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowRestoreDialog(false)} disabled={restoreLoading}>
            Cancel
          </Button>
          <Button onClick={handleConfirmRestoreGroup} color="success" variant="contained" disabled={restoreLoading}>
            {restoreLoading ? <CircularProgress size={24} /> : 'Confirm restore'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Send / Resend onboarding link modal */}
      <Dialog open={onboardingSendModalOpen} onClose={() => setOnboardingSendModalOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            {onboardingDetail?.currentLink ? 'Resend Onboarding Link' : 'Send Onboarding Link'}
          </Typography>
        </DialogTitle>
        <DialogContent>
          <Stack spacing={3} sx={{ mt: 1 }}>
            <Alert severity="info" sx={{ borderRadius: 2 }}>
              A secure onboarding link will be sent to the recipient. The link expires in 7 days. Prefilled from primary contact; change to send to someone else.
            </Alert>
            <Box sx={{ display: 'flex', gap: 2 }}>
              <TextField
                label="First Name"
                value={onboardingSendFirstName}
                onChange={(e) => setOnboardingSendFirstName(e.target.value)}
                fullWidth
                required
                placeholder="John"
              />
              <TextField
                label="Last Name"
                value={onboardingSendLastName}
                onChange={(e) => setOnboardingSendLastName(e.target.value)}
                fullWidth
                required
                placeholder="Smith"
              />
            </Box>
            <TextField
              label="Email Address"
              type="email"
              value={onboardingSendEmail}
              onChange={(e) => setOnboardingSendEmail(e.target.value)}
              fullWidth
              required
              placeholder="admin@company.com"
            />
            {onboardingLinkBaseUrlOptions.length > 0 && (
              <FormControl fullWidth size="medium">
                <InputLabel id="onboarding-link-base-url-label">Link domain</InputLabel>
                <Select
                  labelId="onboarding-link-base-url-label"
                  value={onboardingSendLinkBaseUrl || onboardingDefaultLinkBaseUrl || ''}
                  label="Link domain"
                  onChange={(e) => setOnboardingSendLinkBaseUrl(e.target.value)}
                >
                  {onboardingLinkBaseUrlOptions.map((opt) => (
                    <MenuItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 3 }}>
          <Button onClick={() => setOnboardingSendModalOpen(false)} sx={{ textTransform: 'none' }}>
            Cancel
          </Button>
          <Button
            variant="contained"
            disabled={!onboardingSendEmail?.trim() || !onboardingSendFirstName?.trim() || !onboardingSendLastName?.trim() || onboardingSendResendLoading}
            startIcon={onboardingSendResendLoading ? <CircularProgress size={16} color="inherit" /> : <SendIcon />}
            onClick={() => sendOnboardingLinkToRecipient(onboardingSendEmail.trim(), onboardingSendFirstName.trim(), onboardingSendLastName.trim(), onboardingSendLinkBaseUrl || onboardingDefaultLinkBaseUrl || undefined)}
            sx={{ textTransform: 'none', fontWeight: 600 }}
          >
            {onboardingSendResendLoading ? 'Sending...' : (onboardingDetail?.currentLink ? 'Resend Link' : 'Send Link')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Generate New Group Form modal - 2 steps: select vendor, then review/edit values and generate */}
      <Dialog open={showNewGroupFormModal} onClose={() => { setShowNewGroupFormModal(false); setShowSendEmailModal(false); setNewGroupFormHistoryDeleteConfirmId(null); setNewGroupFormStep('select'); setNewGroupFormPreviewData(null); setNewGroupFormPreviewVendorId(null); }} maxWidth="sm" fullWidth PaperProps={{ sx: { minHeight: '70vh' } }}>
        <DialogTitle>
          {newGroupFormStep === 'review' ? `Review values – ${newGroupFormPreviewData?.vendorName ?? 'New Group Form'}` : 'Generate New Group Form'}
        </DialogTitle>
        <DialogContent>
          {newGroupFormStep === 'select' && (
            <>
              <DialogContentText sx={{ mb: 2 }}>
                Select a vendor to prepare their configured new group form. The form will load with resolved field values; you can edit if needed, then download as PDF or TXT or send by email.
              </DialogContentText>
              {newGroupFormVendorsLoading ? (
                <Box display="flex" justifyContent="center" py={3}>
                  <CircularProgress />
                </Box>
              ) : newGroupFormVendors.length === 0 ? (
                <Typography color="text.secondary">No vendors with a new group form configured for this group. Vendors can configure their form under Vendor Settings → New Group Form.</Typography>
              ) : (
                <Stack spacing={2} sx={{ mt: 1 }}>
                  {newGroupFormVendors.map((v) => {
                    const id = v.VendorId || v.Id;
                    return (
                      <Box key={id} sx={{ p: 2, border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
                        <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1}>
                          <span className="font-medium">{v.VendorName}</span>
                          <Button
                            size="small"
                            variant="contained"
                            onClick={() => openNewGroupFormReviewStep(id)}
                            sx={{ textTransform: 'none', bgcolor: 'var(--oe-primary)', '&:hover': { bgcolor: 'var(--oe-primary-dark)' } }}
                          >
                            Prepare form
                          </Button>
                        </Stack>
                      </Box>
                    );
                  })}
                </Stack>
              )}

              {/* History of generated/sent forms with mark-as-sent tracking */}
              <Box sx={{ mt: 3, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
                <Typography variant="subtitle2" fontWeight={600} sx={{ mb: 1 }}>History</Typography>
                <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
                  Track forms generated or sent. Use &quot;Mark as sent&quot; to record when the form was actually sent to the vendor.
                </Typography>
                {newGroupFormHistoryLoading ? (
                  <Box display="flex" justifyContent="center" py={2}>
                    <CircularProgress size={20} />
                  </Box>
                ) : newGroupFormHistory.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">No history yet.</Typography>
                ) : (
                  <Stack spacing={0.5} sx={{ maxHeight: 200, overflow: 'auto' }}>
                    {newGroupFormHistory.map((h) => (
                      <Box
                        key={h.id}
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 1,
                          py: 0.75,
                          px: 1,
                          borderRadius: 1,
                          bgcolor: h.markedAsSent ? alpha(theme.palette.success.main, 0.06) : undefined
                        }}
                      >
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Typography variant="body2" noWrap>{h.vendorName}</Typography>
                          <Typography variant="caption" color="text.secondary">
                            {h.actionType === 'Email' ? 'Sent' : 'Downloaded'}
                            {h.actionType === 'Email' && h.recipientEmail ? ` to ${h.recipientEmail}` : ''}
                            {' · '}
                            {h.occurredAt ? new Date(h.occurredAt).toLocaleString() : ''}
                          </Typography>
                        </Box>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, shrink: 0 }}>
                          <Tooltip title="Re-download PDF">
                            <span>
                              <IconButton
                                size="small"
                                onClick={() => handleNewGroupFormHistoryRedownload(h)}
                                disabled={newGroupFormHistoryDownloading === h.id}
                                aria-label="Re-download"
                              >
                                {newGroupFormHistoryDownloading === h.id ? <CircularProgress size={18} /> : <FileDownloadIcon fontSize="small" />}
                              </IconButton>
                            </span>
                          </Tooltip>
                          <label className="flex items-center gap-1 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={h.markedAsSent}
                              disabled={newGroupFormHistoryPatching === h.id}
                              onChange={() => handleNewGroupFormHistoryMarkSent(h.id, !h.markedAsSent)}
                              className="rounded border-gray-300"
                            />
                            <span className="text-sm text-gray-600">Mark as sent</span>
                          </label>
                          <Tooltip title="Delete">
                            <span>
                              <IconButton
                                size="small"
                                color="error"
                                onClick={() => setNewGroupFormHistoryDeleteConfirmId(h.id)}
                                disabled={newGroupFormHistoryDeleting === h.id}
                                aria-label="Delete"
                              >
                                {newGroupFormHistoryDeleting === h.id ? <CircularProgress size={18} /> : <DeleteIcon fontSize="small" />}
                              </IconButton>
                            </span>
                          </Tooltip>
                        </Box>
                      </Box>
                    ))}
                  </Stack>
                )}
              </Box>
            </>
          )}

          {newGroupFormStep === 'review' && (
            <>
              {newGroupFormPreviewLoading ? (
                <Box display="flex" justifyContent="center" py={3}>
                  <CircularProgress />
                </Box>
              ) : newGroupFormPreviewData && (
                <>
                  <Typography variant="subtitle2" fontWeight={600} sx={{ mb: 1 }}>{newGroupFormPreviewData.formTitle}</Typography>
                  <Stack spacing={1.5} sx={{ maxHeight: 360, overflow: 'auto' }}>
                    {newGroupFormPreviewData.fields.map((f, idx) => {
                      const isSignatureField = f.key === 'agentSignature' || f.key === 'groupAdminSignature';
                      if (f.fieldType === 'labelHeader') {
                        return (
                          <Box key={f.key}>
                            <Typography variant="subtitle2" fontWeight={600} color="text.primary">
                              {f.label}
                            </Typography>
                          </Box>
                        );
                      }
                      if (isSignatureField) {
                        const provided = !f.missing && (f.value != null && String(f.value).trim() !== '');
                        return (
                          <Box
                            key={f.key}
                            sx={{
                              p: 1.5,
                              borderRadius: 1,
                              border: '1px solid',
                              borderColor: 'divider',
                              bgcolor: (theme) => alpha(theme.palette.background.paper, 0.5)
                            }}
                          >
                            <Typography variant="caption" display="block" color="text.secondary" sx={{ mb: 0.5 }}>
                              {f.label}
                            </Typography>
                            <Typography variant="body2" color={provided ? 'success.main' : 'text.secondary'}>
                              {provided ? 'Provided' : 'Missing'}
                            </Typography>
                          </Box>
                        );
                      }
                      return (
                        <Box key={`${f.key}-${idx}`}>
                          <Typography variant="caption" display="block" color={f.missing ? 'warning.main' : 'text.secondary'} sx={{ mb: 0.5 }}>
                            {f.label}{f.missing ? ' (missing)' : ''}
                          </Typography>
                          <TextField
                            size="small"
                            fullWidth
                            multiline
                            minRows={1}
                            value={newGroupFormEditedValues[getNewGroupFormFieldStateKey(f, idx)] ?? ''}
                            onChange={(e) => setNewGroupFormEditedValues((prev) => ({ ...prev, [getNewGroupFormFieldStateKey(f, idx)]: e.target.value }))}
                            placeholder={f.missing ? 'Enter value or leave blank' : ''}
                            sx={{ '& .MuiOutlinedInput-root': { bgcolor: f.missing ? alpha(theme.palette.warning.main, 0.08) : undefined } }}
                          />
                        </Box>
                      );
                    })}
                  </Stack>
                </>
              )}
            </>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          {newGroupFormStep === 'review' ? (
            <>
              <Button
                onClick={() => { setNewGroupFormStep('select'); setNewGroupFormPreviewData(null); setNewGroupFormPreviewVendorId(null); }}
                sx={{ textTransform: 'none' }}
              >
                Back
              </Button>
              <Box sx={{ flex: 1 }} />
              <Button
                variant="outlined"
                startIcon={newGroupFormDownloading ? <CircularProgress size={14} /> : <FileDownloadIcon />}
                disabled={newGroupFormDownloading || newGroupFormDownloadingTxt}
                onClick={handleGenerateNewGroupFormPdf}
                sx={{ textTransform: 'none' }}
              >
                {newGroupFormDownloading ? 'Downloading...' : 'Download PDF'}
              </Button>
              <Button
                variant="outlined"
                startIcon={newGroupFormDownloadingTxt ? <CircularProgress size={14} /> : <FileDownloadIcon />}
                disabled={newGroupFormDownloading || newGroupFormDownloadingTxt}
                onClick={handleGenerateNewGroupFormTxt}
                sx={{ textTransform: 'none' }}
              >
                {newGroupFormDownloadingTxt ? 'Downloading...' : 'Download TXT'}
              </Button>
              <Button
                variant="contained"
                startIcon={newGroupFormSending === newGroupFormPreviewVendorId ? <CircularProgress size={14} color="inherit" /> : <SendIcon />}
                disabled={!!newGroupFormSending}
                onClick={() => setShowSendEmailModal(true)}
                sx={{ textTransform: 'none', bgcolor: 'var(--oe-primary)', '&:hover': { bgcolor: 'var(--oe-primary-dark)' } }}
              >
                {newGroupFormSending === newGroupFormPreviewVendorId ? 'Sending...' : 'Send email'}
              </Button>
            </>
          ) : (
            <Button onClick={() => { setShowNewGroupFormModal(false); setNewGroupFormStep('select'); setNewGroupFormPreviewData(null); }} sx={{ textTransform: 'none' }}>
              Close
            </Button>
          )}
        </DialogActions>
      </Dialog>

      {/* Confirm delete history entry */}
      <Dialog open={!!newGroupFormHistoryDeleteConfirmId} onClose={() => setNewGroupFormHistoryDeleteConfirmId(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Remove history entry?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {newGroupFormHistoryDeleteConfirmId && (() => {
              const entry = newGroupFormHistory.find((h) => h.id === newGroupFormHistoryDeleteConfirmId);
              return entry ? `Remove the "${entry.vendorName}" history entry? This cannot be undone.` : 'Remove this history entry? This cannot be undone.';
            })()}
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setNewGroupFormHistoryDeleteConfirmId(null)} sx={{ textTransform: 'none' }}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            disabled={!!newGroupFormHistoryDeleting}
            onClick={() => newGroupFormHistoryDeleteConfirmId && handleNewGroupFormHistoryDelete(newGroupFormHistoryDeleteConfirmId)}
            sx={{ textTransform: 'none' }}
          >
            {newGroupFormHistoryDeleting ? 'Removing…' : 'Remove'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Send to email modal — shown when user clicks Send email in the New Group Form review step */}
      <Dialog open={showSendEmailModal} onClose={() => setShowSendEmailModal(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Send to email</DialogTitle>
        <DialogContent>
          <TextField
            size="small"
            fullWidth
            label="Recipient email"
            placeholder="Vendor contact email"
            value={newGroupFormPreviewVendorId ? (newGroupFormEmailOverrides[newGroupFormPreviewVendorId] ?? '') : ''}
            onChange={(e) => newGroupFormPreviewVendorId && setNewGroupFormEmailOverrides((prev) => ({ ...prev, [newGroupFormPreviewVendorId]: e.target.value }))}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setShowSendEmailModal(false)} sx={{ textTransform: 'none' }}>Cancel</Button>
          <Button
            variant="contained"
            startIcon={newGroupFormSending === newGroupFormPreviewVendorId ? <CircularProgress size={14} color="inherit" /> : <SendIcon />}
            disabled={!!newGroupFormSending}
            onClick={handleSendNewGroupFormEmailFromReview}
            sx={{ textTransform: 'none', bgcolor: 'var(--oe-primary)', '&:hover': { bgcolor: 'var(--oe-primary-dark)' } }}
          >
            {newGroupFormSending === newGroupFormPreviewVendorId ? 'Sending...' : 'Send'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* MUI Snackbar for notifications */}
      <Snackbar
        open={notification.open}
        autoHideDuration={6000}
        onClose={handleCloseNotification}
        TransitionComponent={SlideTransition}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Alert 
          onClose={handleCloseNotification} 
          severity={notification.severity} 
          sx={{ 
            width: '100%',
            boxShadow: 3,
            '& .MuiAlert-icon': {
              fontSize: '1.5rem'
            }
          }}
          variant="filled"
          elevation={6}
        >
          {notification.title && <AlertTitle>{notification.title}</AlertTitle>}
          {notification.message}
        </Alert>
      </Snackbar>

      <GroupsAddGroup
        isOpen={showEditModal}
        onClose={() => { setShowEditModal(false); setEditProductsOnly(false); }}
        onSubmit={handleUpdateGroup}
        editingGroup={group as any}
        mode="edit"
        showRemoveGroup={canDeleteGroup && group?.Status !== 'Archived' && !editProductsOnly}
        onRemoveGroupClick={() => {
          setShowEditModal(false);
          setEditProductsOnly(false);
          setShowDeleteDialog(true);
        }}
        onNotification={showNotification}
        initialActiveTab={editProductsOnly ? 'products' : undefined}
        productsOnly={editProductsOnly}
      />
      </Box>
    </Box>
  );
};

export default GroupDetails;