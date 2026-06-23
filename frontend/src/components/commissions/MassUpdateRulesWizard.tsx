// src/components/commissions/MassUpdateRulesWizard.tsx
import {
  NavigateBefore as BackIcon,
  Check as CheckIcon,
  Close as CloseIcon,
  NavigateNext as NextIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  InfoOutlined as InfoOutlinedIcon,
  FileCopy as FileCopyIcon,
} from '@mui/icons-material';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  IconButton,
  InputLabel,
  LinearProgress,
  MenuItem,
  Select,
  Step,
  StepLabel,
  Stepper,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
  Collapse,
  FormControlLabel,
} from '@mui/material';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useCommissionLevels } from '../../hooks/useCommissionLevels';
import { getTierName } from '../../constants/form-options';
import { FormProvider, useForm } from 'react-hook-form';
import { commissionGroupsService, type CommissionGroup } from '../../services/commissionGroups.service';
import { commissionRuleService, type CommissionRule } from '../../services/commissionRules.service';


import { CommissionConfigurationStep } from './steps/CommissionConfigurationStep';
import type { RuleCreationFormData } from './RuleCreationWizard';
import { mapCommissionRuleToFormData } from './RuleCreationWizard';

// Local shape for rules fed into the wizard (matches the manager's CommissionRule).
interface WizardRule {
  RuleId: string;
  RuleName: string;
  ProductId: string;
  ProductName?: string;
  EntityType: 'Agent' | 'Agency' | 'Tier' | 'Split';
  CommissionType: 'Percentage' | 'Flat' | 'Tiered' | 'Split';
  CommissionJson?: string;
  GroupName?: string;
  Locked?: boolean | number;
  TenantId?: string;
}

interface MassUpdateRulesWizardProps {
  open: boolean;
  onClose: () => void;
  rules: WizardRule[];
  onApplied: (successCount: number) => void;
}

type SlotKey = 'base' | 'EE' | 'ES' | 'EC' | 'EF';

interface AdminTier {
  level: number;
  name: string;
  rate?: number;
  flatAmount?: number;
  productTiers?: {
    EE?: { rate?: number; flatAmount?: number };
    ES?: { rate?: number; flatAmount?: number };
    EC?: { rate?: number; flatAmount?: number };
    EF?: { rate?: number; flatAmount?: number };
  };
}

interface SlotChange {
  slot: SlotKey;
  before?: number;
  after?: number;
  kind: 'new' | 'fill' | 'overwrite' | 'unchanged';
}

interface TierDiff {
  level: number;
  name: string;
  isNewTier: boolean;
  slots: SlotChange[];
}

interface RuleDiff {
  ruleId: string;
  ruleName: string;
  productName: string;
  groupName: string;
  tierDiffs: TierDiff[];
  mergedTiers: any[];
  mergedCommissionJson: any;
  hasAnyChange: boolean;
  hasOverwrite: boolean;
  hasNewTier: boolean;
  hasFill: boolean;
}

interface GroupTarget {
  groupId: string;
  groupName: string;
  tieredRules: WizardRule[];
  primaryRule: WizardRule | null;
  otherRules: WizardRule[];
}

const SLOT_ORDER: SlotKey[] = ['base', 'EE', 'ES', 'EC', 'EF'];

const STEPS = [
  'Product Scope',
  'Configure Tiers',
  'Select Groups',
  'Review & Apply',
];

const ALL_PRODUCTS_ID = '__ALL_PRODUCTS__';

/** MUI Select menus portaled above the Mass Update dialog. */
const MODAL_SELECT_MENU_PROPS = {
  slotProps: {
    paper: { sx: { zIndex: 1700 } },
    root: { sx: { zIndex: 1700 } },
  },
} as const;

/** Nested copy dialog stacks above the main Mass Update dialog. */
const NESTED_MODAL_SELECT_MENU_PROPS = {
  slotProps: {
    paper: { sx: { zIndex: 1800 } },
    root: { sx: { zIndex: 1800 } },
  },
} as const;

const ALL_PRODUCTS_GUID = '00000000-0000-0000-0000-000000000000';

/**
 * Returns true when a numeric slot value is considered "empty" (no existing value).
 * Zero is treated as a real existing value on purpose — overwriting 0 is still an overwrite.
 */
const isEmpty = (v: unknown): boolean => v === undefined || v === null;

const isConfiguredSlot = (v: unknown): boolean => !isEmpty(v);

/** Returns true if the admin-configured tier has at least one non-empty value anywhere. */
const tierHasAnyValue = (tier: AdminTier, payoutType: 'flatrate' | 'percentage'): boolean => {
  const baseKey: 'rate' | 'flatAmount' = payoutType === 'percentage' ? 'rate' : 'flatAmount';
  if (isConfiguredSlot(tier[baseKey])) return true;
  const pt = tier.productTiers;
  if (!pt) return false;
  return (['EE', 'ES', 'EC', 'EF'] as const).some((k) => isConfiguredSlot(pt[k]?.[baseKey]));
};

/** Get a slot's value (base/EE/ES/EC/EF) given the payout type. */
const getSlotValue = (
  tier: AdminTier | any,
  slot: SlotKey,
  payoutType: 'flatrate' | 'percentage'
): number | undefined => {
  const key: 'rate' | 'flatAmount' = payoutType === 'percentage' ? 'rate' : 'flatAmount';
  if (slot === 'base') return tier?.[key];
  return tier?.productTiers?.[slot]?.[key];
};

/** Set a slot's value on a tier object (mutates and returns). */
const setSlotValue = (
  tier: any,
  slot: SlotKey,
  value: number,
  payoutType: 'flatrate' | 'percentage'
): any => {
  const key: 'rate' | 'flatAmount' = payoutType === 'percentage' ? 'rate' : 'flatAmount';
  if (slot === 'base') {
    tier[key] = value;
    return tier;
  }
  if (!tier.productTiers) tier.productTiers = {};
  if (!tier.productTiers[slot]) tier.productTiers[slot] = {};
  tier.productTiers[slot][key] = value;
  return tier;
};

/**
 * Diff admin-configured tiers against an existing rule's tiers.
 *
 * Per-slot classification for each of [base, EE, ES, EC, EF]:
 *  - admin slot empty     → unchanged
 *  - tier is new          → new
 *  - admin !empty, existing empty          → fill (blue)
 *  - admin !empty, existing equal value    → unchanged
 *  - admin !empty, existing !empty differs → overwrite (red)
 */
