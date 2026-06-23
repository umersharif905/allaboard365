import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, Sparkles, Trash2 } from 'lucide-react';
import SearchableDropdown from '../../common/SearchableDropdown';
import { apiService } from '../../../services/api.service';
import {
  filterSourceKeysForImportRules,
  formatUsesSourceKeyFilter,
  staleSourceKeysForImportRules,
} from '../../../utils/vendorImportSourceKeys';
import TobaccoDetectionConfig from './TobaccoDetectionConfig';
import type { VendorImportRules } from '../../../types/vendor/vendorImportRules.types';
import { buildEffectiveImportRulesFromPreset } from '../../../utils/vendorImportRulesNormalize';
import {
  allKeysForPlanGroup,
  applyAutoMapForPlanGroups,
  buildPlanGroupsFromImportKeys,
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

function tierRateLabel(tier: PricingTierOption): string {
  return `Net ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(tier.netRate || 0)}`;
}

interface Props {
  formatSlug?: string;
  /** Extra keys to show beyond saved mappings and format-specific suggestions. */
  suggestedKeys?: string[];
  /** From selected format preset — drives UA relabel and auto-map product hint. */
  importRules?: VendorImportRules | null;
  formatLabel?: string;
  rowTemplate?: string;
  tobaccoCsvColumn?: string;
  tobaccoYesValues?: string[];
  onTobaccoChange?: (next: { tobaccoCsvColumn: string; tobaccoYesValues: string[] }) => void;
  onSaveTobacco?: () => void;
  tobaccoSaving?: boolean;
}

const VendorImportProductMappingPanel: React.FC<Props> = ({
  formatSlug,
  suggestedKeys = [],
  importRules,
  formatLabel,
  rowTemplate = '',
  tobaccoCsvColumn = '',
  tobaccoYesValues = [],
  onTobaccoChange,
  onSaveTobacco,
  tobaccoSaving,
}) => {
  const effectiveRules = useMemo(
    () => buildEffectiveImportRulesFromPreset({
      importRules,
      tobaccoCsvColumn,
      tobaccoYesValues,
    }),
    [importRules, tobaccoCsvColumn, tobaccoYesValues],
  );

  const [tiers, setTiers] = useState<PricingTierOption[]>([]);
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [autoMapProductId, setAutoMapProductId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pendingRemovals, setPendingRemovals] = useState<Set<string>>(() => new Set());

  const mappingLoadKey = `${formatSlug ?? ''}|${effectiveRules.planKey.sourceKeyIncludeRegex ?? ''}`;

  const visibleSourceKeys = useMemo(() => {
    const raw = [
      ...suggestedKeys,
      ...Object.keys(mappings),
    ];
    return filterSourceKeysForImportRules(raw, effectiveRules);
  }, [effectiveRules, suggestedKeys, mappings]);

  const planGroups = useMemo(
    () => buildPlanGroupsFromImportKeys(visibleSourceKeys, effectiveRules),
    [visibleSourceKeys, effectiveRules],
  );

  const staleSourceKeys = useMemo(
    () => staleSourceKeysForImportRules(Object.keys(mappings), effectiveRules),
    [mappings, effectiveRules],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [tierRes, mapRes] = await Promise.all([
          apiService.get<{ success: boolean; data: PricingTierOption[] }>('/api/me/vendor/import/pricing-tiers'),
          apiService.get<{
            success: boolean;
            data: Array<{ sourceProductKey: string; productPricingId?: string }>;
          }>('/api/me/vendor/import/members/product-mapping'),
        ]);

        if (cancelled) return;

        const tierRows = tierRes.success ? tierRes.data || [] : [];
        setTiers(tierRows);

        const saved: Record<string, string> = {};
        if (mapRes.success) {
          for (const row of mapRes.data || []) {
            if (row.productPricingId) saved[row.sourceProductKey] = row.productPricingId;
          }
        }

        const initialKeys = filterSourceKeysForImportRules(
          [...new Set([...suggestedKeys, ...Object.keys(saved)])],
          effectiveRules,
        );
        const initialGroups = buildPlanGroupsFromImportKeys(initialKeys, effectiveRules);
        const defaultProductId = inferDefaultAutoMapProductId(
          initialGroups.map((g) => g.lookupKey),
          tierRows,
          saved,
          effectiveRules,
        );
        const merged = syncPlanGroupMappingKeys(
          initialGroups,
          applyAutoMapForPlanGroups(
            initialGroups,
            tierRows,
            defaultProductId || undefined,
            effectiveRules,
            saved,
          ),
        );
        if (cancelled) return;

        setMappings(merged);
        setAutoMapProductId(
          inferDefaultAutoMapProductId(initialGroups.map((g) => g.lookupKey), tierRows, merged, effectiveRules)
            || defaultProductId,
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mappingLoadKey, suggestedKeys.join(','), effectiveRules]);

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
    sublabel: t.importKey ? `Catalog key: ${t.importKey}` : undefined,
  })), [tiersForPicker]);

  const handleProductFilterChange = (productId: string) => {
    setAutoMapProductId(productId);
    if (!productId) return;
    setMappings((prev) => {
      const next: Record<string, string> = {};
      for (const [key, pricingId] of Object.entries(prev)) {
        const tier = tiers.find((t) => t.productPricingId === pricingId);
        if (tier?.productId === productId) next[key] = pricingId;
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

  const mappedCount = planGroups.filter((g) => resolvedPricingIdForGroup(g, mappings)).length;
  const unmappedCount = planGroups.length - mappedCount;

  const runAutoMap = () => {
    setMappings((prev) => applyAutoMapForPlanGroups(
      planGroups,
      tiers,
      autoMapProductId || undefined,
      effectiveRules,
      prev,
    ));
  };

  const setGroupMapping = (group: PlanCodeGroup, pricingId: string) => {
    setMappings((prev) => {
      const next = { ...prev };
      for (const k of allKeysForPlanGroup(group)) next[k] = pricingId;
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

  const saveMappings = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const payload: Array<{
        sourceProductKey: string;
        productId: string | null;
        productPricingId: string | null;
      }> = [];
      for (const group of planGroups) {
        const pricingId = resolvedPricingIdForGroup(group, mappings);
        const tier = tierById.get(pricingId || '');
        if (!tier?.productId || !tier.productPricingId) continue;
        for (const sourceProductKey of allKeysForPlanGroup(group)) {
          payload.push({
            sourceProductKey,
            productId: tier.productId,
            productPricingId: tier.productPricingId,
          });
        }
      }
      await apiService.post('/api/me/vendor/import/members/product-mapping', {
        mappings: payload,
        removeSourceProductKeys: [...pendingRemovals],
      });
      setPendingRemovals(new Set());
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center p-6">
        <Loader2 className="h-6 w-6 animate-spin text-oe-primary" />
      </div>
    );
  }

  const hasTobaccoTiers = tiers.some((t) => t.tobaccoStatus === 'Yes' || t.tobaccoStatus === 'No');

  return (
    <div className="space-y-4">
      {onTobaccoChange && rowTemplate ? (
        <div className="space-y-2">
          <TobaccoDetectionConfig
            formatLabel={formatLabel}
            rowTemplate={rowTemplate}
            tobaccoCsvColumn={tobaccoCsvColumn}
            tobaccoYesValues={tobaccoYesValues}
            onChange={onTobaccoChange}
            hasTobaccoTiers={hasTobaccoTiers}
          />
          {onSaveTobacco && (
            <button
              type="button"
              disabled={tobaccoSaving || !tobaccoCsvColumn}
              onClick={onSaveTobacco}
              className="text-sm font-medium text-oe-primary hover:underline disabled:opacity-50"
            >
              {tobaccoSaving ? 'Saving…' : 'Save tobacco detection for this format'}
            </button>
          )}
        </div>
      ) : null}

      <div>
        <p className="text-sm text-gray-600">
          {formatUsesSourceKeyFilter(effectiveRules)
            ? 'Map file plan codes that match this format’s include pattern to catalog tiers. Generic catalog keys are hidden — remove legacy rows with Delete, then Save.'
            : 'Map each plan code to a catalog tier. When tiers show Tobacco Yes/No, pick any matching tier — import uses the tobacco column per row.'}
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
        <p className="text-xs text-gray-500 mt-1">
          {mappedCount} of {planGroups.length} mapped
          {unmappedCount > 0 && ` · ${unmappedCount} need a tier`}
        </p>
      </div>

      <div className="flex flex-col sm:flex-row sm:flex-wrap gap-3 sm:items-end">
        <div className="min-w-[220px] flex-1 sm:max-w-xs">
          <label className="block text-xs font-medium text-gray-600 mb-1">Auto-map within product</label>
          <SearchableDropdown
            options={autoMapProductOptions}
            value={autoMapProductId}
            onChange={handleProductFilterChange}
            placeholder="Select product"
          />
        </div>
        <button
          type="button"
          onClick={runAutoMap}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
        >
          <Sparkles className="h-4 w-4" />
          Auto-map by tier code
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => void saveMappings()}
          className="px-4 py-1.5 text-sm font-medium text-white bg-oe-primary rounded-lg disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save mappings'}
        </button>
        {saved && <span className="text-sm text-green-700">Saved</span>}
      </div>

      <div className="space-y-3 max-h-[28rem] overflow-auto border border-gray-200 rounded-lg p-3">
        {planGroups.map((group) => {
          const pricingId = resolvedPricingIdForGroup(group, mappings);
          const selectedTier = tierById.get(pricingId || '');
          return (
            <div
              key={group.lookupKey}
              className="grid grid-cols-1 md:grid-cols-2 gap-2 items-start border-b border-gray-100 pb-3 last:border-0"
            >
              <div className="pt-2 flex gap-2">
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-mono font-medium">{primaryPlanCodeLabel(group)}</span>
                  <p className="text-xs text-gray-500 mt-0.5">Plan code in file</p>
                  {shouldShowCatalogKeyHint(group) && (
                    <p className="text-xs text-gray-600 mt-1">
                      Catalog key: <span className="font-mono">{group.lookupKey}</span>
                    </p>
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
              <SearchableDropdown
                options={dropdownOptions}
                value={pricingId}
                onChange={(v) => setGroupMapping(group, v)}
                placeholder={autoMapProductId ? 'Select pricing tier…' : 'Choose product above first'}
                disabled={!autoMapProductId}
              />
              {selectedTier && (
                <p className="text-xs text-gray-600 md:col-span-2 -mt-1">
                  {formatTierDropdownLabel(selectedTier, tierRateLabel(selectedTier))}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default VendorImportProductMappingPanel;
