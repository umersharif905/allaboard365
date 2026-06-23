import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, Sparkles, Trash2 } from 'lucide-react';
import SearchableDropdown from '../../common/SearchableDropdown';
import { apiService } from '../../../services/api.service';
import TobaccoDetectionConfig from './TobaccoDetectionConfig';
import {
  filterSourceKeysForImportRules,
  formatUsesSourceKeyFilter,
  staleSourceKeysForImportRules,
  sourceKeyIncludedByRules,
} from '../../../utils/vendorImportSourceKeys';
import type { VendorImportRules } from '../../../types/vendor/vendorImportRules.types';
import { buildEffectiveImportRulesFromPreset } from '../../../utils/vendorImportRulesNormalize';
import {
  describePlanKeySourceFromRules,
  planKeyFileColumnHint,
  productIdColumnHint,
} from '../../../utils/describePlanKeySource';
import {
  allKeysForPlanGroup,
  applyAutoMapForPlanGroups,
  syncPlanGroupMappingKeys,
  filterTiersForProduct,
  formatTierDropdownLabel,
  inferDefaultAutoMapProductId,
  primaryPlanCodeLabel,
  resolvedPricingIdForGroup,
  shouldShowCatalogKeyHint,
  type PlanCodeGroup,
  type PricingTierOption,
} from '../../../utils/vendorImportProductMapping';

interface Props {
  formatSlug?: string;
  distinctProducts: string[];
  planCodeGroups?: PlanCodeGroup[];
  importRules?: VendorImportRules | null;
  formatLabel?: string;
  rowTemplate?: string;
  tobaccoCsvColumn?: string;
  tobaccoYesValues?: string[];
  onTobaccoChange?: (next: { tobaccoCsvColumn: string; tobaccoYesValues: string[] }) => void;
  validation?: {
    weakPlanCodes?: Array<{ planKey: string; reason: string; suggestion?: string | null }>;
    rowsWithGenericPlanNameOnly?: number;
    formatIssues?: Array<{ code: string; message: string }>;
  };
  onBack: () => void;
  onContinue: () => void | Promise<void>;
}

function formatMoney(amount: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount || 0);
}

function tierRateLabel(tier: PricingTierOption): string {
  return `Net ${formatMoney(tier.netRate)} · MSRP ${formatMoney(tier.msrpRate)}`;
}

function groupsFromProps(distinctProducts: string[], planCodeGroups?: PlanCodeGroup[]): PlanCodeGroup[] {
  if (planCodeGroups?.length) return planCodeGroups;
  return distinctProducts.map((lookupKey) => ({ lookupKey, filePlanCodes: [] }));
}

