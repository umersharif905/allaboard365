// src/components/commissions/RuleCreationWizard.tsx
import {
    NavigateBefore as BackIcon,
    Check as CheckIcon,
    Close as CloseIcon,
    NavigateNext as NextIcon,
} from '@mui/icons-material';
import {
    Alert,
    Box,
    Button,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    List,
    ListItemButton,
    ListItemText,
    Snackbar,
    Step,
    StepLabel,
    Stepper,
    TextField,
    Tooltip,
    Typography,
} from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import React, { useMemo, useState, useEffect } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import { commissionGroupsService } from '../../services/commissionGroups.service';
import { commissionRuleService } from '../../services/commissionRules.service';
import { apiService } from '../../services/api.service';
import { useCommissionLevels } from '../../hooks/useCommissionLevels';

// Import step components
import { AdvancedSettingsStep } from './steps/AdvancedSettingsStep';
import { CommissionConfigurationStep } from './steps/CommissionConfigurationStep';
import { CommissionGroupsStep } from './steps/CommissionGroupsStep';
import { ProductAndRuleSetupStep } from './steps/ProductAndRuleSetupStep';
import { ReviewStep } from './steps/ReviewStep';
import {
  COMMISSION_NESTED_DIALOG_Z,
  COMMISSION_WIZARD_DIALOG_Z,
  commissionDialogSlotProps,
} from './commissionDialogZIndex';
import CommissionRuleAIAssistant, {
    type AIProposalPatch,
} from './ai/CommissionRuleAIAssistant';
import { mergeAiPatchIntoTiers } from '../../utils/commissionAiMerge';

// Types
export interface RuleCreationFormData {
  // Step 1: Product Selection
  productId: string;
  productName: string;
  productType: string;
  
  // Step 2: Rule Type
  ruleName: string;
  // Scope is controlled by Commission Groups; rule authoring does not support agent/agency-specific rules.
  entityType: 'Tier' | 'Split';
  entityId?: string | null; // For agent/agency-scoped rules (e.g. from duplicate)
  tierLevel?: number;
  priority: number;
  commissionType: 'Percentage' | 'Flat' | 'Tiered' | 'Split';
  description: string;
  // Tenant selection for SysAdmin
  tenantId?: string;
  // Group selection for Split commission rules
  groupId?: string;
  
  // Step 3: Commission Configuration
  rate?: number;
  amount?: number;
  // Type for tier configuration (flatrate or percentage)
  type?: 'flatrate' | 'percentage';
  tiers?: {
    level: number;
    name: string;
    rate?: number; // For percentage type
    flatAmount?: number; // For flatrate type (base amount, used if product tiers not specified)
    productTiers?: {
      EE?: { rate?: number; flatAmount?: number };
      ES?: { rate?: number; flatAmount?: number };
      EC?: { rate?: number; flatAmount?: number };
      EF?: { rate?: number; flatAmount?: number };
    };
  }[];
  // Split commission configuration
  splitCommission?: {
    primaryAgentId: string;
    primaryAgentName?: string;
    primaryAgentPercentage?: number;
    agents: Array<{
      agentId: string;
      agentName?: string;
      percentage: number;
      flatAmount?: number;
    }>;
  };
  // Product-tier specific rates
  productTiers?: {
    EE?: { rate?: number; flatAmount?: number };
    ES?: { rate?: number; flatAmount?: number };
    EC?: { rate?: number; flatAmount?: number };
    EF?: { rate?: number; flatAmount?: number };
  };
  
  // Step 4: Advanced Settings
  effectiveDate: Date;
  terminationDate?: Date | null;
  renewable: boolean;
  yearlySchedule?: {
    year: number;
    rate?: number;
    amount?: number;
  }[];
  stateOverrides?: Record<string, {
    rate?: number;
    amount?: number;
  }>;
  bonusEligible: boolean;
  bonusThresholds?: {
    threshold: number;
    bonusRate: number;
  }[];
  notes?: string;
  locked?: boolean;
  // Step: Commission Groups (create only)
  commissionGroupIds?: string[];
  addToAllGroups?: boolean;
}

interface CommissionRule {
  RuleId: string;
  RuleName: string;
  ProductId?: string;
  ProductName?: string;
  EntityType: 'Agent' | 'Agency' | 'Tier' | 'Split';
  EntityId?: string;
  agencyId?: string;
  agentid?: string;
  TierLevel?: number;
  CommissionType: 'Percentage' | 'Flat' | 'Tiered' | 'Split';
  CommissionRate?: number;
  FlatAmount?: number;
  CommissionJson?: string;
  EffectiveDate: string;
  TerminationDate?: string;
  Priority: number;
  Status: 'Active' | 'Inactive' | 'Pending' | 'Deleted';
  TenantId?: string;
  GroupId?: string;
  GroupName?: string;
  Locked?: boolean | number;
}

