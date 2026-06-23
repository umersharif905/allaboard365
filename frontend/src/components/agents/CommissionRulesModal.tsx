import { format } from 'date-fns';
import { AlertCircle, AlertTriangle, Calculator, Copy, Edit, FileText, Loader2, Lock, MoreVertical, Pencil, Plus, Save, Trash2, Users, X } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';
import AgentCommissionOverridesSection from './AgentCommissionOverridesSection';
import AgentCommissionPayoutsView from './AgentCommissionPayoutsView';
import { COMMISSION_TIER_LEVELS, getTierDisplayForRule, getTierLevelLabel } from '../../constants/form-options';
import { apiService, resolveTenantScopeId } from '../../services/api.service';
import { commissionRuleService, type CommissionRule } from '../../services/commissionRules.service';
import { commissionService } from '../../services/commissions.service';
import { commissionGroupsService, type CommissionGroup } from '../../services/commissionGroups.service';
import { TenantAdminAgentsService, type CommissionLevel } from '../../services/tenant-admin/agents.service';
import ApplyCommissionGroupToDownlinesModal from './ApplyCommissionGroupToDownlinesModal';
import CommissionSimulator from '../commissions/CommissionSimulator';
import { RuleCreationWizard } from '../commissions/RuleCreationWizard';

interface CommissionRulesModalProps {
  isOpen: boolean;
  onClose: () => void;
  entityType: 'Agent' | 'Agency';
  entityId: string;
  entityName: string;
  /** Called after group/level is saved. Optional third arg merges into parent state without full refetch. */
  onSave?: (
    entityType: 'Agent' | 'Agency',
    entityId: string,
    updates?: {
      commissionTierLevel?: number | null;
      commissionGroupId?: string | null;
      commissionLevelId?: string | null;
      commissionGroupName?: string | null;
      commissionLevelName?: string | null;
    }
  ) => void;
  /** When provided (TenantAdmin/SysAdmin), show "Upline: {uplineName}" with edit icon for agents; called with agentId before closing so parent can open Agent modal on Hierarchy tab. */
  onConfigureUpline?: (agentId: string) => void;
  /** Display name of current upline (agent only). */
  uplineName?: string | null;
  /** When Agent role: current user's tier level; Level dropdown is restricted to levels below this. */
  currentUserTierLevel?: number | null;
  /** When true (e.g. Agent viewing own record), Level dropdown and Save are disabled; no permission error shown. */
  isViewingSelf?: boolean;
  /** When true, render inline (e.g. inside a tab) without modal overlay, header close button, or footer Close. */
  embedded?: boolean;
  /** Current user role from parent (TenantAdmin, SysAdmin, Agent, etc.). When provided, used for permission checks instead of localStorage. */
  currentRole?: string;
  /** SysAdmin /admin/agents: tenant from page picker (not profile tenant). */
  explicitTenantId?: string | null;
}