export function diffTiers(
  existing: any[],
  incoming: AdminTier[],
  payoutType: 'flatrate' | 'percentage'
): { merged: any[]; diffs: TierDiff[] } {
  const existingByLevel = new Map<number, any>();
  (existing || []).forEach((t) => {
    if (t && Number.isFinite(Number(t.level))) existingByLevel.set(Number(t.level), t);
  });

  const diffs: TierDiff[] = [];
  const merged: any[] = [];

  // Start from a clone of existing so untouched tiers are preserved.
  (existing || []).forEach((t) => merged.push(JSON.parse(JSON.stringify(t))));

  incoming.forEach((adminTier) => {
    if (!tierHasAnyValue(adminTier, payoutType)) return; // skip empty admin tiers

    const level = Number(adminTier.level);
    const existingTier = existingByLevel.get(level);
    const isNewTier = !existingTier;

    const slots: SlotChange[] = [];
    // Build merged tier target — start from existing (if any) or a fresh shell.
    let mergedTier: any;
    if (isNewTier) {
      mergedTier = { level, name: adminTier.name };
      merged.push(mergedTier);
    } else {
      mergedTier = merged.find((m) => Number(m.level) === level);
      if (!mergedTier) {
        mergedTier = JSON.parse(JSON.stringify(existingTier));
        merged.push(mergedTier);
      }
      // Refresh name from admin if admin provided one (keeps existing name otherwise).
      if (adminTier.name) mergedTier.name = adminTier.name;
    }

    SLOT_ORDER.forEach((slot) => {
      const adminVal = getSlotValue(adminTier, slot, payoutType);
      const existingVal = isNewTier ? undefined : getSlotValue(existingTier, slot, payoutType);
      if (!isConfiguredSlot(adminVal)) {
        // Admin didn't touch this slot — leave existing, classify unchanged.
        slots.push({ slot, before: existingVal as number | undefined, after: existingVal as number | undefined, kind: 'unchanged' });
        return;
      }
      // Admin provided a value.
      if (isNewTier) {
        slots.push({ slot, before: undefined, after: adminVal as number, kind: 'new' });
        setSlotValue(mergedTier, slot, adminVal as number, payoutType);
        return;
      }
      if (!isConfiguredSlot(existingVal)) {
        slots.push({ slot, before: undefined, after: adminVal as number, kind: 'fill' });
        setSlotValue(mergedTier, slot, adminVal as number, payoutType);
        return;
      }
      if (existingVal === adminVal) {
        slots.push({ slot, before: existingVal as number, after: existingVal as number, kind: 'unchanged' });
        return;
      }
      slots.push({ slot, before: existingVal as number, after: adminVal as number, kind: 'overwrite' });
      setSlotValue(mergedTier, slot, adminVal as number, payoutType);
    });

    diffs.push({ level, name: adminTier.name || mergedTier.name || `Level ${level}`, isNewTier, slots });
  });

  // Sort merged tiers by level for stable output.
  merged.sort((a, b) => Number(a.level) - Number(b.level));

  return { merged, diffs };
}

const formatSlotValue = (v: number | undefined, payoutType: 'flatrate' | 'percentage'): string => {
  if (isEmpty(v)) return 'N/A';
  if (payoutType === 'percentage') return `${((v as number) * 100).toFixed(2)}%`;
  return `$${(v as number).toFixed(2)}`;
};

const kindChip = (kind: SlotChange['kind']) => {
  if (kind === 'new') return <Chip size="small" label="New" sx={{ bgcolor: '#dcfce7', color: '#166534', fontWeight: 600 }} />;
  if (kind === 'fill') return <Chip size="small" label="Fill" sx={{ bgcolor: '#dbeafe', color: '#1e40af', fontWeight: 600 }} />;
  if (kind === 'overwrite') return <Chip size="small" label="Overwrite" sx={{ bgcolor: '#fee2e2', color: '#991b1b', fontWeight: 600 }} />;
  return <Chip size="small" label="—" variant="outlined" />;
};

const summarizeRuleTiers = (rule: WizardRule): string => {
  try {
    const json = rule.CommissionJson ? JSON.parse(rule.CommissionJson) : {};
    const tiers: any[] = json?.tiers || [];
    if (tiers.length === 0) return 'No tiers configured';
    return tiers
      .sort((a, b) => Number(a.level) - Number(b.level))
      .map((t) => t.name || `Level ${t.level}`)
      .join(', ');
  } catch {
    return '—';
  }
};

const parseRulePayoutType = (rule: WizardRule): 'flatrate' | 'percentage' | null => {
  try {
    const json = rule.CommissionJson ? JSON.parse(rule.CommissionJson) : {};
    if (json?.type === 'percentage' || json?.type === 'flatrate') return json.type;
    return null;
  } catch {
    return null;
  }
};

const parseRuleJson = (rule: WizardRule): any => {
  try {
    return rule.CommissionJson ? JSON.parse(rule.CommissionJson) : {};
  } catch {
    return {};
  }
};


const toWizardRule = (r: CommissionRule): WizardRule => ({
  RuleId: r.RuleId,
  RuleName: r.RuleName,
  ProductId: r.ProductId,
  ProductName: r.ProductName,
  EntityType: r.EntityType as WizardRule['EntityType'],
  CommissionType: r.CommissionType as WizardRule['CommissionType'],
  CommissionJson: typeof r.CommissionJson === 'string' ? r.CommissionJson : r.CommissionJson ? JSON.stringify(r.CommissionJson) : undefined,
  GroupName: r.GroupName,
  Locked: r.Locked,
  TenantId: r.TenantId,
});


const MEMBERSHIP_BATCH_SIZE = 100;

async function fetchGroupMembershipsBatched(
  ruleIds: string[]
): Promise<Array<{ ruleId: string; groups: Array<{ CommissionGroupId: string; Name: string }> }>> {
  const merged: Array<{ ruleId: string; groups: Array<{ CommissionGroupId: string; Name: string }> }> = [];
  for (let i = 0; i < ruleIds.length; i += MEMBERSHIP_BATCH_SIZE) {
    const chunk = ruleIds.slice(i, i + MEMBERSHIP_BATCH_SIZE);
    const batch = await commissionRuleService.getRulesGroupMemberships(chunk);
    merged.push(...batch);
  }
  return merged;
}

