// frontend/src/pages/groups/GroupsAddGroup.tsx

import { Building, Calendar, Check, CreditCard, Info, Landmark, Package, Plus, RotateCcw, Search, Send, Tag, Trash2, Upload, X, Zap } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import SearchableDropdown from '../../components/common/SearchableDropdown';
import DeleteProductConfirmModal from '../../components/groups/DeleteProductConfirmModal';
import { VendorNetworkSelectionMap } from '../../components/groups/VendorNetworkSelections';
import NetworkPickerForProduct, {
  deriveCardVendorIds,
  productHasVariationsForVendor
} from '../../components/enrollment-wizard/components/NetworkPicker';
import { ACCOUNT_TYPES, BUSINESS_TYPES, CREDIT_CARD_TYPES, US_STATES_FORMATTED } from '../../constants/form-options';
import { useAuth } from '../../contexts/AuthContext';
import { useAgentsByTenant } from '../../hooks/useAgentsByTenant';
import { useGroupAgent } from '../../hooks/useGroupAgent';
import { useGroupProducts } from '../../hooks/useGroupProducts';
import { useMyTenant } from '../../hooks/useMyTenant';
import { useTenants } from '../../hooks/useTenants';
import { apiService } from '../../services/api.service';
import { EnrollmentLinkTemplatesService } from '../../services/enrollment-link-templates.service';
import { GroupProductsService } from '../../services/group-products.service';
import { Group, GroupsService } from '../../services/groups.service';
import { User } from '../../types/user.types';
import { formatPhoneNumber } from '../../utils/payment-validation';
import {
  addDaysYmd,
  buildFirstEffectiveDateOptions,
  computeInitialEnrollmentPeriodFromFirstEffective,
  formatDisplayDate,
  isFutureDateYmd,
  isValidFirstEffectiveDayOfMonth
} from '../../utils/groupFirstEffectiveDate';

export interface InitialEnrollmentPeriodPayload {
  startDate: string;
  endDate: string;
  earliestEffectiveDate: string;
  allowMidMonthEffective?: boolean;
}



export interface GroupFormData {
  name: string; primaryContactFirstName: string; primaryContactLastName: string; contactEmail: string; contactPhone: string; contactTitle: string;
  contactPhone2: string; faxNumber: string; website: string; address: string; address2: string; city: string;
  state: string; zip: string; taxIdNumber: string; businessType: string;
  paymentType: 'ACH' | 'CreditCard' | ''; // Payment type selector
  creditCardNumber: string;
  creditCardType: string; creditCardExpiry: string; creditCardName: string; achBankName: string;
  achAccountType: string; achRoutingNumber: string; achAccountNumber: string; achAccountName: string;
  tenantId: string; agentId: string; selectedProducts?: string[];
  groupType: 'Standard' | 'ListBill';
  allAboardMasterGroupId?: string;
}

function getGroupFormErrorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    const m = (err as { message: string }).message.trim();
    if (m) return m;
  }
  return 'Unable to create group. Please try again.';
}

export interface GroupsAddGroupProps {
  isOpen: boolean; onClose: () => void; onSubmit: (groupData: any) => void | Promise<void>;
  editingGroup?: Group | null; mode: 'create' | 'edit';
  onGroupCreated?: (groupId: string) => void;
  tenants?: any[];
  agents?: any[];
  /** When true (edit mode only), show a discreet "Terminate Group" link in the modal footer */
  showRemoveGroup?: boolean;
  /** Called when user clicks "Terminate Group"; parent should close modal and open termination confirmation */
  onRemoveGroupClick?: () => void;
  /** Optional callback for notifications (e.g. when user tries to remove a product that has enrollments) */
  onNotification?: (message: string, severity?: 'success' | 'error' | 'warning' | 'info') => void;
  /** Tab to land on when the modal opens. Defaults to 'basic'. */
  initialActiveTab?: 'basic' | 'products' | 'address' | 'business' | 'payment' | 'documents';
  /** When true, hide all tabs except Products and show an inline Save button on the Products tab (edit mode only). */
  productsOnly?: boolean;
}

const GROUPS_ADD_GROUP_ENROLLMENT_REMOVE_MSG = 'Cannot remove a product that members are enrolled in. Use the hide option on the Products tab to prevent new enrollments while keeping existing ones active.';

