import { AlertCircle, Info, Lock, Unlock, Trash2, Wallet, Plus, Pencil, Loader2, X, Copy } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AgeBand, PricingTier, StepProps } from '../../../types/sysadmin/addproductswizard.types';
import { PRICING_TIERS, TOBACCO_OPTIONS } from '../AddProductWizard';
import { ProductOverridesService, type OverrideACHAccount, type ProductOverride } from '../../../services/product-overrides.service';
import { apiService } from '../../../services/api.service';
import type { PaymentProcessorSettings } from '../../../types/paymentProcessorSettings';
import {
  calculateWizardIncludedProcessingFee,
  getHighestFeeConfigForWizardDisplay
} from '../../../utils/wizardIncludedProcessingFee';
import { calculatePricingComponentBase } from '../../../utils/wizardPricingMsrp';

const isGuid = (value: string | undefined): boolean => {
  if (!value) return false;
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
};

/** Normalize GUID for comparison (strip non-hex, lowercase) so DB/frontend format differences don't hide overrides */
const normalizePricingId = (value: string | undefined | null): string => {
  if (value == null) return '';
  const s = String(value).trim().toLowerCase().replace(/[-{}\s]/g, '');
  return s.replace(/[^0-9a-f]/g, '');
};

const findOverrideForAchOnPricingBand = (
  overrides: ProductOverride[],
  productPricingId: string,
  overrideACHId: string,
  excludeOverrideId?: string
): ProductOverride | undefined => {
  const pricingKey = normalizePricingId(productPricingId);
  const achKey = normalizePricingId(overrideACHId);
  if (!pricingKey || !achKey) return undefined;
  return overrides.find(
    (o) =>
      normalizePricingId(o.ProductPricingId) === pricingKey &&
      normalizePricingId(o.OverrideACHId) === achKey &&
      (!excludeOverrideId || o.OverrideId !== excludeOverrideId)
  );
};

const projectedActiveOverrideTotal = (
  bandOverrides: ProductOverride[],
  amount: number,
  isActive: boolean,
  replaceExisting?: ProductOverride
): number => {
  const othersTotal = bandOverrides
    .filter(
      (o) =>
        o.IsActive && (!replaceExisting || o.OverrideId !== replaceExisting.OverrideId)
    )
    .reduce((sum, o) => sum + (Number(o.OverrideAmount) || 0), 0);
  return othersTotal + (isActive ? amount : 0);
};

/** Prefer persisted ProductPricingId over client band.id (wizard can keep a stale id after save). */
const resolveBandProductPricingId = (band: AgeBand): string => {
  const persisted = band.productPricingId != null ? String(band.productPricingId).trim() : '';
  if (persisted && isGuid(persisted)) {
    return persisted;
  }
  if (isGuid(band.id)) {
    return band.id;
  }
  return '';
};

interface Step4PricingProps extends StepProps {
  onValidationChange?: (hasErrors: boolean) => void;
  editingProductId?: string;
  pricingTiersRevision?: number;
}

interface OverrideFormState {
  overrideACHId: string;
  overrideAmount: string;
  priority: string;
  effectiveDate: string;
  isActive: boolean;
}

const formatCurrency = (value: number): string => {
  if (!isFinite(value)) {
    return '$0.00';
  }
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
};

/** Last four digits from masked account (e.g. *****1234) for ACH labels */
const formatAchLast4Suffix = (masked?: string | null): string => {
  if (!masked) return '';
  const digits = String(masked).replace(/\D/g, '');
  const last4 = digits.slice(-4);
  return last4.length === 4 ? ` ••••${last4}` : '';
};

const formatAchAccountSelectLabel = (account: OverrideACHAccount): string => {
  const name = (account.AccountName || account.AccountHolderName) ?? 'Override Account';
  return `${name} • ${account.BankName}${formatAchLast4Suffix(account.maskedAccountNumber)}`;
};

type PricingBandOverrideTarget = {
  tierId: string;
  bandId: string;
  productPricingId: string;
  label: string;
  overrideRate: number;
};

const toDateInputValue = (value?: string | null): string => {
  if (!value) return '';
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    return value.toString().slice(0, 10);
  }
  return date.toISOString().split('T')[0];
};

type OverrideModalState = {
  tierId: string;
  bandId: string;
  productPricingId: string;
  bandLabel: string;
  tierLabel: string;
  overrideRate: number;
  bandEffectiveDate?: string | null;
  bandEndDate?: string | null;
};

