// src/components/commissions/CommissionRulesManager.tsx
import { format } from 'date-fns';
import {
    AlertTriangle,
    Calculator,
    CheckCircle2,
    ChevronDown,
    ChevronUp,
    Copy,
    Edit,
    Filter,
    Layers,
    Loader2,
    Lock,
    MoreVertical,
    Plus,
    Sparkles,
    Trash2,
    X,
    XCircle
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import AgentManagementModal from '../../pages/tenant-admin/AgentManagementModal';
import { apiService } from '../../services/apiServices';
import { commissionGroupsService, type CommissionGroup, type CommissionGroupRule } from '../../services/commissionGroups.service';
import { TenantAdminAgentsService, type AgentRecord, type CommissionLevel } from '../../services/tenant-admin/agents.service';
import { TenantAdminService } from '../../services/tenant-admin/tenant-admin.service';
import { getMissingProductsForGroup, getMissingTiersForGroup, getSplitDisplayForRule, getTierDisplayForRule, getTierName } from '../../constants/form-options';
import SearchableDropdown from '../common/SearchableDropdown';
import CommissionSimulator from './CommissionSimulator';
import { GroupCommissionAIAssistant, ruleLooksTiered } from './ai/GroupCommissionAIAssistant';
import { MassUpdateRulesWizard } from './MassUpdateRulesWizard';
import { CommissionRuleHoverPreview } from './CommissionRuleHoverPreview';
import { RuleCreationWizard } from './RuleCreationWizard';

// Updated interface to include tenant fields from backend
interface CommissionRule {
  // Backend returns PascalCase fields matching database schema
  RuleId: string;
  RuleName: string;
  ProductId: string;
  ProductName?: string; // Joined from Products table
  ProductSalesType?: 'Individual' | 'Group' | 'Both' | string; // SalesType from Products table
  EntityType: 'Agent' | 'Agency' | 'Tier' | 'Split';
  EntityId?: string;
  agencyId?: string;
  agentid?: string;
  AgencyName?: string;
  AgentName?: string;
  /** Resolved scope: Tenant name, Agency name, or Agent name */
  Scope?: string;
  TierLevel?: number;
  CommissionType: 'Percentage' | 'Flat' | 'Tiered' | 'Split';
  CommissionRate?: number;
  FlatAmount?: number;
  TieredRates?: string;
  CommissionJson?: string;
  PaymentTiming: string;
  YearlySchedule?: string;
  MinimumPremium?: number;
  MaximumPremium?: number;
  EffectiveDate: string;
  TerminationDate?: string;
  Priority: number;
  Status: 'Active' | 'Inactive' | 'Pending' | 'Deleted';
  // New tenant fields
  TenantId?: string;
  TenantName?: string;
  IsGlobal: boolean;
  // Group field
  GroupId?: string;
  GroupName?: string;
  // Locked field
  Locked?: boolean;
  CreatedDate: string;
  ModifiedDate: string;
  CreatedBy?: string;
  ModifiedBy?: string;
}

interface CommissionRulesManagerProps {
  productId?: string;
  onRuleChange?: (ruleId: string) => void;
  onCreateRule?: () => void;
  readOnly?: boolean;
}

export const CommissionRulesManager: React.FC<CommissionRulesManagerProps> = ({
  productId,
  onRuleChange,
  onCreateRule,
  readOnly = false,
}) => {
  const [activeTab, setActiveTab] = useState<'levels' | 'groups' | 'rules'>('levels');
  const [rules, setRules] = useState<CommissionRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedRule, setSelectedRule] = useState<CommissionRule | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [massUpdateOpen, setMassUpdateOpen] = useState(false);
  const [selectedTenantId, setSelectedTenantId] = useState<string>('');
  const [selectedEntityType, setSelectedEntityType] = useState<string>('');
  const [selectedLockedStatus, setSelectedLockedStatus] = useState<string>(''); // 'locked', 'unlocked', or '' for all
  const [selectedProductId, setSelectedProductId] = useState<string>(''); // Filter by specific product or 'all'
  const [selectedAgencyId, setSelectedAgencyId] = useState<string>(''); // Filter by agency or agent
  const [tenantOptions, setTenantOptions] = useState<Array<{ id: string; label: string; value: string }>>([]);
  const [tenantSearchLoading, setTenantSearchLoading] = useState(false);
  const [products, setProducts] = useState<Array<{ ProductId: string; Name: string; SalesType?: string }>>([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [agencyOptions, setAgencyOptions] = useState<Array<{ id: string; label: string; value: string; type?: string }>>([]);
  const [selectedAgencyOrAgentType, setSelectedAgencyOrAgentType] = useState<string>('');
  const [agencySearchLoading, setAgencySearchLoading] = useState(false);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: 'success' | 'error' | 'warning' | 'info';
  }>({ open: false, message: '', severity: 'success' });
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [showSimulator, setShowSimulator] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [migrationModalOpen, setMigrationModalOpen] = useState(false);
  const [ruleToDelete, setRuleToDelete] = useState<CommissionRule | null>(null);
  const [agentsTiedToRule, setAgentsTiedToRule] = useState<Array<{ AgentId: string; AgentName: string; Email: string }>>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [selectedNewRuleId, setSelectedNewRuleId] = useState<string>('');
  const [availableRules, setAvailableRules] = useState<CommissionRule[]>([]);

  // Commission Groups state
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groups, setGroups] = useState<CommissionGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string>('');
  const [groupRulesLoading, setGroupRulesLoading] = useState(false);
  const [groupRules, setGroupRules] = useState<CommissionGroupRule[]>([]);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupDescription, setNewGroupDescription] = useState('');
  const [newGroupCopyFromId, setNewGroupCopyFromId] = useState('');
  const [newGroupCopyMode, setNewGroupCopyMode] = useState<'duplicate' | 'shared'>('duplicate');
  const [newGroupAgentsCanViewOthers, setNewGroupAgentsCanViewOthers] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [createModalGroups, setCreateModalGroups] = useState<CommissionGroup[]>([]);
  const [createModalGroupsLoading, setCreateModalGroupsLoading] = useState(false);
  const [selectedRuleToAdd, setSelectedRuleToAdd] = useState<string>('');
  const selectedRuleToAddRef = useRef<string>('');
  useEffect(() => {
    selectedRuleToAddRef.current = selectedRuleToAdd;
  }, [selectedRuleToAdd]);
  const [createGroupModalOpen, setCreateGroupModalOpen] = useState(false);
  const [editGroupModalOpen, setEditGroupModalOpen] = useState(false);
  const [editGroupName, setEditGroupName] = useState('');
  const [editGroupDescription, setEditGroupDescription] = useState('');
  const [editGroupStatus, setEditGroupStatus] = useState<'Active' | 'Inactive'>('Active');
  const [editGroupAgentsCanViewOthers, setEditGroupAgentsCanViewOthers] = useState(false);
  const [groupCreateRuleWizardOpen, setGroupCreateRuleWizardOpen] = useState(false);
  const [groupFilterAgentId, setGroupFilterAgentId] = useState<string>('');
  const [groupFilterAgencyId, setGroupFilterAgencyId] = useState<string>('');
  const [groupFilterSearch, setGroupFilterSearch] = useState<string>('');
  const [groupsPage, setGroupsPage] = useState(1);
  const [groupsPagination, setGroupsPagination] = useState<{ page: number; limit: number; total: number }>({ page: 1, limit: 20, total: 0 });
  const [manageRulesModalOpen, setManageRulesModalOpen] = useState(false);
  const editRuleFromManageRulesRef = useRef(false);
  const reopenManageRulesAfterWizardRef = useRef(false);
  const [addRuleOptions, setAddRuleOptions] = useState<Array<{ id: string; value: string; label: string; sublabel?: string; tooltip?: string }>>([]);
  const [addRuleOptionsLoading, setAddRuleOptionsLoading] = useState(false);
  const [groupAiModalOpen, setGroupAiModalOpen] = useState(false);
  const [groupPreviewGroupId, setGroupPreviewGroupId] = useState<string | null>(null);
  const [pendingRuleRemovals, setPendingRuleRemovals] = useState<Set<string>>(new Set());
  const [pendingRuleAdditions, setPendingRuleAdditions] = useState<Array<{ ruleId: string; ruleName: string; label: string }>>([]);
  const [savingChanges, setSavingChanges] = useState(false);
  const [groupRuleToEdit, setGroupRuleToEdit] = useState<CommissionGroupRule | null>(null);
  const [groupRuleFullForEdit, setGroupRuleFullForEdit] = useState<CommissionRule | null>(null);
  const [groupRuleEditLoading, setGroupRuleEditLoading] = useState(false);
  const [duplicateInGroupModalOpen, setDuplicateInGroupModalOpen] = useState(false);
  const [duplicateInGroupRule, setDuplicateInGroupRule] = useState<CommissionGroupRule | null>(null);
  const [duplicateInGroupName, setDuplicateInGroupName] = useState('');
  const [duplicateInGroupLoading, setDuplicateInGroupLoading] = useState(false);
  const [groupModalProducts, setGroupModalProducts] = useState<Array<{ ProductId: string; Name: string }>>([]);
  const [groupModalProductsLoading, setGroupModalProductsLoading] = useState(false);
  const [commissionLevelsLoading, setCommissionLevelsLoading] = useState(false);
  const [commissionLevels, setCommissionLevels] = useState<CommissionLevel[]>([]);
  const [newLevelDisplayName, setNewLevelDisplayName] = useState('');
  const [newLevelSortOrder, setNewLevelSortOrder] = useState('');
  const [newLevelModalOpen, setNewLevelModalOpen] = useState(false);
  const [savingLevel, setSavingLevel] = useState(false);
  const [levelStatusModalOpen, setLevelStatusModalOpen] = useState(false);
  const [levelStatusTarget, setLevelStatusTarget] = useState<CommissionLevel | null>(null);
  const [levelStatusMode, setLevelStatusMode] = useState<'activate' | 'deactivate'>('deactivate');
  const [deactivateStrategy, setDeactivateStrategy] = useState<'keep_legacy' | 'merge_to_level' | 'delete_permanently'>('keep_legacy');
  const [deactivateMergeTargetLevelId, setDeactivateMergeTargetLevelId] = useState('');
  const [levelUsageCount, setLevelUsageCount] = useState(0);
  const [levelAgencyUsageCount, setLevelAgencyUsageCount] = useState(0);
  const [loadingLevelUsage, setLoadingLevelUsage] = useState(false);
  const [levelAgentsModalOpen, setLevelAgentsModalOpen] = useState(false);
  const [levelAgentsTarget, setLevelAgentsTarget] = useState<CommissionLevel | null>(null);
  const [levelAgentsSearch, setLevelAgentsSearch] = useState('');
  const [levelAgentsPage, setLevelAgentsPage] = useState(1);
  const [levelAgentsLoading, setLevelAgentsLoading] = useState(false);
  const [levelAgentsRows, setLevelAgentsRows] = useState<AgentRecord[]>([]);
  const [levelAgentsPagination, setLevelAgentsPagination] = useState({ page: 1, limit: 15, total: 0, pages: 1 });
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [editingLevelId, setEditingLevelId] = useState<string | null>(null);
  const [editLevelDisplayName, setEditLevelDisplayName] = useState('');
  const [editLevelSortOrder, setEditLevelSortOrder] = useState('');

  // Note: apiService handles authentication automatically, so getAuthHeaders is no longer needed

  // Get current user info
  const getCurrentUser = () => {
    const storedRoles = localStorage.getItem('roles');
    const roles = storedRoles ? JSON.parse(storedRoles) : [];
    const currentRole = localStorage.getItem('currentRole') || roles[0] || null;
    // Use currentTenantId (active tenant) instead of tenantId (primary tenant)
    // This ensures tenant switching works correctly
    const tenantId = localStorage.getItem('currentTenantId') || localStorage.getItem('tenantId');
    const userId = localStorage.getItem('userId');
    
    return {
      roles,
      currentRole,
      tenantId,
      userId
    };
  };

  const currentRole = getCurrentUser().currentRole;
  const canManageGroups = currentRole === 'TenantAdmin' || currentRole === 'SysAdmin';
  const canManageLevels = currentRole === 'TenantAdmin' || currentRole === 'SysAdmin';

  const tenantTierLevelsForGroupAi = useMemo(() => {
    return commissionLevels
      .filter((level) => level.IsActive !== false)
      .map((level) => ({
        level: Number(level.SortOrder),
        name: String(level.DisplayName || `Level ${level.SortOrder}`),
      }))
      .filter((t) => Number.isFinite(t.level))
      .sort((a, b) => a.level - b.level);
  }, [commissionLevels]);

  // Check user role
  const checkUserRole = (): { hasAccess: boolean; role: string | null } => {
    const { currentRole } = getCurrentUser();
    const hasAccess = currentRole === 'SysAdmin' || currentRole === 'Agent' || currentRole === 'TenantAdmin';
    
    console.log('🔍 CommissionRulesManager - Role Check:', {
      currentRole,
      hasAccess,
    });
    
    return { hasAccess, role: currentRole };
  };

  // Commission Rule Service
  const commissionRuleService = {
    async getRules(filters: any) {
      const params = new URLSearchParams();
      if (filters.productId) params.append('productId', filters.productId);
      if (filters.entityType) params.append('entityType', filters.entityType);
      if (filters.entityId) params.append('entityId', filters.entityId);
      if (filters.status) params.append('status', filters.status);
      if (filters.locked !== undefined && filters.locked !== '') {
        params.append('locked', filters.locked === 'locked' ? 'true' : 'false');
      }
      
      try {
        const data = await apiService.get<{ success: boolean; rules?: any[] } | any[]>(`/api/commissions/rules?${params}`);
        console.log('Rules API response:', data);
        
        // Backend returns { success: true, rules: [...] }
        if (data && typeof data === 'object' && 'success' in data && Array.isArray((data as any).rules)) {
          return (data as any).rules;
        } else if (Array.isArray(data)) {
          return data;
        } else {
          console.warn('Unexpected rules response format:', data);
          return [];
        }
      } catch (error: any) {
        console.error('API Error:', error);
        if (error.status === 403 || error.status === 401) {
          throw new Error('UNAUTHORIZED');
        }
        throw new Error(error.message || 'Failed to fetch rules');
      }
    },

    async getRuleById(ruleId: string) {
      try {
        const data = await apiService.get<{ success: boolean; rule?: any }>(`/api/commissions/rules/${ruleId}`);
        
        // Backend returns { success: true, rule: {...} }
        if (data && typeof data === 'object' && 'success' in data && (data as any).rule) {
          return (data as any).rule;
        }
        
        throw new Error('Rule not found');
      } catch (error: any) {
        console.error('API Error:', error);
        if (error.status === 403 || error.status === 401) {
          throw new Error('UNAUTHORIZED');
        }
        if (error.status === 404) {
          throw new Error('Rule not found');
        }
        throw new Error(error.message || 'Failed to fetch rule');
      }
    },

    async createRule(rule: any) {
      try {
        return await apiService.post<{ success: boolean; [key: string]: any }>('/api/commissions/rules', rule);
      } catch (error: any) {
        throw new Error(error.message || 'Failed to create rule');
      }
    },

    async updateRule(ruleId: string, updates: any) {
      try {
        return await apiService.put<{ success: boolean; [key: string]: any }>(`/api/commissions/rules/${ruleId}`, updates);
      } catch (error: any) {
        throw new Error(error.message || 'Failed to update rule');
      }
    },

    async deleteRule(ruleId: string, newCommissionRuleId?: string) {
      try {
        return await apiService.delete<{ success: boolean; [key: string]: any }>(`/api/commissions/rules/${ruleId}`, {
          data: newCommissionRuleId ? { newCommissionRuleId } : undefined,
        });
      } catch (error: any) {
        throw new Error(error.message || 'Failed to delete rule');
      }
    },

    async checkRuleUsage(ruleId: string) {
      try {
        return await apiService.get<{ success: boolean; isInUse: boolean; agentCount: number; commissionCount: number; canUnlock: boolean }>(`/api/commissions/rules/${ruleId}/usage-check`);
      } catch (error: any) {
        throw new Error(error.message || 'Failed to check rule usage');
      }
    },

    async unlockRule(ruleId: string) {
      try {
        return await apiService.put<{ success: boolean; message?: string }>(`/api/commissions/rules/${ruleId}/unlock`);
      } catch (error: any) {
        throw new Error(error.message || 'Failed to unlock rule');
      }
    },

    async exportRules(filters: any) {
      const rules = await this.getRules(filters);
      return rules;
    },

    async importRules(data: any) {
      // Import rules one by one
      for (const rule of data) {
        await this.createRule(rule);
      }
    },
  };

  // Load products for filter - filter by tenant if selected, exclude bundles
  const loadProducts = useCallback(async () => {
    const currentUser = getCurrentUser();
    if (currentUser.currentRole !== 'TenantAdmin' && currentUser.currentRole !== 'SysAdmin') {
      return;
    }

    try {
      setLoadingProducts(true);
      let response;
      
      if (currentUser.currentRole === 'SysAdmin') {
        // If tenant is selected, get products for that tenant
        if (selectedTenantId && selectedTenantId !== 'global') {
          response = await apiService.get<{ success: boolean; data?: any[] }>(`/api/tenants/${selectedTenantId}/products`);
        } else {
          response = await apiService.get<{ success: boolean; data?: any[] }>('/api/admin/products');
        }
      } else {
        response = await TenantAdminService.getSubscribedProducts();
      }
      
      if (response.success && response.data) {
        const productsList = Array.isArray(response.data) ? response.data : [];
        const formattedProducts = productsList
          .filter((p: any) => 
            p.Status === 'Active' && 
            (!p.IsHidden || p.IsHidden === 0) &&
            (!p.IsBundle || p.IsBundle === 0) // Exclude bundles
          )
          .map((p: any) => ({
            ProductId: p.ProductId || p.productId,
            Name: p.Name || p.ProductName || p.name,
            SalesType: p.SalesType || p.salesType
          }));
        setProducts(formattedProducts);
      }
    } catch (error) {
      console.error('Error loading products:', error);
    } finally {
      setLoadingProducts(false);
    }
  }, [selectedTenantId]);

  // Search for tenants (SysAdmin only) - using SearchableDropdown with backend search
  const searchTenants = useCallback(async (query: string) => {
    const currentUser = getCurrentUser();
    if (currentUser.currentRole !== 'SysAdmin') {
      setTenantOptions([]);
      return;
    }

    try {
      setTenantSearchLoading(true);
      const params = new URLSearchParams();
      if (query && query.trim().length > 0) {
        params.append('search', query.trim());
      }
      params.append('lightweight', 'true'); // Use lightweight mode for faster results
      
      const response = await apiService.get<{ success: boolean; data?: Array<{ TenantId: string; Name: string }> }>(`/api/tenants?${params.toString()}`);
      
      if (response.success && response.data) {
        const tenantList = [
          { id: 'global', label: 'Global Rules', value: 'global' },
          ...response.data.map((tenant) => ({
            id: tenant.TenantId,
            label: tenant.Name,
            value: tenant.TenantId
          }))
        ];
        setTenantOptions(tenantList);
      } else {
        setTenantOptions([{ id: 'global', label: 'Global Rules', value: 'global' }]);
      }
    } catch (error) {
      console.error('Error searching tenants:', error);
      setTenantOptions([{ id: 'global', label: 'Global Rules', value: 'global' }]);
    } finally {
      setTenantSearchLoading(false);
    }
  }, []);

  // Search for agencies and agents - memoized to prevent re-render loops
  const searchAgencies = useCallback(async (query: string) => {
    const currentUser = getCurrentUser();
    if (currentUser.currentRole !== 'TenantAdmin' && currentUser.currentRole !== 'SysAdmin') {
      setAgencyOptions([]);
      return;
    }

    // If no query or empty query, load initial results (both agencies and agents)
    if (!query || query.trim().length === 0) {
      try {
        setAgencySearchLoading(true);
        const response = await TenantAdminAgentsService.getAgentsAndAgencies({
          status: 'Active',
          page: 1,
          limit: 20
        });

        if (response.success && response.data && Array.isArray(response.data)) {
          const entities = response.data.map((item: any) => ({
            id: item.Id || item.id,
            label: `${item.Name || item.name}${item.Type === 'Agency' ? ' (Agency)' : ' (Agent)'}`,
            value: item.Id || item.id,
            type: item.Type
          }));
          setAgencyOptions(entities);
        } else {
          setAgencyOptions([]);
        }
      } catch (error) {
        console.error('❌ Error loading initial agencies/agents:', error);
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
      // Search both agencies and agents (no type filter)
      const response = await TenantAdminAgentsService.getAgentsAndAgencies({
        search: query,
        status: 'Active',
        page: 1,
        limit: 20
      });

      if (response.success && response.data && Array.isArray(response.data)) {
        const entities = response.data.map((item: any) => ({
          id: item.Id || item.id,
          label: `${item.Name || item.name}${item.Type === 'Agency' ? ' (Agency)' : ' (Agent)'}`,
          value: item.Id || item.id,
          type: item.Type
        }));
        setAgencyOptions(entities);
      } else {
        setAgencyOptions([]);
      }
    } catch (error) {
      console.error('❌ Error searching agencies/agents:', error);
      setAgencyOptions([]);
    } finally {
      setAgencySearchLoading(false);
    }
  }, []);


  // Load rules
  const loadRules = useCallback(async () => {
    try {
      setLoading(true);
      setAuthError(null);
      
      // Check user role first
      const { hasAccess, role } = checkUserRole();
      if (!hasAccess) {
        setAuthError(`Access denied. This feature requires TenantAdmin or SysAdmin role. Your role: ${role || 'Unknown'}`);
        setRules([]);
        return;
      }
      
      const entityTypeForFilter = selectedAgencyOrAgentType;
      const data = await commissionRuleService.getRules({
        productId,
        entityType: selectedEntityType || entityTypeForFilter || undefined,
        entityId: selectedAgencyId || undefined,
        locked: selectedLockedStatus || undefined,
      });
      // Normalize backend fields (IsGlobal may arrive as 1/0)
      setRules(
        (Array.isArray(data) ? data : []).map((r: any) => ({
          ...r,
          IsGlobal: Boolean(r.IsGlobal),
        }))
      );
    } catch (error: any) {
      console.error('Error loading rules:', error);
      
      if (error.message === 'UNAUTHORIZED') {
        const { role } = checkUserRole();
        setAuthError(`Access denied. Your role (${role}) does not have permission to view commission rules.`);
        setRules([]);
      } else {
        const errorMessage = error.message || 'Failed to load commission rules';
        showSnackbar(`Error: ${errorMessage}`, 'error');
        
        // If it's a 500 error, show more helpful message
        if (errorMessage.includes('500')) {
          console.error('Server error - check backend logs for details');
          showSnackbar('Server error occurred. Please check backend logs.', 'error');
        }
      }
    } finally {
      setLoading(false);
    }
  }, [productId, selectedAgencyId, selectedAgencyOrAgentType, selectedEntityType, selectedLockedStatus, selectedTenantId]);

  const loadSelectedGroupRules = useCallback(async (groupId: string) => {
    if (!groupId) {
      setGroupRules([]);
      return;
    }
    try {
      setGroupRulesLoading(true);
      const data = await commissionGroupsService.listGroupRules(groupId);
      setGroupRules(data);
    } catch (error: any) {
      console.error('Error loading commission group rules:', error);
      showSnackbar(error?.message ? `Error: ${error.message}` : 'Failed to load group rules', 'error');
      setGroupRules([]);
    } finally {
      setGroupRulesLoading(false);
    }
  }, []);

  const loadGroups = useCallback(async (page = groupsPage) => {
    try {
      setGroupsLoading(true);
      const result = await commissionGroupsService.listGroups({
        page,
        limit: 20,
        search: groupFilterSearch || undefined,
        agentId: groupFilterAgentId || undefined,
        agencyId: groupFilterAgencyId || undefined
      });
      setGroups(result.groups);
      setGroupsPagination(result.pagination);
      if (!selectedGroupId && result.groups.length > 0) {
        setSelectedGroupId(result.groups[0].CommissionGroupId);
        loadSelectedGroupRules(result.groups[0].CommissionGroupId);
      }
    } catch (error: any) {
      console.error('Error loading commission groups:', error);
      showSnackbar(error?.message ? `Error: ${error.message}` : 'Failed to load commission groups', 'error');
      setGroups([]);
    } finally {
      setGroupsLoading(false);
    }
  }, [loadSelectedGroupRules, selectedGroupId, groupsPage, groupFilterSearch, groupFilterAgentId, groupFilterAgencyId]);

  const copyRulesToNewGroup = useCallback(async (
    sourceGroupId: string,
    destinationGroupId: string,
    mode: 'duplicate' | 'shared',
    /** When duplicating rules, appended as `${RuleName} - ${suffix}` (use the new group name from the create form). */
    duplicateRuleNameSuffix?: string
  ) => {
    const rules = await commissionGroupsService.listGroupRules(sourceGroupId);
    if (rules.length === 0) return { copied: 0 };
    if (mode === 'shared') {
      for (const r of rules) {
        await commissionGroupsService.addRuleToGroup(destinationGroupId, r.RuleId);
      }
      return { copied: rules.length };
    }
    // duplicate mode: clone each rule as a new inactive rule, then add those clones
    const nameSuffix = duplicateRuleNameSuffix?.trim() || 'Copy';
    const currentUser = getCurrentUser();
    let copied = 0;
    for (const r of rules) {
      const fullRule = await commissionRuleService.getRuleById(r.RuleId);
      const newRulePayload = {
        ruleName: `${fullRule.RuleName} - ${nameSuffix}`,
        productId: fullRule.ProductId || '00000000-0000-0000-0000-000000000000',
        productName: fullRule.ProductName || 'All Products',
        entityType: fullRule.EntityType,
        tierLevel: fullRule.TierLevel,
        commissionType: fullRule.CommissionType,
        commissionRate: fullRule.CommissionRate,
        flatAmount: fullRule.FlatAmount,
        commissionJson: fullRule.CommissionJson || '',
        effectiveDate: fullRule.EffectiveDate ? new Date(fullRule.EffectiveDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
        terminationDate: fullRule.TerminationDate ? new Date(fullRule.TerminationDate).toISOString().split('T')[0] : null,
        status: 'Inactive' as const,
        priority: fullRule.Priority ?? 100,
        tenantId: currentUser.currentRole === 'TenantAdmin' ? currentUser.tenantId : fullRule.TenantId,
        groupId: fullRule.GroupId,
        locked: false
      };
      const createRes = await apiService.post<{ success?: boolean; ruleId?: string }>('/api/commissions/rules', newRulePayload);
      const newRuleId = createRes?.ruleId;
      if (!newRuleId) throw new Error(`Failed to duplicate rule "${fullRule.RuleName}"`);
      await commissionGroupsService.addRuleToGroup(destinationGroupId, newRuleId);
      copied += 1;
    }
    return { copied };
  }, []);

  const loadCommissionLevels = useCallback(async () => {
    try {
      setCommissionLevelsLoading(true);
      const response = await TenantAdminAgentsService.getCommissionLevels(true);
      if (response.success && Array.isArray(response.data)) {
        setCommissionLevels(
          [...response.data].sort((a, b) => Number(a.SortOrder) - Number(b.SortOrder))
        );
      } else {
        setCommissionLevels([]);
      }
    } catch {
      setCommissionLevels([]);
    } finally {
      setCommissionLevelsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'rules') {
      loadRules();
      loadProducts();
    } else if (activeTab === 'levels') {
      loadCommissionLevels();
    } else {
      loadGroups(groupsPage);
    }
  }, [activeTab, loadCommissionLevels, loadGroups, loadRules, loadProducts, selectedEntityType, selectedLockedStatus, selectedTenantId, selectedAgencyId, groupsPage]);

  // Reset to page 1 when group filters change
  useEffect(() => {
    if (activeTab === 'groups') {
      setGroupsPage(1);
    }
  }, [activeTab, groupFilterSearch, groupFilterAgentId, groupFilterAgencyId]);

  const searchAvailableRulesForGroup = useCallback(async (query: string) => {
    if (!selectedGroupId) {
      setAddRuleOptions([]);
      return;
    }
    try {
      setAddRuleOptionsLoading(true);
      const { rules: list } = await commissionGroupsService.getAvailableRulesForGroup(selectedGroupId, {
        search: query || undefined,
        page: 1,
        limit: 30
      });
      setAddRuleOptions(
        list.map((r) => {
          const tierDisplay = getTierDisplayForRule(r);
          const tierPart = tierDisplay ? ` • ${tierDisplay}` : '';
          return {
            id: r.RuleId,
            value: r.RuleId,
            label: `${r.RuleName} • ${r.ProductName || (r.ProductId === '00000000-0000-0000-0000-000000000000' ? 'All' : r.ProductId)} • ${r.EntityType}${tierPart} • ${r.CommissionType}`,
            sublabel: r.Locked ? 'Active' : 'Inactive',
            tooltip: `${r.RuleName}\nProduct: ${r.ProductName || (r.ProductId === '00000000-0000-0000-0000-000000000000' ? 'All Products' : r.ProductId)}\nType: ${r.CommissionType}${tierDisplay ? `\nTier: ${tierDisplay}` : ''}${r.CommissionRate != null ? ` • ${(r.CommissionRate * 100).toFixed(1)}%` : ''}${r.FlatAmount != null ? ` • $${r.FlatAmount}` : ''}`
          };
        })
      );
    } catch (e: any) {
      console.error('Error searching available rules:', e);
      setAddRuleOptions([]);
    } finally {
      setAddRuleOptionsLoading(false);
    }
  }, [selectedGroupId]);

  // Pre-load available rules when manage modal opens
  useEffect(() => {
    if (manageRulesModalOpen && selectedGroupId && canManageGroups) {
      searchAvailableRulesForGroup('');
    }
  }, [manageRulesModalOpen, selectedGroupId, canManageGroups, searchAvailableRulesForGroup]);

  // Load tenant products when manage modal opens (for Missing products warning)
  useEffect(() => {
    if (!manageRulesModalOpen || !selectedGroupId) return;
    const group = groups.find((g) => g.CommissionGroupId === selectedGroupId);
    if (!group?.TenantId) return;
    const loadProductsForGroup = async () => {
      setGroupModalProductsLoading(true);
      try {
        const currentUser = getCurrentUser();
        let response: { success?: boolean; data?: any[] };
        if (currentUser.currentRole === 'SysAdmin') {
          response = await apiService.get<{ success: boolean; data?: any[] }>(`/api/tenants/${group.TenantId}/products?status=Active`);
        } else {
          response = await TenantAdminService.getSubscribedProducts();
        }
        const data = response?.data ?? (response as any)?.data ?? [];
        const list = Array.isArray(data) ? data : [];
        const formatted = list
          .filter((p: any) => {
            const status = p.Status ?? p.status;
            const isBundle = p.IsBundle ?? p.isBundle ?? (p.ProductType === 'Bundle' || p.productType === 'Bundle');
            const isHidden = p.IsHidden ?? p.isHidden;
            return status === 'Active' && (!isHidden || isHidden === 0) && !isBundle;
          })
          .map((p: any) => ({ ProductId: p.ProductId || p.productId, Name: p.Name || p.ProductName || p.productName || p.name }));
        setGroupModalProducts(formatted);
      } catch {
        setGroupModalProducts([]);
      } finally {
        setGroupModalProductsLoading(false);
      }
    };
    loadProductsForGroup();
  }, [manageRulesModalOpen, selectedGroupId, groups]);

  // Load groups for "duplicate from" dropdown when create modal opens
  useEffect(() => {
    if (!createGroupModalOpen) return;
    setNewGroupCopyFromId('');
    setCreateModalGroupsLoading(true);
    commissionGroupsService.listGroups({ limit: 200 })
      .then((r) => {
        setCreateModalGroups(r.groups ?? []);
      })
      .catch(() => setCreateModalGroups([]))
      .finally(() => setCreateModalGroupsLoading(false));
  }, [createGroupModalOpen]);

  // Fetch full rule when editing a group rule
  useEffect(() => {
    if (groupRuleToEdit && groupCreateRuleWizardOpen) {
      setGroupRuleEditLoading(true);
      setGroupRuleFullForEdit(null);
      commissionRuleService.getRuleById(groupRuleToEdit.RuleId)
        .then((r) => {
          setGroupRuleFullForEdit(r);
          setGroupRuleEditLoading(false);
        })
        .catch((e) => {
          console.error('Failed to fetch rule for edit:', e);
          showSnackbar('Failed to load rule for editing', 'error');
          setGroupCreateRuleWizardOpen(false);
          setGroupRuleToEdit(null);
          setGroupRuleEditLoading(false);
        });
    } else {
      setGroupRuleFullForEdit(null);
      setGroupRuleEditLoading(false);
    }
  }, [groupRuleToEdit?.RuleId, groupCreateRuleWizardOpen]);

  // Show snackbar
  const showSnackbar = (
    message: string,
    severity: 'success' | 'error' | 'warning' | 'info'
  ) => {
    setSnackbar({ open: true, message, severity });
  };

  // Handle menu actions (pass event to position menu for portal)
  const handleMenuClick = (ruleId: string, e?: React.MouseEvent) => {
    if (menuOpen === ruleId) {
      setMenuOpen(null);
      setMenuPosition(null);
      return;
    }
    if (e) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setMenuPosition({ top: rect.bottom, left: rect.left });
    }
    setMenuOpen(ruleId);
  };

  const handleMenuClose = () => {
    setMenuOpen(null);
    setMenuPosition(null);
  };

  // Close menu when clicking outside (menu is in portal)
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const menuEl = document.getElementById('commission-rules-action-menu');
      const trigger = document.querySelector('[data-commission-rule-menu-trigger]');
      if (menuOpen && !menuEl?.contains(target) && !trigger?.contains(target)) {
        handleMenuClose();
      }
    };

    if (menuOpen) {
      const timeoutId = setTimeout(() => {
        document.addEventListener('mousedown', handleClickOutside);
      }, 0);
      return () => {
        clearTimeout(timeoutId);
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [menuOpen]);

  const handleEditRule = (rule: CommissionRule) => {
    const currentUser = getCurrentUser();
    
    // Note: Locked rules can still be opened to edit Termination Date only
    // The wizard will handle disabling fields appropriately
    
    // Check if TenantAdmin is trying to edit a global rule
    if (currentUser.currentRole === 'TenantAdmin' && rule.IsGlobal) {
      showSnackbar('You cannot edit global commission rules', 'warning');
      return;
    }
    
    // Check if TenantAdmin is trying to edit another tenant's rule
    if (currentUser.currentRole === 'TenantAdmin' && rule.TenantId && rule.TenantId !== currentUser.tenantId) {
      showSnackbar('You can only edit rules for your own tenant', 'warning');
      return;
    }
    
    setSelectedRule(rule);
    setWizardOpen(true);
    handleMenuClose();
  };

  const handleUnlockRule = async (rule: CommissionRule) => {
    try {
      handleMenuClose();
      
      // Check if rule is in use
      const usageCheck = await commissionRuleService.checkRuleUsage(rule.RuleId);
      
      if (!usageCheck.success) {
        showSnackbar('Failed to check rule usage', 'error');
        return;
      }
      
      if (usageCheck.isInUse) {
        const message = `Cannot unlock rule: it is currently in use (${usageCheck.agentCount} agent(s) assigned, ${usageCheck.commissionCount} commission(s) recorded)`;
        showSnackbar(message, 'warning');
        return;
      }
      
      // Unlock the rule
      const response = await commissionRuleService.unlockRule(rule.RuleId);
      
      if (response.success) {
        showSnackbar('Rule unlocked successfully', 'success');
        loadRules(); // Reload to update the UI
      } else {
        showSnackbar(response.message || 'Failed to unlock rule', 'error');
      }
    } catch (error: any) {
      console.error('Error unlocking rule:', error);
      const errorMessage = error?.message || 'Failed to unlock rule';
      showSnackbar(errorMessage, 'error');
    }
  };

  const handleDuplicateRule = async (rule: CommissionRule) => {
    try {
      const currentUser = getCurrentUser();
      
      // Map the rule to CreateRuleDTO format
      const newRuleData = {
        ruleName: `${rule.RuleName} (Copy)`,
        productId: rule.ProductId || '00000000-0000-0000-0000-000000000000',
        productName: rule.ProductName || 'All Products',
        entityType: rule.EntityType as 'Agent' | 'Agency' | 'Tier' | 'Split',
        tierLevel: rule.TierLevel,
        commissionType: rule.CommissionType as 'Percentage' | 'Flat' | 'Tiered' | 'Split',
        rate: rule.CommissionRate,
        amount: rule.FlatAmount,
        effectiveDate: rule.EffectiveDate ? new Date(rule.EffectiveDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
        terminationDate: rule.TerminationDate ? new Date(rule.TerminationDate).toISOString().split('T')[0] : null,
        status: (rule.Status || 'Active') as 'Active' | 'Inactive' | 'Pending',
        priority: rule.Priority || 100,
        commissionJson: rule.CommissionJson || '',
        tenantId: currentUser.currentRole === 'TenantAdmin' ? currentUser.tenantId : rule.TenantId,
        groupId: rule.GroupId,
        locked: false, // Always unlock duplicated rules by default
      };
      
      const response = await commissionRuleService.createRule(newRuleData);
      
      // Get the newly created rule ID from the response
      const newRuleId = response?.ruleId;
      
      if (newRuleId) {
        // Fetch the complete rule object
        const newRule = await commissionRuleService.getRuleById(newRuleId);
        
        // Open the wizard with the new rule
        setSelectedRule(newRule);
        setWizardOpen(true);
        
        showSnackbar('Rule duplicated successfully', 'success');
      } else {
        // Fallback: reload rules if we can't get the ID
        showSnackbar('Rule duplicated successfully', 'success');
        loadRules();
      }
    } catch (error: any) {
      console.error('Error duplicating rule:', error);
      const errorMessage = error?.message || 'Failed to duplicate rule';
      showSnackbar(errorMessage, 'error');
    }
    handleMenuClose();
  };

  const handleDeleteClick = async (rule: CommissionRule) => {
    const currentUser = getCurrentUser();
    
    // Check if rule is locked
    if (rule.Locked) {
      showSnackbar('This commission rule is locked and cannot be deleted.', 'warning');
      handleMenuClose();
      return;
    }
    
    // Check permissions
    if (currentUser.currentRole === 'TenantAdmin') {
      if (rule.IsGlobal) {
        showSnackbar('You cannot delete global commission rules', 'warning');
        handleMenuClose();
        return;
      }
      if (rule.TenantId && rule.TenantId !== currentUser.tenantId) {
        showSnackbar('You can only delete rules for your own tenant', 'warning');
        handleMenuClose();
        return;
      }
    }
    
    // Close menu first
    handleMenuClose();
    
    // Set rule to delete
    setRuleToDelete(rule);
    setSelectedNewRuleId('');
    setAgentsTiedToRule([]);
    
    // Check if agents are tied to this rule
    try {
      setLoadingAgents(true);
      const response = await apiService.get<{ success: boolean; data: Array<{ AgentId: string; AgentName: string; Email: string }>; count: number }>(
        `/api/commissions/rules/${rule.RuleId}/agents`
      );
      
      if (response.success && response.data && response.data.length > 0) {
        setAgentsTiedToRule(response.data);
        // Load available rules for migration (excluding the one being deleted and locked rules)
        const availableRulesList = rules.filter(r => 
          r.RuleId !== rule.RuleId && 
          !r.Locked && 
          r.Status !== 'Deleted' &&
          (currentUser.currentRole === 'SysAdmin' || r.TenantId === currentUser.tenantId || r.IsGlobal)
        );
        setAvailableRules(availableRulesList);
        // Show migration modal first
        setMigrationModalOpen(true);
      } else {
        setAgentsTiedToRule([]);
        // No agents tied, go straight to confirmation
        setDeleteConfirmOpen(true);
      }
    } catch (error: any) {
      console.error('Error checking agents for rule:', error);
      // If error, assume no agents (will fail on delete if wrong)
      setAgentsTiedToRule([]);
      setDeleteConfirmOpen(true);
    } finally {
      setLoadingAgents(false);
    }
  };

  const handleMigrationContinue = () => {
    if (!selectedNewRuleId) {
      showSnackbar('Please select a new commission rule to assign the agents to', 'warning');
      return;
    }
    // Close migration modal and show confirmation
    setMigrationModalOpen(false);
    setDeleteConfirmOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!ruleToDelete) return;

    try {
      // Delete with optional migration
      await commissionRuleService.deleteRule(ruleToDelete.RuleId, selectedNewRuleId || undefined);
      showSnackbar(
        agentsTiedToRule.length > 0 
          ? `Rule deleted successfully. ${agentsTiedToRule.length} agent(s) migrated to new rule.`
          : 'Rule deleted successfully',
        'success'
      );
      loadRules();
      if (onRuleChange) onRuleChange(ruleToDelete.RuleId);
      setDeleteConfirmOpen(false);
      setRuleToDelete(null);
      setAgentsTiedToRule([]);
      setSelectedNewRuleId('');
    } catch (error: any) {
      console.error('Error deleting rule:', error);
      const errorMessage = error?.message || 'Failed to delete rule';
      showSnackbar(errorMessage, 'error');
    }
  };

  // Helper function to determine if a rule is active
  // A rule is active if: Locked = true AND EffectiveDate <= Today AND (TerminationDate IS NULL OR TerminationDate >= Today)
  const isRuleActive = (rule: CommissionRule): boolean => {
    if (!rule.Locked) return false;
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const effectiveDate = rule.EffectiveDate ? new Date(rule.EffectiveDate) : null;
    if (!effectiveDate || effectiveDate > today) return false;
    
    if (rule.TerminationDate) {
      const terminationDate = new Date(rule.TerminationDate);
      terminationDate.setHours(0, 0, 0, 0);
      if (terminationDate < today) return false;
    }
    
    return true;
  };

  // Filter rules based on search term, tenant, entity type, and locked status
  const getFilteredRules = () => {
    let filtered = rules;

    // Filter by tenant
    if (selectedTenantId) {
      filtered = filtered.filter(rule => {
        if (selectedTenantId === 'global') {
          // Backend may return IsGlobal as 1/0, so treat any truthy value as global
          return Boolean((rule as any).IsGlobal);
        }
        return rule.TenantId === selectedTenantId;
      });
    }

    // Filter by entity type (rule type)
    if (selectedEntityType) {
      filtered = filtered.filter(rule => rule.EntityType === selectedEntityType);
    }

    // Filter by locked status (handled on backend, but also filter client-side for consistency)
    if (selectedLockedStatus === 'locked') {
      filtered = filtered.filter(rule => rule.Locked === true);
    } else if (selectedLockedStatus === 'unlocked') {
      filtered = filtered.filter(rule => !rule.Locked);
    }

    // Filter by product
    if (selectedProductId) {
      if (selectedProductId === 'all-products') {
        // Show rules for "All Products" (ProductId = '00000000-0000-0000-0000-000000000000')
        filtered = filtered.filter(rule => rule.ProductId === '00000000-0000-0000-0000-000000000000');
      } else {
        // Show rules for specific product
        filtered = filtered.filter(rule => rule.ProductId === selectedProductId);
      }
    }

    // Filter by agency or agent (backend scopes by agencyId and agentid, not EntityId)
    if (selectedAgencyId) {
      const id = selectedAgencyId;
      filtered = filtered.filter(rule =>
        (rule.EntityType === 'Agency' || rule.EntityType === 'Agent') &&
        (rule.agencyId === id || rule.agentid === id)
      );
    }

    return filtered;
  };


  // Check if user can edit/create (TenantAdmin or SysAdmin)
  const canEdit = () => {
    const currentUser = getCurrentUser();
    return currentUser.currentRole === 'TenantAdmin' || currentUser.currentRole === 'SysAdmin';
  };

  // If there's an auth error, show it prominently
  if (authError) {
    return (
      <div className="p-6">
        <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-lg mb-4">
          <h3 className="text-lg font-semibold mb-1">Access Denied</h3>
          <p>{authError}</p>
        </div>
        <p className="text-sm text-gray-600">
          Commission rules can only be managed by TenantAdmin or SysAdmin users.
        </p>
      </div>
    );
  }

  const getStatusBadge = (rule: CommissionRule) => {
    const baseClasses = "inline-flex px-2 py-1 text-xs font-semibold rounded-full";
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const effectiveDate = rule.EffectiveDate ? new Date(rule.EffectiveDate) : null;
    const terminationDate = rule.TerminationDate ? new Date(rule.TerminationDate) : null;
    if (effectiveDate) effectiveDate.setHours(0, 0, 0, 0);
    if (terminationDate) terminationDate.setHours(0, 0, 0, 0);

    if (!rule.Locked) {
      return (
        <span className={`${baseClasses} bg-yellow-100 text-yellow-800 flex items-center gap-1`}>
          <AlertTriangle className="h-3 w-3" />
          Inactive
        </span>
      );
    }
    if (effectiveDate && effectiveDate > today) {
      return (
        <span className={`${baseClasses} bg-yellow-100 text-yellow-800 flex items-center gap-1`}>
          <AlertTriangle className="h-3 w-3" />
          Effective Starting {format(effectiveDate, 'M/d/yy')}
        </span>
      );
    }
    if (terminationDate && terminationDate < today) {
      return (
        <span className={`${baseClasses} bg-gray-100 text-gray-800 flex items-center gap-1`}>
          <XCircle className="h-3 w-3" />
          Terminated
        </span>
      );
    }
    if (isRuleActive(rule)) return null; // Active - no label needed
    return (
      <span className={`${baseClasses} bg-gray-100 text-gray-800 flex items-center gap-1`}>
        <XCircle className="h-3 w-3" />
        Inactive
      </span>
    );
  };

  const getEntityTypeBadge = (entityType: string) => {
    const baseClasses = "inline-flex px-2 py-1 text-xs font-semibold rounded-full";
    switch (entityType) {
      case 'Agent':
        return <span className={`${baseClasses} bg-oe-light text-oe-dark`}>Agent</span>;
      case 'Agency':
        return <span className={`${baseClasses} bg-purple-100 text-purple-800`}>Agency</span>;
      case 'Tier':
        return <span className={`${baseClasses} bg-indigo-100 text-indigo-800`}>Tier</span>;
      case 'Split':
        return <span className={`${baseClasses} bg-orange-100 text-orange-800`}>Split</span>;
      default:
        return <span className={baseClasses}>{entityType}</span>;
    }
  };

  // Helper function to format SalesType for display
  const formatSalesType = (salesType?: string): string => {
    if (!salesType) return '';
    if (salesType === 'Both') return '(Group & Individual)';
    if (salesType === 'Group') return '(Group)';
    if (salesType === 'Individual') return '(Individual)';
    return `(${salesType})`;
  };

  const beginEditLevel = (level: CommissionLevel) => {
    setEditingLevelId(level.CommissionLevelId);
    setEditLevelDisplayName(level.DisplayName || '');
    setEditLevelSortOrder(String(level.SortOrder ?? ''));
  };

  const cancelEditLevel = () => {
    setEditingLevelId(null);
    setEditLevelDisplayName('');
    setEditLevelSortOrder('');
  };

  const slugifyLevelCode = (value: string): string => {
    const base = value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return base || 'level';
  };

  const buildUniqueLevelCode = (displayName: string, sortOrder: number): string => {
    const existing = new Set(
      commissionLevels
        .map((l) => (l.Code || '').trim().toLowerCase())
        .filter(Boolean)
    );
    const preferredBase = `${slugifyLevelCode(displayName)}_${sortOrder}`;
    if (!existing.has(preferredBase)) return preferredBase;
    let idx = 2;
    while (existing.has(`${preferredBase}_${idx}`)) idx += 1;
    return `${preferredBase}_${idx}`;
  };

  const parseTierLevelValue = (raw: string): number | null => {
    const value = raw.trim();
    if (!value || !/^-?\d+(\.\d+)?$/.test(value)) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return parsed;
  };

  const createLevel = async (): Promise<boolean> => {
    const displayName = newLevelDisplayName.trim();
    const sortOrderRaw = newLevelSortOrder.trim();
    const sortOrder = parseTierLevelValue(sortOrderRaw);
    if (!displayName || sortOrder === null) {
      showSnackbar('Display name and a valid Tier Level number are required.', 'warning');
      return false;
    }
    const duplicate = commissionLevels.find(
      (level) => level.IsActive && Number(level.SortOrder) === sortOrder
    );
    if (duplicate) {
      const message = `Level ${sortOrder} already exists as "${duplicate.DisplayName}". Choose a different level number.`;
      globalThis.alert?.(message);
      showSnackbar(message, 'warning');
      return false;
    }
    try {
      setSavingLevel(true);
      const generatedCode = buildUniqueLevelCode(displayName, sortOrder);
      const response = await TenantAdminAgentsService.createCommissionLevel({
        displayName,
        sortOrder,
        code: generatedCode
      });
      if (!response.success) throw new Error(response.message || 'Failed to create level');
      setNewLevelDisplayName('');
      setNewLevelSortOrder('');
      await loadCommissionLevels();
      showSnackbar('Agent level created.', 'success');
      return true;
    } catch (error: any) {
      showSnackbar(error?.message || 'Failed to create level', 'error');
      return false;
    } finally {
      setSavingLevel(false);
    }
  };

  const saveEditedLevel = async () => {
    if (!editingLevelId) return;
    const displayName = editLevelDisplayName.trim();
    const sortOrderRaw = editLevelSortOrder.trim();
    const sortOrder = parseTierLevelValue(sortOrderRaw);
    if (!displayName || sortOrder === null) {
      showSnackbar('Display name and a valid Tier Level number are required.', 'warning');
      return;
    }
    const duplicate = commissionLevels.find(
      (level) =>
        level.CommissionLevelId !== editingLevelId &&
        level.IsActive &&
        Number(level.SortOrder) === sortOrder
    );
    if (duplicate) {
      const message = `Level ${sortOrder} already exists as "${duplicate.DisplayName}". Choose a different level number.`;
      globalThis.alert?.(message);
      showSnackbar(message, 'warning');
      return;
    }
    try {
      setSavingLevel(true);
      const response = await TenantAdminAgentsService.updateCommissionLevel(editingLevelId, {
        displayName,
        sortOrder
      });
      if (!response.success) throw new Error(response.message || 'Failed to update level');
      await loadCommissionLevels();
      cancelEditLevel();
      showSnackbar('Agent level updated.', 'success');
    } catch (error: any) {
      showSnackbar(error?.message || 'Failed to update level', 'error');
    } finally {
      setSavingLevel(false);
    }
  };

  const requestToggleLevelStatus = async (level: CommissionLevel) => {
    setLevelStatusTarget(level);
    setLevelStatusMode(level.IsActive ? 'deactivate' : 'activate');
    setDeactivateStrategy('keep_legacy');
    setDeactivateMergeTargetLevelId('');
    if (level.IsActive) {
      setLoadingLevelUsage(true);
      try {
        const usage = await TenantAdminAgentsService.getCommissionLevelUsage(level.CommissionLevelId);
        setLevelUsageCount(Number(usage.data?.agentCount || 0));
        setLevelAgencyUsageCount(Number(usage.data?.agencyCount || 0));
      } catch {
        setLevelUsageCount(0);
        setLevelAgencyUsageCount(0);
      } finally {
        setLoadingLevelUsage(false);
      }
    } else {
      setLevelUsageCount(0);
      setLevelAgencyUsageCount(0);
      setLoadingLevelUsage(false);
    }
    setLevelStatusModalOpen(true);
  };

  const confirmToggleLevelStatus = async () => {
    if (!levelStatusTarget) return;
    const level = levelStatusTarget;
    if (levelStatusMode === 'activate') {
      const activeDuplicate = commissionLevels.find(
        (l) =>
          l.CommissionLevelId !== level.CommissionLevelId &&
          l.IsActive &&
          Number(l.SortOrder) === Number(level.SortOrder)
      );
      if (activeDuplicate) {
        const msg = `Cannot reactivate. Tier Level ${level.SortOrder} is already used by active level "${activeDuplicate.DisplayName}".`;
        globalThis.alert?.(msg);
        showSnackbar(msg, 'warning');
        return;
      }
    }
    if (levelStatusMode === 'deactivate' && deactivateStrategy === 'merge_to_level' && !deactivateMergeTargetLevelId) {
      showSnackbar('Please select the replacement level to merge agents into.', 'warning');
      return;
    }
    if (levelStatusMode === 'deactivate' && deactivateStrategy === 'delete_permanently' && (levelUsageCount > 0 || levelAgencyUsageCount > 0)) {
      showSnackbar('Cannot delete permanently while this level is assigned to agents or agencies.', 'warning');
      return;
    }
    try {
      setSavingLevel(true);
      let response;
      if (levelStatusMode === 'activate') {
        response = await TenantAdminAgentsService.updateCommissionLevel(level.CommissionLevelId, { isActive: true });
      } else {
        response = await TenantAdminAgentsService.deactivateCommissionLevel(level.CommissionLevelId, {
          strategy: deactivateStrategy,
          targetCommissionLevelId: deactivateStrategy === 'merge_to_level' ? deactivateMergeTargetLevelId : undefined
        });
      }
      if (!response.success) throw new Error(response.message || 'Failed to update level status');
      await loadCommissionLevels();
      setLevelStatusModalOpen(false);
      setLevelStatusTarget(null);
      if (levelStatusMode === 'deactivate' && deactivateStrategy === 'delete_permanently') {
        showSnackbar('Agent level deleted permanently.', 'success');
      } else {
        showSnackbar(levelStatusMode === 'deactivate' ? 'Agent level deactivated.' : 'Agent level activated.', 'success');
      }
    } catch (error: any) {
      showSnackbar(error?.message || 'Failed to update level status', 'error');
    } finally {
      setSavingLevel(false);
    }
  };

  const openLevelAgentsModal = (level: CommissionLevel) => {
    setLevelAgentsTarget(level);
    setLevelAgentsSearch('');
    setLevelAgentsPage(1);
    setLevelAgentsModalOpen(true);
  };

  useEffect(() => {
    const loadLevelAgents = async () => {
      if (!levelAgentsModalOpen || !levelAgentsTarget?.CommissionLevelId) return;
      try {
        setLevelAgentsLoading(true);
        const response = await TenantAdminAgentsService.getAgentsAndAgencies({
          type: 'Agent',
          commissionLevelId: levelAgentsTarget.CommissionLevelId,
          search: levelAgentsSearch.trim() ? levelAgentsSearch.trim() : undefined,
          page: levelAgentsPage,
          limit: 15
        });
        if (response.success) {
          const rows = Array.isArray(response.data) ? response.data.filter((row) => row.Type === 'Agent') : [];
          setLevelAgentsRows(rows);
          setLevelAgentsPagination({
            page: response.pagination?.page || levelAgentsPage,
            limit: response.pagination?.limit || 15,
            total: response.pagination?.total || rows.length,
            pages: response.pagination?.pages || 1
          });
        } else {
          setLevelAgentsRows([]);
          setLevelAgentsPagination({ page: 1, limit: 15, total: 0, pages: 1 });
        }
      } catch {
        setLevelAgentsRows([]);
        setLevelAgentsPagination({ page: 1, limit: 15, total: 0, pages: 1 });
      } finally {
        setLevelAgentsLoading(false);
      }
    };

    loadLevelAgents();
  }, [levelAgentsModalOpen, levelAgentsTarget?.CommissionLevelId, levelAgentsSearch, levelAgentsPage]);


  const massUpdateWizardPortal = createPortal(
    <MassUpdateRulesWizard
      open={massUpdateOpen}
      onClose={() => setMassUpdateOpen(false)}
      rules={rules}
      onApplied={(count: number) => {
        loadRules();
        if (activeTab === 'groups') {
          loadGroups(groupsPage);
        }
        setMassUpdateOpen(false);
        showSnackbar(`Mass update applied to ${count} rule${count === 1 ? '' : 's'}`, 'success');
      }}
    />,
    document.body
  );

  if (activeTab === 'levels') {
    return (
      <div className="h-full flex flex-col p-6">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div className="inline-flex rounded-lg border border-gray-200 bg-white p-1">
            <button
              type="button"
              onClick={() => setActiveTab('levels')}
              className="px-3 py-2 text-sm rounded-md bg-oe-primary text-white"
            >
              Agent Levels
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('groups')}
              className="px-3 py-2 text-sm rounded-md text-gray-700 hover:bg-gray-50"
            >
              Commission Groups
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('rules')}
              className="px-3 py-2 text-sm rounded-md text-gray-700 hover:bg-gray-50"
            >
              Rules
            </button>
          </div>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 flex-1 min-h-0 flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
            <div className="text-sm font-semibold text-gray-900">Agent Levels</div>
            <div className="flex items-center gap-2">
              {commissionLevelsLoading && <Loader2 className="h-4 w-4 animate-spin text-gray-500" />}
              {canManageLevels && (
                <button
                  type="button"
                  onClick={() => {
                    setNewLevelDisplayName('');
                    setNewLevelSortOrder('');
                    setNewLevelModalOpen(true);
                  }}
                  className="px-3 py-1.5 text-xs bg-oe-primary text-white rounded hover:bg-oe-dark inline-flex items-center gap-1.5"
                >
                  <Plus className="h-3.5 w-3.5" />
                  New Agent Level
                </button>
              )}
            </div>
          </div>
          <div className="overflow-auto flex-1">
            {commissionLevels.length === 0 ? (
              <div className="p-8 text-sm text-gray-600 text-center">No levels found.</div>
            ) : (
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Level</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"># of Agents</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {commissionLevels.map((level) => {
                    const isEditing = editingLevelId === level.CommissionLevelId;
                    return (
                      <tr key={level.CommissionLevelId} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm text-gray-700">
                          {isEditing ? (
                            <input
                              value={editLevelSortOrder}
                              onChange={(e) => setEditLevelSortOrder(e.target.value)}
                              className="w-24 px-2 py-1 border border-gray-300 rounded text-sm"
                            />
                          ) : level.SortOrder}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-900">
                          {isEditing ? (
                            <input
                              value={editLevelDisplayName}
                              onChange={(e) => setEditLevelDisplayName(e.target.value)}
                              className="w-full px-2 py-1 border border-gray-300 rounded text-sm"
                            />
                          ) : level.DisplayName}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-700">
                          <button
                            type="button"
                            onClick={() => openLevelAgentsModal(level)}
                            className="text-oe-primary hover:underline disabled:text-gray-400 disabled:no-underline"
                            disabled={savingLevel}
                          >
                            {Number(level.AgentCount || 0)}
                          </button>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex px-2 py-1 text-xs font-medium rounded-full ${level.IsActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'}`}>
                            {level.IsActive ? 'Active' : 'Inactive'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          {canManageLevels && (
                            <div className="inline-flex items-center gap-2">
                              {isEditing ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={saveEditedLevel}
                                    disabled={savingLevel}
                                    className="px-3 py-1.5 text-xs bg-oe-primary text-white rounded hover:bg-oe-dark disabled:opacity-60"
                                  >
                                    Save
                                  </button>
                                  <button
                                    type="button"
                                    onClick={cancelEditLevel}
                                    className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50"
                                  >
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => beginEditLevel(level)}
                                    className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50"
                                  >
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => requestToggleLevelStatus(level)}
                                    disabled={savingLevel}
                                    className={`px-3 py-1.5 text-xs rounded border ${level.IsActive ? 'border-red-300 text-red-700 hover:bg-red-50' : 'border-green-300 text-green-700 hover:bg-green-50'} disabled:opacity-60`}
                                  >
                                    {level.IsActive ? 'Deactivate' : 'Activate'}
                                  </button>
                                </>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
        {newLevelModalOpen && createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-lg bg-white rounded-lg shadow-xl border border-gray-200">
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
                <div className="text-sm font-semibold text-gray-900">New Agent Level</div>
                <button
                  type="button"
                  onClick={() => !savingLevel && setNewLevelModalOpen(false)}
                  disabled={savingLevel}
                  className="p-2 text-gray-500 hover:bg-gray-50 rounded-lg disabled:opacity-50"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="p-4 space-y-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Display Name</label>
                  <input
                    value={newLevelDisplayName}
                    onChange={(e) => setNewLevelDisplayName(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    placeholder="e.g. Senior Producer"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Tier Level</label>
                  <input
                    value={newLevelSortOrder}
                    onChange={(e) => setNewLevelSortOrder(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    placeholder="e.g. 7"
                    inputMode="decimal"
                  />
                </div>
              </div>
              <div className="px-4 py-3 border-t border-gray-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => !savingLevel && setNewLevelModalOpen(false)}
                  disabled={savingLevel}
                  className="px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-lg disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={savingLevel}
                  onClick={async () => {
                    const ok = await createLevel();
                    if (ok) setNewLevelModalOpen(false);
                  }}
                  className="px-3 py-2 bg-oe-primary text-white rounded-lg text-sm disabled:opacity-50 flex items-center gap-2"
                >
                  {savingLevel && <Loader2 className="h-4 w-4 animate-spin" />}
                  {savingLevel ? 'Creating…' : 'Create'}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
        {levelStatusModalOpen && levelStatusTarget && createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-lg bg-white rounded-lg shadow-xl border border-gray-200">
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
                <div className="text-sm font-semibold text-gray-900">
                  {levelStatusMode === 'deactivate' ? 'Deactivate Agent Level' : 'Reactivate Agent Level'}
                </div>
                <button
                  type="button"
                  onClick={() => !savingLevel && setLevelStatusModalOpen(false)}
                  disabled={savingLevel}
                  className="p-2 text-gray-500 hover:bg-gray-50 rounded-lg disabled:opacity-50"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="p-4 space-y-3">
                <p className="text-sm text-gray-700">
                  <span className="font-medium">{levelStatusTarget.DisplayName}</span> (Tier Level {levelStatusTarget.SortOrder})
                </p>
                {levelStatusMode === 'deactivate' ? (
                  <>
                    <div className="space-y-2">
                      {levelUsageCount > 0 && (
                        <>
                          <label className="flex items-start gap-2 text-sm text-gray-700">
                            <input
                              type="radio"
                              name="deactivateStrategy"
                              checked={deactivateStrategy === 'keep_legacy'}
                              onChange={() => setDeactivateStrategy('keep_legacy')}
                            />
                            <span>Keep {levelUsageCount} agents on this legacy level</span>
                          </label>
                          <label className="flex items-start gap-2 text-sm text-gray-700">
                            <input
                              type="radio"
                              name="deactivateStrategy"
                              checked={deactivateStrategy === 'merge_to_level'}
                              onChange={() => setDeactivateStrategy('merge_to_level')}
                            />
                            <span>Merge {levelUsageCount} agents to new level</span>
                          </label>
                        </>
                      )}
                      <label className="flex items-start gap-2 text-sm text-gray-700">
                        <input
                          type="radio"
                          name="deactivateStrategy"
                          checked={deactivateStrategy === 'delete_permanently'}
                          disabled={loadingLevelUsage || levelUsageCount > 0 || levelAgencyUsageCount > 0}
                          onChange={() => setDeactivateStrategy('delete_permanently')}
                        />
                        <span>Delete permanently (only available when no assignments exist)</span>
                      </label>
                      {levelUsageCount === 0 && (
                        <p className="text-xs text-gray-500">No assigned agents to keep or merge for this level.</p>
                      )}
                    </div>
                    {deactivateStrategy === 'merge_to_level' && (
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">Replacement level</label>
                        <select
                          value={deactivateMergeTargetLevelId}
                          onChange={(e) => setDeactivateMergeTargetLevelId(e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                        >
                          <option value="">Select level...</option>
                          {commissionLevels
                            .filter((l) => l.IsActive && l.CommissionLevelId !== levelStatusTarget.CommissionLevelId)
                            .sort((a, b) => Number(a.SortOrder) - Number(b.SortOrder))
                            .map((l) => (
                              <option key={l.CommissionLevelId} value={l.CommissionLevelId}>
                                Level {l.SortOrder}: {l.DisplayName}
                              </option>
                            ))}
                        </select>
                      </div>
                    )}
                    {deactivateStrategy === 'delete_permanently' && (
                      <p className="text-xs text-red-600">
                        This removes the level from the database and cannot be undone.
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-gray-600">
                    Are you sure you want to reactivate this level?
                  </p>
                )}
              </div>
              <div className="px-4 py-3 border-t border-gray-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => !savingLevel && setLevelStatusModalOpen(false)}
                  disabled={savingLevel}
                  className="px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-lg disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={savingLevel || loadingLevelUsage}
                  onClick={confirmToggleLevelStatus}
                  className="px-3 py-2 bg-oe-primary text-white rounded-lg text-sm disabled:opacity-50 flex items-center gap-2"
                >
                  {savingLevel && <Loader2 className="h-4 w-4 animate-spin" />}
                  Confirm
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
        {levelAgentsModalOpen && levelAgentsTarget && createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-4xl bg-white rounded-lg shadow-xl border border-gray-200">
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
                <div className="text-sm font-semibold text-gray-900">
                  Agents on Level {levelAgentsTarget.SortOrder}: {levelAgentsTarget.DisplayName}
                </div>
                <button
                  type="button"
                  onClick={() => !levelAgentsLoading && setLevelAgentsModalOpen(false)}
                  className="p-2 text-gray-500 hover:bg-gray-50 rounded-lg disabled:opacity-50"
                  disabled={levelAgentsLoading}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="p-4 border-b border-gray-200">
                <input
                  value={levelAgentsSearch}
                  onChange={(e) => {
                    setLevelAgentsSearch(e.target.value);
                    setLevelAgentsPage(1);
                  }}
                  placeholder="Search agents by name or email..."
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                />
              </div>
              <div className="max-h-[420px] overflow-auto">
                {levelAgentsLoading ? (
                  <div className="p-8 text-sm text-gray-600 text-center">Loading agents…</div>
                ) : levelAgentsRows.length === 0 ? (
                  <div className="p-8 text-sm text-gray-600 text-center">No agents found for this level.</div>
                ) : (
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Email</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {levelAgentsRows.map((agent) => (
                        <tr key={agent.Id} className="hover:bg-gray-50">
                          <td className="px-4 py-3 text-sm">
                            <button
                              type="button"
                              onClick={() => setSelectedAgentId(agent.Id)}
                              className="text-oe-primary hover:underline"
                            >
                              {agent.Name}
                            </button>
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-700">{agent.Email || '—'}</td>
                          <td className="px-4 py-3 text-sm text-gray-700">{agent.Status || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <div className="px-4 py-3 border-t border-gray-200 flex items-center justify-between">
                <div className="text-xs text-gray-600">
                  Showing {levelAgentsRows.length} of {levelAgentsPagination.total} agents
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setLevelAgentsPage((prev) => Math.max(1, prev - 1))}
                    disabled={levelAgentsLoading || levelAgentsPagination.page <= 1}
                    className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
                  >
                    Previous
                  </button>
                  <span className="text-xs text-gray-600">
                    Page {levelAgentsPagination.page} of {Math.max(1, levelAgentsPagination.pages)}
                  </span>
                  <button
                    type="button"
                    onClick={() => setLevelAgentsPage((prev) => prev + 1)}
                    disabled={levelAgentsLoading || levelAgentsPagination.page >= levelAgentsPagination.pages}
                    className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}
        {selectedAgentId && (
          <AgentManagementModal
            agentId={selectedAgentId}
            isOpen={true}
            onClose={() => setSelectedAgentId(null)}
          />
        )}
        {massUpdateWizardPortal}
      </div>
    );
  }

  if (activeTab === 'groups') {
    const selectedGroup = selectedGroupId ? groups.find((g) => g.CommissionGroupId === selectedGroupId) : null;

    const getGroupRuleStatusBadge = (r: CommissionGroupRule) => {
      const base = "inline-flex px-2 py-0.5 text-xs font-medium rounded-full";
      const locked = r.Locked === true;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const eff = r.EffectiveDate ? new Date(r.EffectiveDate) : null;
      const term = r.TerminationDate ? new Date(r.TerminationDate) : null;
      if (eff) eff.setHours(0, 0, 0, 0);
      if (term) term.setHours(0, 0, 0, 0);
      if (!locked) return <span className={`${base} bg-yellow-100 text-yellow-800`}>Inactive</span>;
      if (eff && eff > today) return <span className={`${base} bg-yellow-100 text-yellow-800`}>Pending</span>;
      if (term && term < today) return <span className={`${base} bg-gray-100 text-gray-700`}>Terminated</span>;
      return null; // Active - no label needed
    };

    return (
      <div className="h-full flex flex-col p-6">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div className="inline-flex rounded-lg border border-gray-200 bg-white p-1">
            <button
              type="button"
              onClick={() => setActiveTab('levels')}
              className="px-3 py-2 text-sm rounded-md text-gray-700 hover:bg-gray-50"
            >
              Agent Levels
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('groups')}
              className="px-3 py-2 text-sm rounded-md bg-oe-primary text-white"
            >
              Commission Groups
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('rules')}
              className="px-3 py-2 text-sm rounded-md text-gray-700 hover:bg-gray-50"
            >
              Rules
            </button>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="w-64">
              <SearchableDropdown
                options={agencyOptions}
                value={groupFilterAgentId || groupFilterAgencyId || ''}
                onChange={(value, _label, opt) => {
                  const o = opt as { type?: string } | undefined;
                  if (!value) {
                    setGroupFilterAgentId('');
                    setGroupFilterAgencyId('');
                  } else if (o?.type === 'Agency') {
                    setGroupFilterAgencyId(value);
                    setGroupFilterAgentId('');
                  } else {
                    setGroupFilterAgentId(value);
                    setGroupFilterAgencyId('');
                  }
                }}
                placeholder="Filter by agent or agency…"
                searchPlaceholder="Search agents or agencies…"
                loading={agencySearchLoading}
                onSearch={searchAgencies}
                useBackendSearch={true}
                className="w-full"
              />
            </div>
            <input
              type="text"
              value={groupFilterSearch}
              onChange={(e) => setGroupFilterSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && loadGroups(1)}
              placeholder="Search groups…"
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm w-48"
            />
            <button
              type="button"
              onClick={() => loadGroups(1)}
              className="px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Search
            </button>
            {canManageGroups && (
              <button
                type="button"
                onClick={() => {
                  setNewGroupName('');
                  setNewGroupDescription('');
                  setNewGroupCopyFromId('');
                  setNewGroupCopyMode('duplicate');
                  setNewGroupAgentsCanViewOthers(false);
                  setCreateGroupModalOpen(true);
                }}
                className="px-3 py-2 text-sm bg-oe-primary text-white rounded-lg hover:bg-oe-dark transition-colors"
              >
                <Plus className="h-4 w-4 inline mr-2" />
                New group
              </button>
            )}
          </div>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 flex-1 min-h-0 flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between flex-shrink-0">
            <div className="text-sm font-semibold text-gray-900">Commission groups</div>
            <div className="flex items-center gap-2">
              {!readOnly && canEdit() && (
                <button
                  type="button"
                  onClick={() => { loadRules(); setMassUpdateOpen(true); }}
                  className="px-3 py-1.5 text-sm bg-white text-oe-primary border border-oe-primary rounded-lg hover:bg-oe-light transition-colors flex items-center gap-1.5"
                  title="Apply the same tier configuration to multiple tiered rules at once"
                >
                  <Layers className="h-4 w-4" />
                  Mass Update
                </button>
              )}
              {groupsLoading && <Loader2 className="h-4 w-4 animate-spin text-gray-500" />}
            </div>
          </div>
          <div className="overflow-auto flex-1">
            {groups.length === 0 ? (
              <div className="p-8 text-sm text-gray-600 text-center">No commission groups found.</div>
            ) : (
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Description</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Rules</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {groups.map((g) => (
                    <tr key={g.CommissionGroupId} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">{g.Name}</td>
                      <td className="px-4 py-3 text-sm text-gray-600 max-w-xs truncate" title={g.Description || undefined}>
                        {g.Description || '—'}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">{g.RuleCount ?? 0}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex px-2 py-1 text-xs font-medium rounded-full ${g.Status === 'Active' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'}`}>
                          {g.Status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedGroupId(g.CommissionGroupId);
                              loadSelectedGroupRules(g.CommissionGroupId);
                              setPendingRuleRemovals(new Set()); setPendingRuleAdditions([]);
                              setManageRulesModalOpen(true);
                            }}
                            className="px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-100 rounded"
                          >
                            {canManageGroups ? 'Manage rules' : 'View rules'}
                          </button>
                          {canManageGroups && (
                            <>
                            <button
                              type="button"
                              onClick={() => {
                                setEditGroupName(g.Name);
                                setEditGroupDescription(g.Description || '');
                                setEditGroupStatus((g.Status as any) === 'Inactive' ? 'Inactive' : 'Active');
                                setEditGroupAgentsCanViewOthers(!!g.AgentsCanViewOtherCommissionLevels);
                                setSelectedGroupId(g.CommissionGroupId);
                                setEditGroupModalOpen(true);
                              }}
                              className="px-2 py-1.5 text-xs text-gray-700 hover:bg-gray-100 rounded"
                              title="Edit group"
                            >
                              <Edit className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={async () => {
                                if (!confirm(`Delete "${g.Name}"?`)) return;
                                try {
                                  await commissionGroupsService.deleteGroup(g.CommissionGroupId);
                                  showSnackbar('Commission group deleted', 'success');
                                  if (selectedGroupId === g.CommissionGroupId) {
                                    setSelectedGroupId('');
                                    setGroupRules([]);
                                    setManageRulesModalOpen(false);
                                  }
                                  await loadGroups(groupsPage);
                                } catch (e: any) {
                                  showSnackbar(e?.message ? `Error: ${e.message}` : 'Failed to delete group', 'error');
                                }
                              }}
                              className="px-2 py-1.5 text-xs text-red-700 hover:bg-red-50 rounded"
                              title="Delete group"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {groupsPagination.total > 0 && (
            <div className="px-4 py-2 border-t border-gray-200 flex items-center justify-between text-xs text-gray-600 flex-shrink-0">
              <span>
                {(groupsPagination.page - 1) * groupsPagination.limit + 1}–{Math.min(groupsPagination.page * groupsPagination.limit, groupsPagination.total)} of {groupsPagination.total}
              </span>
              <div className="flex gap-1">
                <button
                  type="button"
                  disabled={groupsPagination.page <= 1}
                  onClick={() => { setGroupsPage((p) => Math.max(1, p - 1)); }}
                  className="px-2 py-1 rounded border border-gray-300 disabled:opacity-50 hover:bg-gray-50"
                >
                  Prev
                </button>
                <button
                  type="button"
                  disabled={groupsPagination.page * groupsPagination.limit >= groupsPagination.total}
                  onClick={() => { setGroupsPage((p) => p + 1); }}
                  className="px-2 py-1 rounded border border-gray-300 disabled:opacity-50 hover:bg-gray-50"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Manage rules modal */}
        {manageRulesModalOpen && selectedGroup && createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-2xl bg-white rounded-lg shadow-xl border border-gray-200 max-h-[90vh] flex flex-col">
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
                <div>
                  <div className="text-sm font-semibold text-gray-900">Rules in {selectedGroup.Name}</div>
                  {selectedGroup.Description && (
                    <div className="text-xs text-gray-500 mt-0.5">{selectedGroup.Description}</div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {canManageGroups &&
                    selectedGroup &&
                    groupRules.some(
                      (r) => !pendingRuleRemovals.has(r.RuleId) && ruleLooksTiered(r)
                    ) && (
                      <button
                        type="button"
                        onClick={() => setGroupAiModalOpen(true)}
                        className="px-3 py-2 text-sm text-violet-700 hover:bg-violet-50 rounded-lg flex items-center gap-2 border border-violet-200"
                        title="Edit Tiered rules in this group with AI"
                      >
                        <Sparkles className="h-4 w-4" />
                        Edit rules with AI
                      </button>
                    )}
                  <button
                    type="button"
                    onClick={() => setGroupPreviewGroupId(selectedGroup.CommissionGroupId)}
                    className="px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-lg flex items-center gap-2"
                    title="Preview commissions for this group"
                  >
                    <Calculator className="h-4 w-4" />
                    Calculator
                  </button>
                  <button type="button" onClick={() => { setManageRulesModalOpen(false); setSelectedRuleToAdd(''); setAddRuleOptions([]); setPendingRuleRemovals(new Set()); setPendingRuleAdditions([]); loadGroups(groupsPage); }} className="p-2 text-gray-500 hover:bg-gray-50 rounded-lg">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div className="p-4 overflow-auto flex-1 space-y-4">
                {canManageGroups && (
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Add rule</label>
                    <div className="flex gap-2">
                      <SearchableDropdown
                        options={addRuleOptions.filter((o) => !groupRules.some((r) => r.RuleId === o.id) && !pendingRuleAdditions.some((a) => a.ruleId === o.id))}
                        value={selectedRuleToAdd}
                        onChange={(value) => {
                          const id = value || '';
                          setSelectedRuleToAdd(id);
                          selectedRuleToAddRef.current = id;
                        }}
                        placeholder="Search rules by name or product…"
                        searchPlaceholder="Type to search…"
                        useBackendSearch={true}
                        onSearch={searchAvailableRulesForGroup}
                        loading={addRuleOptionsLoading}
                        showSublabel={true}
                        className="flex-1"
                      />
                      <button
                        type="button"
                        disabled={!selectedRuleToAdd}
                        onClick={() => {
                          const ruleId = selectedRuleToAddRef.current || selectedRuleToAdd;
                          if (!ruleId) return;
                          const opt = addRuleOptions.find((o) => o.id === ruleId);
                          if (!opt || pendingRuleAdditions.some((a) => a.ruleId === ruleId)) return;
                          setPendingRuleAdditions((prev) => [...prev, { ruleId, ruleName: opt.label.split(' • ')[0] || opt.label, label: opt.label }]);
                          setSelectedRuleToAdd('');
                          selectedRuleToAddRef.current = '';
                        }}
                        className="px-3 py-2 bg-gray-900 text-white rounded-lg text-sm disabled:opacity-50"
                      >
                        Add selected
                      </button>
                    </div>
                    <div className="mt-2">
                      <button
                        type="button"
                        onClick={() => {
                          reopenManageRulesAfterWizardRef.current = true;
                          setManageRulesModalOpen(false);
                          setGroupCreateRuleWizardOpen(true);
                        }}
                        className="px-3 py-2 text-sm bg-oe-primary text-white rounded-lg"
                      >
                        <Plus className="h-4 w-4 inline mr-2" />
                        Create new rule and add to group
                      </button>
                    </div>
                  </div>
                )}
                {(() => {
                  const effectiveRules = groupRules.filter((r) => !pendingRuleRemovals.has(r.RuleId));
                  const missingTiers = getMissingTiersForGroup(effectiveRules);
                  const missingProducts = !groupModalProductsLoading
                    ? getMissingProductsForGroup(groupModalProducts, effectiveRules)
                    : [];
                  return (
                    <>
                      {missingTiers.length > 0 && effectiveRules.length > 0 && (
                        <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200">
                          <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
                          <div>
                            <div className="text-sm font-medium text-amber-800">Missing tiers</div>
                            <div className="text-xs text-amber-700 mt-0.5">
                              These agent levels do not receive commission from this group:{' '}
                              {missingTiers.map((l) => getTierName(l)).join(', ')}
                            </div>
                          </div>
                        </div>
                      )}
                      {missingProducts.length > 0 && effectiveRules.length > 0 && (
                        <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200">
                          <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
                          <div>
                            <div className="text-sm font-medium text-amber-800">Missing products</div>
                            <div className="text-xs text-amber-700 mt-0.5">
                              These tenant products have no commission rules in this group:{' '}
                              {missingProducts.map((p) => p.Name).join(', ')}
                            </div>
                          </div>
                        </div>
                      )}
                    </>
                  );
                })()}
                <div>
                  <div className="text-xs font-medium text-gray-700 mb-2">Rules in this group</div>
                {groupRulesLoading ? (
                  <div className="flex items-center gap-2 text-sm text-gray-600 py-4">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading rules…
                  </div>
                ) : groupRules.length === 0 && pendingRuleAdditions.length === 0 ? (
                  <div className="text-sm text-gray-600 py-4">No rules in this group yet.</div>
                ) : (
                  <div className="divide-y divide-gray-200 border border-gray-200 rounded-lg">
                    {groupRules.map((r) => {
                      const isPendingRemoval = pendingRuleRemovals.has(r.RuleId);
                      return (
                      <div key={r.RuleId} className={`p-3 flex items-center justify-between gap-3 ${isPendingRemoval ? 'bg-red-50 opacity-75' : ''}`}>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`text-sm font-medium truncate ${isPendingRemoval ? 'line-through text-gray-500' : 'text-gray-900'}`}>{r.RuleName}</span>
                            {!isPendingRemoval && <CommissionRuleHoverPreview rule={r} />}
                            {!isPendingRemoval && getGroupRuleStatusBadge(r)}
                            {isPendingRemoval && <span className="text-xs text-red-600 font-medium">Will be removed</span>}
                          </div>
                          <div className="text-xs text-gray-600 mt-0.5">
                            {r.ProductId === '00000000-0000-0000-0000-000000000000' ? 'All Products' : (r.ProductName || r.ProductId)}
                            {getTierDisplayForRule(r) ? (
                              <span> • Tiers: {getTierDisplayForRule(r)}</span>
                            ) : getSplitDisplayForRule(r) ? (
                              <span> • Split: {getSplitDisplayForRule(r)}</span>
                            ) : (
                              <span> • {r.EntityType}</span>
                            )}
                            {r.CommissionType === 'Tiered' || r.CommissionType === 'Split' ? null : r.CommissionType === 'Percentage' && r.CommissionRate != null ? (
                              <span> • {(r.CommissionRate * 100).toFixed(1)}%</span>
                            ) : r.CommissionType === 'Flat' && r.FlatAmount != null ? (
                              <span> • ${Number(r.FlatAmount).toFixed(2)}</span>
                            ) : null}
                          </div>
                        </div>
                        {canManageGroups && (
                          <div className="flex items-center gap-2 flex-shrink-0">
                            {isPendingRemoval ? (
                              <button
                                type="button"
                                onClick={() => setPendingRuleRemovals((prev) => { const next = new Set(prev); next.delete(r.RuleId); return next; })}
                                className="px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg"
                                title="Undo removal"
                              >
                                Undo
                              </button>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  onClick={() => {
                                    editRuleFromManageRulesRef.current = true;
                                    setGroupAiModalOpen(false);
                                    setGroupRuleToEdit(r);
                                    setManageRulesModalOpen(false);
                                    setGroupCreateRuleWizardOpen(true);
                                  }}
                                  className="px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-lg"
                                  title="Edit rule"
                                >
                                  <Edit className="h-4 w-4" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setDuplicateInGroupRule(r);
                                    setDuplicateInGroupName(selectedGroup ? `${r.RuleName} - ${selectedGroup.Name}` : `${r.RuleName} (Copy)`);
                                    setDuplicateInGroupModalOpen(true);
                                  }}
                                  className="px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-lg"
                                  title="Duplicate rule in group"
                                >
                                  <Copy className="h-4 w-4" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setPendingRuleRemovals((prev) => new Set(prev).add(r.RuleId))}
                                  className="px-3 py-2 text-sm text-red-700 hover:bg-red-50 rounded-lg"
                                >
                                  Remove
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    );})}
                    {pendingRuleAdditions.map((a) => (
                      <div key={a.ruleId} className="p-3 flex items-center justify-between gap-3 bg-green-50">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-gray-900 truncate">{a.ruleName}</span>
                            <span className="text-xs text-green-600 font-medium">Will be added</span>
                          </div>
                          <div className="text-xs text-gray-600 mt-0.5 truncate">{a.label}</div>
                        </div>
                        {canManageGroups && (
                          <button
                            type="button"
                            onClick={() => setPendingRuleAdditions((prev) => prev.filter((x) => x.ruleId !== a.ruleId))}
                            className="px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg"
                            title="Undo"
                          >
                            Undo
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                </div>
              </div>
              {(pendingRuleRemovals.size > 0 || pendingRuleAdditions.length > 0) && (
                <div className="px-4 py-3 border-t border-gray-200 flex items-center justify-between">
                  <span className="text-sm text-gray-600">
                    {pendingRuleAdditions.length > 0 && `${pendingRuleAdditions.length} to add`}
                    {pendingRuleAdditions.length > 0 && pendingRuleRemovals.size > 0 && ' · '}
                    {pendingRuleRemovals.size > 0 && `${pendingRuleRemovals.size} to remove`}
                  </span>
                  <button
                    type="button"
                    disabled={savingChanges}
                    onClick={async () => {
                      if (!selectedGroup) return;
                      setSavingChanges(true);
                      try {
                        for (const a of pendingRuleAdditions) {
                          await commissionGroupsService.addRuleToGroup(selectedGroup.CommissionGroupId, a.ruleId);
                        }
                        for (const ruleId of pendingRuleRemovals) {
                          await commissionGroupsService.removeRuleFromGroup(selectedGroup.CommissionGroupId, ruleId);
                        }
                        showSnackbar('Changes saved', 'success');
                        setPendingRuleRemovals(new Set());
                        setPendingRuleAdditions([]);
                        await loadSelectedGroupRules(selectedGroup.CommissionGroupId);
                        await loadGroups(groupsPage);
                      } catch (e: any) {
                        showSnackbar(e?.message ? `Error: ${e.message}` : 'Failed to save changes', 'error');
                      } finally {
                        setSavingChanges(false);
                      }
                    }}
                    className="px-4 py-2 text-sm bg-oe-primary text-white rounded-lg hover:bg-oe-dark disabled:opacity-50 flex items-center gap-2"
                  >
                    {savingChanges && <Loader2 className="h-4 w-4 animate-spin" />}
                    Save changes
                  </button>
                </div>
              )}
            </div>
          </div>,
          document.body
        )}

        {createGroupModalOpen && createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-lg bg-white rounded-lg shadow-xl border border-gray-200">
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
                <div className="text-sm font-semibold text-gray-900">Create commission group</div>
                <button
                  type="button"
                  onClick={() => !creatingGroup && setCreateGroupModalOpen(false)}
                  disabled={creatingGroup}
                  className="p-2 text-gray-500 hover:bg-gray-50 rounded-lg disabled:opacity-50"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="p-4 space-y-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Name</label>
                  <input
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    placeholder="e.g. Mightywell - Level 0"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Description (optional)</label>
                  <textarea
                    value={newGroupDescription}
                    onChange={(e) => setNewGroupDescription(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    rows={3}
                  />
                </div>
                <label className="flex items-start gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    className="mt-0.5 rounded border-gray-300"
                    checked={newGroupAgentsCanViewOthers}
                    onChange={(e) => setNewGroupAgentsCanViewOthers(e.target.checked)}
                  />
                  <span>
                    <span className="font-medium">Agents can view other commission levels</span>
                    <span className="block text-xs text-gray-500">
                      When enabled, agents see payouts at every level in this group, with their level highlighted.
                    </span>
                  </span>
                </label>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Duplicate rules from (optional)</label>
                  <select
                    value={newGroupCopyFromId}
                    onChange={(e) => {
                      setNewGroupCopyFromId(e.target.value);
                      setNewGroupCopyMode('duplicate');
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  >
                    <option value="">Start with no rules</option>
                    {createModalGroups.map((g) => (
                      <option key={g.CommissionGroupId} value={g.CommissionGroupId}>
                        {g.Name} ({g.RuleCount ?? 0} rules)
                      </option>
                    ))}
                  </select>
                  {createModalGroupsLoading && (
                    <span className="text-xs text-gray-500 mt-1 block">Loading groups…</span>
                  )}
                </div>
                {newGroupCopyFromId && (
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Copy mode</label>
                    <div className="space-y-2">
                      <label className="flex items-start gap-2 text-sm text-gray-700">
                        <input
                          type="radio"
                          name="newGroupCopyMode"
                          checked={newGroupCopyMode === 'duplicate'}
                          onChange={() => setNewGroupCopyMode('duplicate')}
                        />
                        <span>
                          <span className="font-medium">Duplicate All Rules</span>
                          <span className="block text-xs text-gray-500">Creates new copied rules in default inactive state for this group.</span>
                        </span>
                      </label>
                      <label className="flex items-start gap-2 text-sm text-gray-700">
                        <input
                          type="radio"
                          name="newGroupCopyMode"
                          checked={newGroupCopyMode === 'shared'}
                          onChange={() => setNewGroupCopyMode('shared')}
                        />
                        <span>
                          <span className="font-medium">Use Shared Rules</span>
                          <span className="block text-xs text-gray-500">References the exact same existing rules from the selected group.</span>
                        </span>
                      </label>
                    </div>
                  </div>
                )}
              </div>
              <div className="px-4 py-3 border-t border-gray-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => !creatingGroup && setCreateGroupModalOpen(false)}
                  disabled={creatingGroup}
                  className="px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-lg disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!newGroupName.trim() || creatingGroup}
                  onClick={async () => {
                    if (creatingGroup) return;
                    setCreatingGroup(true);
                    try {
                      const res = await commissionGroupsService.createGroup({
                        name: newGroupName.trim(),
                        description: newGroupDescription.trim() ? newGroupDescription.trim() : null,
                        agentsCanViewOtherCommissionLevels: newGroupAgentsCanViewOthers
                      });
                      if (newGroupCopyFromId) {
                        const result = await copyRulesToNewGroup(
                          newGroupCopyFromId,
                          res.commissionGroupId,
                          newGroupCopyMode,
                          newGroupName.trim()
                        );
                        showSnackbar(
                          newGroupCopyMode === 'duplicate'
                            ? `Commission group created with ${result.copied} duplicated inactive rule(s)`
                            : `Commission group created with ${result.copied} shared rule reference(s)`,
                          'success'
                        );
                      } else {
                        showSnackbar('Commission group created', 'success');
                      }
                      setCreateGroupModalOpen(false);
                      await loadGroups();
                      setSelectedGroupId(res.commissionGroupId);
                      await loadSelectedGroupRules(res.commissionGroupId);
                    } catch (e: any) {
                      showSnackbar(e?.message ? `Error: ${e.message}` : 'Failed to create group', 'error');
                    } finally {
                      setCreatingGroup(false);
                    }
                  }}
                  className="px-3 py-2 bg-oe-primary text-white rounded-lg text-sm disabled:opacity-50 flex items-center gap-2"
                >
                  {creatingGroup && <Loader2 className="h-4 w-4 animate-spin" />}
                  {creatingGroup ? 'Creating…' : 'Create'}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

        {duplicateInGroupModalOpen && duplicateInGroupRule && selectedGroup && createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-lg bg-white rounded-lg shadow-xl border border-gray-200">
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
                <div className="text-sm font-semibold text-gray-900">Duplicate rule in group</div>
                <button
                  type="button"
                  onClick={() => !duplicateInGroupLoading && (setDuplicateInGroupModalOpen(false), setDuplicateInGroupRule(null))}
                  disabled={duplicateInGroupLoading}
                  className="p-2 text-gray-500 hover:bg-gray-50 rounded-lg disabled:opacity-50"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="p-4 space-y-3">
                <p className="text-sm text-gray-600">
                  This will remove the existing rule from this commission group and create a new duplicate one. The original rule will remain in the system but will no longer be assigned to this group.
                </p>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">New rule name</label>
                  <input
                    value={duplicateInGroupName}
                    onChange={(e) => setDuplicateInGroupName(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    placeholder="e.g. Rule Name - Group Name"
                  />
                </div>
              </div>
              <div className="px-4 py-3 border-t border-gray-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => !duplicateInGroupLoading && (setDuplicateInGroupModalOpen(false), setDuplicateInGroupRule(null))}
                  disabled={duplicateInGroupLoading}
                  className="px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-lg disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!duplicateInGroupName.trim() || duplicateInGroupLoading}
                  onClick={async () => {
                    if (duplicateInGroupLoading || !duplicateInGroupRule || !selectedGroup) return;
                    setDuplicateInGroupLoading(true);
                    try {
                      const fullRule = await commissionRuleService.getRuleById(duplicateInGroupRule.RuleId);
                      const currentUser = getCurrentUser();
                      const newRulePayload = {
                        ruleName: duplicateInGroupName.trim(),
                        productId: fullRule.ProductId || '00000000-0000-0000-0000-000000000000',
                        productName: fullRule.ProductName || 'All Products',
                        entityType: fullRule.EntityType,
                        tierLevel: fullRule.TierLevel,
                        commissionType: fullRule.CommissionType,
                        commissionRate: fullRule.CommissionRate,
                        flatAmount: fullRule.FlatAmount,
                        commissionJson: fullRule.CommissionJson || '',
                        effectiveDate: fullRule.EffectiveDate ? new Date(fullRule.EffectiveDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
                        terminationDate: fullRule.TerminationDate ? new Date(fullRule.TerminationDate).toISOString().split('T')[0] : null,
                        status: (fullRule.Status || 'Active') as 'Active' | 'Inactive' | 'Pending',
                        priority: fullRule.Priority ?? 100,
                        tenantId: currentUser.currentRole === 'TenantAdmin' ? currentUser.tenantId : fullRule.TenantId,
                        groupId: fullRule.GroupId,
                        locked: false,
                      };
                      const createRes = await apiService.post<{ success?: boolean; ruleId?: string }>('/api/commissions/rules', newRulePayload);
                      const newRuleId = createRes?.ruleId;
                      if (!newRuleId) throw new Error('Failed to create duplicate rule');
                      await commissionGroupsService.removeRuleFromGroup(selectedGroup.CommissionGroupId, duplicateInGroupRule.RuleId);
                      await commissionGroupsService.addRuleToGroup(selectedGroup.CommissionGroupId, newRuleId);
                      showSnackbar('Rule duplicated and replaced in group', 'success');
                      setDuplicateInGroupModalOpen(false);
                      setDuplicateInGroupRule(null);
                      await loadSelectedGroupRules(selectedGroup.CommissionGroupId);
                      await loadGroups(groupsPage);
                    } catch (e: any) {
                      showSnackbar(e?.message ? `Error: ${e.message}` : 'Failed to duplicate rule', 'error');
                    } finally {
                      setDuplicateInGroupLoading(false);
                    }
                  }}
                  className="px-3 py-2 bg-oe-primary text-white rounded-lg text-sm disabled:opacity-50 flex items-center gap-2"
                >
                  {duplicateInGroupLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                  {duplicateInGroupLoading ? 'Duplicating…' : 'Duplicate'}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

        {editGroupModalOpen && selectedGroup && createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-lg bg-white rounded-lg shadow-xl border border-gray-200">
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
                <div className="text-sm font-semibold text-gray-900">Edit commission group</div>
                <button
                  type="button"
                  onClick={() => setEditGroupModalOpen(false)}
                  className="p-2 text-gray-500 hover:bg-gray-50 rounded-lg"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="p-4 space-y-3">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Name</label>
                  <input
                    value={editGroupName}
                    onChange={(e) => setEditGroupName(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Description</label>
                  <textarea
                    value={editGroupDescription}
                    onChange={(e) => setEditGroupDescription(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    rows={3}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Status</label>
                  <select
                    value={editGroupStatus}
                    onChange={(e) => setEditGroupStatus(e.target.value as any)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  >
                    <option value="Active">Active</option>
                    <option value="Inactive">Inactive</option>
                  </select>
                </div>
                <label className="flex items-start gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    className="mt-0.5 rounded border-gray-300"
                    checked={editGroupAgentsCanViewOthers}
                    onChange={(e) => setEditGroupAgentsCanViewOthers(e.target.checked)}
                  />
                  <span>
                    <span className="font-medium">Agents can view other commission levels</span>
                    <span className="block text-xs text-gray-500">
                      When enabled, agents see payouts at every level in this group, with their level highlighted.
                    </span>
                  </span>
                </label>
              </div>
              <div className="px-4 py-3 border-t border-gray-200 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditGroupModalOpen(false)}
                  className="px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!editGroupName.trim()}
                  onClick={async () => {
                    try {
                      await commissionGroupsService.updateGroup(selectedGroup.CommissionGroupId, {
                        name: editGroupName.trim(),
                        description: editGroupDescription.trim() ? editGroupDescription.trim() : null,
                        status: editGroupStatus,
                        agentsCanViewOtherCommissionLevels: editGroupAgentsCanViewOthers
                      });
                      showSnackbar('Commission group updated', 'success');
                      setEditGroupModalOpen(false);
                      await loadGroups();
                    } catch (e: any) {
                      showSnackbar(e?.message ? `Error: ${e.message}` : 'Failed to update group', 'error');
                    }
                  }}
                  className="px-3 py-2 bg-oe-primary text-white rounded-lg text-sm disabled:opacity-50"
                >
                  Save
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

        {groupCreateRuleWizardOpen && selectedGroup && (
          groupRuleToEdit && groupRuleEditLoading ? (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
              <div className="bg-white rounded-lg shadow-xl p-6 flex items-center gap-3">
                <Loader2 className="h-6 w-6 animate-spin text-oe-primary" />
                <span className="text-sm text-gray-700">Loading rule for editing…</span>
              </div>
            </div>
          ) : (
          <RuleCreationWizard
            open={groupCreateRuleWizardOpen}
            onClose={() => {
              const shouldReopenGroupModal =
                selectedGroup &&
                (editRuleFromManageRulesRef.current || reopenManageRulesAfterWizardRef.current);
              if (shouldReopenGroupModal) {
                setPendingRuleRemovals(new Set());
                setPendingRuleAdditions([]);
                setManageRulesModalOpen(true);
              }
              editRuleFromManageRulesRef.current = false;
              reopenManageRulesAfterWizardRef.current = false;
              setGroupCreateRuleWizardOpen(false);
              setGroupRuleToEdit(null);
              setGroupRuleFullForEdit(null);
            }}
            rule={groupRuleToEdit ? (groupRuleFullForEdit ?? undefined) : undefined}
            initialEntityType="Tier"
            onRuleCreated={async (created: any) => {
              try {
                if (groupRuleToEdit) {
                  await loadSelectedGroupRules(selectedGroup.CommissionGroupId);
                  showSnackbar('Rule updated', 'success');
                  if (editRuleFromManageRulesRef.current) {
                    setPendingRuleRemovals(new Set()); setPendingRuleAdditions([]);
                    setManageRulesModalOpen(true);
                    editRuleFromManageRulesRef.current = false;
                  }
                } else {
                  const newRuleId = created?.ruleId ?? created?.RuleId;
                  if (newRuleId) {
                    await commissionGroupsService.addRuleToGroup(selectedGroup.CommissionGroupId, String(newRuleId));
                    await loadSelectedGroupRules(selectedGroup.CommissionGroupId);
                    showSnackbar('Rule created and added to group', 'success');
                    if (reopenManageRulesAfterWizardRef.current) {
                      setPendingRuleRemovals(new Set()); setPendingRuleAdditions([]);
                      setManageRulesModalOpen(true);
                      reopenManageRulesAfterWizardRef.current = false;
                    }
                  } else {
                    showSnackbar('Rule created, but could not auto-add to group (missing ruleId)', 'warning');
                  }
                }
              } catch (e: any) {
                showSnackbar(e?.message ? `Error: ${e.message}` : (groupRuleToEdit ? 'Failed to update rule' : 'Rule created but failed to add to group'), 'error');
              } finally {
                setGroupCreateRuleWizardOpen(false);
                setGroupRuleToEdit(null);
              }
            }}
          />
          )
        )}

        {groupAiModalOpen && selectedGroup && (
          <GroupCommissionAIAssistant
            open={groupAiModalOpen}
            onClose={() => setGroupAiModalOpen(false)}
            commissionGroupId={selectedGroup.CommissionGroupId}
            groupName={selectedGroup.Name}
            groupRules={groupRules.filter((r) => !pendingRuleRemovals.has(r.RuleId))}
            tenantTierLevels={tenantTierLevelsForGroupAi}
            onApplied={async () => {
              showSnackbar('Commission rules updated from AI', 'success');
              await loadSelectedGroupRules(selectedGroup.CommissionGroupId);
              await loadGroups(groupsPage);
            }}
          />
        )}

        {groupPreviewGroupId && (
          <CommissionSimulator
            onClose={() => setGroupPreviewGroupId(null)}
            initialGroupId={groupPreviewGroupId}
          />
        )}


        {massUpdateWizardPortal}

        {/* Snackbar - must be in groups tab return too */}
        {snackbar.open && (
          <div className={`fixed bottom-4 right-4 px-4 py-3 rounded-lg shadow-lg z-[100] ${
            snackbar.severity === 'success' ? 'bg-green-50 border border-green-200 text-green-800' :
            snackbar.severity === 'error' ? 'bg-red-50 border border-red-200 text-red-800' :
            snackbar.severity === 'warning' ? 'bg-yellow-50 border border-yellow-200 text-yellow-800' :
            'bg-oe-light border border-oe-light text-oe-dark'
          }`}>
            <div className="flex items-center justify-between gap-4">
              <span>{snackbar.message}</span>
              <button
                onClick={() => setSnackbar({ ...snackbar, open: false })}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-1">
          <button
            type="button"
            onClick={() => setActiveTab('levels')}
            className="px-3 py-2 text-sm rounded-md text-gray-700 hover:bg-gray-50"
          >
            Agent Levels
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('groups')}
            className="px-3 py-2 text-sm rounded-md text-gray-700 hover:bg-gray-50"
          >
            Commission Groups
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('rules')}
            className="px-3 py-2 text-sm rounded-md bg-oe-primary text-white"
          >
            Rules
          </button>
        </div>
      </div>
      {/* Filters */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">Filters</h3>
          <button
            onClick={() => setShowAdvancedFilters(!showAdvancedFilters)}
            className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:text-gray-900 hover:bg-gray-50 rounded-lg transition-colors"
          >
            <Filter className="h-4 w-4" />
            Advanced filtering
            {showAdvancedFilters ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {/* Tenant Filter (only for SysAdmin) */}
          {getCurrentUser().currentRole === 'SysAdmin' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Tenant</label>
              <SearchableDropdown
                options={tenantOptions}
                value={selectedTenantId}
                onChange={(value) => {
                  setSelectedTenantId(value);
                  // Reload products when tenant changes
                  if (value !== selectedTenantId) {
                    setTimeout(() => loadProducts(), 100);
                  }
                }}
                placeholder="Search for a tenant..."
                searchPlaceholder="Type to search tenants..."
                loading={tenantSearchLoading}
                onSearch={searchTenants}
                useBackendSearch={true}
                className="w-full"
              />
            </div>
          )}

          {/* Product Filter */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Product</label>
            <select
              value={selectedProductId}
              onChange={(e) => setSelectedProductId(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              disabled={loadingProducts}
            >
              <option value="">All Products</option>
              <option value="all-products">All Products (Global Rule)</option>
              {products.map((product) => (
                <option key={product.ProductId} value={product.ProductId}>
                  {product.Name} {formatSalesType(product.SalesType)}
                </option>
              ))}
            </select>
          </div>

          {/* Agency/Agent Filter */}
          {(getCurrentUser().currentRole === 'TenantAdmin' || getCurrentUser().currentRole === 'SysAdmin') && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Agency/Agent</label>
              <SearchableDropdown
                options={agencyOptions}
                value={selectedAgencyId}
                onChange={(value, _label, option) => {
                  setSelectedAgencyId(value);
                  setSelectedAgencyOrAgentType(value ? ((option as { type?: string })?.type ?? '') : '');
                }}
                placeholder="Search for an agency or agent..."
                searchPlaceholder="Type to search agencies or agents..."
                loading={agencySearchLoading}
                onSearch={searchAgencies}
                useBackendSearch={true}
                className="w-full"
              />
            </div>
          )}

          {/* Advanced Filters - Only show when toggled */}
          {showAdvancedFilters && (
            <>
              {/* Rule Type (Entity Type) Filter */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Rule Type</label>
                <select
                  value={selectedEntityType}
                  onChange={(e) => setSelectedEntityType(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                >
                  <option value="">All Rule Types</option>
                  <option value="Agent">Agent</option>
                  <option value="Agency">Agency</option>
                  <option value="Tier">Tier</option>
                  <option value="Split">Split</option>
                </select>
              </div>

              {/* Locked Status Filter */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Lock Status</label>
                <select
                  value={selectedLockedStatus}
                  onChange={(e) => setSelectedLockedStatus(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                >
                  <option value="">All Rules (Locked & Unlocked)</option>
                  <option value="locked">Locked (Active)</option>
                  <option value="unlocked">Unlocked (Not Yet Active)</option>
                </select>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex justify-end gap-3 mb-4">
        {/* Commission Simulator Button */}
        <button
          onClick={() => setShowSimulator(true)}
          className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark transition-colors flex items-center gap-2"
        >
          <Calculator className="h-5 w-5" />
          Commission Simulator
        </button>

        {/* Add New Rule Button */}
        {!readOnly && canEdit() && (
          <button
            onClick={() => {
              if (onCreateRule) {
                onCreateRule();
              } else {
                // Fallback: open wizard directly if onCreateRule not provided
                setSelectedRule(null);
                setWizardOpen(true);
              }
            }}
            disabled={readOnly}
            className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            <Plus className="h-5 w-5" />
            Add New Rule
          </button>
        )}
      </div>

      {/* Main Table */}
      <div className="bg-white rounded-lg border border-gray-200 flex-1 overflow-x-auto overflow-y-visible pb-20 relative">
        {loading ? (
          <div className="flex justify-center items-center h-64">
            <Loader2 className="h-8 w-8 animate-spin text-oe-primary" />
          </div>
        ) : getFilteredRules().length === 0 ? (
          <div className="flex flex-col justify-center items-center h-64 p-8">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">No Commission Rules Found</h3>
            <p className="text-gray-600 mb-4">
              Create your first commission rule to get started
            </p>
            {canEdit() && onCreateRule && (
              <button
                onClick={() => onCreateRule()}
                disabled={readOnly}
                className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                <Plus className="h-5 w-5" />
                Create First Rule
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto overflow-visible pb-20">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Rule Name</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Product</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Entity Type</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Tier</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Scope</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Rate/Amount</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                  {canEdit() && (
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                  )}
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {getFilteredRules().map((rule) => (
                    <tr key={rule.RuleId} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                        <div className="flex items-center gap-2">
                          {rule.RuleName}
                          <CommissionRuleHoverPreview rule={rule} />
                          {rule.Locked && (
                            <Lock className="h-4 w-4 text-yellow-600" title="This rule is locked. Only the Termination Date can be edited." />
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {rule.ProductId === '00000000-0000-0000-0000-000000000000' ? (
                          <span className="text-gray-400 italic">All Products</span>
                        ) : rule.ProductName ? (
                          <div>
                            <div className="font-medium text-gray-900">{rule.ProductName}</div>
                            {rule.ProductSalesType && (
                              <div className="text-xs text-gray-500 mt-0.5">
                                {rule.ProductSalesType === 'Both' ? 'Group & Individual' :
                                 rule.ProductSalesType === 'Group' ? 'Group Only' :
                                 rule.ProductSalesType === 'Individual' ? 'Individual Only' :
                                 rule.ProductSalesType}
                              </div>
                            )}
                          </div>
                        ) : (
                          'N/A'
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm">
                        <div className="flex flex-col gap-1">
                          {getEntityTypeBadge(rule.EntityType)}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {(() => {
                          const display = getTierDisplayForRule(rule);
                          if (!display) return '—';
                          const count = display.split(',').length;
                          return (
                            <span
                              title={display}
                              className="inline-flex items-center px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 text-xs font-medium cursor-help"
                            >
                              {count} tier{count !== 1 ? 's' : ''}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {rule.Scope ?? '—'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {rule.CommissionType === 'Percentage' && rule.CommissionRate
                          ? `${(rule.CommissionRate * 100).toFixed(2)}%`
                          : rule.CommissionType === 'Flat' && rule.FlatAmount
                          ? `$${rule.FlatAmount.toFixed(2)}`
                          : rule.CommissionType === 'Split'
                          ? 'Split'
                          : 'Tiered'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm">{getStatusBadge(rule)}</td>
                      {canEdit() && (
                        <td className="px-6 py-4 whitespace-nowrap text-sm">
                          <button
                            data-commission-rule-menu-trigger
                            onClick={(e) => handleMenuClick(rule.RuleId, e)}
                            className="text-gray-600 hover:text-gray-800"
                            title="More options"
                          >
                            <MoreVertical className="h-4 w-4" />
                          </button>
                        </td>
                      )}
                    </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Action menu in portal so it is not clipped by table overflow */}
      {menuOpen && menuPosition && typeof document !== 'undefined' && document.body && (() => {
        const rule = getFilteredRules().find((r) => r.RuleId === menuOpen);
        if (!rule) return null;
        const currentUser = getCurrentUser();
        const canEditRule = canEdit() && !(currentUser.currentRole === 'TenantAdmin' && rule.IsGlobal);
        const menuContent = (
          <div
            id="commission-rules-action-menu"
            className="fixed w-48 bg-white rounded-md shadow-lg border border-gray-200 z-[9999] py-1"
            style={{ top: menuPosition.top, left: menuPosition.left }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                handleEditRule(rule);
                handleMenuClose();
              }}
              disabled={!canEditRule}
              className="w-full text-left px-4 py-2 text-sm text-oe-primary hover:bg-gray-100 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Edit className="h-4 w-4" />
              Edit
            </button>
            {rule.Locked && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  handleUnlockRule(rule);
                  handleMenuClose();
                }}
                className="w-full text-left px-4 py-2 text-sm text-blue-600 hover:bg-blue-50 flex items-center gap-2"
              >
                <Lock className="h-4 w-4" />
                Unlock
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                handleDuplicateRule(rule);
                handleMenuClose();
              }}
              className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 flex items-center gap-2"
            >
              <Copy className="h-4 w-4" />
              Duplicate
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                handleDeleteClick(rule);
                handleMenuClose();
              }}
              disabled={(() => {
                const currentUser = getCurrentUser();
                if (rule.Locked) return true;
                if (currentUser.currentRole === 'TenantAdmin' && rule.IsGlobal) return true;
                return false;
              })()}
              className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </button>
          </div>
        );
        return createPortal(menuContent, document.body);
      })()}

      {/* Edit Rule Form */}
      <RuleCreationWizard
        open={wizardOpen}
        rule={selectedRule}
        onClose={() => {
          setWizardOpen(false);
          setSelectedRule(null);
        }}
        onRuleCreated={() => {
          loadRules();
          setWizardOpen(false);
          setSelectedRule(null);
          showSnackbar(selectedRule ? 'Rule updated successfully' : 'Rule created successfully', 'success');
        }}
      />

      {massUpdateWizardPortal}

      {/* Snackbar */}
      {snackbar.open && (
        <div className={`fixed bottom-4 right-4 px-4 py-3 rounded-lg shadow-lg z-50 ${
          snackbar.severity === 'success' ? 'bg-green-50 border border-green-200 text-green-800' :
          snackbar.severity === 'error' ? 'bg-red-50 border border-red-200 text-red-800' :
          snackbar.severity === 'warning' ? 'bg-yellow-50 border border-yellow-200 text-yellow-800' :
          'bg-oe-light border border-oe-light text-oe-dark'
        }`}>
          <div className="flex items-center justify-between gap-4">
            <span>{snackbar.message}</span>
            <button
              onClick={() => setSnackbar({ ...snackbar, open: false })}
              className="text-gray-400 hover:text-gray-600"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Commission Simulator Modal */}
      {showSimulator && (
        <CommissionSimulator onClose={() => setShowSimulator(false)} />
      )}

      {/* Migration Selection Modal */}
      {migrationModalOpen && ruleToDelete && agentsTiedToRule.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50" onClick={(e) => {
          if (e.target === e.currentTarget) {
            setMigrationModalOpen(false);
            setRuleToDelete(null);
            setAgentsTiedToRule([]);
            setSelectedNewRuleId('');
          }
        }}>
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="flex-shrink-0 w-10 h-10 rounded-full bg-yellow-100 flex items-center justify-center">
                  <AlertTriangle className="h-5 w-5 text-yellow-600" />
                </div>
                <h3 className="text-lg font-semibold text-gray-900">
                  Agents Assigned to Rule
                </h3>
              </div>
              
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-4">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-5 w-5 text-yellow-600 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-yellow-800 mb-1">
                      {agentsTiedToRule.length} agent(s) are assigned to this rule
                    </p>
                    <p className="text-xs text-yellow-700">
                      You must select a new commission rule to assign these agents to before deleting.
                    </p>
                  </div>
                </div>
              </div>
              
              <div className="mb-4">
                <p className="text-sm font-medium text-gray-700 mb-2">
                  Agents assigned to rule "{ruleToDelete.RuleName}":
                </p>
                <div className="max-h-32 overflow-y-auto border border-gray-200 rounded-lg p-2 bg-gray-50">
                  {agentsTiedToRule.map((agent) => (
                    <div key={agent.AgentId} className="text-sm text-gray-600 py-1">
                      • {agent.AgentName} {agent.Email && `(${agent.Email})`}
                    </div>
                  ))}
                </div>
              </div>
              
              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Select New Commission Rule <span className="text-red-500">*</span>
                </label>
                <select
                  value={selectedNewRuleId}
                  onChange={(e) => setSelectedNewRuleId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-yellow-500 focus:border-yellow-500"
                  required
                >
                  <option value="">-- Select a rule --</option>
                  {availableRules.map((rule) => (
                    <option key={rule.RuleId} value={rule.RuleId}>
                      {rule.RuleName} {rule.ProductName && `(${rule.ProductName})`}
                    </option>
                  ))}
                </select>
                {availableRules.length === 0 && (
                  <p className="text-xs text-red-600 mt-1">
                    No available rules found. Please create a new commission rule first.
                  </p>
                )}
              </div>
              
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => {
                    setMigrationModalOpen(false);
                    setRuleToDelete(null);
                    setAgentsTiedToRule([]);
                    setSelectedNewRuleId('');
                  }}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleMigrationContinue}
                  disabled={!selectedNewRuleId}
                  className="px-4 py-2 text-sm font-medium text-white bg-yellow-600 rounded-lg hover:bg-yellow-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Continue to Confirmation
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirmOpen && ruleToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50" onClick={(e) => {
          if (e.target === e.currentTarget) {
            setDeleteConfirmOpen(false);
            setRuleToDelete(null);
            setAgentsTiedToRule([]);
            setSelectedNewRuleId('');
          }
        }}>
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="flex-shrink-0 w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
                  <AlertTriangle className="h-5 w-5 text-red-600" />
                </div>
                <h3 className="text-lg font-semibold text-gray-900">
                  Delete Commission Rule
                </h3>
              </div>
              
              {loadingAgents ? (
                <div className="py-8 text-center">
                  <Loader2 className="h-6 w-6 animate-spin text-gray-400 mx-auto mb-2" />
                  <p className="text-sm text-gray-500">Checking for agents assigned to this rule...</p>
                </div>
              ) : (
                <>
                  <p className="text-gray-600 mb-6">
                    Are you sure you want to delete the rule <strong>"{ruleToDelete.RuleName}"</strong>?
                  </p>
                  
                  <p className="text-sm text-gray-500 mb-6">
                    This action cannot be undone. All associated commission calculations will be affected.
                  </p>
                </>
              )}

              {agentsTiedToRule.length > 0 && selectedNewRuleId && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
                  <div className="flex items-start gap-2">
                    <CheckCircle2 className="h-5 w-5 text-blue-600 mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="text-sm font-medium text-blue-800 mb-1">
                        {agentsTiedToRule.length} agent(s) will be migrated
                      </p>
                      <p className="text-xs text-blue-700">
                        Agents will be reassigned to: <strong>{availableRules.find(r => r.RuleId === selectedNewRuleId)?.RuleName}</strong>
                      </p>
                    </div>
                  </div>
                </div>
              )}
              
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => {
                    setDeleteConfirmOpen(false);
                    setRuleToDelete(null);
                    setAgentsTiedToRule([]);
                    setSelectedNewRuleId('');
                  }}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDeleteConfirm}
                  disabled={loadingAgents}
                  className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loadingAgents ? 'Checking...' : 'Delete Rule'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};