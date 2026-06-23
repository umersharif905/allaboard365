// frontend/src/components/commissions/CommissionSimulator.tsx
import { AlertTriangle, Calculator, CheckCircle2, ChevronLeft, ChevronRight, DollarSign, Loader2, TrendingUp, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { apiService } from '../../services/apiServices';
import { commissionService } from '../../services/commissions.service';
import { PricingService, type PricingResult } from '../../services/pricing.service';
import { TenantAdminService } from '../../services/tenant-admin/tenant-admin.service';
import { TenantAdminAgentsService } from '../../services/tenant-admin/agents.service';
import SearchableDropdown from '../common/SearchableDropdown';
import { getTierLevelLabel, getTierName } from '../../constants/form-options';
import { useDownlineAgentsForFilter } from '../../hooks/useDownlineAgentsForFilter';
import { useCommissionLevels } from '../../hooks/useCommissionLevels';
import { isAgentFilterScopeSentinel } from '../../constants/agentFilterScope';

interface CommissionSimulatorProps {
  onClose: () => void;
  initialAgentId?: string;
  initialTenantId?: string;
  initialRuleId?: string;
  initialGroupId?: string;
}

type WizardStep = 1 | 2 | 3 | 4;
type HouseholdTier = 'EE' | 'ES' | 'EC' | 'EF';
type TobaccoUse = 'Yes' | 'No';

type ProductForWizard = {
  id: string;
  name: string;
  salesType: 'Individual' | 'Group' | 'Both' | string;
  isBundle: boolean;
  /** When set (bundle AllowedConfigOptions), config dropdown options are restricted to these values. */
  bundleAllowedConfigValues?: string[] | null;
};

/** Parse oe.ProductBundles.AllowedConfigOptions into a flat allowed-values list. */
function extractBundleAllowedConfigValues(allowed: unknown): string[] | null {
  if (!allowed || typeof allowed !== 'object') return null;
  if (Array.isArray(allowed)) {
    const entry = allowed.find((a: unknown) => {
      const row = a as { allowedValues?: unknown };
      return Array.isArray(row?.allowedValues);
    }) as { allowedValues?: unknown[] } | undefined;
    return entry?.allowedValues?.map(String) ?? null;
  }
  const vals = Object.values(allowed as Record<string, unknown>).find((v) => Array.isArray(v)) as
    | string[]
    | undefined;
  return vals?.map(String) ?? null;
}

function productHasConfigurableFields(product: unknown): boolean {
  const configFields =
    (product as { ConfigurationFields?: unknown })?.ConfigurationFields ||
    (product as { configurationFields?: unknown })?.configurationFields ||
    (product as { RequiredDataFields?: unknown })?.RequiredDataFields ||
    (product as { requiredDataFields?: unknown })?.requiredDataFields;
  if (!configFields) return false;
  try {
    const parsed = typeof configFields === 'string' ? JSON.parse(configFields) : configFields;
    if (Array.isArray(parsed)) {
      return parsed.some(
        (field: { fieldOptions?: unknown }) =>
          Array.isArray(field?.fieldOptions) && field.fieldOptions.length > 0
      );
    }
    const cfg = parsed as { ConfigValue1?: { options?: unknown[] } };
    return Array.isArray(cfg?.ConfigValue1?.options) && cfg.ConfigValue1.options.length > 0;
  } catch {
    return false;
  }
}

interface SimulationAgentOverride {
  overrideId: string;
  overrideType: 'Fixed' | 'Percentage';
  sourceAgentId: string;
  sourceAgentName: string;
  recipientAgentId: string;
  recipientAgentName: string | null;
  amount: number;
  sourceTotalBefore?: number;
  skipped?: boolean;
  skipReason?: string;
}

interface SimulationResult {
  agentId: string;
  tenantId: string;
  productId?: string;
  allocatedCommissionAmount: number;
  paymentDate: string;
  commissionRuleId?: string;
  agentActualRuleId?: string; // The agent's actual assigned rule
  agentOverrides?: SimulationAgentOverride[];
  breakdown: {
    agents: Array<{
      agentId: string;
      amount: number;
      tierLevel: number;
      ruleId?: string;
      ruleName?: string;
      commissionType?: string;
      isOverride?: boolean;
      isSplitPartner?: boolean;
      splitAmount?: number;
      splitFromAgentId?: string;
    }>;
    vendors: Array<{
      vendorId: string;
      amount: number;
      ruleId?: string;
      ruleName?: string;
      isVendorCommission?: boolean;
    }>;
    tenants: Array<{
      tenantId: string;
      amount: number;
      ruleId?: string;
      ruleName?: string;
      isOverride?: boolean;
      isExcess?: boolean;
      isPrimaryAgency?: boolean;
      tierLevel?: number | null;
    }>;
    /** Set by the calculator when a tenant has no primary agency to receive overflow. */
    overflowDestinationMissing?: boolean;
  };
  totalCommissionsPaid: number;
  vendorCommissionPaid: number;
  totalPayouts: number;
  remainingAmount: number;
  overflowToProductOwner: number;
}

const CommissionSimulator: React.FC<CommissionSimulatorProps> = ({ onClose, initialAgentId, initialTenantId, initialRuleId, initialGroupId }) => {
  const { user } = useAuth();
  const [simulating, setSimulating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SimulationResult | null>(null);
  
  // Input state
  const [tenantId, setTenantId] = useState<string>(initialTenantId || '');
  const [agentId, setAgentId] = useState<string>(initialAgentId || '');
  const [commissionRuleId, setCommissionRuleId] = useState<string>(initialRuleId || '');
  const [agentActualRuleId, setAgentActualRuleId] = useState<string | null>(null);
  const [allocatedCommissionAmount, setAllocatedCommissionAmount] = useState<string>('');
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [productOptions, setProductOptions] = useState<Array<{ id: string; label: string; value: string }>>([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [paymentDate, setPaymentDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [includeUnlockedRules] = useState<boolean>(false);
  const [productTier, setProductTier] = useState<string>(''); // Product tier code (EE, ES, EC, EF)
  const [groupId, setGroupId] = useState<string>(initialGroupId || ''); // Group ID for testing split commission rules

  // Wizard state (new)
  const [wizardStep, setWizardStep] = useState<WizardStep>(1);
  const [wizardError, setWizardError] = useState<string | null>(null);
  const [wizardIncludeUnlockedRules] = useState<boolean>(false);
  const [wizardTier, setWizardTier] = useState<HouseholdTier>('EE');
  const [wizardAge, setWizardAge] = useState<number>(30);
  const [wizardTobaccoUse, setWizardTobaccoUse] = useState<TobaccoUse>('No');
  const [wizardProductSearch, setWizardProductSearch] = useState<string>('');
  const [wizardProducts, setWizardProducts] = useState<ProductForWizard[]>([]);
  const [wizardConfigByProductId, setWizardConfigByProductId] = useState<Record<string, string>>({});
  const [pricingPreview, setPricingPreview] = useState<PricingResult | null>(null);
  const [pricingPreviewLoading, setPricingPreviewLoading] = useState(false);
  const [pricingResult, setPricingResult] = useState<PricingResult | null>(null);
  const [pricingLoading, setPricingLoading] = useState(false);
  // Step 4 sim results keyed by lineItemId (not productId) so bundles can expand into included-product rows safely
  const [simulationResults, setSimulationResults] = useState<Record<string, SimulationResult>>({});
  const [simulationLoading, setSimulationLoading] = useState(false);
  const [wizardAgentNames, setWizardAgentNames] = useState<Map<string, string>>(new Map());
  const [wizardAgencyNames, setWizardAgencyNames] = useState<Map<string, string>>(new Map());
  /** Tenant-configured commission level names (SortOrder → DisplayName).
   *  Sourced via the shared `useCommissionLevels()` hook so this modal and
   *  every other commission UI stay in sync without duplicate fetches. */
  const { displayNameByLevel: tierLevelDisplayNames } = useCommissionLevels({
    tenantId: user?.currentRole === 'SysAdmin' ? tenantId : undefined,
  });
  const [lastAutoCalcSignature, setLastAutoCalcSignature] = useState<string | null>(null);
  const [resultsTab, setResultsTab] = useState<'agent' | 'vendor' | 'overrides'>('agent');
  // Defensive: snap non-admin viewers back to the agent tab if anything ever
  // sets vendor/overrides — admin-only views are otherwise hidden via the
  // tab buttons.
  useEffect(() => {
    const isAdmin = (user?.currentRole === 'TenantAdmin') || (user?.currentRole === 'SysAdmin');
    if (!isAdmin && resultsTab !== 'agent') setResultsTab('agent');
  }, [user?.currentRole, resultsTab]);
  const [payoutDestinations, setPayoutDestinations] = useState<{ vendors: Record<string, any>; overrides: Record<string, any>; overrideAch: Record<string, any> } | null>(null);
  const [payoutDestinationsLoading, setPayoutDestinationsLoading] = useState(false);
  
  // Dropdown options
  const [tenantOptions, setTenantOptions] = useState<Array<{ id: string; label: string; value: string }>>([]);
  const [agentOptions, setAgentOptions] = useState<Array<{ id: string; label: string; value: string; email?: string; code?: string }>>([]);
  const [ruleOptions, setRuleOptions] = useState<Array<{ id: string; label: string; value: string; locked?: boolean; ruleStatus?: string; commissionJson?: string; commissionType?: string }>>([]);
  const [groupOptions, setGroupOptions] = useState<Array<{ id: string; label: string; value: string }>>([]);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [ruleDataMap, setRuleDataMap] = useState<Map<string, { commissionJson?: string; commissionType?: string }>>(new Map());
  const [selectedRuleStatus, setSelectedRuleStatus] = useState<string | null>(null);
  const [loadingRules, setLoadingRules] = useState(false);
  const [loadingTenants, setLoadingTenants] = useState(false);
  const [loadingAgents, setLoadingAgents] = useState(false);
  
  // Missing commissions state (SysAdmin only)
  const [missingCommissionsCount, setMissingCommissionsCount] = useState<number | null>(null);
  const [loadingMissingCount, setLoadingMissingCount] = useState(false);
  const [generatingMissing, setGeneratingMissing] = useState(false);
  
  // Expanded sections for step-by-step display

  // Refs to track if we've already loaded data (prevent infinite loops)
  const agentsLoadedRef = useRef<{ tenantId?: string; role?: string }>({});
  const rulesLoadedRef = useRef<{ tenantId?: string; role?: string }>({});
  const productsLoadedRef = useRef<{ tenantId?: string; role?: string }>({});

  const currentRole = user?.currentRole;
  const isAgent = currentRole === 'Agent';
  const isTenantAdmin = currentRole === 'TenantAdmin';
  const isSysAdmin = currentRole === 'SysAdmin';
  const isAgencyOwner = (currentRole as string) === 'AgencyOwner';
  const useWizard = true;

  const formatAgentLabel = React.useCallback(
    (name: string, commissionTierLevel?: number | null) => {
      const base = (name || '').trim() || 'Unknown';
      if (
        commissionTierLevel === undefined ||
        commissionTierLevel === null ||
        Number.isNaN(Number(commissionTierLevel))
      ) {
        return base;
      }
      const level = Number(commissionTierLevel);
      const tierLabel = tierLevelDisplayNames.get(level) || getTierLevelLabel(level);
      return `${base} (${tierLabel})`;
    },
    [tierLevelDisplayNames]
  );

  // Agent-role downline / agency picker for the wizard. The hook returns scope
  // sentinels (e.g. AGENCY/DIRECT/SHOW_ALL) and an empty-string "Me" entry —
  // simulate-detailed needs a real GUID so we filter both out and remap "Me"
  // to the viewer's actual AgentId.
  const {
    data: downlineAgentOptions,
    currentAgentId: viewerAgentIdFromHook,
    agencyWideFilterAvailable,
    isLoading: isLoadingDownlineAgents
  } = useDownlineAgentsForFilter({ includeShowAllOption: false, agencyOwnerFilter: true });

  const agentOptionsForAgentRole = React.useMemo(() => {
    if (!isAgent) return [] as Array<{ id: string; label: string; value: string; email?: string }>;
    return (downlineAgentOptions || [])
      .filter((opt) => !isAgentFilterScopeSentinel(opt.value))
      .map((opt) => {
        const value = opt.value || viewerAgentIdFromHook || '';
        const displayName =
          opt.commissionTierLevel != null && !Number.isNaN(Number(opt.commissionTierLevel))
            ? formatAgentLabel(opt.label, opt.commissionTierLevel)
            : opt.label;
        return {
          id: value,
          label: displayName,
          value,
          email: opt.email
        };
      })
      .filter((opt) => !!opt.value);
  }, [isAgent, downlineAgentOptions, viewerAgentIdFromHook, formatAgentLabel]);

  const agentRoleHasPicker = isAgent && (agencyWideFilterAvailable || agentOptionsForAgentRole.length > 1);

  // Sync commissionRuleId when initialRuleId prop changes (e.g. preview from group rules)
  useEffect(() => {
    if (initialRuleId) {
      setCommissionRuleId(initialRuleId);
    }
  }, [initialRuleId]);

  // In wizard mode, try to resolve agent display names from commission simulation breakdowns
  useEffect(() => {
    if (!useWizard) return;
    const ids = new Set<string>();
    // Include the selling agent so the step-4 header shows their name even
    // when no breakdown has loaded yet (e.g. modal launched from
    // AgentCommissions with a prefilled agentId).
    if (agentId) ids.add(agentId);
    Object.values(simulationResults || {}).forEach((sim) => {
      (sim?.breakdown?.agents || []).forEach((a: any) => {
        if (a?.agentId) ids.add(a.agentId);
      });
    });
    if (ids.size === 0) return;

    let cancelled = false;
    const hydrate = async () => {
      const next = new Map(wizardAgentNames);
      for (const id of ids) {
        if (next.has(id)) continue;
        const fromOptions = agentOptions.find((a) => a.value === id)?.label;
        if (fromOptions) {
          next.set(id, fromOptions);
          continue;
        }
        try {
          const resp: any = await apiService.get(`/api/tenant-admin/agents/${id}`);
          if (resp?.success && resp.data) {
            const a = resp.data;
            const name = a.Name || `${a.FirstName || ''} ${a.LastName || ''}`.trim();
            if (name) next.set(id, name);
          }
        } catch {
          // ignore (may 403 for AgencyOwner)
        }
      }
      if (!cancelled) setWizardAgentNames(next);
    };
    hydrate();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simulationResults, agentId]);

  // (CommissionLevels are loaded via useCommissionLevels() above.)

  // Resolve agency names for any AgencyId that appears in breakdown.tenants[].
  useEffect(() => {
    if (!useWizard) return;
    const ids = new Set<string>();
    Object.values(simulationResults || {}).forEach((sim) => {
      (sim?.breakdown?.tenants || []).forEach((t: any) => {
        if (t?.tenantId && (t.entityType === 'Agency' || t.isPrimaryAgency)) {
          ids.add(t.tenantId);
        }
      });
    });
    if (ids.size === 0) return;

    let cancelled = false;
    const hydrate = async () => {
      const next = new Map(wizardAgencyNames);
      for (const id of ids) {
        if (next.has(id)) continue;
        try {
          const resp = await TenantAdminAgentsService.getAgencyDetails(id);
          if (resp?.success && resp.data) {
            const ag = resp.data as any;
            const name = ag.AgencyName || ag.Name;
            if (name) next.set(id, String(name));
          }
        } catch {
          // ignore — UI falls back to "Unknown agency".
        }
      }
      if (!cancelled) setWizardAgencyNames(next);
    };
    hydrate();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simulationResults]);

  // Load tenants for SysAdmin
  useEffect(() => {
    if (isSysAdmin) {
      loadTenants();
      fetchMissingCommissionsCount();
    }
    // For Agent role in wizard mode, auto-load their agent profile for Step 1
    if (useWizard && isAgent && user?.userId && !agentId) {
      loadAgentSelf();
    }
    // If initialAgentId is provided, set it
    if (initialAgentId && !agentId) {
      setAgentId(initialAgentId);
    }
    // If initialTenantId is provided, set it
    if (initialTenantId && !tenantId) {
      setTenantId(initialTenantId);
    }
  }, [isSysAdmin, initialAgentId, initialTenantId]);

  // Fetch missing commissions count (SysAdmin only)
  const fetchMissingCommissionsCount = async () => {
    if (!isSysAdmin) return;
    
    setLoadingMissingCount(true);
    try {
      const response = await apiService.get<{ success: boolean; missingCount: number; message?: string }>('/api/commissions/missing');
      if (response.success) {
        setMissingCommissionsCount(response.missingCount);
      }
    } catch (error: any) {
      console.error('Failed to fetch missing commissions count:', error);
      setMissingCommissionsCount(null);
    } finally {
      setLoadingMissingCount(false);
    }
  };

  // Generate missing commissions (SysAdmin only)
  const handleGenerateMissing = async () => {
    if (!isSysAdmin || !missingCommissionsCount || missingCommissionsCount === 0) {
      return;
    }

    // Confirmation dialog
    const confirmed = window.confirm(
      `This will generate commissions for ${missingCommissionsCount} payment(s) that are missing commission rows. This uses the same logic as the commission trigger and may take a few moments. Continue?`
    );

    if (!confirmed) return;

    try {
      setGeneratingMissing(true);
      const response = await apiService.post<{
        success: boolean;
        processed: number;
        created: number;
        failed: number;
        message?: string;
        errors?: Array<{ paymentId: string; error: string }>;
      }>('/api/commissions/generate-missing', {});

      if (response.success) {
        const message = `Successfully generated ${response.created} commission row(s) for ${response.processed} payment(s).${response.failed > 0 ? ` ${response.failed} payment(s) failed.` : ''}`;
        alert(message);
        setMissingCommissionsCount(0); // Reset count after successful generation
      } else {
        alert(`Error: ${response.message || 'Failed to generate commissions'}`);
      }
    } catch (error: any) {
      alert(`Failed to generate commissions: ${error.message || 'Unknown error'}`);
    } finally {
      setGeneratingMissing(false);
    }
  };

  // Load agents when tenant changes (SysAdmin) or on mount (TenantAdmin)
  useEffect(() => {
    if (useWizard) return;
    // Prevent loading if already loading
    if (loadingAgents) return;
    
    if (isSysAdmin && tenantId) {
      // Check if we've already loaded for this tenant
      if (agentsLoadedRef.current.tenantId === tenantId && agentsLoadedRef.current.role === 'SysAdmin') {
        return;
      }
      loadAgents(tenantId);
      agentsLoadedRef.current = { tenantId, role: 'SysAdmin' };
    } else if (isTenantAdmin) {
      // Check if we've already loaded for TenantAdmin
      if (agentsLoadedRef.current.role === 'TenantAdmin') {
        return;
      }
      loadAgents(); // Uses user's tenantId
      agentsLoadedRef.current = { role: 'TenantAdmin' };
    } else if (isAgent && user?.userId && !agentId) {
      // For Agent role, auto-set their agentId (only if not already set)
      if (agentsLoadedRef.current.role === 'Agent') {
        return;
      }
      loadAgentSelf();
      agentsLoadedRef.current = { role: 'Agent' };
    }
  }, [tenantId, isSysAdmin, isTenantAdmin, isAgent, user?.userId, agentId]);

  // Load products when tenant changes (SysAdmin) or on mount (TenantAdmin/Agent)
  useEffect(() => {
    if (useWizard) return;
    if (loadingProducts) return;
    
    if (isSysAdmin && tenantId) {
      if (productsLoadedRef.current.tenantId === tenantId && productsLoadedRef.current.role === 'SysAdmin') {
        return;
      }
      loadProducts(tenantId);
      productsLoadedRef.current = { tenantId, role: 'SysAdmin' };
    } else if (isTenantAdmin) {
      if (productsLoadedRef.current.role === 'TenantAdmin') {
        return;
      }
      loadProducts();
      productsLoadedRef.current = { role: 'TenantAdmin' };
    } else if (isAgent) {
      if (productsLoadedRef.current.role === 'Agent') {
        return;
      }
      loadProducts();
      productsLoadedRef.current = { role: 'Agent' };
    }
  }, [tenantId, isSysAdmin, isTenantAdmin, isAgent]);

  // Load rules when tenant changes (SysAdmin) or on mount (TenantAdmin/Agent)
  useEffect(() => {
    if (useWizard) return;
    // Prevent loading if already loading
    if (loadingRules) return;
    
    if (isSysAdmin && tenantId) {
      // Check if we've already loaded for this tenant
      if (rulesLoadedRef.current.tenantId === tenantId && rulesLoadedRef.current.role === 'SysAdmin') {
        return;
      }
      loadRules(tenantId);
      rulesLoadedRef.current = { tenantId, role: 'SysAdmin' };
    } else if (isTenantAdmin || isAgent) {
      // Check if we've already loaded for TenantAdmin/Agent
      const roleKey = isTenantAdmin ? 'TenantAdmin' : 'Agent';
      if (rulesLoadedRef.current.role === roleKey) {
        return;
      }
      loadRules(undefined); // Don't pass tenantId for TenantAdmin/Agent - backend uses req.user.TenantId
      rulesLoadedRef.current = { role: roleKey };
    }
  }, [tenantId, isSysAdmin, isTenantAdmin, isAgent]);

  // When agent is selected and rules are loaded, auto-select their commission rule
  useEffect(() => {
    if (useWizard) return;
    if (agentId && ruleOptions.length > 0) {
      // Only auto-select if no rule is currently selected (to avoid overwriting user selection)
      if (!commissionRuleId) {
        loadAgentCommissionRule(agentId);
      } else {
        // If a rule is already selected, update its status if it's in the options
        const selectedRule = ruleOptions.find(r => r.value === commissionRuleId);
        if (selectedRule) {
          setSelectedRuleStatus(selectedRule.ruleStatus || null);
        }
      }
    }
  }, [agentId, ruleOptions.length, commissionRuleId]);

  const loadTenants = async () => {
    setLoadingTenants(true);
    try {
      const response = await apiService.get('/api/tenants?status=Active') as any;
      if (response.success && response.data) {
        setTenantOptions(
          response.data.map((t: any) => ({
            id: t.TenantId || t.tenantId,
            label: t.Name || t.name,
            value: t.TenantId || t.tenantId
          }))
        );
      }
    } catch (err: any) {
      console.error('Error loading tenants:', err);
      setError('Failed to load tenants');
    } finally {
      setLoadingTenants(false);
    }
  };

  const loadProducts = async (filterTenantId?: string) => {
    setLoadingProducts(true);
    try {
      if (!user?.currentRole) {
        setProductOptions([]);
        setWizardProducts([]);
        return;
      }
      
      let endpoint = '';
      if (isSysAdmin && filterTenantId) {
        endpoint = `/api/tenants/${filterTenantId}/products`;
      } else if (isTenantAdmin) {
        endpoint = '/api/tenant/products';
      } else if (isAgent || isAgencyOwner) {
        endpoint = '/api/me/agent/products';
      } else {
        setProductOptions([]);
        setWizardProducts([]);
        return;
      }
      
      const response: any = await apiService.get(endpoint);
      
      let productData: any[] = [];
      if (response.success && response.data) {
        productData = response.data;
      } else if (Array.isArray(response)) {
        productData = response;
      } else if (response.data) {
        productData = Array.isArray(response.data) ? response.data : [];
      }
      
      // Filter active products only, exclude hidden products
      const activeProducts = productData.filter((p: any) => {
        const status = p.status ?? p.Status;
        const hidden = p.isHidden ?? p.IsHidden;
        const isHidden = hidden === true || hidden === 1;
        return status === 'Active' && !isHidden;
      });
      
      const options = activeProducts.map((p: any) => ({
        id: p.ProductId || p.productId,
        label: p.Name || p.ProductName || p.name || 'Unknown Product',
        value: p.ProductId || p.productId
      }));
      
      setProductOptions(options);

      const bundleAllowedByProductId = new Map<string, string[]>();
      const bundleItems = activeProducts.filter(
        (p: any) => p.IsBundle === true || p.IsBundle === 1 || p.isBundle === true || p.isBundle === 1
      );
      await Promise.all(
        bundleItems.map(async (p: any) => {
          const pid = p.ProductId || p.productId;
          if (!pid) return;
          try {
            const bundleResp: any = await apiService.get(`/api/products/${pid}/bundle-products`);
            const includedList = bundleResp?.success && Array.isArray(bundleResp.data) ? bundleResp.data : [];
            for (const included of includedList) {
              if (!productHasConfigurableFields(included)) continue;
              const allowedValues = extractBundleAllowedConfigValues(
                included.AllowedConfigOptions || included.allowedConfigOptions
              );
              if (allowedValues && allowedValues.length > 0) {
                bundleAllowedByProductId.set(pid, allowedValues);
                break;
              }
            }
          } catch {
            // ignore — simulator still works with unfiltered pricing options
          }
        })
      );

      // Wizard-friendly metadata
      setWizardProducts(
        activeProducts.map((p: any) => {
          const id = p.ProductId || p.productId;
          return {
            id,
            name: p.Name || p.ProductName || p.name || 'Unknown Product',
            salesType: (p.SalesType || p.salesType || 'Both') as any,
            isBundle: (p.IsBundle === true || p.IsBundle === 1 || p.isBundle === true || p.isBundle === 1) as boolean,
            bundleAllowedConfigValues: bundleAllowedByProductId.get(id) ?? null,
          };
        })
      );
    } catch (err: any) {
      console.error('Error loading products:', err);
      setProductOptions([]);
      setWizardProducts([]);
    } finally {
      setLoadingProducts(false);
    }
  };

  const loadRules = async (filterTenantId?: string) => {
    setLoadingRules(true);
    try {
      const response = await commissionService.getSimulationRules(filterTenantId);
      console.log('📋 Rules response:', { success: response.success, rulesCount: response.rules?.length, filterTenantId });
      if (response.success && response.rules) {
        const options = response.rules.map((r: any) => {
          const isLocked = r.Locked === true || r.Locked === 1;
          const statusText = isLocked ? '' : ' ⚠️ Not Active';
          const ruleId = r.RuleId || r.ruleId;
          return {
            id: ruleId,
            label: `${r.RuleName || r.ruleName} (${r.CommissionType || r.commissionType})${statusText}`,
            value: ruleId,
            locked: isLocked,
            ruleStatus: r.RuleStatus || (isLocked ? 'Active' : 'Not Active (Unlocked)'),
            commissionJson: r.CommissionJson || r.commissionJson,
            commissionType: r.CommissionType || r.commissionType
          };
        });
        
        // Store full rule data in a map for easy lookup
        // Normalize ruleId to string to ensure consistent lookups
        const ruleMap = new Map<string, { commissionJson?: string; commissionType?: string }>();
        response.rules.forEach((r: any) => {
          const ruleId = (r.RuleId || r.ruleId)?.toString();
          if (ruleId) {
            ruleMap.set(ruleId, {
              commissionJson: r.CommissionJson || r.commissionJson,
              commissionType: r.CommissionType || r.commissionType
            });
          }
        });
        setRuleDataMap(ruleMap);
        
        console.log('📋 Setting rule options:', options.length);
        setRuleOptions(options);
      } else {
        console.warn('📋 No rules returned or response not successful:', response);
        setRuleOptions([]);
      }
    } catch (err: any) {
      console.error('Error loading rules:', err);
      setError('Failed to load commission rules');
      setRuleOptions([]);
    } finally {
      setLoadingRules(false);
    }
  };

  const loadAgents = async (filterTenantId?: string) => {
    setLoadingAgents(true);
    try {
      // getTenantAgents automatically filters by user's tenant for TenantAdmin
      // For SysAdmin, we need to pass tenantId if provided
      const response = await TenantAdminService.getTenantAgents({
        status: 'Active',
        type: 'Agent',
        search: '',
        limit: 100,
        ...(filterTenantId && { tenantId: filterTenantId }) // For SysAdmin
      });
      
      if (response.success && response.data) {
        const options = response.data.map((agent: any) => {
          const name = agent.Name || `${agent.FirstName || ''} ${agent.LastName || ''}`.trim();
          const tier =
            agent.CommissionTierLevel ??
            agent.commissionTierLevel ??
            null;
          return {
            id: agent.Id || agent.AgentId,
            label: formatAgentLabel(name, tier),
            value: agent.Id || agent.AgentId,
            email: agent.Email,
            code: agent.AgencyName || agent.agencyName || undefined
          };
        });
        setAgentOptions(options);
      }
    } catch (err: any) {
      console.error('Error loading agents:', err);
      setError('Failed to load agents');
    } finally {
      setLoadingAgents(false);
    }
  };

  const loadAgentSelf = async () => {
    setLoadingAgents(true);
    try {
      // For Agent role, get their own agent profile
      const response = await apiService.get('/api/me/agent') as any;
      if (response.success && response.data) {
        const agent = response.data;
        if (agent.AgentId) {
          setAgentId(agent.AgentId);
          setAgentOptions([{
            id: agent.AgentId,
            label: formatAgentLabel(
              `${agent.FirstName || ''} ${agent.LastName || ''}`.trim() || 'Me',
              agent.CommissionTierLevel ?? agent.commissionTierLevel ?? null
            ),
            value: agent.AgentId,
            email: agent.Email
          }]);
          // Load their assigned commission rule and groups
          await loadAgentCommissionRule(agent.AgentId);
          await loadGroupsForAgent(agent.AgentId);
        }
      }
    } catch (err: any) {
      console.error('Error loading agent profile:', err);
      setError('Failed to load agent profile');
    } finally {
      setLoadingAgents(false);
    }
  };

  const handleAgentSearch = async (query: string) => {
    // Empty query means load all (initial load handled by loadAgents)
    if (query.length === 0) {
      // Don't reload if we already have options and we're not searching
      if (agentOptions.length > 0) return;
      
      if (isSysAdmin && tenantId) {
        loadAgents(tenantId);
      } else if (isTenantAdmin) {
        loadAgents();
      }
      return;
    }
    
    // Minimum 2 characters for search
    if (query.length < 2) return;
    
    // Prevent concurrent searches
    if (loadingAgents) return;
    
    setLoadingAgents(true);
    try {
      // getTenantAgents automatically filters by user's tenant for TenantAdmin
      // For SysAdmin, we need to pass tenantId
      const response = await TenantAdminService.getTenantAgents({
        status: 'Active',
        type: 'Agent',
        search: query,
        limit: 50,
        ...(isSysAdmin && tenantId && { tenantId: tenantId })
      });
      
      if (response.success && response.data) {
        const options = response.data.map((agent: any) => {
          const name = agent.Name || `${agent.FirstName || ''} ${agent.LastName || ''}`.trim();
          const tier =
            agent.CommissionTierLevel ??
            agent.commissionTierLevel ??
            null;
          return {
            id: agent.Id || agent.AgentId,
            label: formatAgentLabel(name, tier),
            value: agent.Id || agent.AgentId,
            email: agent.Email,
            code: agent.AgencyName || agent.agencyName || undefined
          };
        });
        setAgentOptions(options);
      }
    } catch (err: any) {
      console.error('Error searching agents:', err);
    } finally {
      setLoadingAgents(false);
    }
  };

  const loadAgentCommissionRule = async (selectedAgentId: string) => {
    try {
      const response = await apiService.get(`/api/tenant-admin/agents/${selectedAgentId}/commission-rule`) as any;
      if (response.success && response.data?.RuleId) {
        const ruleId = response.data.RuleId;
        // Set the commission rule ID - it will be available in the dropdown once rules are loaded
        setCommissionRuleId(ruleId);
        setAgentActualRuleId(ruleId); // Store the agent's actual assigned rule
        // Try to find the rule in current options to set status
        const selectedRule = ruleOptions.find(r => r.value === ruleId);
        if (selectedRule) {
          setSelectedRuleStatus(selectedRule.ruleStatus || null);
        }
      } else if (response.success && !response.data?.RuleId) {
        // Agent has no assigned rule
        setCommissionRuleId('');
        setAgentActualRuleId(null);
        setSelectedRuleStatus(null);
      }
    } catch (err: any) {
      console.error('Error loading agent commission rule:', err);
      // Don't set error state here - just log it
    }
  };

  const loadGroupsForAgent = async (selectedAgentId: string) => {
    if (!selectedAgentId) {
      setGroupOptions([]);
      return;
    }

    setLoadingGroups(true);
    try {
      // Use /api/groups?agentId=xxx endpoint to get groups for the selected agent
      console.log('🔍 Loading groups for agent:', selectedAgentId);
      const response = await apiService.get(`/api/groups?agentId=${selectedAgentId}`) as any;
      console.log('🔍 Groups response:', response);
      if (response.success && response.data) {
        const options = response.data
          .filter((g: any) => g.Status === 'Active')
          .map((g: any) => ({
            id: g.GroupId || g.groupId,
            label: g.Name || g.name || 'Unknown Group',
            value: g.GroupId || g.groupId
          }));
        console.log('🔍 Group options:', options);
        setGroupOptions(options);
      } else {
        console.log('🔍 No groups found or invalid response:', response);
        setGroupOptions([]);
      }
    } catch (err: any) {
      console.error('Error loading groups for agent:', err);
      setGroupOptions([]);
    } finally {
      setLoadingGroups(false);
    }
  };

  const handleSimulate = async () => {
    setError(null);
    setResult(null);
    
    // Validation
    if (isSysAdmin && !tenantId) {
      setError('Please select a tenant');
      return;
    }
    
    if (!agentId) {
      setError('Please select an agent');
      return;
    }
    
    // Commission Groups mode: simulation uses the resolved Commission Group (agent -> upline -> agency).
    
    if (!allocatedCommissionAmount || parseFloat(allocatedCommissionAmount) <= 0) {
      setError('Please enter a valid commission amount');
      return;
    }

    setSimulating(true);
    try {
      const params: any = {
        allocatedCommissionAmount: parseFloat(allocatedCommissionAmount),
        agentId: agentId, // Required for all simulations
      };

      if (isSysAdmin) {
        params.tenantId = tenantId;
      }
      
      // Commission Groups mode: do not send commissionRuleId (deprecated).
      
      // Send first selected product ID if any products are selected
      // Backend currently supports single productId, but we allow multi-select for future support
      if (selectedProductIds.length > 0) {
        params.productId = selectedProductIds[0];
        // If multiple products selected, we could send as array in future
        // For now, just use the first one
      }
      
      if (paymentDate) {
        params.paymentDate = paymentDate;
      }
      
      // Include unlocked rules based on checkbox
      params.allowUnlockedRules = includeUnlockedRules;
      
      // Include product tier if selected
      if (productTier) {
        params.productTier = productTier;
      }
      
      // Include group ID if selected (for testing split commission rules)
      if (groupId) {
        params.groupId = groupId;
      }

      const response = await commissionService.simulateCommissionDetailed(params);
      
      if (response.success && response.simulation) {
        setResult(response.simulation);
      } else {
        setError(response.message || 'Simulation failed');
      }
    } catch (err: any) {
      console.error('Error simulating commission:', err);
      setError(err.response?.data?.message || err.message || 'Failed to simulate commission');
    } finally {
      setSimulating(false);
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
  };

  // Load all unique agent IDs from breakdown to get their names
  const [allAgentNames, setAllAgentNames] = useState<Map<string, string>>(new Map());
  
  useEffect(() => {
    if (result && result.breakdown) {
      const breakdown = result.breakdown as any || {};
      const agents = (breakdown.agents || []) as any[];
      const uniqueAgentIds = new Set<string>();
      
      // Collect all unique agent IDs from breakdown
      agents.forEach((agent: any) => {
        if (agent.agentId) uniqueAgentIds.add(agent.agentId);
      });
      
      // Load agent names for all agents in breakdown
      const loadAgentNames = async () => {
        const agentNameMap = new Map<string, string>();
        
        // Start with agents we already have in agentOptions
        agentOptions.forEach(opt => {
          if (opt.value) agentNameMap.set(opt.value, opt.label);
        });
        
        // Load names for agents not in agentOptions
        const agentsToLoad = Array.from(uniqueAgentIds).filter(id => !agentNameMap.has(id));
        
        if (agentsToLoad.length > 0) {
          try {
            // Load agent names in batches
            for (const agentId of agentsToLoad) {
              try {
                const response = await apiService.get(`/api/tenant-admin/agents/${agentId}`) as any;
                if (response.success && response.data) {
                  const agent = response.data;
                  const name = agent.Name || `${agent.FirstName || ''} ${agent.LastName || ''}`.trim() || `Agent ${agentId.substring(0, 8)}`;
                  agentNameMap.set(agentId, name);
                }
              } catch (err) {
                // If agent not found, use ID
                agentNameMap.set(agentId, `Agent ${agentId.substring(0, 8)}`);
              }
            }
          } catch (err) {
            console.error('Error loading agent names:', err);
          }
        }
        
        setAllAgentNames(agentNameMap);
      };
      
      loadAgentNames();
    }
  }, [result, agentOptions]);

  // Helper function to get tier rate from CommissionJson
  // If productTier is specified, returns the product tier-specific rate/amount
  const getTierRate = (ruleId: string, tierLevel: number, productTierCode?: string): string | null => {
    if (!ruleId) return null;
    
    // Try to find rule in ruleDataMap (normalize ruleId to string for comparison)
    const normalizedRuleId = ruleId.toString();
    let ruleData = ruleDataMap.get(normalizedRuleId);
    
    // If not found, try to find in ruleOptions as fallback
    if (!ruleData) {
      const ruleOption = ruleOptions.find(r => r.value === normalizedRuleId || r.id === normalizedRuleId);
      if (ruleOption && ruleOption.commissionJson) {
        ruleData = {
          commissionJson: ruleOption.commissionJson,
          commissionType: ruleOption.commissionType
        };
      }
    }
    
    if (!ruleData || !ruleData.commissionJson) {
      console.warn('Rule data not found for ruleId:', normalizedRuleId, 'Available ruleIds:', Array.from(ruleDataMap.keys()));
      return null;
    }
    
    try {
      const commissionConfig = typeof ruleData.commissionJson === 'string'
        ? JSON.parse(ruleData.commissionJson)
        : ruleData.commissionJson;
      
      if (commissionConfig.tiers && Array.isArray(commissionConfig.tiers)) {
        const tier = commissionConfig.tiers.find((t: any) => {
          const tLevel = t.tierLevel !== undefined ? t.tierLevel : (t.level !== undefined ? t.level : 0);
          return tLevel === tierLevel;
        });
        
        if (tier) {
          const tierType = commissionConfig.type || 'percentage';
          
          // Check for product tier-specific rate/amount first
          if (productTierCode && tier.productTiers && tier.productTiers[productTierCode]) {
            const productTierConfig = tier.productTiers[productTierCode];
            if (tierType === 'percentage' && productTierConfig.rate !== undefined) {
              const rate = productTierConfig.rate > 1 ? productTierConfig.rate : productTierConfig.rate * 100;
              return `${productTierCode}: ${rate.toFixed(1)}%`;
            } else if (tierType === 'flatrate' && productTierConfig.flatAmount !== undefined) {
              return `${productTierCode}: $${productTierConfig.flatAmount.toFixed(2)}`;
            }
          }
          
          // Fallback to base tier rate/amount
          if (tierType === 'percentage') {
            const rate = tier.rate !== undefined ? tier.rate : tier.percentage;
            if (rate !== undefined) {
              // Convert to percentage if it's a decimal (0.25 -> 25%)
              const percentage = rate > 1 ? rate : rate * 100;
              return `${percentage.toFixed(1)}%`;
            }
          } else if (tierType === 'flatrate') {
            const flatAmount = tier.flatAmount;
            if (flatAmount !== undefined) {
              return `Flat $${flatAmount.toFixed(2)}`;
            }
          }
        } else {
          console.warn('Tier level not found:', { ruleId: normalizedRuleId, tierLevel, availableTiers: commissionConfig.tiers });
        }
      } else {
        console.warn('No tiers array in CommissionJson:', { ruleId: normalizedRuleId, commissionConfig });
      }
    } catch (error) {
      console.error('Error parsing CommissionJson for tier rate:', error, { ruleId: normalizedRuleId, commissionJson: ruleData.commissionJson });
    }
    
    return null;
  };

  // Organize breakdown by processing steps in order
  const organizeBreakdown = () => {
    if (!result || !result.breakdown) {
      console.warn('No breakdown in result:', result);
      return null;
    }

    // Ensure breakdown has all required arrays
    const breakdown = (result.breakdown || {}) as any;
    const agents = (breakdown.agents || []) as any[];
    const tenants = (breakdown.tenants || []) as any[];

    // Step 1: Commission Overrides (EntityType = 'Override')
    const commissionOverrides = agents.filter((a: any) => a.isOverride);
    
    // Group overrides by rule
    const overrideGroups = new Map<string, typeof commissionOverrides>();
    commissionOverrides.forEach((override: any) => {
      const key = override.ruleId || 'unknown';
      if (!overrideGroups.has(key)) {
        overrideGroups.set(key, []);
      }
      overrideGroups.get(key)!.push(override);
    });

    // Step 2: Agent-Specific Rule (the agent's default rule)
    const nonOverrideNonSplit = agents.filter(
      (a: any) => !a.isOverride && !a.isSplitPartner && !a.splitAmount
    );
    
    let agentSpecific: typeof agents = [];
    let regularRules: typeof agents = [];
    
    if (result.agentActualRuleId) {
      agentSpecific = nonOverrideNonSplit.filter(
        (a: any) => a.ruleId === result.agentActualRuleId
      );
      regularRules = nonOverrideNonSplit.filter(
        (a: any) => a.ruleId !== result.agentActualRuleId
      );
    } else {
      regularRules = nonOverrideNonSplit;
    }

    // Group agent-specific by rule and tier level
    const agentSpecificGroups = new Map<string, Map<number, typeof agentSpecific>>();
    agentSpecific.forEach((agent: any) => {
      const ruleKey = agent.ruleId || 'unknown';
      if (!agentSpecificGroups.has(ruleKey)) {
        agentSpecificGroups.set(ruleKey, new Map());
      }
      const tierMap = agentSpecificGroups.get(ruleKey)!;
      const tierLevel = agent.tierLevel ?? 0;
      if (!tierMap.has(tierLevel)) {
        tierMap.set(tierLevel, []);
      }
      tierMap.get(tierLevel)!.push(agent);
    });

    // Step 3: Regular Rules (grouped by rule, then by tier level for tiered rules)
    const regularRuleGroups = new Map<string, Map<number, typeof regularRules>>();
    regularRules.forEach((agent: any) => {
      const ruleKey = agent.ruleId || 'unknown';
      if (!regularRuleGroups.has(ruleKey)) {
        regularRuleGroups.set(ruleKey, new Map());
      }
      const tierMap = regularRuleGroups.get(ruleKey)!;
      const tierLevel = agent.tierLevel ?? 0;
      if (!tierMap.has(tierLevel)) {
        tierMap.set(tierLevel, []);
      }
      tierMap.get(tierLevel)!.push(agent);
    });

    // Step 4: Split Rules
    // Include both split partners and primary agents in splits (isPrimaryInSplit)
    const splitRules = agents.filter((a: any) => a.isSplitPartner || a.splitAmount || a.isPrimaryInSplit);
    const splitGroups = new Map<string, typeof splitRules>();
    splitRules.forEach((split: any) => {
      const key = split.ruleId || split.splitRuleId || 'unknown';
      if (!splitGroups.has(key)) {
        splitGroups.set(key, []);
      }
      splitGroups.get(key)!.push(split);
    });
    
    // Also include primary agents that had splits applied to them
    // They should show their reduced amount and indicate the split
    agents.forEach((agent: any) => {
      if (agent.isPrimaryInSplit && agent.splitAmount) {
        const key = agent.splitRuleId || agent.ruleId || 'unknown';
        if (!splitGroups.has(key)) {
          splitGroups.set(key, []);
        }
        // Check if this agent is already in the split group
        const existing = splitGroups.get(key)!.find((a: any) => a.agentId === agent.agentId);
        if (!existing) {
          splitGroups.get(key)!.push(agent);
        }
      }
    });

    // Step 5: Excess/Overflow (primary-agency excess only)
    const excess = tenants.filter((t: any) => t.isExcess);
    // Step 5b: Tier-slot agency payouts
    const agencyTierSlots = tenants.filter(
      (t: any) => t.entityType === 'Agency' && !t.isExcess && !t.isOverride
    );

    return {
      commissionOverrides: Array.from(overrideGroups.entries()),
      agentSpecific: Array.from(agentSpecificGroups.entries()),
      regularRules: Array.from(regularRuleGroups.entries()),
      splitRules: Array.from(splitGroups.entries()),
      excess,
      agencyTierSlots,
      remainingAmount: result.remainingAmount || 0
    };
  };

  const breakdownSteps = organizeBreakdown();

  // ===========================
  // Wizard UI (step-by-step)
  // ===========================
  if (useWizard) {
    const ageOptions = Array.from({ length: 47 }, (_, i) => 18 + i); // 18..64
    const householdCriteria = {
      tier: wizardTier,
      age: wizardAge,
      tobaccoUse: wizardTobaccoUse,
      householdSize: wizardTier === 'EE' ? 1 : wizardTier === 'ES' ? 2 : wizardTier === 'EC' ? 2 : 3,
    };

    const searchQ = wizardProductSearch.trim().toLowerCase();
    const filteredProducts = searchQ
      ? wizardProducts.filter((p) => p.name.toLowerCase().includes(searchQ))
      : wizardProducts;

    const groupProducts = filteredProducts.filter((p) => {
      const st = (p.salesType ?? 'Both').toString();
      return st === 'Group' || st === 'Both';
    });
    const individualProducts = filteredProducts.filter((p) => {
      const st = (p.salesType ?? 'Both').toString();
      return st === 'Individual' || st === 'Both';
    });

    const buildWizardProductSelections = () => {
      return selectedProductIds.map((productId) => {
        const selectedConfig = wizardConfigByProductId[productId];
        return {
          productId,
          configValues: selectedConfig ? { configValue1: selectedConfig } : {},
        };
      });
    };

    const canNext = () => {
      if (wizardStep === 1) {
        if (isSysAdmin && !tenantId) return false;
        if (!agentId) return false;
        return true;
      }
      if (wizardStep === 2) return true;
      if (wizardStep === 3) return selectedProductIds.length > 0;
      return false;
    };

    const onNext = async () => {
      setWizardError(null);

      if (!canNext()) {
        setWizardError('Please complete the required fields before continuing.');
        return;
      }

      if (wizardStep === 2) {
        // entering Step 3 - ensure products loaded
        if (wizardProducts.length === 0 && !loadingProducts) {
          await loadProducts(isSysAdmin ? tenantId : undefined);
        }
      }

      setWizardStep((s) => ((s + 1) as WizardStep));
    };

    const onBack = () => {
      setWizardError(null);
      setWizardStep((s) => ((s - 1) as WizardStep));
    };

    const loadAgencyOwnerAgents = async () => {
      setLoadingAgents(true);
      try {
        const response: any = await apiService.get('/api/me/agent/agents');
        const rows = Array.isArray(response?.data) ? response.data : Array.isArray(response?.data?.data) ? response.data.data : [];
        const options = rows
          .filter((r: any) => r.Type === 'Agent')
          .map((a: any) => {
            const name = a.Name || `${a.FirstName || ''} ${a.LastName || ''}`.trim();
            const tier =
              a.CommissionTierLevel ??
              a.commissionTierLevel ??
              null;
            return {
              id: a.Id || a.AgentId,
              label: formatAgentLabel(name, tier),
              value: a.Id || a.AgentId,
              email: a.Email,
              code: a.AgencyName || a.agencyName || undefined,
            };
          });
        setAgentOptions(options);
      } catch (e: any) {
        console.error('Failed to load AgencyOwner agents:', e);
        setAgentOptions([]);
      } finally {
        setLoadingAgents(false);
      }
    };

    const handleWizardAgentSearch = async (query: string) => {
      if (isAgent) return;
      if (isSysAdmin && !tenantId) return;

      if (isAgencyOwner) {
        // No backend search right now; load all (SearchableDropdown client-filters when useBackendSearch=false)
        if (agentOptions.length === 0 && !loadingAgents) {
          await loadAgencyOwnerAgents();
        }
        return;
      }

      // backend search requires >=2 chars, but initial '' load is valid
      if (query.length > 0 && query.length < 2) return;
      if (loadingAgents) return;

      setLoadingAgents(true);
      try {
        const response = await TenantAdminService.getTenantAgents({
          status: 'Active',
          type: 'Agent',
          search: query,
          limit: 50,
          ...(isSysAdmin && tenantId ? { tenantId } : {}),
        });

        if (response.success && response.data) {
          const options = response.data.map((agent: any) => {
            const name = agent.Name || `${agent.FirstName || ''} ${agent.LastName || ''}`.trim();
            const tier =
              agent.CommissionTierLevel ??
              agent.commissionTierLevel ??
              null;
            return {
              id: agent.Id || agent.AgentId,
              label: formatAgentLabel(name, tier),
              value: agent.Id || agent.AgentId,
              email: agent.Email,
              code: agent.AgencyName || agent.agencyName || undefined,
            };
          });
          setAgentOptions(options);
        } else {
          setAgentOptions([]);
        }
      } catch (e: any) {
        console.error('Failed to search agents:', e);
      } finally {
        setLoadingAgents(false);
      }
    };

    const handleWizardPreviewPricing = async () => {
      setWizardError(null);
      setPricingPreviewLoading(true);
      setPricingPreview(null);
      try {
        const res = await PricingService.calculatePricing({
          calculationType: 'enrollment',
          memberCriteria: householdCriteria as any,
          productSelections: buildWizardProductSelections() as any,
          effectiveDate: paymentDate,
        } as any);
        setPricingPreview(res);
      } catch (e: any) {
        console.error('Pricing preview failed:', e);
        setWizardError(e?.message || 'Failed to load configuration options');
      } finally {
        setPricingPreviewLoading(false);
      }
    };

    const configSignature = selectedProductIds
      .map((id) => `${id}:${wizardConfigByProductId[id] || ''}`)
      .sort()
      .join('|');

    const calcSignature = [
      `tenant:${tenantId || ''}`,
      `agent:${agentId || ''}`,
      `date:${paymentDate || ''}`,
      `tier:${wizardTier}`,
      `age:${wizardAge}`,
      `tobacco:${wizardTobaccoUse}`,
      `products:${selectedProductIds.slice().sort().join(',')}`,
      `configs:${configSignature}`,
      `unlocked:${wizardIncludeUnlockedRules ? '1' : '0'}`,
    ].join('|');

    // Auto-load pricing preview (debounced) so config options show immediately
    useEffect(() => {
      if (wizardStep !== 3) return;
      if (selectedProductIds.length === 0) {
        setPricingPreview(null);
        return;
      }
      // If products aren't loaded yet, wait
      if (loadingProducts) return;

      const timer = window.setTimeout(() => {
        handleWizardPreviewPricing();
      }, 400);

      return () => window.clearTimeout(timer);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [wizardStep, wizardTier, wizardAge, wizardTobaccoUse, paymentDate, selectedProductIds.join(','), configSignature]);

    // Resolve payout destinations (masked bank info) for Vendor/Overrides tabs
    useEffect(() => {
      if (wizardStep !== 4) return;
      if (!pricingResult) return;
      if (resultsTab === 'agent') return;

      const vendorIds = new Set<string>();
      const overrideAchIds = new Set<string>();

      Object.values(simulationResults || {}).forEach((sim: any) => {
        (sim?.breakdown?.vendors || []).forEach((v: any) => {
          if (v?.vendorId) vendorIds.add(v.vendorId);
        });
        (sim?.breakdown?.tenants || [])
          .filter((t: any) => t?.isOverride)
          .forEach((t: any) => {
            if (t?.overrideAchId) overrideAchIds.add(t.overrideAchId);
          });
      });

      const vArr = Array.from(vendorIds);
      const oArr = Array.from(overrideAchIds).filter(Boolean);

      if (vArr.length === 0 && oArr.length === 0) {
        setPayoutDestinations(null);
        return;
      }

      let cancelled = false;
      const load = async () => {
        try {
          setPayoutDestinationsLoading(true);
          const resp = await commissionService.getPayoutDestinations({
            vendorIds: vArr,
            overrideAchIds: oArr,
          });
          if (!cancelled && resp?.success && resp?.data) {
            setPayoutDestinations(resp.data);
          }
        } catch (e) {
          // Keep UI usable even if destination lookup fails
        } finally {
          if (!cancelled) setPayoutDestinationsLoading(false);
        }
      };
      load();
      return () => {
        cancelled = true;
      };
    }, [wizardStep, resultsTab, pricingResult, Object.keys(simulationResults || {}).length]);

    const getConfigMeta = (productId: string) => {
      const p = (pricingPreview?.products || []).find((x: any) => x.productId === productId);
      if (!p) return null;

      // Only show configuration dropdown if there are REAL config values setup for the product.
      // The pricing engine will fall back `configValue` to "Default" when no ConfigValue1-5 exist,
      // so we must NOT treat "Default" as a real selectable option.
      const normalizedAvailableConfigs = ((p as any).availableConfigs || [])
        .map((v: any) => String(v))
        .map((v: string) => v.trim())
        .filter(Boolean)
        .filter((v: string) => v.toLowerCase() !== 'default');

      const normalizedVariationConfigs = Array.from(
        new Set(
          (p.pricingVariations || [])
            .map((v: any) => String(v.configValue))
            .map((v: string) => v.trim())
            .filter(Boolean)
            .filter((v: string) => v.toLowerCase() !== 'default')
        )
      );

      let options: string[] =
        normalizedAvailableConfigs.length > 0 ? normalizedAvailableConfigs : normalizedVariationConfigs;

      const wizardProduct = wizardProducts.find((w) => w.id === productId);
      const bundleAllowed = wizardProduct?.bundleAllowedConfigValues;
      if (bundleAllowed && bundleAllowed.length > 0 && options.length > 0) {
        const filtered = options.filter((opt) => bundleAllowed.includes(opt));
        if (filtered.length > 0) {
          options = filtered;
        }
      }

      if (!options || options.length === 0) return null;

      const label =
        p.requiredDataFields?.[0]?.fieldName ||
        'Configuration';

      // Default to first real option; ignore backend defaultConfig if it equals "Default"
      const backendDefault =
        typeof (p as any).defaultConfig === 'string' && (p as any).defaultConfig.trim().toLowerCase() !== 'default'
          ? (p as any).defaultConfig.trim()
          : null;
      const defaultValue = wizardConfigByProductId[productId] || backendDefault || options[0];

      return { label, options, defaultValue };
    };

    const handleWizardCalculate = async () => {
      setWizardError(null);
      setPricingLoading(true);
      setSimulationLoading(true);
      setPricingResult(null);
      setSimulationResults({});
      try {
        // Ensure we send explicit config values by defaulting to the first available option
        const selectionsWithDefaults = buildWizardProductSelections().map((sel: any) => {
          if (sel?.configValues && sel.configValues.configValue1) return sel;
          const meta = getConfigMeta(sel.productId);
          if (!meta) return sel;
          return {
            ...sel,
            configValues: { ...(sel.configValues || {}), configValue1: meta.defaultValue },
          };
        });

        const res = await PricingService.calculatePricing({
          calculationType: 'enrollment',
          memberCriteria: householdCriteria as any,
          productSelections: selectionsWithDefaults as any,
          effectiveDate: paymentDate,
        } as any);
        setPricingResult(res);

        // Flatten priced products into commission line items.
        // If a selected product is a bundle, we simulate commission per included product
        // and omit the bundle itself from the final listing.
        const lineItems: Array<{
          lineItemId: string;
          productId: string;
          productName: string;
          monthlyPremium: number;
          vendorCommission: number;
          netRate: number;
          overrideRate: number;
          productPricingId: string | null;
        }> = [];

        (res.products || []).forEach((prod: any) => {
          if (prod?.isBundle && Array.isArray(prod?.includedProducts) && prod.includedProducts.length > 0) {
            prod.includedProducts.forEach((inc: any) => {
              lineItems.push({
                lineItemId: `${prod.productId}::${inc.productId}`,
                productId: inc.productId,
                productName: inc.productName,
                monthlyPremium: Number(inc.monthlyPremium || 0),
                vendorCommission: Number(inc?.pricingDetails?.vendorCommission || 0),
                netRate: Number(inc?.pricingDetails?.netRate || 0),
                overrideRate: Number(inc?.pricingDetails?.overrideRate || 0),
                productPricingId: inc?.pricingDetails?.productPricingId ? String(inc.pricingDetails.productPricingId) : null,
              });
            });
            return;
          }

          lineItems.push({
            lineItemId: prod.productId,
            productId: prod.productId,
            productName: prod.productName,
            monthlyPremium: Number(prod.monthlyPremium || 0),
            vendorCommission: Number(prod?.pricingDetails?.vendorCommission || 0),
            netRate: Number(prod?.pricingDetails?.netRate || 0),
            overrideRate: Number(prod?.pricingDetails?.overrideRate || 0),
            productPricingId: prod?.pricingDetails?.productPricingId ? String(prod.pricingDetails.productPricingId) : null,
          });
        });

        const sims = await Promise.all(
          lineItems.map(async (li) => {
            const commissionBase = Number(li.vendorCommission || 0);
            const params: any = {
              agentId,
              allocatedCommissionAmount: commissionBase,
              vendorCommissionAmount: Number(li.netRate || 0),
              overrideAmount: Number(li.overrideRate || 0),
              productPricingId: li.productPricingId,
              productId: li.productId,
              productTier: wizardTier,
              paymentDate,
            };
            if (isSysAdmin && tenantId) params.tenantId = tenantId;
            params.allowUnlockedRules = wizardIncludeUnlockedRules;
            if (groupId) params.groupId = groupId;

            const simRes = await commissionService.simulateCommissionDetailed(params);
            if (!simRes?.success || !simRes.simulation) {
              throw new Error(simRes?.message || 'Commission simulation failed');
            }
            return [li.lineItemId, simRes.simulation] as const;
          })
        );

        setSimulationResults(Object.fromEntries(sims));
      } catch (e: any) {
        console.error('Wizard calculate failed:', e);
        setWizardError(e?.message || 'Failed to calculate');
      } finally {
        setPricingLoading(false);
        setSimulationLoading(false);
      }
    };

    // Auto-run calculation when arriving at Step 4 (and whenever inputs changed since last auto-run)
    useEffect(() => {
      if (wizardStep !== 4) return;
      if (!agentId) return;
      if (isSysAdmin && !tenantId) return;
      if (selectedProductIds.length === 0) return;
      if (pricingLoading || simulationLoading) return;
      if (lastAutoCalcSignature === calcSignature) return;

      setLastAutoCalcSignature(calcSignature);
      handleWizardCalculate();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [wizardStep, calcSignature]);

    const stepTitles: Record<WizardStep, string> = {
      1: 'Pick your agent',
      2: 'Customize fake household',
      3: 'Pick product(s) being purchased',
      4: 'Calculate and see the breakdown',
    };

    const stepDescriptions: Record<WizardStep, string> = {
      1: '',
      2: 'These criteria determine pricing eligibility and tiers.',
      3: 'Pick group and/or individual products. Hidden products are excluded.',
      4: '',
    };

    const getWizardAgentName = (id: string) => {
      if (!id) return 'Unknown agent';
      return (
        agentOptions.find((a) => a.value === id)?.label ||
        wizardAgentNames.get(id) ||
        `Agent ${id.substring(0, 8)}`
      );
    };

    const formatOverflowLabel = (e: any) => {
      // Backend may send ruleName like: "Primary Agency Excess (MightyWELL Health LLC)"
      // UI requested format:
      // Header: "Primary Agency Overflow"
      // Row: "MightyWELL Health LLC"
      if (e?.isPrimaryAgency && typeof e?.ruleName === 'string') {
        const m = e.ruleName.match(/^Primary Agency Excess \((.+)\)$/);
        if (m?.[1]) return m[1];
      }
      return e?.ruleName || (e?.isPrimaryAgency ? 'Primary agency' : 'Overflow');
    };

    const organizeBreakdownFor = (sim: SimulationResult) => {
      const breakdown = (sim.breakdown || {}) as any;
      const agents = (breakdown.agents || []) as any[];
      const tenants = (breakdown.tenants || []) as any[];
      const ALL_PRODUCTS_ID = '00000000-0000-0000-0000-000000000000';

      // Step 1: Commission Overrides
      const commissionOverrides = agents.filter((a: any) => a.isOverride);
      const overrideGroups = new Map<string, typeof commissionOverrides>();
      commissionOverrides.forEach((override: any) => {
        const key = override.ruleId || 'unknown';
        if (!overrideGroups.has(key)) overrideGroups.set(key, []);
        overrideGroups.get(key)!.push(override);
      });

      // Step 2: Agent-Specific Rule (agentActualRuleId)
      const nonOverrideNonSplit = agents.filter(
        (a: any) => !a.isOverride && !a.isSplitPartner && !a.splitAmount
      );

      let agentSpecific: typeof agents = [];
      let regularRules: typeof agents = [];

      if (sim.agentActualRuleId) {
        agentSpecific = nonOverrideNonSplit.filter((a: any) => a.ruleId === sim.agentActualRuleId);
        regularRules = nonOverrideNonSplit.filter((a: any) => a.ruleId !== sim.agentActualRuleId);
      } else {
        regularRules = nonOverrideNonSplit;
      }

      const groupByRuleThenTier = (rows: any[]) => {
        const ruleGroups = new Map<string, Map<number, any[]>>();
        rows.forEach((row: any) => {
          const ruleKey = row.ruleId || 'unknown';
          if (!ruleGroups.has(ruleKey)) ruleGroups.set(ruleKey, new Map());
          const tierMap = ruleGroups.get(ruleKey)!;
          const tierLevel = row.tierLevel ?? 0;
          if (!tierMap.has(tierLevel)) tierMap.set(tierLevel, []);
          tierMap.get(tierLevel)!.push(row);
        });
        return ruleGroups;
      };

      // Tier-slot agency payouts share the rule with their agent siblings.
      // Splice each agency row into the SAME group that holds its rule's agent
      // rows so they render in one card, in tier order (selling agent -> upline
      // agency). Falls back to the all-products bucket only when no agent
      // sibling for that rule exists in this scenario.
      const tierAgencyRows = tenants
        .filter((t: any) => t.entityType === 'Agency' && !t.isExcess && !t.isOverride && t.ruleId)
        .map((t: any) => ({
          isAgencyRecipient: true,
          agencyId: t.tenantId,
          ruleId: t.ruleId,
          ruleName: t.ruleName,
          tierLevel: t.tierLevel ?? 0,
          amount: t.amount
        }));

      const allProductsRegularRules = regularRules.filter((r: any) => {
        const pid = (r.ruleProductId || r.productId || '').toString().toLowerCase();
        return pid === ALL_PRODUCTS_ID;
      });
      const productSpecificRegularRules = regularRules.filter((r: any) => !allProductsRegularRules.includes(r));

      const agentSpecificRuleIds = new Set(agentSpecific.map((a: any) => a.ruleId).filter(Boolean));
      const allProductsRuleIds = new Set(allProductsRegularRules.map((r: any) => r.ruleId).filter(Boolean));
      const productSpecificRuleIds = new Set(productSpecificRegularRules.map((r: any) => r.ruleId).filter(Boolean));

      const agencyForAgentSpecific = tierAgencyRows.filter((r: any) => agentSpecificRuleIds.has(r.ruleId));
      const agencyForProductSpecific = tierAgencyRows.filter(
        (r: any) => !agentSpecificRuleIds.has(r.ruleId) && productSpecificRuleIds.has(r.ruleId)
      );
      const agencyForAllProducts = tierAgencyRows.filter(
        (r: any) =>
          !agentSpecificRuleIds.has(r.ruleId) &&
          !productSpecificRuleIds.has(r.ruleId)
        // includes orphan rows (no agent sibling at all) — the all-products
        // bucket is the most generic landing spot.
      );

      const agentSpecificGroups = groupByRuleThenTier([...agentSpecific, ...agencyForAgentSpecific]);
      const allProductsRuleGroups = groupByRuleThenTier([
        ...allProductsRegularRules,
        ...agencyForAllProducts.filter((r: any) => allProductsRuleIds.has(r.ruleId))
      ]);
      const regularRuleGroups = groupByRuleThenTier([
        ...productSpecificRegularRules,
        ...agencyForProductSpecific
      ]);
      // Truly orphan agency rows — no agent sibling anywhere — still need to
      // surface. Splice into the all-products bucket so the user sees them.
      const trulyOrphan = agencyForAllProducts.filter((r: any) => !allProductsRuleIds.has(r.ruleId));
      if (trulyOrphan.length > 0) {
        for (const row of trulyOrphan) {
          const ruleKey = row.ruleId || 'unknown';
          if (!allProductsRuleGroups.has(ruleKey)) allProductsRuleGroups.set(ruleKey, new Map());
          const tierMap = allProductsRuleGroups.get(ruleKey)!;
          const lvl = row.tierLevel ?? 0;
          if (!tierMap.has(lvl)) tierMap.set(lvl, []);
          tierMap.get(lvl)!.push(row);
        }
      }

      // Step 4: Split Rules
      const splitRules = agents.filter((a: any) => a.isSplitPartner || a.splitAmount || a.isPrimaryInSplit);
      const splitGroups = new Map<string, typeof splitRules>();
      splitRules.forEach((split: any) => {
        const key = split.ruleId || split.splitRuleId || 'unknown';
        if (!splitGroups.has(key)) splitGroups.set(key, []);
        splitGroups.get(key)!.push(split);
      });

      // Step 5: Excess/Overflow (primary-agency excess only)
      const excess = tenants.filter((t: any) => t.isExcess);
      // Step 5b: Tier-slot agency payouts (agency in upline matched a tier rule)
      const agencyTierSlots = tenants.filter(
        (t: any) => t.entityType === 'Agency' && !t.isExcess && !t.isOverride
      );

      return {
        commissionOverrides: Array.from(overrideGroups.entries()),
        agentSpecific: Array.from(agentSpecificGroups.entries()),
        allProductsRules: Array.from(allProductsRuleGroups.entries()),
        regularRules: Array.from(regularRuleGroups.entries()),
        splitRules: Array.from(splitGroups.entries()),
        excess,
        agencyTierSlots,
      };
    };

    const selectedAgentLabel =
      agentOptions.find((a) => a.value === agentId)?.label ||
      agentOptionsForAgentRole.find((a) => a.value === agentId)?.label ||
      wizardAgentNames.get(agentId) ||
      (isAgent ? 'Me' : '');

    /** Flat per-product recipient list. Recipient = primary label, rule =
     *  small sublabel. One row per (rule × tier × recipient) sorted by tier
     *  ascending. Primary-agency overflow renders last. */
    const renderRecipientList = (grouped: any) => {
      type Row = {
        key: string;
        isAgencyRecipient: boolean;
        id: string;
        name: string;
        tierLevel: number;
        ruleName: string;
        amount: number;
      };
      const rows: Row[] = [];
      let n = 0;

      grouped.commissionOverrides.forEach(([ruleId, overrides]: any) => {
        overrides.forEach((o: any) => {
          n += 1;
          rows.push({
            key: `ov:${ruleId}:${o.agentId}:${n}`,
            isAgencyRecipient: false,
            id: o.agentId,
            name: getWizardAgentName(o.agentId),
            tierLevel: o.tierLevel ?? 0,
            ruleName: o.ruleName || 'Override',
            amount: Number(o.amount || 0)
          });
        });
      });
      const pushFromTierMap = (entries: any[]) => {
        entries.forEach(([ruleId, tierMap]: any) => {
          Array.from(tierMap.entries()).forEach(([tierLevel, items]: any) => {
            items.forEach((r: any) => {
              n += 1;
              const isAgency = !!r.isAgencyRecipient;
              rows.push({
                key: `tr:${ruleId}:${tierLevel}:${isAgency ? r.agencyId : r.agentId}:${n}`,
                isAgencyRecipient: isAgency,
                id: isAgency ? r.agencyId : r.agentId,
                name: isAgency
                  ? wizardAgencyNames.get(r.agencyId) || 'Agency'
                  : getWizardAgentName(r.agentId),
                tierLevel: r.tierLevel ?? tierLevel ?? 0,
                ruleName: r.ruleName || 'Rule',
                amount: Number(r.amount || 0)
              });
            });
          });
        });
      };
      pushFromTierMap(grouped.agentSpecific);
      pushFromTierMap(grouped.allProductsRules);
      pushFromTierMap(grouped.regularRules);
      grouped.splitRules.forEach(([ruleId, splitRows]: any) => {
        splitRows.forEach((r: any) => {
          n += 1;
          rows.push({
            key: `sp:${ruleId}:${r.agentId}:${n}`,
            isAgencyRecipient: false,
            id: r.agentId,
            name: getWizardAgentName(r.agentId),
            tierLevel: r.tierLevel ?? 0,
            ruleName: r.ruleName || 'Split rule',
            amount: Number(r.splitAmount || r.amount || 0)
          });
        });
      });
      const visibleRows = rows
        .filter((r) => Math.abs(r.amount) > 0.0001)
        .sort((a, b) => a.tierLevel - b.tierLevel);

      if (visibleRows.length === 0 && (!grouped.excess || grouped.excess.length === 0)) {
        return (
          <p className="text-sm text-gray-500 italic">No recipients on this product.</p>
        );
      }

      return (
        <div className="space-y-2">
          {visibleRows.map((r, idx) => (
            <div key={r.key} className="border-l-4 border-oe-primary pl-4 py-1.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-base font-semibold text-gray-900 flex items-baseline gap-2 flex-wrap">
                    <span className="truncate">{r.name}</span>
                    <span className="text-xs font-normal text-gray-500 whitespace-nowrap">
                      ({idx + 1}) {tierLevelDisplayNames.get(r.tierLevel) || getTierName(r.tierLevel)}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 truncate" title={`Rule: ${r.ruleName}`}>
                    Rule: {r.ruleName}
                  </div>
                </div>
                <div className="text-base font-semibold text-gray-900 tabular-nums whitespace-nowrap">
                  {formatCurrency(r.amount)}
                </div>
              </div>
            </div>
          ))}
          {grouped.excess && grouped.excess.length > 0 && grouped.excess.map((e: any, i: number) => (
            <div key={`overflow:${i}`} className="border-l-4 border-oe-primary pl-4 py-1.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-base font-semibold text-gray-900 truncate">
                    {wizardAgencyNames.get(e.tenantId) || formatOverflowLabel(e)}
                  </div>
                  <div className="text-xs text-gray-500">Primary agency overflow</div>
                </div>
                <div className="text-base font-semibold text-gray-900 tabular-nums whitespace-nowrap">
                  {formatCurrency(e.amount)}
                </div>
              </div>
            </div>
          ))}
        </div>
      );
    };

    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60] p-4">
        <div className="bg-white rounded-lg border border-gray-200 shadow-xl max-w-6xl w-full max-h-[90vh] overflow-hidden flex flex-col">
          <div className="flex items-center justify-between p-6 border-b border-gray-200">
            <div>
              <h1 className="text-2xl font-semibold text-gray-900 mb-2">Commission Simulator</h1>
              <p className="text-gray-600">Step {wizardStep} of 4 — {stepTitles[wizardStep]}</p>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
              <X className="h-6 w-6" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            {/* SysAdmin-only helper */}
            {isSysAdmin && missingCommissionsCount !== null && missingCommissionsCount > 0 && (
              <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 rounded-lg p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-5 w-5 text-yellow-600 mt-0.5" />
                    <div>
                      <div className="text-sm font-semibold">Missing Commissions Detected</div>
                      <div className="text-sm">
                        {missingCommissionsCount} payment(s) found without commission rows.
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={handleGenerateMissing}
                    disabled={generatingMissing || loadingMissingCount}
                    className="px-4 py-2 rounded-lg bg-yellow-600 text-white hover:bg-yellow-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {generatingMissing ? 'Generating…' : `Generate (${missingCommissionsCount})`}
                  </button>
                </div>
              </div>
            )}

            {/* Step indicator */}
            <div className="bg-white rounded-lg border border-gray-200 p-6">
              <div className="flex items-center justify-between gap-4">
                {[1, 2, 3, 4].map((n) => {
                  const s = n as WizardStep;
                  const isDone = wizardStep > s;
                  const isCurrent = wizardStep === s;
                  return (
                    <div key={n} className="flex items-center gap-2">
                      <div
                        className={`h-6 w-6 rounded-full flex items-center justify-center text-xs font-semibold ${
                          isDone ? 'bg-green-100 text-green-800' : isCurrent ? 'bg-oe-primary text-white' : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {isDone ? <CheckCircle2 className="h-4 w-4" /> : n}
                      </div>
                      <div className={`text-sm ${isCurrent ? 'text-gray-900 font-medium' : 'text-gray-600'}`}>
                        {n === 1 ? 'Agent' : n === 2 ? 'Household' : n === 3 ? 'Products' : 'Results'}
                      </div>
                    </div>
                  );
                })}
              </div>
              {stepDescriptions[wizardStep] ? (
                <p className="text-gray-600 mt-4">{stepDescriptions[wizardStep]}</p>
              ) : null}
            </div>

            {wizardError && (
              <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-4">
                {wizardError}
              </div>
            )}

            {/* Step 1 */}
            {wizardStep === 1 && (
              <div className="bg-white rounded-lg border border-gray-200">
                <div className="p-6 border-b border-gray-200">
                  <h2 className="text-lg font-medium text-gray-900">Pick your agent</h2>
                </div>
                <div className="p-6 space-y-4">
                  {isSysAdmin && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Tenant *</label>
                      <SearchableDropdown
                        options={tenantOptions}
                        value={tenantId}
                        onChange={(value) => {
                          setTenantId(value);
                          setAgentId('');
                          setAgentOptions([]);
                        }}
                        placeholder="Select tenant"
                        loading={loadingTenants}
                        disabled={pricingLoading || simulationLoading}
                      />
                    </div>
                  )}

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Agent *</label>
                    {isAgent ? (
                      agentRoleHasPicker ? (
                        <SearchableDropdown
                          options={agentOptionsForAgentRole}
                          value={agentId}
                          onChange={async (value) => {
                            const realAgentId = value || viewerAgentIdFromHook || '';
                            if (!realAgentId) return;
                            setAgentId(realAgentId);
                            await loadAgentCommissionRule(realAgentId);
                            await loadGroupsForAgent(realAgentId);
                          }}
                          placeholder="Select an agent…"
                          searchPlaceholder="Search agents…"
                          loading={isLoadingDownlineAgents}
                          disabled={pricingLoading || simulationLoading}
                          showEmail={true}
                          multiLine={true}
                          useBackendSearch={false}
                        />
                      ) : (
                        <div className="px-3 py-2 border border-gray-300 rounded-lg bg-gray-50 text-gray-700">
                          {selectedAgentLabel || 'Loading…'}
                        </div>
                      )
                    ) : (
                      <SearchableDropdown
                        options={agentOptions}
                        value={agentId}
                        onChange={(value) => setAgentId(value)}
                        placeholder={isSysAdmin && !tenantId ? 'Select tenant first' : 'Select an agent…'}
                        searchPlaceholder="Search agents…"
                        loading={loadingAgents}
                        disabled={(isSysAdmin && !tenantId) || pricingLoading || simulationLoading}
                        showEmail={true}
                        showCode={true}
                        multiLine={true}
                        onSearch={handleWizardAgentSearch}
                        useBackendSearch={true}
                      />
                    )}
                  </div>

                </div>
              </div>
            )}

            {/* Step 2 */}
            {wizardStep === 2 && (
              <div className="bg-white rounded-lg border border-gray-200">
                <div className="p-6 border-b border-gray-200">
                  <h2 className="text-lg font-medium text-gray-900">Customize fake household</h2>
                  <p className="text-gray-600">Tier, age, and tobacco determine eligible pricing tiers.</p>
                </div>
                <div className="p-6 grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Tier</label>
                    <select
                      value={wizardTier}
                      onChange={(e) => setWizardTier(e.target.value as HouseholdTier)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                    >
                      <option value="EE">EE</option>
                      <option value="ES">ES</option>
                      <option value="EC">EC</option>
                      <option value="EF">EF</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Age</label>
                    <select
                      value={wizardAge}
                      onChange={(e) => setWizardAge(Number(e.target.value))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                    >
                      {ageOptions.map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Tobacco Use</label>
                    <select
                      value={wizardTobaccoUse}
                      onChange={(e) => setWizardTobaccoUse(e.target.value as TobaccoUse)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                    >
                      <option value="No">No</option>
                      <option value="Yes">Yes</option>
                    </select>
                  </div>
                </div>
              </div>
            )}

            {/* Step 3 */}
            {wizardStep === 3 && (
              <div className="bg-white rounded-lg border border-gray-200">
                <div className="p-6 border-b border-gray-200">
                  <h2 className="text-lg font-medium text-gray-900">Pick product(s) being purchased</h2>
                  <p className="text-gray-600">Group and Individual products are shown separately. Hidden products are excluded.</p>
                </div>
                <div className="p-6 space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Search products</label>
                      <input
                        value={wizardProductSearch}
                        onChange={(e) => setWizardProductSearch(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                        placeholder="Type to filter…"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Effective Date</label>
                      <input
                        type="date"
                        value={paymentDate}
                        onChange={(e) => setPaymentDate(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                      />
                    </div>
                  </div>

                  {loadingProducts ? (
                    <div className="text-gray-600 flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading products…
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                      <div className="bg-white rounded-lg border border-gray-200">
                        <div className="p-6 border-b border-gray-200">
                          <h2 className="text-lg font-medium text-gray-900">Group Products</h2>
                        </div>
                        <div className="p-6">
                          {groupProducts.length === 0 ? (
                            <p className="text-gray-600">No group products found.</p>
                          ) : (
                            <div className="space-y-2">
                              {groupProducts.map((p) => {
                                const isSelected = selectedProductIds.includes(p.id);
                                const meta = isSelected ? getConfigMeta(p.id) : null;
                                return (
                                <label key={p.id} className="flex items-start gap-2 p-2 rounded hover:bg-gray-50 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    className="mt-1 h-4 w-4 border-gray-300 rounded"
                                    checked={isSelected}
                                    onChange={(e) => {
                                      if (e.target.checked) setSelectedProductIds([...selectedProductIds, p.id]);
                                      else setSelectedProductIds(selectedProductIds.filter((id) => id !== p.id));
                                    }}
                                  />
                                  <div className="min-w-0 flex-1">
                                    <div className="text-sm font-medium text-gray-900 truncate">{p.name}</div>
                                    {p.isBundle && (
                                      <div className="text-xs text-gray-500">Bundle</div>
                                    )}
                                    {isSelected && pricingPreviewLoading && (
                                      <div className="text-xs text-gray-500 mt-1 flex items-center gap-1">
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                        Loading options…
                                      </div>
                                    )}
                                    {isSelected && meta && (
                                      <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                                        <label className="block text-xs font-semibold text-gray-600 mb-1">{meta.label}</label>
                                        <select
                                          value={meta.defaultValue}
                                          onChange={(e) =>
                                            setWizardConfigByProductId((prev) => ({
                                              ...prev,
                                              [p.id]: e.target.value,
                                            }))
                                          }
                                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                                        >
                                          {meta.options.map((v) => (
                                            <option key={v} value={v}>
                                              {v}
                                            </option>
                                          ))}
                                        </select>
                                      </div>
                                    )}
                                  </div>
                                </label>
                              );
                              })}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="bg-white rounded-lg border border-gray-200">
                        <div className="p-6 border-b border-gray-200">
                          <h2 className="text-lg font-medium text-gray-900">Individual Products</h2>
                        </div>
                        <div className="p-6">
                          {individualProducts.length === 0 ? (
                            <p className="text-gray-600">No individual products found.</p>
                          ) : (
                            <div className="space-y-2">
                              {individualProducts.map((p) => {
                                const isSelected = selectedProductIds.includes(p.id);
                                const meta = isSelected ? getConfigMeta(p.id) : null;
                                return (
                                <label key={p.id} className="flex items-start gap-2 p-2 rounded hover:bg-gray-50 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    className="mt-1 h-4 w-4 border-gray-300 rounded"
                                    checked={isSelected}
                                    onChange={(e) => {
                                      if (e.target.checked) setSelectedProductIds([...selectedProductIds, p.id]);
                                      else setSelectedProductIds(selectedProductIds.filter((id) => id !== p.id));
                                    }}
                                  />
                                  <div className="min-w-0 flex-1">
                                    <div className="text-sm font-medium text-gray-900 truncate">{p.name}</div>
                                    {p.isBundle && (
                                      <div className="text-xs text-gray-500">Bundle</div>
                                    )}
                                    {isSelected && pricingPreviewLoading && (
                                      <div className="text-xs text-gray-500 mt-1 flex items-center gap-1">
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                        Loading options…
                                      </div>
                                    )}
                                    {isSelected && meta && (
                                      <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                                        <label className="block text-xs font-semibold text-gray-600 mb-1">{meta.label}</label>
                                        <select
                                          value={meta.defaultValue}
                                          onChange={(e) =>
                                            setWizardConfigByProductId((prev) => ({
                                              ...prev,
                                              [p.id]: e.target.value,
                                            }))
                                          }
                                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                                        >
                                          {meta.options.map((v) => (
                                            <option key={v} value={v}>
                                              {v}
                                            </option>
                                          ))}
                                        </select>
                                      </div>
                                    )}
                                  </div>
                                </label>
                              );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="text-sm text-gray-600">
                    {selectedProductIds.length} selected
                    {selectedProductIds.length > 0 && pricingPreviewLoading && (
                      <span className="ml-2 text-gray-500">(loading configuration options…)</span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Step 4 */}
            {wizardStep === 4 && (
              <div className="bg-white rounded-lg border border-gray-200">
                <div className="p-6 border-b border-gray-200">
                  <h2 className="text-lg font-medium text-gray-900">Calculate and see the breakdown</h2>
                </div>
                <div className="p-6 space-y-6">
                  <div className="flex items-center justify-between gap-4">
                    <div className="text-sm text-gray-600 flex items-center gap-3 flex-wrap">
                      <div>
                        Agent: <span className="text-gray-900 font-medium">{selectedAgentLabel || agentId}</span>
                      </div>
                      <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-gray-100 text-gray-800">
                        {wizardTier} · Age {wizardAge} · Tobacco: {wizardTobaccoUse === 'Yes' ? 'Y' : 'N'}
                      </span>
                    </div>
                    <div className="text-sm text-gray-600">
                      {pricingLoading || simulationLoading ? (
                        <span className="flex items-center gap-2">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Calculating…
                        </span>
                      ) : (
                        <span className="text-gray-500"></span>
                      )}
                    </div>
                  </div>

                  {(pricingLoading || simulationLoading) && (
                    <div className="text-gray-600 flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Running pricing + commission simulation…
                    </div>
                  )}

                  {(() => {
                    const sims = Object.values(simulationResults || {});
                    const hasMissing = sims.some((s) => s?.breakdown?.overflowDestinationMissing === true);
                    if (!hasMissing) return null;
                    const totalMissing = sims.reduce(
                      (sum, s) => sum + (s?.breakdown?.overflowDestinationMissing ? Number(s?.overflowToProductOwner || 0) : 0),
                      0
                    );
                    return (
                      <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 rounded-lg p-3 flex items-start gap-2">
                        <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
                        <div className="text-sm">
                          {isAgent ? (
                            <p>
                              <span className="font-medium">Warning:</span> your tenant has no primary agency, so any
                              overflow on this scenario won&apos;t be paid out — please contact your admin.
                            </p>
                          ) : (
                            <p>
                              <span className="font-medium">Warning:</span> this tenant has no primary agency.
                              {' '}{formatCurrency(totalMissing)} of overflow commission has no destination and will not be paid out.
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Per-entity totals across all simulated products. */}
                  {(() => {
                    const dynamicTierName = (level: number | null | undefined) => {
                      if (level == null) return '';
                      const dyn = tierLevelDisplayNames.get(Number(level));
                      return dyn || getTierName(Number(level));
                    };
                    const sims = Object.values(simulationResults || {});
                    if (sims.length === 0) return null;

                    type EntityTotal = {
                      key: string;
                      type: 'Agent' | 'Agency';
                      id: string;
                      name: string;
                      tierLevel: number | null;
                      total: number;
                      isOverflow: boolean;
                    };
                    const totals = new Map<string, EntityTotal>();

                    sims.forEach((sim) => {
                      const breakdown = (sim?.breakdown || {}) as any;
                      (breakdown.agents || []).forEach((a: any) => {
                        if (!a?.agentId) return;
                        const key = `Agent:${a.agentId}`;
                        const existing = totals.get(key);
                        const amt = Number(a.amount || 0);
                        if (existing) {
                          existing.total += amt;
                        } else {
                          totals.set(key, {
                            key,
                            type: 'Agent',
                            id: a.agentId,
                            name: wizardAgentNames.get(a.agentId) || `Agent ${String(a.agentId).slice(0, 8)}`,
                            tierLevel: a.tierLevel ?? null,
                            total: amt,
                            isOverflow: false
                          });
                        }
                      });
                      (breakdown.tenants || []).forEach((t: any) => {
                        if (!t?.tenantId) return;
                        const isAgencyRow = t.entityType === 'Agency' || t.isPrimaryAgency;
                        if (!isAgencyRow) return;
                        const key = `Agency:${t.tenantId}`;
                        const existing = totals.get(key);
                        const amt = Number(t.amount || 0);
                        if (existing) {
                          existing.total += amt;
                          if (t.isPrimaryAgency) existing.isOverflow = true;
                        } else {
                          totals.set(key, {
                            key,
                            type: 'Agency',
                            id: t.tenantId,
                            name: wizardAgencyNames.get(t.tenantId) || `Agency ${String(t.tenantId).slice(0, 8)}`,
                            tierLevel: t.tierLevel ?? null,
                            total: amt,
                            isOverflow: !!t.isPrimaryAgency
                          });
                        }
                      });
                    });

                    const rows = Array.from(totals.values()).filter((r) => r.total > 0);
                    if (rows.length === 0) return null;
                    // Order matches commission flow: tier ascending (selling
                    // agent first, upline next), with primary-agency overflow
                    // last regardless of tier.
                    rows.sort((a, b) => {
                      if (a.isOverflow !== b.isOverflow) return a.isOverflow ? 1 : -1;
                      const ta = a.tierLevel ?? Number.MAX_SAFE_INTEGER;
                      const tb = b.tierLevel ?? Number.MAX_SAFE_INTEGER;
                      if (ta !== tb) return ta - tb;
                      return b.total - a.total;
                    });

                    const grandTotal = rows.reduce((s, r) => s + r.total, 0);

                    return (
                      <div className="bg-white rounded-lg border border-gray-200 p-4">
                        <div className="flex items-center justify-between mb-3">
                          <h3 className="text-sm font-semibold text-gray-900">Total per recipient</h3>
                          <span className="text-sm text-gray-600">
                            Grand total: <span className="font-semibold text-gray-900">{formatCurrency(grandTotal)}</span>
                          </span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                          {rows.map((r) => (
                            <div
                              key={r.key}
                              className="rounded-lg border border-gray-200 bg-gradient-to-br from-blue-50 via-white to-white p-3"
                            >
                              <div className="text-xs uppercase tracking-wide text-gray-500">
                                {r.isOverflow ? 'Primary agency overflow' : r.type}
                              </div>
                              <div className="text-base font-semibold text-gray-900 truncate" title={r.name}>
                                {r.name}
                              </div>
                              <div className="text-xs text-gray-500 mt-0.5">
                                {r.tierLevel != null
                                  ? `Level ${r.tierLevel}: ${dynamicTierName(r.tierLevel)}`
                                  : '—'}
                              </div>
                              <div className="text-lg font-bold text-gray-900 mt-1 tabular-nums">
                                {formatCurrency(r.total)}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}

                  {pricingResult && (
                    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                      <div className="p-6 border-b border-gray-200">
                        <div className="flex items-center justify-between gap-4 flex-wrap">
                          <h2 className="text-lg font-medium text-gray-900">Results</h2>
                          <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden">
                            <button
                              type="button"
                              onClick={() => setResultsTab('agent')}
                              className={`px-3 py-2 text-sm font-medium transition-colors ${
                                resultsTab === 'agent'
                                  ? 'bg-blue-50 text-oe-primary border-r border-gray-200'
                                  : 'bg-white text-gray-700 hover:bg-gray-50 border-r border-gray-200'
                              }`}
                            >
                              Agent Commission
                            </button>
                            {(isTenantAdmin || isSysAdmin) && (
                              <button
                                type="button"
                                onClick={() => setResultsTab('vendor')}
                                className={`px-3 py-2 text-sm font-medium transition-colors ${
                                  resultsTab === 'vendor'
                                    ? 'bg-blue-50 text-oe-primary border-r border-gray-200'
                                    : 'bg-white text-gray-700 hover:bg-gray-50 border-r border-gray-200'
                                }`}
                              >
                                Vendor Payouts
                              </button>
                            )}
                            {(isTenantAdmin || isSysAdmin) && (
                              <button
                                type="button"
                                onClick={() => setResultsTab('overrides')}
                                className={`px-3 py-2 text-sm font-medium transition-colors ${
                                  resultsTab === 'overrides' ? 'bg-blue-50 text-oe-primary' : 'bg-white text-gray-700 hover:bg-gray-50'
                                }`}
                              >
                                Overrides
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="p-6 overflow-x-auto">
                        {(() => {
                          const rowAgentPaid = (sim: any) =>
                            (sim?.breakdown?.agents || [])
                              .filter((a: any) => a.agentId === agentId)
                              .reduce((sum: number, a: any) => sum + Number(a.amount || 0), 0);

                          const rowVendorPaid = (sim: any) =>
                            (sim?.breakdown?.vendors || []).reduce((sum: number, v: any) => sum + Number(v.amount || 0), 0);

                          const rowOverridePaid = (sim: any) =>
                            (sim?.breakdown?.agents || [])
                              .filter((a: any) => a.agentId === agentId && a.isOverride)
                              .reduce((sum: number, a: any) => sum + Number(a.amount || 0), 0) +
                            (sim?.breakdown?.tenants || [])
                              .filter((t: any) => t.isOverride)
                              .reduce((sum: number, t: any) => sum + Number(t.amount || 0), 0);

                          const totalSelectedAgentPaid = (pricingResult.products || []).reduce((sum: number, p: any) => {
                            if (p?.isBundle && Array.isArray(p?.includedProducts) && p.includedProducts.length > 0) {
                              return (
                                sum +
                                p.includedProducts.reduce((s2: number, inc: any) => {
                                  const lineItemId = `${p.productId}::${inc.productId}`;
                                  return s2 + rowAgentPaid(simulationResults[lineItemId]);
                                }, 0)
                              );
                            }
                            return sum + rowAgentPaid(simulationResults[p.productId]);
                          }, 0);

                          const totalVendorsPaid = (pricingResult.products || []).reduce((sum: number, p: any) => {
                            if (p?.isBundle && Array.isArray(p?.includedProducts) && p.includedProducts.length > 0) {
                              return (
                                sum +
                                p.includedProducts.reduce((s2: number, inc: any) => {
                                  const lineItemId = `${p.productId}::${inc.productId}`;
                                  return s2 + rowVendorPaid(simulationResults[lineItemId]);
                                }, 0)
                              );
                            }
                            return sum + rowVendorPaid(simulationResults[p.productId]);
                          }, 0);

                          const totalOverridesPaid = (pricingResult.products || []).reduce((sum: number, p: any) => {
                            if (p?.isBundle && Array.isArray(p?.includedProducts) && p.includedProducts.length > 0) {
                              return (
                                sum +
                                p.includedProducts.reduce((s2: number, inc: any) => {
                                  const lineItemId = `${p.productId}::${inc.productId}`;
                                  return s2 + rowOverridePaid(simulationResults[lineItemId]);
                                }, 0)
                              );
                            }
                            return sum + rowOverridePaid(simulationResults[p.productId]);
                          }, 0);

                          // Aggregate agent-to-agent overrides across every simulated
                          // product where the selected agent is the source. We dedupe
                          // by overrideId because a Fixed override is returned by every
                          // per-product simulation even though it only applies once to
                          // the real payment total. For Percentage overrides we recompute
                          // against the aggregate totalSelectedAgentPaid.
                          const aggregatedOverrideMap = new Map<string, SimulationAgentOverride>();
                          const collectFrom = (sim: any) => {
                            const list: SimulationAgentOverride[] = sim?.agentOverrides || [];
                            for (const ov of list) {
                              if (!ov || ov.sourceAgentId !== agentId) continue;
                              if (!aggregatedOverrideMap.has(ov.overrideId)) {
                                aggregatedOverrideMap.set(ov.overrideId, ov);
                              }
                            }
                          };
                          (pricingResult.products || []).forEach((p: any) => {
                            if (p?.isBundle && Array.isArray(p?.includedProducts) && p.includedProducts.length > 0) {
                              p.includedProducts.forEach((inc: any) => {
                                collectFrom(simulationResults[`${p.productId}::${inc.productId}`]);
                              });
                            } else {
                              collectFrom(simulationResults[p.productId]);
                            }
                          });
                          const viewerOverrides = Array.from(aggregatedOverrideMap.values())
                            .map((ov) => {
                              let amount = Number(ov.amount || 0);
                              if (ov.overrideType === 'Percentage') {
                                const pct = ov.sourceTotalBefore && ov.sourceTotalBefore > 0
                                  ? (Number(ov.amount || 0) / ov.sourceTotalBefore) * 100
                                  : 0;
                                amount = Math.round((totalSelectedAgentPaid * pct) / 100 * 100) / 100;
                              }
                              const skipped = amount <= 0 || amount > totalSelectedAgentPaid;
                              return { ov, amount, skipped };
                            });
                          const appliedOverrides = viewerOverrides.filter((e) => !e.skipped);
                          const overrideDeduction = appliedOverrides.reduce((s, e) => s + e.amount, 0);
                          const totalAfterOverrides = Math.max(0, totalSelectedAgentPaid - overrideDeduction);
                          const showOverridePanel = resultsTab === 'agent' && viewerOverrides.length > 0;

                          return (
                        <>
                        {showOverridePanel && (
                          <div className="mb-4 border border-blue-200 rounded-lg overflow-hidden">
                            <div className="bg-blue-50 px-4 py-3 border-b border-blue-200">
                              <h3 className="text-sm font-medium text-blue-900">Agent overrides applied</h3>
                              <p className="text-xs text-blue-800 mt-0.5">
                                Portions of {selectedAgentLabel || 'this agent'}&apos;s per-payment commission are redirected to another agent.
                              </p>
                            </div>
                            <div className="px-4 py-3 bg-white space-y-2 text-sm">
                              <div className="flex items-center justify-between">
                                <span className="text-gray-700">Total</span>
                                <span className="font-medium text-gray-900">{formatCurrency(totalSelectedAgentPaid)}</span>
                              </div>
                              {viewerOverrides.map(({ ov, amount, skipped }) => {
                                const recipientName =
                                  allAgentNames.get(ov.recipientAgentId) ||
                                  agentOptions.find((a) => a.value === ov.recipientAgentId)?.label ||
                                  ov.recipientAgentName ||
                                  `Agent ${ov.recipientAgentId.substring(0, 8)}`;
                                return (
                                  <div key={ov.overrideId} className="flex items-center justify-between">
                                    <span className="text-gray-600">
                                      To {recipientName}
                                      {skipped && (
                                        <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-yellow-100 text-yellow-800">
                                          Skipped
                                        </span>
                                      )}
                                    </span>
                                    <span className={`font-medium ${skipped ? 'text-gray-400 line-through' : 'text-red-600'}`}>
                                      -{formatCurrency(amount)}
                                    </span>
                                  </div>
                                );
                              })}
                              <div className="border-t border-gray-200 pt-2 flex items-center justify-between">
                                <span className="font-semibold text-gray-900">Total After Overrides</span>
                                <span className="font-semibold text-gray-900">{formatCurrency(totalAfterOverrides)}</span>
                              </div>
                            </div>
                          </div>
                        )}
                        <table className="min-w-full divide-y divide-gray-200">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="px-4 py-2 text-left text-xs font-semibold text-gray-600">Product</th>
                              <th className="px-4 py-2 text-right text-xs font-semibold text-gray-600">Monthly Premium</th>
                              {resultsTab === 'agent' && (isTenantAdmin || isSysAdmin) && (
                                <th className="px-4 py-2 text-right text-xs font-semibold text-gray-600">Allocated commission</th>
                              )}
                              {resultsTab === 'agent' && (
                                <th className="px-4 py-2 text-right text-xs font-semibold text-gray-600">
                                  Selected Agent Paid (Total: {formatCurrency(totalSelectedAgentPaid)})
                                </th>
                              )}
                              {resultsTab === 'vendor' && (
                                <th className="px-4 py-2 text-right text-xs font-semibold text-gray-600">
                                  Vendor payouts (Total: {formatCurrency(totalVendorsPaid)})
                                </th>
                              )}
                              {resultsTab === 'overrides' && (
                                <th className="px-4 py-2 text-right text-xs font-semibold text-gray-600">
                                  Overrides (Total: {formatCurrency(totalOverridesPaid)})
                                </th>
                              )}
                            </tr>
                          </thead>
                          <tbody className="bg-white divide-y divide-gray-200">
                            {(pricingResult.products || []).flatMap((p: any) => {
                              // For bundles, list each included product and omit the bundle row
                              if (p?.isBundle && Array.isArray(p?.includedProducts) && p.includedProducts.length > 0) {
                                return p.includedProducts.map((inc: any) => {
                                  const lineItemId = `${p.productId}::${inc.productId}`;
                                  const sim = simulationResults[lineItemId];
                                  const agentPaid = rowAgentPaid(sim);
                                  const vendorPaid = rowVendorPaid(sim);
                                  const overridePaid = rowOverridePaid(sim);
                                  return (
                                    <tr key={lineItemId}>
                                      <td className="px-4 py-2 text-sm text-gray-900">{inc.productName}</td>
                                      <td className="px-4 py-2 text-sm text-gray-900 text-right">{formatCurrency(inc.monthlyPremium || 0)}</td>
                                      {resultsTab === 'agent' && (isTenantAdmin || isSysAdmin) && (
                                        <td className="px-4 py-2 text-sm text-gray-900 text-right">{formatCurrency(inc.pricingDetails?.vendorCommission || 0)}</td>
                                      )}
                                      {resultsTab === 'agent' && (
                                        <td className="px-4 py-2 text-sm text-gray-900 text-right">{formatCurrency(agentPaid)}</td>
                                      )}
                                      {resultsTab === 'vendor' && (
                                        <td className="px-4 py-2 text-sm text-gray-900 text-right">{formatCurrency(vendorPaid)}</td>
                                      )}
                                      {resultsTab === 'overrides' && (
                                        <td className="px-4 py-2 text-sm text-gray-900 text-right">{formatCurrency(overridePaid)}</td>
                                      )}
                                    </tr>
                                  );
                                });
                              }

                              const sim = simulationResults[p.productId];
                              const agentPaid = rowAgentPaid(sim);
                              const vendorPaid = rowVendorPaid(sim);
                              const overridePaid = rowOverridePaid(sim);
                              return (
                                <tr key={p.productId}>
                                  <td className="px-4 py-2 text-sm text-gray-900">{p.productName}</td>
                                  <td className="px-4 py-2 text-sm text-gray-900 text-right">{formatCurrency(p.monthlyPremium || 0)}</td>
                                  {resultsTab === 'agent' && (isTenantAdmin || isSysAdmin) && (
                                    <td className="px-4 py-2 text-sm text-gray-900 text-right">{formatCurrency(p.pricingDetails?.vendorCommission || 0)}</td>
                                  )}
                                  {resultsTab === 'agent' && (
                                    <td className="px-4 py-2 text-sm text-gray-900 text-right">{formatCurrency(agentPaid)}</td>
                                  )}
                                  {resultsTab === 'vendor' && (
                                    <td className="px-4 py-2 text-sm text-gray-900 text-right">{formatCurrency(vendorPaid)}</td>
                                  )}
                                  {resultsTab === 'overrides' && (
                                    <td className="px-4 py-2 text-sm text-gray-900 text-right">{formatCurrency(overridePaid)}</td>
                                  )}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        </>
                          );
                        })()}
                      </div>
                    </div>
                  )}

                  {/* Per-product commission breakdown */}
                  {resultsTab === 'agent' && pricingResult && (pricingResult.products || []).length > 0 && (
                    <div className="space-y-4">
                      {(pricingResult.products || []).flatMap((p: any) => {
                        // Expand bundles into included products and omit bundle itself
                        if (p?.isBundle && Array.isArray(p?.includedProducts) && p.includedProducts.length > 0) {
                          return p.includedProducts.map((inc: any) => {
                            const lineItemId = `${p.productId}::${inc.productId}`;
                            const sim = simulationResults[lineItemId];
                            if (!sim) return null;
                            const grouped = organizeBreakdownFor(sim);

                            return (
                              <div key={lineItemId} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                                <div className="p-6 border-b border-gray-200">
                                  <h2 className="text-lg font-medium text-gray-900">{inc.productName}</h2>
                                  <p className="text-gray-600">
                                    Premium {formatCurrency(inc.monthlyPremium || 0)}
                                  </p>
                                </div>
                                <div className="p-6 space-y-4">
                                  <div className="bg-white rounded-lg border border-gray-200 p-4">
                                    <div className="flex items-center gap-2 mb-3">
                                      <TrendingUp className="h-5 w-5 text-oe-primary" />
                                      <div className="text-sm font-semibold text-gray-900">Step-by-step commission processing</div>
                                    </div>

                                    {renderRecipientList(grouped)}
                                    {/* legacy step blocks below kept disabled — replaced by renderRecipientList */}
                                    {false && (
                                    <>

                                    {/* Step 1: Overrides */}
                                    {grouped.commissionOverrides.length > 0 && (
                                      <div className="border-l-4 border-oe-primary pl-4">
                                        {grouped.commissionOverrides.map(([ruleId, overrides], idx) => (
                                          <div key={ruleId} className="mb-4 last:mb-0">
                                            {(() => {
                                              const first = overrides?.[0];
                                              const ruleName = first?.ruleName || 'Override';
                                              const priority = first?.priority;
                                              return (
                                                <div className="text-sm font-semibold text-gray-900">
                                                  {idx + 1}. {ruleName}{priority != null ? ` (Priority ${priority})` : ''}
                                                </div>
                                              );
                                            })()}
                                            <div className="mt-2 space-y-1">
                                              {overrides.map((o: any, i: number) => (
                                                <div key={i} className="flex items-center justify-between text-sm text-gray-700">
                                                  <span>{getWizardAgentName(o.agentId)}</span>
                                                  <span className="font-medium text-gray-900">{formatCurrency(o.amount)}</span>
                                                </div>
                                              ))}
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    )}

                                    {/* Step 2: Agent-specific */}
                                    {grouped.agentSpecific.length > 0 && (
                                      <div className="border-l-4 border-oe-primary pl-4 mt-4">
                                        {grouped.agentSpecific.map(([ruleId, tierMap], idx) => (
                                          <div key={ruleId} className="mb-4 last:mb-0">
                                            {(() => {
                                              const first = Array.from(tierMap.values())[0]?.[0];
                                              const ruleName = first?.ruleName || 'Agent-specific rule';
                                              const priority = first?.priority;
                                              return (
                                                <div className="text-sm font-semibold text-gray-900">
                                                  {idx + 1}. {ruleName}{priority != null ? ` (Priority ${priority})` : ''}
                                                </div>
                                              );
                                            })()}
                                            <div className="mt-2 space-y-2">
                                              {Array.from(tierMap.entries())
                                                .sort(([a], [b]) => (a ?? 0) - (b ?? 0))
                                                .map(([tierLevel, rows]) => (
                                                  <div key={tierLevel}>
                                                    <div className="text-xs font-semibold text-gray-600">Tier Level {tierLevel}</div>
                                                    {rows.map((r: any, i: number) => (
                                                      <div key={i} className="flex items-center justify-between text-sm text-gray-700">
                                                        <span>{r.isAgencyRecipient ? (wizardAgencyNames.get(r.agencyId) || 'Agency') : getWizardAgentName(r.agentId)}</span>
                                                        <span className="font-medium text-gray-900">{formatCurrency(r.amount)}</span>
                                                      </div>
                                                    ))}
                                                  </div>
                                                ))}
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    )}

                                    {/* Step 3: Regular rules */}
                                    {grouped.allProductsRules.length > 0 && (
                                      <div className="border-l-4 border-oe-primary pl-4 mt-4">
                                        <div className="text-sm font-semibold text-gray-900">All Products</div>
                                        <div className="mt-2 space-y-2">
                                          {grouped.allProductsRules.map(([ruleId, tierMap], idx) => (
                                            <div key={ruleId} className="mb-3 last:mb-0">
                                              {(() => {
                                                const first = Array.from(tierMap.values())[0]?.[0];
                                                const ruleName = first?.ruleName || 'All Products rule';
                                                const priority = first?.priority;
                                                return (
                                                  <div className="text-sm font-semibold text-gray-900">
                                                    {idx + 1}. {ruleName}{priority != null ? ` (Priority ${priority})` : ''}
                                                  </div>
                                                );
                                              })()}
                                              <div className="mt-1 space-y-2">
                                                {Array.from(tierMap.entries())
                                                  .sort(([a], [b]) => (a ?? 0) - (b ?? 0))
                                                  .map(([tierLevel, rows]) => (
                                                    <div key={tierLevel}>
                                                      <div className="text-xs font-semibold text-gray-600">Tier Level {tierLevel}</div>
                                                      {rows.map((r: any, i: number) => (
                                                        <div key={i} className="flex items-center justify-between text-sm text-gray-700">
                                                          <span>{r.isAgencyRecipient ? (wizardAgencyNames.get(r.agencyId) || 'Agency') : getWizardAgentName(r.agentId)}</span>
                                                          <span className="font-medium text-gray-900">{formatCurrency(r.amount)}</span>
                                                        </div>
                                                      ))}
                                                    </div>
                                                  ))}
                                              </div>
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                    )}

                                    {grouped.regularRules.length > 0 && (
                                      <div className="border-l-4 border-oe-primary pl-4 mt-4">
                                        {grouped.regularRules.map(([ruleId, tierMap], idx) => (
                                          <div key={ruleId} className="mb-4 last:mb-0">
                                            {(() => {
                                              const first = Array.from(tierMap.values())[0]?.[0];
                                              const ruleName = first?.ruleName || 'Regular rule';
                                              const priority = first?.priority;
                                              return (
                                                <div className="text-sm font-semibold text-gray-900">
                                                  {idx + 1}. {ruleName}{priority != null ? ` (Priority ${priority})` : ''}
                                                </div>
                                              );
                                            })()}
                                            <div className="mt-2 space-y-2">
                                              {Array.from(tierMap.entries())
                                                .sort(([a], [b]) => (a ?? 0) - (b ?? 0))
                                                .map(([tierLevel, rows]) => (
                                                  <div key={tierLevel}>
                                                    <div className="text-xs font-semibold text-gray-600">Tier Level {tierLevel}</div>
                                                    {rows.map((r: any, i: number) => (
                                                      <div key={i} className="flex items-center justify-between text-sm text-gray-700">
                                                        <span>{r.isAgencyRecipient ? (wizardAgencyNames.get(r.agencyId) || 'Agency') : getWizardAgentName(r.agentId)}</span>
                                                        <span className="font-medium text-gray-900">{formatCurrency(r.amount)}</span>
                                                      </div>
                                                    ))}
                                                  </div>
                                                ))}
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    )}

                                    {/* Step 4: Split rules */}
                                    {grouped.splitRules.length > 0 && (
                                      <div className="border-l-4 border-oe-primary pl-4 mt-4">
                                        {grouped.splitRules.map(([ruleId, rows], idx) => (
                                          <div key={ruleId} className="mb-4 last:mb-0">
                                            {(() => {
                                              const first = rows?.[0];
                                              const ruleName = first?.ruleName || 'Split rule';
                                              const priority = first?.priority;
                                              return (
                                                <div className="text-sm font-semibold text-gray-900">
                                                  {idx + 1}. {ruleName}{priority != null ? ` (Priority ${priority})` : ''}
                                                </div>
                                              );
                                            })()}
                                            <div className="mt-2 space-y-1">
                                              {rows.map((r: any, i: number) => (
                                                <div key={i} className="flex items-center justify-between text-sm text-gray-700">
                                                  <span>{getWizardAgentName(r.agentId)}</span>
                                                  <span className="font-medium text-gray-900">
                                                    {formatCurrency(r.splitAmount || r.amount)}
                                                  </span>
                                                </div>
                                              ))}
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    )}

                                    {/* Step 5: Excess */}
                                    {grouped.excess.length > 0 && (
                                      <div className="border-l-4 border-oe-primary pl-4 mt-4">
                                        <div className="text-sm font-semibold text-gray-900">
                                          {grouped.excess.some((e: any) => e?.isPrimaryAgency) ? 'Primary Agency Overflow' : 'Excess / Overflow'}
                                        </div>
                                        <div className="mt-2 space-y-1">
                                          {grouped.excess.map((e: any, i: number) => (
                                            <div key={i} className="flex items-center justify-between text-sm text-gray-700">
                                              <span>{formatOverflowLabel(e)}</span>
                                              <span className="font-medium text-gray-900">{formatCurrency(e.amount)}</span>
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                    )}

                                    {/* Tier-slot agency payouts now render inline with their rule's tier rows. */}
                                    </>
                                    )}
                                  </div>

                                  <div className="flex items-center justify-between text-sm text-gray-700">
                                    <span className="font-medium text-gray-900">Total to {getWizardAgentName(agentId)}</span>
                                    <span className="font-semibold text-gray-900">
                                      {formatCurrency(
                                        (sim.breakdown?.agents || [])
                                          .filter((a: any) => a.agentId === agentId)
                                          .reduce((sum: number, a: any) => sum + Number(a.amount || 0), 0)
                                      )}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            );
                          });
                        }

                        const sim = simulationResults[p.productId];
                        if (!sim) return null;
                        const grouped = organizeBreakdownFor(sim);

                        return (
                          <div key={p.productId} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                            <div className="p-6 border-b border-gray-200">
                              <h2 className="text-lg font-medium text-gray-900">{p.productName}</h2>
                              <p className="text-gray-600">
                                Premium {formatCurrency(p.monthlyPremium || 0)}
                              </p>
                            </div>
                            <div className="p-6 space-y-4">
                              <div className="bg-white rounded-lg border border-gray-200 p-4">
                                <div className="flex items-center gap-2 mb-3">
                                  <TrendingUp className="h-5 w-5 text-oe-primary" />
                                  <div className="text-sm font-semibold text-gray-900">Step-by-step commission processing</div>
                                </div>

                                {renderRecipientList(grouped)}
                                {/* legacy step blocks below kept disabled — replaced by renderRecipientList */}
                                {false && (
                                <>

                                {/* Step 1: Overrides */}
                                {grouped.commissionOverrides.length > 0 && (
                                  <div className="border-l-4 border-oe-primary pl-4">
                                    {grouped.commissionOverrides.map(([ruleId, overrides], idx) => (
                                      <div key={ruleId} className="mb-4 last:mb-0">
                                        {(() => {
                                          const first = overrides?.[0];
                                          const ruleName = first?.ruleName || 'Override';
                                          const priority = first?.priority;
                                          return (
                                            <div className="text-sm font-semibold text-gray-900">
                                              {idx + 1}. {ruleName}{priority != null ? ` (Priority ${priority})` : ''}
                                            </div>
                                          );
                                        })()}
                                        <div className="mt-2 space-y-1">
                                          {overrides.map((o: any, i: number) => (
                                            <div key={i} className="flex items-center justify-between text-sm text-gray-700">
                                              <span>{getWizardAgentName(o.agentId)}</span>
                                              <span className="font-medium text-gray-900">{formatCurrency(o.amount)}</span>
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}

                                {/* Step 2: Agent-specific */}
                                {grouped.agentSpecific.length > 0 && (
                                  <div className="border-l-4 border-oe-primary pl-4 mt-4">
                                    {grouped.agentSpecific.map(([ruleId, tierMap], idx) => (
                                      <div key={ruleId} className="mb-4 last:mb-0">
                                        {(() => {
                                          const first = Array.from(tierMap.values())[0]?.[0];
                                          const ruleName = first?.ruleName || 'Agent-specific rule';
                                          const priority = first?.priority;
                                          return (
                                            <div className="text-sm font-semibold text-gray-900">
                                              {idx + 1}. {ruleName}{priority != null ? ` (Priority ${priority})` : ''}
                                            </div>
                                          );
                                        })()}
                                        <div className="mt-2 space-y-2">
                                          {Array.from(tierMap.entries())
                                            .sort(([a], [b]) => (a ?? 0) - (b ?? 0))
                                            .map(([tierLevel, rows]) => (
                                              <div key={tierLevel}>
                                                <div className="text-xs font-semibold text-gray-600">Tier Level {tierLevel}</div>
                                                {rows.map((r: any, i: number) => (
                                                  <div key={i} className="flex items-center justify-between text-sm text-gray-700">
                                                    <span>{getWizardAgentName(r.agentId)}</span>
                                                    <span className="font-medium text-gray-900">{formatCurrency(r.amount)}</span>
                                                  </div>
                                                ))}
                                              </div>
                                            ))}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}

                                {/* Step 3: Regular rules */}
                                {grouped.allProductsRules.length > 0 && (
                                  <div className="border-l-4 border-oe-primary pl-4 mt-4">
                                    <div className="text-sm font-semibold text-gray-900">All Products</div>
                                    <div className="mt-2 space-y-2">
                                      {grouped.allProductsRules.map(([ruleId, tierMap], idx) => (
                                        <div key={ruleId} className="mb-3 last:mb-0">
                                          {(() => {
                                            const first = Array.from(tierMap.values())[0]?.[0];
                                            const ruleName = first?.ruleName || 'All Products rule';
                                            const priority = first?.priority;
                                            return (
                                              <div className="text-sm font-semibold text-gray-900">
                                                {idx + 1}. {ruleName}{priority != null ? ` (Priority ${priority})` : ''}
                                              </div>
                                            );
                                          })()}
                                          <div className="mt-1 space-y-2">
                                            {Array.from(tierMap.entries())
                                              .sort(([a], [b]) => (a ?? 0) - (b ?? 0))
                                              .map(([tierLevel, rows]) => (
                                                <div key={tierLevel}>
                                                  <div className="text-xs font-semibold text-gray-600">Tier Level {tierLevel}</div>
                                                  {rows.map((r: any, i: number) => (
                                                    <div key={i} className="flex items-center justify-between text-sm text-gray-700">
                                                      <span>{getWizardAgentName(r.agentId)}</span>
                                                      <span className="font-medium text-gray-900">{formatCurrency(r.amount)}</span>
                                                    </div>
                                                  ))}
                                                </div>
                                              ))}
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}

                                {grouped.regularRules.length > 0 && (
                                  <div className="border-l-4 border-oe-primary pl-4 mt-4">
                                    {grouped.regularRules.map(([ruleId, tierMap], idx) => (
                                      <div key={ruleId} className="mb-4 last:mb-0">
                                        {(() => {
                                          const first = Array.from(tierMap.values())[0]?.[0];
                                          const ruleName = first?.ruleName || 'Regular rule';
                                          const priority = first?.priority;
                                          return (
                                            <div className="text-sm font-semibold text-gray-900">
                                              {idx + 1}. {ruleName}{priority != null ? ` (Priority ${priority})` : ''}
                                            </div>
                                          );
                                        })()}
                                        <div className="mt-2 space-y-2">
                                          {Array.from(tierMap.entries())
                                            .sort(([a], [b]) => (a ?? 0) - (b ?? 0))
                                            .map(([tierLevel, rows]) => (
                                              <div key={tierLevel}>
                                                <div className="text-xs font-semibold text-gray-600">Tier Level {tierLevel}</div>
                                                {rows.map((r: any, i: number) => (
                                                  <div key={i} className="flex items-center justify-between text-sm text-gray-700">
                                                    <span>{getWizardAgentName(r.agentId)}</span>
                                                    <span className="font-medium text-gray-900">{formatCurrency(r.amount)}</span>
                                                  </div>
                                                ))}
                                              </div>
                                            ))}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}

                                {/* Step 4: Split rules */}
                                {grouped.splitRules.length > 0 && (
                                  <div className="border-l-4 border-oe-primary pl-4 mt-4">
                                    {grouped.splitRules.map(([ruleId, rows], idx) => (
                                      <div key={ruleId} className="mb-4 last:mb-0">
                                        {(() => {
                                          const first = rows?.[0];
                                          const ruleName = first?.ruleName || 'Split rule';
                                          const priority = first?.priority;
                                          return (
                                            <div className="text-sm font-semibold text-gray-900">
                                              {idx + 1}. {ruleName}{priority != null ? ` (Priority ${priority})` : ''}
                                            </div>
                                          );
                                        })()}
                                        <div className="mt-2 space-y-1">
                                          {rows.map((r: any, i: number) => (
                                            <div key={i} className="flex items-center justify-between text-sm text-gray-700">
                                              <span>{getWizardAgentName(r.agentId)}</span>
                                              <span className="font-medium text-gray-900">
                                                {formatCurrency(r.splitAmount || r.amount)}
                                              </span>
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}

                                {/* Step 5: Excess */}
                                {grouped.excess.length > 0 && (
                                  <div className="border-l-4 border-oe-primary pl-4 mt-4">
                                    <div className="text-sm font-semibold text-gray-900">
                                      {grouped.excess.some((e: any) => e?.isPrimaryAgency) ? 'Primary Agency Overflow' : 'Excess / Overflow'}
                                    </div>
                                    <div className="mt-2 space-y-1">
                                      {grouped.excess.map((e: any, i: number) => (
                                        <div key={i} className="flex items-center justify-between text-sm text-gray-700">
                                          <span>{formatOverflowLabel(e)}</span>
                                          <span className="font-medium text-gray-900">{formatCurrency(e.amount)}</span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}

                                {/* Step 5b: Tier-slot agency payouts (now inline via renderRecipientList) */}
                                </>
                                )}
                              </div>

                              <div className="flex items-center justify-between text-sm text-gray-700">
                                <span className="font-medium text-gray-900">Total to {getWizardAgentName(agentId)}</span>
                                <span className="font-semibold text-gray-900">
                                  {formatCurrency(
                                    (sim.breakdown?.agents || [])
                                      .filter((a: any) => a.agentId === agentId)
                                      .reduce((sum: number, a: any) => sum + Number(a.amount || 0), 0)
                                  )}
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {resultsTab === 'vendor' && pricingResult && (pricingResult.products || []).length > 0 && (
                    <div className="space-y-4">
                      {payoutDestinationsLoading && (
                        <div className="text-sm text-gray-600 flex items-center gap-2">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Loading payout destinations…
                        </div>
                      )}
                      {(pricingResult.products || []).flatMap((p: any) => {
                        const renderVendorCard = (key: string, productName: string, premium: number, sim: any) => {
                          const vendors = (sim?.breakdown?.vendors || []) as any[];
                          const total = vendors.reduce((sum: number, v: any) => sum + Number(v.amount || 0), 0);
                          return (
                            <div key={key} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                              <div className="p-6 border-b border-gray-200">
                                <h2 className="text-lg font-medium text-gray-900">{productName}</h2>
                                <p className="text-gray-600">Premium {formatCurrency(premium || 0)}</p>
                              </div>
                              <div className="p-6 space-y-3">
                                {vendors.length === 0 ? (
                                  <div className="text-sm text-gray-600">No vendor payouts for this simulation.</div>
                                ) : (
                                  <div className="bg-white rounded-lg border border-gray-200 p-4">
                                    <div className="flex items-center justify-between text-sm text-gray-700 mb-2">
                                      <span className="font-semibold text-gray-900">Vendor payouts</span>
                                      <span className="font-semibold text-gray-900">{formatCurrency(total)}</span>
                                    </div>
                                    <div className="space-y-1">
                                      {vendors.map((v: any, i: number) => (
                                        <div key={i} className="flex items-center justify-between text-sm text-gray-700">
                                          <div className="flex flex-col">
                                            <span>{payoutDestinations?.vendors?.[v.vendorId]?.displayName || v.vendorName || v.vendorId || 'Vendor'}</span>
                                            {(() => {
                                              const accounts = payoutDestinations?.vendors?.[v.vendorId]?.achAccounts || [];
                                              if (!Array.isArray(accounts) || accounts.length === 0) {
                                                return <span className="text-xs text-gray-500">(no ACH on file)</span>;
                                              }
                                              const pctSum = accounts.reduce((sum: number, a: any) => sum + Number(a.distributionPercentage || 0), 0);
                                              const usePct = pctSum > 0.0001;
                                              const normalized = usePct
                                                ? accounts.map((a: any) => ({ ...a, pct: Number(a.distributionPercentage || 0) / pctSum }))
                                                : [{ ...(accounts.find((a: any) => a.isDefault) || accounts[0]), pct: 1 }];
                                              return (
                                                <div className="mt-1 space-y-1">
                                                  {normalized.map((a: any, j: number) => (
                                                    <div key={j} className="text-xs text-gray-500 flex items-center justify-between gap-2">
                                                      <span className="truncate">
                                                        {a.bankName || 'Bank'} {a.accountNumberLast4 ? `· ****${a.accountNumberLast4}` : ''}
                                                        {usePct ? ` · ${(a.pct * 100).toFixed(1)}%` : ''}
                                                      </span>
                                                      <span className="shrink-0">
                                                        {formatCurrency(Number(v.amount || 0) * a.pct)}
                                                      </span>
                                                    </div>
                                                  ))}
                                                </div>
                                              );
                                            })()}
                                          </div>
                                          <span className="font-medium text-gray-900">{formatCurrency(v.amount)}</span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        };

                        if (p?.isBundle && Array.isArray(p?.includedProducts) && p.includedProducts.length > 0) {
                          return p.includedProducts.map((inc: any) => {
                            const lineItemId = `${p.productId}::${inc.productId}`;
                            const sim = simulationResults[lineItemId];
                            if (!sim) return null;
                            return renderVendorCard(lineItemId, inc.productName, inc.monthlyPremium || 0, sim);
                          });
                        }

                        const sim = simulationResults[p.productId];
                        if (!sim) return null;
                        return renderVendorCard(p.productId, p.productName, p.monthlyPremium || 0, sim);
                      })}
                    </div>
                  )}

                  {resultsTab === 'overrides' && pricingResult && (pricingResult.products || []).length > 0 && (
                    <div className="space-y-4">
                      {payoutDestinationsLoading && (
                        <div className="text-sm text-gray-600 flex items-center gap-2">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Loading payout destinations…
                        </div>
                      )}
                      {(pricingResult.products || []).flatMap((p: any) => {
                        const renderOverrideCard = (key: string, productName: string, premium: number, sim: any) => {
                          const agentOverrides = ((sim?.breakdown?.agents || []) as any[]).filter((a: any) => a.isOverride);
                          const tenantOverrides = ((sim?.breakdown?.tenants || []) as any[]).filter((t: any) => t.isOverride);
                          const total =
                            agentOverrides.reduce((sum: number, a: any) => sum + Number(a.amount || 0), 0) +
                            tenantOverrides.reduce((sum: number, t: any) => sum + Number(t.amount || 0), 0);

                          return (
                            <div key={key} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                              <div className="p-6 border-b border-gray-200">
                                <h2 className="text-lg font-medium text-gray-900">{productName}</h2>
                                <p className="text-gray-600">Premium {formatCurrency(premium || 0)}</p>
                              </div>
                              <div className="p-6 space-y-3">
                                {(agentOverrides.length === 0 && tenantOverrides.length === 0) ? (
                                  <div className="text-sm text-gray-600">No overrides applied for this simulation.</div>
                                ) : (
                                  <div className="bg-white rounded-lg border border-gray-200 p-4">
                                    <div className="flex items-center justify-between text-sm text-gray-700 mb-2">
                                      <span className="font-semibold text-gray-900">Overrides</span>
                                      <span className="font-semibold text-gray-900">{formatCurrency(total)}</span>
                                    </div>

                                    {agentOverrides.length > 0 && (
                                      <div className="mt-2">
                                        <div className="text-xs font-semibold text-gray-600 mb-1">Agent overrides</div>
                                        <div className="space-y-1">
                                          {agentOverrides.map((o: any, i: number) => (
                                            <div key={i} className="flex items-center justify-between text-sm text-gray-700">
                                              <span>
                                                {o.ruleName || 'Override'} · {getWizardAgentName(o.agentId)}
                                              </span>
                                              <span className="font-medium text-gray-900">{formatCurrency(o.amount)}</span>
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                    )}

                                    {tenantOverrides.length > 0 && (
                                      <div className="mt-3">
                                        <div className="text-xs font-semibold text-gray-600 mb-1">Tenant/Agency overrides</div>
                                        <div className="space-y-1">
                                          {tenantOverrides.map((o: any, i: number) => (
                                            <div key={i} className="flex items-center justify-between text-sm text-gray-700">
                                              <div className="flex flex-col">
                                                <span>
                                                  {o.overrideName || o.ruleName || 'Override'}
                                                </span>
                                                <span className="text-xs text-gray-500">
                                                  {(() => {
                                                    const ach = o?.overrideAchId ? payoutDestinations?.overrideAch?.[o.overrideAchId] : null;
                                                    if (!o?.overrideAchId) return '(no override ACH selected)';
                                                    if (!ach || ach?.missing) return '(override ACH not found)';
                                                    const bank = ach.bankName || 'Bank';
                                                    const acct = ach.maskedAccountNumber ? `· ${ach.maskedAccountNumber}` : '· (no account)';
                                                    return `${bank} ${acct}`;
                                                  })()}
                                                </span>
                                              </div>
                                              <span className="font-medium text-gray-900">{formatCurrency(o.amount)}</span>
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        };

                        if (p?.isBundle && Array.isArray(p?.includedProducts) && p.includedProducts.length > 0) {
                          return p.includedProducts.map((inc: any) => {
                            const lineItemId = `${p.productId}::${inc.productId}`;
                            const sim = simulationResults[lineItemId];
                            if (!sim) return null;
                            return renderOverrideCard(lineItemId, inc.productName, inc.monthlyPremium || 0, sim);
                          });
                        }

                        const sim = simulationResults[p.productId];
                        if (!sim) return null;
                        return renderOverrideCard(p.productId, p.productName, p.monthlyPremium || 0, sim);
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Footer nav */}
          <div className="p-6 border-t border-gray-200 flex items-center justify-between">
            <button
              onClick={onBack}
              disabled={wizardStep === 1}
              className="btn-secondary flex items-center gap-2"
            >
              <ChevronLeft className="h-4 w-4" />
              Back
            </button>
            <button
              onClick={onNext}
              disabled={wizardStep === 4 || !canNext()}
              className="btn-primary flex items-center gap-2"
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60] p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-6xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center gap-3">
            <Calculator className="h-6 w-6 text-oe-primary" />
            <h2 className="text-2xl font-semibold text-gray-900">Commission Simulator</h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* Missing Commissions Warning (SysAdmin only) */}
          {isSysAdmin && missingCommissionsCount !== null && missingCommissionsCount > 0 && (
            <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <AlertTriangle className="h-5 w-5 text-yellow-600" />
                    <h3 className="text-sm font-semibold text-yellow-800">
                      Missing Commissions Detected
                    </h3>
                  </div>
                  <p className="text-sm text-yellow-700">
                    {missingCommissionsCount} payment(s) found without commission rows. These commissions can be generated retroactively using the same logic as the commission trigger.
                  </p>
                </div>
                <button
                  onClick={handleGenerateMissing}
                  disabled={generatingMissing || loadingMissingCount}
                  className="ml-4 px-4 py-2 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {generatingMissing ? 'Generating...' : loadingMissingCount ? 'Loading...' : `Generate Missing Commissions (${missingCommissionsCount})`}
                </button>
              </div>
            </div>
          )}

          {/* Input Section */}
          <div className="bg-gray-50 rounded-lg p-6 mb-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Simulation Parameters</h3>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* SysAdmin: Tenant Selection */}
              {isSysAdmin && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Tenant *
                  </label>
                  <SearchableDropdown
                    options={tenantOptions}
                    value={tenantId}
                    onChange={(value) => {
                      setTenantId(value);
                      setAgentId(''); // Reset agent when tenant changes
                      setCommissionRuleId(''); // Reset rule when tenant changes
                      setAgentActualRuleId(null); // Reset agent's actual rule
                      setSelectedRuleStatus(null); // Reset rule status warning
                      // Reset loaded refs so rules/agents reload for new tenant
                      agentsLoadedRef.current = {};
                      rulesLoadedRef.current = {};
                    }}
                    placeholder="Select tenant"
                    loading={loadingTenants}
                    disabled={simulating}
                  />
                </div>
              )}

              {/* Agent Selection - Required for all roles */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Agent * {isAgent && <span className="text-gray-500 text-xs">(You)</span>}
                </label>
                {isAgent ? (
                  <div className="px-3 py-2 border border-gray-300 rounded-lg bg-gray-50 text-gray-700">
                    {agentOptions.length > 0 ? agentOptions[0].label : 'Loading...'}
                  </div>
                ) : (
                  <SearchableDropdown
                    options={agentOptions}
                    value={agentId}
                    onChange={async (value) => {
                      setAgentId(value);
                      // Reset group when agent changes
                      setGroupId('');
                      setGroupOptions([]);
                      // Fetch agent's assigned commission rule
                      if (value) {
                        await loadAgentCommissionRule(value);
                        await loadGroupsForAgent(value);
                      } else {
                        setCommissionRuleId('');
                        setAgentActualRuleId(null);
                      }
                    }}
                    placeholder="Select an agent..."
                    searchPlaceholder="Search agents by name or email..."
                    loading={loadingAgents}
                    disabled={simulating || (isSysAdmin && !tenantId)}
                    showEmail={true}
                    multiLine={true}
                    className="w-full"
                    onSearch={handleAgentSearch}
                    useBackendSearch={true}
                  />
                )}
              </div>

              {/* TenantAdmin/SysAdmin: Commission Rule Selection */}
              {(isTenantAdmin || isSysAdmin) && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Commission Rule *
                  </label>
                  <SearchableDropdown
                    options={ruleOptions}
                    value={commissionRuleId}
                    onChange={(value) => {
                      setCommissionRuleId(value);
                      // Find the selected rule to show its status
                      const selectedRule = ruleOptions.find(r => r.value === value);
                      setSelectedRuleStatus(selectedRule?.ruleStatus || null);
                    }}
                    placeholder="Select commission rule"
                    loading={loadingRules}
                    disabled={simulating || (isSysAdmin && !tenantId)}
                  />
                  {/* Combined warning for unlocked rule and/or different rule from agent's default */}
                  {((selectedRuleStatus && selectedRuleStatus.includes('Not Active')) || 
                    (agentId && commissionRuleId && agentActualRuleId && commissionRuleId !== agentActualRuleId)) && (
                    <div className="mt-2 p-2 alert-warning rounded-lg">
                      <p className="text-sm">
                        {selectedRuleStatus && selectedRuleStatus.includes('Not Active') && (
                          <>
                            <span className="font-semibold">⚠️ Warning:</span> This rule is <strong>not active</strong> (unlocked). 
                            Commission calculations will not use this rule in production until it is locked.
                            {agentId && commissionRuleId && agentActualRuleId && commissionRuleId !== agentActualRuleId && <><br /><br /></>}
                          </>
                        )}
                        {agentId && commissionRuleId && agentActualRuleId && commissionRuleId !== agentActualRuleId && (
                          <>
                            <span className="font-semibold">Note:</span> For this simulation, the agent's default commission rule will be different than their actual assigned rule.
                          </>
                        )}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Commission Amount */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Allocated Commission Amount *
                </label>
                <div className="relative">
                  <DollarSign className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={allocatedCommissionAmount}
                    onChange={(e) => setAllocatedCommissionAmount(e.target.value)}
                    className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    placeholder="0.00"
                    disabled={simulating}
                  />
                </div>
              </div>

              {/* Payment Date */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Payment Date
                </label>
                <input
                  type="date"
                  value={paymentDate}
                  onChange={(e) => setPaymentDate(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  disabled={simulating}
                />
              </div>

              {/* Products Multi-Select (Optional) */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Products (Optional)
                </label>
                <p className="text-xs text-gray-500 mb-2">
                  Select products to see which product-specific rules apply
                </p>
                <div className="border border-gray-300 rounded-lg max-h-48 overflow-y-auto p-3 bg-white">
                  {loadingProducts ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
                      <span className="ml-2 text-sm text-gray-500">Loading products...</span>
                    </div>
                  ) : productOptions.length === 0 ? (
                    <p className="text-sm text-gray-500 py-2">No products available</p>
                  ) : (
                    <div className="space-y-2">
                      {productOptions.map((product) => (
                        <label
                          key={product.id}
                          className="flex items-center gap-2 cursor-pointer hover:bg-gray-50 p-2 rounded"
                        >
                          <input
                            type="checkbox"
                            checked={selectedProductIds.includes(product.value)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedProductIds([...selectedProductIds, product.value]);
                              } else {
                                setSelectedProductIds(selectedProductIds.filter(id => id !== product.value));
                              }
                            }}
                            className="w-4 h-4 text-oe-primary border-gray-300 rounded focus:ring-oe-primary"
                            disabled={simulating}
                          />
                          <span className="text-sm text-gray-700">{product.label}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
                {selectedProductIds.length > 0 && (
                  <p className="text-xs text-gray-500 mt-1">
                    {selectedProductIds.length} product{selectedProductIds.length !== 1 ? 's' : ''} selected
                  </p>
                )}
              </div>
              
              {/* Product Tier Selection */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Product Tier (Optional)
                </label>
                <p className="text-xs text-gray-500 mb-2">
                  Select a product tier code to see tier-specific commission amounts (EE, ES, EC, EF)
                </p>
                <select
                  value={productTier}
                  onChange={(e) => setProductTier(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  disabled={simulating}
                >
                  <option value="">All Product Tiers (Base Rate)</option>
                  <option value="EE">EE (Employee Only)</option>
                  <option value="ES">ES (Employee + Spouse)</option>
                  <option value="EC">EC (Employee + Children)</option>
                  <option value="EF">EF (Employee + Family)</option>
                </select>
              </div>

              {/* Group Selection (Optional) */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Group (Optional)
                </label>
                <p className="text-xs text-gray-500 mb-2">
                  Select a group to test split commission rules for groups
                </p>
                <SearchableDropdown
                  options={groupOptions}
                  value={groupId}
                  onChange={(value) => setGroupId(value)}
                  placeholder="Select a group (optional)"
                  loading={loadingGroups}
                  disabled={simulating || !agentId}
                />
              </div>
              
            </div>

            {error && (
              <div className="mt-4 alert-error px-4 py-3 rounded-lg">
                {error}
              </div>
            )}

            <div className="mt-6">
              <button
                onClick={handleSimulate}
                disabled={simulating || (isSysAdmin && !tenantId) || !allocatedCommissionAmount}
                className="w-full md:w-auto px-6 py-2 btn-primary flex items-center justify-center gap-2"
              >
                {simulating ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Simulating...
                  </>
                ) : (
                  <>
                    <Calculator className="h-4 w-4" />
                    Run Simulation
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Results Section - Step by Step Breakdown */}
          {result && breakdownSteps && (
            <div className="space-y-4">
              {result.breakdown?.overflowDestinationMissing && (
                <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 rounded-lg p-3 flex items-start gap-2">
                  <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
                  <div className="text-sm">
                    {isAgent ? (
                      <p>
                        <span className="font-medium">Warning:</span> your tenant has no primary agency, so any
                        overflow on this scenario won&apos;t be paid out — please contact your admin.
                      </p>
                    ) : (
                      <p>
                        <span className="font-medium">Warning:</span> this tenant has no primary agency.
                        {' '}{formatCurrency(result.overflowToProductOwner || 0)} of overflow commission has no destination and will not be paid out.
                      </p>
                    )}
                  </div>
                </div>
              )}
              {/* Step-by-Step Processing */}
              <div className="bg-white border border-gray-200 rounded-lg p-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                  <TrendingUp className="h-5 w-5 text-oe-primary" />
                  Step-by-Step Commission Processing
                </h3>
                
                <div className="space-y-4">
                  {/* Step 1: Commission Overrides */}
                  {breakdownSteps.commissionOverrides.length > 0 && (
                    <div className="border-l-4 border-oe-primary pl-4">
                      {breakdownSteps.commissionOverrides.map(([ruleId, overrides], ruleIdx) => {
                        const firstOverride = overrides[0];
                        const ruleName = firstOverride?.ruleName || `Commission Override ${ruleIdx + 1}`;
                        const ruleReason = firstOverride?.ruleReason || 'Commission Override';
                        return (
                          <div key={ruleId} className="mb-6 pb-6 border-b border-gray-200 last:border-b-0 last:mb-0 last:pb-0">
                            <div className="flex gap-4">
                              <div className="flex-shrink-0 w-8 text-gray-500 font-semibold">
                                {ruleIdx + 1}.
                              </div>
                              <div className="flex-1">
                                <div className="font-semibold text-gray-900 mb-1">
                                  "{ruleName}"
                                </div>
                                <div className="text-sm text-gray-500 mb-3 italic">
                                  ({ruleReason})
                                </div>
                                {overrides.map((override: any, idx: number) => {
                                  // Try to get agent name from options
                                  const agentOption = agentOptions.find(a => a.value === override.agentId);
                                  const agentName = agentOption?.label || allAgentNames.get(override.agentId) || `Agent ${override.agentId.substring(0, 8)}`;
                                  return (
                                    <div key={idx} className="ml-4 text-gray-700 flex justify-between items-center mb-2">
                                      <span>{agentName}</span>
                                      <span className="ml-4 text-xl font-semibold text-gray-900">{formatCurrency(override.amount)}</span>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Step 2: Agent-Specific Rule */}
                  {breakdownSteps.agentSpecific.length > 0 && (
                    <div className="border-l-4 border-oe-primary pl-4">
                      {breakdownSteps.agentSpecific.map(([ruleId, tierMap]) => {
                        const firstEntry = Array.from(tierMap.values())[0]?.[0];
                        const ruleName = firstEntry?.ruleName || 'Agent-Specific Rule';
                        const isDefaultRule = firstEntry?.isAgentSpecific === true;
                        const commissionType = firstEntry?.commissionType || '';
                        const priority = firstEntry?.priority;
                        const totalForRule = Array.from(tierMap.values()).flat().reduce((sum: number, a: any) => sum + a.amount, 0);
                        const stepNum = breakdownSteps.commissionOverrides.length + 1;
                        const allTiers = Array.from(tierMap.entries()).sort(([levelA], [levelB]) => (levelA ?? 0) - (levelB ?? 0));
                        // For tiered commission type, always show as tiered structure
                        const isTiered = commissionType === 'Tiered' || allTiers.length > 1 || (allTiers.length === 1 && allTiers[0][0] !== 0);
                        
                        // Calculate percentage or show flat rate
                        let rateDisplay = '';
                        if (commissionType === 'Percentage') {
                          const percentage = result.allocatedCommissionAmount > 0 
                            ? ((totalForRule / result.allocatedCommissionAmount) * 100).toFixed(1)
                            : '0';
                          rateDisplay = `${percentage}%`;
                        } else if (commissionType === 'Flat') {
                          rateDisplay = 'Flat Rate';
                        } else if (commissionType === 'Tiered') {
                          rateDisplay = 'Tiered';
                        }
                        
                        return (
                          <div key={ruleId} className="mb-6 pb-6 border-b border-gray-200 last:border-b-0 last:mb-0 last:pb-0">
                            <div className="flex gap-4">
                              <div className="flex-shrink-0 w-8 text-gray-500 font-semibold">
                                {stepNum}.
                              </div>
                              <div className="flex-1">
                                <div className="font-semibold text-gray-900 mb-1">
                                  "{ruleName}" {rateDisplay && `(${rateDisplay})`}
                                  {isDefaultRule && (
                                    <span className="ml-2 text-xs font-normal text-gray-500 bg-gray-100 px-2 py-0.5 rounded">
                                      Assigned Commission Rule
                                    </span>
                                  )}
                                  {priority != null && (
                                    <span className="ml-2 text-xs font-normal text-oe-primary bg-blue-50 px-2 py-0.5 rounded">
                                      Priority {priority}
                                    </span>
                                  )}
                                </div>
                                {/* Show tier levels or single agent */}
                                {allTiers.map(([tierLevel, agents]) => {
                                  // Get tier label using centralized function
                                  const tierLabel = getTierLevelLabel(tierLevel);
                                  
                                  // Get tier rate from CommissionJson (with product tier if specified)
                                  const tierRate = getTierRate(ruleId, tierLevel, productTier || undefined);
                                  const tierLabelWithRate = tierRate ? `${tierLabel} (${tierRate})` : tierLabel;
                                  
                                  return (
                                    <div key={tierLevel} className="ml-4 text-gray-700 mb-2">
                                      {agents.map((agent: any, idx: number) => {
                                        const agentName = allAgentNames.get(agent.agentId) || agentOptions.find(a => a.value === agent.agentId)?.label || `Agent ${agent.agentId.substring(0, 8)}`;
                                        return (
                                          <div key={idx} className="flex justify-between items-center mb-1">
                                            <span>{isTiered ? `${tierLabelWithRate}: ${agentName}` : agentName}</span>
                                            <span className="ml-4 text-xl font-semibold text-gray-900">{formatCurrency(agent.amount)}</span>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Step 3: Regular Rules */}
                  {breakdownSteps.regularRules.length > 0 && (
                    <div className="border-l-4 border-oe-primary pl-4">
                      {breakdownSteps.regularRules.map(([ruleId, tierMap], ruleIdx) => {
                        const firstEntry = Array.from(tierMap.values())[0]?.[0];
                        const ruleName = firstEntry?.ruleName || `Rule ${ruleIdx + 1}`;
                        const commissionType = firstEntry?.commissionType || '';
                        const priority = firstEntry?.priority;
                        const totalForRule = Array.from(tierMap.values()).flat().reduce((sum: number, a: any) => sum + a.amount, 0);
                        const stepNum = breakdownSteps.commissionOverrides.length + breakdownSteps.agentSpecific.length + ruleIdx + 1;
                        const allTiers = Array.from(tierMap.entries()).sort(([levelA], [levelB]) => (levelA ?? 0) - (levelB ?? 0));
                        // For tiered commission type, always show as tiered structure
                        const isTiered = commissionType === 'Tiered' || allTiers.length > 1 || (allTiers.length === 1 && allTiers[0][0] !== 0);
                        
                        // Calculate percentage or show flat rate
                        let rateDisplay = '';
                        if (commissionType === 'Percentage') {
                          const percentage = result.allocatedCommissionAmount > 0 
                            ? ((totalForRule / result.allocatedCommissionAmount) * 100).toFixed(1)
                            : '0';
                          rateDisplay = `${percentage}%`;
                        } else if (commissionType === 'Flat') {
                          rateDisplay = 'Flat Rate';
                        } else if (commissionType === 'Tiered') {
                          rateDisplay = 'Tiered';
                        }
                        
                        return (
                          <div key={ruleId} className="mb-6 pb-6 border-b border-gray-200 last:border-b-0 last:mb-0 last:pb-0">
                            <div className="flex gap-4">
                              <div className="flex-shrink-0 w-8 text-gray-500 font-semibold">
                                {stepNum}.
                              </div>
                              <div className="flex-1">
                                <div className="font-semibold text-gray-900 mb-1">
                                  "{ruleName}" {rateDisplay && `(${rateDisplay})`}
                                  {priority != null && (
                                    <span className="ml-2 text-xs font-normal text-oe-primary bg-blue-50 px-2 py-0.5 rounded">
                                      Priority {priority}
                                    </span>
                                  )}
                                </div>
                                {/* Show tier levels or single agent */}
                                {allTiers.map(([tierLevel, agents]) => {
                                  // Get tier label using centralized function
                                  const tierLabel = getTierLevelLabel(tierLevel);
                                  
                                  // Get tier rate from CommissionJson (with product tier if specified)
                                  const tierRate = getTierRate(ruleId, tierLevel, productTier || undefined);
                                  const tierLabelWithRate = tierRate ? `${tierLabel} (${tierRate})` : tierLabel;
                                  
                                  return (
                                    <div key={tierLevel} className="ml-4 text-gray-700 mb-2">
                                      {agents.map((agent: any, idx: number) => {
                                        const agentName = allAgentNames.get(agent.agentId) || agentOptions.find(a => a.value === agent.agentId)?.label || `Agent ${agent.agentId.substring(0, 8)}`;
                                        return (
                                          <div key={idx} className="flex justify-between items-center mb-1">
                                            <span>{isTiered ? `${tierLabelWithRate}: ${agentName}` : agentName}</span>
                                            <span className="ml-4 text-xl font-semibold text-gray-900">{formatCurrency(agent.amount)}</span>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Step 4: Split Rules */}
                  {breakdownSteps.splitRules.length > 0 && (
                    <div className="border-l-4 border-oe-primary pl-4">
                      {breakdownSteps.splitRules.map(([ruleId, splits], ruleIdx) => {
                        const firstSplit = splits[0];
                        const ruleName = firstSplit?.ruleName || `Split Rule ${ruleIdx + 1}`;
                        const ruleReason = firstSplit?.ruleReason || 'Split Rule';
                        const stepNum = breakdownSteps.commissionOverrides.length + breakdownSteps.agentSpecific.length + breakdownSteps.regularRules.length + ruleIdx + 1;
                        
                        return (
                          <div key={ruleId} className="mb-6 pb-6 border-b border-gray-200 last:border-b-0 last:mb-0 last:pb-0">
                            <div className="flex gap-4">
                              <div className="flex-shrink-0 w-8 text-gray-500 font-semibold">
                                {stepNum}.
                              </div>
                              <div className="flex-1">
                                <div className="font-semibold text-gray-900 mb-1">
                                  "{ruleName}"
                                </div>
                                <div className="text-sm text-gray-500 mb-3 italic">
                                  ({ruleReason})
                                </div>
                                {splits.map((split: any, idx: number) => {
                                  const agentOption = agentOptions.find(a => a.value === split.agentId);
                                  const agentName = agentOption?.label || allAgentNames.get(split.agentId) || `Agent ${split.agentId.substring(0, 8)}`;
                                  
                                  // Show different text for primary agent vs split partner
                                  if (split.isPrimaryInSplit) {
                                    // Primary agent - show their remaining amount after split
                                    const splitPartnerOption = agentOptions.find(a => a.value === split.splitPartnerId);
                                    const splitPartnerName = splitPartnerOption?.label || allAgentNames.get(split.splitPartnerId) || `Agent ${split.splitPartnerId?.substring(0, 8)}`;
                                    return (
                                      <div key={idx} className="ml-4 text-gray-700 flex justify-between items-center mb-2">
                                        <span>
                                          {agentName} 
                                          <span className="text-gray-500 text-sm ml-2">
                                            (primary - split {split.splitPercentage ? `${(split.splitPercentage * 100).toFixed(1)}%` : ''} to {splitPartnerName})
                                          </span>
                                        </span>
                                        <span className="ml-4 text-xl font-semibold text-gray-900">{formatCurrency(split.amount)}</span>
                                      </div>
                                    );
                                  } else {
                                    // Split partner - show who they got the split from
                                    const splitFromName = split.splitFromAgentId 
                                      ? (agentOptions.find(a => a.value === split.splitFromAgentId)?.label || allAgentNames.get(split.splitFromAgentId) || `Agent ${split.splitFromAgentId.substring(0, 8)}`)
                                      : 'primary agent';
                                    return (
                                      <div key={idx} className="ml-4 text-gray-700 flex justify-between items-center mb-2">
                                        <span>
                                          {agentName} 
                                          <span className="text-gray-500 text-sm ml-2">
                                            (split {split.splitPercentage ? `${(split.splitPercentage * 100).toFixed(1)}%` : ''} from {splitFromName})
                                          </span>
                                        </span>
                                        <span className="ml-4 text-xl font-semibold text-gray-900">{formatCurrency(split.splitAmount || split.amount)}</span>
                                      </div>
                                    );
                                  }
                                })}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Step 5: Excess to Product Owner (Last Step) - Hidden for Agents */}
                  {!isAgent && breakdownSteps.remainingAmount > 0 && (
                    <div className="border-l-4 border-yellow-400 pl-4 mt-4">
                      <div className="flex gap-4">
                        <div className="flex-shrink-0 w-8 text-gray-500 font-semibold">
                          {breakdownSteps.commissionOverrides.length + breakdownSteps.agentSpecific.length + breakdownSteps.regularRules.length + breakdownSteps.splitRules.length + 1}.
                        </div>
                        <div className="flex-1">
                          <div className="font-semibold text-gray-900 mb-1">
                            Excess to Product Owner
                          </div>
                          <div className="ml-4 text-gray-700 flex justify-between items-center mt-2">
                            <span>Excess to Product Owner</span>
                            <span className="ml-4 text-xl font-semibold text-gray-900">{formatCurrency(breakdownSteps.remainingAmount)}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Agent-to-agent commission overrides applied to this simulation */}
              {result && Array.isArray(result.agentOverrides) && result.agentOverrides.length > 0 && (
                <div className="bg-white border border-blue-200 rounded-lg overflow-hidden">
                  <div className="bg-blue-50 px-6 py-4 border-b border-blue-200">
                    <h3 className="text-lg font-semibold text-blue-900">Agent overrides applied</h3>
                    <p className="text-sm text-blue-800 mt-1">
                      Portions of one agent&apos;s per-payment commission redirected to another agent. These adjustments would be created as paired negative/positive commission rows on generation.
                    </p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">From</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">To</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
                          <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Amount</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {result.agentOverrides.map((ov) => {
                          const sourceName =
                            allAgentNames.get(ov.sourceAgentId) ||
                            agentOptions.find((a) => a.value === ov.sourceAgentId)?.label ||
                            ov.sourceAgentName ||
                            `Agent ${ov.sourceAgentId.substring(0, 8)}`;
                          const recipientName =
                            allAgentNames.get(ov.recipientAgentId) ||
                            agentOptions.find((a) => a.value === ov.recipientAgentId)?.label ||
                            ov.recipientAgentName ||
                            `Agent ${ov.recipientAgentId.substring(0, 8)}`;
                          return (
                          <tr key={ov.overrideId}>
                            <td className="px-4 py-2 text-sm text-gray-900">
                              {sourceName}
                            </td>
                            <td className="px-4 py-2 text-sm text-gray-900">
                              {recipientName}
                            </td>
                            <td className="px-4 py-2 text-sm text-gray-600">{ov.overrideType}</td>
                            <td
                              className={`px-4 py-2 text-sm text-right font-medium ${
                                ov.skipped ? 'text-gray-400 line-through' : 'text-green-700'
                              }`}
                            >
                              {formatCurrency(ov.amount)}
                            </td>
                            <td className="px-4 py-2 text-sm">
                              {ov.skipped ? (
                                <span
                                  className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-yellow-100 text-yellow-800"
                                  title={ov.skipReason}
                                >
                                  Skipped
                                </span>
                              ) : (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-800">
                                  Applied
                                </span>
                              )}
                            </td>
                          </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Summary Stats */}
              <div className="bg-white border border-gray-200 rounded-lg p-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Summary</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className="bg-oe-primary-light p-4 rounded-lg">
                    <div className="text-sm text-gray-600">Total Commission Allocated</div>
                    <div className="text-2xl font-bold text-oe-primary">
                      {formatCurrency(result.allocatedCommissionAmount)}
                    </div>
                  </div>
                  <div className="bg-green-50 p-4 rounded-lg">
                    <div className="text-sm text-gray-600">Total Commissions Paid</div>
                    <div className="text-2xl font-bold text-oe-success">
                      {formatCurrency(result.totalCommissionsPaid)}
                    </div>
                  </div>
                  {(() => {
                    // Calculate leftover: allocated - paid
                    const leftover = result.allocatedCommissionAmount - result.totalCommissionsPaid;
                    return leftover > 0 ? (
                      <div className="bg-orange-50 p-4 rounded-lg">
                        <div className="text-sm text-gray-600">Total Commission Leftover</div>
                        <div className="text-2xl font-bold text-orange-600">
                          {formatCurrency(leftover)}
                        </div>
                      </div>
                    ) : null;
                  })()}
                  {!isAgent && result.overflowToProductOwner > 0 && (
                    <div className="bg-yellow-50 p-4 rounded-lg">
                      <div className="text-sm text-gray-600">Excess to Product Owner</div>
                      <div className="text-2xl font-bold text-yellow-600">
                        {formatCurrency(result.overflowToProductOwner)}
                      </div>
                    </div>
                  )}
                </div>
              </div>

            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default CommissionSimulator;