export const MassUpdateRulesWizard: React.FC<MassUpdateRulesWizardProps> = ({
  open,
  onClose,
  rules,
  onApplied,
}) => {
  const [activeStep, setActiveStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [scopeProductId, setScopeProductId] = useState<string>(ALL_PRODUCTS_ID);
  const [commissionGroups, setCommissionGroups] = useState<CommissionGroup[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());
  const [advancedGroupIds, setAdvancedGroupIds] = useState<Set<string>>(new Set());
  const [extraRuleIds, setExtraRuleIds] = useState<Set<string>>(new Set());
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(null);
  const [productScopeHelpOpen, setProductScopeHelpOpen] = useState(false);
  const [copyFromOpen, setCopyFromOpen] = useState(false);
  const [copyGroupId, setCopyGroupId] = useState('');
  const [copySourceGroupId, setCopySourceGroupId] = useState('');
  const [copyGroupRulesLoading, setCopyGroupRulesLoading] = useState(false);
  const [copySourceRule, setCopySourceRule] = useState<WizardRule | null>(null);
  const [copyTierLevels, setCopyTierLevels] = useState<Set<number>>(new Set());
  const [copyApplying, setCopyApplying] = useState(false);
  const [rulesByGroupId, setRulesByGroupId] = useState<Map<string, WizardRule[]>>(new Map());
  const [applying, setApplying] = useState(false);
  const [applyResults, setApplyResults] = useState<Record<string, { ok: boolean; error?: string }>>({});
  const [applyProgress, setApplyProgress] = useState(0);
  const [applyDone, setApplyDone] = useState(false);
  // Snapshot of admin-configured tiers taken when leaving the Configure step.
  // Drives the Select/Review steps so we don't depend on RHF deep-watch reactivity.
  const [tiersSnapshot, setTiersSnapshot] = useState<AdminTier[]>([]);
  const [payoutTypeSnapshot, setPayoutTypeSnapshot] = useState<'flatrate' | 'percentage'>('flatrate');
  // Tracks the latest CommissionJson we've already applied for a rule (in this wizard session).
  // Subsequent diffs re-base against this so re-applying after edits shows the correct before state.
  const [appliedJsonById, setAppliedJsonById] = useState<Record<string, any>>({});
  // Cumulative success count across apply runs so the parent snackbar is accurate.
  const [cumulativeSuccessCount, setCumulativeSuccessCount] = useState(0);
  const [fetchedRules, setFetchedRules] = useState<WizardRule[]>([]);
  const [rulesFetching, setRulesFetching] = useState(false);

  const { displayNameByLevel } = useCommissionLevels();

  const tierDisplayName = useCallback(
    (level: number, storedName?: string) => {
      const db = displayNameByLevel.get(Number(level));
      if (db) return db;
      const trimmed = (storedName || '').trim();
      if (trimmed) return trimmed;
      return getTierName(level);
    },
    [displayNameByLevel]
  );

  const methods = useForm<RuleCreationFormData>({
    mode: 'onChange',
    defaultValues: {
      productId: '',
      productName: '',
      productType: '',
      ruleName: '',
      entityType: 'Tier',
      tierLevel: 0,
      priority: 999,
      commissionType: 'Tiered',
      description: '',
      tenantId: localStorage.getItem('currentTenantId') || localStorage.getItem('tenantId') || '',
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

  const { reset, getValues, setValue } = methods;

  // Reset on close/open.
  useEffect(() => {
    if (!open) return;
    setActiveStep(0);
    setError(null);
    setScopeProductId(ALL_PRODUCTS_ID);
    setSelectedGroupIds(new Set());
    setAdvancedGroupIds(new Set());
    setExtraRuleIds(new Set());
    setCopyFromOpen(false);
    setCopyGroupId('');
    setCopySourceGroupId('');
    setCopySourceRule(null);
    setCopyTierLevels(new Set());
    setRulesByGroupId(new Map());
    setExpandedRuleId(null);
    setApplying(false);
    setApplyResults({});
    setApplyProgress(0);
    setApplyDone(false);
    setTiersSnapshot([]);
    setPayoutTypeSnapshot('flatrate');
    setAppliedJsonById({});
    setCumulativeSuccessCount(0);
    setFetchedRules([]);
    setRulesFetching(false);
    reset({
      productId: '',
      productName: '',
      productType: '',
      ruleName: '',
      entityType: 'Tier',
      tierLevel: 0,
      priority: 999,
      commissionType: 'Tiered',
      description: '',
      tenantId: localStorage.getItem('currentTenantId') || localStorage.getItem('tenantId') || '',
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
  }, [open, reset]);


  // Load tiered rules inside the wizard (parent rules[] is often empty on Commission Groups tab).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setRulesFetching(true);
      try {
        const role = localStorage.getItem('currentRole') || undefined;
        const data = await commissionRuleService.getRules({}, role || undefined);
        if (!cancelled) {
          setFetchedRules((Array.isArray(data) ? data : []).map(toWizardRule));
        }
      } catch (e) {
        console.error('Mass update: failed to load rules', e);
        if (!cancelled) setFetchedRules([]);
      } finally {
        if (!cancelled) setRulesFetching(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  // Only tiered + Tier-entity rules are eligible for mass update.
  const allTieredRules = useMemo(() => {
    const pool = fetchedRules.length > 0 ? fetchedRules : rules || [];
    return pool.filter((r) => r.EntityType === 'Tier' && r.CommissionType === 'Tiered');
  }, [fetchedRules, rules]);

  useEffect(() => {
    setSelectedGroupIds(new Set());
    setExtraRuleIds(new Set());
    setAdvancedGroupIds(new Set());
  }, [scopeProductId]);

  const scopeProductIdForMatch = useMemo(
    () => (scopeProductId === ALL_PRODUCTS_ID ? ALL_PRODUCTS_GUID : scopeProductId),
    [scopeProductId]
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setGroupsLoading(true);
      try {
        const [groupsRes, memberships] = await Promise.all([
          commissionGroupsService.listGroups({ limit: 500 }),
          allTieredRules.length > 0
            ? fetchGroupMembershipsBatched(allTieredRules.map((r) => r.RuleId))
            : Promise.resolve([] as Array<{ ruleId: string; groups: Array<{ CommissionGroupId: string; Name: string }> }>),
        ]);
        if (cancelled) return;
        setCommissionGroups(groupsRes.groups ?? []);
        const ruleById = new Map(allTieredRules.map((r) => [r.RuleId.toLowerCase(), r]));
        const map = new Map<string, WizardRule[]>();
        for (const m of memberships) {
          const rule = ruleById.get(String(m.ruleId).toLowerCase());
          if (!rule) continue;
          for (const g of m.groups || []) {
            const gid = String(g.CommissionGroupId);
            if (!map.has(gid)) map.set(gid, []);
            const arr = map.get(gid)!;
            if (!arr.some((x) => x.RuleId === rule.RuleId)) arr.push(rule);
          }
        }
        setRulesByGroupId(map);
      } catch (e) {
        console.error('Mass update: failed to load groups/memberships', e);
        if (!cancelled) {
          setCommissionGroups([]);
          setRulesByGroupId(new Map());
        }
      } finally {
        if (!cancelled) setGroupsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, allTieredRules]);

  // Distinct product options from the eligible rules.
  const productOptions = useMemo(() => {
    const map = new Map<string, string>();
    allTieredRules.forEach((r) => {
      const id = r.ProductId || '';
      const name = r.ProductName || (id === '00000000-0000-0000-0000-000000000000' ? 'All Products (global)' : id);
      if (!map.has(id)) map.set(id, name);
    });
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [allTieredRules]);

  const scopedRules = useMemo(() => {
    if (scopeProductId === ALL_PRODUCTS_ID) return allTieredRules;
    return allTieredRules.filter((r) => r.ProductId === scopeProductId);
  }, [allTieredRules, scopeProductId]);

  const groupTargets: GroupTarget[] = useMemo(() => {
    return commissionGroups
      .map((g) => {
        const tieredRules = rulesByGroupId.get(g.CommissionGroupId) ?? [];
        const primaryRule =
          tieredRules.find((r) => r.ProductId === scopeProductIdForMatch) ?? null;
        const otherRules = tieredRules.filter((r) => r.RuleId !== primaryRule?.RuleId);
        return {
          groupId: g.CommissionGroupId,
          groupName: g.Name,
          tieredRules,
          primaryRule,
          otherRules,
        };
      })
      .filter((gt) => gt.primaryRule != null)
      .sort((a, b) => a.groupName.localeCompare(b.groupName));
  }, [commissionGroups, rulesByGroupId, scopeProductIdForMatch]);

  const visibleGroupTargets = useMemo(
    () =>
      copySourceGroupId
        ? groupTargets.filter((gt) => gt.groupId !== copySourceGroupId)
        : groupTargets,
    [groupTargets, copySourceGroupId]
  );

  /** Groups that contain a tiered rule for the scoped product (copy-from source). */
  const copyGroupOptions = useMemo(() => {
    const withRule = commissionGroups.filter((g) => {
      const tieredRules = rulesByGroupId.get(g.CommissionGroupId) ?? [];
      return tieredRules.some((r) => r.ProductId === scopeProductIdForMatch);
    });
    if (withRule.length > 0) {
      return withRule.slice().sort((a, b) => a.Name.localeCompare(b.Name));
    }
    // Fallback: list all groups if memberships not loaded yet
    return commissionGroups.slice().sort((a, b) => a.Name.localeCompare(b.Name));
  }, [commissionGroups, rulesByGroupId, scopeProductIdForMatch]);

  // Snapshot-driven view of the admin's tier configuration. This is captured when
  // leaving the Configure step so downstream steps (Select / Review) are not affected
  // by nested RHF reactivity quirks on deep productTiers.* writes.
  const payoutType = payoutTypeSnapshot;
  const adminEffectiveTiers = useMemo(
    () => tiersSnapshot.filter((t) => tierHasAnyValue(t, payoutType)),
    [tiersSnapshot, payoutType]
  );

  // Per-rule compatibility: incompatible if payout type doesn't match the rule's existing type.
  const getCompatibility = useCallback((rule: WizardRule): { compatible: boolean; reason?: string } => {
    const rt = parseRulePayoutType(rule);
    if (rt == null) {
      return { compatible: true }; // legacy rule without type — treat as compatible; still merges safely.
    }
    if (rt !== payoutType) {
      return {
        compatible: false,
        reason: `Rule uses ${rt === 'percentage' ? 'percentage' : 'flat rate'} tiers; you configured ${payoutType === 'percentage' ? 'percentage' : 'flat rate'}.`,
      };
    }
    return { compatible: true };
  }, [payoutType]);

  const selectedRuleIds = useMemo(() => {
    const ids = new Set<string>();
    visibleGroupTargets.forEach((gt) => {
      if (!selectedGroupIds.has(gt.groupId)) return;
      if (gt.primaryRule && getCompatibility(gt.primaryRule).compatible) {
        ids.add(gt.primaryRule.RuleId);
      }
      gt.otherRules.forEach((r) => {
        if (extraRuleIds.has(r.RuleId) && getCompatibility(r).compatible) {
          ids.add(r.RuleId);
        }
      });
    });
    return ids;
  }, [visibleGroupTargets, selectedGroupIds, extraRuleIds, getCompatibility]);

  // Precompute diffs for the Review step (only for selected rules).
  const ruleDiffs: RuleDiff[] = useMemo(() => {
    if (activeStep < 3) return [];
    const out: RuleDiff[] = [];
    allTieredRules
      .filter((r) => selectedRuleIds.has(r.RuleId))
      .forEach((rule) => {
        // Prefer locally-tracked updated JSON so re-applies show the right "before" state.
        const existingJson = appliedJsonById[rule.RuleId] ?? parseRuleJson(rule);
        const existingTiers = Array.isArray(existingJson?.tiers) ? existingJson.tiers : [];
        const { merged, diffs } = diffTiers(existingTiers, adminEffectiveTiers, payoutType);
        const mergedJson = { ...existingJson, tiers: merged, type: existingJson?.type || payoutType };
        const hasNewTier = diffs.some((d) => d.isNewTier);
        const hasOverwrite = diffs.some((d) => d.slots.some((s) => s.kind === 'overwrite'));
        const hasFill = diffs.some((d) => d.slots.some((s) => s.kind === 'fill'));
        out.push({
          ruleId: rule.RuleId,
          ruleName: rule.RuleName,
          productName: rule.ProductName || (rule.ProductId === '00000000-0000-0000-0000-000000000000' ? 'All Products' : rule.ProductId),
          groupName: rule.GroupName || '—',
          tierDiffs: diffs,
          mergedTiers: merged,
          mergedCommissionJson: mergedJson,
          hasAnyChange: hasNewTier || hasOverwrite || hasFill,
          hasNewTier,
          hasOverwrite,
          hasFill,
        });
      });
    return out;
  }, [activeStep, allTieredRules, selectedRuleIds, adminEffectiveTiers, payoutType, appliedJsonById]);

  const reviewSections = useMemo(() => {
    if (activeStep < 3) return [] as Array<{ groupId: string; groupName: string; diffs: RuleDiff[] }>;
    const diffById = new Map(ruleDiffs.map((d) => [d.ruleId, d]));
    return visibleGroupTargets
      .filter((gt) => selectedGroupIds.has(gt.groupId))
      .map((gt) => {
        const ruleIds = new Set<string>();
        if (gt.primaryRule && selectedRuleIds.has(gt.primaryRule.RuleId)) {
          ruleIds.add(gt.primaryRule.RuleId);
        }
        gt.otherRules.forEach((r) => {
          if (extraRuleIds.has(r.RuleId) && selectedRuleIds.has(r.RuleId)) ruleIds.add(r.RuleId);
        });
        const diffs = Array.from(ruleIds)
          .map((id) => diffById.get(id))
          .filter((d): d is RuleDiff => Boolean(d));
        return { groupId: gt.groupId, groupName: gt.groupName, diffs };
      })
      .filter((s) => s.diffs.length > 0);
  }, [activeStep, visibleGroupTargets, selectedGroupIds, selectedRuleIds, extraRuleIds, ruleDiffs]);

  const toggleGroup = (groupId: string) => {
    setSelectedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
        const gt = groupTargets.find((g) => g.groupId === groupId);
        if (gt) {
          setExtraRuleIds((ex) => {
            const n = new Set(ex);
            gt.otherRules.forEach((r) => n.delete(r.RuleId));
            return n;
          });
        }
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  const toggleExtraRule = (ruleId: string) => {
    setExtraRuleIds((prev) => {
      const next = new Set(prev);
      if (next.has(ruleId)) next.delete(ruleId);
      else next.add(ruleId);
      return next;
    });
  };

  const setGroupAdvanced = (groupId: string, enabled: boolean) => {
    setAdvancedGroupIds((prev) => {
      const next = new Set(prev);
      if (enabled) next.add(groupId);
      else {
        next.delete(groupId);
        const gt = groupTargets.find((g) => g.groupId === groupId);
        if (gt) {
          setExtraRuleIds((ex) => {
            const n = new Set(ex);
            gt.otherRules.forEach((r) => n.delete(r.RuleId));
            return n;
          });
        }
      }
      return next;
    });
  };

  const selectAllCompatibleGroups = () => {
    const next = new Set<string>();
    groupTargets.forEach((gt) => {
      if (gt.primaryRule && getCompatibility(gt.primaryRule).compatible) {
        next.add(gt.groupId);
      }
    });
    setSelectedGroupIds(next);
  };

  const clearSelection = () => {
    setSelectedGroupIds(new Set());
    setExtraRuleIds(new Set());
    setAdvancedGroupIds(new Set());
  };

  const handleNext = () => {
    setError(null);
    if (activeStep === 0) {
      // Product scope always valid (All Products is allowed).
    }
    if (activeStep === 1) {
      // Read latest form state directly — avoids stale memo on click.
      const freshType = (getValues('type') as 'flatrate' | 'percentage') || 'flatrate';
      const freshTiers = (getValues('tiers') as AdminTier[] | undefined) || [];
      const hasAny = freshTiers.some((t) => tierHasAnyValue(t, freshType));
      if (!hasAny) {
        setError('Enter a value in at least one tier (base or EE/ES/EC/EF) before continuing.');
        return;
      }
      const normalizedTiers = freshTiers.map((t) => {
        const lvl = Number(t.level);
        const dbName = displayNameByLevel.get(lvl);
        return dbName ? { ...t, name: dbName } : t;
      });
      setValue('tiers', normalizedTiers);
      setTiersSnapshot(JSON.parse(JSON.stringify(normalizedTiers)));
      setPayoutTypeSnapshot(freshType);
    }
    if (activeStep === 2) {
      if (selectedRuleIds.size === 0) {
        setError('Select at least one commission group to update.');
        return;
      }
    }
    if (activeStep < STEPS.length - 1) setActiveStep((s) => s + 1);
  };

  const handleBack = () => {
    setError(null);
    // If user is on the Review step after applying, going back should clear the
    // per-run apply UI so the Apply button comes back on return.
    if (activeStep === STEPS.length - 1 && applyDone) {
      resetApplyRunState();
    }
    if (activeStep > 0) setActiveStep((s) => s - 1);
  };

  const handleApply = async () => {
    setApplying(true);
    setApplyResults({});
    setApplyProgress(0);
    setApplyDone(false);
    const toApply = ruleDiffs.filter((d) => d.hasAnyChange);
    let completed = 0;
    let runSuccess = 0;
    for (const diff of toApply) {
      try {
        await commissionRuleService.updateRule(diff.ruleId, {
          commissionJson: JSON.stringify(diff.mergedCommissionJson) as any,
        });
        setApplyResults((prev) => ({ ...prev, [diff.ruleId]: { ok: true } }));
        // Remember new "existing" state so future re-applies diff correctly.
        setAppliedJsonById((prev) => ({ ...prev, [diff.ruleId]: diff.mergedCommissionJson }));
        runSuccess += 1;
      } catch (e: any) {
        setApplyResults((prev) => ({
          ...prev,
          [diff.ruleId]: { ok: false, error: e?.message || 'Failed to update rule' },
        }));
      } finally {
        completed += 1;
        setApplyProgress(completed);
      }
    }
    setCumulativeSuccessCount((c) => c + runSuccess);
    setApplying(false);
    setApplyDone(true);
  };

  const retryFailed = async () => {
    const failed = Object.entries(applyResults)
      .filter(([, v]) => !v.ok)
      .map(([ruleId]) => ruleId);
    if (failed.length === 0) return;
    setApplying(true);
    let completed = applyProgress;
    let runSuccess = 0;
    for (const ruleId of failed) {
      const diff = ruleDiffs.find((d) => d.ruleId === ruleId);
      if (!diff) continue;
      try {
        await commissionRuleService.updateRule(ruleId, {
          commissionJson: JSON.stringify(diff.mergedCommissionJson) as any,
        });
        setApplyResults((prev) => ({ ...prev, [ruleId]: { ok: true } }));
        setAppliedJsonById((prev) => ({ ...prev, [ruleId]: diff.mergedCommissionJson }));
        runSuccess += 1;
      } catch (e: any) {
        setApplyResults((prev) => ({ ...prev, [ruleId]: { ok: false, error: e?.message || 'Failed to update rule' } }));
      } finally {
        completed += 1;
        setApplyProgress(completed);
      }
    }
    setCumulativeSuccessCount((c) => c + runSuccess);
    setApplying(false);
  };

  /** Clear run-specific state so the Review step shows a fresh "Apply" button for re-applying. */
  const resetApplyRunState = () => {
    setApplyDone(false);
    setApplyResults({});
    setApplyProgress(0);
  };

  const handleFinish = () => {
    onApplied(cumulativeSuccessCount);
  };



  useEffect(() => {
    if (!open || !copyFromOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await commissionGroupsService.listGroups({ limit: 500 });
        if (!cancelled) setCommissionGroups(res.groups ?? []);
      } catch {
        /* keep existing list */
      }
    })();
    return () => { cancelled = true; };
  }, [open, copyFromOpen]);

  useEffect(() => {
    if (!copyFromOpen || !copyGroupId) {
      setCopySourceRule(null);
      setCopyTierLevels(new Set());
      return;
    }
    let cancelled = false;
    (async () => {
      setCopyGroupRulesLoading(true);
      try {
        const list = await commissionGroupsService.listGroupRules(copyGroupId);
        if (cancelled) return;
        const tiered = list.filter(
          (r) => r.EntityType === 'Tier' && r.CommissionType === 'Tiered'
        );
        const match = tiered.find((r) => r.ProductId === scopeProductIdForMatch) ?? null;
        setCopySourceRule(
          match
            ? {
                RuleId: match.RuleId,
                RuleName: match.RuleName,
                ProductId: match.ProductId,
                ProductName: match.ProductName ?? undefined,
                EntityType: 'Tier',
                CommissionType: 'Tiered',
                CommissionJson: match.CommissionJson ?? undefined,
              }
            : null
        );
        if (match?.CommissionJson) {
          try {
            const json = JSON.parse(match.CommissionJson);
            const levels = new Set<number>(
              (json.tiers || [])
                .map((t: { level?: number }) => Number(t.level))
                .filter((n: number) => Number.isFinite(n))
            );
            setCopyTierLevels(levels);
          } catch {
            setCopyTierLevels(new Set());
          }
        } else {
          setCopyTierLevels(new Set());
        }
      } finally {
        if (!cancelled) setCopyGroupRulesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [copyFromOpen, copyGroupId, scopeProductIdForMatch]);

  const toggleCopyTierLevel = (level: number) => {
    setCopyTierLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  };

  const applyCopyFromGroup = async () => {
    if (!copySourceRule || copyTierLevels.size === 0) return;
    setCopyApplying(true);
    setError(null);
    try {
      const full = await commissionRuleService.getRuleById(copySourceRule.RuleId);
      const copied = mapCommissionRuleToFormData(full);
      const sourceTiers = (copied.tiers || []) as AdminTier[];
      const picked = sourceTiers.filter((t) => copyTierLevels.has(Number(t.level)));
      const current = (getValues('tiers') as AdminTier[]) || [];
      const next = [...current];
      for (const st of picked) {
        const lvl = Number(st.level);
        const idx = next.findIndex((t) => Number(t.level) === lvl);
        const clone = JSON.parse(JSON.stringify(st));
        const dbName = displayNameByLevel.get(lvl);
        if (dbName) clone.name = dbName;
        if (idx >= 0) next[idx] = clone;
        else next.push(clone);
      }
      setValue('type', copied.type || 'flatrate');
      setValue('tiers', next);
      setCopySourceGroupId(copyGroupId);
      setSelectedGroupIds((prev) => {
        const next = new Set(prev);
        next.delete(copyGroupId);
        return next;
      });
      setCopyFromOpen(false);
      setCopyGroupId('');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to copy from group');
    } finally {
      setCopyApplying(false);
    }
  };

  const scopeProductLabel = useMemo(() => {
    if (scopeProductId === ALL_PRODUCTS_ID) return 'All Products (global)';
    return productOptions.find((p) => p.id === scopeProductId)?.name || scopeProductId;
  }, [scopeProductId, productOptions]);

  const renderProductStep = () => (
    <Box>
      <Box display="flex" alignItems="center" gap={0.5} mb={1}>
        <Typography variant="h6">Product Scope</Typography>
        <Tooltip title="Eligible: Tier entity + Tiered commission type">
          <IconButton size="small" onClick={() => setProductScopeHelpOpen((o) => !o)} aria-label="Product scope help">
            <InfoOutlinedIcon fontSize="small" color="info" />
          </IconButton>
        </Tooltip>
      </Box>
      {productScopeHelpOpen && (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1.5 }}>
          Choose the product used to match one rule per commission group. Only filled tier slots are pushed on apply.
        </Typography>
      )}
      <FormControl fullWidth size="small">
        <InputLabel>Product</InputLabel>
        <Select
          label="Product"
          value={scopeProductId}
          onChange={(e) => setScopeProductId(String(e.target.value))}
        
          MenuProps={MODAL_SELECT_MENU_PROPS}
        >
          <MenuItem value={ALL_PRODUCTS_ID}>All Products (global)</MenuItem>
          {productOptions.map((p) => (
            <MenuItem key={p.id} value={p.id}>{p.name}</MenuItem>
          ))}
        </Select>
      </FormControl>
      <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
        {rulesFetching
          ? 'Loading rules…'
          : scopeProductId === ALL_PRODUCTS_ID
            ? `${allTieredRules.length} eligible tiered rule(s).`
            : `${scopedRules.length} tiered rule(s) for this product.`}
      </Typography>
    </Box>
  );

  const renderConfigureStep = () => (
    <Box>
      <Box display="flex" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1} mb={1}>
        <Typography variant="h6">Configure Tiers</Typography>
        <Button
          size="small"
          variant="outlined"
          startIcon={<FileCopyIcon />}
          onClick={() => { setCopyGroupId(''); setCopySourceRule(null); setCopyFromOpen(true); }}
        >
          Copy from commission group
        </Button>
      </Box>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 2 }}>
        Add only the tiers you want to change. Blank slots are left unchanged on target rules.
      </Typography>
      <FormProvider {...methods}>
        <CommissionConfigurationStep isEditMode={false} skipAutoInit compactMode inModal />
      </FormProvider>

      <Dialog open={copyFromOpen} onClose={() => !copyApplying && setCopyFromOpen(false)} maxWidth="sm" fullWidth slotProps={{ root: { sx: { zIndex: 1700 } }, paper: { sx: { overflow: 'visible' } } }}>
        <DialogTitle>Copy from commission group</DialogTitle>
        <DialogContent dividers>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 2 }}>
            Copies tier amounts from the group&apos;s rule for <b>{scopeProductLabel}</b> into this wizard.
          </Typography>
          <FormControl fullWidth size="small" sx={{ mb: 2 }}>
            <InputLabel>Commission group</InputLabel>
            <Select
              label="Commission group"
              value={copyGroupId}
              onChange={(e) => setCopyGroupId(String(e.target.value))}
              MenuProps={NESTED_MODAL_SELECT_MENU_PROPS}
            >
              {groupsLoading ? (
                <MenuItem disabled>Loading groups…</MenuItem>
              ) : copyGroupOptions.length === 0 ? (
                <MenuItem disabled>No groups with a rule for this product</MenuItem>
              ) : (
                copyGroupOptions.map((g) => (
                  <MenuItem key={g.CommissionGroupId} value={g.CommissionGroupId}>
                    {g.Name}
                  </MenuItem>
                ))
              )}
            </Select>
          </FormControl>
          {copyGroupRulesLoading ? (
            <Box display="flex" justifyContent="center" py={2}><CircularProgress size={28} /></Box>
          ) : copyGroupId && !copySourceRule ? (
            <Alert severity="warning">No tiered rule in this group for the selected product.</Alert>
          ) : copySourceRule ? (
            <Box>
              <Typography variant="body2" fontWeight={600} sx={{ mb: 1 }}>
                Source: {copySourceRule.RuleName}
              </Typography>
              {(() => {
                const json = parseRuleJson(copySourceRule);
                const tiers: any[] = json?.tiers || [];
                if (tiers.length === 0) {
                  return <Typography variant="caption" color="text.secondary">No tiers on source rule.</Typography>;
                }
                return tiers
                  .slice()
                  .sort((a, b) => Number(a.level) - Number(b.level))
                  .map((t) => (
                    <FormControlLabel
                      key={t.level}
                      control={
                        <Checkbox
                          checked={copyTierLevels.has(Number(t.level))}
                          onChange={() => toggleCopyTierLevel(Number(t.level))}
                        />
                      }
                      label={`${tierDisplayName(Number(t.level), t.name)} (Level ${t.level})`}
                    />
                  ));
              })()}
            </Box>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => !copyApplying && setCopyFromOpen(false)} disabled={copyApplying}>Cancel</Button>
          <Button
            variant="contained"
            onClick={applyCopyFromGroup}
            disabled={!copySourceRule || copyTierLevels.size === 0 || copyApplying}
          >
            {copyApplying ? 'Applying…' : 'Apply'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );

  const renderRuleDiffCard = (diff: RuleDiff) => {
    const expanded = expandedRuleId === diff.ruleId;
    const result = applyResults[diff.ruleId];
    return (
      <Box
        key={diff.ruleId}
        sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, mb: 1, overflow: 'hidden' }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            px: 2,
            py: 1.25,
            bgcolor: 'grey.50',
            cursor: 'pointer',
          }}
          onClick={() => setExpandedRuleId(expanded ? null : diff.ruleId)}
        >
          <Box display="flex" alignItems="center" gap={1} flexWrap="wrap">
            <Typography variant="body2" fontWeight={600}>{diff.ruleName}</Typography>
            <Typography variant="caption" color="textSecondary">· {diff.productName}</Typography>
            {!diff.hasAnyChange && <Chip size="small" label="No changes" variant="outlined" />}
            {diff.hasNewTier && (
              <Chip size="small" label={`+${diff.tierDiffs.filter((t) => t.isNewTier).length} new tier(s)`} sx={{ bgcolor: '#dcfce7', color: '#166534' }} />
            )}
            {diff.hasOverwrite && <Chip size="small" label="Overwrites" sx={{ bgcolor: '#fee2e2', color: '#991b1b' }} />}
            {appliedJsonById[diff.ruleId] && <Chip size="small" label="Previously applied" variant="outlined" color="info" />}
            {!diff.hasOverwrite && !diff.hasNewTier && diff.hasFill && (
              <Chip size="small" label="Fills empty slots" sx={{ bgcolor: '#dbeafe', color: '#1e40af' }} />
            )}
            {result?.ok && <Chip size="small" label="Applied" color="success" />}
            {result && !result.ok && (
              <Tooltip title={result.error || 'Failed'}>
                <Chip size="small" label="Failed" color="error" />
              </Tooltip>
            )}
          </Box>
          <IconButton size="small">{expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}</IconButton>
        </Box>
        {expanded && (
          <Box sx={{ px: 2, py: 1.5, bgcolor: 'background.paper' }}>
            {diff.tierDiffs.length === 0 ? (
              <Typography variant="caption" color="textSecondary">No tier-level changes.</Typography>
            ) : (
              diff.tierDiffs.map((tier) => (
                <Box key={tier.level} sx={{ mb: 1.5 }}>
                  <Box display="flex" alignItems="center" gap={1} mb={0.5}>
                    <Typography variant="body2" fontWeight={600}>{tierDisplayName(tier.level, tier.name)} (Level {tier.level})</Typography>
                    {tier.isNewTier && <Chip size="small" label="New Tier" sx={{ bgcolor: '#dcfce7', color: '#166534', fontWeight: 600 }} />}
                  </Box>
                  <Table size="small" sx={{ '& td, & th': { py: 0.5 } }}>
                    <TableHead>
                      <TableRow>
                        <TableCell>Slot</TableCell>
                        <TableCell>Before</TableCell>
                        <TableCell>After</TableCell>
                        <TableCell>Change</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {tier.slots
                        .filter((s) => !(s.kind === 'unchanged' && isEmpty(s.before) && isEmpty(s.after)))
                        .map((s) => {
                          const changedColor = s.kind === 'new' ? '#166534' : s.kind === 'overwrite' ? '#991b1b' : s.kind === 'fill' ? '#1e40af' : 'inherit';
                          return (
                            <TableRow key={s.slot}>
                              <TableCell><Typography variant="body2" fontWeight={500}>{s.slot === 'base' ? 'Base' : s.slot}</Typography></TableCell>
                              <TableCell><Typography variant="body2" color="textSecondary">{formatSlotValue(s.before, payoutType)}</Typography></TableCell>
                              <TableCell><Typography variant="body2" sx={{ color: changedColor, fontWeight: s.kind === 'unchanged' ? 400 : 600 }}>{formatSlotValue(s.after, payoutType)}</Typography></TableCell>
                              <TableCell>{kindChip(s.kind)}</TableCell>
                            </TableRow>
                          );
                        })}
                    </TableBody>
                  </Table>
                </Box>
              ))
            )}
          </Box>
        )}
      </Box>
    );
  };

  const renderSelectStep = () => {
    const selectedGroupCount = selectedGroupIds.size;
    return (
      <Box>
        <Box display="flex" alignItems="center" justifyContent="space-between" mb={1}>
          <Typography variant="h6">Select Commission Groups</Typography>
          <Box display="flex" gap={1}>
            <Button size="small" variant="outlined" onClick={selectAllCompatibleGroups} disabled={groupsLoading}>Select all compatible</Button>
            <Button size="small" onClick={clearSelection}>Clear</Button>
          </Box>
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ mb: 2, display: 'block' }}>
          {selectedGroupCount} group(s) · {selectedRuleIds.size} rule(s) · Product match: {scopeProductLabel}
          {copySourceGroupId ? ' · Source group hidden (you copied tiers from it)' : ''}
        </Typography>
        {groupsLoading || rulesFetching ? (
          <Box display="flex" justifyContent="center" py={4}><CircularProgress /></Box>
        ) : visibleGroupTargets.length === 0 ? (
          <Alert severity="warning">
            No commission groups have a tiered rule for {scopeProductLabel}. Add the product&apos;s rule to a group, or choose another product in step 1.
          </Alert>
        ) : (
          visibleGroupTargets.map((gt) => {
            const groupChecked = selectedGroupIds.has(gt.groupId);
            const primaryCompat = gt.primaryRule ? getCompatibility(gt.primaryRule) : { compatible: false, reason: 'No matching rule' };
            const advanced = advancedGroupIds.has(gt.groupId);
            return (
              <Box
                key={gt.groupId}
                sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, mb: 1.5, p: 1.5 }}
              >
                <Box display="flex" alignItems="flex-start" gap={1}>
                  <Checkbox
                    checked={groupChecked}
                    disabled={!gt.primaryRule || !primaryCompat.compatible}
                    onChange={() => toggleGroup(gt.groupId)}
                  />
                  <Box flex={1}>
                    <Typography variant="body2" fontWeight={600}>{gt.groupName}</Typography>
                    {gt.primaryRule ? (
                      <Box mt={0.5}>
                        <Typography variant="body2" color="text.primary">
                          {gt.primaryRule.RuleName}
                        </Typography>
                        <Box display="flex" alignItems="center" gap={1} flexWrap="wrap" mt={0.25}>
                          {parseRulePayoutType(gt.primaryRule) && (
                            <Chip size="small" variant="outlined" label={parseRulePayoutType(gt.primaryRule) === 'percentage' ? 'Percentage' : 'Flat Rate'} />
                          )}
                          {!primaryCompat.compatible && (
                            <Typography variant="caption" color="error.main">{primaryCompat.reason}</Typography>
                          )}
                        </Box>
                        {groupChecked && gt.otherRules.length > 0 && (
                          <Button
                            size="small"
                            variant="text"
                            sx={{ mt: 0.5, p: 0, minWidth: 0, textTransform: 'none' }}
                            onClick={() => setGroupAdvanced(gt.groupId, !advanced)}
                          >
                            {advanced ? 'Hide additional rules' : `Show all rules (${gt.otherRules.length})`}
                          </Button>
                        )}
                        <Collapse in={groupChecked && advanced && gt.otherRules.length > 0}>
                          <Box sx={{ mt: 1, pl: 1, borderLeft: '2px solid', borderColor: 'divider' }}>
                            {gt.otherRules.map((r) => {
                              const compat = getCompatibility(r);
                              return (
                                <FormControlLabel
                                  key={r.RuleId}
                                  sx={{ display: 'flex', alignItems: 'flex-start', ml: 0 }}
                                  control={
                                    <Checkbox
                                      size="small"
                                      checked={extraRuleIds.has(r.RuleId)}
                                      disabled={!compat.compatible}
                                      onChange={() => toggleExtraRule(r.RuleId)}
                                    />
                                  }
                                  label={
                                    <Box>
                                      <Typography variant="body2">{r.RuleName}</Typography>
                                      <Typography variant="caption" color="text.secondary">
                                        {r.ProductId === ALL_PRODUCTS_GUID ? 'All Products' : (r.ProductName || r.ProductId)}
                                        {!compat.compatible && ` — ${compat.reason}`}
                                      </Typography>
                                    </Box>
                                  }
                                />
                              );
                            })}
                          </Box>
                        </Collapse>
                      </Box>
                    ) : (
                      <Typography variant="caption" color="warning.main">
                        No tiered rule for {scopeProductLabel} in this group
                      </Typography>
                    )}
                  </Box>
                </Box>
              </Box>
            );
          })
        )}
      </Box>
    );
  };

  const renderReviewStep = () => {
    const changeCount = ruleDiffs.filter((d) => d.hasAnyChange).length;
    const noChangeCount = ruleDiffs.length - changeCount;

    return (
      <Box>
        <Box display="flex" alignItems="center" justifyContent="space-between" mb={1}>
          <Typography variant="h6">Review & Apply</Typography>
          <Box display="flex" gap={1}>
            <Chip size="small" label="New" sx={{ bgcolor: '#dcfce7', color: '#166534', fontWeight: 600 }} />
            <Chip size="small" label="Fill" sx={{ bgcolor: '#dbeafe', color: '#1e40af', fontWeight: 600 }} />
            <Chip size="small" label="Overwrite" sx={{ bgcolor: '#fee2e2', color: '#991b1b', fontWeight: 600 }} />
          </Box>
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ mb: 2, display: 'block' }}>
          {changeCount} changing · {noChangeCount} unchanged · expand for slot detail
        </Typography>

        {(applying || applyDone) && (
          <Box mb={2}>
            <LinearProgress
              variant="determinate"
              value={ruleDiffs.filter((d) => d.hasAnyChange).length === 0
                ? 100
                : (applyProgress / ruleDiffs.filter((d) => d.hasAnyChange).length) * 100}
            />
            <Typography variant="caption" color="textSecondary">
              {applyProgress}/{ruleDiffs.filter((d) => d.hasAnyChange).length} applied
            </Typography>
          </Box>
        )}

        {reviewSections.length === 0 ? (
          <Alert severity="warning">No rules selected.</Alert>
        ) : (
          reviewSections.map((section) => (
            <Box key={section.groupId} sx={{ mb: 2 }}>
              <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1, color: 'text.secondary' }}>
                {section.groupName}
              </Typography>
              {section.diffs.map((diff) => renderRuleDiffCard(diff))}
            </Box>
          ))
        )}
      </Box>
    );
  };

  const renderStep = () => {
    switch (activeStep) {
      case 0: return renderProductStep();
      case 1: return renderConfigureStep();
      case 2: return renderSelectStep();
      case 3: return renderReviewStep();
      default: return null;
    }
  };

  const failedCount = Object.values(applyResults).filter((r) => !r.ok).length;
  const successCount = Object.values(applyResults).filter((r) => r.ok).length;

  return (
    <Dialog open={open} onClose={() => !applying && onClose()} maxWidth="lg" fullWidth disableEscapeKeyDown={applying}>
      <DialogTitle>
        <Box display="flex" alignItems="center" justifyContent="space-between">
          <Typography variant="h6">Mass Update</Typography>
          <IconButton size="small" onClick={() => !applying && onClose()} disabled={applying}>
            <CloseIcon />
          </IconButton>
        </Box>
      </DialogTitle>
      <DialogContent dividers>
        <Stepper activeStep={activeStep} sx={{ mb: 3 }}>
          {STEPS.map((label) => (
            <Step key={label}>
              <StepLabel>{label}</StepLabel>
            </Step>
          ))}
        </Stepper>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {applyDone && (
          <Alert severity={failedCount === 0 ? 'success' : 'warning'} sx={{ mb: 2 }}>
            {failedCount === 0
              ? `Successfully updated ${successCount} rule(s).`
              : `${successCount} succeeded, ${failedCount} failed. Use "Retry failed" to try again.`}
          </Alert>
        )}

        <Box minHeight={420}>{renderStep()}</Box>
      </DialogContent>
      <DialogActions>
        <Button
          onClick={activeStep === 0 ? onClose : handleBack}
          disabled={applying}
          startIcon={<BackIcon />}
        >
          {activeStep === 0 ? 'Cancel' : 'Back'}
        </Button>

        {activeStep < STEPS.length - 1 && (
          <Button variant="contained" onClick={handleNext} endIcon={<NextIcon />}>
            Next
          </Button>
        )}

        {activeStep === STEPS.length - 1 && !applyDone && (
          <Button
            variant="contained"
            color="primary"
            onClick={handleApply}
            disabled={applying || ruleDiffs.filter((d) => d.hasAnyChange).length === 0}
            startIcon={applying ? <CircularProgress size={18} /> : <CheckIcon />}
          >
            {applying
              ? `Applying... (${applyProgress}/${ruleDiffs.filter((d) => d.hasAnyChange).length})`
              : `Apply to ${ruleDiffs.filter((d) => d.hasAnyChange).length} rule(s)`}
          </Button>
        )}

        {activeStep === STEPS.length - 1 && applyDone && failedCount > 0 && (
          <Button variant="outlined" color="warning" onClick={retryFailed} disabled={applying}>
            Retry failed ({failedCount})
          </Button>
        )}

        {activeStep === STEPS.length - 1 && applyDone && (
          <Button
            variant="outlined"
            color="primary"
            onClick={() => {
              // Jump back to Select Rules so the admin can pick a different group,
              // adjust selections, or tweak tiers before re-applying. Run state is
              // cleared so the Apply button reappears on return to Review.
              resetApplyRunState();
              setActiveStep(2);
            }}
            disabled={applying}
          >
            Apply to more rules
          </Button>
        )}

        {activeStep === STEPS.length - 1 && applyDone && (
          <Button variant="contained" onClick={handleFinish}>
            Done
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
};

export default MassUpdateRulesWizard;