interface RuleCreationWizardProps {
  open: boolean;
  onClose: () => void;
  onRuleCreated: (rule: any) => void;
  rule?: CommissionRule | null; // Optional rule for edit mode
  initialEntityType?: 'Tier' | 'Split'; // Initial entity type for new rules
  initialEntityId?: string; // Initial entity ID for new rules
}

// Get current user info from localStorage
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

// Step definitions (will be updated based on edit mode)
const getSteps = (isEdit: boolean) => [
  'Product & Rule',
  'Commission',
  'Dates',
  ...(isEdit ? [] : ['Groups']),
  'Review',
];

/** Map API commission rule → wizard form (same shape as edit preload). */
export function mapCommissionRuleToFormData(editRule: CommissionRule): RuleCreationFormData {
  let commissionJson: any = {};
  if (editRule.CommissionJson) {
    commissionJson =
      typeof editRule.CommissionJson === 'string'
        ? JSON.parse(editRule.CommissionJson)
        : editRule.CommissionJson;
  }

  const entityIdForForm =
    editRule.EntityType === 'Agency'
      ? (editRule.agencyId ?? editRule.EntityId)
      : editRule.EntityType === 'Agent'
        ? (editRule.agentid ?? editRule.EntityId)
        : editRule.EntityId;

  return {
    productId: editRule.ProductId ?? '',
    productName: editRule.ProductName || '',
    productType: '',
    ruleName: editRule.RuleName,
    entityType:
      editRule.EntityType === 'Agent' || editRule.EntityType === 'Agency' ? 'Tier' : editRule.EntityType,
    entityId: entityIdForForm || undefined,
    tierLevel: editRule.TierLevel,
    priority: editRule.Priority,
    commissionType: editRule.CommissionType,
    description: commissionJson.description || '',
    tenantId: editRule.TenantId || '',
    groupId: editRule.GroupId || '',
    rate: editRule.CommissionRate,
    amount: editRule.FlatAmount,
    type: commissionJson.type || 'flatrate',
    tiers: commissionJson.tiers || [],
    splitCommission: commissionJson.splitCommission,
    productTiers: commissionJson.productTiers,
    effectiveDate: new Date(editRule.EffectiveDate),
    terminationDate: editRule.TerminationDate ? new Date(editRule.TerminationDate) : null,
    renewable: commissionJson.renewable || false,
    yearlySchedule: commissionJson.yearlySchedule || [],
    stateOverrides: commissionJson.stateOverrides || {},
    bonusEligible: commissionJson.bonusEligible || false,
    bonusThresholds: commissionJson.bonusThresholds || [],
    notes: commissionJson.notes || '',
    locked: Boolean(editRule.Locked),
    commissionGroupIds: [],
    addToAllGroups: false,
  };
}