const CommissionRulesModal: React.FC<CommissionRulesModalProps> = ({
  isOpen,
  onClose,
  entityType,
  entityId,
  entityName,
  onSave,
  onConfigureUpline,
  uplineName,
  currentUserTierLevel,
  isViewingSelf = false,
  embedded = false,
  currentRole: propCurrentRole,
  explicitTenantId: propExplicitTenantId
}) => {
  const [rules, setRules] = useState<CommissionRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSimulator, setShowSimulator] = useState(false);
  const [simulatorAgentId, setSimulatorAgentId] = useState<string | undefined>(undefined);
  const [simulatorTenantId, setSimulatorTenantId] = useState<string | undefined>(undefined);
  const [showCreateRuleWizard, setShowCreateRuleWizard] = useState(false);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [selectedRule, setSelectedRule] = useState<CommissionRule | null>(null);
  const [showEditRuleWizard, setShowEditRuleWizard] = useState(false);
  const [filterType, setFilterType] = useState<'all' | 'tenant' | 'agency' | 'agent'>(entityType === 'Agency' ? 'agency' : 'agent');
  const menuRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [agentAgencyId, setAgentAgencyId] = useState<string | null>(null);
  // Default commission rule and tier level (top section)
  const [entityDefaultRuleId, setEntityDefaultRuleId] = useState<string | null>(null);
  const [entityDefaultRuleName, setEntityDefaultRuleName] = useState<string>('');
  const [entityTierLevel, setEntityTierLevel] = useState<number | null>(null);
  /** Commission Settings tab: wait for entity + groups before showing dropdowns (avoids flash). */
  const [settingsReady, setSettingsReady] = useState(false);
  const [commissionGroups, setCommissionGroups] = useState<CommissionGroup[]>([]);
  const [loadingCommissionGroups, setLoadingCommissionGroups] = useState(false);
  const [loadingDefaultSection, setLoadingDefaultSection] = useState(false);
  const [savingDefault, setSavingDefault] = useState(false);
  const [defaultSectionError, setDefaultSectionError] = useState<string | null>(null);
  /** When Agent: viewer's tier from API (getCommissionRule returns viewerTierLevel). Used when currentUserTierLevel prop is not passed. */
  const [resolvedViewerTierLevel, setResolvedViewerTierLevel] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<'level' | 'rules' | 'payouts'>('level');
  const [advanceMonths, setAdvanceMonths] = useState<number | null>(null);
  const [savingAdvance, setSavingAdvance] = useState(false);
  const rulesLoaded = useRef(false);
  const [showApplyToDownlinesModal, setShowApplyToDownlinesModal] = useState(false);
  const [downlineCount, setDownlineCount] = useState<number>(0);
  const [applicableRulesForDropdown, setApplicableRulesForDropdown] = useState<CommissionRule[]>([]);
  const [commissionLevels, setCommissionLevels] = useState<CommissionLevel[]>([]);
  const [entityCommissionLevelId, setEntityCommissionLevelId] = useState<string | null>(null);
  const [entityIsPrimaryAgency, setEntityIsPrimaryAgency] = useState(false);
  const [effectiveGroup, setEffectiveGroup] = useState<{ commissionGroupId: string; name: string | null; source: string } | null | undefined>(undefined);

  useEffect(() => {
    if (!isOpen || !entityId) {
      setRules([]);
      setError(null);
      setAgentAgencyId(null);
      setSettingsReady(false);
      return;
    }
    setActiveTab('level');
    setFilterType(entityType === 'Agency' ? 'agency' : 'agent');
    setEntityDefaultRuleId(null);
    setEntityDefaultRuleName('');
    setDefaultSectionError(null);
    setResolvedViewerTierLevel(null);
    setAdvanceMonths(null);
    rulesLoaded.current = false;
    setEntityCommissionLevelId(null);
    setEntityTierLevel(null);
    setEntityIsPrimaryAgency(false);
    setEffectiveGroup(undefined);
    setSettingsReady(false);
    if (entityType === 'Agency') setAgentAgencyId(null);

    let cancelled = false;
    const run = async () => {
      // Parallelise the independent fetches that were previously chained one
      // useEffect at a time. Single render after all five resolve. The
      // serial agent-detail step runs first because everything else only
      // needs `entityId`, but the four parallel calls can race at startup.
      setLoadingCommissionGroups(true);
      const [levelsResult, groupsResult, downlineCountRes, egRes] = await Promise.all([
        TenantAdminAgentsService.getCommissionLevels(
          false,
          resolveTenantScopeId(propExplicitTenantId) || undefined
        ).catch(() => null),
        commissionGroupsService.listGroups().catch(() => null),
        entityType === 'Agent'
          ? TenantAdminAgentsService.getAgentDownlineCount(entityId).catch(() => null)
          : Promise.resolve(null),
        entityType === 'Agent'
          ? apiService
              .get<{ success: boolean; data: { commissionGroupId: string; name: string | null; source: string } | null }>(
                `/api/tenant-admin/agents/${encodeURIComponent(entityId)}/effective-commission-group`
              )
              .catch(() => null)
          : Promise.resolve(null)
      ]);

      if (cancelled) return;

      if (levelsResult?.success && Array.isArray(levelsResult.data)) {
        setCommissionLevels(
          [...levelsResult.data]
            .filter((l) => l.IsActive)
            .sort((a, b) => Number(a.SortOrder) - Number(b.SortOrder))
        );
      } else {
        setCommissionLevels([]);
      }

      setCommissionGroups(groupsResult?.groups ?? []);
      setLoadingCommissionGroups(false);

      if (entityType === 'Agent') {
        if (downlineCountRes?.success && downlineCountRes.data != null) {
          setDownlineCount(Number(downlineCountRes.data));
        } else {
          setDownlineCount(0);
        }
        setEffectiveGroup(egRes?.success ? (egRes.data ?? null) : null);
      }

      // Agent/agency details + tier level run after the parallel block since
      // downstream UI keys off them. Cheap; one query.
      await loadEntityDefaultAndLevel((agencyId) => {
        if (!cancelled) setAgentAgencyId(agencyId);
      });
      if (!cancelled) setSettingsReady(true);
    };
    run();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- single initial load; loadRules/loadEntityDefaultAndLevel intentionally excluded
  }, [isOpen, entityId, entityType]);

  // Lazy-load rules only when Rules tab is first visited
  useEffect(() => {
    if (activeTab !== 'rules' || rulesLoaded.current || !isOpen) return;
    rulesLoaded.current = true;
    loadRules(filterType, agentAgencyId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, isOpen, agentAgencyId]);

  const rawViewerTier = currentUserTierLevel ?? resolvedViewerTierLevel;
  const effectiveViewerTierLevel =
    rawViewerTier != null && Number.isFinite(Number(rawViewerTier)) ? Number(rawViewerTier) : null;

  const availableLevelOptions = useMemo(() => {
    if (commissionLevels.length > 0) {
      return commissionLevels.map((level) => ({
        level: Number(level.SortOrder),
        label: `Level ${level.SortOrder}: ${level.DisplayName}`,
        commissionLevelId: level.CommissionLevelId
      }));
    }
    return COMMISSION_TIER_LEVELS.map((level) => ({
      level: level.level,
      label: getTierLevelLabel(level.level),
      commissionLevelId: null
    }));
  }, [commissionLevels]);

  // Keep selected group name in sync
  useEffect(() => {
    if (!entityDefaultRuleId) {
      setEntityDefaultRuleName('');
      return;
    }
    const g = commissionGroups.find((x) => x.CommissionGroupId === entityDefaultRuleId);
    setEntityDefaultRuleName(g?.Name || '');
  }, [commissionGroups, entityDefaultRuleId]);

  // When Agent: clamp entity tier level to allowed range (below viewer's level)
  useEffect(() => {
    if (entityType !== 'Agent' || effectiveViewerTierLevel == null) return;
    const allowed = availableLevelOptions.filter((opt) => opt.level < effectiveViewerTierLevel);
    if (allowed.length === 0) return;
    const maxAllowed = Math.max(...allowed.map((t) => t.level));
    if (entityTierLevel != null && entityTierLevel >= effectiveViewerTierLevel) {
      setEntityTierLevel(maxAllowed);
      const matched = allowed.find((opt) => opt.level === maxAllowed);
      setEntityCommissionLevelId(matched?.commissionLevelId || null);
    }
  }, [entityType, effectiveViewerTierLevel, entityTierLevel, availableLevelOptions]);

  useEffect(() => {
    // Don't auto-snap a CommissionLevelId when the entity is intentionally
    // unset (None for an agency).
    if (entityTierLevel == null) return;
    if (!entityCommissionLevelId && commissionLevels.length > 0) {
      const matched = commissionLevels.find((level) => Number(level.SortOrder) === Number(entityTierLevel));
      if (matched) {
        setEntityCommissionLevelId(matched.CommissionLevelId);
      }
    }
  }, [commissionLevels, entityCommissionLevelId, entityTierLevel]);

  /** Load default commission rule and tier level for the entity (agent or agency).
   * Calls onAgencyId(agencyId) when we have an agency id (Agent only), so callers can use it before state updates. */
  const loadEntityDefaultAndLevel = async (
    onAgencyId?: (agencyId: string | null) => void
  ): Promise<void> => {
    if (!entityId) return;
    setLoadingDefaultSection(true);
    setDefaultSectionError(null);
    try {
      let ruleId: string | null = null;
      let agencyIdForDropdown: string | null = null;
      const detailsRes = entityType === 'Agency'
        ? await TenantAdminAgentsService.getAgencyDetails(entityId)
        : await TenantAdminAgentsService.getAgentDetails(entityId);
      if (detailsRes.success && detailsRes.data) {
        const level = (detailsRes.data as any).CommissionTierLevel;
        const levelId = (detailsRes.data as any).CommissionLevelId;
        if (entityType === 'Agency') {
          setEntityIsPrimaryAgency(!!(detailsRes.data as any).IsPrimary);
        }
        const isUnset = (level === undefined || level === null) && (levelId === undefined || levelId === null);
        setEntityTierLevel(isUnset ? null : Number(level ?? 0));
        setEntityCommissionLevelId(levelId ? String(levelId) : null);
        if (entityType === 'Agent') {
          agencyIdForDropdown = (detailsRes.data as any).AgencyId ?? null;
          onAgencyId?.(agencyIdForDropdown);
          const advance = (detailsRes.data as { AdvanceMonths?: number | null }).AdvanceMonths;
          setAdvanceMonths(advance !== undefined && advance !== null ? advance : null);
        }
        ruleId = (detailsRes.data as any).CommissionGroupId ?? null;
      }
      setEntityDefaultRuleId(ruleId);
    } catch (err: any) {
      console.error('Error loading default rule/level:', err);
      setDefaultSectionError(err?.message || 'Failed to load default commission and level');
    } finally {
      setLoadingDefaultSection(false);
    }
  };

  // Commission Groups replace default commission rule selection.


  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      let clickedInside = false;
      
      menuRefs.current.forEach((ref) => {
        if (ref && ref.contains(target)) {
          clickedInside = true;
        }
      });
      
      if (!clickedInside) {
        setMenuOpen(null);
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

  const getCurrentUser = () => {
    const storedRoles = localStorage.getItem('roles');
    const roles = storedRoles ? JSON.parse(storedRoles) : [];
    const currentRole = propCurrentRole ?? localStorage.getItem('currentRole') ?? roles[0] ?? null;
    const tenantId = resolveTenantScopeId(propExplicitTenantId) || undefined;
    const userId = localStorage.getItem('userId');
    
    return {
      roles,
      currentRole,
      tenantId,
      userId
    };
  };

  const canEdit = () => {
    const { currentRole } = getCurrentUser();
    // Agent can edit level when viewing a downline agent only; when viewing self, dropdown is disabled
    if (currentRole === 'Agent' && entityType === 'Agent' && !isViewingSelf) return true;
    if (currentRole === 'AgencyOwner') return false;
    return currentRole === 'SysAdmin' || currentRole === 'TenantAdmin';
  };

  /** Only TenantAdmin/SysAdmin may change the default commission rule; Agent cannot. */
  const canEditDefaultRule = () => {
    const { currentRole } = getCurrentUser();
    return currentRole === 'TenantAdmin' || currentRole === 'SysAdmin';
  };

  /** Can apply commission group to downlines: TenantAdmin/SysAdmin only (not Agent). */
  const canApplyToDownlines = () => {
    if (entityType !== 'Agent') return false;
    const { currentRole } = getCurrentUser();
    const role = (currentRole || '').toString();
    return role === 'TenantAdmin' || role === 'SysAdmin';
  };

  const canEditRule = (rule: CommissionRule) => {
    const currentUser = getCurrentUser();
    
    // Agents cannot edit any rules
    if (currentUser.currentRole === 'Agent') {
      return false;
    }
    
    // AgencyOwner cannot edit tenant-level rules (Tier rules without entityId)
    if (currentUser.currentRole === 'AgencyOwner') {
      if (rule.EntityType === 'Tier' && !rule.EntityId && !rule.agencyId && !rule.agentid) {
        return false; // Tenant-level rule
      }
      // AgencyOwner also cannot edit agency-level rules if they're not for their agency
      // (This would need agencyId check, but for now we'll allow if it's an agency rule)
      if (rule.EntityType === 'Agency' && rule.EntityId !== entityId && rule.agencyId !== entityId) {
        return false;
      }
    }
    
    // TenantAdmin cannot edit global rules
    if (currentUser.currentRole === 'TenantAdmin' && rule.IsGlobal) {
      return false;
    }
    
    return true;
  };

  const handleMenuClick = (ruleId: string) => {
    setMenuOpen(menuOpen === ruleId ? null : ruleId);
  };

  const handleEditRule = (rule: CommissionRule) => {
    if (!canEditRule(rule)) {
      const currentUser = getCurrentUser();
      if (currentUser.currentRole === 'Agent') {
        alert('Agents cannot edit commission rules');
      } else if (currentUser.currentRole === 'AgencyOwner') {
        alert('You cannot edit tenant-level commission rules');
      } else if (currentUser.currentRole === 'TenantAdmin' && rule.IsGlobal) {
        alert('You cannot edit global commission rules');
      } else {
        alert('You do not have permission to edit this rule');
      }
      return;
    }
    
    setSelectedRule(rule);
    setShowEditRuleWizard(true);
    setMenuOpen(null);
  };

  const handleDuplicateRule = async (rule: CommissionRule) => {
    try {
      const currentUser = getCurrentUser();
      // Preserve scope: backend uses entityId to set agencyId/agentid. Prefer agencyId/agentid over EntityId.
      const entityIdForScope =
        rule.EntityType === 'Agency'
          ? (rule.agencyId ?? rule.EntityId)
          : rule.EntityType === 'Agent'
            ? (rule.agentid ?? rule.EntityId)
            : rule.EntityId;

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
        locked: false,
        entityId: entityIdForScope ?? null,
      };
      
      await commissionRuleService.createRule(newRuleData);
      loadRules(); // Reload rules to show the new one
      setMenuOpen(null);
    } catch (error: any) {
      console.error('Error duplicating rule:', error);
      alert(error?.message || 'Failed to duplicate rule');
      setMenuOpen(null);
    }
  };

  const handleDeleteRule = async (rule: CommissionRule) => {
    if (!confirm(`Are you sure you want to delete the rule "${rule.RuleName}"?`)) {
      return;
    }

    try {
      await commissionRuleService.deleteRule(rule.RuleId);
      loadRules(); // Reload rules
      setMenuOpen(null);
    } catch (error: any) {
      console.error('Error deleting rule:', error);
      alert(error?.message || 'Failed to delete rule');
      setMenuOpen(null);
    }
  };

  const handleUnlockRule = async (rule: CommissionRule) => {
    try {
      const response = await apiService.put<{ success: boolean; message?: string }>(`/api/commissions/rules/${rule.RuleId}/unlock`);
      if (response.success) {
        loadRules(); // Reload rules
      } else {
        alert(response.message || 'Failed to unlock rule');
      }
      setMenuOpen(null);
    } catch (error: any) {
      console.error('Error unlocking rule:', error);
      alert(error?.message || 'Failed to unlock rule');
      setMenuOpen(null);
    }
  };

  const handleSaveAdvance = async () => {
    if (!entityId) return;
    setSavingAdvance(true);
    try {
      const response = await TenantAdminAgentsService.updateAgent(entityId, { advanceMonths });
      if (response.success) {
        await loadEntityDefaultAndLevel();
        onSave?.(entityType, entityId);
      } else {
        setDefaultSectionError(response.message || 'Failed to save advance configuration');
      }
    } catch (err: any) {
      setDefaultSectionError(err?.message || 'Failed to save advance configuration');
    } finally {
      setSavingAdvance(false);
    }
  };

  const handleSaveDefaultRuleAndLevel = async () => {
    if (!entityId) return;
    setSavingDefault(true);
    setDefaultSectionError(null);
    try {
      const levelName =
        entityTierLevel != null
          ? availableLevelOptions.find((o) => o.level === entityTierLevel)?.label?.replace(/^Level\s[\d.]+:\s*/, '') ?? null
          : null;

      if (entityType === 'Agent') {
        const updateRes = await TenantAdminAgentsService.updateAgent(entityId, {
          commissionTierLevel: entityTierLevel,
          commissionLevelId: entityCommissionLevelId,
          commissionGroupId: entityDefaultRuleId || null
        });
        if (!updateRes?.success) {
          throw new Error(updateRes?.message || 'Failed to save commission settings');
        }
      } else {
        const detailsRes = await TenantAdminAgentsService.getAgencyDetails(entityId);
        if (!detailsRes.success || !detailsRes.data) {
          throw new Error('Could not load agency details to update');
        }
        const d = detailsRes.data as any;
        const updateRes = await TenantAdminAgentsService.updateAgency(entityId, {
          agencyName: d.AgencyName || d.Name,
          contactEmail: d.ContactEmail || d.Email || '',
          commissionTierLevel: entityTierLevel,
          commissionLevelId: entityCommissionLevelId,
          commissionGroupId: entityDefaultRuleId ?? null
        });
        if (!updateRes?.success) {
          throw new Error(updateRes?.message || 'Failed to save commission settings');
        }
      }

      const updates = {
        commissionTierLevel: entityTierLevel,
        commissionLevelId: entityCommissionLevelId,
        commissionGroupId: entityDefaultRuleId || null,
        commissionGroupName: entityDefaultRuleName || null,
        commissionLevelName: levelName
      };
      onSave?.(entityType, entityId, updates);
      toast.success('Commission settings saved');
      setDefaultSectionError(null);
    } catch (err: any) {
      const msg = err?.message || 'Failed to save commission settings';
      setDefaultSectionError(msg);
      toast.error(msg);
    } finally {
      setSavingDefault(false);
    }
  };

  const loadRules = async (
    overrideFilter?: 'all' | 'tenant' | 'agency' | 'agent',
    agencyIdOverride?: string | null
  ) => {
    const effectiveFilter = overrideFilter ?? filterType;
    const effectiveAgencyId = agencyIdOverride !== undefined ? agencyIdOverride : agentAgencyId;

    setLoading(true);
    setError(null);
    try {
      const params: any = { status: 'Active' };

      if (effectiveFilter === 'all') {
        // Get all applicable rules - include tenant, agency, and agent rules
        // We need to fetch both entity-specific rules AND tenant-level rules
        params.entityType = entityType;
        params.entityId = entityId;
        // Also fetch tenant-level Tier rules (we'll combine them in the response)
      } else if (effectiveFilter === 'tenant') {
        params.entityType = 'Tier';
      } else if (effectiveFilter === 'agency') {
        params.entityType = 'Agency';
        const targetAgencyId = (entityType === 'Agent' && effectiveAgencyId) ? effectiveAgencyId : entityId;
        if (!targetAgencyId) {
          setRules([]);
          setLoading(false);
          return;
        }
        params.entityId = targetAgencyId;
      } else if (effectiveFilter === 'agent') {
        // Get agent-specific rules
        params.entityType = 'Agent';
        params.entityId = entityId;
      }

      const response = await commissionService.getCommissionRules(params);
      
      if (response.success && response.rules) {
        let filteredRules = response.rules;

        if (effectiveFilter === 'all') {
          // For "all", we need to fetch:
          // 1. Tenant-level rules (Tier rules without entityId/agencyId/agentid)
          // 2. Agency-level rules (if viewing an agent, get rules for the agent's agency)
          // 3. Agent-level rules (if viewing an agent)
          
          const allRules: CommissionRule[] = [...response.rules];
          
          // Fetch tenant-level rules
          const tenantRulesParams = {
            entityType: 'Tier',
            status: 'Active'
            // Don't set entityId to get all tier rules
          };
          
          try {
            const tenantResponse = await commissionService.getCommissionRules(tenantRulesParams);
            if (tenantResponse.success && tenantResponse.rules) {
              // Filter to only tenant-level rules (no entityId/agencyId/agentid)
              const tenantLevelRules = tenantResponse.rules.filter((rule: CommissionRule) => {
                return rule.EntityType === 'Tier' && 
                       (!rule.EntityId || rule.EntityId === null) && 
                       (!rule.agencyId || rule.agencyId === null) && 
                       (!rule.agentid || rule.agentid === null);
              });
              allRules.push(...tenantLevelRules);
            }
          } catch (err) {
            console.error('Error fetching tenant-level rules:', err);
          }
          
          // If viewing an agent, also fetch agency-level rules for their agency
          if (entityType === 'Agent' && effectiveAgencyId) {
            try {
              const agencyRulesParams = {
                entityType: 'Agency',
                entityId: effectiveAgencyId,
                status: 'Active'
              };
              const agencyResponse = await commissionService.getCommissionRules(agencyRulesParams);
              if (agencyResponse.success && agencyResponse.rules) {
                allRules.push(...agencyResponse.rules);
              }
            } catch (err) {
              console.error('Error fetching agency-level rules:', err);
            }
          }
          
          // Remove duplicates based on RuleId
          const ruleIds = new Set<string>();
          filteredRules = allRules.filter((rule: CommissionRule) => {
            if (ruleIds.has(rule.RuleId)) {
              return false;
            }
            ruleIds.add(rule.RuleId);
            return true;
          });
          // Populate default-rule dropdown from same data so we don't call loadApplicableRulesForDropdown
          const ALL_PRODUCTS_ID = '00000000-0000-0000-0000-000000000000';
          const allProductsOnly = filteredRules.filter(
            (r) => r.ProductId === ALL_PRODUCTS_ID || !r.ProductId
          );
          const sortedForDropdown = [...allProductsOnly].sort((a, b) => (a.Priority ?? 999) - (b.Priority ?? 999));
          setApplicableRulesForDropdown(sortedForDropdown);
        } else if (effectiveFilter === 'tenant') {
          filteredRules = response.rules.filter((rule: CommissionRule) => {
            return rule.EntityType === 'Tier' && 
                   (!rule.EntityId || rule.EntityId === null) && 
                   (!rule.agencyId || rule.agencyId === null) && 
                   (!rule.agentid || rule.agentid === null);
          });
        } else if (effectiveFilter === 'agency') {
          const targetAgencyId = (entityType === 'Agent' && effectiveAgencyId) ? effectiveAgencyId : entityId;
          filteredRules = response.rules.filter((rule: CommissionRule) => {
            const matchesAgency = rule.agencyId === targetAgencyId || rule.agentid === targetAgencyId;
            return (rule.EntityType === 'Agency' && matchesAgency) ||
                   (rule.EntityType === 'Tier' && matchesAgency) ||
                   (rule.EntityType === 'Agent' && matchesAgency);
          });
        } else if (effectiveFilter === 'agent') {
          filteredRules = response.rules.filter((rule: CommissionRule) => {
            return rule.EntityType === 'Agent' || 
                   (rule.EntityType === 'Tier' && (rule.agentid === entityId || rule.EntityId === entityId));
          });
        }
        
        // Sort by priority (ascending, nulls last), then by effective date (descending)
        const sortedRules = [...filteredRules].sort((a, b) => {
          const priorityA = a.Priority ?? 999;
          const priorityB = b.Priority ?? 999;
          if (priorityA !== priorityB) {
            return priorityA - priorityB;
          }
          const dateA = a.EffectiveDate ? new Date(a.EffectiveDate).getTime() : 0;
          const dateB = b.EffectiveDate ? new Date(b.EffectiveDate).getTime() : 0;
          return dateB - dateA;
        });
        setRules(sortedRules);
      } else {
        setRules([]);
      }
    } catch (err: any) {
      console.error('Error loading commission rules:', err);
      setError(err.message || 'Failed to load commission rules');
      setRules([]);
    } finally {
      setLoading(false);
    }
  };

  const getStatusBadge = (rule: CommissionRule) => {
    const baseClasses = "inline-flex px-2 py-1 text-xs font-semibold rounded-full";
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const effectiveDate = rule.EffectiveDate ? new Date(rule.EffectiveDate) : null;
    const terminationDate = rule.TerminationDate ? new Date(rule.TerminationDate) : null;
    
    if (effectiveDate) {
      effectiveDate.setHours(0, 0, 0, 0);
    }
    if (terminationDate) {
      terminationDate.setHours(0, 0, 0, 0);
    }
    
    // If rule is unlocked, it's inactive (unlocked rules don't apply)
    if (!rule.Locked) {
      return (
        <span className={`${baseClasses} bg-gray-100 text-gray-800 flex items-center gap-1`}>
          <AlertTriangle className="h-3 w-3" />
          Inactive
        </span>
      );
    }
    
    // Check if rule is effective in the future
    if (effectiveDate && effectiveDate > today) {
      const formattedDate = format(effectiveDate, 'M/d/yy');
      return (
        <span className={`${baseClasses} bg-yellow-100 text-yellow-800 flex items-center gap-1`}>
          <AlertTriangle className="h-3 w-3" />
          Effective Starting {formattedDate}
        </span>
      );
    }
    
    // Check if rule is terminated
    if (terminationDate && terminationDate < today) {
      return (
        <span className={`${baseClasses} bg-gray-100 text-gray-800 flex items-center gap-1`}>
          <AlertTriangle className="h-3 w-3" />
          Terminated
        </span>
      );
    }
    
    // Check if rule is currently active - no label needed
    const isActive = rule.Status === 'Active' && 
      (!effectiveDate || effectiveDate <= today) &&
      (!terminationDate || terminationDate >= today);
    
    if (isActive) return null;
    return (
      <span className={`${baseClasses} bg-gray-100 text-gray-800 flex items-center gap-1`}>
        <AlertTriangle className="h-3 w-3" />
        {rule.Status}
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

  const getTieredCommissionDisplay = (rule: CommissionRule): string => {
    if (rule.CommissionType !== 'Tiered' || !rule.CommissionJson) {
      return '';
    }
    
    try {
      const json = typeof rule.CommissionJson === 'string' 
        ? JSON.parse(rule.CommissionJson) 
        : rule.CommissionJson;
      
      const commissionTypeType = json.type || 'percentage';
      
      if (json.tiers && Array.isArray(json.tiers) && json.tiers.length > 0) {
        const productTierKeys = ['EE', 'ES', 'EC', 'EF'] as const;
        
        // Build display for each tier
        const tierDisplay = json.tiers
          .filter((tier: any) => {
            // Only show tiers that have a value set (either direct or in productTiers)
            return tier.rate !== undefined || tier.flatAmount !== undefined ||
                   (tier.productTiers && Object.keys(tier.productTiers).length > 0);
          })
          .map((tier: any) => {
            const label = tier.name || `Level ${tier.level ?? tier.tierLevel ?? 0}`;
            
            // Check if this tier has productTiers (EE, ES, EC, EF)
            if (tier.productTiers && typeof tier.productTiers === 'object') {
              const tierValues: number[] = [];
              
              productTierKeys.forEach(key => {
                if (tier.productTiers[key]) {
                  if (commissionTypeType === 'flatrate' && tier.productTiers[key].flatAmount !== undefined) {
                    tierValues.push(tier.productTiers[key].flatAmount);
                  } else if (tier.productTiers[key].rate !== undefined) {
                    const rate = tier.productTiers[key].rate > 1 ? tier.productTiers[key].rate : tier.productTiers[key].rate * 100;
                    tierValues.push(rate);
                  }
                }
              });
              
              if (tierValues.length > 0) {
                const min = Math.min(...tierValues);
                const max = Math.max(...tierValues);
                if (min === max) {
                  // All product tier values are the same
                  if (commissionTypeType === 'flatrate') {
                    return `${label}: $${min.toFixed(2)}`;
                  } else {
                    return `${label}: ${min.toFixed(2)}%`;
                  }
                } else {
                  // Show range for this tier
                  if (commissionTypeType === 'flatrate') {
                    return `${label}: $${min.toFixed(2)}-$${max.toFixed(2)}`;
                  } else {
                    return `${label}: ${min.toFixed(2)}%-${max.toFixed(2)}%`;
                  }
                }
              }
            }
            
            // Fall back to direct tier values (no productTiers)
            if (commissionTypeType === 'flatrate' && tier.flatAmount !== undefined) {
              return `${label}: $${tier.flatAmount.toFixed(2)}`;
            } else if (tier.rate !== undefined) {
              const rate = tier.rate > 1 ? tier.rate : tier.rate * 100;
              return `${label}: ${rate.toFixed(2)}%`;
            }
            return `${label}: Not set`;
          })
          .join(', ');
        
        return tierDisplay || 'Tiered (no tiers configured)';
      }
    } catch {
      // Ignore parse errors
    }
    
    return 'Tiered';
  };

  if (!isOpen) return null;

  const content = (
    <>
        {/* Upline row moved into Commission Settings tab */}
        {!embedded && (
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div>
            <h2 className="text-2xl font-semibold text-gray-900">
              Commission Settings
            </h2>
            <p className="text-gray-600 mt-1">
              {entityType}: {entityName}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {entityType === 'Agent' && onConfigureUpline && (
              <button
                type="button"
                onClick={() => {
                  onConfigureUpline(entityId);
                  onClose();
                }}
                className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                title="Edit upline"
              >
                <span className="text-gray-600">Upline: {uplineName?.trim() || '—'}</span>
                <Pencil className="h-4 w-4 text-gray-500" />
              </button>
            )}
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 transition-colors"
            >
              <X className="h-6 w-6" />
            </button>
          </div>
        </div>
        )}

        <div className={`flex-1 overflow-y-auto ${embedded ? 'p-4' : 'p-6'}`}>
          {/* Sub-tabs: Commission Settings | Advances | Payouts */}
          <div className="flex border-b border-gray-200 mb-4">
            <button
              type="button"
              onClick={() => setActiveTab('level')}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                activeTab === 'level'
                  ? 'border-oe-primary text-oe-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Commission Settings
            </button>
            {!embedded && (
              <button
                type="button"
                onClick={() => setActiveTab('rules')}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  activeTab === 'rules'
                    ? 'border-oe-primary text-oe-primary'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                Commission Rules
              </button>
            )}
            {embedded && entityType === 'Agent' && (
            <button
              type="button"
              onClick={() => setActiveTab('payouts')}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                activeTab === 'payouts'
                  ? 'border-oe-primary text-oe-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Payouts
            </button>
            )}
          </div>

          {activeTab === 'level' && (
          <div className="mb-6 p-4 bg-gray-50 border border-gray-200 rounded-lg">
            {/* Tab title is "Commission Level" */}
            {!settingsReady || loadingDefaultSection ? (
              <div className="flex items-center justify-center gap-2 text-gray-500 text-sm py-8">
                <Loader2 className="h-5 w-5 animate-spin text-oe-primary" />
                Loading commission settings…
              </div>
            ) : (
              <>
                {defaultSectionError && !(isViewingSelf && /permission|insufficient/i.test(defaultSectionError)) && (
                  <div className="mb-4 flex gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                    <AlertCircle className="h-5 w-5 flex-shrink-0 text-red-500" />
                    <span>{defaultSectionError}</span>
                  </div>
                )}
                {entityType === 'Agency' && entityIsPrimaryAgency && (
                  <p className="mb-3 text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    Primary agency: choose <strong>None</strong> (overflow only — not in the tier chain),{' '}
                    <strong>Level 5 (FMO)</strong>, or <strong>Level 6 (Enterprise/Carrier)</strong>.
                    Unallocated commission pool overflow is paid to this agency.
                  </p>
                )}
                <div className="flex flex-wrap items-end gap-4">
                  {/* Commission Group: only TenantAdmin/SysAdmin can change; hide from Agent entirely if none set */}
                  {(canEditDefaultRule() || (entityDefaultRuleId ?? '')) && (
                    <div className="min-w-[200px]">
                      <label htmlFor="default-rule" className="block text-xs font-medium text-gray-600 mb-1">
                        Commission Group
                      </label>
                      <select
                        id="default-rule"
                        value={entityDefaultRuleId ?? ''}
                        onChange={(e) => {
                          const v = e.target.value;
                          setEntityDefaultRuleId(v || null);
                          const g = commissionGroups.find((x) => x.CommissionGroupId === v);
                          setEntityDefaultRuleName(g?.Name ?? '');
                        }}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        disabled={!canEditDefaultRule() || loadingCommissionGroups}
                      >
                        <option value="">None</option>
                        {commissionGroups
                          .filter((g) => (g.Status || '').toLowerCase() === 'active')
                          .map((g) => (
                          <option key={g.CommissionGroupId} value={g.CommissionGroupId}>
                            {g.Name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="min-w-[200px]">
                    <label htmlFor="tier-level" className="block text-xs font-medium text-gray-600 mb-1">
                      Level
                    </label>
                    <select
                      id="tier-level"
                      value={entityTierLevel ?? ''}
                      onChange={(e) => {
                        const raw = e.target.value;
                        if (raw === '') {
                          // Agency-only "None" — clears commission entirely so the
                          // agency drops out of the upline chain in tier rules.
                          setEntityTierLevel(null);
                          setEntityCommissionLevelId(null);
                          return;
                        }
                        const nextLevel = Number(raw);
                        setEntityTierLevel(nextLevel);
                        const matched = availableLevelOptions.find((opt) => opt.level === nextLevel);
                        setEntityCommissionLevelId(matched?.commissionLevelId || null);
                      }}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      disabled={!canEdit()}
                    >
                      {entityType === 'Agency' && (
                        <option value="">None — no commissions</option>
                      )}
                      {(() => {
                        const restricted = effectiveViewerTierLevel != null && entityType === 'Agent';
                        let options = restricted
                          ? availableLevelOptions.filter((opt) => opt.level < effectiveViewerTierLevel!)
                          : [...availableLevelOptions];
                        if (entityType === 'Agency' && entityIsPrimaryAgency) {
                          options = options.filter((opt) => opt.level === 5 || opt.level === 6);
                        }
                        options.sort((a, b) => b.level - a.level);
                        const fallbackLevel = entityTierLevel ?? 0;
                        const tierOptions: Array<{ level: number; label: string }> =
                          options.length > 0
                            ? options
                            : [{ level: fallbackLevel, label: getTierLevelLabel(fallbackLevel) }];
                        return tierOptions.map((tier) => (
                          <option key={tier.level} value={tier.level}>
                            {tier.label}
                          </option>
                        ));
                      })()}
                    </select>
                  </div>
                  {canEdit() && (
                    <button
                      type="button"
                      onClick={handleSaveDefaultRuleAndLevel}
                      disabled={savingDefault}
                      className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark transition-colors flex items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed text-sm"
                    >
                      {savingDefault ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Save className="h-4 w-4" />
                      )}
                      Save
                    </button>
                  )}
                  {entityType === 'Agent' && canApplyToDownlines() && (
                    <button
                      type="button"
                      onClick={() => setShowApplyToDownlinesModal(true)}
                      className="px-4 py-2 text-oe-primary border border-oe-primary rounded-lg hover:bg-oe-light transition-colors flex items-center gap-2 text-sm"
                    >
                      <Users className="h-4 w-4" />
                      Apply Commission Group to Downlines
                      {downlineCount > 0 && (
                        <span className="ml-1 text-xs opacity-80">({downlineCount})</span>
                      )}
                    </button>
                  )}
                </div>
                {/* Commission Group — only render the inheritance row when no
                    direct group is set on this agent. The dropdown above shows
                    the direct assignment; this row is informational
                    inheritance. Showing both confused readers (looked like the
                    dropdown was wrong). */}
                {embedded && entityType === 'Agent' && !entityDefaultRuleId && effectiveGroup && effectiveGroup.source === 'inherited' && (
                  <div className="mt-3 pt-3 border-t border-gray-200 flex items-center gap-2 text-sm text-gray-600 flex-wrap">
                    <span className="font-medium text-gray-700">Inherited group:</span>
                    <span className="font-medium text-gray-900">{effectiveGroup.name || effectiveGroup.commissionGroupId}</span>
                    <span className="text-xs text-gray-400">(from upline/agency)</span>
                  </div>
                )}
                {/* Upline display (agents only, embedded) */}
                {embedded && entityType === 'Agent' && (
                  <div className="mt-3 pt-3 border-t border-gray-200 flex items-center justify-between text-sm text-gray-600">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-gray-700">Upline:</span>
                      <span>{uplineName?.trim() || '—'}</span>
                    </div>
                    {onConfigureUpline && (
                      <button
                        type="button"
                        onClick={() => onConfigureUpline(entityId)}
                        className="inline-flex items-center gap-1 text-oe-primary hover:text-oe-dark font-medium text-sm"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        Configure
                      </button>
                    )}
                  </div>
                )}
                {/* Advance Period (agents only) */}
                {entityType === 'Agent' && (
                  <div className="mt-3 pt-3 border-t border-gray-200 flex items-center gap-3 text-sm flex-wrap">
                    <span className="font-medium text-gray-700">Advance Period:</span>
                    <select
                      value={advanceMonths === null ? '' : advanceMonths}
                      onChange={(e) => setAdvanceMonths(e.target.value === '' ? null : parseInt(e.target.value, 10))}
                      className="px-2 py-1 border border-gray-300 rounded text-sm focus:ring-1 focus:ring-oe-primary focus:border-oe-primary"
                      disabled={!canEditDefaultRule()}
                    >
                      <option value="">None</option>
                      {[1,2,3,4,5,6,7,8,9,10,11,12].map((m) => (
                        <option key={m} value={m}>{m} {m === 1 ? 'month' : 'months'}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      title="When enabled, the agent receives their commission upfront for the selected number of months. For example, 6 months means they receive 6× the monthly commission immediately at enrollment. During the advance period, subsequent monthly payments show $0 commission; normal commission resumes after the advance period expires."
                      className="text-gray-400 hover:text-gray-600 focus:outline-none"
                    >
                      <AlertCircle className="h-4 w-4" />
                    </button>
                    {canEditDefaultRule() && (
                      <button
                        type="button"
                        onClick={handleSaveAdvance}
                        disabled={savingAdvance}
                        className="px-3 py-1 bg-oe-primary text-white rounded text-sm hover:bg-oe-dark disabled:opacity-60 flex items-center gap-1"
                      >
                        {savingAdvance ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                        Save
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
          )}

          {/* Overrides (agents only, embedded, TenantAdmin/SysAdmin) */}
          {activeTab === 'level' && embedded && entityType === 'Agent' && canEditDefaultRule() && (
            <div className="mt-4">
              <AgentCommissionOverridesSection
                sourceAgentId={entityId}
                sourceAgentName={entityName}
                canEdit={canEditDefaultRule()}
              />
            </div>
          )}

          {/* Commission Simulator (agents, Commission Settings tab only) */}
          {activeTab === 'level' && entityType === 'Agent' && (
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={async () => {
                  try {
                    let agentId: string | undefined = entityId;
                    const tenantId = resolveTenantScopeId(propExplicitTenantId) || undefined;
                    setSimulatorAgentId(agentId);
                    setSimulatorTenantId(tenantId);
                    setShowSimulator(true);
                  } catch (error) {
                    console.error('Error opening simulator:', error);
                    alert('Failed to open commission simulator. Please try again.');
                  }
                }}
                className="px-3 py-1.5 border border-gray-300 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors flex items-center gap-1.5 text-sm"
              >
                <Calculator className="h-3.5 w-3.5" />
                Commission Simulator
              </button>
            </div>
          )}

          {activeTab === 'payouts' && embedded && entityType === 'Agent' && (
            <AgentCommissionPayoutsView agentId={entityId} agentName={entityName} />
          )}

          {activeTab === 'rules' && (
          <>
          {/* Filter and Create New Rule at top */}
          <div className="mb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex items-center gap-3">
              <label htmlFor="rule-filter" className="text-sm font-medium text-gray-700">
                Filter:
              </label>
              <select
                id="rule-filter"
                value={filterType}
                onChange={(e) => {
                  const v = e.target.value as 'all' | 'tenant' | 'agency' | 'agent';
                  setFilterType(v);
                  loadRules(v);
                }}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="all">All Applicable Rules</option>
                <option value="tenant">Tenant Rules</option>
                <option value="agency">Agency Rules</option>
                {entityType === 'Agent' && <option value="agent">Agent Rules</option>}
              </select>
            </div>
            {canEditDefaultRule() && (
              <button
                onClick={() => setShowCreateRuleWizard(true)}
                className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark transition-colors flex items-center gap-2"
              >
                <Plus className="h-4 w-4" />
                Create New Rule
              </button>
            )}
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
              <span className="ml-2 text-gray-600">Loading commission rules...</span>
            </div>
          ) : error ? (
            <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-4">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-5 w-5 mt-0.5" />
                <div>
                  <div className="font-semibold">Error loading commission rules</div>
                  <div className="text-sm mt-1">{error}</div>
                </div>
              </div>
            </div>
          ) : rules.length === 0 ? (
            <div className="text-center py-12">
              <FileText className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-2 text-sm font-medium text-gray-900">No commission rules found</h3>
              <p className="mt-1 text-sm text-gray-500">
                This {entityType.toLowerCase()} does not have any active commission rules assigned.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Rule Name</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Product</th>
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
                  {rules.map((rule) => (
                    <tr key={rule.RuleId} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                        <div className="flex items-center gap-2">
                          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-gray-100 text-gray-600 text-xs font-semibold" title={`Priority: ${rule.Priority ?? 999}`}>
                            {rule.Priority ?? 999}
                          </span>
                          {rule.RuleName}
                          {rule.Locked && (
                            <Lock className="h-4 w-4 text-yellow-600" title="This rule is locked. Only the Termination Date can be edited." />
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {rule.ProductId === '00000000-0000-0000-0000-000000000000' ? (
                          <span className="text-gray-400 italic">All Products</span>
                        ) : rule.ProductName ? (
                          rule.ProductName
                        ) : (
                          'N/A'
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {getTierDisplayForRule(rule) || '—'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {rule.Scope ?? '—'}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-500">
                        {rule.CommissionType === 'Percentage' && rule.CommissionRate
                          ? `${(rule.CommissionRate * 100).toFixed(2)}%`
                          : rule.CommissionType === 'Flat' && rule.FlatAmount
                          ? `$${rule.FlatAmount.toFixed(2)}`
                          : rule.CommissionType === 'Split'
                          ? 'Split'
                          : rule.CommissionType === 'Tiered'
                          ? (
                              <div className="space-y-1">
                                <div className="font-medium">Tiered</div>
                                {getTieredCommissionDisplay(rule) && (
                                  <div className="text-xs text-gray-600">
                                    {getTieredCommissionDisplay(rule)}
                                  </div>
                                )}
                              </div>
                            )
                          : 'N/A'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm">
                        {getStatusBadge(rule)}
                      </td>
                      {canEdit() && (
                        <td className="px-6 py-4 whitespace-nowrap text-sm">
                          <div 
                            className="relative" 
                            ref={(el) => {
                              if (el) {
                                menuRefs.current.set(rule.RuleId, el);
                              } else {
                                menuRefs.current.delete(rule.RuleId);
                              }
                            }}
                          >
                            <button
                              onClick={() => handleMenuClick(rule.RuleId)}
                              className="text-gray-600 hover:text-gray-800"
                              title="More options"
                            >
                              <MoreVertical className="h-4 w-4" />
                            </button>
                            {menuOpen === rule.RuleId && (() => {
                              const menuRef = menuRefs.current.get(rule.RuleId);
                              const rect = menuRef?.getBoundingClientRect();
                              return (
                                <div 
                                  className="fixed w-48 bg-white rounded-md shadow-xl z-[10000] border border-gray-200"
                                  style={{
                                    top: `${(rect?.bottom || 0) + 8}px`,
                                    left: `${Math.max(8, (rect?.right || 0) - 192)}px`
                                  }}
                                  onMouseDown={(e) => e.stopPropagation()}
                                >
                                <div className="py-1">
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      e.preventDefault();
                                      handleEditRule(rule);
                                    }}
                                    disabled={!canEditRule(rule)}
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
                                      handleDeleteRule(rule);
                                    }}
                                    disabled={(() => {
                                      if (rule.Locked) return true;
                                      return !canEditRule(rule);
                                    })()}
                                    className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                                  >
                                    <Trash2 className="h-4 w-4" />
                                    Delete
                                  </button>
                                </div>
                              </div>
                              );
                            })()}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          </>
          )}

        </div>

        {!embedded && (
        <div className="border-t border-gray-200 px-6 py-4 bg-gray-50 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Close
          </button>
        </div>
        )}
    </>
  );

  if (embedded) {
    return (
      <>
        <div className="flex flex-col min-h-0">
          {content}
        </div>
        {showSimulator && (
          <CommissionSimulator
            onClose={() => {
              setShowSimulator(false);
              setSimulatorAgentId(undefined);
              setSimulatorTenantId(undefined);
            }}
            initialAgentId={simulatorAgentId}
            initialTenantId={simulatorTenantId}
          />
        )}
        {showCreateRuleWizard && (
          <RuleCreationWizard
            open={showCreateRuleWizard}
            onClose={() => setShowCreateRuleWizard(false)}
            onRuleCreated={() => {
              setShowCreateRuleWizard(false);
              loadRules();
            }}
            initialEntityType={entityType === 'Agent' || entityType === 'Agency' ? undefined : entityType}
            initialEntityId={entityId}
          />
        )}
        {showEditRuleWizard && selectedRule && (
          <RuleCreationWizard
            open={showEditRuleWizard}
            rule={selectedRule}
            onClose={() => {
              setShowEditRuleWizard(false);
              setSelectedRule(null);
            }}
            onRuleCreated={() => {
              setShowEditRuleWizard(false);
              setSelectedRule(null);
              loadRules();
            }}
          />
        )}
        <ApplyCommissionGroupToDownlinesModal
          isOpen={showApplyToDownlinesModal}
          onClose={() => setShowApplyToDownlinesModal(false)}
          uplineAgentId={entityId}
          uplineAgentName={entityName}
          commissionGroups={commissionGroups}
          onSuccess={() => {
            loadEntityDefaultAndLevel();
            onSave?.(entityType, entityId);
          }}
        />
      </>
    );
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[100] p-4">
      <div className="bg-white rounded-lg border border-gray-200 shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col relative">
        {content}
      </div>

      {/* Commission Simulator Modal */}
      {showSimulator && (
        <CommissionSimulator
          onClose={() => {
            setShowSimulator(false);
            setSimulatorAgentId(undefined);
            setSimulatorTenantId(undefined);
          }}
          initialAgentId={simulatorAgentId}
          initialTenantId={simulatorTenantId}
        />
      )}

      {/* Rule Creation Wizard */}
      {showCreateRuleWizard && (
        <RuleCreationWizard
          open={showCreateRuleWizard}
          onClose={() => setShowCreateRuleWizard(false)}
          onRuleCreated={() => {
            setShowCreateRuleWizard(false);
            loadRules(); // Reload rules to show the new one
          }}
          initialEntityType={entityType === 'Agent' || entityType === 'Agency' ? undefined : entityType}
          initialEntityId={entityId}
        />
      )}

      {/* Edit Rule Wizard */}
      {showEditRuleWizard && selectedRule && (
        <RuleCreationWizard
          open={showEditRuleWizard}
          rule={selectedRule}
          onClose={() => {
            setShowEditRuleWizard(false);
            setSelectedRule(null);
          }}
          onRuleCreated={() => {
            setShowEditRuleWizard(false);
            setSelectedRule(null);
            loadRules(); // Reload rules to show the updated one
          }}
        />
      )}

      {/* Apply Commission Group to Downlines */}
      <ApplyCommissionGroupToDownlinesModal
        isOpen={showApplyToDownlinesModal}
        onClose={() => setShowApplyToDownlinesModal(false)}
        uplineAgentId={entityId}
        uplineAgentName={entityName}
        commissionGroups={commissionGroups}
        onSuccess={() => {
          loadEntityDefaultAndLevel();
          onSave?.(entityType, entityId);
        }}
      />
    </div>
  );
};

export default CommissionRulesModal;