const GroupsAddGroup: React.FC<GroupsAddGroupProps> = ({
  isOpen, onClose, onSubmit, editingGroup = null, mode = 'create',
  showRemoveGroup = false, onRemoveGroupClick, onNotification,
  initialActiveTab, productsOnly = false
}) => {
  const { user } = useAuth();
  const typedUser = user as User | null;
  const isSysAdmin = typedUser?.currentRole === 'SysAdmin';
  const isTenantAdmin = typedUser?.currentRole === 'TenantAdmin';
  const isAgent = typedUser?.currentRole === 'Agent';
  const isAgentLike = isAgent || typedUser?.currentRole === 'AgencyOwner';
  
  console.log('🔍 User role debugging:', {
    user: typedUser,
    roles: typedUser?.roles,
    currentRole: typedUser?.currentRole,
    isSysAdmin,
    isTenantAdmin,
    isAgent
  });
  
  const [activeTab, setActiveTab] = useState<'basic' | 'products' | 'address' | 'business' | 'payment' | 'documents'>(initialActiveTab ?? 'basic');
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string>('');
  const [existingLogoUrl, setExistingLogoUrl] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [availableProducts, setAvailableProducts] = useState<any[]>([]);
  const [selectedProducts, setSelectedProducts] = useState<string[]>([]);
  const [selectedProductsData, setSelectedProductsData] = useState<any[]>([]); // Store full product data for selected products
  /** Agent must tick this when any selected product's vendor has a MinimumEmployeesPerGroup. */
  const [vendorMinimumAcknowledged, setVendorMinimumAcknowledged] = useState(false);
  // Vendor network selections per VendorId. null/undefined => use vendor default.
  // Persisted to /api/groups/:groupId/vendor-networks after the group save resolves.
  const [vendorNetworkSelections, setVendorNetworkSelections] = useState<VendorNetworkSelectionMap>({});
  // Tracks which selected products have already had the network picker modal
  // auto-opened (to avoid re-opening on every render). Seeded with initially-
  // loaded selectedProducts on edit-mode mount so existing groups don't pop the
  // modal for products the admin has already configured.
  const [networkModalAutoOpened, setNetworkModalAutoOpened] = useState<Set<string>>(new Set());
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [productSearchTerm, setProductSearchTerm] = useState('');
  /** TenantAdmin: include products with IsHidden (Hide from Groups) in picker and selected list */
  const [showHiddenGroupProducts, setShowHiddenGroupProducts] = useState(false);
  const [showProductModal, setShowProductModal] = useState(false);
  const [showQuickSendDialog, setShowQuickSendDialog] = useState(false);
  const [quickSendData, setQuickSendData] = useState({
    firstName: '',
    lastName: '',
    email: ''
  });
  const [existingPaymentMethods, setExistingPaymentMethods] = useState<any[]>([]);
  const [loadingPaymentMethods, setLoadingPaymentMethods] = useState(false);
  const [createOnboardingLink, setCreateOnboardingLink] = useState<boolean>(true); // Default to true for backward compatibility
  /** Create mode: first day benefits may start (1st or 15th); drives initial enrollment period. */
  const [firstEffectiveDate, setFirstEffectiveDate] = useState('');
  const [allowMidMonthEffectiveOnCreate, setAllowMidMonthEffectiveOnCreate] = useState(false);
  const [firstEffectiveDateError, setFirstEffectiveDateError] = useState<string | null>(null);

  /** One-time hydrate of assigned agent from editingGroup when options load (edit mode). */
  const agentHydratedFromEditRef = useRef(false);
  /** Set when the user changes the agent dropdown so we never overwrite their choice. */
  const userEditedAgentRef = useRef(false);

  useEffect(() => {
    if (isOpen && initialActiveTab) setActiveTab(initialActiveTab);
  }, [isOpen, initialActiveTab]);

  useEffect(() => {
    if (!isOpen) return;
    agentHydratedFromEditRef.current = false;
    userEditedAgentRef.current = false;
  }, [isOpen, mode, editingGroup?.GroupId]);

  useEffect(() => {
    if (isOpen) setSubmitError(null);
  }, [isOpen]);
  const [enrollmentLinkTemplateCount, setEnrollmentLinkTemplateCount] = useState<number | null>(null);
  /** Product IDs that have enrollments in this group (edit mode only); cannot remove these from group */
  const [productIdsWithEnrollments, setProductIdsWithEnrollments] = useState<string[]>([]);
  /** Agent dropdown search - triggers server-side search when typing */
  const [agentSearchQuery, setAgentSearchQuery] = useState('');
  /** Store selected agent option for display when it's not in current options (e.g. during refetch) */
  const [selectedAgentOption, setSelectedAgentOption] = useState<{ id: string; label: string; value: string; email?: string; code?: string } | null>(null);
  /** Agent: GET /api/me/agent/assignable-agents (same rules as server assert) */
  const [assignableGroupAgents, setAssignableGroupAgents] = useState<{
    mode: string;
    agents: Array<{ agentId: string; userId: string; firstName: string; lastName: string; email: string }>;
  } | null>(null);
  const [loadingAssignableGroup, setLoadingAssignableGroup] = useState(false);

  const includeHiddenGroupProducts = isTenantAdmin && showHiddenGroupProducts;

  const isProductHiddenForGroup = (p: any) =>
    p.IsHidden === true || p.IsHidden === 1 ||
    p.isHidden === true || p.isHidden === 1 ||
    p.IsHidden === 'true' || p.isHidden === 'true';

  const isProductCatalogHidden = (p: any) =>
    p.IsCatalogHidden === true || p.IsCatalogHidden === 1 ||
    p.isCatalogHidden === true || p.isCatalogHidden === 1 ||
    p.IsCatalogHidden === 'true' || p.isCatalogHidden === 'true';

  // Data fetching hooks
  const { data: allTenants, isLoading: isLoadingTenants } = useTenants(isOpen && isSysAdmin);
  const { data: myTenant, isLoading: isLoadingMyTenant } = useMyTenant(isOpen && !isSysAdmin);

  // For agents, use the tenantId directly from the user object
  const agentTenantId = isAgent ? typedUser?.tenantId : null;
  const userTenantId = typedUser?.tenantId;
  
  // Determine tenantId for agent fetch:
  // - SysAdmin: Use selectedTenantId (may be null until tenant is selected)
  // - TenantAdmin: Use myTenant?.TenantId or fallback to typedUser?.tenantId (available immediately)
  // - Agent: Use agentTenantId (typedUser?.tenantId)
  const tenantIdForAgentFetch = isSysAdmin 
    ? selectedTenantId 
    : (isAgent 
      ? agentTenantId 
      : (myTenant?.TenantId || typedUser?.tenantId || null));
  
  // For agents, we don't need to fetch agents - we'll use the current user
  // For TenantAdmin, enable the query even if myTenant isn't loaded yet (use typedUser?.tenantId as fallback)
  const shouldFetchAgents = isAgent 
    ? false 
    : (isSysAdmin 
      ? !!selectedTenantId 
      : !!(myTenant?.TenantId || typedUser?.tenantId));
  
  // In edit mode, pass includeUserId so backend always returns the group's assigned agent (even if inactive)
  // Must use AgentUserId (UserId) - backend includeUserId expects UserId, not AgentId
  const includeUserIdForAgentFetch = mode === 'edit' && editingGroup?.AgentUserId ? editingGroup.AgentUserId : null;
  const { data: agentsForTenant, isLoading: isLoadingAgents } = useAgentsByTenant(
    isAgent ? null : (tenantIdForAgentFetch || null),
    shouldFetchAgents,
    agentSearchQuery,
    includeUserIdForAgentFetch ?? undefined
  );

  // Fetch assigned agent using the new hook
  const groupIdForAgentFetch = mode === 'edit' && editingGroup ? editingGroup.GroupId : null;
  const { data: assignedAgent, isLoading: isLoadingAssignedAgent } = useGroupAgent(groupIdForAgentFetch);

  useEffect(() => {
    if (!isOpen || !isAgentLike) {
      setAssignableGroupAgents(null);
      setLoadingAssignableGroup(false);
      return;
    }
    let cancelled = false;
    setLoadingAssignableGroup(true);
    setAssignableGroupAgents(null);
    const qs = new URLSearchParams();
    if (mode === 'edit' && editingGroup?.GroupId) {
      qs.set('forGroupId', editingGroup.GroupId);
    }
    (async () => {
      try {
        const res = (await apiService.get(`/api/me/agent/assignable-agents?${qs}`)) as {
          success?: boolean;
          data?: { mode: string; agents: Array<{ agentId: string; userId: string; firstName: string; lastName: string; email: string }> };
        };
        if (!cancelled && res?.success && res.data) {
          setAssignableGroupAgents(res.data);
        } else if (!cancelled) {
          setAssignableGroupAgents({ mode: 'none', agents: [] });
        }
      } catch {
        if (!cancelled) setAssignableGroupAgents({ mode: 'none', agents: [] });
      } finally {
        if (!cancelled) setLoadingAssignableGroup(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, isAgentLike, mode, editingGroup?.GroupId]);

  // Use hook for fetching group products (following backend-system.md pattern)
  const groupIdForProducts = isOpen && mode === 'edit' && editingGroup?.GroupId ? editingGroup.GroupId : undefined;
  const {
    data: groupProductsData,
    isLoading: isLoadingGroupProducts,
    refetch: refetchGroupProducts
  } = useGroupProducts(groupIdForProducts, { includeHidden: includeHiddenGroupProducts });

  const queryClient = useQueryClient();

  /** Saved product (has a row in oe.GroupProducts) the agent wants to remove. Triggers the
   *  enrollment-aware confirmation modal — same flow used on the Group Products tab. */
  const [productPendingDelete, setProductPendingDelete] = useState<{ productId: string; productName: string } | null>(null);
  const [productPendingDeleteCount, setProductPendingDeleteCount] = useState<number | null>(null);
  const [productPendingDeleteCountLoading, setProductPendingDeleteCountLoading] = useState(false);
  const [restoringProductId, setRestoringProductId] = useState<string | null>(null);

  // Fetch the enrollment count when a saved product is queued for deletion.
  useEffect(() => {
    if (!productPendingDelete || !editingGroup?.GroupId) return;
    let cancelled = false;
    setProductPendingDeleteCountLoading(true);
    setProductPendingDeleteCount(null);
    GroupProductsService.getEnrollmentCount(editingGroup.GroupId, productPendingDelete.productId)
      .then((res) => {
        if (!cancelled) setProductPendingDeleteCount(res?.count ?? 0);
      })
      .catch(() => {
        if (!cancelled) setProductPendingDeleteCount(0);
      })
      .finally(() => {
        if (!cancelled) setProductPendingDeleteCountLoading(false);
      });
    return () => { cancelled = true; };
  }, [productPendingDelete, editingGroup?.GroupId]);

  const invalidateGroupProductCaches = async () => {
    if (!editingGroup?.GroupId) return;
    await queryClient.invalidateQueries({ queryKey: ['groupProducts', editingGroup.GroupId] });
    await queryClient.invalidateQueries({ queryKey: ['group-hidden-with-enrollments', editingGroup.GroupId] });
    await refetchGroupProducts();
  };

  const handleRestoreSavedProduct = async (productId: string, productName: string) => {
    if (!editingGroup?.GroupId) return;
    setRestoringProductId(productId);
    try {
      const response = await GroupProductsService.toggleProductVisibility(editingGroup.GroupId, productId, false);
      if (response.success) {
        await invalidateGroupProductCaches();
      } else if ((response as any).message) {
        window.alert((response as any).message);
      } else {
        window.alert(`Failed to add "${productName}" back to the group.`);
      }
    } finally {
      setRestoringProductId(null);
    }
  };

  const handleConfirmDeleteSavedProduct = async () => {
    if (!editingGroup?.GroupId || !productPendingDelete) return;
    const { productId, productName } = productPendingDelete;
    const response = await GroupProductsService.toggleProductVisibility(editingGroup.GroupId, productId, true);
    setProductPendingDelete(null);
    if (response.success) {
      await invalidateGroupProductCaches();
    } else if ((response as any).message) {
      window.alert((response as any).message);
    } else {
      window.alert(`Failed to remove "${productName}" from the group.`);
    }
  };

  const isLoading =
    isLoadingTenants ||
    isLoadingMyTenant ||
    (isAgent ? false : isLoadingAgents) ||
    isLoadingAssignedAgent ||
    isLoadingGroupProducts;

  const currentUserId = typedUser?.userId || (typedUser as any)?.UserId || localStorage.getItem('userId') || '';

  // Prepare dropdown options
  const tenantOptions = allTenants?.map(tenant => ({
    id: tenant.TenantId,
    label: tenant.Name || 'Unknown Tenant',
    value: tenant.TenantId
  })) || [];

  // For agents: always include self, plus assignable downline/agency agents (UserId values for API)
  const baseAgentOptions = isAgentLike
    ? (() => {
        const selfOption = currentUserId
          ? [{
              id: currentUserId,
              label: `${typedUser?.firstName || ''} ${typedUser?.lastName || ''}`.trim() || 'Me',
              value: currentUserId,
              email: typedUser?.email || '',
              code: ''
            }]
          : [];
        const downlineOptions = assignableGroupAgents &&
            assignableGroupAgents.mode !== 'none' &&
            assignableGroupAgents.agents.length > 0
          ? assignableGroupAgents.agents
              .filter((a) => String(a.userId).toLowerCase() !== String(currentUserId).toLowerCase()) // avoid duplicate self
              .map((a) => ({
                id: a.userId,
                label: `${a.firstName || ''} ${a.lastName || ''}`.trim() || 'Agent',
                value: a.userId,
                email: a.email || '',
                code: ''
              }))
          : [];
        return [...selfOption, ...downlineOptions];
      })()
    :
    (agentsForTenant?.map(agent => {
      // Backend returns UserId for agents; groups update expects UserId (looks up AgentId)
      const userId = agent.UserId ?? agent.Id;
      if (!userId) {
        console.warn('⚠️ Agent missing UserId/Id:', agent);
        return null;
      }
      
      // Extract name - could be in Name field (from view) or FirstName/LastName (from other endpoints)
      const agentName = agent.Name || `${agent.FirstName || ''} ${agent.LastName || ''}`.trim() || 'Unknown Agent';
      
      return {
        id: userId,
        label: agentName,
        value: userId, // Always use UserId - backend expects this
        email: agent.Email || '',
        code: agent.AgentCode || agent.NPN || ''
      };
    }).filter(Boolean) || []);

  // For agents, the current agent is the user themselves
  const currentAgent = isAgent ? typedUser : null;
  
  console.log('🔍 GroupsAddGroup - Loading states:', {
    isLoadingTenants,
    isLoadingMyTenant,
    isLoadingAgents,
    isLoadingAssignedAgent,
    isAgent,
    totalIsLoading: isLoading
  });
  
  console.log('🔍 GroupsAddGroup - Tenant data:', {
    selectedTenantId,
    myTenant: typeof myTenant === 'string' ? myTenant : myTenant?.TenantId,
    myTenantType: typeof myTenant,
    agentTenantId,
    userTenantId: typedUser?.tenantId,
    isSysAdmin,
    isTenantAdmin,
    isAgent,
    tenantIdForAgentFetch,
    shouldFetchAgents
  });
  
  const [formData, setFormData] = useState<GroupFormData>({
    name: '', primaryContactFirstName: '', primaryContactLastName: '', contactEmail: '', contactPhone: '', contactTitle: '', contactPhone2: '',
    faxNumber: '', website: '', address: '', address2: '', city: '', state: '', zip: '', taxIdNumber: '',
    businessType: '', paymentType: '', creditCardNumber: '', creditCardType: '', creditCardExpiry: '', creditCardName: '',
    achBankName: '', achAccountType: '', achRoutingNumber: '', achAccountNumber: '', achAccountName: '',
    tenantId: '', agentId: '', groupType: 'Standard', allAboardMasterGroupId: ''
  });
  const [masterGroupIdSuggested, setMasterGroupIdSuggested] = useState(false);
  const [masterGroupIdValidation, setMasterGroupIdValidation] = useState<{
    available?: boolean;
    message?: string;
    checking?: boolean;
  }>({});

  // Include selectedAgentOption in agentOptions when formData.agentId is set but not in list (prevents "no one selected" during refetch)
  const agentOptions = (() => {
    const opts = baseAgentOptions.filter((o): o is NonNullable<typeof o> => o != null);
    if (formData.agentId && selectedAgentOption && selectedAgentOption.value === formData.agentId && !opts.some(o => o.value === formData.agentId)) {
      return [selectedAgentOption, ...opts];
    }
    return opts;
  })();

  console.log('🔍 GroupsAddGroup - Agent data:', {
    agentsForTenantCount: agentsForTenant?.length || 0,
    agentsForTenant: agentsForTenant,
    agentOptionsCount: agentOptions.length,
    agentOptions: agentOptions,
    isLoadingAgents
  });

  // Process group products data from hook (following backend-system.md pattern)
  // Defined here so it can be used in useEffect
  const processGroupProductsData = (data: any) => {
    if (!data) return;
    
    console.log('🔍 Processing group products data from hook:', data);
    
    // Handle different data structures like GroupProductsTab does
    let processedData = data;
    if ((processedData as any).data) {
      processedData = (processedData as any).data;
    }
    
    // Extract groupProducts from various possible structures
    let groupProducts = [];
    if (Array.isArray(processedData)) {
      groupProducts = processedData;
    } else if (processedData.groupProducts) {
      groupProducts = processedData.groupProducts;
    } else if ((processedData as any).data && (processedData as any).data.groupProducts) {
      groupProducts = (processedData as any).data.groupProducts;
    } else if ((processedData as any).data && Array.isArray((processedData as any).data)) {
      groupProducts = (processedData as any).data;
    }
    
    console.log('🔍 Group products extracted:', groupProducts);
    console.log('🔍 Group products length:', groupProducts.length);
    
    if (groupProducts && groupProducts.length > 0) {
      const activeProducts = groupProducts.filter((gp: any) => gp.IsActive);
      
      // Assigned group products: always include every active row (hidden bundles/products, any SalesType)
      const filteredSelectedProducts = activeProducts;
      
      const productIds = filteredSelectedProducts.map((gp: any) => gp.ProductId);
      
      setSelectedProductsData(filteredSelectedProducts.map((gp: any) => ({
        ProductId: gp.ProductId,
        Name: gp.Name || gp.ProductName,
        ProductType: gp.ProductType,
        Description: gp.Description,
        ProductImageUrl: gp.ProductImageUrl,
        ProductLogoUrl: gp.ProductLogoUrl,
        ProductOwner: gp.ProductOwner,
        IsHidden: gp.IsHidden,
        IsCatalogHidden: gp.IsCatalogHidden ?? 0,
        IsBundle: gp.IsBundle,
        SalesType: gp.SalesType || gp.salesType,
        vendorId: gp.vendorId || gp.VendorId || null,
        idCardData: gp.idCardData ?? null,
        includedProducts: gp.includedProducts ?? gp.bundleProducts ?? null
      })));

      console.log('✅ Loaded selected products:', productIds);
      setSelectedProducts(productIds);
      // Seed auto-opened set so existing products don't auto-pop the modal.
      setNetworkModalAutoOpened(new Set(productIds));
    } else {
      console.log('⚠️ No active products found in groupProducts array');
      setSelectedProducts([]);
      setSelectedProductsData([]);
    }
    
    // Also update availableProducts if they're included in the response
    let availableProducts = [];
    if (processedData.availableProducts && Array.isArray(processedData.availableProducts)) {
      availableProducts = processedData.availableProducts;
    } else if ((processedData as any).data && (processedData as any).data.availableProducts) {
      availableProducts = (processedData as any).data.availableProducts;
    }
    
    if (availableProducts && availableProducts.length > 0) {
      const filteredAvailableProducts = availableProducts.filter((p: any) => {
        const isHidden = isProductHiddenForGroup(p);
        if (!includeHiddenGroupProducts && isHidden) {
          return false;
        }
        
        const salesType = (p.SalesType || p.salesType || '').toString().trim();
        if (salesType && salesType.toLowerCase() !== 'group' && salesType.toLowerCase() !== 'both') {
          return false;
        }
        
        return true;
      });
      
      setAvailableProducts(prev => {
        const existingIds = new Set(prev.map(p => p.ProductId || p.productId));
        const newProducts = filteredAvailableProducts.filter((p: any) => 
          !existingIds.has(p.ProductId || p.productId)
        );
        return [...prev, ...newProducts];
      });
    }
  };

  // Debug useEffect to track when component mounts and data changes
  useEffect(() => {
    // Only run when modal is open to prevent infinite loops
    if (!isOpen) return;
    
    console.log('🔍 Component mounted/updated:', {
      isOpen,
      myTenant,
      myTenantType: typeof myTenant,
      userTenantId: typedUser?.tenantId,
      selectedTenantId
    });
    
    // FORCED FIX: If we're open, not SysAdmin, and have no selectedTenantId but have userTenantId, set it immediately
    if (!isSysAdmin && !selectedTenantId && typedUser?.tenantId) {
      console.log('🚨 FORCED FIX: Setting selectedTenantId to userTenantId:', typedUser.tenantId);
      setSelectedTenantId(typedUser.tenantId);
      setFormData(prev => ({ ...prev, tenantId: typedUser.tenantId }));
    }
    
}, [isOpen, myTenant, typedUser?.tenantId, isSysAdmin]);

  // Fetch product IDs that have enrollments in this group (edit mode) so we can block removing them
  useEffect(() => {
    if (!isOpen || mode !== 'edit' || !editingGroup?.GroupId) {
      setProductIdsWithEnrollments([]);
      return;
    }
    let cancelled = false;
    GroupProductsService.getGroupProductIdsWithEnrollments(editingGroup.GroupId).then((res) => {
      if (!cancelled && res.success && res.data?.productIds) {
        setProductIdsWithEnrollments(res.data.productIds.map((id) => String(id)));
      } else if (!cancelled) {
        setProductIdsWithEnrollments([]);
      }
    }).catch(() => {
      if (!cancelled) setProductIdsWithEnrollments([]);
    });
    return () => { cancelled = true; };
  }, [isOpen, mode, editingGroup?.GroupId]);

  // Effect to populate form when data is loaded
  useEffect(() => {
    if (!isOpen) {
        resetForm();
        return;
    }
    
    console.log('🔍 Main useEffect triggered:', {
      isOpen,
      isSysAdmin,
      isTenantAdmin,
      isAgent,
      agentTenantId,
      myTenant: typeof myTenant === 'string' ? myTenant : myTenant?.TenantId,
      myTenantType: typeof myTenant,
      userTenantId: typedUser?.tenantId,
      mode,
      editingGroup: editingGroup?.GroupId,
      editingGroupAgentId: editingGroup?.AgentId,
      editingGroupAgentUserId: editingGroup?.AgentUserId,
      editingGroupLogoUrl: editingGroup?.LogoUrl
    });
    
    console.log('🔍 Modal is open, proceeding with tenant setup');
    
    console.log('🔍 GroupsAddGroup - User data:', {
      isSysAdmin,
      isTenantAdmin,
      isAgent,
      agentTenantId,
      myTenant: typeof myTenant === 'string' ? myTenant : myTenant?.TenantId,
      myTenantType: typeof myTenant,
      userTenantId: typedUser?.tenantId
    });
    
    // Set tenant from hook or user object
    console.log('🔍 About to check tenant setup logic:', { isSysAdmin, myTenant: !!myTenant, userTenantId: !!userTenantId });
    
    if (!isSysAdmin) {
        console.log('🔍 User is not SysAdmin, proceeding with tenant setup');
        
        // Check if we already have selectedTenantId set
        if (!selectedTenantId) {
            console.log('🔍 selectedTenantId is null, setting it now');
            console.log('🔍 Available tenant sources:', { myTenant, agentTenantId, typedUserTenantId: typedUser?.tenantId, userTenantId });
            if (myTenant) {
                // Handle both cases: myTenant as string (tenant ID) or object with TenantId property
                const tenantId = typeof myTenant === 'string' || myTenant instanceof String ? String(myTenant) : String(myTenant.TenantId);
                console.log('🔍 Setting tenant from myTenant hook:', tenantId, 'type:', typeof myTenant, 'isString:', typeof myTenant === 'string', 'isStringObject:', myTenant instanceof String);
                setFormData(prev => ({ ...prev, tenantId }));
                setSelectedTenantId(tenantId);
                console.log('🔍 selectedTenantId set to:', tenantId);
            } else if (isAgent && agentTenantId) {
                console.log('🔍 Setting tenant from agent user object (fallback):', agentTenantId);
                setFormData(prev => ({ ...prev, tenantId: agentTenantId }));
                setSelectedTenantId(agentTenantId);
                console.log('🔍 selectedTenantId set to:', agentTenantId);
            } else if (typedUser?.tenantId) {
                console.log('🔍 Setting tenant from user object (final fallback):', typedUser.tenantId);
                setFormData(prev => ({ ...prev, tenantId: typedUser.tenantId }));
                setSelectedTenantId(typedUser.tenantId);
                console.log('🔍 selectedTenantId set to:', typedUser.tenantId);
            } else if (userTenantId) {
                console.log('🔍 Setting tenant from userTenantId (emergency fallback):', userTenantId);
                setFormData(prev => ({ ...prev, tenantId: userTenantId }));
                setSelectedTenantId(userTenantId);
                console.log('🔍 selectedTenantId set to:', userTenantId);
            } else {
                console.log('🔍 No tenant found - checking all sources:', {
                    myTenant: myTenant,
                    agentTenantId: agentTenantId,
                    typedUserTenantId: typedUser?.tenantId,
                    userTenantId: userTenantId,
                    isAgent: isAgent
                });
            }
        } else {
            console.log('🔍 selectedTenantId already set:', selectedTenantId);
        }
    }
    
    // Auto-select current agent for agents
    if (isAgent && currentAgent && mode === 'create' && currentUserId) {
        console.log('🔍 Auto-selecting current agent:', currentAgent);
        setFormData(prev => ({ 
            ...prev, 
            agentId: currentUserId 
        }));
    }
    // Populate form for editing
    if (mode === 'edit' && editingGroup) {
        // Split primary contact into first and last name
        const primaryContactParts = (editingGroup.PrimaryContact || '').split(' ');
        const primaryContactFirstName = primaryContactParts[0] || '';
        const primaryContactLastName = primaryContactParts.slice(1).join(' ') || '';
        
        setFormData({
            name: editingGroup.Name || '',
            primaryContactFirstName: primaryContactFirstName,
            primaryContactLastName: primaryContactLastName,
            contactEmail: editingGroup.ContactEmail || '',
            contactPhone: editingGroup.ContactPhone ? formatPhoneNumber(editingGroup.ContactPhone) : '',
            contactTitle: editingGroup.ContactTitle || '',
            contactPhone2: editingGroup.ContactPhone2 ? formatPhoneNumber(editingGroup.ContactPhone2) : '',
            faxNumber: editingGroup.FaxNumber ? formatPhoneNumber(editingGroup.FaxNumber) : '',
            website: editingGroup.Website || '',
            address: editingGroup.Address || '',
            address2: editingGroup.Address2 || '',
            city: editingGroup.City || '',
            state: editingGroup.State || '',
            zip: editingGroup.Zip || '',
            taxIdNumber: editingGroup.TaxIdNumber || '',
            businessType: editingGroup.BusinessType || '',
            paymentType: '', // Don't pre-fill payment type for edit mode
            creditCardNumber: editingGroup.CreditCardNumber ? `****${editingGroup.CreditCardNumber.slice(-4)}` : '',
            creditCardType: editingGroup.CreditCardType || '',
            creditCardExpiry: editingGroup.CreditCardExpiry || '',
            creditCardName: editingGroup.CreditCardName || '',
            achBankName: editingGroup.ACHBankName || '',
            achAccountType: editingGroup.ACHAccountType || '',
            achRoutingNumber: editingGroup.ACHRoutingNumber || '',
            achAccountNumber: editingGroup.ACHAccountNumber ? `****${editingGroup.ACHAccountNumber.slice(-4)}` : '',
            achAccountName: editingGroup.ACHAccountName || '',
            tenantId: editingGroup.TenantId || '',
            agentId: editingGroup.AgentUserId || editingGroup.AgentId || '', // Use AgentUserId (UserId) first, fallback to AgentId (will need lookup)
            groupType: (editingGroup.GroupType as 'Standard' | 'ListBill') || 'Standard',
            allAboardMasterGroupId: (editingGroup as any).AllAboardMasterGroupId || ''
        });
        setMasterGroupIdSuggested(true); // Don't auto-suggest when editing an existing group
        if(isSysAdmin) {
            setSelectedTenantId(editingGroup.TenantId || null);
        }
        // Logo handling is now done in a separate useEffect
    } else if (mode === 'create') {
        setSelectedTenantId(null);
    }
  }, [isOpen, editingGroup, mode, myTenant, isSysAdmin, typedUser]);

  // Effect to handle logo when editingGroup changes
  useEffect(() => {
    if (mode === 'edit' && editingGroup?.LogoUrl) {
      console.log('🔍 Setting logo from editingGroup:', editingGroup.LogoUrl);
      setExistingLogoUrl(editingGroup.LogoUrl);
      setLogoPreview(editingGroup.LogoUrl);
    } else if (mode === 'create') {
      // Clear logo data for create mode
      setExistingLogoUrl('');
      setLogoPreview('');
      setLogoFile(null);
    }
  }, [editingGroup?.LogoUrl, mode]);

  // Effect to load selected products when editing a group (using hook data)
  useEffect(() => {
    // Only run when modal is open
    if (!isOpen) return;
    
    if (mode === 'edit' && editingGroup?.GroupId) {
      console.log('🔍 Loading selected products for group:', editingGroup.GroupId);
      // Products are now loaded via useGroupProducts hook
      // Process the hook data when it's available
      if (groupProductsData) {
        processGroupProductsData(groupProductsData);
      }
      fetchExistingPaymentMethods(editingGroup.GroupId);
    } else if (mode === 'create') {
      // Clear selected products for create mode
      setSelectedProducts([]);
      setSelectedProductsData([]);
      setExistingPaymentMethods([]);
    }
  }, [isOpen, editingGroup?.GroupId, mode, groupProductsData, includeHiddenGroupProducts]);

  // Load existing vendor network selections in edit mode so the panel pre-fills properly
  useEffect(() => {
    if (!isOpen) return;
    if (mode !== 'edit' || !editingGroup?.GroupId) {
      setVendorNetworkSelections({});
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const resp = await apiService.get<{ success: boolean; data?: Array<{ vendorId: string; vendorNetworkId: string }> }>(`/api/groups/${editingGroup.GroupId}/vendor-networks`);
        if (cancelled || !resp?.success || !Array.isArray(resp.data)) return;
        const map: VendorNetworkSelectionMap = {};
        for (const row of resp.data) {
          if (row?.vendorId) map[row.vendorId] = row.vendorNetworkId || null;
        }
        setVendorNetworkSelections(map);
      } catch (err) {
        console.warn('Failed to fetch group vendor-networks', err);
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, mode, editingGroup?.GroupId]);

  // Fetch enrollment link template count for this group when in edit mode (Agent/TenantAdmin/SysAdmin) for in-modal messaging
  const canAccessEnrollmentLinks = typedUser?.currentRole && ['Agent', 'TenantAdmin', 'SysAdmin'].includes(typedUser.currentRole);
  useEffect(() => {
    if (!isOpen || mode !== 'edit' || !editingGroup?.GroupId || !canAccessEnrollmentLinks) {
      setEnrollmentLinkTemplateCount(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await EnrollmentLinkTemplatesService.getTemplates(
          { groupId: editingGroup.GroupId, templateType: 'Group', limit: 10 },
          typedUser?.currentRole ?? undefined
        );
        if (cancelled) return;
        const data = (res as any)?.data;
        const data2 = (res as any)?.data;
        const templates = data2?.data || [];
        const total = data2?.pagination?.totalCount ?? data2?.totalCount ?? templates.length ?? 0;
        setEnrollmentLinkTemplateCount(typeof total === 'number' ? total : 0);
      } catch {
        if (!cancelled) setEnrollmentLinkTemplateCount(0);
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, mode, editingGroup?.GroupId, canAccessEnrollmentLinks, typedUser?.currentRole]);

  // Debug effect for logo state changes
  useEffect(() => {
    console.log('🔍 Logo state changed:', { logoPreview, existingLogoUrl, logoFile, mode });
  }, [logoPreview, existingLogoUrl, logoFile, mode]);

  // Effect to handle agent selection after agents are loaded
  useEffect(() => {
    if (!isOpen) return;
    
    // For agents, we don't need to wait for agentsForTenant since we use the current user
    if (isAgent) {
      console.log('🔍 Agent selection useEffect for Agent role:', {
        mode,
        currentAgent: !!currentAgent,
        formDataAgentId: formData.agentId,
        agentOptions: agentOptions.length
      });
      
      // For create mode, auto-select the current agent if not already set
      if (mode === 'create' && currentAgent && currentUserId && !formData.agentId) {
        const agentId = currentUserId;
        console.log('🔍 Auto-selecting current agent for create mode:', agentId);
        setFormData(prev => ({ ...prev, agentId: agentId || '' }));
      }
      
      // Edit mode: one-time hydrate from editingGroup when options load (do not overwrite user changes)
      if (mode === 'edit' && (editingGroup?.AgentUserId || editingGroup?.AgentId)) {
        const userIdToMatch = editingGroup.AgentUserId || editingGroup.AgentId;
        const agentExists = agentOptions.find(agent => agent.value === userIdToMatch);
        if (agentExists && !agentHydratedFromEditRef.current && !userEditedAgentRef.current) {
          setFormData(prev => ({ ...prev, agentId: userIdToMatch || '' }));
          agentHydratedFromEditRef.current = true;
        }
      }
      return;
    }
    
    // For non-agents, wait for agentsForTenant to be loaded
    if (!agentsForTenant || agentsForTenant.length === 0) return;
    
    console.log('🔍 Agent selection useEffect for non-Agent role:', {
      mode,
      editingGroupAgentId: editingGroup?.AgentId,
      editingGroupAgentUserId: editingGroup?.AgentUserId,
      formDataAgentId: formData.agentId,
      agentsForTenant: agentsForTenant.length,
      agentOptions: agentOptions.length
    });
    
    if (mode === 'edit' && (editingGroup?.AgentUserId || editingGroup?.AgentId)) {
      const userIdToMatch = editingGroup.AgentUserId || editingGroup.AgentId;
      const agentExists = agentOptions.find(agent => agent.value === userIdToMatch);
      if (agentExists && !agentHydratedFromEditRef.current && !userEditedAgentRef.current) {
        setFormData(prev => ({ ...prev, agentId: userIdToMatch || '' }));
        agentHydratedFromEditRef.current = true;
      } else if (!agentExists) {
        console.log('🔍 Agent not found in options:', userIdToMatch, 'Available:', agentOptions.map(a => a.value));
      }
    }
  }, [isOpen, agentsForTenant, agentOptions, mode, editingGroup?.AgentUserId, editingGroup?.AgentId, isAgent, currentAgent, currentUserId]);

  // Effect to fetch products when tenant is set for non-SysAdmin users
  useEffect(() => {
    // Only run when modal is open
    if (!isOpen) return;
    
    console.log('🔍 Products useEffect triggered:', {
      isOpen,
      isSysAdmin,
      selectedTenantId,
      loadingProducts,
      isTenantAdmin,
      isAgent,
      myTenant: typeof myTenant === 'string' ? myTenant : myTenant?.TenantId,
      myTenantType: typeof myTenant
    });
    
    // Simple fix: If selectedTenantId is null but we have tenant data, set it
    if (!selectedTenantId && !isSysAdmin && (myTenant || typedUser?.tenantId)) {
      const tenantId = typeof myTenant === 'string' || myTenant instanceof String ? 
        String(myTenant) : 
        (myTenant?.TenantId || typedUser?.tenantId);
      
      if (tenantId) {
        console.log('🔍 Setting selectedTenantId directly:', tenantId);
        setSelectedTenantId(tenantId);
        setFormData(prev => ({ ...prev, tenantId }));
        return; // Exit early to prevent immediate product fetch
      }
    }
    
    // For non-SysAdmin users, fetch products when we have selectedTenantId
    if (!isSysAdmin && selectedTenantId && !loadingProducts) {
      console.log('🔍 Fetching products for non-SysAdmin user with tenant:', selectedTenantId);
      fetchProductsForTenant(selectedTenantId);
    }
  }, [isOpen, selectedTenantId, myTenant, typedUser?.tenantId, isSysAdmin, showHiddenGroupProducts]);


  const resetForm = () => {
    setFormData({
        name: '', primaryContactFirstName: '', primaryContactLastName: '', contactEmail: '', contactPhone: '', contactTitle: '', contactPhone2: '',
        faxNumber: '', website: '', address: '', address2: '', city: '', state: '', zip: '', taxIdNumber: '',
        businessType: '', paymentType: '', creditCardNumber: '', creditCardType: '', creditCardExpiry: '', creditCardName: '',
        achBankName: '', achAccountType: '', achRoutingNumber: '', achAccountNumber: '', achAccountName: '',
        tenantId: '', agentId: '', groupType: 'Standard'
    });
    setLogoFile(null);
    setLogoPreview('');
    setExistingLogoUrl('');
    setIsSubmitting(false);
    setSelectedTenantId(null);
    setActiveTab('basic');
    setSelectedProducts([]);
    setSelectedProductsData([]);
    setProductSearchTerm('');
    setShowHiddenGroupProducts(false);
    setShowProductModal(false);
    setShowQuickSendDialog(false);
    setQuickSendData({ firstName: '', lastName: '', email: '' });
    setCreateOnboardingLink(true); // Reset to default
    setFirstEffectiveDate('');
    setAllowMidMonthEffectiveOnCreate(false);
    setFirstEffectiveDateError(null);
  };

  // Fetch products when tenant changes
  useEffect(() => {
    if (selectedTenantId && isOpen) {
      console.log('🔍 Tenant changed, fetching products for:', selectedTenantId);
      fetchProductsForTenant(selectedTenantId);
    }
  }, [selectedTenantId, isOpen, showHiddenGroupProducts]);

  // Format phone number as user types (displays formatted but stores digits only)
  const formatPhoneInput = (value: string): string => {
    // Remove all non-digit characters
    const digits = value.replace(/\D/g, '');
    
    // Limit to 10 digits (area code + 7 digits)
    const limitedDigits = digits.slice(0, 10);
    
    // Format as (123) 456-7890
    if (limitedDigits.length === 0) return '';
    if (limitedDigits.length <= 3) return `(${limitedDigits}`;
    if (limitedDigits.length <= 6) return `(${limitedDigits.slice(0, 3)}) ${limitedDigits.slice(3)}`;
    return `(${limitedDigits.slice(0, 3)}) ${limitedDigits.slice(3, 6)}-${limitedDigits.slice(6)}`;
  };

  // Get digits only from formatted phone number
  const getPhoneDigits = (value: string): string => {
    return value.replace(/\D/g, '');
  };

  // Validate phone number (must be exactly 10 digits)
  const validatePhoneNumber = (value: string): boolean => {
    const digits = getPhoneDigits(value);
    return digits.length === 10;
  };

  const handleInputChange = (field: keyof GroupFormData, value: string) => {
    if (field === 'agentId' && mode === 'edit') {
      userEditedAgentRef.current = true;
    }
    // Handle phone number fields with formatting
    if (field === 'contactPhone' || field === 'contactPhone2' || field === 'faxNumber') {
      // Format the display value as user types
      const formattedValue = formatPhoneInput(value);
      setFormData(prev => ({ ...prev, [field]: formattedValue }));
    } else {
      setFormData(prev => ({ ...prev, [field]: value }));
    }
    
    if (field === 'tenantId') {
        setSelectedTenantId(value);
        setFormData(prev => ({ ...prev, agentId: '' })); // Reset agent when tenant changes
        setAgentSearchQuery(''); // Reset agent search when tenant changes
        setSelectedAgentOption(null); // Reset stored selection
    }
  };

  // Product loading functionality
  const fetchProductsForTenant = async (tenantId: string) => {
    if (!tenantId) return;
    
    try {
      setLoadingProducts(true);
      console.log('🔍 Fetching products for tenant:', tenantId);
      console.log('🔍 User role info:', {
        isSysAdmin,
        isTenantAdmin,
        isAgent,
        currentRole: typedUser?.currentRole,
        userObject: typedUser
      });
      
      let endpoint = '';
      if (isSysAdmin) {
        // SysAdmin uses tenant-specific endpoint with status filter for active subscriptions
        endpoint = `/api/tenants/${tenantId}/products?status=Active`;
      } else {
        // TenantAdmin and Agent use the same endpoint - returns only active subscribed products
        // Use activeOnly=true to filter out Pending products for group creation
        // TenantAdmin can include hidden (Hide from Groups) products when toggled
        const hiddenQs = includeHiddenGroupProducts ? '&includeHidden=true' : '';
        endpoint = `/api/tenant/products?activeOnly=true${hiddenQs}`;
      }
      
      console.log('🔍 Using endpoint:', endpoint);
      const response = await apiService.get(endpoint) as any;
      console.log('✅ Products fetched successfully:', response);
      
      if (response.success && response.data) {
        // Filter out products where IsHidden = 1 (Hide from Groups). SalesType
        // filtering is applied at display time in the picker so that switching
        // the GroupType radio re-renders the picker without a refetch.
        const filteredProducts = response.data.filter((product: any) => {
          const isHidden = isProductHiddenForGroup(product);
          if (!includeHiddenGroupProducts && isHidden) return false;
          return true;
        });
        
        console.log(`✅ Filtered products: ${filteredProducts.length} of ${response.data.length} products`);
        console.log('🔍 Sample filtered product:', filteredProducts[0]);
        setAvailableProducts(filteredProducts);
      } else {
        console.log('⚠️ No products in response or unsuccessful response');
        setAvailableProducts([]);
      }
    } catch (error) {
      console.error('❌ Error fetching products:', error);
      console.log('🔍 Error details:', {
        tenantId,
        userRole: typedUser?.currentRole
      });
      setAvailableProducts([]);
    } finally {
      setLoadingProducts(false);
    }
  };

  const handleAddProduct = (product: any) => {
    const productId = String(product.productId || product.ProductId || '');
    
    // Check if product is already selected
    if (selectedProducts.includes(productId)) {
      console.log('⚠️ Product already selected:', product.Name || product.name);
      return;
    }
    
    console.log('➕ Adding product to group:', product.Name || product.name);
    setSelectedProducts(prev => [...prev, productId]);
    
    // Also add to selectedProductsData if not already there
    setSelectedProductsData(prev => {
      const exists = prev.find(
        (p) => String(p.ProductId || '').toLowerCase() === productId.toLowerCase()
      );
      if (exists) return prev;
      
      return [...prev, {
        ProductId: productId,
        Name: product.Name || product.name || product.ProductName,
        ProductType: product.ProductType || product.productType,
        Description: product.Description || product.description,
        ProductImageUrl: product.ProductImageUrl || product.ProductLogoUrl || product.productImageUrl || product.productLogoUrl,
        ProductLogoUrl: product.ProductLogoUrl || product.productLogoUrl,
        ProductOwner: product.ProductOwner || product.productOwner,
        vendorName: product.vendorName || product.VendorName || null,
        vendorMinimumEmployeesPerGroup:
          product.vendorMinimumEmployeesPerGroup ??
          product.VendorMinimumEmployeesPerGroup ??
          null,
        // Carry forward fields the network picker needs to detect qualifying vendors.
        vendorId: product.vendorId || product.VendorId || null,
        idCardData: product.idCardData ?? null,
        includedProducts: product.includedProducts ?? product.bundleProducts ?? null
      }];
    });
  };

  const handleRemoveProduct = (productId: string) => {
    const id = String(productId);
    if (productIdsWithEnrollments.includes(id)) {
      onNotification?.(GROUPS_ADD_GROUP_ENROLLMENT_REMOVE_MSG, 'warning');
      return;
    }
    console.log('➖ Removing product from group:', productId);
    setSelectedProducts(prev => prev.filter(p => p !== id));
    setSelectedProductsData(prev => prev.filter(p => String(p.ProductId) !== id));
  };

  // Fetch selected products for a group (kept for backward compatibility, but now uses hook)
  const fetchGroupProducts = async (groupId: string) => {
    try {
      console.log('🔍 Fetching products for group:', groupId);
      console.log('🔍 User role info:', {
        currentRole: localStorage.getItem('currentRole'),
        roles: localStorage.getItem('roles'),
        isSysAdmin,
        isTenantAdmin,
        isAgent
      });
      const response = await GroupProductsService.getGroupProducts(groupId);
      
      console.log('🔍 Full response from GroupProductsService:', response);
      console.log('🔍 Sample groupProduct:', response.data?.groupProducts?.[0]);
      console.log('🔍 Sample availableProduct:', response.data?.availableProducts?.[0]);
      
      // Handle different data structures like GroupProductsTab does
      let data = response.data;
      if (response.success && data) {
        // Handle nested data structure
        if ((data as any).data) {
          data = (data as any).data;
        }
        
        // Extract groupProducts from various possible structures
        let groupProducts = [];
        if (Array.isArray(data)) {
          // If data is an array, it might be the groupProducts directly
          groupProducts = data;
        } else if (data.groupProducts) {
          // If data is an object with groupProducts property
          groupProducts = data.groupProducts;
        } else if ((data as any).data && (data as any).data.groupProducts) {
          // If data has a nested data property
          groupProducts = (data as any).data.groupProducts;
        } else if ((data as any).data && Array.isArray((data as any).data)) {
          // If data.data is an array
          groupProducts = (data as any).data;
        }
        
        console.log('🔍 Group products extracted:', groupProducts);
        console.log('🔍 Group products length:', groupProducts.length);
        
        if (groupProducts && groupProducts.length > 0) {
          const activeProducts = groupProducts.filter((gp: any) => gp.IsActive);
          
          const filteredSelectedProducts = activeProducts;
          
          const productIds = filteredSelectedProducts.map((gp: any) => gp.ProductId);
          
          // Store the full product data for selected products
          // This ensures we can display them even if they're not in availableProducts yet
          setSelectedProductsData(filteredSelectedProducts.map((gp: any) => ({
            ProductId: gp.ProductId,
            Name: gp.Name || gp.ProductName,
            ProductType: gp.ProductType,
            Description: gp.Description,
            ProductImageUrl: gp.ProductImageUrl,
            ProductLogoUrl: gp.ProductLogoUrl,
            ProductOwner: gp.ProductOwner,
            IsHidden: gp.IsHidden,
            IsCatalogHidden: gp.IsCatalogHidden ?? 0,
            IsBundle: gp.IsBundle,
            SalesType: gp.SalesType || gp.salesType,
            vendorId: gp.vendorId || gp.VendorId || null,
            idCardData: gp.idCardData ?? null,
            includedProducts: gp.includedProducts ?? gp.bundleProducts ?? null
          })));
          
          console.log('✅ Loaded selected products:', productIds);
          console.log('✅ Loaded selected products data:', filteredSelectedProducts.length, 'products (filtered from', activeProducts.length, ')');
          setSelectedProducts(productIds);
          setNetworkModalAutoOpened(new Set(productIds));
        } else {
          console.log('⚠️ No active products found in groupProducts array');
          setSelectedProducts([]);
          setSelectedProductsData([]);
        }
        
        // Also update availableProducts if they're included in the response
        let availableProducts = [];
        if (data.availableProducts && Array.isArray(data.availableProducts)) {
          availableProducts = data.availableProducts;
        } else if ((data as any).data && (data as any).data.availableProducts) {
          availableProducts = (data as any).data.availableProducts;
        }
        
        if (availableProducts && availableProducts.length > 0) {
          // Filter out hidden products and products with wrong salesType
          const filteredAvailableProducts = availableProducts.filter((p: any) => {
            // Filter out hidden products
            const isHidden = p.IsHidden === true || p.IsHidden === 1 || 
                            p.isHidden === true || p.isHidden === 1 ||
                            p.IsHidden === 'true' || p.isHidden === 'true';
            if (isHidden) {
              console.log('🔍 Filtering out hidden available product:', p.Name || p.ProductName);
              return false;
            }
            
            // For all products, only show if salesType is 'Group' or 'Both' (case-insensitive)
            const salesType = (p.SalesType || p.salesType || '').toString().trim();
            if (salesType && salesType.toLowerCase() !== 'group' && salesType.toLowerCase() !== 'both') {
              console.log('🔍 Filtering out available product (wrong salesType):', p.Name || p.ProductName, { SalesType: p.SalesType, salesType: p.salesType });
              return false;
            }
            
            console.log('✅ Available product passed filter:', p.Name || p.ProductName);
            return true;
          });
          
          console.log('🔍 Merging filtered available products from response:', filteredAvailableProducts.length, 'of', availableProducts.length);
          setAvailableProducts(prev => {
            // Merge with existing, avoiding duplicates
            const existingIds = new Set(prev.map(p => p.ProductId || p.productId));
            const newProducts = filteredAvailableProducts.filter((p: any) => 
              !existingIds.has(p.ProductId || p.productId)
            );
            return [...prev, ...newProducts];
          });
        }
      } else {
        console.log('⚠️ No products found for group or unsuccessful response:', {
          success: response.success,
          hasData: !!response.data,
          message: response.message
        });
        setSelectedProducts([]);
        setSelectedProductsData([]);
      }
    } catch (error) {
      console.error('❌ Error fetching group products:', error);
      setSelectedProducts([]);
      setSelectedProductsData([]);
    }
  };

  // Fetch existing payment methods for a group
  const fetchExistingPaymentMethods = async (groupId: string) => {
    try {
      setLoadingPaymentMethods(true);
      console.log('🔍 Fetching payment methods for group:', groupId);
      const response = await GroupsService.getGroupBillingData(groupId, {
        invoiceLimit: 0,
        paymentLimit: 0
      });
      
      console.log('🔍 Payment methods response:', response);
      
      if (response.success && response.data) {
        // Handle both single payment method and multiple payment methods
        let paymentMethods = [];
        if ((response.data as any).paymentMethods && Array.isArray((response.data as any).paymentMethods) && (response.data as any).paymentMethods.length > 0) {
          paymentMethods = (response.data as any).paymentMethods;
        } else if (response.data.paymentMethod) {
          paymentMethods = [response.data.paymentMethod];
        }
        
        console.log('✅ Loaded payment methods:', paymentMethods.length);
        setExistingPaymentMethods(paymentMethods);
      } else {
        console.log('⚠️ No payment methods found for group');
        setExistingPaymentMethods([]);
      }
    } catch (error) {
      console.error('❌ Error fetching payment methods:', error);
      setExistingPaymentMethods([]);
    } finally {
      setLoadingPaymentMethods(false);
    }
  };

  const handleLogoUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    console.log('📁 Logo file selected:', file);
    if (file) {
      setLogoFile(file);
      const reader = new FileReader();
      reader.onload = (e) => setLogoPreview(e.target?.result as string);
      reader.readAsDataURL(file);
      console.log('✅ Logo file set and preview generated');
    }
  };

  const handleRemoveLogo = () => {
    setLogoFile(null);
    setLogoPreview(existingLogoUrl);
  };

  // Check if payment info has been provided
  const hasPaymentInfo = (): boolean => {
    // Check if payment type is selected and has required fields
    if (formData.paymentType === 'ACH') {
      return !!(formData.achBankName || formData.achRoutingNumber || formData.achAccountNumber);
    } else if (formData.paymentType === 'CreditCard') {
      return !!(formData.creditCardNumber || formData.creditCardName);
    }
    return false;
  };

  // Validation functions
  const validateCurrentTab = () => {
    switch (activeTab) {
      case 'basic':
        // Required fields for basic tab:
        // 1. Group Name (always required)
        // 2. Tenant ID (required for SysAdmin in create mode, auto-set for others)
        // 3. Agent ID (always required - user wants this to be mandatory)
        // Note: Primary contact fields moved to business tab and no longer required on basic tab
        
        const hasGroupName = formData.name && formData.name.trim() !== '';
        const hasTenant = isSysAdmin && mode === 'create' ? 
          (formData.tenantId && formData.tenantId.trim() !== '') : 
          true; // For non-SysAdmin users, tenant is auto-set
        const hasAgent = formData.agentId && formData.agentId.trim() !== '';
        
        if (mode === 'create') {
          return hasGroupName && hasTenant && hasAgent && !!firstEffectiveDate && !firstEffectiveDateError;
        }
        return hasGroupName && hasTenant && hasAgent;
      case 'products':
        // Required: At least one product must be selected (only for create mode)
        // For edit mode, allow saving with no products (user may be removing all products)
        if (mode === 'edit') {
          return true; // Allow saving in edit mode even with no products
        }
        return selectedProducts && selectedProducts.length > 0;
      case 'business':
        // Required fields for business tab:
        // 1. Primary Contact First Name (always required)
        // 2. Primary Contact Last Name (always required)  
        // 3. Contact Email (always required)
        // Note: Primary Phone is optional (not required)
        
        const hasContactInfo = formData.primaryContactFirstName && formData.primaryContactFirstName.trim() !== '' &&
                              formData.primaryContactLastName && formData.primaryContactLastName.trim() !== '' &&
                              formData.contactEmail && formData.contactEmail.trim() !== '';
        
        // Phone number is optional - validate format if provided, but don't require it
        const hasValidPhone = !formData.contactPhone || validatePhoneNumber(formData.contactPhone);
        
        return hasContactInfo && hasValidPhone;
      case 'address':
        // If payment info is provided, address is required
        if (hasPaymentInfo()) {
          const hasRequiredAddress = formData.address && formData.address.trim() !== '' &&
                                     formData.city && formData.city.trim() !== '' &&
                                     formData.state && formData.state.trim() !== '' &&
                                     formData.zip && formData.zip.trim() !== '';
          return hasRequiredAddress;
        }
        return true; // No required fields if no payment info
      case 'payment':
        return true; // No required fields in payment tab (optional)
      case 'documents':
        return true; // No required fields in documents tab
      default:
        return true;
    }
  };

  // Largest vendor minimum across selected products. Drives the "I acknowledge…"
  // checkbox on the Products tab and gates Next + Quick Send when > 0.
  // Reads either casing because endpoints differ across roles.
  const maxVendorMinimumForSelectedProducts = (() => {
    let max = 0;
    selectedProducts.forEach((productId) => {
      const normalizedId = String(productId || '').toLowerCase();
      const product =
        availableProducts.find(
          (p) => String(p.ProductId || p.productId || '').toLowerCase() === normalizedId
        ) ||
        selectedProductsData.find(
          (p) => String(p.ProductId || '').toLowerCase() === normalizedId
        );
      if (!product) return;
      const minimum =
        product.vendorMinimumEmployeesPerGroup ??
        product.VendorMinimumEmployeesPerGroup ??
        null;
      if (minimum != null && Number(minimum) > max) max = Number(minimum);
    });
    return max;
  })();

  // List-bill groups have no participation floor, so the vendor-minimum
  // acknowledgment doesn't apply regardless of what the vendor configured.
  const vendorMinimumApplies =
    maxVendorMinimumForSelectedProducts > 0 && formData.groupType !== 'ListBill';

  // Reset the acknowledgment whenever the binding minimum changes (selection
  // changed, vendor swapped, etc.) so the agent doesn't auto-confirm a number
  // they never actually saw.
  useEffect(() => {
    setVendorMinimumAcknowledged(false);
  }, [maxVendorMinimumForSelectedProducts]);

  // Tenant-configured buffer between the enrollment-minimum deadline and the
  // effective date. Pulled from AdvancedSettings.enrollment. When unset/0 the
  // acknowledgment reads "by the effective date".
  const enrollmentDeadlineDaysBeforeEffectiveDate = (() => {
    const raw = (myTenant as any)?.AdvancedSettings ?? (myTenant as any)?.advancedSettings;
    if (!raw) return 0;
    let parsed: any = raw;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch { return 0; }
    }
    const v = parsed?.enrollment?.enrollmentDeadlineDaysBeforeEffectiveDate;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  })();

  const firstEffectiveDateOptions = useMemo(
    () => buildFirstEffectiveDateOptions(allowMidMonthEffectiveOnCreate),
    [allowMidMonthEffectiveOnCreate]
  );

  useEffect(() => {
    if (!isOpen || mode !== 'create') return;
    if (firstEffectiveDate && firstEffectiveDateOptions.includes(firstEffectiveDate)) return;
    if (firstEffectiveDateOptions.length > 0) {
      setFirstEffectiveDate(firstEffectiveDateOptions[0]);
    }
  }, [isOpen, mode, firstEffectiveDateOptions]);

  useEffect(() => {
    if (!firstEffectiveDate) {
      setFirstEffectiveDateError(null);
      return;
    }
    if (!firstEffectiveDateOptions.includes(firstEffectiveDate)) {
      setFirstEffectiveDateError(
        allowMidMonthEffectiveOnCreate
          ? 'Choose the 1st or 15th of a future month.'
          : 'Choose the 1st of a future month.'
      );
      return;
    }
    setFirstEffectiveDateError(null);
  }, [firstEffectiveDate, firstEffectiveDateOptions, allowMidMonthEffectiveOnCreate]);

  const computedEnrollmentPeriodPreview = useMemo(() => {
    if (!firstEffectiveDate || firstEffectiveDateError) return null;
    const result = computeInitialEnrollmentPeriodFromFirstEffective(firstEffectiveDate);
    return 'error' in result ? null : result;
  }, [firstEffectiveDate, firstEffectiveDateError]);

  const enrollmentMinimumDeadlineYmd = useMemo(() => {
    if (!firstEffectiveDate || enrollmentDeadlineDaysBeforeEffectiveDate <= 0) return null;
    return addDaysYmd(firstEffectiveDate, -enrollmentDeadlineDaysBeforeEffectiveDate);
  }, [firstEffectiveDate, enrollmentDeadlineDaysBeforeEffectiveDate]);

  const resolveInitialEnrollmentPeriodForSubmit = (): InitialEnrollmentPeriodPayload | string => {
    if (!firstEffectiveDate) {
      return 'Please select a first effective date.';
    }
    if (!isFutureDateYmd(firstEffectiveDate)) {
      return 'First effective date must be in the future.';
    }
    if (!isValidFirstEffectiveDayOfMonth(firstEffectiveDate, allowMidMonthEffectiveOnCreate)) {
      return allowMidMonthEffectiveOnCreate
        ? 'First effective date must be the 1st or 15th of a month.'
        : 'First effective date must be the 1st of a month.';
    }
    const period = computeInitialEnrollmentPeriodFromFirstEffective(firstEffectiveDate);
    if ('error' in period) {
      return period.error;
    }
    return {
      ...period,
      allowMidMonthEffective: allowMidMonthEffectiveOnCreate || undefined
    };
  };

  const canProceedToNext = () => {
    if (!validateCurrentTab()) return false;
    // Products tab: if any selected product carries a vendor minimum, require the
    // acknowledgment box to be ticked before moving on.
    if (mode === 'create' && activeTab === 'products' && vendorMinimumApplies && !vendorMinimumAcknowledged) {
      return false;
    }
    return true;
  };

  // Validation for Quick Send - checks basic group info and products since recipient details are entered in the modal
  const canQuickSend = () => {
    // Basic tab requirements - recipient details are entered in the Quick Send modal
    const hasGroupName = formData.name && formData.name.trim() !== '';
    const hasTenant = isSysAdmin && mode === 'create' ?
      (formData.tenantId && formData.tenantId.trim() !== '') :
      true; // For non-SysAdmin users, tenant is auto-set
    const hasAgent = formData.agentId && formData.agentId.trim() !== '';

    // Products requirement - at least one product must be selected
    const hasProducts = selectedProducts && selectedProducts.length > 0;

    // If any selected product has a vendor minimum, the agent must acknowledge.
    // List-bill groups bypass this — no participation floor applies.
    const minimumOk = !vendorMinimumApplies || vendorMinimumAcknowledged;

    return hasGroupName && hasTenant && hasAgent && hasProducts && minimumOk;
  };

  const handleSubmit = async (shouldCreateOnboardingLink?: boolean) => {
    if (isSubmitting) return; // Prevent double submission
    
    // Use the parameter if provided, otherwise use the state
    const willCreateOnboardingLink = shouldCreateOnboardingLink !== undefined 
      ? shouldCreateOnboardingLink 
      : createOnboardingLink;
    
    // Validate required fields
    // For create mode with onboarding link: phone number will be collected during onboarding
    // For edit mode: phone number should already exist or can be left empty
    const isCreatingWithOnboarding = mode === 'create';
    
    if (!formData.name || !formData.primaryContactFirstName || !formData.primaryContactLastName || !formData.contactEmail || !formData.agentId || (mode === 'create' && !formData.tenantId)) {
      alert(`Please fill in all required fields: Group Name, Assigned Agent, Primary Contact Information (First Name, Last Name, Email), and Tenant (if applicable)`);
      return;
    }
    
    // Products are required for create mode, but optional for edit mode (user may be removing all products)
    if (mode === 'create' && (!selectedProducts || selectedProducts.length === 0)) {
      alert('At least one product must be selected when creating a group.');
      return;
    }

    let initialEnrollmentPeriod: InitialEnrollmentPeriodPayload | undefined;
    if (mode === 'create') {
      const periodResult = resolveInitialEnrollmentPeriodForSubmit();
      if (typeof periodResult === 'string') {
        alert(periodResult);
        return;
      }
      initialEnrollmentPeriod = periodResult;
    }
    
    // Validate Primary Phone if provided (must be 10 digits if not empty)
    // Phone number is optional - only validate format if provided
    if (formData.contactPhone && !validatePhoneNumber(formData.contactPhone)) {
      alert('Primary Phone must be a valid 10-digit phone number (including area code) if provided.');
      return;
    }
    
    // Validate Secondary Phone if provided (must be 10 digits if not empty)
    if (formData.contactPhone2 && !validatePhoneNumber(formData.contactPhone2)) {
      alert('Secondary Phone must be a valid 10-digit phone number (including area code) if provided.');
      return;
    }
    
    // Validate Fax Number if provided (must be 10 digits if not empty)
    if (formData.faxNumber && !validatePhoneNumber(formData.faxNumber)) {
      alert('Fax Number must be a valid 10-digit phone number (including area code) if provided.');
      return;
    }
    
    setIsSubmitting(true);
    setSubmitError(null);
    
    try {
      // Edit mode: if products changed, confirm before updating (enrollment links will be synced)
      if (mode === 'edit' && editingGroup?.GroupId && selectedProducts) {
        const gp = groupProductsData?.groupProducts ?? (groupProductsData as any)?.data?.groupProducts ?? [];
        const initialProductIds = gp.filter((p: any) => p.IsActive !== false).map((p: any) => p.ProductId).filter(Boolean).sort();
        const newProductIds = [...selectedProducts].sort();
        const productsChanged = initialProductIds.length !== newProductIds.length || initialProductIds.some((id: string, i: number) => id !== newProductIds[i]);
        if (productsChanged && selectedProducts.length > 0) {
          let totalCount = enrollmentLinkTemplateCount ?? 0;
          if (totalCount === 0 && canAccessEnrollmentLinks) {
            const res = await EnrollmentLinkTemplatesService.getTemplates(
              { groupId: editingGroup.GroupId, limit: 1 },
              typedUser?.currentRole ?? undefined
            );
            const data = (res as any)?.data;
            totalCount = data?.pagination?.totalCount ?? data?.totalCount ?? 0;
          }
          if (totalCount > 0 && !window.confirm(`${totalCount} enrollment link template(s) will be updated to reflect these products. Continue?`)) {
            setIsSubmitting(false);
            return;
          }
        }
      }

      // Convert phone numbers to digits only before submitting
      const phoneDigits = {
        contactPhone: getPhoneDigits(formData.contactPhone),
        contactPhone2: formData.contactPhone2 ? getPhoneDigits(formData.contactPhone2) : '',
        faxNumber: formData.faxNumber ? getPhoneDigits(formData.faxNumber) : ''
      };
      
      // For create mode, we need to handle the onboarding link creation
      if (mode === 'create') {
        // Combine first and last name for primary contact
        const groupData = { 
          ...formData,
          ...phoneDigits, // Override with digits-only phone numbers
          primaryContact: `${formData.primaryContactFirstName} ${formData.primaryContactLastName}`.trim(),
          primaryContactFirstName: formData.primaryContactFirstName,
          primaryContactLastName: formData.primaryContactLastName,
          selectedProducts,
          vendorNetworkSelections,
          logoFile: logoFile || undefined, // Only include if new file selected
          existingLogoUrl: !logoFile ? existingLogoUrl : undefined, // Only include existing if no new file
          mode, 
          groupId: (mode as string) === 'edit' ? editingGroup?.GroupId : undefined,
          createOnboardingLink: willCreateOnboardingLink, // Use parameter to control onboarding link creation
          initialEnrollmentPeriod
        };
        delete (groupData as { allAboardMasterGroupId?: string }).allAboardMasterGroupId;
        
        console.log('📤 Submitting group data with logo:', {
          hasLogoFile: !!logoFile,
          logoFileName: logoFile?.name,
          existingLogoUrl,
          mode
        });
        
        // Call the parent's onSubmit to create the group
        await onSubmit(groupData);
        
        // The parent will handle the creation and show the onboarding modal
      } else {
        // For edit mode, just submit normally
        const groupData = { 
          ...formData,
          ...phoneDigits, // Override with digits-only phone numbers
          primaryContact: `${formData.primaryContactFirstName} ${formData.primaryContactLastName}`.trim(),
          primaryContactFirstName: formData.primaryContactFirstName,
          primaryContactLastName: formData.primaryContactLastName,
          selectedProducts,
          vendorNetworkSelections,
          logoFile: logoFile || undefined, // Only include if new file selected
          existingLogoUrl: !logoFile ? existingLogoUrl : undefined, // Only include existing if no new file
          mode, 
          groupId: mode === 'edit' ? editingGroup?.GroupId : undefined 
        };
        
        console.log('📤 Submitting group data for edit with logo:', {
          hasLogoFile: !!logoFile,
          logoFileName: logoFile?.name,
          existingLogoUrl,
          mode,
          groupId: editingGroup?.GroupId
        });
        
        await onSubmit(groupData);
      }
    } catch (error) {
      console.error('Error submitting group:', error);
      setSubmitError(getGroupFormErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleQuickSend = async () => {
    if (isSubmitting) return; // Prevent double submission
    
    // Only validate basic group info for Quick Send - recipient details are in the modal
    // Phone number will be collected during onboarding, so it's not required here
    if (!formData.name || !formData.agentId || (mode === 'create' && !formData.tenantId)) {
      alert(`Please fill in all required fields: Group Name, Assigned Agent, and Tenant (if applicable)`);
      return;
    }

    if (!quickSendData.firstName || !quickSendData.lastName || !quickSendData.email) {
      alert('Please fill in the recipient details for the quick send');
      return;
    }
    
    // Validate Secondary Phone if provided (optional)
    if (formData.contactPhone2 && !validatePhoneNumber(formData.contactPhone2)) {
      alert('Secondary Phone must be a valid 10-digit phone number (including area code) if provided.');
      return;
    }
    
    // Validate Fax Number if provided (optional)
    if (formData.faxNumber && !validatePhoneNumber(formData.faxNumber)) {
      alert('Fax Number must be a valid 10-digit phone number (including area code) if provided.');
      return;
    }
    
    setIsSubmitting(true);
    setSubmitError(null);
    
    try {
      // Convert phone numbers to digits only before submitting
      const phoneDigits = {
        contactPhone: getPhoneDigits(formData.contactPhone),
        contactPhone2: formData.contactPhone2 ? getPhoneDigits(formData.contactPhone2) : '',
        faxNumber: formData.faxNumber ? getPhoneDigits(formData.faxNumber) : ''
      };
      
      // For Quick Send, use the recipient details from the modal as the primary contact
      const groupData = { 
        ...formData,
        ...phoneDigits, // Override with digits-only phone numbers
        primaryContact: `${quickSendData.firstName} ${quickSendData.lastName}`.trim(),
        primaryContactFirstName: quickSendData.firstName,
        primaryContactLastName: quickSendData.lastName,
        contactEmail: quickSendData.email, // Use recipient email as primary contact email
        selectedProducts,
        vendorNetworkSelections,
        logoFile: logoFile || undefined, // Only include if new file selected
        existingLogoUrl: !logoFile ? existingLogoUrl : undefined, // Only include existing if no new file
        mode, 
        groupId: (mode as string) === 'edit' ? editingGroup?.GroupId : undefined,
        createOnboardingLink: true, // This indicates we want to create an onboarding link
        quickSend: true, // This indicates we want to use quick send
        quickSendRecipient: {
          firstName: quickSendData.firstName,
          lastName: quickSendData.lastName,
          email: quickSendData.email
        }
      };

      const periodResult = resolveInitialEnrollmentPeriodForSubmit();
      if (typeof periodResult === 'string') {
        alert(periodResult);
        setIsSubmitting(false);
        return;
      }
      (groupData as any).initialEnrollmentPeriod = periodResult;
      
      console.log('📤 Quick send - Submitting group data with recipient:', {
        hasLogoFile: !!logoFile,
        logoFileName: logoFile?.name,
        existingLogoUrl,
        recipient: quickSendData
      });
      
      // Call the parent's onSubmit to create the group and send the invite
      await onSubmit(groupData);
      
      // Close the dialog
      setShowQuickSendDialog(false);
      setQuickSendData({ firstName: '', lastName: '', email: '' });
      
    } catch (error) {
      console.error('Error in quick send:', error);
      setSubmitError(getGroupFormErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  };





  if (!isOpen) return null;

  const tabs = [
    { id: 'basic', label: 'Basic Info', icon: Building },
    { id: 'products', label: 'Products', icon: Package },
    { id: 'business', label: 'Business Info', icon: Building },
    { id: 'payment', label: 'Payment Info', icon: CreditCard },
    { id: 'address', label: 'Address Info', icon: Landmark },
    { id: 'documents', label: 'Logo & Docs', icon: Upload }
  ];

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200 flex-shrink-0">
          <h3 className="text-xl font-semibold text-gray-900 flex items-center space-x-2">
            <Building className="h-6 w-6 text-oe-primary" />
            <span>
              {mode === 'create'
                ? 'Create New Group'
                : productsOnly
                  ? `Manage Products: ${editingGroup?.Name}`
                  : `Edit Group: ${editingGroup?.Name}`}
            </span>
          </h3>
          <button onClick={() => { onClose(); resetForm(); }} className="text-gray-400 hover:text-gray-500">
            <X className="h-6 w-6" />
          </button>
        </div>

        {submitError && (
          <div className="px-6 pt-4 flex-shrink-0" role="alert">
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              {submitError}
            </div>
          </div>
        )}

        {/* Tabs (hidden in productsOnly mode — only the Products tab content renders below) */}
        {!productsOnly && (
          <div className="px-6 border-b border-gray-200 flex-shrink-0">
            <nav className="-mb-px flex space-x-8">
              {tabs.map((tab) => {
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id as any)}
                    className={`py-3 px-1 border-b-2 font-medium text-sm flex items-center space-x-2 ${
                      activeTab === tab.id
                        ? 'border-oe-primary text-oe-primary'
                        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </nav>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 pb-24" style={{ minHeight: '400px' }}>
          {activeTab === 'basic' && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Group Name <span className="text-red-500">*</span></label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => handleInputChange('name', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Tenant {mode === 'create' ? <span className="text-red-500">*</span> : ''}</label>
                  {isLoading ? (
                    <div className="w-full px-3 py-2 border border-gray-200 rounded-md bg-gray-50 text-gray-600">Loading...</div>
                  ) : (isSysAdmin && mode === 'create') ? (
                    <SearchableDropdown
                      options={tenantOptions}
                      value={formData.tenantId}
                      onChange={(value) => {
                        handleInputChange('tenantId', value);
                        setSelectedTenantId(value);
                        // Products will be fetched by useEffect when selectedTenantId changes
                      }}
                      placeholder="Select Tenant"
                      searchPlaceholder="Search tenants..."
                      loading={isLoadingTenants}
                      className="w-full"
                    />
                  ) : (
                    <div className="w-full px-3 py-2 border border-gray-300 rounded-md bg-gray-50">
                      {isLoadingMyTenant 
                        ? 'Loading tenant...' 
                        : (typeof myTenant === 'string' ? myTenant : myTenant?.Name) || 
                          (typedUser as any)?.tenantName || 
                          editingGroup?.TenantName || 
                          'Unknown Tenant'}
                    </div>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Assigned Agent <span className="text-red-500">*</span></label>
                  {isSysAdmin || isTenantAdmin ? (
                    <>
                      {console.log('🔍 SearchableDropdown props:', {
                        value: formData.agentId,
                        optionsCount: agentOptions.length,
                        options: agentOptions.map(o => ({ value: o.value, label: o.label })),
                        mode,
                        editingGroupAgentId: editingGroup?.AgentId,
                        editingGroupAgentUserId: editingGroup?.AgentUserId
                      })}
                      <SearchableDropdown
                        options={agentOptions}
                        value={formData.agentId}
                        onChange={(value, _label, option) => {
                          handleInputChange('agentId', value);
                          setSelectedAgentOption(option ? { id: option.id, label: option.label, value: option.value, email: option.email, code: option.code } : null);
                        }}
                        placeholder="No agent assigned"
                        searchPlaceholder="Search agents by name or email..."
                        loading={isLoadingAgents}
                        disabled={!formData.tenantId && mode === 'create'}
                        className="w-full"
                        showEmail={true}
                        showCode={true}
                        useBackendSearch={true}
                        onSearch={(query) => setAgentSearchQuery(query)}
                      />
                    </>
                  ) : isAgentLike ? (
                    loadingAssignableGroup ? (
                      <div className="w-full px-3 py-2 border border-gray-200 rounded-md bg-gray-50 text-gray-600">
                        Loading agents…
                      </div>
                    ) : agentOptions.length > 1 ? (
                      <SearchableDropdown
                        options={agentOptions}
                        value={formData.agentId}
                        onChange={(value, _label, option) => {
                          handleInputChange('agentId', value);
                          setSelectedAgentOption(
                            option
                              ? { id: option.id, label: option.label, value: option.value, email: option.email, code: option.code }
                              : null
                          );
                        }}
                        placeholder="Select an agent…"
                        searchPlaceholder="Search by name or email…"
                        loading={false}
                        className="w-full"
                        showEmail={true}
                        useBackendSearch={false}
                      />
                    ) : (
                      <div className="w-full px-3 py-2 border border-gray-300 rounded-md bg-gray-50">
                        {currentAgent
                          ? `${currentAgent.firstName || ''} ${currentAgent.lastName || ''}`.trim() || 'Me'
                          : 'Loading...'}
                      </div>
                    )
                  ) : (
                    <div className="w-full px-3 py-2 border border-gray-300 rounded-md bg-gray-50">
                      {isLoadingAssignedAgent ? 'Loading...' : (assignedAgent ? `${assignedAgent.FirstName} ${assignedAgent.LastName}` : 'No agent assigned')}
                    </div>
                  )}
                </div>
              </div>

              {/* AllAboard Master Group ID — edit mode only; create auto-assigns on the server */}
              {mode === 'edit' && (isSysAdmin || isTenantAdmin) && (
                <div className="rounded-lg border border-gray-200 bg-white p-5">
                  <div className="flex items-center gap-2 mb-3">
                    <Tag className="h-4 w-4 text-oe-primary" />
                    <h3 className="text-sm font-semibold text-gray-800">
                      AllAboard Master Group ID
                    </h3>
                  </div>
                  <input
                    type="text"
                    value={formData.allAboardMasterGroupId || ''}
                    onChange={(e) => {
                      const v = e.target.value.replace(/\D/g, '').slice(0, 6);
                      setFormData(prev => ({ ...prev, allAboardMasterGroupId: v }));
                      setMasterGroupIdValidation({});
                      setMasterGroupIdSuggested(true);
                    }}
                    onBlur={async () => {
                      const v = (formData.allAboardMasterGroupId || '').trim();
                      if (!v) { setMasterGroupIdValidation({}); return; }
                      setMasterGroupIdValidation({ checking: true });
                      const excludeId = mode === 'edit' && editingGroup?.GroupId ? editingGroup.GroupId : undefined;
                      const res = await GroupsService.validateMasterGroupId(v, excludeId);
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
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono focus:ring-oe-primary focus:border-oe-primary"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Exactly 6 digits. Leave blank on create to auto-assign the next number.
                  </p>
                  {masterGroupIdValidation.checking && (
                    <p className="text-xs text-gray-400 mt-1">Checking availability…</p>
                  )}
                  {!masterGroupIdValidation.checking && masterGroupIdValidation.available === true && (
                    <p className="flex items-center gap-1 text-xs text-oe-success mt-1">
                      <Check className="h-3.5 w-3.5" /> {masterGroupIdValidation.message}
                    </p>
                  )}
                  {!masterGroupIdValidation.checking && masterGroupIdValidation.available === false && (
                    <p className="flex items-center gap-1 text-xs text-red-600 mt-1">
                      <X className="h-3.5 w-3.5" /> {masterGroupIdValidation.message}
                    </p>
                  )}
                </div>
              )}

              {/* Group Type Picker — locked in edit mode; type changes go through the
                  Settings tab's "Request Type Change" flow so a tenant admin can review. */}
              <div className="rounded-lg border border-gray-200 bg-white p-6">
                <h3 className="text-base font-semibold text-gray-900">Group Type</h3>
                {mode === 'edit' && (
                  <p className="mt-2 text-sm text-gray-600">
                    Locked after group creation. To switch between Standard and List Bill,
                    submit a request from the group's Settings tab.
                  </p>
                )}
                <div className="mt-4 space-y-3">
                  <label className={`flex items-start gap-3 ${mode === 'edit' ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
                    <input
                      type="radio"
                      name="groupType"
                      value="Standard"
                      checked={formData.groupType === 'Standard'}
                      disabled={mode === 'edit'}
                      onChange={() => {
                        if (mode === 'edit') return;
                        setFormData({ ...formData, groupType: 'Standard' });
                        setSelectedProducts([]);
                        setSelectedProductsData([]);
                      }}
                      className="mt-1"
                    />
                    <div>
                      <div className="font-medium">Standard Group</div>
                      <div className="text-sm text-gray-500">
                        Group-level enrollment. Subject to vendor minimum employees per group.
                      </div>
                    </div>
                  </label>
                  <label className={`flex items-start gap-3 ${mode === 'edit' ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
                    <input
                      type="radio"
                      name="groupType"
                      value="ListBill"
                      checked={formData.groupType === 'ListBill'}
                      disabled={mode === 'edit'}
                      onChange={() => {
                        if (mode === 'edit') return;
                        setFormData({ ...formData, groupType: 'ListBill' });
                        setSelectedProducts([]);
                        setSelectedProductsData([]);
                      }}
                      className="mt-1"
                    />
                    <div>
                      <div className="font-medium">
                        List Bill
                      </div>
                      <div className="text-sm text-gray-500">
                        Members enroll in individual products, and all charges are consolidated into one shared bill with a single payment method.
                      </div>
                    </div>
                  </label>
                </div>
              </div>

              {mode === 'create' && (
                <div className="rounded-lg border border-gray-200 bg-white p-6 space-y-4">
                  <h3 className="text-base font-semibold text-gray-900">First effective date</h3>
                  <p className="text-sm text-gray-600">
                    When benefits may begin for this group. This sets the initial enrollment window from today through the day before this date.
                  </p>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      First effective date <span className="text-red-500">*</span>
                    </label>
                    <div className="relative">
                      <Calendar className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400 pointer-events-none" />
                      <select
                        value={firstEffectiveDate}
                        onChange={(e) => setFirstEffectiveDate(e.target.value)}
                        className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary appearance-none bg-white"
                        required
                        data-testid="first-effective-date"
                      >
                        <option value="">Select first effective date…</option>
                        {firstEffectiveDateOptions.map((date) => (
                          <option key={date} value={date}>
                            {formatDisplayDate(date)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      {allowMidMonthEffectiveOnCreate
                        ? 'Must be a future date on the 1st or 15th of the month.'
                        : 'Must be a future date on the 1st of the month.'}
                    </p>
                    {firstEffectiveDateError && (
                      <p className="text-sm text-red-600 mt-1">{firstEffectiveDateError}</p>
                    )}
                  </div>

                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={allowMidMonthEffectiveOnCreate}
                      onChange={(e) => {
                        setAllowMidMonthEffectiveOnCreate(e.target.checked);
                        setFirstEffectiveDate('');
                      }}
                      className="mt-1 h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                      data-testid="allow-mid-month-effective-create"
                    />
                    <span className="text-sm text-gray-800">
                      Allow mid-month effective dates (members may also choose the <strong>15th</strong>).
                    </span>
                  </label>

                  {computedEnrollmentPeriodPreview && (
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-900">
                      <div className="flex items-start gap-2">
                        <Info className="h-5 w-5 shrink-0 mt-0.5" />
                        <div>
                          <p>
                            <strong>Enrollment period:</strong>{' '}
                            {formatDisplayDate(computedEnrollmentPeriodPreview.startDate)} –{' '}
                            {formatDisplayDate(computedEnrollmentPeriodPreview.endDate)}
                          </p>
                          <p className="mt-1">
                            <strong>Earliest member effective date:</strong>{' '}
                            {formatDisplayDate(computedEnrollmentPeriodPreview.earliestEffectiveDate)}
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {enrollmentDeadlineDaysBeforeEffectiveDate > 0 && firstEffectiveDate && (
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
                      <div className="flex items-start gap-2">
                        <Info className="h-5 w-5 shrink-0 mt-0.5 text-amber-700" />
                        <p>
                          <strong>Enrollment deadline:</strong> For vendor minimums, employees must be enrolled at least{' '}
                          <strong>{enrollmentDeadlineDaysBeforeEffectiveDate}</strong>{' '}
                          {enrollmentDeadlineDaysBeforeEffectiveDate === 1 ? 'day' : 'days'} before the first effective date
                          {enrollmentMinimumDeadlineYmd ? (
                            <> (by <strong>{formatDisplayDate(enrollmentMinimumDeadlineYmd)}</strong>)</>
                          ) : null}
                          .
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
                      {activeTab === 'business' && (
              <div className="space-y-6">
                {/* Primary Contact Information Section */}
                <div className="border-b pb-6">
                  <h4 className="text-lg font-medium text-gray-900 mb-4">Primary Contact Information</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">First Name <span className="text-red-500">*</span></label>
                      <input type="text" value={formData.primaryContactFirstName} onChange={(e) => handleInputChange('primaryContactFirstName', e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary" required />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Last Name <span className="text-red-500">*</span></label>
                      <input type="text" value={formData.primaryContactLastName} onChange={(e) => handleInputChange('primaryContactLastName', e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary" required />
                    </div>
                    <div className="md:col-span-2">
                      <label className="block text-sm font-medium text-gray-700 mb-1">Email Address <span className="text-red-500">*</span></label>
                      <input type="email" value={formData.contactEmail} onChange={(e) => handleInputChange('contactEmail', e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary" required />
                    </div>
                  </div>
                </div>
                
                {/* Business Information Section */}
                <div>
                  <h4 className="text-lg font-medium text-gray-900 mb-4">Business Information</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Tax ID Number (EIN)</label>
                      <input type="text" value={formData.taxIdNumber} onChange={(e) => handleInputChange('taxIdNumber', e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md"/>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Business Type</label>
                      <select value={formData.businessType} onChange={(e) => handleInputChange('businessType', e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md">
                        <option value="">Select Business Type</option>
                        {BUSINESS_TYPES.map((type) => (<option key={type} value={type}>{type}</option>))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Contact Title</label>
                      <input type="text" value={formData.contactTitle} onChange={(e) => handleInputChange('contactTitle', e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md"/>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Primary Phone <span className="text-gray-500 text-xs">(Optional)</span>
                      </label>
                      <input 
                        type="tel" 
                        value={formData.contactPhone} 
                        onChange={(e) => handleInputChange('contactPhone', e.target.value)} 
                        placeholder="(123) 456-7890"
                        className={`w-full px-3 py-2 border rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
                          formData.contactPhone && !validatePhoneNumber(formData.contactPhone) 
                            ? 'border-red-300' 
                            : 'border-gray-300'
                        }`}
                        maxLength={14} // (123) 456-7890 = 14 characters
                      />
                      {formData.contactPhone && !validatePhoneNumber(formData.contactPhone) && (
                        <p className="mt-1 text-sm text-red-600">Please enter a valid 10-digit phone number with area code</p>
                      )}
                      {!formData.contactPhone && (
                        <p className="mt-1 text-xs text-gray-500">Phone number is optional</p>
                      )}
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Secondary Phone</label>
                      <input 
                        type="tel" 
                        value={formData.contactPhone2} 
                        onChange={(e) => handleInputChange('contactPhone2', e.target.value)} 
                        placeholder="(123) 456-7890"
                        className={`w-full px-3 py-2 border rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
                          formData.contactPhone2 && !validatePhoneNumber(formData.contactPhone2) 
                            ? 'border-red-300' 
                            : 'border-gray-300'
                        }`}
                        maxLength={14}
                      />
                      {formData.contactPhone2 && !validatePhoneNumber(formData.contactPhone2) && (
                        <p className="mt-1 text-sm text-red-600">Please enter a valid 10-digit phone number with area code</p>
                      )}
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Fax Number</label>
                      <input 
                        type="tel" 
                        value={formData.faxNumber} 
                        onChange={(e) => handleInputChange('faxNumber', e.target.value)} 
                        placeholder="(123) 456-7890"
                        className={`w-full px-3 py-2 border rounded-md focus:ring-2 focus:ring-oe-primary focus:border-oe-primary ${
                          formData.faxNumber && !validatePhoneNumber(formData.faxNumber) 
                            ? 'border-red-300' 
                            : 'border-gray-300'
                        }`}
                        maxLength={14}
                      />
                      {formData.faxNumber && !validatePhoneNumber(formData.faxNumber) && (
                        <p className="mt-1 text-sm text-red-600">Please enter a valid 10-digit phone number with area code</p>
                      )}
                    </div>
                    <div className="md:col-span-2">
                      <label className="block text-sm font-medium text-gray-700 mb-1">Website</label>
                      <input type="url" value={formData.website} onChange={(e) => handleInputChange('website', e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md"/>
                    </div>
                  </div>
                </div>
              </div>
           )}

           {activeTab === 'products' && (
              <div className="space-y-6">
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <h3 className="text-lg font-medium text-blue-900 mb-2">Product Selection</h3>
                  <p className="text-oe-primary-dark text-sm">Select which products should be available to this group. You can change this later.</p>
                </div>

                {mode === 'edit' && enrollmentLinkTemplateCount !== null && enrollmentLinkTemplateCount > 0 && (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                    <p className="text-amber-900 text-sm">
                      This group has <strong>{enrollmentLinkTemplateCount} enrollment link template{enrollmentLinkTemplateCount !== 1 ? 's' : ''}</strong>.
                      Changing products and saving will update those links to match the new product set.
                    </p>
                  </div>
                )}
                
                <div className="space-y-4">
                  {(!selectedTenantId && isSysAdmin) ? (
                    <div className="text-sm text-gray-600">
                      Please select a tenant first to see available products.
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => setShowProductModal(true)}
                        className="btn-primary inline-flex items-center w-fit"
                      >
                        <Plus className="w-4 h-4 mr-2" />
                        Add Products
                      </button>

                      {/* Selected Products List */}
                      <div className="space-y-3">
                        {(() => {
                          // Resolve display info for each selected product. Per-group state
                          // (selectedProductsData) takes precedence for IsHidden — availableProducts
                          // carries the catalog flag (Products.IsHidden), which is a separate concept.
                          const filteredSelectedProducts = selectedProducts
                            .map((productId) => {
                              const groupProduct = selectedProductsData.find(p => p.ProductId === productId);
                              const catalogProduct = availableProducts.find(p => (p.ProductId || p.productId) === productId);
                              const product = catalogProduct || groupProduct;
                              if (!product) return null;
                              const isSavedToGroup = !!groupProduct;
                              // GroupProducts.IsHidden is the per-group "removed" flag.
                              const removed = isSavedToGroup ? isProductHiddenForGroup(groupProduct) : false;
                              return { productId, product, isSavedToGroup, removed };
                            })
                            .filter((item): item is { productId: string; product: any; isSavedToGroup: boolean; removed: boolean } => {
                              if (item == null) return false;
                              // Catalog-hidden products (Products.IsHidden = 1) are bundle-only / retired and
                              // must never appear here as either an active row or a "Removed / Add Back" row —
                              // the agent has no legitimate way to re-attach them at the catalog level.
                              const groupProduct = selectedProductsData.find(p => p.ProductId === item.productId);
                              if (item.isSavedToGroup && groupProduct && isProductCatalogHidden(groupProduct)) return false;
                              return true;
                            });

                          return (
                            <>
                              <h4 className="text-md font-medium text-gray-900">Selected Products ({filteredSelectedProducts.length})</h4>
                              {filteredSelectedProducts.length === 0 ? (
                                <p className="text-gray-500 text-sm">No products selected yet</p>
                              ) : (
                                <div className="space-y-2">
                                  {filteredSelectedProducts
                              .map(({ productId, product, isSavedToGroup, removed }) => {

                                const productName = product.Name || product.name || product.ProductName || 'Unknown Product';
                                const productType = product.ProductType || product.productType || 'Unknown Type';
                                const productImageUrl = product.ProductImageUrl || product.ProductLogoUrl || product.productImageUrl || product.productLogoUrl;
                                const restoring = restoringProductId === productId;

                                // Resolve qualifying vendors so we can gate auto-open: skip if all
                                // qualifying vendors of this product already have a selection.
                                const productForPicker = {
                                  ...product,
                                  // Normalize keys the picker expects
                                  vendorId: product.vendorId || product.VendorId || null,
                                  idCardData: product.idCardData ?? null,
                                  includedProducts:
                                    product.includedProducts ?? product.bundleProducts ?? null
                                };
                                const pickerVendorIds = deriveCardVendorIds(productForPicker)
                                  .filter((vid) => productHasVariationsForVendor(productForPicker, vid));
                                const allVendorsAlreadySelected =
                                  pickerVendorIds.length > 0 &&
                                  pickerVendorIds.every((vid) => !!vendorNetworkSelections[vid]);
                                const shouldAutoOpenForProduct =
                                  !networkModalAutoOpened.has(productId) && !allVendorsAlreadySelected;

                                return (
                                <div
                                  key={productId}
                                  className={`flex flex-col gap-2 p-3 border border-gray-200 rounded-lg bg-gray-50 ${removed ? 'opacity-60' : ''}`}
                                >
                                  <div className="flex items-center justify-between gap-2 w-full">
                                  <div className="flex items-center space-x-3">
                                    {/* Product Image */}
                                    <div className="flex-shrink-0">
                                      {productImageUrl ? (
                                        <img
                                          src={productImageUrl}
                                          alt={productName}
                                          className="w-10 h-10 rounded-lg object-contain border border-gray-200 bg-white"
                                          onError={(e) => {
                                            e.currentTarget.style.display = 'none';
                                            e.currentTarget.nextElementSibling?.classList.remove('hidden');
                                          }}
                                        />
                                      ) : null}
                                      <div className={`w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center border border-gray-200 ${productImageUrl ? 'hidden' : ''}`}>
                                        <Package className="w-5 h-5 text-gray-400" />
                                      </div>
                                    </div>

                                    <div>
                                      <div className="flex items-center gap-2 flex-wrap">
                                        <h5 className={`font-medium text-gray-900 ${removed ? 'line-through' : ''}`}>{productName}</h5>
                                        {removed && (
                                          <span className="inline-flex px-2 py-0.5 text-xs font-medium rounded-full bg-gray-200 text-gray-700 border border-gray-300">
                                            Removed
                                          </span>
                                        )}
                                      </div>
                                      <p className="text-sm text-gray-600">
                                        {productType}
                                      </p>
                                    </div>
                                  </div>
                                  {removed ? (
                                    <button
                                      type="button"
                                      onClick={() => handleRestoreSavedProduct(productId, productName)}
                                      disabled={restoring}
                                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-oe-primary border border-oe-primary rounded-md hover:bg-oe-light disabled:opacity-50 disabled:cursor-not-allowed"
                                      title={`Add ${productName} back to this group`}
                                    >
                                      <RotateCcw className="w-4 h-4" aria-hidden />
                                      {restoring ? 'Adding…' : 'Add Back'}
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        if (isSavedToGroup) {
                                          // Saved row → use the same enrollment-aware soft-delete flow
                                          // as the Group Products tab; the row stays visible (as Removed)
                                          // until the agent restores it.
                                          setProductPendingDelete({ productId, productName });
                                        } else {
                                          // Newly-added in this modal session — just drop it from local state.
                                          handleRemoveProduct(productId);
                                        }
                                      }}
                                      className="text-red-600 hover:text-red-800 p-1 transition-colors"
                                      title={`Remove ${productName} from this group`}
                                    >
                                      <Trash2 className="w-4 h-4" />
                                    </button>
                                  )}
                                  </div>
                                  {/* Per-product network picker — auto-opens once when a qualifying
                                      product is newly added; pencil reopens. Hidden when product
                                      removed or no qualifying vendors. Persists into the same
                                      vendorNetworkSelections map; saved to oe.GroupVendorNetworks
                                      after group save resolves. */}
                                  {!removed && pickerVendorIds.length > 0 && (
                                    <NetworkPickerForProduct
                                      product={productForPicker}
                                      cacheKey="group-admin"
                                      fetchVendorNetworks={async (vendorId) => {
                                        const resp = await apiService.get<{ success: boolean; data: any[] }>(
                                          `/api/vendors/${vendorId}/networks`
                                        );
                                        return resp?.success && Array.isArray(resp.data) ? resp.data : [];
                                      }}
                                      selections={vendorNetworkSelections as Record<string, string>}
                                      onChange={(next) =>
                                        setVendorNetworkSelections(next as VendorNetworkSelectionMap)
                                      }
                                      shouldAutoOpen={shouldAutoOpenForProduct}
                                      onAutoOpened={() =>
                                        setNetworkModalAutoOpened((prev) => {
                                          const nextSet = new Set(prev);
                                          nextSet.add(productId);
                                          return nextSet;
                                        })
                                      }
                                    />
                                  )}
                                </div>
                              );
                            })}
                                </div>
                              )}
                            </>
                          );
                        })()}
                      </div>

                    {/* Per-product network pickers above replace the standalone vendor-networks
                        panel. Selections still persist via vendorNetworkSelections → PUT /vendor-networks. */}
                    </>
                  )}
                </div>

                {mode === 'create' && enrollmentDeadlineDaysBeforeEffectiveDate > 0 && (
                  <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
                    <strong>Enrollment must complete early:</strong> Your tenant requires enrollments for vendor minimums at least{' '}
                    <strong>{enrollmentDeadlineDaysBeforeEffectiveDate}</strong>{' '}
                    {enrollmentDeadlineDaysBeforeEffectiveDate === 1 ? 'day' : 'days'} before the first effective date you chose on Basic Info
                    {enrollmentMinimumDeadlineYmd ? (
                      <> (by <strong>{formatDisplayDate(enrollmentMinimumDeadlineYmd)}</strong>)</>
                    ) : null}
                    .
                  </div>
                )}

                {/* Vendor minimum acknowledgment — derived from selected products that
                    carry a vendorMinimumEmployeesPerGroup. Only shown in create mode:
                    in edit/productsOnly the Save buttons don't gate on it and there's
                    no persisted field, so it would be a dead control.
                    Hidden for ListBill groups (no participation floor applies). */}
                {mode === 'create' && vendorMinimumApplies && (
                  <div className="rounded-md border border-gray-300 bg-gray-50 px-4 py-3">
                    <label className="flex items-start gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={vendorMinimumAcknowledged}
                        onChange={(e) => setVendorMinimumAcknowledged(e.target.checked)}
                        className="mt-1 h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                        data-testid="vendor-minimum-ack"
                      />
                      <span className="text-sm text-gray-800">
                        I acknowledge that I need at least <strong>{maxVendorMinimumForSelectedProducts}</strong> employees enrolled for this group{' '}
                        {enrollmentDeadlineDaysBeforeEffectiveDate > 0 ? (
                          <>at least <strong>{enrollmentDeadlineDaysBeforeEffectiveDate}</strong> {enrollmentDeadlineDaysBeforeEffectiveDate === 1 ? 'day' : 'days'} before the effective date.</>
                        ) : (
                          <>by the effective date.</>
                        )}
                      </span>
                    </label>
                  </div>
                )}

              </div>
           )}

           {activeTab === 'address' && (
              <div className="space-y-6">
                <div className={`border rounded-lg p-4 ${
                  hasPaymentInfo() 
                    ? 'bg-amber-50 border-amber-200' 
                    : 'bg-blue-50 border-blue-200'
                }`}>
                  <h3 className={`text-lg font-medium mb-2 ${
                    hasPaymentInfo() ? 'text-amber-900' : 'text-blue-900'
                  }`}>Address Information {hasPaymentInfo() && <span className="text-red-500">*</span>}</h3>
                  <p className={`text-sm ${
                    hasPaymentInfo() ? 'text-amber-700' : 'text-oe-primary-dark'
                  }`}>
                    {hasPaymentInfo() 
                      ? 'Address is required because payment information was provided. This address will be used for billing and creating a primary location.'
                      : 'Enter the group\'s primary address information (optional).'}
                  </p>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Street Address {hasPaymentInfo() && <span className="text-red-500">*</span>}
                    </label>
                    <input 
                      type="text" 
                      value={formData.address} 
                      onChange={(e) => handleInputChange('address', e.target.value)} 
                      className="w-full px-3 py-2 border border-gray-300 rounded-md" 
                      placeholder="123 Main Street"
                      required={hasPaymentInfo()}
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">Address Line 2</label>
                    <input type="text" value={formData.address2} onChange={(e) => handleInputChange('address2', e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md" placeholder="Suite, floor, etc. (optional)"/>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      City {hasPaymentInfo() && <span className="text-red-500">*</span>}
                    </label>
                    <input 
                      type="text" 
                      value={formData.city} 
                      onChange={(e) => handleInputChange('city', e.target.value)} 
                      className="w-full px-3 py-2 border border-gray-300 rounded-md" 
                      placeholder="City"
                      required={hasPaymentInfo()}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      State {hasPaymentInfo() && <span className="text-red-500">*</span>}
                    </label>
                    <select 
                      value={formData.state} 
                      onChange={(e) => handleInputChange('state', e.target.value)} 
                      className="w-full px-3 py-2 border border-gray-300 rounded-md"
                      required={hasPaymentInfo()}
                    >
                      <option value="">Select State</option>
                      {US_STATES_FORMATTED.map((state) => (
                        <option key={state.value} value={state.value}>{state.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      ZIP Code {hasPaymentInfo() && <span className="text-red-500">*</span>}
                    </label>
                    <input 
                      type="text" 
                      value={formData.zip} 
                      onChange={(e) => handleInputChange('zip', e.target.value)} 
                      className="w-full px-3 py-2 border border-gray-300 rounded-md" 
                      placeholder="12345"
                      pattern="\d{5}"
                      maxLength={5}
                      required={hasPaymentInfo()}
                    />
                  </div>
                </div>
              </div>
           )}

            {activeTab === 'payment' && (
              <div className="space-y-6">
                {/* Existing Payment Methods (Edit Mode Only) */}
                {mode === 'edit' && (
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                    <h4 className="text-sm font-medium text-blue-900 mb-3">Existing Payment Methods</h4>
                    {loadingPaymentMethods ? (
                      <div className="flex items-center justify-center py-4">
                        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-oe-primary"></div>
                      </div>
                    ) : existingPaymentMethods.length > 0 ? (
                      <div className="space-y-2">
                        {existingPaymentMethods.map((method: any) => (
                          <div key={method.PaymentMethodId} className="bg-white rounded-md p-3 border border-blue-200">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center space-x-3">
                                {method.Type === 'ACH' ? (
                                  <Landmark className="h-5 w-5 text-green-600" />
                                ) : (
                                  <CreditCard className="h-5 w-5 text-oe-primary" />
                                )}
                                <div>
                                  <p className="text-sm font-medium text-gray-900">
                                    {method.Type === 'ACH' 
                                      ? `${method.BankName || 'Bank Account'} ••••${method.Last4}`
                                      : `${method.CardBrand || 'Credit Card'} ••••${method.Last4}`
                                    }
                                  </p>
                                  {method.IsDefault && (
                                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800 mt-1">
                                      Primary
                                    </span>
                                  )}
                                  {method.LocationName && (
                                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700 mt-1 ml-2">
                                      {method.LocationName}
                                    </span>
                                  )}
                                </div>
                              </div>
                              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                                method.Status === 'Active' 
                                  ? 'bg-green-100 text-green-800' 
                                  : 'bg-gray-100 text-gray-800'
                              }`}>
                                {method.Status}
                              </span>
                            </div>
                          </div>
                        ))}
                        <p className="text-xs text-oe-primary-dark mt-2">
                          💡 Payment methods are managed in the <strong>Billing</strong> tab. You can add, edit, or remove payment methods there.
                        </p>
                      </div>
                    ) : (
                      <p className="text-sm text-oe-primary-dark">
                        No payment methods found. Add payment methods in the <strong>Billing</strong> tab.
                      </p>
                    )}
                  </div>
                )}

                {/* Payment Type Selector - Only show if no existing payment methods (for first payment method only) */}
                {existingPaymentMethods.length === 0 && (
                  <>
                    <div className="flex items-end gap-4">
                      <div className="flex-1">
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Payment Method Type
                        </label>
                        <select
                          value={formData.paymentType}
                          onChange={(e) => handleInputChange('paymentType', e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
                        >
                          <option value="">None (add later)</option>
                          <option value="ACH">Bank Account (ACH)</option>
                          <option value="CreditCard">Credit Card</option>
                        </select>
                      </div>
                      
                      {/* Dev Mode Auto-Fill Buttons */}
                      {(window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && (
                        <div className="flex items-center space-x-2">
                          <button
                            type="button"
                            onClick={() => {
                              setFormData(prev => ({
                                ...prev,
                                paymentType: 'ACH',
                                achBankName: 'Test Bank',
                                achAccountType: 'Checking',
                                achRoutingNumber: '021000021',
                                achAccountNumber: '1234567890',
                                achAccountName: formData.primaryContactFirstName && formData.primaryContactLastName 
                                  ? `${formData.primaryContactFirstName} ${formData.primaryContactLastName}` 
                                  : 'Test Account Holder'
                              }));
                            }}
                            className="px-3 py-2 text-xs bg-green-100 text-green-700 rounded-md hover:bg-green-200 transition-colors whitespace-nowrap"
                          >
                            Auto fill ACH (DEV)
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setFormData(prev => ({
                                ...prev,
                                paymentType: 'CreditCard',
                                creditCardNumber: '4111111111111111',
                                creditCardType: 'Visa',
                                creditCardExpiry: `12/${new Date().getFullYear() + 2}`,
                                creditCardName: formData.primaryContactFirstName && formData.primaryContactLastName 
                                  ? `${formData.primaryContactFirstName} ${formData.primaryContactLastName}` 
                                  : 'Test Cardholder'
                              }));
                            }}
                            className="px-3 py-2 text-xs bg-blue-100 text-oe-primary-dark rounded-md hover:bg-blue-200 transition-colors whitespace-nowrap"
                          >
                            Auto fill CC (DEV)
                          </button>
                        </div>
                      )}
                    </div>
                    
                    {/* Credit Card Fields */}
                    {formData.paymentType === 'CreditCard' && (
                    <div className="bg-oe-light p-6 rounded-lg">
                      <h4 className="text-lg font-medium text-gray-900 mb-4 flex items-center space-x-2"><CreditCard className="h-5 w-5 text-oe-primary" /><span>Credit Card Information</span></h4>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Cardholder Name</label>
                          <input type="text" value={formData.creditCardName} onChange={(e) => handleInputChange('creditCardName', e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md"/>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Card Type</label>
                          <select value={formData.creditCardType} onChange={(e) => handleInputChange('creditCardType', e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md">
                            <option value="">Select Card Type</option>
                            {CREDIT_CARD_TYPES.map((type) => (<option key={type} value={type}>{type}</option>))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Card Number</label>
                          <input 
                            type="text" 
                            value={formData.creditCardNumber} 
                            onChange={(e) => handleInputChange('creditCardNumber', e.target.value)} 
                            className="w-full px-3 py-2 border border-gray-300 rounded-md"
                            placeholder="16 digits"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Expiration Date</label>
                          <input 
                            type="text" 
                            value={formData.creditCardExpiry} 
                            onChange={(e) => handleInputChange('creditCardExpiry', e.target.value)} 
                            className="w-full px-3 py-2 border border-gray-300 rounded-md" 
                            placeholder="MM/YYYY"
                          />
                        </div>
                      </div>
                    </div>
                    )}
                    
                    {/* ACH Fields */}
                    {formData.paymentType === 'ACH' && (
                    <div className="bg-green-50 p-6 rounded-lg">
                      <h4 className="text-lg font-medium text-gray-900 mb-4 flex items-center space-x-2"><Landmark className="h-5 w-5 text-oe-success" /><span>ACH / Bank Account Information</span></h4>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Account Holder Name</label>
                          <input type="text" value={formData.achAccountName} onChange={(e) => handleInputChange('achAccountName', e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md"/>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Bank Name</label>
                          <input type="text" value={formData.achBankName} onChange={(e) => handleInputChange('achBankName', e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md"/>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Account Type</label>
                          <select value={formData.achAccountType} onChange={(e) => handleInputChange('achAccountType', e.target.value)} className="w-full px-3 py-2 border border-gray-300 rounded-md">
                            <option value="">Select Account Type</option>
                            {ACCOUNT_TYPES.map((type) => (<option key={type} value={type}>{type}</option>))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Routing Number</label>
                          <input 
                            type="text" 
                            value={formData.achRoutingNumber} 
                            onChange={(e) => handleInputChange('achRoutingNumber', e.target.value)} 
                            className="w-full px-3 py-2 border border-gray-300 rounded-md" 
                            maxLength={9}
                            placeholder="9 digits"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Account Number</label>
                          <input 
                            type="text" 
                            value={formData.achAccountNumber} 
                            onChange={(e) => handleInputChange('achAccountNumber', e.target.value)} 
                            className="w-full px-3 py-2 border border-gray-300 rounded-md"
                            placeholder="Account number"
                          />
                        </div>
                      </div>
                    </div>
                    )}
                  </>
                )}
              </div>
            )}
            {activeTab === 'documents' && (
              <div className="space-y-6">
                <div className="bg-purple-50 p-6 rounded-lg">
                  <h4 className="text-lg font-medium text-gray-900 mb-4 flex items-center space-x-2"><Upload className="h-5 w-5 text-purple-600" /><span>Upload Company Logo</span></h4>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Company Logo</label>
                      <input 
                        type="file" 
                        accept="image/*" 
                        onChange={handleLogoUpload} 
                        className="w-full px-3 py-2 border border-gray-300 rounded-md"
                        disabled={isSubmitting}
                      />
                    </div>
                    {logoPreview && (
                      <div className="mt-4">
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-sm font-medium text-gray-700">Logo Preview:</p>
                          {logoFile && (
                            <button
                              type="button"
                              onClick={handleRemoveLogo}
                              className="text-sm text-red-600 hover:text-red-800"
                              disabled={isSubmitting}
                            >
                              Remove New Logo
                            </button>
                          )}
                        </div>
                        <div className="relative inline-block">
                          <img 
                            src={logoPreview} 
                            alt="Logo preview" 
                            className="h-20 w-auto border border-gray-300 rounded-md"
                            onError={(e) => {
                              console.error('🔍 Logo image failed to load:', logoPreview);
                              e.currentTarget.style.display = 'none';
                            }}
                            onLoad={() => {
                              console.log('🔍 Logo image loaded successfully:', logoPreview);
                            }}
                          />
                          {logoFile && (
                            <div className="absolute -top-2 -right-2 bg-green-500 text-white text-xs px-2 py-1 rounded-full">
                              New
                            </div>
                          )}
                        </div>
                        {existingLogoUrl && !logoFile && (
                          <p className="text-xs text-gray-500 mt-1">Showing existing logo</p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex-shrink-0">
          <div className="flex justify-between">
            <div className="flex items-center gap-4">
              <button type="button" onClick={() => { onClose(); resetForm(); }} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50">Cancel</button>
              {mode === 'edit' && showRemoveGroup && onRemoveGroupClick && (
                <button
                  type="button"
                  onClick={onRemoveGroupClick}
                  className="text-sm text-gray-500 hover:text-red-600 transition-colors"
                >
                  Terminate Group
                </button>
              )}
            </div>
            <div className="flex space-x-3">
              {productsOnly && mode === 'edit' ? (
                <button
                  type="button"
                  onClick={() => handleSubmit()}
                  disabled={isSubmitting}
                  className="px-4 py-2 text-sm font-medium text-white bg-oe-success border border-transparent rounded-md hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                >
                  {isSubmitting ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                      Saving...
                    </>
                  ) : (
                    <>
                      <Check className="h-4 w-4 mr-2" />
                      Save Products
                    </>
                  )}
                </button>
              ) : (
              <>
              {activeTab !== 'basic' && (
                <button type="button" onClick={() => {
                  const currentIndex = tabs.findIndex(t => t.id === activeTab);
                  if (currentIndex > 0) setActiveTab(tabs[currentIndex - 1].id as any);
                }} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50">Previous</button>
              )}
              {activeTab !== 'documents' ? (
                <div className="flex space-x-2">
                  {/* Quick Send Button - Only show on products tab for create mode */}
                  {activeTab === 'products' && mode === 'create' && (
                    <button
                      onClick={() => setShowQuickSendDialog(true)}
                      disabled={isSubmitting || !canQuickSend()}
                      className="px-4 py-2 text-sm font-medium text-white bg-gradient-to-r from-purple-600 to-indigo-600 border border-transparent rounded-md hover:from-purple-700 hover:to-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center transition-all duration-200"
                      title="Create group and send onboarding invite immediately"
                    >
                      <Zap className="w-4 h-4 mr-2" />
                      Quick Send
                    </button>
                  )}
                  
                  <button 
                    type="button" 
                    onClick={() => {
                      const currentIndex = tabs.findIndex(t => t.id === activeTab);
                      if (currentIndex < tabs.length - 1) setActiveTab(tabs[currentIndex + 1].id as any);
                    }} 
                    disabled={!canProceedToNext()}
                    className="px-4 py-2 text-sm font-medium text-white bg-oe-primary border border-transparent rounded-md hover:bg-oe-dark disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Next
                  </button>
                </div>
              ) : (
                <div className="flex space-x-2">
                  {mode === 'create' ? (
                    <>
                      {/* Create Group Only Button */}
                      <button 
                        type="button" 
                        onClick={() => handleSubmit(false)} 
                        disabled={
                          !formData.name || 
                          !formData.primaryContactFirstName || 
                          !formData.primaryContactLastName || 
                          !formData.contactEmail || 
                          !formData.agentId || 
                          !formData.tenantId || 
                          (!selectedProducts || selectedProducts.length === 0) || // Products required for create mode
                          (formData.contactPhone && !validatePhoneNumber(formData.contactPhone)) || // Validate phone format if provided, but don't require it
                          isSubmitting
                        } 
                        className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                      >
                        {isSubmitting ? (
                          <>
                            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-700 mr-2"></div>
                            Creating...
                          </>
                        ) : (
                          <>
                            <Check className="h-4 w-4 mr-2" />
                            Create Group Only
                          </>
                        )}
                      </button>
                      
                      {/* Create & Send Email Invite Button */}
                      <button 
                        type="button" 
                        onClick={() => handleSubmit(true)} 
                        disabled={
                          !formData.name || 
                          !formData.primaryContactFirstName || 
                          !formData.primaryContactLastName || 
                          !formData.contactEmail || 
                          !formData.agentId || 
                          !formData.tenantId || 
                          (!selectedProducts || selectedProducts.length === 0) || // Products required for create mode
                          (formData.contactPhone && !validatePhoneNumber(formData.contactPhone)) || // Validate phone format if provided, but don't require it
                          isSubmitting
                        } 
                        className="px-4 py-2 text-sm font-medium text-white bg-oe-success border border-transparent rounded-md hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                      >
                        {isSubmitting ? (
                          <>
                            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                            Creating & Sending...
                          </>
                        ) : (
                          <>
                            <Send className="h-4 w-4 mr-2" />
                            Create & Send Email Invite
                          </>
                        )}
                      </button>
                    </>
                  ) : (
                    <button 
                      type="button" 
                      onClick={() => handleSubmit()} 
                      disabled={
                        !formData.name || 
                        !formData.primaryContactFirstName || 
                        !formData.primaryContactLastName || 
                        !formData.contactEmail || 
                        !formData.agentId || 
                        (formData.contactPhone && !validatePhoneNumber(formData.contactPhone)) || // Validate phone format if provided, but don't require it
                        isSubmitting
                      } 
                      className="px-4 py-2 text-sm font-medium text-white bg-oe-success border border-transparent rounded-md hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                    >
                      {isSubmitting ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                          Updating...
                        </>
                      ) : (
                        'Update Group'
                      )}
                    </button>
                  )}
                </div>
              )}
              </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Quick Send Dialog */}
      <QuickSendDialog
        isOpen={showQuickSendDialog}
        onClose={() => {
          setShowQuickSendDialog(false);
          setQuickSendData({ firstName: '', lastName: '', email: '' });
        }}
        onSend={handleQuickSend}
        quickSendData={quickSendData}
        setQuickSendData={setQuickSendData}
        isSubmitting={isSubmitting}
      />

      {/* Product Selection Modal */}
      <ProductSelectionModal
        isOpen={showProductModal}
        onClose={() => {
          setShowProductModal(false);
          setProductSearchTerm('');
        }}
        products={availableProducts}
        selectedProducts={selectedProducts}
        onAddProduct={handleAddProduct}
        onRemoveProduct={handleRemoveProduct}
        searchTerm={productSearchTerm}
        setSearchTerm={setProductSearchTerm}
        isLoading={loadingProducts}
        groupType={formData.groupType}
        includeHiddenProducts={includeHiddenGroupProducts}
        showHiddenProductsToggle={isTenantAdmin}
        onIncludeHiddenChange={setShowHiddenGroupProducts}
      />

      {/* Soft-delete confirm — same flow as the Group Products tab */}
      {productPendingDelete && (
        <DeleteProductConfirmModal
          productName={productPendingDelete.productName}
          enrollmentCount={productPendingDeleteCount}
          isLoading={productPendingDeleteCountLoading}
          onCancel={() => {
            setProductPendingDelete(null);
            setProductPendingDeleteCount(null);
          }}
          onConfirm={handleConfirmDeleteSavedProduct}
        />
      )}

    </div>
  );
};

// Quick Send Dialog Component
const QuickSendDialog: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  onSend: () => void;
  quickSendData: {
    firstName: string;
    lastName: string;
    email: string;
  };
  setQuickSendData: (data: { firstName: string; lastName: string; email: string }) => void;
  isSubmitting: boolean;
}> = ({ isOpen, onClose, onSend, quickSendData, setQuickSendData, isSubmitting }) => {
  const handleInputChange = (field: string, value: string) => {
    setQuickSendData({ ...quickSendData, [field]: value });
  };

  const handleSend = async () => {
    if (!quickSendData.firstName || !quickSendData.lastName || !quickSendData.email) {
      alert('Please fill in all recipient details');
      return;
    }
    await onSend();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg w-full max-w-md shadow-2xl">
        <div className="flex justify-between items-center p-6 border-b border-gray-200">
          <div className="flex items-center space-x-2">
            <Zap className="w-5 h-5 text-purple-600" />
            <h3 className="text-lg font-medium text-gray-900">Quick Send Onboarding Invite</h3>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-500 transition-colors"
            disabled={isSubmitting}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6">
          <div className="mb-4">
            <div className="bg-gradient-to-r from-purple-50 to-indigo-50 border border-purple-200 rounded-lg p-3 mb-4">
              <p className="text-purple-700 text-sm">
                This will create the group and immediately send an onboarding invite to the recipient. 
                The recipient can complete the onboarding process using the secure link.
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">First Name</label>
                <input
                  type="text"
                  value={quickSendData.firstName}
                  onChange={(e) => handleInputChange('firstName', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  placeholder="John"
                  disabled={isSubmitting}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Last Name</label>
                <input
                  type="text"
                  value={quickSendData.lastName}
                  onChange={(e) => handleInputChange('lastName', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                  placeholder="Smith"
                  disabled={isSubmitting}
                />
              </div>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email Address</label>
              <input
                type="email"
                value={quickSendData.email}
                onChange={(e) => handleInputChange('email', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                placeholder="admin@company.com"
                disabled={isSubmitting}
              />
            </div>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex justify-end space-x-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button
            onClick={handleSend}
            className="px-4 py-2 text-sm font-medium text-white bg-gradient-to-r from-purple-600 to-indigo-600 border border-transparent rounded-md hover:from-purple-700 hover:to-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center transition-all duration-200"
            disabled={isSubmitting || !quickSendData.firstName || !quickSendData.lastName || !quickSendData.email}
          >
            {isSubmitting ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                Creating & Sending...
              </>
            ) : (
              <>
                <Zap className="w-4 h-4 mr-2" />
                Create & Send Invite
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

// Product Selection Modal
const productHiddenForModal = (product: any) =>
  product.IsHidden === true || product.IsHidden === 1 ||
  product.isHidden === true || product.isHidden === 1 ||
  product.IsHidden === 'true' || product.isHidden === 'true';

const ProductSelectionModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  products: any[];
  selectedProducts: string[];
  onAddProduct: (product: any) => void;
  onRemoveProduct: (productId: string) => void;
  searchTerm: string;
  setSearchTerm: (term: string) => void;
  isLoading: boolean;
  /** Group type currently selected on the form — determines which SalesType
   *  values are eligible. 'ListBill' → Individual/Both; 'Standard' → Group/Both. */
  groupType: 'Standard' | 'ListBill';
  /** When true (TenantAdmin), list products marked hidden from groups */
  includeHiddenProducts?: boolean;
  /** TenantAdmin: show checkbox in this modal to include hidden products/bundles */
  showHiddenProductsToggle?: boolean;
  onIncludeHiddenChange?: (include: boolean) => void;
}> = ({
  isOpen,
  onClose,
  products,
  selectedProducts,
  onAddProduct,
  onRemoveProduct,
  searchTerm,
  setSearchTerm,
  isLoading,
  groupType,
  includeHiddenProducts = false,
  showHiddenProductsToggle = false,
  onIncludeHiddenChange
}) => {
  const [productModalTab, setProductModalTab] = useState<'individual' | 'bundles'>('bundles');

  const filteredProducts = products.filter(product => {
    // Search filter
    const matchesSearch = !searchTerm ||
      product.Name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (product.ProductName && product.ProductName.toLowerCase().includes(searchTerm.toLowerCase())) ||
      product.ProductType?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (product.productType && product.productType.toLowerCase().includes(searchTerm.toLowerCase())) ||
      product.Description?.toLowerCase().includes(searchTerm.toLowerCase());
    
    if (!matchesSearch) return false;
    
    if (!includeHiddenProducts && productHiddenForModal(product)) return false;

    // Filter SalesType based on the group type the agent has selected.
    // Standard groups use Group/Both products; List-Bill groups use Individual/Both.
    const salesType = (product.SalesType || product.salesType || '').toString().trim().toLowerCase();
    const allowed = groupType === 'ListBill'
      ? ['individual', 'both']
      : ['group', 'both'];
    if (salesType && !allowed.includes(salesType)) return false;

    return true;
  });

  const isBundleProduct = (p: any) => p.IsBundle === true || p.IsBundle === 1 || p.isBundle === true || p.isBundle === 1;
  const individualProducts = filteredProducts.filter(p => !isBundleProduct(p));
  const bundleProducts = filteredProducts.filter(p => isBundleProduct(p));

  const productImageUrl = (product: any) =>
    product.ProductLogoUrl || product.productLogoUrl || product.ProductImageUrl || product.productImageUrl;

  const renderProductRow = (product: any) => {
    const productId = product.ProductId || product.productId;
    const isSelected = selectedProducts.includes(productId);
    const imageUrl = productImageUrl(product);
    const name = product.Name || product.ProductName || product.name;
    const productType = product.ProductType || product.productType;

    return (
      <div
        key={productId}
        onClick={() => isSelected ? onRemoveProduct(productId) : onAddProduct(product)}
        className={`p-3 border rounded-lg cursor-pointer transition-colors hover:bg-opacity-90 ${
          isSelected 
            ? 'border-green-300 bg-green-50' 
            : 'border-gray-200 hover:bg-gray-50'
        }`}
      >
        <div className="flex items-start space-x-3">
          {/* Product Image / Logo */}
          <div className="flex-shrink-0 relative">
            {imageUrl ? (
              <img
                src={imageUrl}
                alt={name || 'Product'}
                className="w-12 h-12 rounded-lg object-contain border border-gray-200 bg-white"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                  e.currentTarget.nextElementSibling?.classList.remove('hidden');
                }}
              />
            ) : null}
            <div className={`w-12 h-12 rounded-lg bg-gray-100 flex items-center justify-center border border-gray-200 ${imageUrl ? 'hidden' : ''}`}>
              <Package className="w-6 h-6 text-gray-400" />
            </div>
          </div>
          
          {/* Product Details */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap min-w-0">
              <h5 className="font-medium text-gray-900 truncate">{name}</h5>
              {includeHiddenProducts && productHiddenForModal(product) && (
                <span className="inline-flex px-2 py-0.5 text-xs font-medium rounded-full bg-gray-100 text-gray-700 border border-gray-200 shrink-0">
                  Hidden
                </span>
              )}
            </div>
            <p className="text-sm text-gray-600">
              {productType}
              {(() => {
                // ListBill groups are exempt from vendor employee minimums
                // (see vendorMinimumApplies in the parent), so the chip doesn't
                // apply either — even when the vendor has a minimum configured.
                if (groupType === 'ListBill') return null;
                const min = product.vendorMinimumEmployeesPerGroup ?? product.VendorMinimumEmployeesPerGroup ?? null;
                if (min == null) return null;
                return (
                  <span className="ml-1 text-gray-500">(min {Number(min)} employee{Number(min) === 1 ? '' : 's'})</span>
                );
              })()}
            </p>
            {product.Description && (
              <p className="text-sm text-gray-500 mt-1 line-clamp-2">{product.Description}</p>
            )}
          </div>
          
          {/* Toggle: checkmark = selected (click to deselect), plus = add */}
          <div className="flex-shrink-0">
            {isSelected ? (
              <div className="text-green-600" title="Click to deselect">
                <Check className="w-5 h-5" />
              </div>
            ) : (
              <div className="text-oe-primary">
                <Plus className="w-5 h-5" />
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg w-full max-w-4xl max-h-[80vh] overflow-hidden shadow-2xl">
        <div className="flex justify-between items-center p-6 border-b border-gray-200 bg-gradient-to-r from-oe-primary to-oe-dark">
          <h3 className="text-lg font-medium text-white">Select Products</h3>
          <button
            onClick={onClose}
            className="text-white hover:bg-white hover:bg-opacity-20 p-2 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6">
          {/* Search */}
          <div className="mb-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
              <input
                type="text"
                placeholder="Search products..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-transparent"
              />
            </div>
          </div>

          {showHiddenProductsToggle && (
            <div className="mb-4 flex flex-wrap items-center justify-end gap-2">
              <label className="inline-flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={includeHiddenProducts}
                  onChange={(e) => onIncludeHiddenChange?.(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span>Show hidden products &amp; bundles</span>
              </label>
            </div>
          )}

          {/* Selected Count */}
          <div className="mb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <p className="text-sm text-gray-600">
              {selectedProducts.length} product{selectedProducts.length !== 1 ? 's' : ''} selected (click to toggle)
            </p>
            {includeHiddenProducts && showHiddenProductsToggle && (
              <p className="text-xs text-gray-500">Listing includes items hidden from groups</p>
            )}
          </div>

          {/* Tabs: Bundles (default) | Single Products */}
          <div className="flex border-b border-gray-200 mb-4">
            <button
              type="button"
              onClick={() => setProductModalTab('bundles')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                productModalTab === 'bundles'
                  ? 'border-oe-primary text-oe-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Bundles {bundleProducts.length > 0 && `(${bundleProducts.length})`}
            </button>
            <button
              type="button"
              onClick={() => setProductModalTab('individual')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                productModalTab === 'individual'
                  ? 'border-oe-primary text-oe-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Single Products {individualProducts.length > 0 && `(${individualProducts.length})`}
            </button>
          </div>

          {/* Products List by tab */}
          <div className="max-h-96 overflow-y-auto">
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary"></div>
                <span className="ml-2 text-gray-600">Loading products...</span>
              </div>
            ) : productModalTab === 'bundles' ? (
              bundleProducts.length === 0 ? (
                <p className="text-gray-500 text-center py-8">No bundles found</p>
              ) : (
                <div className="space-y-2">
                  {bundleProducts.map(renderProductRow)}
                </div>
              )
            ) : individualProducts.length === 0 ? (
              <p className="text-gray-500 text-center py-8">No single products found</p>
            ) : (
              <div className="space-y-2">
                {individualProducts.map(renderProductRow)}
              </div>
            )}
          </div>
        </div>

        {/* Footer with Done button */}
        <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-white bg-oe-primary border border-transparent rounded-md hover:bg-oe-dark transition-colors"
          >
            Done ({selectedProducts.length} selected)
          </button>
        </div>
      </div>
    </div>
  );
};

export default GroupsAddGroup; 