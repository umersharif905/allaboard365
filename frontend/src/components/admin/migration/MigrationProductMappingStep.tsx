import { AlertTriangle, Ban, CheckCircle, ChevronDown, ChevronRight, Info, Loader2, Plus, RefreshCw, RotateCcw, Unlink } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AddProductWizard, { ProductFormData } from '../../forms/AddProductWizard';
import AddBundleWizard from '../../forms/AddBundleWizard';
import { BundleFormData } from '../../../types/sysadmin/addproductswizard.types';
import SearchableDropdown from '../../common/SearchableDropdown';
import {
  E123ProductMappingGroup,
  E123ProductWizardDraftMeta,
  E123VendorRoutingPreview,
  MigrationPricingOption,
  MigrationSubscribedProduct,
  PremiumMatch,
  VendorBucketChoice,
  e123MigrationService
} from '../../../services/e123Migration.service';
import E123VendorRoutingModal from './E123VendorRoutingModal';
import E123CopyProductTemplateModal from './E123CopyProductTemplateModal';
import { apiService } from '../../../services/api.service';
import {
  clearProductMappingDraft,
  loadProductMappingDraft,
  saveProductMappingDraft
} from '../../../utils/e123MigrationSession';
import { uploadProductWizardAssets } from '../../../utils/productWizardSaveUploads';

interface TierSelection {
  productId: string;
  pricingId: string;
  pricingIdTobacco?: string;
}

interface Props {
  batchId?: string;
  instanceId: string;
  tenantId: string;
  tenantName?: string;
  /** When set (member import wizard), scopes E123 products to checked households only. */
  selectedHouseholdCount?: number;
  onMappingChange?: (allMapped: boolean, summary?: { totalGroups: number; pendingGroups: number }) => void;
  resyncTarget?: { sourceProductKey: string; productId: string } | null;
  onResyncTargetHandled?: () => void;
}

function draftScopeKey(batchId: string | undefined, instanceId: string) {
  return batchId || `instance:${instanceId}`;
}

function errorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'string' && err.trim()) return err;
  if (err instanceof Error && err.message.trim()) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}

function tierKey(sourceProductKey: string, sourceBenefitKey: string | null) {
  return `${sourceProductKey}::${sourceBenefitKey || ''}`;
}

/** Sentinel for pricing dropdown — persisted as null; import infers from member premium. */
const PRICING_TIER_NONE = '__none__';

function toSavedPricingId(value?: string | null): string | null {
  if (!value || value === PRICING_TIER_NONE) return null;
  return value;
}

function isUnsetPricingSelection(value?: string | null): boolean {
  return !value || value === '';
}

function buildNonePricingOption(note?: string) {
  return {
    id: PRICING_TIER_NONE,
    value: PRICING_TIER_NONE,
    label: 'None — no fixed tier match',
    sublabel: note || 'Import infers AB365 pricing from each member’s premium'
  };
}

function shouldDefaultTierToNoPricing(
  tier: E123ProductMappingGroup['tiers'][number],
  suggestion: {
    productPricingId?: string | null;
    premiumMatch?: PremiumMatch | null;
  }
): boolean {
  if (tier.memberCount <= 0) return true;
  if (!suggestion.productPricingId) return true;
  if (suggestion.premiumMatch?.status === 'mismatch') return true;
  return false;
}

function resolveTierPricingSelection(
  tier: E123ProductMappingGroup['tiers'][number],
  suggestion: {
    productPricingId?: string | null;
    productPricingIdTobacco?: string | null;
    premiumMatch?: PremiumMatch | null;
    needsDualTobaccoMapping?: boolean;
  },
  productId: string
): TierSelection {
  if (shouldDefaultTierToNoPricing(tier, suggestion)) {
    const dual = tier.needsDualTobaccoMapping
      || suggestion.needsDualTobaccoMapping
      || !!suggestion.productPricingIdTobacco;
    return {
      productId,
      pricingId: PRICING_TIER_NONE,
      pricingIdTobacco: dual ? PRICING_TIER_NONE : undefined
    };
  }
  return {
    productId,
    pricingId: suggestion.productPricingId || '',
    pricingIdTobacco: suggestion.productPricingIdTobacco || undefined
  };
}

function tierRequiresPricingSelection(tier: E123ProductMappingGroup['tiers'][number]): boolean {
  return tier.memberCount > 0;
}

function formatTierCode(code?: string | null) {
  switch (code) {
    case 'EE': return 'Employee Only (EE)';
    case 'ES': return 'Employee + Spouse (ES)';
    case 'EC': return 'Employee + Children (EC)';
    case 'EF': return 'Employee + Family (EF)';
    default: return code || '';
  }
}

function formatE123TierTitle(tier: E123ProductMappingGroup['tiers'][number]) {
  if (tier.resolvedTier) return formatTierCode(tier.resolvedTier);
  if (tier.sourceBenefitLabel && !/^monthly$/i.test(tier.sourceBenefitLabel.trim())) {
    return tier.sourceBenefitLabel;
  }
  if (tier.sourceBenefitKey) return `Benefit ${tier.sourceBenefitKey}`;
  return 'Default tier';
}

function recommendedUseTobaccoPricing(group: E123ProductMappingGroup): boolean {
  if (group.tobaccoPricingRecommendation != null) {
    return group.tobaccoPricingRecommendation.recommended;
  }
  return group.tiers.some((tier) => {
    if (tier.needsDualTobaccoMapping) return true;
    const yes = tier.tobaccoCounts?.yes || 0;
    const no = tier.tobaccoCounts?.no || 0;
    if (yes > 0 && no > 0) return true;
    const stats = tier.feeAmountStats;
    return !!(stats && stats.sampleSize >= 3 && (stats.max - stats.min) >= 5);
  });
}

function formatTobaccoRecommendationLabel(rec: E123ProductMappingGroup['tobaccoPricingRecommendation']): string {
  if (!rec) return '';
  const prefix = rec.recommended ? 'E123 recommends: include tobacco tiers' : 'E123 recommends: skip tobacco tiers';
  const confidence = rec.confidence !== 'low' ? ` (${rec.confidence} confidence)` : '';
  return `${prefix}${confidence}`;
}

function suggestTemplateProductId(
  sourceLabel: string,
  products: MigrationSubscribedProduct[],
  preferredId?: string
): string | undefined {
  if (preferredId && products.some((p) => p.productId === preferredId)) return preferredId;
  const source = normalizeName(sourceLabel);
  let best: string | undefined;
  let bestScore = 0;
  for (const product of products) {
    if (product.isBundle) continue;
    const target = normalizeName(product.name);
    if (!source || !target) continue;
    let score = 0;
    if (source === target) score = 100;
    else if (target.includes(source) || source.includes(target)) score = 85;
    else {
      const tokens = source.split(' ').filter(Boolean);
      const targetTokens = new Set(target.split(' ').filter(Boolean));
      score = tokens.filter((token) => targetTokens.has(token)).length * 20;
    }
    if (score > bestScore && score >= 40) {
      bestScore = score;
      best = product.productId;
    }
  }
  return best;
}

function normalizeName(value: string) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function SalesTypeBadge({ label }: { label: string }) {
  const tone = label === 'Group'
    ? 'bg-violet-50 text-violet-800 border-violet-200'
    : label === 'Individual'
      ? 'bg-sky-50 text-sky-800 border-sky-200'
      : 'bg-slate-50 text-slate-700 border-slate-200';
  return (
    <span className={`inline-flex px-2 py-0.5 text-[11px] font-semibold rounded-full border ${tone}`}>
      {label}
    </span>
  );
}

function getSavedProductId(group: E123ProductMappingGroup): string {
  return group.tiers.find((tier) => tier.savedMap?.productId)?.savedMap?.productId || '';
}

function groupHasSavedPairing(group: E123ProductMappingGroup): boolean {
  return group.tiers.some((tier) => !!tier.savedMap?.productId);
}

function isPendingMappingGroup(group: E123ProductMappingGroup): boolean {
  return !group.ignored && !groupHasSavedPairing(group);
}

function isSyncedMappingGroup(group: E123ProductMappingGroup): boolean {
  return !group.ignored && groupHasSavedPairing(group);
}

function buildAb365ProductDropdownOptions(
  products: MigrationSubscribedProduct[],
  syncedBundleProductIds: Set<string>
) {
  const toOption = (
    product: MigrationSubscribedProduct,
    section?: 'synced-bundles' | 'catalog',
    extraSublabel?: string
  ) => ({
    id: product.productId,
    value: product.productId,
    label: product.name,
    code: product.salesTypeLabel,
    ...(section ? { section } : {}),
    sublabel: [
      product.vendorName ? `Vendor: ${product.vendorName}` : null,
      product.isBundle ? 'Bundle' : null,
      extraSublabel || null,
      product.isHidden ? 'Hidden from agents' : null,
      product.catalogSource === 'owned'
        ? 'Tenant-owned'
        : product.catalogSource === 'both'
          ? 'Subscribed · Tenant-owned'
          : 'Subscribed'
    ].filter(Boolean).join(' · ')
  });

  const syncedBundles = products
    .filter((product) => product.isBundle && syncedBundleProductIds.has(product.productId))
    .sort((a, b) => a.name.localeCompare(b.name));
  const syncedIds = new Set(syncedBundles.map((product) => product.productId));
  const catalogProducts = products
    .filter((product) => !syncedIds.has(product.productId))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!syncedBundles.length) {
    return catalogProducts.map((product) => toOption(product));
  }

  return [
    ...syncedBundles.map((product) => toOption(product, 'synced-bundles', 'Created this migration')),
    ...catalogProducts.map((product) => toOption(product, 'catalog'))
  ];
}

function catalogPremiumLabelPrefix(tier: E123ProductMappingGroup['tiers'][number]): string {
  const sources = tier.catalogPricing?.sources
    || [...new Set((tier.catalogPricing?.rows || []).map((row) => row.source || 'catalog'))];
  if (sources.length === 1 && sources[0] === 'getrates') return 'E123 GetRates';
  if (sources.includes('getrates')) return 'E123 catalog/GetRates';
  return 'E123 catalog';
}

function formatTierCatalogPremium(tier: E123ProductMappingGroup['tiers'][number]): string | null {
  const catalog = tier.catalogPricing;
  if (!catalog?.rows?.length) return null;
  const prefix = catalogPremiumLabelPrefix(tier);
  if (catalog.rows.length === 1) {
    const row = catalog.rows[0];
    const ages = row.memberAgeMin != null && row.memberAgeMax != null
      ? ` · ages ${row.memberAgeMin}-${row.memberAgeMax}`
      : '';
    return `${prefix} $${row.amount.toFixed(2)}/mo${ages}`;
  }
  return `${prefix} $${catalog.min.toFixed(2)}–$${catalog.max.toFixed(2)}/mo (${catalog.rows.length} tiers)`;
}