const VendorImportProductMappingStep: React.FC<Props> = ({
  formatSlug,
  distinctProducts,
  planCodeGroups,
  importRules,
  formatLabel,
  rowTemplate = '',
  tobaccoCsvColumn = '',
  tobaccoYesValues = [],
  onTobaccoChange,
  validation,
  onBack,
  onContinue,
}) => {
  const effectiveRules = useMemo(
    () => buildEffectiveImportRulesFromPreset({
      importRules,
      tobaccoCsvColumn,
      tobaccoYesValues,
    }),
    [importRules, tobaccoCsvColumn, tobaccoYesValues],
  );
  const planGroups = useMemo(
    () => groupsFromProps(distinctProducts, planCodeGroups),
    [distinctProducts, planCodeGroups],
  );

  const visiblePlanGroups = useMemo(() => {
    const fromUploadedFile = planGroups.some((g) => g.filePlanCodes.length > 0);
    if (fromUploadedFile) return planGroups;
    if (!formatUsesSourceKeyFilter(effectiveRules)) return planGroups;
    return planGroups.filter(
      (g) => sourceKeyIncludedByRules(g.lookupKey, effectiveRules)
        || g.filePlanCodes.some((code) => sourceKeyIncludedByRules(code, effectiveRules)),
    );
  }, [effectiveRules, planGroups]);

  const [tiers, setTiers] = useState<PricingTierOption[]>([]);
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [autoMapProductId, setAutoMapProductId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pendingRemovals, setPendingRemovals] = useState<Set<string>>(() => new Set());

  const staleSourceKeys = useMemo(
    () => staleSourceKeysForImportRules(Object.keys(mappings), effectiveRules),
    [mappings, effectiveRules],
  );

  const planGroupLoadKey = planGroups
    .map((g) => `${g.lookupKey}:${g.filePlanCodes.join('|')}`)
    .join(';');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [tierRes, mapRes] = await Promise.all([
          apiService.get<{ success: boolean; data: PricingTierOption[] }>('/api/me/vendor/import/pricing-tiers'),
          apiService.get<{
            success: boolean;
            data: Array<{ sourceProductKey: string; productPricingId?: string }>;
          }>('/api/me/vendor/import/members/product-mapping'),
        ]);

        const tierRows = tierRes.success ? tierRes.data || [] : [];
        setTiers(tierRows);

        const saved: Record<string, string> = {};
        if (mapRes.success) {
          for (const row of mapRes.data || []) {
            if (row.productPricingId) saved[row.sourceProductKey] = row.productPricingId;
          }
        }

        const defaultProductId = inferDefaultAutoMapProductId(
          visiblePlanGroups.map((g) => g.lookupKey),
          tierRows,
          {},
          effectiveRules,
        );
        const merged = syncPlanGroupMappingKeys(
          visiblePlanGroups,
          applyAutoMapForPlanGroups(
            visiblePlanGroups,
            tierRows,
            defaultProductId || undefined,
            effectiveRules,
            saved,
          ),
        );
        if (cancelled) return;

        setMappings(merged);
        setAutoMapProductId(
          inferDefaultAutoMapProductId(visiblePlanGroups.map((g) => g.lookupKey), tierRows, merged, effectiveRules)
            || defaultProductId,
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [planGroupLoadKey, formatSlug, visiblePlanGroups]);

  const tierById = useMemo(() => {
    const map = new Map<string, PricingTierOption>();
    for (const t of tiers) map.set(t.productPricingId, t);
    return map;
  }, [tiers]);

  const tiersForPicker = useMemo(
    () => filterTiersForProduct(tiers, autoMapProductId),
    [tiers, autoMapProductId],
  );

  const dropdownOptions = useMemo(() => tiersForPicker.map((t) => ({
    id: t.productPricingId,
    label: formatTierDropdownLabel(t, tierRateLabel(t)),
    value: t.productPricingId,
    sublabel: t.importKey ? `Catalog key: ${t.importKey}` : tierRateLabel(t),
  })), [tiersForPicker]);

  const handleProductFilterChange = (productId: string) => {
    setAutoMapProductId(productId);
    if (!productId) return;
    setMappings((prev) => {
      const next: Record<string, string> = {};
      for (const group of planGroups) {
        const pricingId = resolvedPricingIdForGroup(group, prev);
        const tier = tiers.find((t) => t.productPricingId === pricingId);
        if (tier?.productId === productId) next[group.lookupKey] = pricingId;
      }
      return next;
    });
  };

  const productOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const t of tiers) {
      if (!byId.has(t.productId)) byId.set(t.productId, t.productName);
    }
    return Array.from(byId.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [tiers]);

  const autoMapProductOptions = useMemo(
    () => productOptions.map((p) => ({ id: p.id, label: p.name, value: p.id })),
    [productOptions],
  );

  const autoMapProductName = autoMapProductId
    ? productOptions.find((p) => p.id === autoMapProductId)?.name
    : null;

  const mappedCount = visiblePlanGroups.filter((g) => resolvedPricingIdForGroup(g, mappings)).length;
  const unmappedCount = visiblePlanGroups.length - mappedCount;

  const runAutoMap = () => {
    setMappings((prev) => applyAutoMapForPlanGroups(
      visiblePlanGroups,
      tiers,
      autoMapProductId || undefined,
      effectiveRules,
      prev,
    ));
  };

  const setGroupMapping = (group: PlanCodeGroup, pricingId: string) => {
    setMappings((prev) => {
      const next = { ...prev };
      for (const k of allKeysForPlanGroup(group)) {
        if (pricingId) next[k] = pricingId;
        else delete next[k];
      }
      return next;
    });
  };

  const removeGroup = (group: PlanCodeGroup) => {
    const keys = allKeysForPlanGroup(group);
    setMappings((prev) => {
      const next = { ...prev };
      for (const k of keys) delete next[k];
      return next;
    });
    setPendingRemovals((prev) => {
      const next = new Set(prev);
      for (const k of keys) next.add(k);
      return next;
    });
  };

  const removeStaleSourceMappings = () => {
    if (!staleSourceKeys.length) return;
    setMappings((prev) => {
      const next = { ...prev };
      for (const k of staleSourceKeys) delete next[k];
      return next;
    });
    setPendingRemovals((prev) => {
      const next = new Set(prev);
      for (const k of staleSourceKeys) next.add(k);
      return next;
    });
  };

  const saveAndContinue = async () => {
    if (unmappedCount > 0) return;
    setSaving(true);
    try {
      const rows: Array<{ sourceProductKey: string; productId: string | null; productPricingId: string | null }> = [];
      for (const group of visiblePlanGroups) {
        const tier = tierById.get(mappings[group.lookupKey] || '');
        if (!tier?.productId || !tier.productPricingId) continue;
        for (const sourceProductKey of allKeysForPlanGroup(group)) {
          rows.push({
            sourceProductKey,
            productId: tier.productId,
            productPricingId: tier.productPricingId,
          });
        }
      }
      await apiService.post('/api/me/vendor/import/members/product-mapping', {
        mappings: rows,
        removeSourceProductKeys: [...pendingRemovals],
      });
      setPendingRemovals(new Set());
      onContinue();
    } finally {
      setSaving(false);
    }
  };

  const renderPlanGroupRow = (group: PlanCodeGroup) => {
    const pricingId = mappings[group.lookupKey] || resolvedPricingIdForGroup(group, mappings);
    const selectedTier = tierById.get(pricingId || '');
    const weakHint = validation?.weakPlanCodes?.find((w) => w.planKey === group.lookupKey
      || group.filePlanCodes.includes(w.planKey));
    const filterProductId = group.targetProductId || autoMapProductId;
    let tierOptions = filterTiersForProduct(tiers, filterProductId).map((t) => ({
      id: t.productPricingId,
      value: t.productPricingId,
      label: formatTierDropdownLabel(t, tierRateLabel(t)),
      sublabel: t.importKey ? `Catalog key: ${t.importKey}` : tierRateLabel(t),
    }));
    if (selectedTier && !tierOptions.some((o) => o.value === selectedTier.productPricingId)) {
      tierOptions = [
        {
          id: selectedTier.productPricingId,
          value: selectedTier.productPricingId,
          label: formatTierDropdownLabel(selectedTier, tierRateLabel(selectedTier)),
          sublabel: selectedTier.importKey ? `Catalog key: ${selectedTier.importKey}` : tierRateLabel(selectedTier),
        },
        ...tierOptions,
      ];
    }
    return (
      <div key={`${group.importProductId || ''}:${group.lookupKey}`} className="grid grid-cols-1 md:grid-cols-2 gap-2 items-start border-b pb-3">
        <div className="flex gap-2">
          <div className="flex-1 min-w-0">
            <span className="text-sm font-mono font-medium">{primaryPlanCodeLabel(group)}</span>
            <p className="text-xs text-gray-500 mt-0.5">{planKeyFileColumnHint(effectiveRules)} in file</p>
            {group.productIdKey && (
              <p className="text-xs text-gray-600 mt-1">
                File product id: <span className="font-mono">{group.productIdKey}</span>
              </p>
            )}
            {shouldShowCatalogKeyHint(group) && (
              <p className="text-xs text-gray-600 mt-1">
                Catalog map key: <span className="font-mono">{group.lookupKey}</span>
              </p>
            )}
            {weakHint?.suggestion && (
              <p className="text-xs text-amber-700 mt-1">{weakHint.suggestion}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => removeGroup(group)}
            className="shrink-0 p-2 text-red-600 hover:bg-red-50 rounded-lg border border-transparent hover:border-red-200"
            title="Remove mapping"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
        <div>
          <SearchableDropdown
            options={tierOptions}
            value={pricingId}
            onChange={(v) => setGroupMapping(group, v)}
            placeholder={filterProductId ? 'Select pricing tier…' : 'Choose product above first'}
            disabled={!filterProductId}
          />
          {selectedTier && (
            <p className="text-xs text-gray-600 mt-1">
              {tierRateLabel(selectedTier)}
              {selectedTier.importKey && selectedTier.importKey !== group.lookupKey && (
                <span> · Tier key: {selectedTier.importKey}</span>
              )}
            </p>
          )}
        </div>
      </div>
    );
  };

  const planGroupSections = useMemo(() => {
    const sections = new Map<string, PlanCodeGroup[]>();
    for (const g of visiblePlanGroups) {
      const label = g.importProductLabel || 'Plan keys';
      if (!sections.has(label)) sections.set(label, []);
      sections.get(label)!.push(g);
    }
    return [...sections.entries()];
  }, [visiblePlanGroups]);

  if (loading) {
    return (
      <div className="flex justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin text-oe-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {(validation?.weakPlanCodes?.length || validation?.formatIssues?.length || (validation?.rowsWithGenericPlanNameOnly ?? 0) > 0) ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <div className="font-medium">File plan code issues</div>
          {(validation?.rowsWithGenericPlanNameOnly ?? 0) > 0 && (
            <p className="mt-1 text-xs">
              {validation?.rowsWithGenericPlanNameOnly} row(s) have a product name in Plan Name without Plan Tier + UA.
            </p>
          )}
          {validation?.weakPlanCodes?.map((w) => (
            <p key={w.planKey} className="mt-1 text-xs">
              <span className="font-mono font-medium">{w.planKey}</span>
              {w.suggestion ? ` — ${w.suggestion}` : ''}
            </p>
          ))}
          {validation?.formatIssues?.map((issue) => (
            <p key={issue.message} className="mt-1 text-xs">{issue.message}</p>
          ))}
        </div>
      ) : null}
      {onTobaccoChange && rowTemplate ? (
        <TobaccoDetectionConfig
          formatLabel={formatLabel}
          rowTemplate={rowTemplate}
          tobaccoCsvColumn={tobaccoCsvColumn}
          tobaccoYesValues={tobaccoYesValues}
          onChange={onTobaccoChange}
          hasTobaccoTiers={tiers.some((t) => t.tobaccoStatus === 'Yes' || t.tobaccoStatus === 'No')}
        />
      ) : null}

      <div>
        <p className="text-sm text-gray-600">
          Plan keys come from format <strong>Import rules</strong> ({describePlanKeySourceFromRules(effectiveRules)}).
          Map each <strong>catalog key</strong> below to a product pricing tier.
          File source columns: <strong>{planKeyFileColumnHint(effectiveRules)}</strong>
          {' '}(native Align inbound often shows <code className="bg-gray-100 px-1 rounded">11321</code> +{' '}
          <code className="bg-gray-100 px-1 rounded">AH1500EE</code>, resolved to keys like{' '}
          <code className="bg-gray-100 px-1 rounded">EE_1500</code>).
          When tiers include tobacco variants, the tobacco column above selects Yes vs No per row.
        </p>
        <p className="text-xs text-gray-500 mt-1">
          {mappedCount} of {visiblePlanGroups.length} mapped
          {unmappedCount > 0 && ` · ${unmappedCount} still need a tier`}
        </p>
        {staleSourceKeys.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <p className="text-xs text-amber-800">
              {staleSourceKeys.length} saved key{staleSourceKeys.length !== 1 ? 's' : ''} do not match this format’s include pattern (not shown).
            </p>
            <button
              type="button"
              onClick={removeStaleSourceMappings}
              className="text-xs font-medium text-red-700 hover:underline"
            >
              Remove all legacy keys on save
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-col sm:flex-row sm:flex-wrap gap-3 sm:items-end">
        <div className="min-w-[220px] flex-1 sm:max-w-xs">
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Product (filters tier list)
          </label>
          <SearchableDropdown
            options={autoMapProductOptions}
            value={autoMapProductId}
            onChange={handleProductFilterChange}
            placeholder="Select product (required)"
          />
        </div>
        <button
          type="button"
          onClick={runAutoMap}
          disabled={!autoMapProductId}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 shrink-0 disabled:opacity-50"
        >
          <Sparkles className="h-4 w-4" />
          Auto-map
          {autoMapProductName ? ` (${autoMapProductName})` : ''}
        </button>
      </div>

      <div className="space-y-4 max-h-96 overflow-auto">
        {planGroupSections.map(([sectionLabel, groups]) => (
          <div key={sectionLabel}>
            {planGroupSections.length > 1 && (
              <h4 className="text-xs font-semibold text-gray-700 mb-2 sticky top-0 bg-white py-1 border-b border-gray-100">
                {sectionLabel}
              </h4>
            )}
            <div className="space-y-3">
              {groups.map((group) => renderPlanGroupRow(group))}
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <button type="button" onClick={onBack} className="px-4 py-2 border rounded-lg text-sm">Back</button>
        <button
          type="button"
          disabled={saving || unmappedCount > 0}
          onClick={() => void saveAndContinue()}
          className="px-4 py-2 bg-oe-primary text-white rounded-lg text-sm disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Continue to preview'}
        </button>
      </div>
    </div>
  );
};

export default VendorImportProductMappingStep;