export default function Step4Pricing({ formData, updateFormData, onValidationChange, editingProductId, pricingTiersRevision = 0 }: Step4PricingProps) {
  const [selectedTierId, setSelectedTierId] = useState<string | null>(null);
  const [selectedStartDateFilter, setSelectedStartDateFilter] = useState<string>('all');
  const [showPhaseInModal, setShowPhaseInModal] = useState(false);
  const [phaseInEndDate, setPhaseInEndDate] = useState('');
  const [phaseInError, setPhaseInError] = useState<string | null>(null);
  const [ageBandErrors, setAgeBandErrors] = useState<{[tierId: string]: string[]}>({});
  const [overrideModalState, setOverrideModalState] = useState<OverrideModalState | null>(null);
  const [overrideModalData, setOverrideModalData] = useState<{
    overrides: ProductOverride[];
    achAccounts: OverrideACHAccount[];
    loading: boolean;
    error: string | null;
  }>({ overrides: [], achAccounts: [], loading: false, error: null });
  const [overrideForm, setOverrideForm] = useState<OverrideFormState>({
    overrideACHId: '',
    overrideAmount: '',
    priority: '',
    effectiveDate: '',
    isActive: true
  });
  const [overrideActionError, setOverrideActionError] = useState<string | null>(null);
  const [overrideSuccessMessage, setOverrideSuccessMessage] = useState<string | null>(null);
  const [bulkOverwritePrompt, setBulkOverwritePrompt] = useState<{ tierLabels: string[] } | null>(null);
  const [overrideSaving, setOverrideSaving] = useState(false);
  const [editingOverride, setEditingOverride] = useState<ProductOverride | null>(null);
  const [collapsedBands, setCollapsedBands] = useState<Record<string, boolean>>({});
  const [showViewAllOverridesModal, setShowViewAllOverridesModal] = useState(false);
  const [viewAllOverrides, setViewAllOverrides] = useState<ProductOverride[]>([]);
  const [viewAllOverridesLoading, setViewAllOverridesLoading] = useState(false);
  const [viewAllFilterACHId, setViewAllFilterACHId] = useState<string>('');
  const [viewAllFilterPricingId, setViewAllFilterPricingId] = useState<string>('');
  const [viewAllAchAccounts, setViewAllAchAccounts] = useState<OverrideACHAccount[]>([]);
  const [ownerPaymentSettings, setOwnerPaymentSettings] = useState<PaymentProcessorSettings | null>(null);
  const [ownerPaymentSettingsLoading, setOwnerPaymentSettingsLoading] = useState(false);
  const [showACHForm, setShowACHForm] = useState(false);
  const [achFormMode, setACHFormMode] = useState<'create' | 'edit'>('create');
  const [achFormSaving, setACHFormSaving] = useState(false);
  const [achFormLoading, setACHFormLoading] = useState(false);
  const [achFormError, setACHFormError] = useState<string | null>(null);
  const [editingACHAccountId, setEditingACHAccountId] = useState<string | null>(null);
  const [achMaskedRouting, setAchMaskedRouting] = useState<string | null>(null);
  const [achMaskedAccount, setAchMaskedAccount] = useState<string | null>(null);
  const [achFormData, setACHFormData] = useState({
    accountName: '',
    accountHolderName: '',
    bankName: '',
    accountNumber: '',
    routingNumber: '',
    bankAccountType: 'Checking' as 'Checking' | 'Savings' | 'Business' | 'Individual'
  });

  const tenantIdForOverrides = formData.productOwnerId || undefined;

  const achAccountById = useMemo(() => {
    const map = new Map<string, OverrideACHAccount>();
    overrideModalData.achAccounts.forEach((account) => {
      map.set(account.OverrideACHId, account);
    });
    viewAllAchAccounts.forEach((account) => {
      if (!map.has(account.OverrideACHId)) {
        map.set(account.OverrideACHId, account);
      }
    });
    return map;
  }, [overrideModalData.achAccounts, viewAllAchAccounts]);

  const formatOverrideAchDisplay = useCallback(
    (override: ProductOverride): { primary: string; secondary: string } => {
      const ach = override.OverrideACHId ? achAccountById.get(override.OverrideACHId) : undefined;
      const last4Suffix = formatAchLast4Suffix(ach?.maskedAccountNumber);
      return {
        primary: `${override.ACHAccountName || override.OverrideName || 'Override Distribution'}${last4Suffix}`,
        secondary: `${override.ACHBankName || 'Account'}${last4Suffix}`
      };
    },
    [achAccountById]
  );

  const collectSavedPricingBandTargets = useCallback((): PricingBandOverrideTarget[] => {
    const targets: PricingBandOverrideTarget[] = [];
    formData.pricingTiers.forEach((tier, tierIndex) => {
      const tierLabel = tier.label || tier.tierType || `Tier ${tierIndex + 1}`;
      tier.ageBands.forEach((band) => {
        const useModalPricingId =
          overrideModalState &&
          tier.id === overrideModalState.tierId &&
          band.id === overrideModalState.bandId;
        const productPricingId = useModalPricingId
          ? overrideModalState.productPricingId
          : resolveBandProductPricingId(band);
        if (!productPricingId) return;
        targets.push({
          tierId: tier.id,
          bandId: band.id,
          productPricingId,
          label: `${tierLabel} • ${band.minAge}-${band.maxAge} (${band.tobaccoStatus})`,
          overrideRate: band.overrideRate || 0
        });
      });
    });
    return targets;
  }, [formData.pricingTiers, overrideModalState]);

  const bulkOverrideBandTargets = useMemo(
    () => collectSavedPricingBandTargets(),
    [collectSavedPricingBandTargets]
  );

  const applyOverridesToPricingTiers = useCallback(
    (tiers: PricingTier[], allOverrides: ProductOverride[]): PricingTier[] => {
      const byPricingId = new Map<string, ProductOverride[]>();
      allOverrides.forEach((override) => {
        const key = normalizePricingId(override.ProductPricingId);
        if (!key) return;
        const list = byPricingId.get(key) || [];
        list.push(override);
        byPricingId.set(key, list);
      });

      return tiers.map((tier) => ({
        ...tier,
        ageBands: tier.ageBands.map((band) => {
          const productPricingId = resolveBandProductPricingId(band);
          const key = normalizePricingId(productPricingId);
          if (!key) return band;
          const overrides = (byPricingId.get(key) || []).slice().sort((a, b) => {
            const dA = a.EffectiveDate ? new Date(a.EffectiveDate).getTime() : 0;
            const dB = b.EffectiveDate ? new Date(b.EffectiveDate).getTime() : 0;
            return dA - dB;
          });
          return { ...band, overrides, productPricingId };
        })
      }));
    },
    []
  );

  const chargeFeeToMemberEnabled = ownerPaymentSettings?.chargeFeeToMember === true;
  /** Catalog pricing can bake fees into MSRP regardless of owner checkout fee policy. */
  const catalogIncludeFeeOptions = { ignoreChargeFeeToMember: true as const };
  const manualFeeEntry = formData.manualIncludedProcessingFee === true;
  const includeProcessingFeeDisabled =
    ownerPaymentSettingsLoading || !formData.productOwnerId || manualFeeEntry;
  const autoFeeControlsDisabled = includeProcessingFeeDisabled || manualFeeEntry;

  const sampleBaseForFeeHint = useMemo(() => {
    for (const tier of formData.pricingTiers) {
      for (const band of tier.ageBands) {
        const base = calculatePricingComponentBase(
          band.netRate || 0,
          band.overrideRate || 0,
          band.commission || 0
        );
        if (base > 0) return base;
      }
    }
    return 100;
  }, [formData.pricingTiers]);

  const highestFeeConfig = useMemo(
    () =>
      getHighestFeeConfigForWizardDisplay(
        ownerPaymentSettings,
        sampleBaseForFeeHint,
        formData.roundUpProcessingFee !== false,
        catalogIncludeFeeOptions
      ),
    [ownerPaymentSettings, sampleBaseForFeeHint, formData.roundUpProcessingFee]
  );

  const effectiveProcessingFeePct = useMemo(() => {
    if (formData.processingFeePercentage != null && !Number.isNaN(Number(formData.processingFeePercentage))) {
      return Number(formData.processingFeePercentage);
    }
    return highestFeeConfig?.percentage ?? null;
  }, [formData.processingFeePercentage, highestFeeConfig]);

  const computeBandIncludedFee = useCallback(
    (msrpRate: number) => {
      if (!formData.includeProcessingFee) return 0;
      return calculateWizardIncludedProcessingFee(
        msrpRate,
        ownerPaymentSettings,
        formData.roundUpProcessingFee !== false,
        {
          percentage: effectiveProcessingFeePct,
          flatFee: highestFeeConfig?.flatFee ?? 0,
          ...catalogIncludeFeeOptions
        }
      );
    },
    [
      formData.includeProcessingFee,
      formData.roundUpProcessingFee,
      ownerPaymentSettings,
      effectiveProcessingFeePct,
      highestFeeConfig
    ]
  );

  const applyIncludedFeesToTiers = useCallback(
    (tiers: PricingTier[]) =>
      tiers.map((tier) => ({
        ...tier,
        ageBands: tier.ageBands.map((band) => {
          const componentBase = calculatePricingComponentBase(
            band.netRate || 0,
            band.overrideRate || 0,
            band.commission || 0
          );
          const includedProcessingFee = computeBandIncludedFee(componentBase);
          const msrpRate = formData.includeProcessingFee
            ? Math.round((componentBase + includedProcessingFee) * 100) / 100
            : componentBase;
          return {
            ...band,
            includedProcessingFee,
            msrpRate
          };
        })
      })),
    [computeBandIncludedFee, formData.includeProcessingFee]
  );

  useEffect(() => {
    let cancelled = false;
    const ownerId = formData.productOwnerId?.trim();
    if (!ownerId) {
      setOwnerPaymentSettings(null);
      return;
    }
    setOwnerPaymentSettingsLoading(true);
    apiService
      .get(`/api/tenants/${ownerId}/payment-settings`)
      .then((resp: { success?: boolean; data?: { paymentProcessorSettings?: PaymentProcessorSettings } }) => {
        if (!cancelled) {
          setOwnerPaymentSettings(resp?.success ? resp.data?.paymentProcessorSettings ?? null : null);
        }
      })
      .catch(() => {
        if (!cancelled) setOwnerPaymentSettings(null);
      })
      .finally(() => {
        if (!cancelled) setOwnerPaymentSettingsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [formData.productOwnerId]);

  const pricingMsrpSignature = useMemo(
    () =>
      JSON.stringify(
        formData.pricingTiers.map((t) =>
          t.ageBands.map((b) => [b.minAge, b.maxAge, b.msrpRate, b.netRate])
        )
      ),
    [formData.pricingTiers]
  );

  useEffect(() => {
    if (!formData.includeProcessingFee || formData.pricingTiers.length === 0 || manualFeeEntry) return;
    const withFees = applyIncludedFeesToTiers(formData.pricingTiers);
    const changed = withFees.some((tier, ti) =>
      tier.ageBands.some(
        (b, bi) =>
          Math.abs((b.includedProcessingFee || 0) - (formData.pricingTiers[ti]?.ageBands[bi]?.includedProcessingFee || 0)) > 0.001
      )
    );
    if (changed) {
      updateFormData({ pricingTiers: withFees });
    }
  }, [
    formData.includeProcessingFee,
    formData.manualIncludedProcessingFee,
    formData.roundUpProcessingFee,
    formData.processingFeePercentage,
    ownerPaymentSettings,
    applyIncludedFeesToTiers,
    pricingMsrpSignature,
    pricingTiersRevision,
  ]);

  // Seed % from owner tenant when enabling inclusion and no saved product value yet
  useEffect(() => {
    if (manualFeeEntry || !highestFeeConfig || !formData.includeProcessingFee) return;
    if (formData.processingFeePercentage != null && !Number.isNaN(Number(formData.processingFeePercentage))) {
      return;
    }
    updateFormData({ processingFeePercentage: highestFeeConfig.percentage });
  }, [highestFeeConfig, formData.includeProcessingFee, formData.manualIncludedProcessingFee, formData.processingFeePercentage, updateFormData]);

  const TIER_TYPE_DISPLAY_ORDER: Record<string, number> = {
    EE: 1,
    ES: 2,
    EC: 3,
    EF: 4
  };

  const getTierEffectiveDates = useCallback((tier: PricingTier): string[] => {
    return Array.from(
      new Set(
        tier.ageBands
          .map((band) => (band.effectiveDate || '').trim())
          .filter(Boolean)
      )
    ).sort((a, b) => b.localeCompare(a));
  }, []);

  const getTierStartDate = useCallback((tier: PricingTier): string => {
    const effectiveDates = getTierEffectiveDates(tier);
    return effectiveDates[0] || '';
  }, [getTierEffectiveDates]);

  const getNextDay = (dateValue: string): string => {
    const date = new Date(`${dateValue}T00:00:00`);
    date.setDate(date.getDate() + 1);
    return date.toISOString().split('T')[0];
  };

  const getSortedTiers = useCallback((tiers: PricingTier[]): PricingTier[] => {
    return [...tiers].sort((a, b) => {
      const orderA = TIER_TYPE_DISPLAY_ORDER[a.tierType] ?? 99;
      const orderB = TIER_TYPE_DISPLAY_ORDER[b.tierType] ?? 99;
      if (orderA !== orderB) return orderA - orderB;

      const startA = getTierStartDate(a);
      const startB = getTierStartDate(b);
      if (startA !== startB) {
        return startB.localeCompare(startA);
      }

      return (a.label || '').localeCompare(b.label || '');
    });
  }, [getTierStartDate]);

  const uniqueStartDates = useMemo(() => {
    const dates = new Set<string>();
    formData.pricingTiers.forEach((tier) => {
      getTierEffectiveDates(tier).forEach((start) => dates.add(start));
    });
    return Array.from(dates).sort((a, b) => b.localeCompare(a));
  }, [formData.pricingTiers, getTierEffectiveDates]);

  const filteredAndSortedTiers = useMemo(() => {
    const filteredTiers = selectedStartDateFilter === 'all'
      ? formData.pricingTiers
      : formData.pricingTiers.filter((tier) => getTierEffectiveDates(tier).includes(selectedStartDateFilter));
    return getSortedTiers(filteredTiers);
  }, [formData.pricingTiers, getSortedTiers, getTierEffectiveDates, selectedStartDateFilter]);

  const getFilteredBandsForTier = useCallback((tier: PricingTier): AgeBand[] => {
    if (selectedStartDateFilter === 'all') {
      return tier.ageBands;
    }
    return tier.ageBands.filter((band) => (band.effectiveDate || '').trim() === selectedStartDateFilter);
  }, [selectedStartDateFilter]);

  const resetACHForm = useCallback(() => {
    setShowACHForm(false);
    setACHFormMode('create');
    setEditingACHAccountId(null);
    setAchMaskedRouting(null);
    setAchMaskedAccount(null);
    setACHFormError(null);
    setACHFormData({
      accountName: '',
      accountHolderName: '',
      bankName: '',
      accountNumber: '',
      routingNumber: '',
      bankAccountType: 'Checking'
    });
  }, []);

  const resetOverrideForm = useCallback(() => {
    setEditingOverride(null);
    resetACHForm();
    setOverrideForm({
      overrideACHId: '',
      overrideAmount: '',
      priority: '',
      effectiveDate: overrideModalState?.bandEffectiveDate ? toDateInputValue(overrideModalState.bandEffectiveDate) : '',
      isActive: true
    });
    setOverrideActionError(null);
    setOverrideSuccessMessage(null);
    setBulkOverwritePrompt(null);
  }, [overrideModalState, resetACHForm]);

  const closeOverrideModal = useCallback(() => {
    setOverrideModalState(null);
    setOverrideModalData({ overrides: [], achAccounts: [], loading: false, error: null });
    setOverrideActionError(null);
    setOverrideSuccessMessage(null);
    setBulkOverwritePrompt(null);
    setOverrideSaving(false);
    setEditingOverride(null);
    resetACHForm();
    setOverrideForm({
      overrideACHId: '',
      overrideAmount: '',
      priority: '',
      effectiveDate: '',
      isActive: true
    });
  }, [resetACHForm]);

  const reloadACHAccounts = useCallback(async () => {
    const achResponse = await ProductOverridesService.getOverrideACHAccounts(tenantIdForOverrides);
    const achAccounts = achResponse.success && achResponse.data ? achResponse.data : [];
    setOverrideModalData(prev => ({ ...prev, achAccounts }));
    return achAccounts;
  }, [tenantIdForOverrides]);

  const handleOpenCreateACHForm = () => {
    resetACHForm();
    setShowACHForm(true);
    setACHFormMode('create');
  };

  const handleOpenEditACHForm = async (overrideAchId: string) => {
    if (!overrideAchId) return;

    setACHFormError(null);
    setACHFormLoading(true);
    setShowACHForm(true);
    setACHFormMode('edit');
    setEditingACHAccountId(overrideAchId);

    const account = overrideModalData.achAccounts.find(a => a.OverrideACHId === overrideAchId);
    setAchMaskedRouting(account?.maskedRoutingNumber || null);
    setAchMaskedAccount(account?.maskedAccountNumber || null);

    try {
      const response = await ProductOverridesService.getOverrideACHAccountForEdit(
        overrideAchId,
        tenantIdForOverrides
      );
      if (response.success && response.data) {
        const d = response.data;
        setACHFormData({
          accountName: (d.AccountName && String(d.AccountName).trim()) || '',
          accountHolderName: d.AccountHolderName || '',
          bankName: d.BankName || '',
          accountNumber: d.accountNumber || '',
          routingNumber: d.routingNumber || '',
          bankAccountType: d.BankAccountType || 'Checking'
        });
      } else {
        setACHFormError(response.message || 'Failed to load account details.');
        setShowACHForm(false);
      }
    } catch (error: any) {
      setACHFormError(error?.response?.data?.message || error?.message || 'Failed to load account details.');
      setShowACHForm(false);
    } finally {
      setACHFormLoading(false);
    }
  };

  const handleSubmitACHAccount = async () => {
    const trimmedName = achFormData.accountName.trim();
    const trimmedHolder = achFormData.accountHolderName.trim();
    const trimmedBank = achFormData.bankName.trim();
    const sanitizedRouting = achFormData.routingNumber.replace(/\D/g, '');
    const sanitizedAccount = achFormData.accountNumber.replace(/\D/g, '');

    if (
      !trimmedName ||
      !trimmedHolder ||
      !trimmedBank ||
      sanitizedRouting.length !== 9 ||
      sanitizedAccount.length === 0
    ) {
      setACHFormError('Please fill in all required ACH account fields.');
      return;
    }

    setACHFormSaving(true);
    setACHFormError(null);

    try {
      const payload = {
        accountName: trimmedName,
        accountHolderName: trimmedHolder,
        bankName: trimmedBank,
        accountNumber: sanitizedAccount,
        routingNumber: sanitizedRouting,
        bankAccountType: achFormData.bankAccountType
      };

      const response =
        achFormMode === 'edit' && editingACHAccountId
          ? await ProductOverridesService.updateACHAccount(
              editingACHAccountId,
              payload,
              tenantIdForOverrides
            )
          : await ProductOverridesService.createACHAccount(payload, tenantIdForOverrides);

      if (response.success && response.data) {
        await reloadACHAccounts();
        setOverrideForm(prev => ({ ...prev, overrideACHId: response.data!.OverrideACHId }));
        resetACHForm();
      } else {
        setACHFormError(
          response.message ||
            `Failed to ${achFormMode === 'edit' ? 'update' : 'create'} ACH account.`
        );
      }
    } catch (error: any) {
      setACHFormError(
        error?.response?.data?.message ||
          error?.message ||
          `Failed to ${achFormMode === 'edit' ? 'update' : 'create'} ACH account.`
      );
    } finally {
      setACHFormSaving(false);
    }
  };

  const loadOverrideData = async (tierId: string, bandId: string, productPricingId: string) => {
    if (!editingProductId) {
      setOverrideModalData(prev => ({ ...prev, loading: false, error: 'Overrides are available after the product has been saved.' }));
      return;
    }

    setOverrideModalData(prev => ({ ...prev, loading: true, error: null }));

    try {
      const [overridesResponse, achResponse] = await Promise.all([
        ProductOverridesService.getProductOverrides(editingProductId),
        ProductOverridesService.getOverrideACHAccounts(tenantIdForOverrides)
      ]);

      const allOverrides =
        overridesResponse.success && overridesResponse.data
          ? overridesResponse.data.map((override) => ({
              ...override,
              OverrideAmount: Number(override.OverrideAmount ?? 0)
            }))
          : [];

      const normalizedBandId = normalizePricingId(productPricingId);
      const overrides = allOverrides.filter(
        (override) => normalizePricingId(override.ProductPricingId) === normalizedBandId
      );

      const achAccounts = achResponse.success && achResponse.data ? achResponse.data : [];

      setOverrideModalData({ overrides, achAccounts, loading: false, error: null });
      updateFormData({
        pricingTiers: applyOverridesToPricingTiers(formData.pricingTiers, allOverrides)
      });
    } catch (error: any) {
      const message = error?.response?.data?.message || error?.message || 'Failed to load override data. Please try again.';
      setOverrideModalData(prev => ({ ...prev, loading: false, error: message }));
    }
  };

  const openOverrideModal = (tier: PricingTier, band: AgeBand) => {
    if (!editingProductId) {
      setOverrideActionError('Overrides are available after the product has been created.');
      return;
    }

    const productPricingId = resolveBandProductPricingId(band);
    if (!productPricingId) {
      setOverrideActionError('Save this age band before managing overrides.');
      return;
    }

    const tierIndex = formData.pricingTiers.findIndex(t => t.id === tier.id);
    const tierLabel = tier.label || `Tier ${tierIndex + 1}`;
    const bandLabel = `${band.minAge}-${band.maxAge} (${band.tobaccoStatus})`;

    const modalState: OverrideModalState = {
      tierId: tier.id,
      bandId: band.id,
      productPricingId,
      tierLabel,
      bandLabel,
      overrideRate: band.overrideRate || 0,
      bandEffectiveDate: band.effectiveDate || null,
      bandEndDate: band.terminationDate || null
    };

    setOverrideModalState(modalState);
    setOverrideModalData(prev => ({ ...prev, overrides: [], achAccounts: [], loading: true, error: null }));
    setOverrideSaving(false);
    setOverrideActionError(null);
    setOverrideSuccessMessage(null);
    setBulkOverwritePrompt(null);
    setEditingOverride(null);
    resetACHForm();
    setOverrideForm({
      overrideACHId: '',
      overrideAmount: '',
      priority: '',
      effectiveDate: modalState.bandEffectiveDate ? toDateInputValue(modalState.bandEffectiveDate) : '',
      isActive: true
    });

    loadOverrideData(tier.id, band.id, productPricingId);
  };

  const handleOverrideEdit = (override: ProductOverride) => {
    resetACHForm();
    setEditingOverride(override);
    setOverrideForm({
      overrideACHId: override.OverrideACHId || '',
      overrideAmount: (Number(override.OverrideAmount ?? 0)).toString(),
      priority: '',
      effectiveDate: override.EffectiveDate ? toDateInputValue(override.EffectiveDate) : '',
      isActive: override.IsActive
    });
    setOverrideActionError(null);
  };

  const handleOverrideSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!overrideModalState || !editingProductId) {
      return;
    }

    if (!formData.productOwnerId) {
      setOverrideActionError('Select a product owner before managing overrides.');
      return;
    }

    if (!overrideForm.overrideACHId) {
      setOverrideActionError('Select an override account.');
      return;
    }

    const amount = parseFloat(overrideForm.overrideAmount);
    if (!amount || amount <= 0) {
      setOverrideActionError('Enter a valid override amount greater than 0.');
      return;
    }

    const existingSameAch = findOverrideForAchOnPricingBand(
      overrideModalData.overrides,
      overrideModalState.productPricingId,
      overrideForm.overrideACHId,
      editingOverride?.OverrideId
    );

    if (existingSameAch) {
      setOverrideActionError(
        'This bank account already has an override on this pricing tier. Edit the existing row or choose a different account.'
      );
      return;
    }

    const projectedTotal = projectedActiveOverrideTotal(
      overrideModalData.overrides,
      amount,
      overrideForm.isActive,
      editingOverride ?? undefined
    );
    if (projectedTotal > overrideModalState.overrideRate) {
      setOverrideActionError(
        `Active overrides cannot exceed ${formatCurrency(overrideModalState.overrideRate)}. Projected active total is ${formatCurrency(projectedTotal)}.`
      );
      return;
    }

    setOverrideSaving(true);
    setOverrideActionError(null);

    const payload = {
      tenantId: formData.productOwnerId,
      overrideACHId: overrideForm.overrideACHId,
      overrideAmount: amount,
      priority: editingOverride?.Priority ?? overrideModalData.overrides.length + 1,
      isActive: overrideForm.isActive,
      effectiveDate: overrideForm.effectiveDate || (overrideModalState.bandEffectiveDate ? toDateInputValue(overrideModalState.bandEffectiveDate) : ''),
      productPricingId: overrideModalState.productPricingId
    };

    try {
      let response;
      if (editingOverride) {
        response = await ProductOverridesService.updateOverride(editingProductId, editingOverride.OverrideId, {
          ...payload,
          overrideName: editingOverride.OverrideName || undefined,
          priority: editingOverride.Priority ?? overrideModalData.overrides.length,
          expirationDate: editingOverride.ExpirationDate ? toDateInputValue(editingOverride.ExpirationDate) : undefined
        });
      } else {
        response = await ProductOverridesService.createOverride(editingProductId, payload);
      }

      if (!response.success) {
        setOverrideSuccessMessage(null);
        setOverrideActionError(response.message || 'Failed to save override.');
      } else if (overrideModalState) {
        setOverrideSuccessMessage('Override saved.');
        resetOverrideForm();
        await loadOverrideData(overrideModalState.tierId, overrideModalState.bandId, overrideModalState.productPricingId);
      }
    } catch (error: any) {
      const message = error?.response?.data?.message || error?.message || 'Failed to save override. Please try again.';
      setOverrideActionError(message);
    } finally {
      setOverrideSaving(false);
    }
  };

  const validateOverrideFitsAllPricingBands = useCallback(
    (
      targets: PricingBandOverrideTarget[],
      allOverrides: ProductOverride[],
      amount: number,
      isActive: boolean,
      overrideACHId: string
    ): { ok: true } | { ok: false; culprits: string[]; skippedUnsaved: number } => {
      if (targets.length === 0) {
        return { ok: false, culprits: [], skippedUnsaved: formData.pricingTiers.reduce((n, t) => n + t.ageBands.length, 0) };
      }

      if (!isActive) {
        return { ok: true };
      }

      const overridesByPricingId = new Map<string, ProductOverride[]>();
      allOverrides.forEach((o) => {
        const key = normalizePricingId(o.ProductPricingId);
        if (!key) return;
        const list = overridesByPricingId.get(key) || [];
        list.push(o);
        overridesByPricingId.set(key, list);
      });

      const culprits: string[] = [];
      for (const target of targets) {
        const key = normalizePricingId(target.productPricingId);
        const bandOverrides = overridesByPricingId.get(key) || [];
        const existingSameAch = findOverrideForAchOnPricingBand(
          bandOverrides,
          target.productPricingId,
          overrideACHId
        );
        const projected = projectedActiveOverrideTotal(
          bandOverrides,
          amount,
          isActive,
          existingSameAch
        );
        if (projected > target.overrideRate) {
          culprits.push(
            `${target.label} (pool ${formatCurrency(target.overrideRate)}, would be ${formatCurrency(projected)})`
          );
        }
      }

      const unsavedBandCount = formData.pricingTiers.reduce((count, tier) => {
        return (
          count +
          tier.ageBands.filter((band) => !resolveBandProductPricingId(band)).length
        );
      }, 0);

      if (culprits.length > 0) {
        return { ok: false, culprits, skippedUnsaved: unsavedBandCount };
      }
      return { ok: true };
    },
    [formData.pricingTiers]
  );

  const applyBulkOverridesToAllTiers = async (
    allOverrides: ProductOverride[],
    amount: number,
    effectiveDate: string
  ) => {
    if (!overrideModalState || !editingProductId || !formData.productOwnerId) {
      return;
    }

    const targets = bulkOverrideBandTargets;
    const achId = overrideForm.overrideACHId;
    const failures: string[] = [];
    let createdCount = 0;
    let updatedCount = 0;

    for (const target of targets) {
      const existing = findOverrideForAchOnPricingBand(
        allOverrides,
        target.productPricingId,
        achId
      );
      const payload = {
        tenantId: formData.productOwnerId,
        overrideACHId: achId,
        overrideAmount: amount,
        priority: existing?.Priority ?? overrideModalData.overrides.length + 1,
        isActive: overrideForm.isActive,
        effectiveDate,
        productPricingId: target.productPricingId
      };

      try {
        const response = existing
          ? await ProductOverridesService.updateOverride(editingProductId, existing.OverrideId, {
              ...payload,
              overrideName: existing.OverrideName || undefined,
              expirationDate: existing.ExpirationDate
                ? toDateInputValue(existing.ExpirationDate)
                : undefined
            })
          : await ProductOverridesService.createOverride(editingProductId, payload);

        if (response.success) {
          if (existing) {
            updatedCount += 1;
          } else {
            createdCount += 1;
          }
        } else {
          failures.push(`${target.label}: ${response.message || 'Failed'}`);
        }
      } catch (error: any) {
        const message = error?.response?.data?.message || error?.message || 'Failed';
        failures.push(`${target.label}: ${message}`);
      }
    }

    const successCount = createdCount + updatedCount;
    if (failures.length > 0) {
      setOverrideSuccessMessage(null);
      setOverrideActionError(
        `Applied to ${successCount} of ${targets.length} pricing tier(s). Failed: ${failures.join('; ')}`
      );
    } else if (successCount === 0) {
      setOverrideSuccessMessage(null);
      setOverrideActionError('No overrides were created or updated. Check your connection and try again.');
    } else {
      setOverrideActionError(null);
      const parts: string[] = [];
      if (createdCount > 0) {
        parts.push(`added ${createdCount}`);
      }
      if (updatedCount > 0) {
        parts.push(`updated ${updatedCount}`);
      }
      setOverrideSuccessMessage(
        `Override ${parts.join(' and ')} on ${successCount} pricing tier${successCount === 1 ? '' : 's'}.`
      );
      resetOverrideForm();
    }

    await loadOverrideData(
      overrideModalState.tierId,
      overrideModalState.bandId,
      overrideModalState.productPricingId
    );
  };

  const handleConfirmBulkOverwrite = async () => {
    if (!editingProductId || !overrideModalState) {
      setBulkOverwritePrompt(null);
      return;
    }

    const amount = parseFloat(overrideForm.overrideAmount);
    const effectiveDate =
      overrideForm.effectiveDate ||
      (overrideModalState.bandEffectiveDate ? toDateInputValue(overrideModalState.bandEffectiveDate) : '');

    setBulkOverwritePrompt(null);
    setOverrideSaving(true);
    setOverrideActionError(null);
    setOverrideSuccessMessage(null);

    try {
      const res = await ProductOverridesService.getProductOverrides(editingProductId);
      const allOverrides = res.success && res.data ? res.data : [];
      await applyBulkOverridesToAllTiers(allOverrides, amount, effectiveDate);
    } catch (error: any) {
      const message =
        error?.response?.data?.message || error?.message || 'Failed to add overrides to all pricing tiers.';
      setOverrideActionError(message);
    } finally {
      setOverrideSaving(false);
    }
  };

  const handleAddOverrideToAllPricingTiers = async () => {
    if (!overrideModalState || !editingProductId || editingOverride) {
      return;
    }

    if (!formData.productOwnerId) {
      setOverrideActionError('Select a product owner before managing overrides.');
      return;
    }

    if (!overrideForm.overrideACHId) {
      setOverrideActionError('Select an override account.');
      return;
    }

    const amount = parseFloat(overrideForm.overrideAmount);
    if (!amount || amount <= 0) {
      setOverrideActionError('Enter a valid override amount greater than 0.');
      return;
    }

    const targets = bulkOverrideBandTargets;
    if (targets.length === 0) {
      setOverrideActionError('Save pricing age bands before adding overrides to all tiers.');
      return;
    }

    setOverrideSaving(true);
    setOverrideActionError(null);
    setOverrideSuccessMessage(null);

    try {
      const res = await ProductOverridesService.getProductOverrides(editingProductId);
      const allOverrides = res.success && res.data ? res.data : [];
      const achId = overrideForm.overrideACHId;

      const validation = validateOverrideFitsAllPricingBands(
        targets,
        allOverrides,
        amount,
        overrideForm.isActive,
        achId
      );
      if (validation.ok === false) {
        if (validation.culprits.length === 0 && validation.skippedUnsaved > 0) {
          setOverrideActionError(
            `No saved age bands yet. Save ${validation.skippedUnsaved} unsaved band(s) before using add to all tiers.`
          );
        } else if (validation.culprits.length > 0) {
          setOverrideActionError(
            `Cannot add to all pricing tiers — override pool would be exceeded on: ${validation.culprits.join('; ')}`
          );
        } else {
          setOverrideActionError(validation.culprits[0] || 'Cannot add override to all pricing tiers.');
        }
        return;
      }

      const effectiveDate =
        overrideForm.effectiveDate ||
        (overrideModalState.bandEffectiveDate ? toDateInputValue(overrideModalState.bandEffectiveDate) : '');

      const tiersWithExisting = targets
        .map((target) => ({
          target,
          existing: findOverrideForAchOnPricingBand(allOverrides, target.productPricingId, achId)
        }))
        .filter((row) => row.existing);

      if (tiersWithExisting.length > 0) {
        setBulkOverwritePrompt({
          tierLabels: tiersWithExisting.map((row) => row.target.label)
        });
        return;
      }

      await applyBulkOverridesToAllTiers(allOverrides, amount, effectiveDate);
    } catch (error: any) {
      const message = error?.response?.data?.message || error?.message || 'Failed to add overrides to all pricing tiers.';
      setOverrideActionError(message);
    } finally {
      setOverrideSaving(false);
    }
  };

  const handleOverrideToggleActive = async (override: ProductOverride, makeActive: boolean) => {
    if (!overrideModalState || !editingProductId) return;
    if (!formData.productOwnerId) {
      setOverrideActionError('Select a product owner before managing overrides.');
      return;
    }

    const currentActiveTotal = overrideModalData.overrides
      .filter(o => o.IsActive && o.OverrideId !== override.OverrideId)
      .reduce((sum, o) => sum + (Number(o.OverrideAmount) || 0), 0);

    const projectedTotal = makeActive ? currentActiveTotal + (Number(override.OverrideAmount) || 0) : currentActiveTotal;
    if (projectedTotal > overrideModalState.overrideRate) {
      setOverrideActionError(`Cannot activate this override because the total would exceed ${formatCurrency(overrideModalState.overrideRate)}.`);
      return;
    }

    setOverrideSaving(true);
    setOverrideActionError(null);

    try {
      const response = await ProductOverridesService.updateOverride(editingProductId, override.OverrideId, {
        tenantId: formData.productOwnerId,
        overrideACHId: override.OverrideACHId,
        overrideName: override.OverrideName || undefined,
        overrideAmount: Number(override.OverrideAmount) || 0,
        priority: override.Priority ?? undefined,
        isActive: makeActive,
        effectiveDate: override.EffectiveDate ? toDateInputValue(override.EffectiveDate) : undefined,
        expirationDate: override.ExpirationDate ? toDateInputValue(override.ExpirationDate) : undefined,
        productPricingId: overrideModalState.productPricingId
      });

      if (!response.success) {
        setOverrideActionError(response.message || 'Failed to update override status.');
      } else {
        await loadOverrideData(overrideModalState.tierId, overrideModalState.bandId, overrideModalState.productPricingId);
      }
    } catch (error: any) {
      const message = error?.response?.data?.message || error?.message || 'Failed to update override status.';
      setOverrideActionError(message);
    } finally {
      setOverrideSaving(false);
    }
  };

  const handleOverrideDelete = async (override: ProductOverride) => {
    if (!overrideModalState || !editingProductId) return;

    const confirmed = window.confirm('Are you sure you want to permanently delete this override?');
    if (!confirmed) return;

    setOverrideSaving(true);
    setOverrideActionError(null);

    try {
      const response = await ProductOverridesService.deleteOverride(editingProductId, override.OverrideId);
      if (!response.success) {
        setOverrideActionError(response.message || 'Failed to delete override.');
      } else {
        await loadOverrideData(overrideModalState.tierId, overrideModalState.bandId, overrideModalState.productPricingId);
        if (showViewAllOverridesModal) {
          setViewAllOverrides(prev => prev.filter(o => o.OverrideId !== override.OverrideId));
        }
      }
    } catch (error: any) {
      const message = error?.response?.data?.message || error?.message || 'Failed to delete override.';
      setOverrideActionError(message);
    } finally {
      setOverrideSaving(false);
    }
  };

  const openViewAllOverridesModal = async () => {
    if (!editingProductId) return;
    setViewAllOverridesLoading(true);
    setViewAllFilterACHId('');
    setViewAllFilterPricingId('');
    try {
      const [res, achResponse] = await Promise.all([
        ProductOverridesService.getProductOverrides(editingProductId),
        ProductOverridesService.getOverrideACHAccounts(tenantIdForOverrides)
      ]);
      const list = (res.success && res.data ? res.data : []).map(o => ({ ...o, OverrideAmount: Number(o.OverrideAmount ?? 0) }));
      setViewAllOverrides(list);
      setViewAllAchAccounts(achResponse.success && achResponse.data ? achResponse.data : []);
      setShowViewAllOverridesModal(true);
    } catch {
      setViewAllOverrides([]);
      setViewAllAchAccounts([]);
      setShowViewAllOverridesModal(true);
    } finally {
      setViewAllOverridesLoading(false);
    }
  };

  const handleViewAllOverrideDelete = async (override: ProductOverride) => {
    if (!editingProductId) return;
    const confirmed = window.confirm('Are you sure you want to permanently delete this override?');
    if (!confirmed) return;
    setOverrideSaving(true);
    try {
      const response = await ProductOverridesService.deleteOverride(editingProductId, override.OverrideId);
      if (response.success) {
        setViewAllOverrides(prev => prev.filter(o => o.OverrideId !== override.OverrideId));
        if (overrideModalState && normalizePricingId(override.ProductPricingId) === normalizePricingId(overrideModalState.productPricingId)) {
          await loadOverrideData(overrideModalState.tierId, overrideModalState.bandId, overrideModalState.productPricingId);
        }
      }
    } finally {
      setOverrideSaving(false);
    }
  };

  // Prevent mouse wheel from changing number input values
  const handleWheel = (e: React.WheelEvent<HTMLInputElement>) => {
    e.currentTarget.blur();
  };

  // Auto-select first visible tier when tiers are added/filtered or selected tier is removed
  useEffect(() => {
    if (filteredAndSortedTiers.length > 0) {
      if (!selectedTierId || !filteredAndSortedTiers.find(t => t.id === selectedTierId)) {
        setSelectedTierId(filteredAndSortedTiers[0].id);
      }
    } else {
      setSelectedTierId(null);
    }
  }, [filteredAndSortedTiers, selectedTierId]);

  useEffect(() => {
    if (
      overrideModalState &&
      overrideModalData.achAccounts.length > 0 &&
      !overrideForm.overrideACHId &&
      !editingOverride
    ) {
      setOverrideForm(prev => ({
        ...prev,
        overrideACHId: overrideModalData.achAccounts[0].OverrideACHId
      }));
    }
  }, [overrideModalState, overrideModalData.achAccounts, overrideForm.overrideACHId, editingOverride]);

  const validateAgeBandsForTier = useCallback((tierId: string, tiers: PricingTier[]): string[] => {
    const tier = tiers.find(t => t.id === tierId);
    if (!tier) return [];

    const errors: string[] = [];

    const parseDate = (value?: string | null): number | null => {
      if (!value) return null;
      const date = new Date(value);
      return isNaN(date.getTime()) ? null : date.getTime();
    };

    const hasConfigurationFields = (formData.configurationFields?.length || 0) > 0;

    const configKeyForBand = (band: AgeBand) => {
      if (!hasConfigurationFields) return '';
      return [1, 2, 3, 4, 5]
        .map((index) => String(band[`configValue${index}` as keyof AgeBand] || ''))
        .join('|');
    };

    const formatBandLabel = (band: AgeBand, tobaccoStatus: string) => {
      const configSuffix = configKeyForBand(band);
      const configLabel = configSuffix ? ` · ${configSuffix.replace(/\|/g, '/')}` : '';
      return `${band.minAge}-${band.maxAge} (${tobaccoStatus})${configLabel}`;
    };

    const normalizeDateValue = (value?: string | null) => {
      if (!value) return 'none';
      return value.split('T')[0] || 'none';
    };

    const getBandPairKey = (band: AgeBand) => {
      const effective = normalizeDateValue(band.effectiveDate);
      const termination = normalizeDateValue(band.terminationDate);
      return `${band.minAge}-${band.maxAge}-${effective}-${termination}-${configKeyForBand(band)}`;
    };

    const formatBandDateRange = (band: AgeBand) => {
      const start = band.effectiveDate || 'No Effective Date';
      const end = band.terminationDate || 'No Termination Date';
      return `${start} → ${end}`;
    };

    const buildBandCountMap = (bands: AgeBand[]) => {
      const map = new Map<string, number>();
      bands.forEach(band => {
        const key = getBandPairKey(band);
        map.set(key, (map.get(key) ?? 0) + 1);
      });
      return map;
    };

    const ensureMatchingPairs = (
      sourceBands: AgeBand[],
      targetCounts: Map<string, number>,
      sourceLabel: string,
      targetLabel: string
    ) => {
      const countsCopy = new Map(targetCounts);
      sourceBands.forEach(band => {
        const key = getBandPairKey(band);
        const available = countsCopy.get(key) ?? 0;
        if (available === 0) {
          errors.push(
            `Tobacco ${sourceLabel} band ${band.minAge}-${band.maxAge} (${formatBandDateRange(band)}) must have a matching ${targetLabel} band with the same Min/Max Age and Effective/Termination dates.`
          );
        } else {
          countsCopy.set(key, available - 1);
        }
      });
    };

    const dateRangesOverlap = (bandA: AgeBand, bandB: AgeBand) => {
      const aStart = parseDate(bandA.effectiveDate) ?? Number.NEGATIVE_INFINITY;
      const aEnd = parseDate(bandA.terminationDate) ?? Number.POSITIVE_INFINITY;
      const bStart = parseDate(bandB.effectiveDate) ?? Number.NEGATIVE_INFINITY;
      const bEnd = parseDate(bandB.terminationDate) ?? Number.POSITIVE_INFINITY;
      return aEnd > bStart && bEnd > aStart;
    };
    
    // Group bands by tobacco status (and config values when product has configuration fields)
    const bandsByTobacco: { [key: string]: AgeBand[] } = {};
    tier.ageBands.forEach(band => {
      const groupKey = hasConfigurationFields
        ? `${band.tobaccoStatus}::${configKeyForBand(band)}`
        : band.tobaccoStatus;
      if (!bandsByTobacco[groupKey]) {
        bandsByTobacco[groupKey] = [];
      }
      bandsByTobacco[groupKey].push(band);
    });

    const tobaccoGroupLabel = (groupKey: string) => groupKey.split('::')[0];

    // Tobacco validation rules
    const hasNA = Object.keys(bandsByTobacco).some((key) => tobaccoGroupLabel(key) === 'N/A');
    const hasYes = Object.keys(bandsByTobacco).some((key) => tobaccoGroupLabel(key) === 'Yes');
    const hasNo = Object.keys(bandsByTobacco).some((key) => tobaccoGroupLabel(key) === 'No');

    // Rule 1: If tier has Yes, it requires No (and vice versa)
    if (hasYes && !hasNo) {
      errors.push('Tobacco status Yes requires a corresponding No status. Please add a No tobacco age band.');
    }
    if (hasNo && !hasYes) {
      errors.push('Tobacco status No requires a corresponding Yes status. Please add a Yes tobacco age band.');
    }

    if (hasNA && (hasYes || hasNo)) {
      const naBands = Object.entries(bandsByTobacco)
        .filter(([key]) => tobaccoGroupLabel(key) === 'N/A')
        .flatMap(([, bands]) => bands);
      const yesNoBands = Object.entries(bandsByTobacco)
        .filter(([key]) => {
          const label = tobaccoGroupLabel(key);
          return label === 'Yes' || label === 'No';
        })
        .flatMap(([, bands]) => bands);

      naBands.forEach(naBand => {
        yesNoBands.forEach(otherBand => {
          if (dateRangesOverlap(naBand, otherBand)) {
            errors.push(
              `Tobacco N/A band ${formatBandLabel(naBand, 'N/A')} (${formatBandDateRange(naBand)}) overlaps with ${formatBandLabel(otherBand, otherBand.tobaccoStatus)} (${formatBandDateRange(otherBand)}). Adjust Effective/Termination dates so N/A bands do not overlap with Yes/No bands.`
            );
          }
        });
      });
    }

    if (hasYes && hasNo) {
      const yesBands = Object.entries(bandsByTobacco)
        .filter(([key]) => tobaccoGroupLabel(key) === 'Yes')
        .flatMap(([, bands]) => bands);
      const noBands = Object.entries(bandsByTobacco)
        .filter(([key]) => tobaccoGroupLabel(key) === 'No')
        .flatMap(([, bands]) => bands);
      const yesCounts = buildBandCountMap(yesBands);
      const noCounts = buildBandCountMap(noBands);

      ensureMatchingPairs(yesBands, noCounts, 'Yes', 'No');
      ensureMatchingPairs(noBands, yesCounts, 'No', 'Yes');
    }

    // Check each tobacco/config group separately for age band validation
    Object.entries(bandsByTobacco).forEach(([groupKey, bands]) => {
      const tobaccoStatus = tobaccoGroupLabel(groupKey);
      const sortedBands = [...bands].sort((a, b) => a.minAge - b.minAge);
      const dateSortedBands = [...bands].sort((a, b) => {
        const aDate = parseDate(a.effectiveDate) ?? Number.NEGATIVE_INFINITY;
        const bDate = parseDate(b.effectiveDate) ?? Number.NEGATIVE_INFINITY;
        return aDate - bDate;
      });

      for (let i = 0; i < sortedBands.length; i++) {
        const currentBand = sortedBands[i];
        
        if (currentBand.minAge >= currentBand.maxAge) {
          errors.push(`Age band ${currentBand.minAge}-${currentBand.maxAge} (${tobaccoStatus}): Min age must be less than max age`);
        }
        
        if (i < sortedBands.length - 1) {
          const nextBand = sortedBands[i + 1];
          if (currentBand.maxAge >= nextBand.minAge) {
            const currentStart = parseDate(currentBand.effectiveDate) ?? Number.NEGATIVE_INFINITY;
            const currentEnd = parseDate(currentBand.terminationDate) ?? Number.POSITIVE_INFINITY;
            const nextStart = parseDate(nextBand.effectiveDate) ?? Number.NEGATIVE_INFINITY;
            const nextEnd = parseDate(nextBand.terminationDate) ?? Number.POSITIVE_INFINITY;

            const datesOverlap = currentEnd > nextStart && nextEnd > currentStart;

            if (datesOverlap) {
              errors.push(`Age bands overlap for ${tobaccoStatus}: ${currentBand.minAge}-${currentBand.maxAge} overlaps with ${nextBand.minAge}-${nextBand.maxAge}`);
            }
          }
        }
      }

      dateSortedBands.forEach((band) => {
        const bandLabel = formatBandLabel(band, tobaccoStatus);
        const start = parseDate(band.effectiveDate);
        const end = parseDate(band.terminationDate);

        if (start === null) {
          errors.push(`Effective Date is required for ${bandLabel}`);
        }

        if (start !== null && end !== null && end <= start) {
          errors.push(`Termination Date must be after the Effective Date for ${bandLabel}`);
        }
      });

      for (let i = 0; i < dateSortedBands.length - 1; i++) {
        const currentBand = dateSortedBands[i];
        const nextBand = dateSortedBands[i + 1];

        const agesOverlap = currentBand.maxAge >= nextBand.minAge && nextBand.maxAge >= currentBand.minAge;

        if (!agesOverlap) {
          continue;
        }

        const currentStart = parseDate(currentBand.effectiveDate) ?? Number.NEGATIVE_INFINITY;
        const currentEnd = parseDate(currentBand.terminationDate) ?? Number.POSITIVE_INFINITY;
        const nextStart = parseDate(nextBand.effectiveDate) ?? Number.NEGATIVE_INFINITY;
        const nextEnd = parseDate(nextBand.terminationDate) ?? Number.POSITIVE_INFINITY;

        const datesOverlap = currentEnd > nextStart && nextEnd > currentStart;

        if (datesOverlap) {
          errors.push(
            `Effective/Termination dates overlap for ${tobaccoStatus}: ${formatBandLabel(currentBand, tobaccoStatus)} conflicts with ${formatBandLabel(nextBand, tobaccoStatus)}`
          );
        }
      }
    });

    return errors;
  }, [formData.configurationFields]);

  // Recalculate msrpRate for all bands when pricing tiers are loaded
  // This ensures rates are correct even if they weren't calculated during mapping
  useEffect(() => {
    // Only run if we have pricing tiers
    if (formData.pricingTiers.length === 0 || manualFeeEntry) return;
    
    // Check if any band needs recalculation
    const needsRecalculation = formData.pricingTiers.some(tier =>
      tier.ageBands.some(band => {
        const componentBase = calculateMSRPRate(
          band.netRate || 0,
          band.overrideRate || 0,
          band.commission || 0,
          band.systemFees || 0
        );
        const included = computeBandIncludedFee(componentBase);
        const expectedMsrpRate = formData.includeProcessingFee
          ? Math.round((componentBase + included) * 100) / 100
          : componentBase;
        return Math.abs((band.msrpRate || 0) - expectedMsrpRate) > 0.01;
      })
    );
    
    if (needsRecalculation) {
      console.log('💰 Recalculating msrpRate for all bands');
      const updatedTiers = formData.pricingTiers.map(tier => ({
        ...tier,
        ageBands: tier.ageBands.map(band => {
          const componentBase = calculateMSRPRate(
            band.netRate || 0,
            band.overrideRate || 0,
            band.commission || 0,
            band.systemFees || 0
          );
          const includedProcessingFee = computeBandIncludedFee(componentBase);
          const msrpRate = formData.includeProcessingFee
            ? Math.round((componentBase + includedProcessingFee) * 100) / 100
            : componentBase;
          return {
            ...band,
            msrpRate,
            includedProcessingFee,
            affiliateRate: calculateAffiliateRate(band.netRate || 0, band.overrideRate || 0)
          };
        })
      }));
      updateFormData({ pricingTiers: updatedTiers });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.pricingTiers.length]); // Run when number of tiers changes (initial load or tier added/removed)

  // Validate age bands when they change
  useEffect(() => {
    const newErrors: {[tierId: string]: string[]} = {};
    formData.pricingTiers.forEach(tier => {
      const errors = validateAgeBandsForTier(tier.id, formData.pricingTiers);
      if (errors.length > 0) {
        newErrors[tier.id] = errors;
      }
    });
    setAgeBandErrors(newErrors);
    
    // Notify parent component about validation status
    const hasErrors = Object.keys(newErrors).length > 0;
    if (onValidationChange) {
      onValidationChange(hasErrors);
    }
  }, [formData.pricingTiers, validateAgeBandsForTier, onValidationChange]);

  const calculateMSRPRate = (netRate: number, overrideRate: number, commission: number, systemFees: number): number => {
    // systemFees are tenant-level, not product-level, but kept in function signature for backward compatibility
    return netRate + overrideRate + commission;
  };

  const calculateAffiliateRate = (netRate: number, overrideRate: number): number => {
    return netRate + overrideRate;
  };

  const addPricingTier = () => {
    const newTier: PricingTier = {
      id: Date.now().toString(),
      tierType: '',
      label: '',
      ageBands: [{
        id: Date.now().toString(),
        tobaccoStatus: 'N/A',
        minAge: formData.minAge,
        maxAge: formData.maxAge,
        netRate: 0,
        overrideRate: 0,
        commission: 0,
        systemFees: 0,
        msrpRate: 0,
        affiliateRate: 0,
        locked: false,
        effectiveDate: new Date().toISOString().split('T')[0],
        terminationDate: null,
        configValue1: '',
        configValue2: '',
        configValue3: '',
        configValue4: '',
        configValue5: '',
        productPricingId: null,
        overrides: []
      }]
    };
    updateFormData({ 
      pricingTiers: [...formData.pricingTiers, newTier] 
    });
  };

  const updatePricingTier = (tierId: string, updates: Partial<PricingTier>) => {
    updateFormData({
      pricingTiers: formData.pricingTiers.map(tier =>
        tier.id === tierId ? { ...tier, ...updates } : tier
      )
    });
  };

  const addAgeBand = (tierId: string) => {
    const tier = formData.pricingTiers.find(t => t.id === tierId);
    if (!tier) return;

    // Determine default tobacco status based on existing bands
    let defaultTobaccoStatus = 'N/A';
    const hasNA = tier.ageBands.some(b => b.tobaccoStatus === 'N/A');
    const hasYes = tier.ageBands.some(b => b.tobaccoStatus === 'Yes');
    const hasNo = tier.ageBands.some(b => b.tobaccoStatus === 'No');
    
    // If tier already has Yes or No, default to the missing one
    if (hasYes && !hasNo) {
      defaultTobaccoStatus = 'No';
    } else if (hasNo && !hasYes) {
      defaultTobaccoStatus = 'Yes';
    } else if (!hasNA && (hasYes || hasNo)) {
      // If tier has Yes/No but not N/A, default to N/A (but validation will catch if needed)
      defaultTobaccoStatus = 'N/A';
    }

    const newAgeBand: AgeBand = {
      id: Date.now().toString(),
      tobaccoStatus: defaultTobaccoStatus,
      minAge: formData.minAge,
      maxAge: formData.maxAge,
      netRate: 0,
      overrideRate: 0,
      commission: 0,
      systemFees: 0,
      msrpRate: 0,
      affiliateRate: 0,
      locked: false,
      effectiveDate: new Date().toISOString().split('T')[0],
      terminationDate: null,
      configValue1: '',
      configValue2: '',
      configValue3: '',
      configValue4: '',
      configValue5: '',
      productPricingId: null,
      overrides: []
    };
    
    updatePricingTier(tierId, {
      ageBands: [...tier.ageBands, newAgeBand]
    });
  };

  const duplicateAgeBand = (tierId: string, bandId: string) => {
    const tier = formData.pricingTiers.find(t => t.id === tierId);
    if (!tier) return;

    const originalIndex = tier.ageBands.findIndex(band => band.id === bandId);
    if (originalIndex === -1) return;

    const originalBand = tier.ageBands[originalIndex];
    const duplicatedBand: AgeBand = {
      ...originalBand,
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      locked: false,
      productPricingId: null,
      overrides: []
    };

    const updatedBands = [
      ...tier.ageBands.slice(0, originalIndex + 1),
      duplicatedBand,
      ...tier.ageBands.slice(originalIndex + 1)
    ];

    updatePricingTier(tierId, { ageBands: updatedBands });
  };

  const updateAgeBand = (tierId: string, bandId: string, updates: Partial<AgeBand>) => {
    console.log('🔧 Updating age band:', { tierId, bandId, updates });
    
    // SIMPLIFIED: Follow the exact pattern from Step3ConfigurationFields
    const updatedPricingTiers = formData.pricingTiers.map(tier => {
      if (tier.id === tierId) {
        const updatedBands = tier.ageBands.map(band => {
          if (band.id === bandId) {
            const updatedBand = { ...band, ...updates };
            console.log('📊 Updated band before recalc:', {
              id: updatedBand.id,
              netRate: updatedBand.netRate,
              overrideRate: updatedBand.overrideRate,
              commission: updatedBand.commission
            });

            // Recalculate rates when any rate field changes (auto fee mode only)
            if (
              !formData.manualIncludedProcessingFee &&
              (updates.netRate !== undefined ||
                updates.overrideRate !== undefined ||
                updates.commission !== undefined ||
                updates.systemFees !== undefined)
            ) {
              const componentBase = calculateMSRPRate(
                updatedBand.netRate,
                updatedBand.overrideRate,
                updatedBand.commission,
                updatedBand.systemFees
              );
              updatedBand.includedProcessingFee = computeBandIncludedFee(componentBase);
              updatedBand.msrpRate = formData.includeProcessingFee
                ? Math.round((componentBase + updatedBand.includedProcessingFee) * 100) / 100
                : componentBase;
              updatedBand.affiliateRate = calculateAffiliateRate(
                updatedBand.netRate,
                updatedBand.overrideRate
              );
              console.log('💰 Recalculated rates:', {
                msrpRate: updatedBand.msrpRate,
                affiliateRate: updatedBand.affiliateRate,
                commission: updatedBand.commission,
              });
            } else if (
              formData.manualIncludedProcessingFee &&
              (updates.includedProcessingFee !== undefined ||
                updates.netRate !== undefined ||
                updates.overrideRate !== undefined ||
                updates.commission !== undefined ||
                updates.systemFees !== undefined)
            ) {
              const componentBase = calculateMSRPRate(
                updatedBand.netRate,
                updatedBand.overrideRate,
                updatedBand.commission,
                updatedBand.systemFees
              );
              updatedBand.msrpRate = Math.round(
                (componentBase + Number(updatedBand.includedProcessingFee || 0)) * 100
              ) / 100;
              updatedBand.affiliateRate = calculateAffiliateRate(
                updatedBand.netRate,
                updatedBand.overrideRate
              );
            }

            // Auto-set configField values when configValue values are updated
            for (let i = 1; i <= 5; i++) {
              const configValueKey = `configValue${i}` as keyof typeof updates;
              const configFieldKey = `configField${i}` as keyof typeof updatedBand;
              
              if (updates[configValueKey] && formData.configurationFields[i - 1]) {
                (updatedBand as any)[configFieldKey] = formData.configurationFields[i - 1].fieldName;
                console.log(`🔧 DEBUG: Auto-set ${configFieldKey} = "${formData.configurationFields[i - 1].fieldName}" for ${configValueKey} = "${updates[configValueKey]}"`);
              }
            }

            return updatedBand;
          }
          return band;
        });
        
        return { ...tier, ageBands: updatedBands };
      }
      return tier;
    });

    // SIMPLIFIED: Call updateFormData directly like Step3ConfigurationFields does
    updateFormData({ pricingTiers: updatedPricingTiers });
  };

  const handleStartDateFilterChange = (value: string) => {
    if (value === '__phase_in_new_pricing__') {
      setPhaseInError(null);
      setPhaseInEndDate('');
      setShowPhaseInModal(true);
      return;
    }
    setSelectedStartDateFilter(value);
  };

  const handlePhaseInNewPricing = () => {
    if (!phaseInEndDate) {
      setPhaseInError('Please select an end date for current pricing.');
      return;
    }

    const nextPhaseStartDate = getNextDay(phaseInEndDate);
    const getLatestBandStartDate = (bands: AgeBand[]): string => {
      const sorted = bands
        .map((band) => (band.effectiveDate || '').trim())
        .filter(Boolean)
        .sort((a, b) => b.localeCompare(a));
      return sorted[0] || '';
    };

    const sourceBandsByTierId = new Map<string, AgeBand[]>();
    formData.pricingTiers.forEach((tier) => {
      const openEndedBands = tier.ageBands.filter((band) => !band.terminationDate);
      if (openEndedBands.length > 0) {
        sourceBandsByTierId.set(tier.id, openEndedBands);
        return;
      }

      const latestStartDate = getLatestBandStartDate(tier.ageBands);
      if (!latestStartDate) {
        return;
      }

      const latestBands = tier.ageBands.filter((band) => (band.effectiveDate || '').trim() === latestStartDate);
      if (latestBands.length > 0) {
        sourceBandsByTierId.set(tier.id, latestBands);
      }
    });

    if (sourceBandsByTierId.size === 0) {
      setPhaseInError('No pricing tiers were found to phase forward.');
      return;
    }

    const timestampSeed = Date.now();
    let idCounter = 0;
    const generateId = () => `${timestampSeed}-${idCounter++}-${Math.random().toString(36).slice(2)}`;

    const updatedExistingTiers = formData.pricingTiers.map((tier) => {
      const sourceBands = sourceBandsByTierId.get(tier.id) || [];
      if (sourceBands.length === 0) {
        return tier;
      }

      const sourceBandIds = new Set(sourceBands.map((band) => band.id));
      return {
        ...tier,
        ageBands: tier.ageBands.map((band) => {
          if (!sourceBandIds.has(band.id)) {
            return band;
          }
          return {
            ...band,
            terminationDate: phaseInEndDate
          };
        })
      };
    });

    const newPhaseTiers: PricingTier[] = formData.pricingTiers
      .filter((tier) => sourceBandsByTierId.has(tier.id))
      .map((tier) => {
      const sourceBands = sourceBandsByTierId.get(tier.id) || [];
      const clonedSourceBands = sourceBands.map((band) => ({
          ...band,
          id: generateId(),
          productPricingId: null,
          overrides: [],
          locked: false,
          effectiveDate: nextPhaseStartDate,
          terminationDate: null
        }));

      return {
        ...tier,
        id: generateId(),
        ageBands: clonedSourceBands
      };
    });

    updateFormData({
      pricingTiers: [...updatedExistingTiers, ...newPhaseTiers]
    });

    setSelectedStartDateFilter(nextPhaseStartDate);
    setSelectedTierId(newPhaseTiers[0]?.id || null);
    setShowPhaseInModal(false);
    setPhaseInError(null);
    setPhaseInEndDate('');
  };

  const removeAgeBand = (tierId: string, bandId: string) => {
  const toggleBandCollapse = (bandId: string) => {
    setCollapsedBands(prev => ({
      ...prev,
      [bandId]: !prev[bandId]
    }));
  };

    const tier = formData.pricingTiers.find(t => t.id === tierId);
    if (tier) {
      updatePricingTier(tierId, {
        ageBands: tier.ageBands.filter(b => b.id !== bandId)
      });
    }
  };

  const selectedTier = filteredAndSortedTiers.find(t => t.id === selectedTierId) || null;
  const selectedTierVisibleBands = selectedTier ? getFilteredBandsForTier(selectedTier) : [];

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xl font-bold text-oe-text">Pricing Configuration</h3>
      </div>

      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-3">
        <p className="text-sm font-medium text-gray-800">Included processing fee (product-level)</p>
        {!formData.productOwnerId && (
          <p className="text-xs text-amber-700">Select a product owner on Basic Details to preview fee rates.</p>
        )}
        {ownerPaymentSettingsLoading && (
          <p className="text-xs text-gray-500">Loading owner tenant payment settings…</p>
        )}
        {!ownerPaymentSettingsLoading && formData.productOwnerId && !chargeFeeToMemberEnabled && !manualFeeEntry && (
          <p className="text-xs text-gray-500">
            Owner tenant does not charge processing fees at member checkout. You can still bake included fees into catalog pricing below.
          </p>
        )}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={manualFeeEntry}
            disabled={ownerPaymentSettingsLoading || !formData.productOwnerId}
            onChange={(e) => {
              const checked = e.target.checked;
              if (checked) {
                updateFormData({
                  manualIncludedProcessingFee: true,
                  includeProcessingFee: true,
                  roundUpProcessingFee: false,
                  processingFeePercentage: null,
                });
              } else {
                updateFormData({ manualIncludedProcessingFee: false });
              }
            }}
            className="rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
          />
          <span className="text-sm text-gray-700">Manual entry (edit included fee $ per age band)</span>
        </label>
        {manualFeeEntry && (
          <p className="text-xs text-gray-600 pl-6">
            Auto fee % and round-up are disabled. Edit the included processing fee on each age band; retail (MSRP) = base rate + included fee.
          </p>
        )}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={formData.includeProcessingFee === true}
            disabled={includeProcessingFeeDisabled}
            onChange={(e) =>
              updateFormData({
                includeProcessingFee: e.target.checked,
                roundUpProcessingFee: e.target.checked ? formData.roundUpProcessingFee !== false : false,
                ...(e.target.checked ? {} : { manualIncludedProcessingFee: false }),
              })
            }
            className="rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
          />
          <span className={`text-sm ${includeProcessingFeeDisabled ? 'text-gray-400' : 'text-gray-700'}`}>
            Include payment processing fee in product pricing
          </span>
        </label>
        {formData.includeProcessingFee && !autoFeeControlsDisabled && (
          <div className="pl-6 flex flex-wrap items-center gap-2">
            <label className="text-xs font-medium text-gray-700 whitespace-nowrap">Processing fee %</label>
            <input
              type="number"
              min={0}
              step={0.01}
              value={
                effectiveProcessingFeePct != null && !Number.isNaN(effectiveProcessingFeePct)
                  ? effectiveProcessingFeePct
                  : ''
              }
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === '') {
                  updateFormData({ processingFeePercentage: null });
                  return;
                }
                const n = parseFloat(raw);
                if (!Number.isNaN(n)) {
                  updateFormData({ processingFeePercentage: n });
                }
              }}
              className="w-24 px-2 py-1 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
            />
            <span className="text-xs text-gray-600">
              + ${(highestFeeConfig?.flatFee ?? 0).toFixed(2)} flat per tier
              {highestFeeConfig
                ? ` (default from owner tenant ${highestFeeConfig.methodLabel}; ACH vs CC will not differ)`
                : ''}
            </span>
          </div>
        )}
        <label className="flex items-center gap-2 pl-0">
          <input
            type="checkbox"
            checked={formData.roundUpProcessingFee !== false}
            disabled={!formData.includeProcessingFee || autoFeeControlsDisabled}
            onChange={(e) => updateFormData({ roundUpProcessingFee: e.target.checked })}
            className="rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
          />
          <span
            className={`text-sm ${
              !formData.includeProcessingFee || autoFeeControlsDisabled ? 'text-gray-400' : 'text-gray-700'
            }`}
          >
            Round up fee (whole-dollar total)
          </span>
        </label>
      </div>

      {formData.pricingTiers.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-oe-text text-lg mb-2">No pricing tiers added yet</p>
          <p className="text-sm text-gray-500 mb-4">Click "Add Pricing Tier" to get started</p>
          <button
            onClick={addPricingTier}
            className="btn-primary flex items-center justify-center mx-auto"
          >
            Add Pricing Tier
          </button>
        </div>
      ) : (
        <div className="flex gap-6 h-full min-h-[520px] overflow-hidden pb-4">
          {/* Left Panel - Tier List */}
          <div className="w-80 flex-shrink-0 flex flex-col h-full overflow-hidden">
            <div className="flex justify-between items-center mb-3">
              <h4 className="font-semibold text-sm text-gray-700">Pricing Tiers</h4>
              <button
                onClick={addPricingTier}
                className="btn-primary text-sm"
              >
                Add Pricing Tier
              </button>
            </div>
            <div className="mb-3">
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Start Date Filter
              </label>
              <select
                value={selectedStartDateFilter}
                onChange={(e) => handleStartDateFilterChange(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              >
                <option value="all">All start dates</option>
                {uniqueStartDates.map((startDate) => (
                  <option key={startDate} value={startDate}>
                    {startDate}
                  </option>
                ))}
                <option value="__phase_in_new_pricing__">+ Phase In New Pricing</option>
              </select>
            </div>
            <div className="flex-1 overflow-y-auto pr-2 max-h-[60vh]">
              {filteredAndSortedTiers.length === 0 ? (
                <div className="text-xs text-gray-500 border border-dashed border-gray-300 rounded-lg p-3">
                  No pricing tiers match this start date filter.
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredAndSortedTiers.map((tier, index) => {
                  const hasErrors = ageBandErrors[tier.id]?.length > 0;
                  const isSelected = selectedTierId === tier.id;
                  
                  // Calculate total price range from all age bands
                  const tierVisibleBands = getFilteredBandsForTier(tier);
                  const prices = tierVisibleBands.map(band => band.msrpRate || 0).filter(p => p > 0);
                  const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
                  const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;
                  const avgPrice = prices.length > 0 ? prices.reduce((sum, p) => sum + p, 0) / prices.length : 0;
                  const hasPriceRange = minPrice !== maxPrice && prices.length > 1;
                  
                  return (
                    <div
                      key={tier.id}
                      onClick={() => setSelectedTierId(tier.id)}
                  className={`group p-3 rounded-lg border-2 cursor-pointer transition-all ${
                        isSelected 
                          ? 'border-oe-primary bg-blue-50' 
                          : 'border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm'
                      } ${hasErrors ? 'border-oe-error' : ''}`}
                    >
                      <div className="flex justify-between items-start">
                        <div className="flex-1">
                          <div className="font-medium text-sm text-oe-text">
                            {tier.label || `Tier ${index + 1}`}
                            {hasErrors && (
                              <AlertCircle className="w-4 h-4 text-oe-error inline-block ml-2" />
                            )}
                          </div>
                          <div className="text-xs text-gray-600 mt-1">
                            {tier.tierType || 'No type set'}
                          </div>
                          <div className="text-xs text-gray-500 mt-1">
                            Start: {getTierStartDate(tier) || 'None'}
                          </div>
                          <div className="text-xs text-gray-500 mt-1">
                            {tierVisibleBands.length} age band{tierVisibleBands.length !== 1 ? 's' : ''}
                          </div>
                          {/* Total Price Display */}
                          {prices.length > 0 && (
                            <div className="text-xs font-semibold text-oe-primary mt-2">
                              {hasPriceRange 
                                ? `${formatCurrency(minPrice)} - ${formatCurrency(maxPrice)}`
                                : formatCurrency(avgPrice)
                              }
                            </div>
                          )}
                        </div>
                        {/* Remove tier trash icon per new design */}
                      </div>
                    </div>
                  );
                })}
                </div>
              )}
            </div>
          </div>

          {/* Right Panel - Selected Tier Details */}
          <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden pt-0">
            <div className="flex justify-between items-center mb-1">
              <h4 className="font-semibold text-sm text-gray-700">Tier Configuration</h4>
              {selectedTier && (
                <button
                  onClick={() => addAgeBand(selectedTier.id)}
                  className="btn-secondary text-sm"
                >
                  Add Age Band
                </button>
              )}
            </div>
            <div className="flex-1 overflow-hidden">
              {selectedTier ? (
                <div className="space-y-6 flex-1 flex flex-col min-h-0" style={{ maxHeight: 'calc(90vh - 260px)' }}>
                  <div className="card flex flex-col flex-1 min-h-0">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                      <div>
                        <label className="form-label">
                          Tier Label
                        </label>
                        <input
                          type="text"
                          value={selectedTier.label || ''}
                          disabled={selectedTierVisibleBands.some(band => band.locked)}
                          onChange={(e) => updatePricingTier(selectedTier.id, { label: e.target.value })}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                          placeholder={`Tier ${formData.pricingTiers.findIndex(t => t.id === selectedTier.id) + 1}`}
                        />
                      </div>

                      <div>
                        <label className="form-label">
                          Tier Type <span className="text-oe-error">*</span>
                        </label>
                        <select
                          value={selectedTier.tierType}
                          disabled={selectedTierVisibleBands.some(band => band.locked)}
                          onChange={(e) => updatePricingTier(selectedTier.id, { tierType: e.target.value })}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                          required
                        >
                          <option value="">Select a tier type</option>
                          {PRICING_TIERS.map(pt => (
                            <option key={pt.value} value={pt.value}>{pt.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    {/* Age Bands */}
                    <div className="flex-1 flex flex-col overflow-hidden pr-1 min-h-0">
                      <div className="space-y-3 overflow-y-auto pr-2 flex-1 min-h-0 pb-24">
                        {ageBandErrors[selectedTier.id] && ageBandErrors[selectedTier.id].length > 0 && (
                          <div className="sticky top-0 z-10 flex justify-end">
                            <div className="relative group">
                              <button
                                type="button"
                                className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold text-red-600 border border-red-300 rounded-full bg-red-50"
                                aria-label="View age band validation errors"
                              >
                                <AlertCircle className="w-4 h-4" />
                                Validation Issues
                                <span className="text-[11px] font-normal text-red-500">(hover for details)</span>
                              </button>
                              <div className="absolute right-0 mt-2 w-80 bg-white border border-gray-200 rounded-lg shadow-xl p-3 text-xs text-gray-700 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-20">
                                <div className="font-semibold text-red-600 mb-2">Age Band Validation Errors</div>
                                <ul className="list-disc list-inside space-y-1 text-red-600">
                                  {ageBandErrors[selectedTier.id].map((error, index) => (
                                    <li key={index}>{error}</li>
                                  ))}
                                </ul>
                              </div>
                            </div>
                          </div>
                        )}

                        {selectedTierVisibleBands.map((band) => {
                          const isExistingBand = !!resolveBandProductPricingId(band);
                          const isLocked = Boolean(isExistingBand && band.locked);
                          const inputBaseClass =
                            'w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-oe-primary';
                          const disabledInputClass = isLocked ? ' bg-gray-100 text-gray-500 cursor-not-allowed' : '';
                          const overridesForBand = Array.isArray(band.overrides) ? band.overrides : [];
                          const activeOverrides = overridesForBand.filter(override => override.IsActive);
                          const activeOverridesTotal = activeOverrides.reduce((sum, override) => sum + (Number(override.OverrideAmount) || 0), 0);
                          const overrideButtonDisabled =
                            isLocked ||
                            !editingProductId ||
                            !isExistingBand ||
                            !formData.productOwnerId;
                          let overrideButtonTitle = 'Manage override distributions for this age band';
                          if (!editingProductId) {
                            overrideButtonTitle = 'Create the product before managing overrides.';
                          } else if (!isExistingBand) {
                            overrideButtonTitle = 'Save this age band before managing overrides.';
                          } else if (!formData.productOwnerId) {
                            overrideButtonTitle = 'Select a product owner before managing overrides.';
                          } else if (isLocked) {
                            overrideButtonTitle = 'Unlock the age band to modify overrides.';
                          }
 
                          return (
                            <div key={band.id} className="relative border border-gray-200 rounded-lg p-4 bg-oe-light bg-opacity-20">
                              <div className="grid grid-cols-5 gap-4 items-end">
                                <div>
                                  <label className="text-xs font-medium text-gray-700 flex items-center">
                                    Tobacco
                                    <div className="relative ml-1 group/tooltip">
                                      <Info className="h-3 w-3 text-oe-primary hover:text-oe-dark cursor-help" size={12} />
                                      <div className="absolute left-0 top-6 z-50 w-72 p-3 bg-oe-dark text-white text-xs rounded-lg shadow-lg opacity-0 invisible group-hover/tooltip:opacity-100 group-hover/tooltip:visible transition-all duration-200">
                                        <div className="font-semibold mb-2 text-oe-light">Validation Fields</div>
                                        <div className="mb-2">These fields define age-based pricing bands for different tobacco statuses.</div>
                                        <div className="space-y-1 text-gray-200">
                                          <div><span className="font-medium">Tobacco:</span> No/Yes tobacco status</div>
                                          <div><span className="font-medium">Min Age:</span> Minimum age for this band</div>
                                          <div><span className="font-medium">Max Age:</span> Maximum age for this band</div>
                                        </div>
                                        <div className="absolute -top-1 left-2 w-2 h-2 bg-oe-dark rotate-45"></div>
                                      </div>
                                    </div>
                                  </label>
                                  <select
                                    value={band.tobaccoStatus}
                                    onChange={(e) => updateAgeBand(selectedTier.id, band.id, { tobaccoStatus: e.target.value })}
                                    disabled={isLocked}
                                    className={`${inputBaseClass}${disabledInputClass}`}
                                  >
                                    {TOBACCO_OPTIONS.map(option => (
                                      <option key={option.value} value={option.value}>{option.value}</option>
                                    ))}
                                  </select>
                                </div>

                                <div>
                                  <label className="text-xs font-medium text-gray-700">Min Age</label>
                                  <input
                                    type="number"
                                    value={band.minAge}
                                    disabled={isLocked}
                                    onChange={(e) => updateAgeBand(selectedTier.id, band.id, { minAge: parseInt(e.target.value) || 0 })}
                                    onWheel={handleWheel}
                                    className={`${inputBaseClass}${disabledInputClass}`}
                                  />
                                </div>

                                <div>
                                  <label className="text-xs font-medium text-gray-700">Max Age</label>
                                  <input
                                    type="number"
                                    value={band.maxAge}
                                    disabled={isLocked}
                                    onChange={(e) => updateAgeBand(selectedTier.id, band.id, { maxAge: parseInt(e.target.value) || 0 })}
                                    onWheel={handleWheel}
                                    className={`${inputBaseClass}${disabledInputClass}`}
                                  />
                                </div>

                                <div>
                                  <label className="text-xs font-medium text-gray-700">Start Date</label>
                                  <input
                                    type="date"
                                    value={band.effectiveDate || ''}
                                    disabled={isLocked}
                                    onChange={(e) => updateAgeBand(selectedTier.id, band.id, { effectiveDate: e.target.value ? e.target.value : null })}
                                    className={`${inputBaseClass}${disabledInputClass}`}
                                  />
                                </div>

                                <div>
                                  <label className="text-xs font-medium text-gray-700">End Date</label>
                                  <input
                                    type="date"
                                    value={band.terminationDate || ''}
                                    disabled={isLocked}
                                    onChange={(e) => updateAgeBand(selectedTier.id, band.id, { terminationDate: e.target.value ? e.target.value : null })}
                                    className={`${inputBaseClass}${disabledInputClass}`}
                                  />
                                </div>
                              </div>

                              <div
                                className={`mt-4 grid grid-cols-2 md:grid-cols-3 gap-4 items-end ${
                                  formData.includeProcessingFee ? 'lg:grid-cols-6' : 'lg:grid-cols-4'
                                }`}
                              >
                                <div>
                                  <label className="text-xs font-medium text-gray-700 flex items-center">
                                    Vendor
                                    <div className="relative ml-1 group/tooltip">
                                      <Info className="h-3 w-3 text-oe-primary hover:text-oe-dark cursor-help" size={12} />
                                      <div className="absolute left-0 top-6 z-50 w-64 p-3 bg-oe-dark text-white text-xs rounded-lg shadow-lg opacity-0 invisible group-hover/tooltip:opacity-100 group-hover/tooltip:visible transition-all duration-200">
                                        <div className="font-semibold mb-2 text-oe-light">Vendor Rate</div>
                                        <div className="text-gray-200">This amount is 100% paid directly to the vendor.</div>
                                        <div className="absolute -top-1 left-2 w-2 h-2 bg-oe-dark rotate-45"></div>
                                      </div>
                                    </div>
                                  </label>
                                  <input
                                    type="number"
                                    step="0.01"
                                    value={band.netRate === 0 ? '' : band.netRate}
                                    disabled={isLocked}
                                    onChange={(e) => {
                                      const value = e.target.value === '' ? 0 : parseFloat(e.target.value) || 0;
                                      updateAgeBand(selectedTier.id, band.id, { netRate: value });
                                    }}
                                    onBlur={(e) => {
                                      if (e.target.value === '') {
                                        updateAgeBand(selectedTier.id, band.id, { netRate: 0 });
                                      }
                                    }}
                                    onWheel={(e) => e.currentTarget.blur()}
                                    className={`${inputBaseClass}${disabledInputClass}`}
                                  />
                                </div>

                                <div>
                                  <label className="text-xs font-medium text-gray-700 flex items-center">
                                    Override
                                    <div className="relative ml-1 group/tooltip">
                                      <Info className="h-3 w-3 text-oe-primary hover:text-oe-dark cursor-help" size={12} />
                                      <div className="absolute left-0 top-6 z-50 w-72 p-3 bg-oe-dark text-white text-xs rounded-lg opacity-0 invisible group-hover/tooltip:opacity-100 group-hover/tooltip:visible transition-all duration-200">
                                        <div className="font-semibold mb-2 text-oe-light">Override Rate</div>
                                        <div className="text-gray-200 mb-2">This amount is 100% paid to the Product Owner.</div>
                                        <div className="space-y-1 text-gray-300 text-xs">
                                          <div><span className="font-medium">SysAdmin:</span> If no 'Product Owner' set Override to $0.00 and set Tenant to 'Master Tenant'</div>
                                          <div><span className="font-medium">TenantAdmin:</span> Product Owner is set to your tenant id</div>
                                        </div>
                                        <div className="absolute -top-1 left-2 w-2 h-2 bg-oe-dark rotate-45"></div>
                                      </div>
                                    </div>
                                  </label>
                                  <input
                                    type="number"
                                    step="0.01"
                                    value={band.overrideRate === 0 ? '' : band.overrideRate}
                                    disabled={isLocked}
                                    onChange={(e) => {
                                      const value = e.target.value === '' ? 0 : parseFloat(e.target.value) || 0;
                                      updateAgeBand(selectedTier.id, band.id, { overrideRate: value });
                                    }}
                                    onBlur={(e) => {
                                      if (e.target.value === '') {
                                        updateAgeBand(selectedTier.id, band.id, { overrideRate: 0 });
                                      }
                                    }}
                                    onWheel={(e) => e.currentTarget.blur()}
                                    className={`${inputBaseClass}${disabledInputClass}`}
                                  />
                                </div>

                                <div>
                                  <label className="text-xs font-medium text-gray-700 flex items-center">
                                    Commission
                                    <div className="relative ml-1 group/tooltip">
                                      <Info className="h-3 w-3 text-oe-primary hover:text-oe-dark cursor-help" size={12} />
                                      <div className="absolute left-0 top-6 z-50 w-80 p-3 bg-oe-dark text-white text-xs rounded-lg shadow-lg opacity-0 invisible group-hover/tooltip:opacity-100 group-hover/tooltip:visible transition-all duration-200">
                                        <div className="font-semibold mb-2 text-oe-light">Commission</div>
                                        <div className="text-gray-200">
                                          Commission amount distributed to the Tenant and processed through commission rules.
                                        </div>
                                        <div className="absolute -top-1 left-2 w-2 h-2 bg-oe-dark rotate-45"></div>
                                      </div>
                                    </div>
                                  </label>
                                  <input
                                    type="number"
                                    step="0.01"
                                    value={band.commission === 0 ? '' : band.commission}
                                    disabled={isLocked}
                                    onChange={(e) => {
                                      const value = e.target.value === '' ? 0 : parseFloat(e.target.value) || 0;
                                      updateAgeBand(selectedTier.id, band.id, { commission: value });
                                    }}
                                    onBlur={(e) => {
                                      if (e.target.value === '') {
                                        updateAgeBand(selectedTier.id, band.id, { commission: 0 });
                                      }
                                    }}
                                    onWheel={(e) => e.currentTarget.blur()}
                                    className={`${inputBaseClass}${disabledInputClass}`}
                                  />
                                </div>

                                <div>
                                  <label className="text-xs font-medium text-gray-700">Base rate</label>
                                  <input
                                    type="number"
                                    value={Number(
                                      calculatePricingComponentBase(
                                        band.netRate || 0,
                                        band.overrideRate || 0,
                                        band.commission || 0
                                      )
                                    ).toFixed(2)}
                                    disabled
                                    className="w-full px-2 py-1 text-sm bg-gray-100 text-gray-600 border border-gray-300 rounded"
                                  />
                                </div>

                                {formData.includeProcessingFee && (
                                  <>
                                    <div>
                                      <label className="text-xs font-medium text-gray-700">Included processing fee</label>
                                      <input
                                        type="number"
                                        step={0.01}
                                        min={0}
                                        value={Number(band.includedProcessingFee || 0).toFixed(2)}
                                        disabled={!manualFeeEntry || isLocked}
                                        onChange={(e) => {
                                          const value =
                                            e.target.value === '' ? 0 : parseFloat(e.target.value) || 0;
                                          updateAgeBand(selectedTier.id, band.id, {
                                            includedProcessingFee: value,
                                          });
                                        }}
                                        onWheel={(e) => e.currentTarget.blur()}
                                        className={`w-full px-2 py-1 text-sm border border-gray-300 rounded ${
                                          manualFeeEntry && !isLocked
                                            ? 'focus:outline-none focus:ring-2 focus:ring-oe-primary'
                                            : 'bg-gray-100 text-gray-600'
                                        }`}
                                      />
                                    </div>

                                    <div>
                                      <label className="text-xs font-medium text-gray-700">Retail rate (MSRP)</label>
                                      <input
                                        type="number"
                                        value={Number(band.msrpRate || 0).toFixed(2)}
                                        disabled
                                        className="w-full px-2 py-1 text-sm bg-gray-100 text-gray-600 border border-gray-300 rounded"
                                      />
                                    </div>
                                  </>
                                )}

                                {!formData.includeProcessingFee && (
                                <div>
                                  <label className="text-xs font-medium text-gray-700">MSRP</label>
                                  <input
                                    type="number"
                                    value={Number(band.msrpRate || 0).toFixed(2)}
                                    disabled
                                    className="w-full px-2 py-1 text-sm bg-gray-100 text-gray-600 border border-gray-300 rounded"
                                  />
                                </div>
                                )}
                              </div>

                              {formData.configurationFields.length > 0 && (
                                <div className="mt-3 pt-3 border-t">
                                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                    {formData.configurationFields.slice(0, 5).map((configField, index) => (
                                      <div key={configField.id}>
                                        <label className="text-xs font-medium text-gray-700">
                                          {configField.fieldName || `Config Field ${index + 1}`}
                                        </label>
                                        <select
                                          value={band[`configValue${index + 1}` as keyof AgeBand] as string || ''}
                                          onChange={(e) => updateAgeBand(selectedTier.id, band.id, { [`configValue${index + 1}`]: e.target.value })}
                                          disabled={isLocked}
                                          className={`${inputBaseClass} text-xs${disabledInputClass}`}
                                        >
                                          <option value="">Select Value</option>
                                          {configField.fieldOptions.filter(opt => opt.trim()).map((option, optIndex) => (
                                            <option key={optIndex} value={option}>
                                              {option}
                                            </option>
                                          ))}
                                        </select>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}

                              <div className="flex items-center justify-end gap-3 mt-3">
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => openOverrideModal(selectedTier, band)}
                                    disabled={overrideButtonDisabled}
                                    className={`inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
                                      overrideButtonDisabled
                                        ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'
                                        : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50 hover:border-gray-400'
                                    }`}
                                    title={overrideButtonTitle}
                                  >
                                    <Wallet className="h-3 w-3" />
                                    Overrides{activeOverrides.length ? ` (${activeOverrides.length})` : ''}
                                  </button>
                                  {isExistingBand && (
                                    <span className="text-xs text-gray-500">
                                      Active: {formatCurrency(activeOverridesTotal)} / {formatCurrency(band.overrideRate || 0)}
                                    </span>
                                  )}
                                </div>
                                <button
                                  type="button"
                                  disabled={isLocked}
                                  onClick={() => updateAgeBand(selectedTier.id, band.id, { locked: !band.locked })}
                                  className={`inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${
                                    band.locked
                                      ? 'bg-oe-primary text-white hover:bg-oe-dark'
                                      : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                                  } ${isExistingBand && band.locked ? 'cursor-not-allowed opacity-70' : ''}`}
                                  title={band.locked ? 'Unlock age band' : 'Lock age band'}
                                >
                                  {band.locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
                                  {band.locked ? 'Locked' : 'Unlocked'}
                                </button>

                                <button
                                  type="button"
                                  onClick={() => duplicateAgeBand(selectedTier.id, band.id)}
                                  className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-full border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors"
                                  title="Duplicate age band"
                                >
                                  <Copy className="h-3 w-3" />
                                  Copy
                                </button>

                                {!isLocked && (
                                  <button
                                    type="button"
                                    onClick={() => removeAgeBand(selectedTier.id, band.id)}
                                    className="btn-danger px-2 py-1 text-sm"
                                    title="Delete age band"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-center h-full">
                  <p className="text-gray-500">Select a pricing tier to view details</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {overrideModalState && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black bg-opacity-50 p-4">
          <div className="bg-white rounded-lg w-full max-w-4xl max-h-[90vh] overflow-hidden shadow-2xl">
            <div className="flex items-start justify-between p-6 border-b border-gray-200 bg-white">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Manage Overrides</h3>
                <p className="text-sm text-gray-600">{overrideModalState.tierLabel} • {overrideModalState.bandLabel}</p>
                <div className="text-xs text-gray-500 mt-2 space-x-2">
                  <span>Override Pool: {formatCurrency(overrideModalState.overrideRate)}</span>
                  <span>Active Total: {formatCurrency(overrideModalData.overrides.filter(o => o.IsActive).reduce((sum, o) => sum + (Number(o.OverrideAmount) || 0), 0))}</span>
                  <span>
                    Remaining: {formatCurrency(Math.max(overrideModalState.overrideRate - overrideModalData.overrides.filter(o => o.IsActive).reduce((sum, o) => sum + (Number(o.OverrideAmount) || 0), 0), 0))}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={openViewAllOverridesModal}
                  disabled={viewAllOverridesLoading || !editingProductId}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                  title="See every override for this product with filters by ACH and pricing tier"
                >
                  {viewAllOverridesLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      <Wallet className="h-4 w-4" />
                      View all overrides
                    </>
                  )}
                </button>
                <button
                  onClick={closeOverrideModal}
                  className="p-2 text-gray-500 hover:text-gray-700 rounded-lg hover:bg-gray-100"
                  title="Close override manager"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {overrideModalData.error && (
              <div className="m-4 p-3 rounded border border-red-200 bg-red-50 text-red-700 text-sm">
                {overrideModalData.error}
              </div>
            )}

                <div className="flex flex-col md:flex-row-reverse gap-6 p-6 overflow-y-auto max-h-[calc(90vh-220px)]">
              <div className="md:w-2/3 space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-gray-900">Existing Overrides</h4>
                  {overrideModalData.loading && <Loader2 className="h-4 w-4 animate-spin text-oe-primary" />}
                </div>

                {overrideModalData.overrides.length === 0 ? (
                  <div className="text-sm text-gray-500 border border-dashed border-gray-300 rounded-lg p-6 text-center">
                    {overrideModalData.loading ? 'Loading overrides...' : 'No overrides configured for this age band yet.'}
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200 text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">Account</th>
                          <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">Amount</th>
                          <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">Status</th>
                          <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">Effective</th>
                          <th className="px-4 py-3 text-right font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {overrideModalData.overrides.map((override) => {
                          const overrideAmount = Number(override.OverrideAmount) || 0;
                          const achDisplay = formatOverrideAchDisplay(override);
                          return (
                            <tr key={override.OverrideId} className="hover:bg-gray-50">
                              <td className="px-4 py-3">
                                <div className="font-medium text-gray-900">
                                  {achDisplay.primary}
                                </div>
                                <div className="text-xs text-gray-500">
                                  {achDisplay.secondary}
                                </div>
                              </td>
                              <td className="px-4 py-3 text-gray-900">{formatCurrency(overrideAmount)}</td>
                              <td className="px-4 py-3">
                                <span
                                  className={`inline-flex px-2 py-1 text-[11px] font-semibold rounded-full ${
                                    override.IsActive ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-700'
                                  }`}
                                >
                                  {override.IsActive ? 'Active' : 'Inactive'}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-gray-600">
                                {override.EffectiveDate ? new Date(override.EffectiveDate).toLocaleDateString() : '-'}
                              </td>
                              <td className="px-4 py-3 text-right space-x-3">
                                <button
                                  type="button"
                                  onClick={() => handleOverrideEdit(override)}
                                  className="inline-flex items-center gap-1 text-oe-primary hover:text-oe-dark"
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleOverrideToggleActive(override, !override.IsActive)}
                                  className="inline-flex items-center gap-1 text-gray-600 hover:text-gray-800"
                                >
                                  {override.IsActive ? 'Deactivate' : 'Activate'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleOverrideDelete(override)}
                                  className="inline-flex items-center gap-1 text-red-600 hover:text-red-700"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                  Delete
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="md:w-1/3 order-first md:order-last">
                <form onSubmit={handleOverrideSubmit} className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-semibold text-gray-900">
                      {editingOverride ? 'Edit Override' : 'Add Override'}
                    </h4>
                    {overrideSaving && <Loader2 className="h-4 w-4 animate-spin text-oe-primary" />}
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Override Account <span className="text-red-500">*</span>
                    </label>
                    <select
                      value={overrideForm.overrideACHId}
                      onChange={(e) => {
                        resetACHForm();
                        setOverrideForm(prev => ({ ...prev, overrideACHId: e.target.value }));
                      }}
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      required
                    >
                      <option value="">Select account</option>
                      {overrideModalData.achAccounts.map((account) => (
                        <option key={account.OverrideACHId} value={account.OverrideACHId}>
                          {formatAchAccountSelectLabel(account)}
                        </option>
                      ))}
                    </select>
                    <div className="flex flex-wrap gap-2 mt-2">
                      <button
                        type="button"
                        onClick={handleOpenCreateACHForm}
                        className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-oe-primary bg-white border border-oe-primary rounded hover:bg-oe-light"
                      >
                        <Plus className="h-3 w-3" />
                        New account
                      </button>
                      <button
                        type="button"
                        onClick={() => handleOpenEditACHForm(overrideForm.overrideACHId)}
                        disabled={!overrideForm.overrideACHId || achFormLoading}
                        className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {achFormLoading ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Pencil className="h-3 w-3" />
                        )}
                        Edit account
                      </button>
                    </div>
                    {overrideModalData.achAccounts.length === 0 && !showACHForm && (
                      <p className="text-[11px] text-gray-500 mt-1">
                        No override accounts yet for this product owner. Use &quot;New account&quot; to add one.
                      </p>
                    )}

                    {showACHForm && (
                      <div className="mt-3 p-3 border-2 border-oe-primary border-opacity-30 rounded-lg bg-oe-light space-y-3">
                        <div className="flex items-center justify-between">
                          <h5 className="text-xs font-semibold text-gray-900">
                            {achFormMode === 'edit' ? 'Edit ACH Account' : 'New ACH Account'}
                          </h5>
                          <button
                            type="button"
                            onClick={resetACHForm}
                            className="text-gray-400 hover:text-gray-600"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>

                        {achFormMode === 'edit' && (
                          <p className="text-[11px] text-gray-500">
                            Routing and account numbers are required when saving changes.
                          </p>
                        )}

                        <div className="grid grid-cols-1 gap-2">
                          <div>
                            <label className="block text-[11px] font-medium text-gray-700 mb-1">
                              Account Name <span className="text-red-500">*</span>
                            </label>
                            <input
                              type="text"
                              value={achFormData.accountName}
                              onChange={(e) => setACHFormData(prev => ({ ...prev, accountName: e.target.value }))}
                              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                              placeholder="e.g., Primary Override Account"
                            />
                          </div>

                          <div>
                            <label className="block text-[11px] font-medium text-gray-700 mb-1">
                              Account Holder Name <span className="text-red-500">*</span>
                            </label>
                            <input
                              type="text"
                              value={achFormData.accountHolderName}
                              onChange={(e) => setACHFormData(prev => ({ ...prev, accountHolderName: e.target.value }))}
                              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                              placeholder="Legal account holder name"
                            />
                          </div>

                          <div>
                            <label className="block text-[11px] font-medium text-gray-700 mb-1">
                              Bank Name <span className="text-red-500">*</span>
                            </label>
                            <input
                              type="text"
                              value={achFormData.bankName}
                              onChange={(e) => setACHFormData(prev => ({ ...prev, bankName: e.target.value }))}
                              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                              placeholder="e.g., Chase Bank"
                            />
                          </div>

                          <div>
                            <label className="block text-[11px] font-medium text-gray-700 mb-1">
                              Account Type <span className="text-red-500">*</span>
                            </label>
                            <select
                              value={achFormData.bankAccountType}
                              onChange={(e) =>
                                setACHFormData(prev => ({
                                  ...prev,
                                  bankAccountType: e.target.value as 'Checking' | 'Savings' | 'Business' | 'Individual'
                                }))
                              }
                              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                            >
                              <option value="Checking">Checking</option>
                              <option value="Savings">Savings</option>
                            </select>
                          </div>

                          <div>
                            <label className="block text-[11px] font-medium text-gray-700 mb-1">
                              Routing Number <span className="text-red-500">*</span>
                            </label>
                            {achFormMode === 'edit' && achMaskedRouting && (
                              <p className="text-[10px] text-gray-500 mb-1">Current: {achMaskedRouting}</p>
                            )}
                            <input
                              type="text"
                              value={achFormData.routingNumber}
                              onChange={(e) =>
                                setACHFormData(prev => ({
                                  ...prev,
                                  routingNumber: e.target.value.replace(/\D/g, '').slice(0, 9)
                                }))
                              }
                              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                              placeholder="9 digits"
                              maxLength={9}
                            />
                          </div>

                          <div>
                            <label className="block text-[11px] font-medium text-gray-700 mb-1">
                              Account Number <span className="text-red-500">*</span>
                            </label>
                            {achFormMode === 'edit' && achMaskedAccount && (
                              <p className="text-[10px] text-gray-500 mb-1">Current: {achMaskedAccount}</p>
                            )}
                            <input
                              type="text"
                              value={achFormData.accountNumber}
                              onChange={(e) =>
                                setACHFormData(prev => ({
                                  ...prev,
                                  accountNumber: e.target.value.replace(/\D/g, '')
                                }))
                              }
                              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                              placeholder="Account number"
                            />
                          </div>
                        </div>

                        {achFormError && (
                          <div className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5">
                            {achFormError}
                          </div>
                        )}

                        <div className="flex justify-end gap-2 pt-1 border-t border-oe-primary border-opacity-30">
                          <button
                            type="button"
                            onClick={resetACHForm}
                            className="px-2 py-1 text-[11px] font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={handleSubmitACHAccount}
                            disabled={
                              achFormSaving ||
                              !achFormData.accountName.trim() ||
                              !achFormData.accountHolderName.trim() ||
                              !achFormData.bankName.trim() ||
                              achFormData.routingNumber.replace(/\D/g, '').length !== 9 ||
                              achFormData.accountNumber.replace(/\D/g, '').length === 0
                            }
                            className="px-2 py-1 text-[11px] font-medium text-white bg-oe-primary rounded hover:bg-oe-dark disabled:opacity-50"
                          >
                            {achFormSaving
                              ? achFormMode === 'edit'
                                ? 'Saving...'
                                : 'Creating...'
                              : achFormMode === 'edit'
                                ? 'Save Account'
                                : 'Create Account'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Override Amount <span className="text-red-500">*</span>
                    </label>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-500 text-sm">$</div>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={overrideForm.overrideAmount}
                        onChange={(e) => setOverrideForm(prev => ({ ...prev, overrideAmount: e.target.value }))}
                        className="w-full pl-7 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                        required
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Effective Date</label>
                    <input
                      type="date"
                      value={overrideForm.effectiveDate}
                      onChange={(e) => setOverrideForm(prev => ({ ...prev, effectiveDate: e.target.value }))}
                      className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    />
                  </div>

                  <label className="inline-flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={overrideForm.isActive}
                      onChange={(e) => setOverrideForm(prev => ({ ...prev, isActive: e.target.checked }))}
                      className="rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                    />
                    <span className="text-xs text-gray-700">Override is active</span>
                  </label>

                  {overrideSuccessMessage && (
                    <div className="text-xs text-green-800 bg-green-50 border border-green-200 rounded px-3 py-2">
                      {overrideSuccessMessage}
                    </div>
                  )}

                  {overrideActionError && (
                    <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
                      {overrideActionError}
                    </div>
                  )}

                  <div className="flex flex-wrap justify-end gap-2 pt-2">
                    {editingOverride && (
                      <button
                        type="button"
                        onClick={resetOverrideForm}
                        className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-100"
                      >
                        Cancel Edit
                      </button>
                    )}
                    {!editingOverride && (
                      <button
                        type="button"
                        onClick={handleAddOverrideToAllPricingTiers}
                        disabled={
                          overrideSaving ||
                          overrideModalData.loading ||
                          !overrideForm.overrideACHId ||
                          !overrideForm.overrideAmount ||
                          parseFloat(overrideForm.overrideAmount) <= 0 ||
                          bulkOverrideBandTargets.length === 0
                        }
                        title={
                          bulkOverrideBandTargets.length === 0
                            ? 'Save all age bands before adding overrides across tiers'
                            : `Add this override to ${bulkOverrideBandTargets.length} saved age band(s)`
                        }
                        className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-oe-primary bg-white border border-oe-primary rounded-lg hover:bg-oe-light disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {overrideSaving ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                        Add to all pricing tiers
                      </button>
                    )}
                    <button
                      type="submit"
                      disabled={overrideSaving || overrideModalData.loading || !overrideForm.overrideACHId}
                      className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white rounded-lg ${
                        overrideSaving || overrideModalData.loading || !overrideForm.overrideACHId
                          ? 'bg-oe-primary/60 cursor-not-allowed'
                          : 'bg-oe-primary hover:bg-oe-dark'
                      }`}
                    >
                      {overrideSaving ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        editingOverride ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />
                      )}
                      {editingOverride ? 'Update Override' : 'Add Override'}
                    </button>
                  </div>
                </form>
              </div>
            </div>

            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 px-6 pb-6 pt-3 border-t border-gray-200 bg-gray-50 text-sm text-gray-700">
              <div className="font-semibold flex items-center gap-2">
                <span>Override Pool:</span>
                <span>{formatCurrency(overrideModalState.overrideRate)}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-gray-600">Override Allocated:</span>
                <span className="font-medium text-oe-primary">{formatCurrency(overrideModalData.overrides.filter(o => o.IsActive).reduce((sum, o) => sum + (Number(o.OverrideAmount) || 0), 0))}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-gray-600">Override Remaining:</span>
                <span className="font-medium text-green-600">
                  {formatCurrency(Math.max(
                    overrideModalState.overrideRate -
                      overrideModalData.overrides
                        .filter(o => o.IsActive)
                        .reduce((sum, o) => sum + (Number(o.OverrideAmount) || 0), 0),
                    0
                  ))}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {bulkOverwritePrompt && (
        <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black bg-opacity-50 p-4">
          <div className="bg-white rounded-lg w-full max-w-md shadow-2xl overflow-hidden">
            <div className="p-6 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Overwrite existing overrides?</h3>
              <p className="text-sm text-gray-600 mt-2">
                Are you sure you want to overwrite existing tier configurations for this override?
              </p>
              <p className="text-sm text-gray-600 mt-2">
                {bulkOverwritePrompt.tierLabels.length} pricing tier
                {bulkOverwritePrompt.tierLabels.length === 1 ? '' : 's'} already use this bank account. Their
                amounts will be updated to {formatCurrency(parseFloat(overrideForm.overrideAmount) || 0)}.
              </p>
              {bulkOverwritePrompt.tierLabels.length <= 6 && (
                <ul className="mt-3 text-xs text-gray-500 list-disc list-inside max-h-32 overflow-y-auto">
                  {bulkOverwritePrompt.tierLabels.map((label) => (
                    <li key={label}>{label}</li>
                  ))}
                </ul>
              )}
            </div>
            <div className="flex justify-end gap-2 p-4 bg-gray-50 border-t border-gray-200">
              <button
                type="button"
                onClick={() => setBulkOverwritePrompt(null)}
                disabled={overrideSaving}
                className="px-4 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmBulkOverwrite}
                disabled={overrideSaving}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-oe-primary rounded-lg hover:bg-oe-dark disabled:opacity-50"
              >
                {overrideSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Overwrite and apply
              </button>
            </div>
          </div>
        </div>
      )}

      {showViewAllOverridesModal && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black bg-opacity-50 p-4">
          <div className="bg-white rounded-lg w-full max-w-5xl max-h-[90vh] overflow-hidden shadow-2xl flex flex-col">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">All overrides for this product</h3>
              <button
                type="button"
                onClick={() => setShowViewAllOverridesModal(false)}
                className="text-gray-500 hover:text-gray-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 border-b border-gray-200 flex flex-wrap gap-4 items-center">
              <label className="text-sm font-medium text-gray-700">Filter by ACH:</label>
              <select
                value={viewAllFilterACHId}
                onChange={(e) => setViewAllFilterACHId(e.target.value)}
                className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
              >
                <option value="">All ACH accounts</option>
                {Array.from(new Map(viewAllOverrides.map(o => [o.OverrideACHId || '', o])).entries())
                  .filter(([id]) => id)
                  .map(([id, o]) => {
                    const ach = achAccountById.get(id);
                    const name = o.ACHAccountName || o.OverrideName || 'Override';
                    const last4 = formatAchLast4Suffix(ach?.maskedAccountNumber);
                    return (
                      <option key={id} value={id}>{`${name}${last4}`}</option>
                    );
                  })}
              </select>
              <label className="text-sm font-medium text-gray-700">Filter by pricing tier:</label>
              <select
                value={viewAllFilterPricingId}
                onChange={(e) => setViewAllFilterPricingId(e.target.value)}
                className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
              >
                <option value="">All pricing tiers</option>
                {Array.from(new Map(viewAllOverrides.map(o => {
                  const pid = o.ProductPricingId || '';
                  const label = o.PricingLabel
                    ? [o.PricingLabel, (o.PricingMinAge != null || o.PricingMaxAge != null) ? `(Age ${o.PricingMinAge ?? '?'}-${o.PricingMaxAge ?? '?'})` : ''].filter(Boolean).join(' ')
                    : o.PricingName || pid.slice(0, 8);
                  return [pid, label];
                })).entries())
                  .filter(([id]) => id)
                  .map(([id, label]) => (
                    <option key={id} value={id}>{label}</option>
                  ))}
              </select>
            </div>
            <div className="flex-1 overflow-auto p-6">
              {viewAllOverrides.length === 0 ? (
                <div className="text-sm text-gray-500 text-center py-10">No overrides for this product.</div>
              ) : (() => {
                const filtered = viewAllOverrides.filter(o => {
                  if (viewAllFilterACHId && (o.OverrideACHId || '') !== viewAllFilterACHId) return false;
                  if (viewAllFilterPricingId && (o.ProductPricingId || '').toLowerCase() !== viewAllFilterPricingId.toLowerCase()) return false;
                  return true;
                });
                if (filtered.length === 0) {
                  return <div className="text-sm text-gray-500 text-center py-10">No overrides match the selected filters.</div>;
                }
                return (
                  <table className="min-w-full divide-y divide-gray-200 text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">Pricing tier</th>
                        <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">Account</th>
                        <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">Amount</th>
                        <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">Status</th>
                        <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">Effective</th>
                        <th className="px-4 py-3 text-right font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {filtered.map((override) => {
                        const bandLabel = override.PricingLabel
                          ? [override.PricingLabel, (override.PricingMinAge != null || override.PricingMaxAge != null) ? `(Age ${override.PricingMinAge ?? '?'}-${override.PricingMaxAge ?? '?'})` : ''].filter(Boolean).join(' ')
                          : override.PricingName || override.ProductPricingId?.slice(0, 8) || '—';
                        const achDisplay = formatOverrideAchDisplay(override);
                        return (
                          <tr key={override.OverrideId} className="hover:bg-gray-50">
                            <td className="px-4 py-3 text-gray-700 whitespace-nowrap">{bandLabel}</td>
                            <td className="px-4 py-3">
                              <div className="font-medium text-gray-900">{achDisplay.primary}</div>
                              <div className="text-xs text-gray-500">{achDisplay.secondary}</div>
                            </td>
                            <td className="px-4 py-3 text-gray-900">{formatCurrency(Number(override.OverrideAmount) || 0)}</td>
                            <td className="px-4 py-3">
                              <span className={`inline-flex px-2 py-1 text-[11px] font-semibold rounded-full ${override.IsActive ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-700'}`}>
                                {override.IsActive ? 'Active' : 'Inactive'}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-gray-600">
                              {override.EffectiveDate ? new Date(override.EffectiveDate).toLocaleDateString() : '-'}
                            </td>
                            <td className="px-4 py-3 text-right">
                              <button
                                type="button"
                                onClick={() => handleViewAllOverrideDelete(override)}
                                disabled={overrideSaving}
                                className="inline-flex items-center gap-1 text-red-600 hover:text-red-700 disabled:opacity-50"
                              >
                                {overrideSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                                {overrideSaving ? 'Deleting...' : 'Delete'}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {showPhaseInModal && (
        <div className="fixed inset-0 z-[2147483648] flex items-center justify-center bg-black bg-opacity-50 p-4">
          <div className="bg-white rounded-lg w-full max-w-md overflow-hidden shadow-2xl">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Phase In New Pricing</h3>
              <button
                type="button"
                onClick={() => {
                  setShowPhaseInModal(false);
                  setPhaseInError(null);
                }}
                className="text-gray-500 hover:text-gray-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              <p className="text-sm text-gray-600">
                Set when current open-ended pricing should end. New pricing tiers will start the next day with the same values.
              </p>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  End date for current pricing
                </label>
                <input
                  type="date"
                  value={phaseInEndDate}
                  onChange={(e) => {
                    setPhaseInEndDate(e.target.value);
                    setPhaseInError(null);
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                />
                {phaseInEndDate && (
                  <p className="text-xs text-gray-500 mt-1">
                    New phase starts: {getNextDay(phaseInEndDate)}
                  </p>
                )}
              </div>
              {phaseInError && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
                  {phaseInError}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 p-4 border-t border-gray-200 bg-gray-50">
              <button
                type="button"
                onClick={() => {
                  setShowPhaseInModal(false);
                  setPhaseInError(null);
                }}
                className="px-4 py-2 text-sm text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handlePhaseInNewPricing}
                className="px-4 py-2 text-sm text-white bg-oe-primary rounded-lg hover:bg-oe-dark"
              >
                Phase In
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