export const RuleCreationWizard: React.FC<RuleCreationWizardProps> = ({
  open,
  onClose,
  onRuleCreated,
  rule: editRule,
  initialEntityType,
  initialEntityId,
}) => {
  const [activeStep, setActiveStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyFromModalOpen, setCopyFromModalOpen] = useState(false);
  const [copyRulesAll, setCopyRulesAll] = useState<CommissionRule[]>([]);
  const [copyRulesLoading, setCopyRulesLoading] = useState(false);
  const [copySearch, setCopySearch] = useState('');
  const [selectedCopyRuleId, setSelectedCopyRuleId] = useState('');
  const [copyApplyLoading, setCopyApplyLoading] = useState(false);
  const [copyInfoMessage, setCopyInfoMessage] = useState<string | null>(null);
  const [aiAssistantOpen, setAiAssistantOpen] = useState(false);
  const [aiAssistantAvailable, setAiAssistantAvailable] = useState(false);
  const [applySnack, setApplySnack] = useState<string | null>(null);
  const isEditMode = !!editRule;
  const isLocked = editRule?.Locked === true || editRule?.Locked === 1;
  
  const currentUser = getCurrentUser();

  // Initialize form with React Hook Form
  const methods = useForm<RuleCreationFormData>({
    mode: 'onChange',
    defaultValues: {
      productId: '',
      productName: '',
      productType: '',
      ruleName: '',
      entityType: initialEntityType || 'Tier',
      entityId: initialEntityId || undefined,
      tierLevel: 0,
      priority: 999,
      commissionType: 'Tiered',
      description: '',
      // Auto-set tenant for TenantAdmin, leave empty for SysAdmin
      // Use currentTenantId (active tenant) to support tenant switching
      tenantId: currentUser.roles.includes('TenantAdmin') ? (localStorage.getItem('currentTenantId') || localStorage.getItem('tenantId') || '') : '',
      groupId: '',
      rate: 0,
      amount: 0,
      type: 'flatrate',
      tiers: [],
      splitCommission: undefined,
      productTiers: undefined,
      effectiveDate: new Date(),
      terminationDate: null,
      renewable: false,
      yearlySchedule: [],
      stateOverrides: {},
      bonusEligible: false,
      bonusThresholds: [],
      notes: '',
      locked: false,
      commissionGroupIds: [],
      addToAllGroups: false,
    },
  });

  const { handleSubmit, reset, watch, setValue, getValues } = methods;

  const watchedTenantId = watch('tenantId');
  const tiersWatch = watch('tiers');
  const typeWatch = watch('type');
  const commissionTypeWatch = watch('commissionType');
  const isSysAdminUser = currentUser.roles.includes('SysAdmin');
  const { levels: commissionLevels } = useCommissionLevels({
    tenantId: isSysAdminUser ? watchedTenantId || undefined : undefined,
  });

  const tenantTierLevelsForAi = useMemo(() => {
    return commissionLevels
      .filter((level) => level.IsActive !== false)
      .map((level) => ({
        level: Number(level.SortOrder),
        name: String(level.DisplayName || `Level ${level.SortOrder}`),
      }))
      .filter((t) => Number.isFinite(t.level))
      .sort((a, b) => a.level - b.level);
  }, [commissionLevels]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiService.get<{ success?: boolean; available?: boolean }>(
          '/api/ai/commission-rule-assistant/status'
        );
        if (!cancelled) setAiAssistantAvailable(Boolean(res.available));
      } catch {
        if (!cancelled) setAiAssistantAvailable(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleAIApply = (patch: AIProposalPatch) => {
    setValue('commissionType', 'Tiered', { shouldDirty: true });
    setValue('type', patch.mode, { shouldDirty: true });

    const merged = mergeAiPatchIntoTiers(getValues('tiers'), patch, tenantTierLevelsForAi);

    setValue('tiers', merged, { shouldDirty: true, shouldValidate: true });

    const steps = getSteps(isEditMode);
    const configStepIndex = steps.findIndex((s) => s === 'Commission' || s.startsWith('Commission'));
    if (configStepIndex >= 0) setActiveStep(configStepIndex);

    const sanitizedLevels = new Set(patch.tiers.map((t) => t.level).filter((l) => tenantTierLevelsForAi.some((x) => x.level === l)));
    const updatedCount = sanitizedLevels.size;
    setApplySnack(
      `AI updated ${updatedCount} tier row${updatedCount === 1 ? '' : 's'}; other tiers unchanged. Review and Save.`
    );
  };

  // Populate form when editing an existing rule or when dialog opens
  useEffect(() => {
    // Only run when dialog opens or editRule changes
    if (!open) return;

    if (editRule) {
      try {
        reset(mapCommissionRuleToFormData(editRule));
        setActiveStep(0);
      } catch (err) {
        console.error('Error parsing rule data for edit:', err);
        setError('Failed to load rule data for editing');
      }
    } else {
      // Reset form when creating new rule
      // Always use currentTenantId (active tenant) to support tenant switching
      const activeTenantId = localStorage.getItem('currentTenantId') || localStorage.getItem('tenantId');
      const defaultTenantId = currentUser.roles.includes('TenantAdmin') ? activeTenantId || '' : '';
      reset({
        productId: '',
        productName: '',
        productType: '',
        ruleName: '',
      entityType: initialEntityType || 'Tier',
        entityId: initialEntityId || undefined,
        tierLevel: 0,
        priority: 999,
        commissionType: 'Tiered',
        description: '',
        tenantId: defaultTenantId,
        groupId: '',
        rate: 0,
        amount: 0,
        type: 'flatrate',
        tiers: [],
        splitCommission: undefined,
        productTiers: undefined,
        effectiveDate: new Date(),
        terminationDate: null,
        renewable: false,
        yearlySchedule: [],
        stateOverrides: {},
        bonusEligible: false,
        bonusThresholds: [],
        notes: '',
        locked: false,
        commissionGroupIds: [],
        addToAllGroups: false,
      });
      setActiveStep(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editRule?.RuleId, initialEntityType, initialEntityId]); // Depend on open state, rule ID, and initial values

  useEffect(() => {
    if (!copyFromModalOpen) return;
    setCopySearch('');
    setSelectedCopyRuleId('');
  }, [copyFromModalOpen]);

  useEffect(() => {
    if (!open || !copyFromModalOpen) return;
    let cancelled = false;
    (async () => {
      setCopyRulesLoading(true);
      try {
        const rules = await commissionRuleService.getRules({}, currentUser.currentRole || undefined);
        if (!cancelled) setCopyRulesAll(rules);
      } catch (e: unknown) {
        console.error(e);
        if (!cancelled) {
          setCopyRulesAll([]);
          setError(e instanceof Error ? e.message : 'Failed to load rules list');
        }
      } finally {
        if (!cancelled) setCopyRulesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, copyFromModalOpen, currentUser.currentRole]);

  const filteredCopyRules = useMemo(() => {
    let list = copyRulesAll;
    if (isEditMode && editRule?.RuleId) {
      list = list.filter((r) => r.RuleId !== editRule.RuleId);
    }
    const q = copySearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (r) =>
        (r.RuleName || '').toLowerCase().includes(q) ||
        (r.ProductName || '').toLowerCase().includes(q)
    );
  }, [copyRulesAll, copySearch, isEditMode, editRule?.RuleId]);

  const applyCopiedRuleToForm = async () => {
    if (!selectedCopyRuleId) return;
    setCopyApplyLoading(true);
    setError(null);
    try {
      const full = await commissionRuleService.getRuleById(selectedCopyRuleId);
      const copied = mapCommissionRuleToFormData(full);
      const prev = methods.getValues();

      // Always preserve the product the user already chose (step 1) and the rule name (step 2)
      copied.productId = prev.productId;
      copied.productName = prev.productName;
      copied.productType = prev.productType;
      if (prev.ruleName && prev.ruleName.trim()) {
        copied.ruleName = prev.ruleName;
      }

      if (isEditMode && editRule) {
        copied.ruleName = editRule.RuleName;
        copied.locked = Boolean(editRule.Locked);
      }
      if (!isEditMode) {
        copied.commissionGroupIds = prev.commissionGroupIds ?? [];
        copied.addToAllGroups = prev.addToAllGroups ?? false;
      }
      // Keep the tenant selection from this session
      if (prev.tenantId) {
        copied.tenantId = prev.tenantId;
      }
      reset(copied);
      setCopyInfoMessage(
        `Configuration copied from "${full.RuleName}". Your product selection and rule name are preserved. Review each step and save when ready.`
      );
      setCopyFromModalOpen(false);
      setSelectedCopyRuleId('');
      setCopySearch('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load rule');
    } finally {
      setCopyApplyLoading(false);
    }
  };

  const validateStep = (step: number, values: RuleCreationFormData): string | null => {
    const reviewStepIndex = getSteps(isEditMode).length - 1;
    if (step === reviewStepIndex && !values.ruleName?.trim()) {
      return 'Rule name is required';
    }
    switch (step) {
      case 0: {
        if (!values.productId) return 'Please select a product';
        if (!values.entityType) return 'Entity type is required';
        if (!values.commissionType) return 'Commission type is required';
        if (
          values.entityType === 'Tier' &&
          (values.tierLevel === undefined || values.tierLevel === null)
        ) {
          return 'Tier level is required for tier-based rules';
        }
        if (values.entityType === 'Split' && !values.groupId) {
          return 'Group selection is required for Split commission rules';
        }
        if (currentUser.roles.includes('SysAdmin') && !values.tenantId) {
          return 'Please select a tenant for this rule';
        }
        return null;
      }
      case 1: {
        if (values.commissionType === 'Percentage' && (values.rate === undefined || values.rate === null || values.rate < 0)) {
          return 'Commission rate is required and must be 0 or greater';
        }
        if (values.commissionType === 'Flat' && (values.amount === undefined || values.amount === null || values.amount < 0)) {
          return 'Commission amount is required and must be 0 or greater';
        }
        if (values.commissionType === 'Tiered') {
          if (!values.tiers || values.tiers.length === 0) {
            return 'At least one tier is required';
          }
          if (values.type === 'percentage') {
            const totalRate = values.tiers.reduce((sum, tier) => sum + (tier.rate || 0), 0);
            if (totalRate > 1) {
              return `Total commission rate (${(totalRate * 100).toFixed(2)}%) exceeds 100%`;
            }
            const invalidTiers = values.tiers.filter(
              (tier) => !tier.name || (tier.rate !== undefined && (tier.rate < 0 || tier.rate > 1))
            );
            if (invalidTiers.length > 0) {
              return 'All tiers must have valid names and rates between 0-100%';
            }
          } else if (values.type === 'flatrate') {
            const invalidTiers = values.tiers.filter((tier) => {
              if (!tier.name) return true;
              const baseAmount = tier.flatAmount;
              const hasValidBaseAmount = baseAmount != null && baseAmount >= 0;
              const hasInvalidBaseAmount = baseAmount != null && baseAmount < 0;
              const productTierAmounts = [
                tier.productTiers?.EE?.flatAmount,
                tier.productTiers?.ES?.flatAmount,
                tier.productTiers?.EC?.flatAmount,
                tier.productTiers?.EF?.flatAmount,
              ];
              const hasAnyProductTierAmount = productTierAmounts.some((v) => v != null);
              const hasInvalidProductTierAmount = productTierAmounts.some((v) => v != null && v < 0);
              if (hasInvalidBaseAmount || hasInvalidProductTierAmount) return true;
              if (!hasValidBaseAmount && !hasAnyProductTierAmount) return true;
              return false;
            });
            if (invalidTiers.length > 0) {
              return 'Each tier must have a valid name and either a base flat amount or at least one family-size amount (0 is allowed).';
            }
          }
        }
        if (values.commissionType === 'Split') {
          const sc = values.splitCommission;
          if (!sc || !sc.primaryAgentId) {
            return 'Primary agent is required for split commission rules';
          }
          if (sc && (!sc.primaryAgentPercentage || sc.primaryAgentPercentage <= 0)) {
            return 'Primary agent percentage is required and must be greater than 0';
          }
          if (!sc?.agents || sc.agents.length === 0) {
            return 'At least one additional agent is required for split commission';
          }
          const primaryPercentage = sc.primaryAgentPercentage || 0;
          const additionalPercentage = sc.agents.reduce((sum, agent) => sum + (agent.percentage || 0), 0);
          const totalPercentage = primaryPercentage + additionalPercentage;
          if (totalPercentage !== 1) {
            const diff = Math.abs(1 - totalPercentage);
            if (totalPercentage > 1) {
              return `Total split percentage (${(totalPercentage * 100).toFixed(2)}%) exceeds 100% by ${(diff * 100).toFixed(2)}%. Total must equal exactly 100%.`;
            }
            return `Total split percentage (${(totalPercentage * 100).toFixed(2)}%) is ${(diff * 100).toFixed(2)}% short of 100%. Total must equal exactly 100%.`;
          }
        }
        return null;
      }
      case 2: {
        if (!values.effectiveDate) return 'Effective date is required';
        if (values.terminationDate && values.terminationDate <= values.effectiveDate) {
          return 'Termination date must be after effective date';
        }
        return null;
      }
      default:
        return null;
    }
  };

  const handleGoToStep = (targetStep: number) => {
    const steps = getSteps(isEditMode);
    if (targetStep < 0 || targetStep >= steps.length) return;
    if (targetStep === activeStep) return;

    if (targetStep < activeStep) {
      setError(null);
      setActiveStep(targetStep);
      return;
    }

    const values = methods.getValues();
    for (let step = activeStep; step < targetStep; step++) {
      const err = validateStep(step, values);
      if (err) {
        setError(err);
        return;
      }
    }
    setError(null);
    setActiveStep(targetStep);
  };

  // Handle next step with validation
  const handleNext = async () => {
    setError(null);
    const values = methods.getValues();
    const stepError = validateStep(activeStep, values);
    if (stepError) {
      setError(stepError);
      return;
    }

    const steps = getSteps(isEditMode);
    if (activeStep < steps.length - 1) {
      setActiveStep((prev) => prev + 1);
      setError(null);
    }
  };

  // Handle back step
  const handleBack = () => {
    setError(null);
    // Allow navigation through all steps even when locked
    if (activeStep > 0) {
      setActiveStep((prev) => prev - 1);
    }
  };

  // Handle form submission
  const onSubmit = async (data: RuleCreationFormData) => {
    try {
      setSubmitting(true);
      setError(null);
      
      // Build the commission JSON config with new structure
      const commissionJson: any = {
        description: data.description || `${data.commissionType} commission rule`,
        renewable: data.renewable,
      };
      
      // Add type field for tiered commissions
      if (data.commissionType === 'Tiered' && data.type) {
        commissionJson.type = data.type;
      }
      
      // Add tiers with product tier configuration
      if (data.commissionType === 'Tiered' && data.tiers && data.tiers.length > 0) {
        commissionJson.tiers = data.tiers.map(tier => {
          const tierConfig: any = {
            level: tier.level,
            name: tier.name,
          };
          
          // Add base rate or flat amount
          if (data.type === 'percentage' && tier.rate !== undefined) {
            tierConfig.rate = tier.rate;
          }
          if (data.type === 'flatrate' && tier.flatAmount !== undefined) {
            tierConfig.flatAmount = tier.flatAmount;
          }
          
          // Add product-tier specific configurations
          if (tier.productTiers) {
            const productTierConfig: any = {};
            if (tier.productTiers.EE) {
              productTierConfig.EE = {};
              if (tier.productTiers.EE.rate !== undefined) productTierConfig.EE.rate = tier.productTiers.EE.rate;
              if (tier.productTiers.EE.flatAmount !== undefined) productTierConfig.EE.flatAmount = tier.productTiers.EE.flatAmount;
            }
            if (tier.productTiers.ES) {
              productTierConfig.ES = {};
              if (tier.productTiers.ES.rate !== undefined) productTierConfig.ES.rate = tier.productTiers.ES.rate;
              if (tier.productTiers.ES.flatAmount !== undefined) productTierConfig.ES.flatAmount = tier.productTiers.ES.flatAmount;
            }
            if (tier.productTiers.EC) {
              productTierConfig.EC = {};
              if (tier.productTiers.EC.rate !== undefined) productTierConfig.EC.rate = tier.productTiers.EC.rate;
              if (tier.productTiers.EC.flatAmount !== undefined) productTierConfig.EC.flatAmount = tier.productTiers.EC.flatAmount;
            }
            if (tier.productTiers.EF) {
              productTierConfig.EF = {};
              if (tier.productTiers.EF.rate !== undefined) productTierConfig.EF.rate = tier.productTiers.EF.rate;
              if (tier.productTiers.EF.flatAmount !== undefined) productTierConfig.EF.flatAmount = tier.productTiers.EF.flatAmount;
            }
            
            // Only add productTiers if at least one is configured
            if (Object.keys(productTierConfig).length > 0) {
              tierConfig.productTiers = productTierConfig;
            }
          }
          
          return tierConfig;
        });
      }
      
      // Add product-tier specific rates
      if (data.productTiers && Object.keys(data.productTiers).length > 0) {
        commissionJson.productTiers = {};
        if (data.productTiers.EE) commissionJson.productTiers.EE = data.productTiers.EE;
        if (data.productTiers.ES) commissionJson.productTiers.ES = data.productTiers.ES;
        if (data.productTiers.EC) commissionJson.productTiers.EC = data.productTiers.EC;
        if (data.productTiers.EF) commissionJson.productTiers.EF = data.productTiers.EF;
      }
      
      // Add split commission configuration
      if (data.commissionType === 'Split' && data.splitCommission) {
        const primaryPercentage = data.splitCommission.primaryAgentPercentage || 0;
        const additionalPercentage = data.splitCommission.agents.reduce((sum, agent) => sum + (agent.percentage || 0), 0);
        commissionJson.splitCommission = {
          primaryAgentId: data.splitCommission.primaryAgentId,
          ...(data.splitCommission.primaryAgentName && { primaryAgentName: data.splitCommission.primaryAgentName }),
          ...(data.splitCommission.primaryAgentPercentage !== undefined && { primaryAgentPercentage: data.splitCommission.primaryAgentPercentage }),
          agents: data.splitCommission.agents.map(agent => ({
            agentId: agent.agentId,
            ...(agent.agentName && { agentName: agent.agentName }),
            percentage: agent.percentage,
            ...(agent.flatAmount !== undefined && { flatAmount: agent.flatAmount }),
          })),
          totalPercentage: primaryPercentage + additionalPercentage,
        };
      }
      
      // Add other optional fields
      if (data.yearlySchedule && data.yearlySchedule.length > 0) {
        commissionJson.yearlySchedule = data.yearlySchedule;
      }
      if (data.stateOverrides && Object.keys(data.stateOverrides).length > 0) {
        commissionJson.stateOverrides = data.stateOverrides;
      }
      if (data.bonusEligible) {
        commissionJson.bonusEligible = true;
        if (data.bonusThresholds) {
          commissionJson.bonusThresholds = data.bonusThresholds;
        }
      }
      if (data.notes) {
        commissionJson.notes = data.notes;
      }

      // Prepare rule data for API
      const ruleData: any = {
        ruleName: data.ruleName,
        productId: data.productId,
        productName: data.productName,
        entityType: data.entityType,
        ...(data.entityType === 'Tier' && data.tierLevel !== undefined && { tierLevel: data.tierLevel }),
        entityId: data.entityId || null, // Always include entityId (null if not provided, for any rule type)
        commissionType: data.commissionType,
        rate: data.commissionType === 'Percentage' ? data.rate : undefined,
        amount: data.commissionType === 'Flat' ? data.amount : undefined,
        effectiveDate: data.effectiveDate.toISOString(),
        terminationDate: data.terminationDate?.toISOString() || null,
        // Status field is deprecated - rules are active if Locked=1 AND EffectiveDate<=Today
        // Backend will set Status='Active' for backward compatibility
        priority: data.priority || 999,
        commissionJson: JSON.stringify(commissionJson),
        ...(data.groupId && { groupId: data.groupId }),
        // Always include locked field, ensuring it's a boolean (default to false if undefined)
        locked: data.locked === true || (typeof data.locked === 'number' && data.locked === 1) || (typeof data.locked === 'string' && (data.locked === 'true' || data.locked === '1')),
      };

      // Handle tenant assignment based on user roles
      // Always use currentTenantId (active tenant) to support tenant switching
      const activeTenantId = localStorage.getItem('currentTenantId') || localStorage.getItem('tenantId');
      
      if (currentUser.roles.includes('SysAdmin')) {
        // SysAdmin must select a tenant (no global rules)
        if (data.tenantId) {
          ruleData.tenantId = data.tenantId;
        }
      } else if (currentUser.roles.includes('TenantAdmin')) {
        // TenantAdmin rules are always assigned to their current active tenant (supports tenant switching)
        ruleData.tenantId = activeTenantId;
      }

      console.log('Submitting rule data:', ruleData);
      console.log('🔍 [FRONTEND] EntityId check:', {
        entityId: data.entityId,
        entityType: data.entityType,
        ruleDataEntityId: ruleData.entityId,
        entityIdInPayload: ruleData.hasOwnProperty('entityId')
      });
      console.log('🔒 [FRONTEND] Locked status:', {
        isLocked,
        dataLocked: data.locked,
        ruleDataLocked: ruleData.locked,
        isEditMode,
        editRuleLocked: editRule?.Locked
      });

      // Create or update rule via API
      let result;
      if (isEditMode && editRule) {
        console.log('🔒 [FRONTEND] Updating rule (locked may still be true):', ruleData.locked);
        result = await commissionRuleService.updateRule(editRule.RuleId, ruleData);
      } else {
        result = await commissionRuleService.createRule(ruleData);
      }

      // Add new rule to commission groups if requested (create only)
      if (!isEditMode && result?.ruleId) {
        const addToAll = data.addToAllGroups === true;
        const groupIds = (data.commissionGroupIds ?? []) as string[];
        if (addToAll || groupIds.length > 0) {
          try {
            if (addToAll) {
              const allGroups = await commissionGroupsService.listGroups({ limit: 500 });
              for (const g of allGroups.groups ?? []) {
                await commissionGroupsService.addRuleToGroup(g.CommissionGroupId, result.ruleId);
              }
            } else {
              for (const gid of groupIds) {
                await commissionGroupsService.addRuleToGroup(gid, result.ruleId);
              }
            }
          } catch (groupErr) {
            console.error('Failed to add rule to groups:', groupErr);
            // Don't fail the whole create - rule was created successfully
          }
        }
      }
      
      // Notify parent component
      onRuleCreated(result);
      
      // Close modal
      onClose();
      
      // Reset form
      methods.reset();
      setActiveStep(0);
    } catch (err) {
      console.error('Error creating rule:', err);
      setError(err instanceof Error ? err.message : 'Failed to create commission rule');
    } finally {
      setSubmitting(false);
    }
  };

  // Handle modal close
  const handleClose = () => {
    if (!submitting) {
      setCopyFromModalOpen(false);
      setAiAssistantOpen(false);
      onClose();
      // Reset form state
      methods.reset();
      setActiveStep(0);
      setError(null);
      setCopyInfoMessage(null);
    }
  };

  // Render step content
  const renderStepContent = (step: number) => {
    const steps = getSteps(isEditMode);
    if (step >= steps.length) return null;
    const stepLabels: Record<string, React.ReactNode> = {
      'Product & Rule': <ProductAndRuleSetupStep />,
      'Commission': <CommissionConfigurationStep isEditMode={isEditMode} inModal />,
      'Dates': <AdvancedSettingsStep />,
      'Groups': <CommissionGroupsStep />,
      'Review': <ReviewStep isEditMode={isEditMode} />,
    };
    return stepLabels[steps[step]] ?? null;
  };

  return (
    <>
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="md"
      fullWidth
      disableEscapeKeyDown={submitting}
      slotProps={commissionDialogSlotProps(COMMISSION_WIZARD_DIALOG_Z)}
      sx={{ zIndex: COMMISSION_WIZARD_DIALOG_Z }}
    >
      <DialogTitle>
        <Box display="flex" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1}>
          <Typography variant="h6">{isEditMode ? 'Edit Commission Rule' : 'Create Commission Rule'}</Typography>
          <Box display="flex" alignItems="center" gap={1}>
            <Tooltip
              title={
                !aiAssistantAvailable
                  ? 'AI assist is not configured on this environment (missing OPENAI_API_KEY).'
                  : isLocked
                    ? 'This rule is locked (active). AI can still propose tier changes; review and save to apply.'
                    : ''
              }
            >
              <span>
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<AutoAwesomeIcon fontSize="small" />}
                  onClick={() => setAiAssistantOpen(true)}
                  disabled={submitting || copyApplyLoading || !aiAssistantAvailable}
                >
                  Edit with AI
                </Button>
              </span>
            </Tooltip>
            <Button
              variant="outlined"
              size="small"
              onClick={() => {
                setCopyInfoMessage(null);
                setCopyFromModalOpen(true);
              }}
              disabled={submitting || copyApplyLoading}
            >
              Copy from another rule
            </Button>
            <Button
              onClick={handleClose}
              disabled={submitting}
              size="small"
              sx={{ minWidth: 'auto' }}
            >
              <CloseIcon />
            </Button>
          </Box>
        </Box>
      </DialogTitle>
      
      <DialogContent dividers>
        <Box sx={{ width: '100%', minHeight: 400 }}>
          {copyInfoMessage && (
            <Alert severity="success" sx={{ mb: 2 }} onClose={() => setCopyInfoMessage(null)}>
              {copyInfoMessage}
            </Alert>
          )}
          <Stepper activeStep={activeStep} sx={{ mb: 4 }}>
            {getSteps(isEditMode).map((label, index) => (
              <Step
                key={label}
                onClick={() => handleGoToStep(index)}
                sx={{ cursor: 'pointer' }}
              >
                <StepLabel>{label}</StepLabel>
              </Step>
            ))}
          </Stepper>

          {error && (
            <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
              {error}
            </Alert>
          )}

          {isEditMode && isLocked && (
            <Alert severity="info" sx={{ mb: 2 }}>
              <Typography variant="body2" component="div">
                <strong>This commission rule is locked</strong> (active). You can edit commission settings and dates; save to apply changes. Unlocking still uses the Unlock action in the rules list when allowed.
              </Typography>
            </Alert>
          )}

          <FormProvider {...methods}>
            <form onSubmit={handleSubmit((data) => onSubmit(data as RuleCreationFormData))}>
              {renderStepContent(activeStep)}
            </form>
          </FormProvider>
        </Box>
      </DialogContent>
      
      <DialogActions>
        <Button
          onClick={activeStep === 0 ? handleClose : handleBack}
          disabled={submitting}
          startIcon={<BackIcon />}
        >
          {activeStep === 0 ? 'Cancel' : 'Back'}
        </Button>
        
        {activeStep === getSteps(isEditMode).length - 1 ? (
          <Button
            variant="contained"
            onClick={handleSubmit((data) => onSubmit(data as RuleCreationFormData))}
            disabled={submitting}
            startIcon={submitting ? <CircularProgress size={20} /> : <CheckIcon />}
          >
            {submitting ? (isEditMode ? 'Updating...' : 'Creating...') : (isEditMode ? 'Update Rule' : 'Create Rule')}
          </Button>
        ) : (
          <Button
            variant="contained"
            onClick={handleNext}
            endIcon={<NextIcon />}
          >
            Next
          </Button>
        )}
      </DialogActions>
    </Dialog>

    <Dialog
      open={copyFromModalOpen}
      onClose={() => !copyApplyLoading && setCopyFromModalOpen(false)}
      maxWidth="sm"
      fullWidth
      disableEscapeKeyDown={copyApplyLoading}
      slotProps={commissionDialogSlotProps(COMMISSION_NESTED_DIALOG_Z)}
      sx={{ zIndex: COMMISSION_NESTED_DIALOG_Z }}
    >
      <DialogTitle>Copy from another rule</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Choose a rule to copy settings from into this wizard. The form will update for you to review; nothing is saved until you finish the wizard.
        </Typography>
        <Alert severity="info" sx={{ mb: 2 }}>
          {isEditMode && editRule
            ? "Your product, rule name, and lock state are kept — only the commission configuration, tiers, and settings are copied."
            : "Your product selection, rule name, tenant, and group assignments are kept — only the commission configuration, tiers, and settings are copied."}
        </Alert>
        <TextField
          fullWidth
          size="small"
          label="Search"
          placeholder="Filter by name or product"
          value={copySearch}
          onChange={(e) => setCopySearch(e.target.value)}
          sx={{ mb: 2 }}
        />
        {copyRulesLoading ? (
          <Box display="flex" justifyContent="center" py={3}>
            <CircularProgress size={28} />
          </Box>
        ) : (
          <List dense sx={{ maxHeight: 360, overflow: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
            {filteredCopyRules.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
                No matching rules. Adjust search or try again later.
              </Typography>
            ) : (
              filteredCopyRules.map((r) => (
                <ListItemButton
                  key={r.RuleId}
                  selected={selectedCopyRuleId === r.RuleId}
                  onClick={() => setSelectedCopyRuleId(r.RuleId)}
                >
                  <ListItemText
                    primary={r.RuleName}
                    secondary={`${r.ProductName || '—'} · ${r.EntityType} · ${r.CommissionType}`}
                  />
                </ListItemButton>
              ))
            )}
          </List>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={() => !copyApplyLoading && setCopyFromModalOpen(false)} disabled={copyApplyLoading}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={applyCopiedRuleToForm}
          disabled={!selectedCopyRuleId || copyApplyLoading}
          startIcon={copyApplyLoading ? <CircularProgress size={18} /> : undefined}
        >
          {copyApplyLoading ? 'Loading…' : 'Apply to form'}
        </Button>
      </DialogActions>
    </Dialog>

    <CommissionRuleAIAssistant
      open={aiAssistantOpen}
      onClose={() => setAiAssistantOpen(false)}
      onApply={handleAIApply}
      formSnapshot={{
        type: typeWatch,
        tiers: tiersWatch,
        commissionType: commissionTypeWatch,
      }}
      tenantTierLevels={tenantTierLevelsForAi}
      aiAvailable={aiAssistantAvailable}
    />

    <Snackbar
      open={Boolean(applySnack)}
      autoHideDuration={6000}
      onClose={() => setApplySnack(null)}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
    >
      <Alert onClose={() => setApplySnack(null)} severity="success" sx={{ width: '100%' }}>
        {applySnack}
      </Alert>
    </Snackbar>
    </>
  );
};