function ageRangesOverlap(minA: number | null | undefined, maxA: number | null | undefined, minB: number | null | undefined, maxB: number | null | undefined) {
  if (minA == null || maxA == null || minB == null || maxB == null) return true;
  return minA <= maxB && maxA >= minB;
}

function resolveCatalogPremiumForPricingRow(
  tier: E123ProductMappingGroup['tiers'][number],
  row: MigrationPricingOption
): number | null {
  const rows = tier.catalogPricing?.rows || [];
  if (!rows.length) return null;

  const minAge = row.minAge;
  const maxAge = row.maxAge;
  if (minAge != null && maxAge != null) {
    const overlapping = rows.filter((catalogRow) =>
      ageRangesOverlap(catalogRow.memberAgeMin, catalogRow.memberAgeMax, minAge, maxAge)
    );
    const pool = overlapping.length ? overlapping : rows;
    if (pool.length === 1) return pool[0].amount;

    const ab365Amount = ab365PremiumAmount(row);
    if (ab365Amount != null) {
      let best = pool[0].amount;
      let bestDiff = Math.abs(best - ab365Amount);
      for (let i = 1; i < pool.length; i += 1) {
        const diff = Math.abs(pool[i].amount - ab365Amount);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = pool[i].amount;
        }
      }
      return best;
    }
    return pool[0].amount;
  }

  if (rows.length === 1) return rows[0].amount;
  return null;
}

function e123PremiumAmount(tier: E123ProductMappingGroup['tiers'][number]): number | null {
  const catalog = tier.catalogPricing;
  if (catalog?.rows?.length === 1) return catalog.rows[0].amount;
  if (catalog?.median != null) return catalog.median;
  if (tier.feeAmountStats?.median != null) return tier.feeAmountStats.median;
  if (tier.feeHints?.amount != null) return Number(tier.feeHints.amount);
  return null;
}

function resolveE123PremiumForPricingRow(
  tier: E123ProductMappingGroup['tiers'][number],
  row: MigrationPricingOption
): number | null {
  const catalogAmount = resolveCatalogPremiumForPricingRow(tier, row);
  if (catalogAmount != null) return catalogAmount;
  return e123PremiumAmount(tier);
}

function ab365PremiumAmount(row: MigrationPricingOption): number | null {
  return row.displayRate ?? row.totalRate ?? row.msrpRate ?? null;
}

function computeSelectionPremiumMatch(
  tier: E123ProductMappingGroup['tiers'][number],
  pricingId: string,
  pricingRows: MigrationPricingOption[]
): PremiumMatch | null {
  if (!pricingId || pricingId === PRICING_TIER_NONE) return null;
  const row = pricingRows.find((r) => r.productPricingId === pricingId);
  if (!row) return null;
  const e123Amount = resolveE123PremiumForPricingRow(tier, row);
  const ab365Amount = ab365PremiumAmount(row);
  if (e123Amount == null || ab365Amount == null) return null;
  const diff = Math.abs(e123Amount - ab365Amount);
  if (diff < 0.01) {
    return { status: 'exact', e123Amount, ab365Amount, diff: 0 };
  }
  if (diff <= ab365Amount * 0.02) {
    return { status: 'close', e123Amount, ab365Amount, diff };
  }
  return { status: 'mismatch', e123Amount, ab365Amount, diff };
}

function productHasPairedTobaccoRows(pricingRows: MigrationPricingOption[]) {
  const hasNo = pricingRows.some((row) => row.tobaccoStatus !== 'Yes');
  const hasYes = pricingRows.some((row) => row.tobaccoStatus === 'Yes');
  return hasNo && hasYes;
}

function resolveGroupProductId(
  group: E123ProductMappingGroup,
  productSelections: Record<string, string>
): string {
  return productSelections[group.sourceProductKey] || getSavedProductId(group);
}

function groupAllTiersPerfectMatch(
  group: E123ProductMappingGroup,
  productId: string,
  tierSelections: Record<string, TierSelection>,
  pricingByProduct: Record<string, MigrationPricingOption[]>
): boolean {
  if (!productId || group.tiers.length === 0) return false;
  const pricingRows = pricingByProduct[productId] || [];
  return group.tiers.every((tier) => {
    const key = tierKey(group.sourceProductKey, tier.sourceBenefitKey);
    const pricingId = tierSelections[key]?.pricingId || tier.savedMap?.productPricingId || '';
    return computeSelectionPremiumMatch(tier, pricingId, pricingRows)?.status === 'exact';
  });
}

function isSyncedWithConsistentPricing(
  group: E123ProductMappingGroup,
  productSelections: Record<string, string>,
  tierSelections: Record<string, TierSelection>,
  pricingByProduct: Record<string, MigrationPricingOption[]>
): boolean {
  const productId = resolveGroupProductId(group, productSelections);
  if (!productId) return false;
  return groupAllTiersPerfectMatch(group, productId, tierSelections, pricingByProduct);
}

function PremiumMatchBadge({ match, label }: { match?: PremiumMatch | null; label?: string }) {
  if (!match || match.status === 'unknown') return null;
  if (match.status === 'exact') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold rounded-full bg-green-50 text-green-800 border border-green-200">
        <CheckCircle className="h-3 w-3" />
        {label ? `${label}: ` : ''}Perfect match
      </span>
    );
  }
  const e123 = match.e123Amount != null ? `$${match.e123Amount.toFixed(2)}` : '—';
  const ab365 = match.ab365Amount != null ? `$${match.ab365Amount.toFixed(2)}` : '—';
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold rounded-full bg-red-50 text-red-800 border border-red-200">
      <AlertTriangle className="h-3 w-3" />
      {label ? `${label}: ` : ''}E123 {e123} vs AB365 {ab365}
    </span>
  );
}

export default function MigrationProductMappingStep({
  batchId,
  instanceId,
  tenantId,
  tenantName,
  selectedHouseholdCount,
  onMappingChange,
  resyncTarget,
  onResyncTargetHandled
}: Props) {
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [groups, setGroups] = useState<E123ProductMappingGroup[]>([]);
  const [duplicateLabelGroups, setDuplicateLabelGroups] = useState(0);
  const [instanceTenantCount, setInstanceTenantCount] = useState(0);
  const [subscribedProducts, setSubscribedProducts] = useState<MigrationSubscribedProduct[]>([]);
  const [productSelections, setProductSelections] = useState<Record<string, string>>({});
  const [tierSelections, setTierSelections] = useState<Record<string, TierSelection>>({});
  const [tierSuggestReasons, setTierSuggestReasons] = useState<Record<string, string>>({});
  const [pricingByProduct, setPricingByProduct] = useState<Record<string, MigrationPricingOption[]>>({});
  const [showIgnoredProducts, setShowIgnoredProducts] = useState(false);
  const [showSyncedConsistentMappings, setShowSyncedConsistentMappings] = useState(false);
  const [showSyncedInconsistentPricing, setShowSyncedInconsistentPricing] = useState(false);
  const [createWizardOpen, setCreateWizardOpen] = useState(false);
  const [createWizardDraft, setCreateWizardDraft] = useState<ProductFormData | null>(null);
  const [createWizardMeta, setCreateWizardMeta] = useState<E123ProductWizardDraftMeta | null>(null);
  const [createWizardForKey, setCreateWizardForKey] = useState<string | null>(null);
  const [createBundleOpen, setCreateBundleOpen] = useState(false);
  const [createBundleForKey, setCreateBundleForKey] = useState<string | null>(null);
  const [createBundlePrefill, setCreateBundlePrefill] = useState<{ Name: string } | null>(null);
  const [wizardResyncProductId, setWizardResyncProductId] = useState<string | null>(null);
  const [e123ResyncDraft, setE123ResyncDraft] = useState<ProductFormData | null>(null);
  const [draftLoadingKey, setDraftLoadingKey] = useState<string | null>(null);
  const [vendorRoutingOpen, setVendorRoutingOpen] = useState(false);
  const [vendorRoutingPreview, setVendorRoutingPreview] = useState<E123VendorRoutingPreview | null>(null);
  const [vendorRoutingLoading, setVendorRoutingLoading] = useState(false);
  const [pendingWizardGroup, setPendingWizardGroup] = useState<E123ProductMappingGroup | null>(null);
  const [pendingResyncProductId, setPendingResyncProductId] = useState<string | null>(null);
  const [tobaccoPromptOpen, setTobaccoPromptOpen] = useState(false);
  const [tobaccoPromptUseTobacco, setTobaccoPromptUseTobacco] = useState(false);
  const [pendingTobaccoVendorOverrides, setPendingTobaccoVendorOverrides] = useState<Record<string, VendorBucketChoice> | undefined>();
  const [copyTemplateOpen, setCopyTemplateOpen] = useState(false);
  const [copyTemplateLoading, setCopyTemplateLoading] = useState(false);
  const [copyTemplateSuggestedId, setCopyTemplateSuggestedId] = useState<string | undefined>();
  const [syncedBundleProductIds, setSyncedBundleProductIds] = useState<string[]>([]);
  const pricingCacheRef = useRef<Record<string, MigrationPricingOption[]>>({});
  const onMappingChangeRef = useRef(onMappingChange);

  useEffect(() => {
    onMappingChangeRef.current = onMappingChange;
  }, [onMappingChange]);

  const pendingMappingGroups = useMemo(
    () => groups.filter(isPendingMappingGroup),
    [groups]
  );
  const syncedMappingGroups = useMemo(
    () => groups.filter(isSyncedMappingGroup),
    [groups]
  );
  const syncedConsistentPricingGroups = useMemo(
    () => syncedMappingGroups.filter((group) =>
      isSyncedWithConsistentPricing(group, productSelections, tierSelections, pricingByProduct)
    ),
    [syncedMappingGroups, productSelections, tierSelections, pricingByProduct]
  );
  const syncedInconsistentPricingGroups = useMemo(
    () => syncedMappingGroups.filter((group) =>
      !isSyncedWithConsistentPricing(group, productSelections, tierSelections, pricingByProduct)
    ),
    [syncedMappingGroups, productSelections, tierSelections, pricingByProduct]
  );
  const ignoredGroups = useMemo(
    () => groups.filter((group) => group.ignored),
    [groups]
  );

  const loadPricing = useCallback(async (productId: string, options?: { force?: boolean }) => {
    if (!productId) return [];
    if (!options?.force && pricingCacheRef.current[productId]) {
      return pricingCacheRef.current[productId];
    }
    const res = await e123MigrationService.getProductPricing(productId);
    if (res.success && res.data) {
      const rows = res.data || [];
      pricingCacheRef.current[productId] = rows;
      setPricingByProduct((prev) => ({ ...prev, [productId]: rows }));
      return rows;
    }
    return [];
  }, []);

  const refreshProductPricing = useCallback(async (productId: string) => {
    delete pricingCacheRef.current[productId];
    return loadPricing(productId, { force: true });
  }, [loadPricing]);

  const buildTierPayload = useCallback((tier: E123ProductMappingGroup['tiers'][number]) => ({
    sourceBenefitKey: tier.sourceBenefitKey,
    sourceBenefitLabel: tier.sourceBenefitLabel,
    memberTierCounts: tier.memberTierCounts,
    inferredMemberTier: tier.inferredMemberTier,
    tierConfidence: tier.tierConfidence,
    tierBreakdownLabel: tier.tierBreakdownLabel,
    memberAgeRange: tier.memberAgeRange,
    feeHints: tier.feeHints,
    feeAmountStats: tier.feeAmountStats,
    tobaccoCounts: tier.tobaccoCounts,
    inferredTobaccoUse: tier.inferredTobaccoUse,
    tobaccoConfidence: tier.tobaccoConfidence,
    tobaccoBreakdownLabel: tier.tobaccoBreakdownLabel,
    catalogTier: tier.resolvedTier,
    catalogBenefitName: null,
    catalogUnsharedAmount: tier.feeHints?.unsharedAmount ?? null,
    catalogPricingRows: tier.catalogPricing?.rows || []
  }), []);

  const suggestPricingForGroup = useCallback(async (
    group: E123ProductMappingGroup,
    productId: string,
    preserveExisting = false
  ) => {
    if (!productId) return;
    await loadPricing(productId);
    const res = await e123MigrationService.suggestTierPricing(
      productId,
      group.tiers.map((tier) => buildTierPayload(tier))
    );
    if (!res.success || !res.data) return;

    const nextReasons: Record<string, string> = {};
    setTierSelections((prev) => {
      const next = { ...prev };
      for (const suggestion of res.data || []) {
        const tier = group.tiers.find((row) => row.sourceBenefitKey === suggestion.sourceBenefitKey);
        if (!tier) continue;
        const key = tierKey(group.sourceProductKey, tier.sourceBenefitKey);
        const existing = next[key] || prev[key];
        const productChanged = !!existing?.productId && existing.productId !== productId;

        if (!preserveExisting || productChanged || isUnsetPricingSelection(existing?.pricingId)) {
          next[key] = resolveTierPricingSelection(tier, suggestion, productId);
        } else {
          next[key] = {
            productId,
            pricingId: existing.pricingId,
            pricingIdTobacco: existing.pricingIdTobacco ?? suggestion.productPricingIdTobacco ?? undefined
          };
        }
        if (suggestion.suggestReason) nextReasons[key] = suggestion.suggestReason;
      }
      return next;
    });
    setTierSuggestReasons((prev) => ({ ...prev, ...nextReasons }));
  }, [buildTierPayload, loadPricing]);

  const notifyMappingSummary = useCallback((nextGroups: E123ProductMappingGroup[]) => {
    onMappingChangeRef.current?.(
      nextGroups.every((g) => g.allTiersMapped || g.ignored),
      {
        totalGroups: nextGroups.length,
        pendingGroups: nextGroups.filter(isPendingMappingGroup).length
      }
    );
  }, []);

  const patchGroupAfterUnsync = useCallback((sourceProductKey: string) => {
    setGroups((prev) => {
      const next = prev.map((g) => {
        if (g.sourceProductKey !== sourceProductKey) return g;
        return {
          ...g,
          allTiersMapped: false,
          ignored: false,
          tiers: g.tiers.map((tier) => ({
            ...tier,
            mapped: false,
            ignored: false,
            savedMap: null
          }))
        };
      });
      notifyMappingSummary(next);
      return next;
    });
  }, [notifyMappingSummary]);

  const patchGroupAfterSync = useCallback((
    sourceProductKey: string,
    productId: string,
    tierSels: Record<string, TierSelection>
  ) => {
    setGroups((prev) => {
      const next = prev.map((g) => {
        if (g.sourceProductKey !== sourceProductKey) return g;
        return {
          ...g,
          allTiersMapped: true,
          ignored: false,
          suggestedProductId: productId,
          tiers: g.tiers.map((tier) => {
            const key = tierKey(g.sourceProductKey, tier.sourceBenefitKey);
            const sel = tierSels[key];
            return {
              ...tier,
              mapped: true,
              ignored: false,
              savedMap: {
                productId,
                productPricingId: sel?.pricingId || null,
                productPricingIdTobacco: sel?.pricingIdTobacco || null,
                sourceProductLabel: g.sourceProductLabel
              },
              suggestedProductId: productId,
              suggestedPricingId: sel?.pricingId || null,
              suggestedPricingIdTobacco: sel?.pricingIdTobacco || null
            };
          })
        };
      });
      notifyMappingSummary(next);
      return next;
    });
  }, [notifyMappingSummary]);

  const fetchTierSelectionsForGroup = useCallback(async (
    group: E123ProductMappingGroup,
    productId: string
  ): Promise<{ selections: Record<string, TierSelection>; reasons: Record<string, string> }> => {
    delete pricingCacheRef.current[productId];
    await loadPricing(productId, { force: true });

    const res = await e123MigrationService.suggestTierPricing(
      productId,
      group.tiers.map((tier) => buildTierPayload(tier))
    );

    const selections: Record<string, TierSelection> = {};
    const reasons: Record<string, string> = {};

    for (const suggestion of res.data || []) {
      const tier = group.tiers.find((row) => row.sourceBenefitKey === suggestion.sourceBenefitKey);
      if (!tier) continue;
      const key = tierKey(group.sourceProductKey, tier.sourceBenefitKey);
      selections[key] = resolveTierPricingSelection(tier, suggestion, productId);
      if (suggestion.suggestReason) reasons[key] = suggestion.suggestReason;
    }

    for (const tier of group.tiers) {
      const key = tierKey(group.sourceProductKey, tier.sourceBenefitKey);
      if (selections[key]) continue;
      selections[key] = resolveTierPricingSelection(
        tier,
        { productPricingId: null, premiumMatch: null },
        productId
      );
    }

    return { selections, reasons };
  }, [buildTierPayload, loadPricing]);

  const buildBulkMappingsForGroup = useCallback((
    group: E123ProductMappingGroup,
    productId: string,
    tierSels: Record<string, TierSelection>
  ) => group.tiers.map((tier) => {
    const key = tierKey(group.sourceProductKey, tier.sourceBenefitKey);
    const selection = tierSels[key];
    return {
      sourceProductKey: group.sourceProductKey,
      sourceBenefitKey: tier.sourceBenefitKey,
      sourceProductLabel: group.sourceProductLabel,
      productId,
      productPricingId: toSavedPricingId(selection?.pricingId),
      productPricingIdTobacco: toSavedPricingId(selection?.pricingIdTobacco)
    };
  }).filter((mapping) => mapping.productId), []);

  const autoSyncGroupAfterProductCreate = useCallback(async (
    group: E123ProductMappingGroup,
    productId: string,
    productData: ProductFormData
  ) => {
    setSavingKey(group.sourceProductKey);
    setError(null);
    try {
      const { selections, reasons } = await fetchTierSelectionsForGroup(group, productId);
      setProductSelections((prev) => ({ ...prev, [group.sourceProductKey]: productId }));
      setTierSelections((prev) => ({ ...prev, ...selections }));
      if (Object.keys(reasons).length > 0) {
        setTierSuggestReasons((prev) => ({ ...prev, ...reasons }));
      }

      const mappings = buildBulkMappingsForGroup(group, productId, selections);
      const missingPricing = group.tiers.some((tier) => {
        if (!tierRequiresPricingSelection(tier)) return false;
        const key = tierKey(group.sourceProductKey, tier.sourceBenefitKey);
        return isUnsetPricingSelection(selections[key]?.pricingId);
      });
      if (missingPricing) {
        setError(
          `Product "${productData.name}" was created, but some E123 tiers could not auto-match AB365 pricing for "${group.sourceProductLabel}". Pick pricing tiers and save mapping.`
        );
        return;
      }

      await e123MigrationService.saveProductMapsBulk(instanceId, mappings);
      clearProductMappingDraft(draftScopeKey(batchId, instanceId));
      patchGroupAfterSync(group.sourceProductKey, productId, selections);
      setShowSyncedConsistentMappings(true);

      setSubscribedProducts((prev) => {
        if (prev.some((row) => row.productId === productId)) return prev;
        const vendorName = prev.find((row) => row.vendorId === productData.vendorId)?.vendorName || '';
        const isBundle = productData.productType === 'Bundle' || !!(productData as ProductFormData & { isBundle?: boolean }).isBundle;
        return [
          ...prev,
          {
            productId,
            name: productData.name || 'New product',
            productType: productData.productType,
            isBundle,
            productKind: isBundle ? 'bundle' : 'product',
            salesType: productData.salesType || '',
            salesTypeLabel: productData.salesType || '',
            vendorId: productData.vendorId,
            vendorName,
            catalogSource: 'owned'
          }
        ];
      });
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : `Product was created but E123 mapping for "${group.sourceProductLabel}" could not be saved automatically.`
      );
    } finally {
      setSavingKey(null);
    }
  }, [
    batchId,
    instanceId,
    fetchTierSelectionsForGroup,
    buildBulkMappingsForGroup,
    patchGroupAfterSync
  ]);

  const hydrateWorkspace = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setLoading(true);
    }
    setError(null);
    if (!options?.silent) {
      pricingCacheRef.current = {};
      setPricingByProduct({});
    }
    const scopeKey = draftScopeKey(batchId, instanceId);
    try {
      const res = batchId
        ? await e123MigrationService.getProductMappingWorkspace(batchId, tenantId)
        : await e123MigrationService.getTenantProductMappingWorkspace(tenantId, batchId, instanceId);
      if (!res.success || !res.data) throw new Error('Failed to load product mapping workspace');

      const nextGroups = res.data.e123ProductGroups || [];
      const nextProducts = res.data.subscribedProducts || [];
      setGroups(nextGroups);
      setDuplicateLabelGroups(res.data.duplicateLabelGroups || 0);
      setInstanceTenantCount(res.data.instanceTenantCount || 0);
      setSubscribedProducts(nextProducts);

      const nextProductSelections: Record<string, string> = {};
      const nextTierSelections: Record<string, TierSelection> = {};
      const pricingIds = new Set<string>();

      const nextTierSuggestReasons: Record<string, string> = {};
      for (const group of nextGroups) {
        const productId = group.suggestedProductId
          || group.tiers.find((tier) => tier.savedMap?.productId)?.savedMap?.productId
          || '';
        if (productId) {
          nextProductSelections[group.sourceProductKey] = productId;
          pricingIds.add(productId);
        }

        for (const tier of group.tiers) {
          const key = tierKey(group.sourceProductKey, tier.sourceBenefitKey);
          const selectedProductId = tier.savedMap?.productId || productId || tier.suggestedProductId || '';
          const selectedPricingId = tier.savedMap?.productPricingId || tier.suggestedPricingId || '';
          const selectedPricingIdTobacco = tier.savedMap?.productPricingIdTobacco || tier.suggestedPricingIdTobacco || '';
          const pricingId = selectedPricingId
            || (tier.memberCount <= 0 ? PRICING_TIER_NONE : '')
            || (tier.savedMap?.productId && !tier.savedMap?.productPricingId ? PRICING_TIER_NONE : '');
          nextTierSelections[key] = {
            productId: selectedProductId,
            pricingId,
            pricingIdTobacco: selectedPricingIdTobacco
              || (pricingId === PRICING_TIER_NONE ? PRICING_TIER_NONE : undefined)
          };
          if (tier.suggestReason) nextTierSuggestReasons[key] = tier.suggestReason;
          if (selectedProductId) pricingIds.add(selectedProductId);
        }
      }

      const draft = loadProductMappingDraft(scopeKey);
      if (draft) {
        for (const [key, productId] of Object.entries(draft.productSelections)) {
          if (productId) nextProductSelections[key] = productId;
        }
        for (const [key, selection] of Object.entries(draft.tierSelections)) {
          if (selection?.productId) {
            nextTierSelections[key] = selection;
            pricingIds.add(selection.productId);
          }
        }
        if (draft.syncedBundleProductIds?.length) {
          setSyncedBundleProductIds(draft.syncedBundleProductIds);
        }
      }

      setProductSelections(nextProductSelections);
      setTierSelections(nextTierSelections);
      setTierSuggestReasons(nextTierSuggestReasons);
      await Promise.all([...pricingIds].map((id) => loadPricing(id)));

      await Promise.all(nextGroups.map(async (group) => {
        const productId = nextProductSelections[group.sourceProductKey];
        if (!productId || group.ignored) return;
        const productPricing = pricingCacheRef.current[productId] || [];
        const pairedTobacco = productHasPairedTobaccoRows(productPricing);
        const needsSuggest = group.tiers.some((tier) => {
          const key = tierKey(group.sourceProductKey, tier.sourceBenefitKey);
          const sel = nextTierSelections[key];
          const missingNonTob = isUnsetPricingSelection(sel?.pricingId)
            && isUnsetPricingSelection(tier.savedMap?.productPricingId);
          const missingTob = pairedTobacco
            && isUnsetPricingSelection(sel?.pricingIdTobacco)
            && isUnsetPricingSelection(tier.savedMap?.productPricingIdTobacco);
          return missingNonTob || missingTob;
        });
        if (needsSuggest) {
          await suggestPricingForGroup(group, productId, true);
        }
      }));

      onMappingChangeRef.current?.(!!res.data.allMapped, {
        totalGroups: res.data.e123ProductGroups?.length || 0,
        pendingGroups: (res.data.e123ProductGroups || []).filter(isPendingMappingGroup).length
      });
    } catch (err: unknown) {
      setError(errorMessage(err, 'Failed to load product mappings'));
    } finally {
      if (!options?.silent) {
        setLoading(false);
      }
    }
  }, [batchId, instanceId, tenantId, loadPricing, suggestPricingForGroup]);

  useEffect(() => {
    hydrateWorkspace();
  }, [hydrateWorkspace]);

  useEffect(() => {
    if (loading) return;
    saveProductMappingDraft(draftScopeKey(batchId, instanceId), {
      productSelections,
      tierSelections,
      syncedBundleProductIds
    });
  }, [batchId, instanceId, loading, productSelections, tierSelections, syncedBundleProductIds]);

  const syncedBundleIdSet = useMemo(
    () => new Set(syncedBundleProductIds),
    [syncedBundleProductIds]
  );

  const registerSyncedBundle = useCallback((productId: string) => {
    if (!productId) return;
    setSyncedBundleProductIds((prev) => (
      prev.includes(productId) ? prev : [...prev, productId]
    ));
  }, []);

  const productDropdownOptions = useMemo(
    () => buildAb365ProductDropdownOptions(subscribedProducts, syncedBundleIdSet),
    [subscribedProducts, syncedBundleIdSet]
  );

  const productDropdownSectionLabels = useMemo(
    () => ({
      'synced-bundles': 'Synced bundles',
      catalog: 'All products'
    }),
    []
  );

  const e123ProductIdByProductId = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of groups) {
      const productId = resolveGroupProductId(group, productSelections);
      if (productId) {
        map.set(productId, group.sourceProductKey);
      }
    }
    return map;
  }, [groups, productSelections]);

  const bundleProductCatalog = useMemo(
    () => subscribedProducts
      .filter((product) => !product.isBundle)
      .map((product) => {
        const e123ProductId = e123ProductIdByProductId.get(product.productId);
        return {
          ProductId: product.productId,
          Name: product.name,
          ProductType: product.productType,
          Description: '',
          VendorName: product.vendorName,
          IsBundle: false,
          SalesType: product.salesType,
          ProductImageUrl: product.productImageUrl || undefined,
          ProductLogoUrl: product.productLogoUrl || undefined,
          ...(e123ProductId ? { E123ProductId: e123ProductId } : {})
        };
      }),
    [subscribedProducts, e123ProductIdByProductId]
  );

  const catalogSummary = useMemo(() => {
    const subscribed = subscribedProducts.filter((p) => p.catalogSource === 'subscribed' || p.catalogSource === 'both').length;
    const owned = subscribedProducts.filter((p) => p.catalogSource === 'owned' || p.catalogSource === 'both').length;
    return { subscribed, owned, total: subscribedProducts.length };
  }, [subscribedProducts]);

  const buildPricingOptions = (productId: string, tobaccoOnly?: 'yes' | 'no') => {
    let rows = pricingByProduct[productId] || [];
    if (tobaccoOnly === 'yes') rows = rows.filter((row) => row.tobaccoStatus === 'Yes');
    else if (tobaccoOnly === 'no') rows = rows.filter((row) => row.tobaccoStatus !== 'Yes');
    return [
      buildNonePricingOption(),
      ...rows.map((row) => ({
        id: row.productPricingId,
        value: row.productPricingId,
        label: row.displayLabel,
        sublabel: [
          row.tierType ? `Tier ${row.tierType}` : null,
          row.displayRate != null ? `$${row.displayRate.toFixed(2)}/mo` : row.totalRate != null ? `$${row.totalRate.toFixed(2)}/mo` : null,
          row.configValue1 ? `UA ${row.configValue1}` : null,
          row.tobaccoStatus === 'Yes' ? 'Tobacco surcharge' : null
        ].filter(Boolean).join(' · ') || undefined
      }))
    ];
  };

  const onProductChange = async (sourceProductKey: string, productId: string) => {
    setProductSelections((prev) => ({ ...prev, [sourceProductKey]: productId }));
    const group = groups.find((row) => row.sourceProductKey === sourceProductKey);
    if (!group) return;
    await suggestPricingForGroup(group, productId, false);
  };

  const saveGroupMappings = async (group: E123ProductMappingGroup) => {
    const productId = productSelections[group.sourceProductKey];
    if (!productId) return;

    setSavingKey(group.sourceProductKey);
    setError(null);
    try {
      const mappings = group.tiers.map((tier) => {
        const key = tierKey(group.sourceProductKey, tier.sourceBenefitKey);
        const selection = tierSelections[key];
        return {
          sourceProductKey: group.sourceProductKey,
          sourceBenefitKey: tier.sourceBenefitKey,
          sourceProductLabel: group.sourceProductLabel,
          productId,
          productPricingId: toSavedPricingId(selection?.pricingId ?? tier.suggestedPricingId),
          productPricingIdTobacco: toSavedPricingId(
            selection?.pricingIdTobacco ?? tier.suggestedPricingIdTobacco
          )
        };
      }).filter((mapping) => mapping.productId);

      const missingPricing = group.tiers.some((tier) => {
        if (!tierRequiresPricingSelection(tier)) return false;
        const key = tierKey(group.sourceProductKey, tier.sourceBenefitKey);
        const selection = tierSelections[key];
        return isUnsetPricingSelection(selection?.pricingId);
      });
      if (missingPricing) {
        setError(`Select an AB365 pricing tier (or None) for every E123 tier with members under "${group.sourceProductLabel}".`);
        return;
      }

      await e123MigrationService.saveProductMapsBulk(instanceId, mappings);
      clearProductMappingDraft(draftScopeKey(batchId, instanceId));
      await hydrateWorkspace();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save product mappings');
    } finally {
      setSavingKey(null);
    }
  };

  const ignoreGroupMappings = async (group: E123ProductMappingGroup) => {
    setSavingKey(group.sourceProductKey);
    setError(null);
    try {
      await e123MigrationService.saveProductMapsBulk(
        instanceId,
        group.tiers.map((tier) => ({
          sourceProductKey: group.sourceProductKey,
          sourceBenefitKey: tier.sourceBenefitKey,
          sourceProductLabel: group.sourceProductLabel,
          ignoreImport: true
        }))
      );
      clearProductMappingDraft(draftScopeKey(batchId, instanceId));
      setShowIgnoredProducts(true);
      await hydrateWorkspace();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to ignore product');
    } finally {
      setSavingKey(null);
    }
  };

  const restoreGroupMappings = async (group: E123ProductMappingGroup) => {
    setSavingKey(group.sourceProductKey);
    setError(null);
    try {
      await e123MigrationService.unignoreProductMap(instanceId, group.sourceProductKey);
      clearProductMappingDraft(draftScopeKey(batchId, instanceId));
      await hydrateWorkspace();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to restore product');
    } finally {
      setSavingKey(null);
    }
  };

  const unsyncGroupMapping = async (group: E123ProductMappingGroup) => {
    setSavingKey(group.sourceProductKey);
    setError(null);
    try {
      await e123MigrationService.unsyncProductMap(instanceId, group.sourceProductKey);
      setProductSelections((prev) => {
        const next = { ...prev };
        delete next[group.sourceProductKey];
        return next;
      });
      setTierSelections((prev) => {
        const next = { ...prev };
        for (const tier of group.tiers) {
          delete next[tierKey(group.sourceProductKey, tier.sourceBenefitKey)];
        }
        return next;
      });
      setTierSuggestReasons((prev) => {
        const next = { ...prev };
        for (const tier of group.tiers) {
          delete next[tierKey(group.sourceProductKey, tier.sourceBenefitKey)];
        }
        return next;
      });
      clearProductMappingDraft(draftScopeKey(batchId, instanceId));
      patchGroupAfterUnsync(group.sourceProductKey);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to unsync product');
    } finally {
      setSavingKey(null);
    }
  };

  const openWizardWithDraft = async (
    group: E123ProductMappingGroup,
    vendorBucketOverrides?: Record<string, VendorBucketChoice>,
    resyncProductId?: string | null,
    useTobaccoPricing?: boolean,
    templateProductId?: string | null
  ) => {
    if (resyncProductId) {
      const [draftRes, productRes] = await Promise.all([
        e123MigrationService.getE123ProductWizardDraft(
          tenantId,
          group.sourceProductKey,
          batchId,
          vendorBucketOverrides,
          useTobaccoPricing
        ),
        apiService.get<{ product?: Record<string, unknown>; data?: Record<string, unknown> }>(
          `/api/products/${resyncProductId}`
        )
      ]);
      if (!draftRes.success || !draftRes.data?.formData) {
        throw new Error(draftRes.message || 'Failed to build product draft from E123 data');
      }
      const rawProduct = productRes.product || productRes.data || productRes;
      setCreateWizardDraft(null);
      setCreateWizardMeta(draftRes.data.meta);
      setE123ResyncDraft(draftRes.data.formData as unknown as ProductFormData);
      setWizardResyncProductId(resyncProductId);
      setCreateWizardForKey(group.sourceProductKey);
      setCreateWizardOpen(true);
      if (!rawProduct) {
        throw new Error('Existing AB365 product could not be loaded');
      }
      return;
    }

    const res = await e123MigrationService.getE123ProductWizardDraft(
      tenantId,
      group.sourceProductKey,
      batchId,
      vendorBucketOverrides,
      useTobaccoPricing,
      templateProductId
    );
    if (!res.success || !res.data?.formData) {
      throw new Error(res.message || 'Failed to build product draft from E123 data');
    }
    setCreateWizardDraft(res.data.formData as unknown as ProductFormData);
    setCreateWizardMeta(res.data.meta);
    setCreateWizardForKey(group.sourceProductKey);
    setWizardResyncProductId(null);
    setE123ResyncDraft(null);
    setCreateWizardOpen(true);
  };

  const openCreateProductWizard = async (group: E123ProductMappingGroup) => {
    setDraftLoadingKey(group.sourceProductKey);
    setError(null);
    setWizardResyncProductId(null);
    setE123ResyncDraft(null);
    try {
      const previewRes = await e123MigrationService.getE123VendorRoutingPreview(
        tenantId,
        group.sourceProductKey,
        batchId
      );
      if (previewRes.success && previewRes.data?.hasRouting) {
        setVendorRoutingPreview(previewRes.data);
        setPendingWizardGroup(group);
        setPendingResyncProductId(null);
        setVendorRoutingOpen(true);
        return;
      }
      setTobaccoPromptUseTobacco(recommendedUseTobaccoPricing(group));
      setPendingWizardGroup(group);
      setPendingResyncProductId(null);
      setPendingTobaccoVendorOverrides(undefined);
      setTobaccoPromptOpen(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to prepare product wizard');
    } finally {
      setDraftLoadingKey(null);
    }
  };

  const openResyncProductWizard = async (
    group: E123ProductMappingGroup,
    existingProductId: string
  ) => {
    setDraftLoadingKey(group.sourceProductKey);
    setError(null);
    try {
      const previewRes = await e123MigrationService.getE123VendorRoutingPreview(
        tenantId,
        group.sourceProductKey,
        batchId
      );
      if (previewRes.success && previewRes.data?.hasRouting) {
        setVendorRoutingPreview(previewRes.data);
        setPendingWizardGroup(group);
        setPendingResyncProductId(existingProductId);
        setVendorRoutingOpen(true);
        return;
      }
      await openWizardWithDraft(group, undefined, existingProductId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to prepare product resync');
      setWizardResyncProductId(null);
      setE123ResyncDraft(null);
    } finally {
      setDraftLoadingKey(null);
    }
  };

  const closeVendorRoutingModalOnly = () => {
    setVendorRoutingOpen(false);
    setVendorRoutingPreview(null);
  };

  const cancelVendorRoutingModal = () => {
    closeVendorRoutingModalOnly();
    setPendingWizardGroup(null);
    setPendingResyncProductId(null);
    setPendingTobaccoVendorOverrides(undefined);
  };

  const handleVendorRoutingConfirm = async (overrides: Record<string, VendorBucketChoice>) => {
    if (!pendingWizardGroup) {
      cancelVendorRoutingModal();
      return;
    }
    if (pendingResyncProductId) {
      setVendorRoutingLoading(true);
      setError(null);
      try {
        await openWizardWithDraft(pendingWizardGroup, overrides, pendingResyncProductId);
        closeVendorRoutingModalOnly();
        setPendingWizardGroup(null);
        setPendingResyncProductId(null);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to prepare product wizard');
      } finally {
        setVendorRoutingLoading(false);
      }
      return;
    }
    setPendingTobaccoVendorOverrides(overrides);
    setTobaccoPromptUseTobacco(recommendedUseTobaccoPricing(pendingWizardGroup));
    closeVendorRoutingModalOnly();
    setTobaccoPromptOpen(true);
  };

  const closeTobaccoPrompt = () => {
    setTobaccoPromptOpen(false);
    if (!copyTemplateOpen) {
      setPendingWizardGroup(null);
      setPendingResyncProductId(null);
      setPendingTobaccoVendorOverrides(undefined);
    }
  };

  const closeCopyTemplateModal = () => {
    setCopyTemplateOpen(false);
    setCopyTemplateSuggestedId(undefined);
    setPendingWizardGroup(null);
    setPendingResyncProductId(null);
    setPendingTobaccoVendorOverrides(undefined);
  };

  const confirmTobaccoPrompt = async () => {
    if (!pendingWizardGroup) {
      closeTobaccoPrompt();
      return;
    }
    if (pendingResyncProductId) {
      setDraftLoadingKey(pendingWizardGroup.sourceProductKey);
      setError(null);
      try {
        await openWizardWithDraft(
          pendingWizardGroup,
          pendingTobaccoVendorOverrides,
          pendingResyncProductId,
          tobaccoPromptUseTobacco
        );
        closeTobaccoPrompt();
        setPendingWizardGroup(null);
        setPendingResyncProductId(null);
        setPendingTobaccoVendorOverrides(undefined);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to prepare product wizard');
      } finally {
        setDraftLoadingKey(null);
      }
      return;
    }
    setCopyTemplateSuggestedId(
      suggestTemplateProductId(
        pendingWizardGroup.sourceProductLabel,
        subscribedProducts,
        productSelections[pendingWizardGroup.sourceProductKey]
          || pendingWizardGroup.suggestedProductId
          || pendingWizardGroup.tiers.find((tier) => tier.savedMap?.productId)?.savedMap?.productId
      )
    );
    setTobaccoPromptOpen(false);
    setCopyTemplateOpen(true);
  };

  const confirmCopyTemplate = async (templateProductId: string | null) => {
    if (!pendingWizardGroup) {
      closeCopyTemplateModal();
      return;
    }
    setCopyTemplateLoading(true);
    setError(null);
    try {
      await openWizardWithDraft(
        pendingWizardGroup,
        pendingTobaccoVendorOverrides,
        null,
        tobaccoPromptUseTobacco,
        templateProductId
      );
      closeCopyTemplateModal();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to prepare product wizard');
    } finally {
      setCopyTemplateLoading(false);
    }
  };

  useEffect(() => {
    if (!resyncTarget || loading) return;
    const group = groups.find((g) => g.sourceProductKey === resyncTarget.sourceProductKey);
    if (!group) return;
    void openResyncProductWizard(group, resyncTarget.productId).finally(() => {
      onResyncTargetHandled?.();
    });
  }, [resyncTarget, loading, groups]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeCreateProductWizard = () => {
    setCreateWizardOpen(false);
    setCreateWizardDraft(null);
    setCreateWizardMeta(null);
    setCreateWizardForKey(null);
    setWizardResyncProductId(null);
    setE123ResyncDraft(null);
  };

  const closeCreateBundleWizard = () => {
    setCreateBundleOpen(false);
    setCreateBundleForKey(null);
    setCreateBundlePrefill(null);
  };

  const openCreateBundleWizard = (group: E123ProductMappingGroup) => {
    setCreateBundleForKey(group.sourceProductKey);
    setCreateBundlePrefill({ Name: group.sourceProductLabel });
    setCreateBundleOpen(true);
  };

  const handleSaveNewBundle = async (bundleData: BundleFormData) => {
    const sourceKey = createBundleForKey;
    const group = sourceKey ? groups.find((g) => g.sourceProductKey === sourceKey) : null;

    let productLogoUrl = bundleData.productLogoUrl;
    if (!productLogoUrl && bundleData.productLogoFile) {
      const formData = new FormData();
      formData.append('file', bundleData.productLogoFile);
      formData.append('type', 'logos');
      formData.append('entityId', sourceKey ? `e123-migration-bundle-${sourceKey}` : 'e123-migration-bundle');
      formData.append('category', 'product');
      const uploadResponse = await apiService.post<{ success: boolean; url?: string; data?: { url?: string } | { url?: string }[] }>(
        '/api/uploads',
        formData,
        { headers: { 'Content-Type': 'multipart/form-data' } }
      );
      if (uploadResponse.success) {
        productLogoUrl = uploadResponse.url
          || (Array.isArray(uploadResponse.data) ? uploadResponse.data[0]?.url : uploadResponse.data?.url);
      }
    }

    const payload = {
      name: bundleData.name,
      description: bundleData.description,
      productType: 'Bundle',
      isBundle: true,
      productOwnerId: tenantId,
      isVendorPricing: false,
      vendorCommission: 0,
      salesType: bundleData.salesType || 'Both',
      minAge: 18,
      maxAge: 65,
      allowedStates: [],
      requiresTobaccoInfo: false,
      effectiveDateLogic: 'FirstOfMonth',
      maxEffectiveDateDays: 60,
      terminationLogic: '',
      requiredLicenses: [],
      bundleProducts: (bundleData.bundleProducts || []).map((bp, index) => ({
        productId: bp.productId,
        isRequired: bp.isRequired ?? true,
        sortOrder: bp.sortOrder ?? index + 1,
        hidePricing: !!bp.hidePricing,
        linkedToProductId: bp.hidePricing ? bp.linkedToProductId || null : null,
        allowedConfigOptions: bp.allowedConfigOptions && Object.keys(bp.allowedConfigOptions).length > 0
          ? bp.allowedConfigOptions
          : undefined
      })),
      isPublic: bundleData.isPublic || false,
      isHidden: bundleData.isHidden || false,
      ...(productLogoUrl ? { productLogoUrl, productImageUrl: productLogoUrl } : {})
    };

    const res = await apiService.post<{ success: boolean; productId?: string; message?: string }>(
      '/api/products',
      payload
    );
    if (!res.success) {
      throw new Error(res.message || 'Failed to create bundle');
    }
    const productId = res.productId;
    if (!productId) {
      throw new Error('Bundle created but no product id was returned');
    }

    registerSyncedBundle(productId);
    closeCreateBundleWizard();

    if (group && sourceKey) {
      await autoSyncGroupAfterProductCreate(group, productId, {
        name: bundleData.name,
        productType: 'Bundle',
        salesType: bundleData.salesType || 'Both',
        vendorId: '',
        isBundle: true
      } as unknown as ProductFormData);
      await hydrateWorkspace({ silent: true });
      return;
    }

    if (productId && sourceKey) {
      setProductSelections((prev) => ({ ...prev, [sourceKey]: productId }));
    }
    await hydrateWorkspace({ silent: true });
  };

  const buildProductSavePayload = (
    productData: ProductFormData,
    uploaded?: Awaited<ReturnType<typeof uploadProductWizardAssets>>
  ) => {
    const mergedData = uploaded
      ? {
        ...productData,
        ...(uploaded.productImageUrl ? { productImageUrl: uploaded.productImageUrl } : {}),
        ...(uploaded.productLogoUrl ? { productLogoUrl: uploaded.productLogoUrl } : {}),
        ...(uploaded.productDocumentUrl ? { productDocumentUrl: uploaded.productDocumentUrl } : {}),
        ...(uploaded.productDocuments ? { productDocuments: uploaded.productDocuments } : {}),
        ...(uploaded.idCardData ? { idCardData: uploaded.idCardData } : {}),
        ...(uploaded.planDetailsData ? { planDetailsData: uploaded.planDetailsData } : {})
      }
      : productData;

    const productImageOrLogoUrl = mergedData.productImageUrl || mergedData.productLogoUrl;
    const {
      productImageFile,
      productLogoFile,
      productDocumentFile,
      productDocumentFiles,
      idCardLogoFile,
      planDetailsHeaderLogoFile,
      idCardBackImageFiles,
      ...rest
    } = mergedData as ProductFormData & Record<string, unknown>;

    return {
      ...rest,
      productOwnerId: mergedData.productOwnerId || tenantId,
      isPublic: mergedData.isPublic ?? false,
      isHidden: mergedData.isHidden ?? false,
      isSSNRequired: mergedData.isSSNRequired ?? false,
      premiumReportingCategory:
        mergedData.premiumReportingCategory === 'NonProfit' ? 'NonProfit' : 'ForProfit',
      ...(productImageOrLogoUrl && !mergedData.productImageFile && {
        productImageUrl: productImageOrLogoUrl,
        productLogoUrl: productImageOrLogoUrl
      }),
      ...(mergedData.productDocumentUrl && !mergedData.productDocumentFile && {
        productDocumentUrl: mergedData.productDocumentUrl
      }),
      productDocuments: (mergedData.productDocuments && mergedData.productDocuments.length > 0)
        ? mergedData.productDocuments
        : (mergedData.productDocumentUrl
          ? [{ documentUrl: mergedData.productDocumentUrl, displayName: 'Document', sortOrder: 0 }]
          : [])
    };
  };

  const handleSaveNewProduct = async (productData: ProductFormData) => {
    const sourceKey = createWizardForKey;
    const group = sourceKey ? groups.find((g) => g.sourceProductKey === sourceKey) : null;

    const uploaded = await uploadProductWizardAssets(productData, {
      entityId: sourceKey ? `e123-migration-${sourceKey}` : 'e123-migration'
    });
    const payload = buildProductSavePayload(productData, uploaded);
    const res = await apiService.post<{ success: boolean; productId?: string; message?: string }>(
      '/api/products',
      payload
    );
    if (!res.success) {
      throw new Error(res.message || 'Failed to create product');
    }
    if (uploaded.uploadFailures.length > 0) {
      setError(
        `Product created, but ${uploaded.uploadFailures.length} file(s) failed to upload: ${uploaded.uploadFailures.join(', ')}. Edit the product to retry.`
      );
    }
    const productId = res.productId;
    if (!productId) {
      throw new Error('Product created but no product id was returned');
    }

    closeCreateProductWizard();

    if (group && sourceKey) {
      await autoSyncGroupAfterProductCreate(group, productId, productData);
      await hydrateWorkspace({ silent: true });
      return;
    }

    if (productId && sourceKey) {
      setProductSelections((prev) => ({ ...prev, [sourceKey]: productId }));
      await refreshProductPricing(productId);
    }
    await hydrateWorkspace({ silent: true });
  };

  const handleResyncProduct = async (productData: ProductFormData) => {
    if (!wizardResyncProductId) {
      throw new Error('No product selected for resync');
    }
    const uploaded = await uploadProductWizardAssets(productData, {
      entityId: wizardResyncProductId
    });
    const payload = buildProductSavePayload(productData, uploaded);
    const res = await apiService.put<{ success: boolean; message?: string }>(
      `/api/products/${wizardResyncProductId}`,
      payload
    );
    if (!res.success) {
      throw new Error(res.message || 'Failed to update product');
    }
    if (uploaded.uploadFailures.length > 0) {
      setError(
        `Product updated, but ${uploaded.uploadFailures.length} file(s) failed to upload: ${uploaded.uploadFailures.join(', ')}. Edit the product to retry.`
      );
    }
    if (createWizardForKey) {
      setProductSelections((prev) => ({ ...prev, [createWizardForKey]: wizardResyncProductId }));
      await refreshProductPricing(wizardResyncProductId);
    }
    await hydrateWorkspace();
    closeCreateProductWizard();
  };

  function renderProductGroup(group: E123ProductMappingGroup) {
    const selectedProductId = productSelections[group.sourceProductKey] || '';
    const savedProductId = getSavedProductId(group);
    const groupComplete = group.allTiersMapped && !group.ignored;
    const groupSynced = groupHasSavedPairing(group) && !group.ignored;
    const groupIgnored = !!group.ignored;
    const displayProductId = selectedProductId || savedProductId;
    const displayProductName = displayProductId
      ? subscribedProducts.find((p) => p.productId === displayProductId)?.name
      : null;
    const resolvedProductId = resolveGroupProductId(group, productSelections);
    const allTiersPerfectMatch = !groupIgnored
      && !!resolvedProductId
      && groupAllTiersPerfectMatch(group, resolvedProductId, tierSelections, pricingByProduct);
    const selectedAb365Product = selectedProductId
      ? subscribedProducts.find((product) => product.productId === selectedProductId)
      : null;
    return (
      <section key={group.sourceProductKey} className={`border rounded-lg overflow-hidden ${groupIgnored ? 'border-amber-200 bg-amber-50/30' : 'border-gray-200'}`}>
        <header className={`px-4 py-3 border-b ${groupIgnored ? 'bg-amber-50 border-amber-200' : 'bg-gray-50 border-gray-200'}`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">E123 Product</div>
              <h3 className="text-base font-semibold text-gray-900 flex items-center gap-2 flex-wrap">
                {group.sourceProductLabel}
                {group.salesTypeLabel ? <SalesTypeBadge label={group.salesTypeLabel} /> : null}
                {allTiersPerfectMatch ? (
                  <PremiumMatchBadge match={{ status: 'exact' }} />
                ) : null}
              </h3>
              <p className="text-xs text-gray-500 mt-1">
                pdid {group.sourceProductKey} · {group.memberCount.toLocaleString()} member rows · {group.tiers.length} tier{group.tiers.length === 1 ? '' : 's'}
                {group.salesTypeLabel ? (
                  <span className="text-gray-600"> · E123 {group.salesTypeLabel.toLowerCase()}</span>
                ) : null}
                {displayProductName && savedProductId ? (
                  <span className="text-green-700 font-medium"> · → {displayProductName}</span>
                ) : displayProductName ? (
                  <span className="text-indigo-700"> · suggested → {displayProductName}</span>
                ) : null}
              </p>
              {group.catalogStatus?.catalogStatusLabel ? (
                <p className={`text-xs mt-1 font-medium ${group.catalogStatus.inAgentCatalog ? 'text-blue-700' : 'text-amber-800'}`}>
                  {group.catalogStatus.catalogStatusLabel}
                  {group.catalogStatus.catalogCategory ? ` · ${group.catalogStatus.catalogCategory}` : ''}
                </p>
              ) : null}
              {group.enrollmentStats?.enrollmentSummaryLabel ? (
                <p className="text-xs text-gray-600 mt-1">
                  {group.enrollmentStats.enrollmentSummaryLabel}
                </p>
              ) : null}
              {(group.duplicateLabelCount || 0) > 1 ? (
                <p className="text-xs text-amber-800 mt-1">
                  {group.duplicateLabelCount} E123 products share this name — map pdid {group.sourceProductKey} individually.
                </p>
              ) : null}
            </div>
            {groupIgnored ? (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-800 bg-amber-100 border border-amber-200 rounded-full px-2 py-1">
                <Ban className="h-3.5 w-3.5" />
                Ignored
              </span>
            ) : groupComplete ? (
              <div className="flex items-center gap-2 shrink-0">
                {savedProductId ? (
                  <button
                    type="button"
                    disabled={draftLoadingKey === group.sourceProductKey}
                    onClick={() => openResyncProductWizard(group, savedProductId)}
                    className="inline-flex items-center gap-1 text-xs font-medium text-violet-700 bg-violet-50 border border-violet-200 rounded-full px-2 py-1 hover:bg-violet-100 disabled:opacity-50"
                    title="Refresh wizard with latest E123 data and update the linked AB365 product"
                  >
                    {draftLoadingKey === group.sourceProductKey ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    Resync
                  </button>
                ) : null}
                <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-1">
                  <CheckCircle className="h-3.5 w-3.5" />
                  Saved
                </span>
              </div>
            ) : groupSynced ? (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded-full px-2 py-1 shrink-0">
                <AlertTriangle className="h-3.5 w-3.5" />
                Synced — review tiers
              </span>
            ) : null}
          </div>
        </header>

        <div className="p-4 space-y-4">
          {groupIgnored ? (
            <>
              <p className="text-sm text-amber-900">
                This E123 product will be skipped during import — no <code className="text-xs">oe.Enrollments</code> rows will be created for it.
              </p>
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={savingKey === group.sourceProductKey}
                  onClick={() => restoreGroupMappings(group)}
                  className="inline-flex items-center px-3 py-1.5 rounded-lg border border-amber-300 text-amber-900 text-sm hover:bg-amber-100 disabled:opacity-50"
                >
                  {savingKey === group.sourceProductKey ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RotateCcw className="h-4 w-4 mr-2" />}
                  Restore for mapping
                </button>
              </div>
            </>
          ) : (
            <>
              <div>
                <div className="flex items-center justify-between gap-3 mb-1">
                  <label className="block text-sm font-medium text-gray-700">AB365 Product</label>
                  <div className="flex items-center gap-2 shrink-0">
                    {(savedProductId || selectedProductId) ? (
                      <button
                        type="button"
                        disabled={savingKey === group.sourceProductKey || draftLoadingKey === group.sourceProductKey}
                        onClick={() => unsyncGroupMapping(group)}
                        className="inline-flex items-center px-2.5 py-1 rounded-lg border border-gray-300 text-gray-700 text-xs font-medium hover:bg-gray-50 disabled:opacity-50"
                        title={savedProductId
                          ? 'Clear the saved pairing so you can create a new product or pick a different match'
                          : 'Clear the current selection'}
                      >
                        {savingKey === group.sourceProductKey ? (
                          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                        ) : (
                          <Unlink className="h-3.5 w-3.5 mr-1.5" />
                        )}
                        Unsync
                      </button>
                    ) : null}
                    {savedProductId ? (
                      <button
                        type="button"
                        disabled={draftLoadingKey === group.sourceProductKey}
                        onClick={() => openResyncProductWizard(group, savedProductId)}
                        className="inline-flex items-center px-2.5 py-1 rounded-lg border border-violet-200 text-violet-800 text-xs font-medium hover:bg-violet-50 disabled:opacity-50"
                        title="Refresh wizard with latest E123 data and update the linked AB365 product"
                      >
                        {draftLoadingKey === group.sourceProductKey ? (
                          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                        )}
                        Resync product
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          disabled={draftLoadingKey === group.sourceProductKey}
                          onClick={() => openCreateBundleWizard(group)}
                          className="inline-flex items-center px-2.5 py-1 rounded-lg border border-violet-200 text-violet-800 text-xs font-medium hover:bg-violet-50 disabled:opacity-50"
                        >
                          <Plus className="h-3.5 w-3.5 mr-1.5" />
                          Create missing bundle
                        </button>
                        <button
                          type="button"
                          disabled={draftLoadingKey === group.sourceProductKey}
                          onClick={() => openCreateProductWizard(group)}
                          className="inline-flex items-center px-2.5 py-1 rounded-lg border border-indigo-200 text-indigo-800 text-xs font-medium hover:bg-indigo-50 disabled:opacity-50"
                        >
                          {draftLoadingKey === group.sourceProductKey ? (
                            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                          ) : (
                            <Plus className="h-3.5 w-3.5 mr-1.5" />
                          )}
                          Create missing product
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <SearchableDropdown
                  options={productDropdownOptions}
                  value={selectedProductId}
                  onChange={(value) => onProductChange(group.sourceProductKey, value)}
                  placeholder="Select AB365 product..."
                  searchPlaceholder="Search by name, vendor, or group/individual..."
                  showSublabel
                  showCode
                  showEmailInSelection
                  sectionLabels={productDropdownSectionLabels}
                />
                {selectedAb365Product ? (
                  <p className="text-xs text-gray-600 mt-1">
                    <span className="font-medium">{selectedAb365Product.vendorName || 'Unknown vendor'}</span>
                    {' · '}
                    {selectedAb365Product.salesTypeLabel}
                    {selectedAb365Product.isBundle ? ' · Bundle' : ''}
                  </p>
                ) : null}
                <p className="text-xs text-gray-500 mt-1">
                  Map E123 products to AB365 products or bundles. Bundled imports enroll each bundle component with{' '}
                  <code className="text-[11px] bg-gray-100 px-1 rounded">ProductBundleId</code> set — no wrapper enrollment row.
                  E123 may use a $0 bundle pdid plus separate component pdids; map components to their AB365 products and optionally map the $0 pdid to the bundle.
                  Use <strong>Unsync</strong> to clear a saved pairing.
                  <strong> Create missing bundle</strong> builds a bundle from tenant products; <strong>Create missing product</strong> prefills from E123 pricing.
                </p>
              </div>

              {selectedProductId ? (
                <div className="space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">Tier mapping</div>
                  {group.tiers.map((tier) => {
                    const key = tierKey(group.sourceProductKey, tier.sourceBenefitKey);
                    const selection = tierSelections[key] || { productId: selectedProductId, pricingId: '' };
                    const tierTitle = formatE123TierTitle(tier);
                    const pricingValue = selection.pricingId || '';
                    const tobaccoPricingValue = selection.pricingIdTobacco || '';
                    const suggestReason = tierSuggestReasons[key] || tier.suggestReason;
                    const showDualTobacco = tier.needsDualTobaccoMapping
                      || productHasPairedTobaccoRows(pricingByProduct[selectedProductId] || []);
                    const productPricingRows = pricingByProduct[selectedProductId] || [];
                    const selectionPremiumMatch = computeSelectionPremiumMatch(
                      tier,
                      pricingValue,
                      productPricingRows
                    );
                    return (
                      <div key={key} className="grid grid-cols-1 md:grid-cols-2 gap-4 pl-3 border-l-2 border-gray-200">
                        <div className="text-sm">
                          <div className="flex items-center gap-2 flex-wrap">
                            <div className="font-medium text-gray-900">{tierTitle}</div>
                            {tier.resolvedTier ? (
                              <span className="inline-flex px-2 py-0.5 text-[11px] font-semibold rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">
                                {tier.resolvedTier}
                              </span>
                            ) : null}
                            <PremiumMatchBadge match={selectionPremiumMatch} />
                          </div>
                          <div className="text-xs text-gray-500 mt-1 space-y-1">
                            <div>
                              {tier.sourceBenefitKey ? `benefit ${tier.sourceBenefitKey}` : 'no benefit id'} · {tier.memberCount.toLocaleString()} rows
                              {tier.mapped ? ' · previously saved' : tier.suggestedPricingId ? ' · auto-suggested' : ''}
                            </div>
                            {tier.tierBreakdownLabel ? (
                              <div>Household mix: {tier.tierBreakdownLabel}</div>
                            ) : null}
                            {tier.tobaccoBreakdownLabel ? (
                              <div>Tobacco mix: {tier.tobaccoBreakdownLabel}</div>
                            ) : tier.inferredTobaccoUse ? (
                              <div>
                                E123 tobacco: {tier.inferredTobaccoUse}
                                {tier.tobaccoConfidence != null
                                  ? ` (${Math.round(tier.tobaccoConfidence * 100)}% of known members)`
                                  : ''}
                              </div>
                            ) : null}
                            {tier.memberAgeRange ? (
                              <div>Member ages {tier.memberAgeRange.min}-{tier.memberAgeRange.max}</div>
                            ) : null}
                            {formatTierCatalogPremium(tier) ? (
                              <div className="font-medium text-gray-700">
                                {formatTierCatalogPremium(tier)}
                              </div>
                            ) : tier.feeAmountStats?.median != null ? (
                              <div className="text-gray-600">
                                Member premium ${tier.feeAmountStats.median.toFixed(2)}/mo
                                {tier.feeAmountStats.sampleSize > 1
                                  ? ` (median of ${tier.feeAmountStats.sampleSize})`
                                  : ''}
                                {' '}· upload E123 catalog CSVs for configured rates
                              </div>
                            ) : tier.feeHints?.amount != null ? (
                              <div className="text-gray-600">
                                Member premium ${Number(tier.feeHints.amount).toFixed(2)}/mo
                                {' '}· upload E123 catalog CSVs for configured rates
                              </div>
                            ) : (
                              <div className="text-amber-700">
                                No E123 catalog pricing — upload product catalog CSVs
                              </div>
                            )}
                            {(tier.feeHints?.unsharedAmount != null) ? (
                              <div>
                                Unshared amount {tier.feeHints.unsharedAmount}
                              </div>
                            ) : null}
                            {tier.displayHint ? (
                              <div className="text-indigo-700">{tier.displayHint}</div>
                            ) : null}
                          </div>
                        </div>
                        <div className="space-y-2">
                          <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">
                              {showDualTobacco ? 'AB365 non-tobacco tier' : 'AB365 pricing tier'}
                            </label>
                            <SearchableDropdown
                              options={buildPricingOptions(selectedProductId, showDualTobacco ? 'no' : undefined)}
                              value={pricingValue}
                              onChange={(value) => {
                                setTierSelections((prev) => ({
                                  ...prev,
                                  [key]: {
                                    productId: selectedProductId,
                                    pricingId: value,
                                    pricingIdTobacco: prev[key]?.pricingIdTobacco
                                  }
                                }));
                              }}
                              placeholder="Select pricing tier..."
                              searchPlaceholder="Search pricing tiers..."
                              showSublabel
                            />
                          </div>
                          {showDualTobacco ? (
                            <div>
                              <label className="block text-xs font-medium text-gray-600 mb-1">AB365 tobacco tier</label>
                              <p className="text-[11px] text-gray-500 mb-1">
                                E123 applies tobacco as a premium surcharge on the same benefit — not a separate tier.
                                Map this for import routing; only the non-tobacco rate is compared to E123.
                              </p>
                              <SearchableDropdown
                                options={buildPricingOptions(selectedProductId, 'yes')}
                                value={tobaccoPricingValue}
                                onChange={(value) => {
                                  setTierSelections((prev) => ({
                                    ...prev,
                                    [key]: {
                                      productId: selectedProductId,
                                      pricingId: prev[key]?.pricingId || '',
                                      pricingIdTobacco: value
                                    }
                                  }));
                                }}
                                placeholder="Select tobacco pricing tier..."
                                searchPlaceholder="Search tobacco tiers..."
                                showSublabel
                              />
                            </div>
                          ) : null}
                          {!selection.pricingId && suggestReason ? (
                            <div className="text-xs text-indigo-700 mt-1">
                              Suggested: {suggestReason}
                            </div>
                          ) : null}
                          {pricingValue === PRICING_TIER_NONE ? (
                            <div className="text-xs text-gray-500 mt-1">
                              No fixed AB365 tier — import will infer pricing from each member’s E123 premium.
                              {tier.memberCount <= 0 ? ' (No members on this benefit in the current batch.)' : ''}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  disabled={savingKey === group.sourceProductKey}
                  onClick={() => ignoreGroupMappings(group)}
                  className="inline-flex items-center px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 text-sm hover:bg-gray-50 disabled:opacity-50"
                >
                  {savingKey === group.sourceProductKey ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Ban className="h-4 w-4 mr-2" />}
                  Ignore product
                </button>
                <button
                  type="button"
                  disabled={!selectedProductId || savingKey === group.sourceProductKey}
                  onClick={() => saveGroupMappings(group)}
                  className="inline-flex items-center px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
                >
                  {savingKey === group.sourceProductKey ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                  {groupComplete ? 'Resave mapping' : 'Save mappings'}
                </button>
              </div>
            </>
          )}
        </div>
      </section>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500 py-8">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading product mappings...
      </div>
    );
  }

  const displayTenantName = tenantName || 'Selected tenant';
  const tenantCountLabel = instanceTenantCount > 0
    ? `${instanceTenantCount} tenant${instanceTenantCount === 1 ? '' : 's'}`
    : 'all instance tenants';

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
        <div className="flex items-start gap-2">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">
              AB365 catalog — {tenantCountLabel} (deduplicated)
            </div>
            <p className="mt-1 text-blue-800">
              {catalogSummary.total.toLocaleString()} unique product{catalogSummary.total === 1 ? '' : 's'} available for mapping
              {catalogSummary.total > 0 ? (
                <span>
                  {' '}({catalogSummary.subscribed} subscribed{catalogSummary.owned ? `, ${catalogSummary.owned} tenant-owned` : ''})
                </span>
              ) : null}.
              {catalogSummary.total <= 1 ? (
                <span className="block mt-1">
                  Few products found across instance tenants. Subscribed and tenant-owned products are merged without duplicates.
                  Add subscriptions under Tenant Product Subscriptions if a tenant is missing expected products.
                </span>
              ) : null}
              {displayTenantName ? (
                <span className="block mt-1">
                  New products created from this screen are owned by <span className="font-semibold">{displayTenantName}</span>.
                </span>
              ) : null}
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">{error}</div>
      )}

      {duplicateLabelGroups > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          E123 has multiple distinct products (pdid) that share the same display name — often created when pricing phases in.
          Use the <strong>pdid</strong>, enrollment dates, and catalog status below to map each version separately.
        </div>
      )}

      {groups.length === 0 ? (
        <div className="text-sm text-gray-500 rounded-lg border border-dashed border-gray-200 p-4">
          {batchId
            ? 'No E123 products found in the selected households for this batch.'
            : 'No E123 products discovered yet. Run a member import first to fetch households, then return here to pair products.'}
        </div>
      ) : null}

      {syncedConsistentPricingGroups.length > 0 && (
        <section className="border border-green-200 rounded-lg overflow-hidden">
          <button
            type="button"
            onClick={() => setShowSyncedConsistentMappings((prev) => !prev)}
            className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-green-50 hover:bg-green-100 text-left"
          >
            <div className="flex items-center gap-2">
              {showSyncedConsistentMappings ? (
                <ChevronDown className="h-4 w-4 text-green-800 shrink-0" />
              ) : (
                <ChevronRight className="h-4 w-4 text-green-800 shrink-0" />
              )}
              <div>
                <div className="text-sm font-medium text-green-900">
                  Synced mappings ({syncedConsistentPricingGroups.length})
                </div>
                <div className="text-xs text-green-800 mt-0.5">
                  Saved pairings with matching E123 and AB365 tier premiums
                </div>
              </div>
            </div>
            <CheckCircle className="h-4 w-4 text-green-700 shrink-0" />
          </button>
          {showSyncedConsistentMappings && (
            <div className="p-4 space-y-4 bg-green-50/40 border-t border-green-200">
              {syncedConsistentPricingGroups.map((group) => renderProductGroup(group))}
            </div>
          )}
        </section>
      )}

      {syncedInconsistentPricingGroups.length > 0 && (
        <section className="border border-yellow-300 rounded-lg overflow-hidden">
          <button
            type="button"
            onClick={() => setShowSyncedInconsistentPricing((prev) => !prev)}
            className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-yellow-50 hover:bg-yellow-100 text-left"
          >
            <div className="flex items-center gap-2">
              {showSyncedInconsistentPricing ? (
                <ChevronDown className="h-4 w-4 text-yellow-900 shrink-0" />
              ) : (
                <ChevronRight className="h-4 w-4 text-yellow-900 shrink-0" />
              )}
              <div>
                <div className="text-sm font-medium text-yellow-950">
                  Synced with inconsistent pricing ({syncedInconsistentPricingGroups.length})
                </div>
                <div className="text-xs text-yellow-900 mt-0.5">
                  Saved pairings where one or more tier premiums do not match E123
                </div>
              </div>
            </div>
            <AlertTriangle className="h-4 w-4 text-yellow-700 shrink-0" />
          </button>
          {showSyncedInconsistentPricing && (
            <div className="p-4 space-y-4 bg-yellow-50/40 border-t border-yellow-300">
              {syncedInconsistentPricingGroups.map((group) => renderProductGroup(group))}
            </div>
          )}
        </section>
      )}

      {pendingMappingGroups.length > 0 ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-gray-900">
              Needs mapping ({pendingMappingGroups.length})
            </h3>
            {syncedMappingGroups.length > 0 ? (
              <span className="text-xs text-gray-500">
                {syncedConsistentPricingGroups.length} matched
                {syncedInconsistentPricingGroups.length > 0
                  ? ` · ${syncedInconsistentPricingGroups.length} pricing gap${syncedInconsistentPricingGroups.length === 1 ? '' : 's'}`
                  : ''}
                {' · '}{pendingMappingGroups.length} remaining
              </span>
            ) : null}
          </div>
          {pendingMappingGroups.map((group) => renderProductGroup(group))}
        </div>
      ) : syncedMappingGroups.length > 0 ? (
        <div className={`text-sm rounded-lg px-4 py-3 border ${
          syncedInconsistentPricingGroups.length > 0
            ? 'text-yellow-950 bg-yellow-50 border-yellow-300'
            : 'text-green-800 bg-green-50 border-green-200'
        }`}>
          All E123 products in this batch are synced.
          {syncedInconsistentPricingGroups.length > 0 ? (
            <> Expand <strong>Synced with inconsistent pricing</strong> to fix tier premium gaps.</>
          ) : (
            <> Expand <strong>Synced mappings</strong> above to review.</>
          )}
        </div>
      ) : null}

      {ignoredGroups.length > 0 && (
        <section className="border border-amber-200 rounded-lg overflow-hidden">
          <button
            type="button"
            onClick={() => setShowIgnoredProducts((prev) => !prev)}
            className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-amber-50 hover:bg-amber-100 text-left"
          >
            <div className="flex items-center gap-2">
              {showIgnoredProducts ? (
                <ChevronDown className="h-4 w-4 text-amber-800 shrink-0" />
              ) : (
                <ChevronRight className="h-4 w-4 text-amber-800 shrink-0" />
              )}
              <div>
                <div className="text-sm font-medium text-amber-900">
                  Ignored products ({ignoredGroups.length})
                </div>
                <div className="text-xs text-amber-800 mt-0.5">
                  Skipped during import — expand to restore and map
                </div>
              </div>
            </div>
            <Ban className="h-4 w-4 text-amber-700 shrink-0" />
          </button>
          {showIgnoredProducts && (
            <div className="p-4 space-y-4 bg-amber-50/40 border-t border-amber-200">
              {ignoredGroups.map((group) => renderProductGroup(group))}
            </div>
          )}
        </section>
      )}

      {createWizardOpen && wizardResyncProductId && !createWizardMeta?.warnings?.length ? (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-900">
          <div className="font-medium mb-1">Resync from latest E123 data</div>
          <p>
            Review the updated fields and save to apply changes to the existing linked product.
          </p>
        </div>
      ) : null}

      {createWizardOpen && createWizardMeta?.warnings?.length ? (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-900">
          <div className="font-medium mb-1">
            {wizardResyncProductId ? 'Resync from latest E123 data' : 'Product wizard prefill notes'}
          </div>
          {wizardResyncProductId ? (
            <p className="mb-2 text-indigo-800">
              The wizard opened in edit mode for the linked AB365 product. Pricing and configuration fields
              are prefilled from the latest E123 catalog data — review and save to update the existing product
              (no duplicate will be created).
            </p>
          ) : null}
          <ul className="list-disc pl-5 space-y-1">
            {createWizardMeta.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          {createWizardMeta.prefilledSections?.length ? (
            <div className="text-xs mt-2 text-indigo-800">
              Prefilled sections: {createWizardMeta.prefilledSections.join(', ')}
            </div>
          ) : null}
        </div>
      ) : null}

      <E123VendorRoutingModal
        isOpen={vendorRoutingOpen}
        preview={vendorRoutingPreview}
        productLabel={pendingWizardGroup?.sourceProductLabel}
        loading={vendorRoutingLoading}
        onClose={cancelVendorRoutingModal}
        onConfirm={handleVendorRoutingConfirm}
      />

      <E123CopyProductTemplateModal
        isOpen={copyTemplateOpen}
        productLabel={pendingWizardGroup?.sourceProductLabel}
        subscribedProducts={subscribedProducts}
        suggestedProductId={copyTemplateSuggestedId}
        loading={copyTemplateLoading}
        onClose={closeCopyTemplateModal}
        onConfirm={(templateProductId) => void confirmCopyTemplate(templateProductId)}
      />

      {tobaccoPromptOpen && pendingWizardGroup ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full p-5 space-y-4">
            <h3 className="text-lg font-semibold text-gray-900">Tobacco pricing tiers</h3>
            <p className="text-sm text-gray-600">
              E123 does not have separate tobacco tiers — smokers pay a higher premium on the same benefit.
              In AB365, that usually means paired <strong>No</strong> and <strong>Yes</strong> pricing rows per band.
              Create them for <strong>{pendingWizardGroup.sourceProductLabel}</strong>?
            </p>
            {pendingWizardGroup.tobaccoPricingRecommendation ? (
              <div className={`rounded-lg border px-3 py-2 text-sm ${
                pendingWizardGroup.tobaccoPricingRecommendation.recommended
                  ? 'border-indigo-200 bg-indigo-50 text-indigo-900'
                  : 'border-gray-200 bg-gray-50 text-gray-800'
              }`}>
                <div className="font-medium">
                  {formatTobaccoRecommendationLabel(pendingWizardGroup.tobaccoPricingRecommendation)}
                </div>
                <p className="mt-1 text-xs opacity-90">
                  {pendingWizardGroup.tobaccoPricingRecommendation.summary}
                </p>
                {(pendingWizardGroup.tobaccoPricingRecommendation.reasonsFor.length > 0
                  || pendingWizardGroup.tobaccoPricingRecommendation.reasonsAgainst.length > 0) && (
                  <ul className="mt-2 space-y-1 text-xs opacity-90 list-disc pl-4">
                    {(pendingWizardGroup.tobaccoPricingRecommendation.recommended
                      ? pendingWizardGroup.tobaccoPricingRecommendation.reasonsFor
                      : pendingWizardGroup.tobaccoPricingRecommendation.reasonsAgainst
                    ).slice(0, 3).map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
            <label className="flex items-start gap-3 text-sm text-gray-800">
              <input
                type="checkbox"
                className="mt-1"
                checked={tobaccoPromptUseTobacco}
                onChange={(e) => setTobaccoPromptUseTobacco(e.target.checked)}
              />
              <span>
                Include tobacco surcharge tiers for all pricing bands
                {tobaccoPromptUseTobacco !== recommendedUseTobaccoPricing(pendingWizardGroup) && (
                  <span className="block text-xs text-amber-700 mt-1">
                    Differs from the E123 recommendation above — override only if you know this product handles tobacco differently in AB365.
                  </span>
                )}
              </span>
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={closeTobaccoPrompt}
                className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmTobaccoPrompt()}
                className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm hover:bg-indigo-700"
              >
                Continue to wizard
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <AddProductWizard
        isOpen={createWizardOpen}
        onClose={closeCreateProductWizard}
        onCancel={closeCreateProductWizard}
        onSave={wizardResyncProductId ? handleResyncProduct : handleSaveNewProduct}
        editingProduct={wizardResyncProductId ? { ProductId: wizardResyncProductId } : undefined}
        prefilledDraft={!wizardResyncProductId ? createWizardDraft || undefined : undefined}
        e123ResyncDraft={e123ResyncDraft || undefined}
        isTenantAdmin={false}
      />

      <AddBundleWizard
        isOpen={createBundleOpen}
        onClose={closeCreateBundleWizard}
        onCancel={closeCreateBundleWizard}
        onComplete={() => {}}
        onSave={handleSaveNewBundle}
        editingBundle={createBundlePrefill || undefined}
        bundleProductCatalog={createBundleOpen ? bundleProductCatalog : undefined}
        bundleProductCatalogLoading={false}
      />
    </div>
  );
}
