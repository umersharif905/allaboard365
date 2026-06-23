import { Building, Download, Loader2, Mail, Package, Phone, User, Wallet, XCircle } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import ProductDocumentsLinks from '../shared/ProductDocumentsLinks';
import ProductSubscribersPanel from './ProductSubscribersPanel';
import SearchableDropdown from '../common/SearchableDropdown';
import { useAuth } from '../../contexts/AuthContext';
import { useBundlePricingSimulator } from '../../hooks/agent/useBundlePricingSimulator';
import { useAgentProductPricing, type ProductPricing } from '../../hooks/agent/useAgentProductPricing';
import {
  useAgentProductCommissionPreview,
  type AgentProductCommissionPreview
} from '../../hooks/agent/useAgentProductCommissionPreview';
import { useTenantCommissionProductGroups } from '../../hooks/agent/useTenantCommissionProductGroups';
import { useDownlineAgentsForFilter } from '../../hooks/useDownlineAgentsForFilter';
import { isAgentFilterScopeSentinel } from '../../constants/agentFilterScope';
import { apiService } from '../../services/api.service';
import { downloadPricingExport } from '../../services/tenant-admin/pricing-export.service';
import type { UserRole } from '../../types/user.types';
import { hasProductDocuments } from '../../utils/productDocuments';
import CommissionTierTable from './CommissionTierTable';

/** Matches backend shouldUseTenantCommissionPreview — tenant sees group picker + all levels. */
function isTenantCommissionViewer(currentRole: UserRole, roles: UserRole[]): boolean {
  if (currentRole === 'TenantAdmin' || currentRole === 'SysAdmin') return true;
  if (currentRole === 'Agent') return false;
  if (roles.includes('TenantAdmin') && !roles.includes('Agent')) return true;
  if (roles.includes('SysAdmin')) return true;
  return false;
}

export interface ProductOwner {
  tenantName: string;
  contactEmail?: string;
  contactPhone?: string;
  contactPerson?: string;
}

export interface SystemFees {
  platformFee?: { name: string; amount: number; type: string };
  transactionFee?: { name: string; amount: number; type: string };
  processingFee?: { name:string; amount: number; type: string };
}

export interface PricingTier {
  id: string;
  minAge: number;
  maxAge: number;
  tierType: string;
  tobaccoStatus: string;
  netRate: number;
  overrideRate: number;
  rate: number;
}

export interface BundleProduct {
  productId: string;
  name: string;
  description?: string;
  productType: string;
  sortOrder: number;
  isRequired: boolean;
  hidePricing?: boolean;
  linkedToProductId?: string;
  productDocumentUrl?: string;
  productDocuments?: { productDocumentId?: string; documentUrl: string; displayName?: string; sortOrder?: number }[];
}

export interface SubscribedProduct {
  subscriptionId: string;
  productId: string;
  productName: string;
  productType: string;
  description?: string;
  productImageUrl?: string;
  productLogoUrl?: string;
  productDocumentUrl?: string;
  productDocuments?: { productDocumentId?: string; documentUrl: string; displayName?: string; sortOrder?: number }[];
  basicPrice: number;
  productOwner: ProductOwner;
  subscriptionStatus: string;
  requestedDiscount?: number;
  approvedDiscount?: number;
  discountType?: 'percent' | 'flatRate' | 'tierBased';
  tierDiscounts?: { [key: string]: number };
  tenantRate: number;
  commissionRate?: number;
  profitMargin?: number;
  systemFees?: SystemFees;
  salePrice?: number;
  requestMessage?: string;
  responseMessage?: string;
  requestDate?: string;
  responseDate?: string;
  isConfigured: boolean;
  status: string;
  allowedStates?: string[];
  pricingTiers?: PricingTier[];
  isBundle?: boolean;
  bundleProducts?: BundleProduct[];
  salesType?: string;
  /** @deprecated Subscription toggle — ignored by pricing; use product MSRPRate / wizard flag. */
  includeProcessingFee?: boolean;
  /** Tenant may hide product from agent catalog; optional on some API responses. */
  isHidden?: boolean;
}

/** Map tenant-admin / API shapes to the agent SubscribedProduct shape used by this modal. */
export function normalizeBundleProduct(bp: Record<string, unknown>): BundleProduct {
  const b = bp as Record<string, any>;
  return {
    productId: String(b.productId ?? b.ProductId ?? ''),
    name: String(b.name ?? b.Name ?? b.ProductName ?? ''),
    description: b.description,
    productType: String(b.productType ?? b.ProductType ?? ''),
    sortOrder: Number(b.sortOrder ?? b.SortOrder ?? 0),
    isRequired: Boolean(b.isRequired ?? b.IsRequired),
    hidePricing: Boolean(b.hidePricing ?? b.HidePricing ?? false),
    linkedToProductId: b.linkedToProductId ?? b.LinkedToProductId,
    productDocumentUrl: b.productDocumentUrl ?? b.ProductDocumentUrl,
    productDocuments: b.productDocuments ?? b.ProductDocuments,
  };
}

export function normalizeSubscribedProductForDetailsModal(raw: unknown): SubscribedProduct {
  const p = raw as Record<string, any>;
  const bundleProductsRaw = (p.bundleProducts ?? p.BundleProducts ?? []) as Record<string, unknown>[];
  let allowedStates = p.allowedStates ?? p.AllowedStates;
  if (typeof allowedStates === 'string') {
    try {
      allowedStates = JSON.parse(allowedStates);
    } catch {
      allowedStates = undefined;
    }
  }
  return {
    subscriptionId: String(p.subscriptionId ?? p.SubscriptionId ?? ''),
    productId: String(p.productId ?? p.ProductId ?? ''),
    productName: String(p.productName ?? p.Name ?? ''),
    productType: String(p.productType ?? p.ProductType ?? ''),
    description: p.description,
    productImageUrl: p.productImageUrl ?? p.ProductImageUrl,
    productLogoUrl: p.productLogoUrl ?? p.ProductLogoUrl,
    productDocumentUrl: p.productDocumentUrl ?? p.ProductDocumentUrl,
    productDocuments: p.productDocuments ?? p.ProductDocuments,
    basicPrice: Number(p.basicPrice ?? p.BasicPrice ?? 0),
    productOwner: p.productOwner ?? { tenantName: '' },
    subscriptionStatus: String(p.subscriptionStatus ?? p.SubscriptionStatus ?? ''),
    requestedDiscount: p.requestedDiscount,
    approvedDiscount: p.approvedDiscount,
    discountType: p.discountType,
    tierDiscounts: p.tierDiscounts,
    tenantRate: Number(p.tenantRate ?? p.TenantRate ?? 0),
    commissionRate: p.commissionRate,
    profitMargin: p.profitMargin,
    systemFees: p.systemFees,
    salePrice: p.salePrice,
    requestMessage: p.requestMessage,
    responseMessage: p.responseMessage,
    requestDate: p.requestDate,
    responseDate: p.responseDate,
    isConfigured: Boolean(p.isConfigured),
    status: String(p.status ?? ''),
    allowedStates: Array.isArray(allowedStates) ? allowedStates : undefined,
    pricingTiers: p.pricingTiers ?? p.PricingTiers,
    isBundle: Boolean(p.isBundle ?? p.IsBundle),
    bundleProducts: bundleProductsRaw.map((x) => normalizeBundleProduct(x)),
    salesType: p.salesType ?? p.SalesType,
    includeProcessingFee: p.includeProcessingFee,
  };
}

interface ProductDetailsModalProps {
  product: unknown;
  onClose: () => void;
  onSubscribersChanged?: () => void;
}

type TobaccoFilter = 'All' | 'Y' | 'N' | 'N/A';
type TierFilter = 'All' | string;

/** Normalize tobacco value for filtering: API may return "Yes"/"No" or "Y"/"N". */
function tobaccoFilterValue(v: string | null | undefined): 'Y' | 'N' | 'N/A' {
  if (v == null || v === '') return 'N/A';
  const u = String(v).trim().toUpperCase();
  if (u === 'Y' || u === 'YES') return 'Y';
  if (u === 'N' || u === 'NO') return 'N';
  return 'N/A';
}

/** Standard coverage tier codes → agent-facing labels (pricing breakdown, bundles, commissions). */
const FAMILY_COVERAGE_TIER_LABELS: Record<string, string> = {
  EE: 'Individual',
  ES: 'Individual + Spouse',
  EC: 'Individual + Child(ren)',
  EF: 'Family',
};

function formatFamilyCoverageTierLabel(tierCode: string | null | undefined): string {
  const raw = (tierCode ?? '').toString().trim();
  const t = raw.toUpperCase();
  if (!t) return '—';
  return FAMILY_COVERAGE_TIER_LABELS[t] ?? raw;
}

function formatTierType(tierType: string | null | undefined): string {
  return formatFamilyCoverageTierLabel(tierType);
}

function formatPricingLabel(pricing: ProductPricing): string {
  const tierRaw = (pricing.TierType ?? '').toString().trim();
  const tier = tierRaw.toUpperCase();
  const label = (pricing.Label ?? '').toString().trim();
  const tierDisplay = tier ? formatTierType(tier) : '';
  if (!tierDisplay) return label || pricing.ProductName || '—';
  if (!label || label.toUpperCase() === tier) return tierDisplay;
  return `${tierDisplay} — ${label}`;
}

function formatMemberPremiumAmount(amount: number): string {
  const value = Number(amount || 0);
  if (!Number.isFinite(value) || value <= 0) return '—';
  return value % 1 === 0 ? `$${value.toFixed(0)}` : `$${value.toFixed(2)}`;
}

function renderMemberPremiumDisplay(pt: NonNullable<ProductPricing['computedMemberDisplay']>) {
  if (pt.basePremium <= 0) return '—';

  const paymentProcessingFee =
    (pt.nonIncludedProcessingFee ?? 0) + (pt.customSystemFeeAmount > 0 ? pt.customSystemFeeAmount : 0);

  const showBreakdown =
    pt.hasIncludedProcessingAdjustment ||
    paymentProcessingFee > 0 ||
    (pt.usesCustomSystemFeeHandling && pt.customSystemFeeAmount === 0);

  if (!showBreakdown) {
    return <span className="font-medium text-gray-900">{formatMemberPremiumAmount(pt.displayPremium)}</span>;
  }

  return (
    <div>
      <div className="font-medium text-gray-900">{formatMemberPremiumAmount(pt.displayPremium)}</div>
      <div className="mt-1 space-y-0.5 text-xs text-gray-500 text-left">
        <p>Base ${pt.basePremium.toFixed(2)}</p>
        {pt.hasIncludedProcessingAdjustment && (
          <p>
            {pt.roundUpProcessingFeeEnabled
              ? `Included processing, round-up (+$${pt.includedProcessingFee.toFixed(2)})`
              : `Included processing (+$${pt.includedProcessingFee.toFixed(2)})`}
          </p>
        )}
        {paymentProcessingFee > 0 && (
          <p>Payment Processing Fee (+${paymentProcessingFee.toFixed(2)})</p>
        )}
        {pt.usesCustomSystemFeeHandling && pt.customSystemFeeAmount === 0 && (
          <p>Custom product system fee enabled — no fixed amount on subscription (see Bundle for scenario total).</p>
        )}
      </div>
    </div>
  );
}

const BUNDLE_TAB_ID = '__bundle__';

const BUNDLE_TIERS = ['EE', 'ES', 'EC', 'EF'] as const;

/** Map sysadmin marketplace list rows to the modal's SubscribedProduct shape. */
export function normalizeMarketplaceProductForDetailsModal(
  product: Record<string, unknown>,
  bundleProducts: BundleProduct[] = []
): unknown {
  const p = product as Record<string, any>;
  let allowedStates = p.AllowedStates ?? p.allowedStates;
  if (typeof allowedStates === 'string') {
    try {
      allowedStates = JSON.parse(allowedStates);
    } catch {
      allowedStates = undefined;
    }
  }
  return {
    productId: String(p.ProductId ?? p.productId ?? ''),
    productName: String(p.Name ?? p.productName ?? ''),
    productType: String(p.ProductType ?? p.productType ?? ''),
    description: p.Description ?? p.description,
    productImageUrl: p.ProductImageUrl ?? p.productImageUrl,
    productLogoUrl: p.ProductLogoUrl ?? p.productLogoUrl,
    productDocumentUrl: p.ProductDocumentUrl ?? p.productDocumentUrl,
    productDocuments: p.productDocuments ?? p.ProductDocuments,
    basicPrice: Number(p.BasePrice ?? p.basicPrice ?? 0),
    productOwner: {
      tenantName: String(p.ProductOwnerName ?? p.productOwner?.tenantName ?? ''),
      contactEmail: p.ProductOwnerEmail ?? p.productOwner?.contactEmail,
    },
    productOwnerId: p.ProductOwnerId ?? p.productOwnerId,
    ownershipType: 'owner',
    status: String(p.Status ?? p.status ?? 'Active'),
    subscriptionStatus: String(p.SubscriptionStatus ?? p.subscriptionStatus ?? ''),
    isConfigured: true,
    tenantRate: Number(p.BasePrice ?? p.tenantRate ?? 0),
    allowedStates: Array.isArray(allowedStates) ? allowedStates : undefined,
    pricingTiers: p.PricingTiers ?? p.pricingTiers,
    isBundle: Boolean(p.IsBundle ?? p.isBundle),
    bundleProducts,
    salesType: p.SalesType ?? p.salesType,
    includeProcessingFee: p.IncludeProcessingFee ?? p.includeProcessingFee,
  };
}

/** Tenant admin may export pricing only for products they own, not subscribed marketplace products. */
function isTenantProductOwner(raw: unknown, currentTenantId: string | undefined): boolean {
  const p = raw as Record<string, unknown>;
  if (p.ownershipType === 'subscriber') return false;
  if (p.ownershipType === 'owner') return true;
  const ownerId = (p.productOwnerId ?? p.ProductOwnerId) as string | undefined;
  if (ownerId && currentTenantId) {
    return String(ownerId).toLowerCase() === String(currentTenantId).toLowerCase();
  }
  return false;
}

function compareFamilyTierTypes(a: string, b: string): number {
  const aKey = a.trim().toUpperCase();
  const bKey = b.trim().toUpperCase();
  const aIdx = (BUNDLE_TIERS as readonly string[]).indexOf(aKey);
  const bIdx = (BUNDLE_TIERS as readonly string[]).indexOf(bKey);
  const aOrder = aIdx >= 0 ? aIdx : BUNDLE_TIERS.length;
  const bOrder = bIdx >= 0 ? bIdx : BUNDLE_TIERS.length;
  if (aOrder !== bOrder) return aOrder - bOrder;
  return aKey.localeCompare(bKey);
}

const UNSHARED_CONFIG_FIELD_RE = /unshared\s*amount|deductible/i;

/** UA / deductible value from a pricing row (labeled config slot, else ConfigValue1). */
function getSimulatorConfigValueFromRow(p: ProductPricing): string | null {
  for (let i = 1; i <= 5; i += 1) {
    const field = String(p[`ConfigField${i}` as keyof ProductPricing] ?? '').trim();
    const value = String(p[`ConfigValue${i}` as keyof ProductPricing] ?? '').trim();
    if (value && UNSHARED_CONFIG_FIELD_RE.test(field)) return value;
  }
  const cv1 = String(p.ConfigValue1 ?? '').trim();
  return cv1 || null;
}

const SubscribedProductDetailsModal: React.FC<ProductDetailsModalProps> = ({
  product: rawProduct,
  onClose,
  onSubscribersChanged
}) => {
  const product = useMemo(() => normalizeSubscribedProductForDetailsModal(rawProduct), [rawProduct]);
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const tenantCommissionViewer = useMemo(() => {
    if (!user?.roles?.length) return false;
    return isTenantCommissionViewer(user.currentRole, user.roles);
  }, [user]);
  const showProductOwnerContact =
    user?.currentRole === 'TenantAdmin' || user?.currentRole === 'SysAdmin';
  const [activeTab, setActiveTab] = useState<'details' | 'pricing' | 'commissions' | 'subscribers'>('details');
  const [selectedCommissionGroupId, setSelectedCommissionGroupId] = useState<string | null>(null);
  /** Upline agent: preview commissions as if a downline agent sold (empty = self). */
  const [selectedDownlineAgentId, setSelectedDownlineAgentId] = useState<string>('');
  /** For bundles: which included product to run commission preview against (rules are per product). */
  const [selectedBundleCommissionProductId, setSelectedBundleCommissionProductId] = useState<string | null>(null);
  const [selectedPricingProductTab, setSelectedPricingProductTab] = useState<string>(product.isBundle ? BUNDLE_TAB_ID : '');
  const [tobaccoFilter, setTobaccoFilter] = useState<TobaccoFilter>('All');
  const [tierFilter, setTierFilter] = useState<TierFilter>('All');
  // Bundle simulator: Tobacco Yes/No, age within product range, optional config (e.g. Unshared amount)
  const [bundleTobacco, setBundleTobacco] = useState<'Y' | 'N'>('N');
  const [bundleAge, setBundleAge] = useState<number>(35);
  const [bundleConfigValue, setBundleConfigValue] = useState<string>('');
  /** Non-included premium processing fee depends on payment method (Quick Quote / enrollment). */
  const [pricingPaymentMethod, setPricingPaymentMethod] = useState<'ACH' | 'Card'>('ACH');
  const [isExportingPricing, setIsExportingPricing] = useState(false);
  const [pricingExportError, setPricingExportError] = useState<string | null>(null);
  const isTenantAdminViewer = user?.currentRole === 'TenantAdmin';
  const isSysAdminViewer = user?.currentRole === 'SysAdmin';
  const currentTenantId = user?.currentTenantId || user?.tenantId;
  const showCommissionsTab = !isSysAdminViewer;
  const showSubscribersTab = isSysAdminViewer || (isTenantAdminViewer && isTenantProductOwner(rawProduct, currentTenantId));
  const subscribersTabOwnerView = isTenantAdminViewer && isTenantProductOwner(rawProduct, currentTenantId);
  const canExportPricing = useMemo(
    () =>
      isSysAdminViewer ||
      (isTenantAdminViewer && isTenantProductOwner(rawProduct, currentTenantId)),
    [isSysAdminViewer, isTenantAdminViewer, rawProduct, currentTenantId]
  );

  const handleExportPricing = async () => {
    if (!product.productId) return;
    setIsExportingPricing(true);
    setPricingExportError(null);
    try {
      await downloadPricingExport(product.productId, product.productName || 'product', isSysAdminViewer);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to export pricing';
      setPricingExportError(message);
    } finally {
      setIsExportingPricing(false);
    }
  };

  const renderPricingExportButton = () => {
    if (!canExportPricing) return null;
    return (
      <div className="flex flex-col items-end gap-1 shrink-0">
        <button
          type="button"
          onClick={handleExportPricing}
          disabled={isExportingPricing}
          className="inline-flex items-center gap-1.5 rounded-lg bg-oe-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-oe-dark disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
        >
          <Download className="h-4 w-4" aria-hidden />
          {isExportingPricing ? 'Exporting…' : 'Export Pricing'}
        </button>
        {pricingExportError && (
          <p className="text-xs text-red-600 max-w-xs text-right">{pricingExportError}</p>
        )}
      </div>
    );
  };

  useEffect(() => {
    setActiveTab('details');
    setSelectedPricingProductTab(product.isBundle ? BUNDLE_TAB_ID : '');
    setTobaccoFilter('All');
    setTierFilter('All');
    setBundleTobacco('N');
    setBundleAge(35);
    setBundleConfigValue('');
    setPricingPaymentMethod('ACH');
    setSelectedCommissionGroupId(null);
    setSelectedBundleCommissionProductId(null);
    setSelectedDownlineAgentId('');
  }, [product.productId, product.subscriptionId, product.isBundle]);

  const downlinePreviewScope = selectedDownlineAgentId.trim() || 'agent';

  const commissionPreviewProductId = useMemo(() => {
    if (!product.isBundle || !product.bundleProducts?.length) return product.productId;
    const first = product.bundleProducts[0]?.productId;
    if (!first) return product.productId;
    return selectedBundleCommissionProductId ?? first;
  }, [product.isBundle, product.bundleProducts, product.productId, selectedBundleCommissionProductId]);

  const bundleCommissionProductOptions = useMemo(
    () =>
      (product.bundleProducts ?? []).map((bp) => ({
        id: bp.productId,
        value: bp.productId,
        label: bp.name?.trim() ? bp.name : 'Product'
      })),
    [product.bundleProducts]
  );

  const bundleProductPicker =
    product.isBundle && (product.bundleProducts?.length ?? 0) > 0 ? (
      <div className="mb-4">
        <label className="block text-xs font-medium text-gray-700 mb-1">Included product</label>
        <SearchableDropdown
          options={bundleCommissionProductOptions}
          value={commissionPreviewProductId}
          onChange={(value) => setSelectedBundleCommissionProductId(value)}
          placeholder="Select a product in this bundle"
          searchPlaceholder="Search products..."
          className="w-full"
        />
      </div>
    ) : null;

  const pricingProductId = activeTab === 'pricing' ? product.productId : null;
  const { data: pricingData, isLoading: isPricingLoading } = useAgentProductPricing(
    pricingProductId,
    pricingPaymentMethod
  );
  const productPricing = pricingData?.rows;

  const commissionsTabActive = activeTab === 'commissions';

  useEffect(() => {
    if (!commissionsTabActive || tenantCommissionViewer) return;
    queryClient.invalidateQueries({ queryKey: ['agentProductCommissionPreview'] });
  }, [downlinePreviewScope, commissionsTabActive, tenantCommissionViewer, queryClient]);

  const {
    data: commissionGroups = [],
    isLoading: commissionGroupsLoading,
    error: commissionGroupsError
  } = useTenantCommissionProductGroups(product.productId, commissionsTabActive && tenantCommissionViewer);

  const effectiveCommissionGroupId =
    selectedCommissionGroupId ?? commissionGroups[0]?.CommissionGroupId ?? null;

  const commissionGroupDropdownOptions = useMemo(
    () =>
      commissionGroups.map((g) => ({
        id: g.CommissionGroupId,
        value: g.CommissionGroupId,
        label: g.Name?.trim() ? g.Name : 'Unnamed group'
      })),
    [commissionGroups]
  );

  const { data: downlineAgentOptionsRaw = [], isLoading: isDownlineLoading } =
    useDownlineAgentsForFilter();

  const downlineDropdownOptions = useMemo(
    () =>
      downlineAgentOptionsRaw
        .filter((o) => o.value === '' || !isAgentFilterScopeSentinel(o.value))
        .map((o) => (o.value === '' ? { ...o, label: 'My commissions' } : o)),
    [downlineAgentOptionsRaw]
  );

  const showDownlineDropdown = !tenantCommissionViewer && downlineDropdownOptions.length > 1;

  const downlinePicker = showDownlineDropdown ? (
    <div className="mb-4">
      <label className="block text-xs font-medium text-gray-700 mb-1">View commissions for</label>
      <SearchableDropdown
        options={downlineDropdownOptions}
        value={selectedDownlineAgentId}
        onChange={(value) => setSelectedDownlineAgentId(String(value ?? '').trim())}
        placeholder="My commissions"
        searchPlaceholder="Search agents..."
        loading={isDownlineLoading}
        className="w-full"
      />
    </div>
  ) : null;

  const { data: commissionPreview, isLoading: isCommissionPreviewLoading, error: commissionPreviewError } =
    useAgentProductCommissionPreview(commissionPreviewProductId, commissionsTabActive, {
      tenantViewer: tenantCommissionViewer,
      commissionGroupId: effectiveCommissionGroupId,
      downlineAgentId: !tenantCommissionViewer && selectedDownlineAgentId ? selectedDownlineAgentId : null
    });

  /**
   * Agent + bundle path: fan out per bundle child so the commissions tab can show
   * every product's payout block at once (no dropdown). Uses the same queryKey
   * shape as useAgentProductCommissionPreview so the cache is shared.
   */
  const bundleCommissionTableActive =
    commissionsTabActive && product.isBundle && !tenantCommissionViewer;
  const bundleChildren = bundleCommissionTableActive ? product.bundleProducts ?? [] : [];

  const bundleCommissionQueries = useQueries({
    queries: bundleChildren.map((bp) => {
      const downlineId = selectedDownlineAgentId.trim();
      return {
        queryKey: ['agentProductCommissionPreview', bp.productId, downlineId || 'agent'],
        enabled: commissionsTabActive && !!bp.productId,
        queryFn: async (): Promise<AgentProductCommissionPreview> => {
          const qs = downlineId ? `?downlineAgentId=${encodeURIComponent(downlineId)}` : '';
          const res = await apiService.get<{
            success: boolean;
            data?: AgentProductCommissionPreview;
            message?: string;
          }>(`/api/me/agent/products/${bp.productId}/commission-preview${qs}`);
          if (!res.success || !res.data) {
            throw new Error(res.message || 'Failed to load commission preview');
          }
          return res.data;
        },
        staleTime: downlineId ? 0 : 5 * 60 * 1000,
        gcTime: 10 * 60 * 1000,
        retry: 1
      };
    })
  });

  const uniqueProductNames: string[] = productPricing
    ? Array.from(new Set(productPricing.map(p => p.ProductName).filter((n): n is string => Boolean(n))))
    : [];
  const effectivePricingTab = selectedPricingProductTab || (product.isBundle ? BUNDLE_TAB_ID : uniqueProductNames[0]) || '';
  const showingBundle = product.isBundle && effectivePricingTab === BUNDLE_TAB_ID;
  const pricingForCurrentTab = showingBundle
    ? undefined
    : (effectivePricingTab ? productPricing?.filter(p => p.ProductName === effectivePricingTab) : productPricing);


  /** Age range and config options for bundle simulator (from all pricing rows). */
  const bundleSimulatorOptions = (() => {
    if (!product.isBundle || !productPricing?.length) return { ageMin: 18, ageMax: 64, ages: [] as number[], configOptions: [] as string[], configLabel: '' };
    let ageMin = 999;
    let ageMax = 0;
    const configValues = new Set<string>();
    let configLabel = '';
    for (const p of productPricing) {
      if (p.MinAge != null) ageMin = Math.min(ageMin, p.MinAge);
      if (p.MaxAge != null) ageMax = Math.max(ageMax, p.MaxAge);
      const configVal = getSimulatorConfigValueFromRow(p);
      if (configVal) {
        configValues.add(configVal);
        if (!configLabel) {
          for (let i = 1; i <= 5; i += 1) {
            const field = String(p[`ConfigField${i}` as keyof ProductPricing] ?? '').trim();
            const value = String(p[`ConfigValue${i}` as keyof ProductPricing] ?? '').trim();
            if (value && UNSHARED_CONFIG_FIELD_RE.test(field)) {
              configLabel = field;
              break;
            }
          }
          if (!configLabel && (p.ConfigField1 ?? '').trim()) configLabel = (p.ConfigField1 ?? '').trim();
        }
      }
    }
    if (ageMin === 999) ageMin = 18;
    if (ageMax === 0) ageMax = 64;
    const ages = Array.from({ length: ageMax - ageMin + 1 }, (_, i) => ageMin + i);
    const configOptions = Array.from(configValues).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
    if (!configLabel && configOptions.length) configLabel = 'Configuration';
    return { ageMin, ageMax, ages, configOptions, configLabel };
  })();

  const effectiveBundleAge = product.isBundle && productPricing?.length
    ? Math.max(bundleSimulatorOptions.ageMin, Math.min(bundleSimulatorOptions.ageMax, bundleAge))
    : bundleAge;
  // Config is required when present; default-select first option.
  const effectiveBundleConfig = product.isBundle && bundleSimulatorOptions.configOptions.length
    ? (bundleConfigValue || bundleSimulatorOptions.configOptions[0])
    : bundleConfigValue;

  const bundleSimEnabled = Boolean(
    product.isBundle &&
      showingBundle &&
      activeTab === 'pricing' &&
      !isPricingLoading &&
      productPricing?.length
  );

  const bundleSimCriteria = bundleSimEnabled
    ? {
        tobacco: bundleTobacco,
        age: effectiveBundleAge,
        configValue: effectiveBundleConfig || '',
        paymentMethod: pricingPaymentMethod,
        bundleProductIds: (product.bundleProducts ?? []).map((bp) => bp.productId).filter(Boolean) as string[],
      }
    : null;

  const {
    data: bundleTotalsFromServer,
    isLoading: isBundleSimLoading,
    isFetching: isBundleSimFetching,
  } = useBundlePricingSimulator(product.productId, bundleSimEnabled, bundleSimCriteria);

  const isBundleSimRefreshing = Boolean(
    bundleSimEnabled && isBundleSimFetching && bundleTotalsFromServer
  );

  const bundleTotalsByTier =
    bundleTotalsFromServer ??
    BUNDLE_TIERS.map((t) => ({
      tier: t,
      totalPremium: 0,
      subtotalWithIncluded: 0,
      nonIncludedSubtotal: 0,
      processingFee: 0,
      systemFees: 0,
      matchedProducts: 0,
      totalProducts: 0,
    }));

  const renderDetailsTab = () => (
    <div className="space-y-6">
      {/* Product Information */}
      <div>
        <h3 className="text-lg font-medium text-gray-900 mb-4">Product Information</h3>
        <div className="bg-gray-50 rounded-lg p-4 space-y-3">
          <div className="flex justify-between">
            <span className="text-gray-600">Product Name</span>
            <span className="font-medium">{product.productName}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Product Type</span>
            <span className="font-medium">{product.productType}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Status</span>
            <span className="font-medium">{product.subscriptionStatus}</span>
          </div>
          {product.isBundle && (
            <div className="flex justify-between">
              <span className="text-gray-600">Product Bundle</span>
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                <Package className="h-3 w-3 mr-1" />
                Bundle with {product.bundleProducts?.length || 0} products
              </span>
            </div>
          )}
          {product.allowedStates && product.allowedStates.length > 0 && (
            <div className="flex justify-between">
              <span className="text-gray-600">Available In</span>
              <span className="font-medium">
                {product.allowedStates.join(', ')}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Bundle Products */}
      {product.isBundle && product.bundleProducts && product.bundleProducts.length > 0 && (
        <div>
          <h3 className="text-lg font-medium text-gray-900 mb-4">Bundle Products ({product.bundleProducts.length})</h3>
          <div className="space-y-3">
            {product.bundleProducts.map((bundleProduct) => (
              <div key={bundleProduct.productId} className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center space-x-2">
                      <h4 className="font-medium text-gray-900">{bundleProduct.name}</h4>
                      {bundleProduct.isRequired && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
                          Required
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-gray-600 mt-1">{bundleProduct.productType}</p>
                    {bundleProduct.description && (
                      <p className="text-sm text-gray-700 mt-2">{bundleProduct.description}</p>
                    )}
                  </div>
                  <ProductDocumentsLinks
                    product={bundleProduct}
                    variant="button"
                    size="md"
                    label="View Document"
                    className="ml-4"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Product Owner Contact */}
      {showProductOwnerContact && (
        <div>
          <h3 className="text-lg font-medium text-gray-900 mb-4">Product Owner Contact</h3>
          <div className="bg-gray-50 rounded-lg p-4 space-y-3">
            <div className="flex items-center space-x-2">
              <Building className="h-4 w-4 text-gray-400" />
              <span className="text-gray-600">Company:</span>
              <span className="font-medium">{product.productOwner.tenantName}</span>
            </div>
            {product.productOwner.contactPerson && (
              <div className="flex items-center space-x-2">
                <User className="h-4 w-4 text-gray-400" />
                <span className="text-gray-600">Contact:</span>
                <span className="font-medium">{product.productOwner.contactPerson}</span>
              </div>
            )}
            {product.productOwner.contactEmail && (
              <div className="flex items-center space-x-2">
                <Mail className="h-4 w-4 text-gray-400" />
                <span className="text-gray-600">Email:</span>
                <a href={`mailto:${product.productOwner.contactEmail}`} className="font-medium text-[#1f8dbf] hover:text-[#175a7a]">
                  {product.productOwner.contactEmail}
                </a>
              </div>
            )}
            {product.productOwner.contactPhone && (
              <div className="flex items-center space-x-2">
                <Phone className="h-4 w-4 text-gray-400" />
                <span className="text-gray-600">Phone:</span>
                <a href={`tel:${product.productOwner.contactPhone}`} className="font-medium text-[#1f8dbf] hover:text-[#175a7a]">
                  {product.productOwner.contactPhone}
                </a>
              </div>
            )}
          </div>
        </div>
      )}

      {product.description && (
        <div>
          <h3 className="text-lg font-medium text-gray-900 mb-3">Description</h3>
          <div className="bg-gray-50 rounded-lg p-4">
            <p className="text-sm text-gray-700">{product.description}</p>
          </div>
        </div>
      )}
      
      {/* Product Documentation in Details Tab */}
      {hasProductDocuments(product) && (
        <div>
          <h3 className="text-lg font-medium text-gray-900 mb-3">Product Documentation</h3>
          <div className="bg-gray-50 rounded-lg p-4">
            <ProductDocumentsLinks
              product={product}
              variant="button"
              size="md"
              label="View Product Documentation"
            />
          </div>
        </div>
      )}
    </div>
  );

  const renderPricingTab = () => {
    if (isPricingLoading) {
      return (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#1f8dbf]"></div>
        </div>
      );
    }

    if (!productPricing || productPricing.length === 0) {
      return (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-6 text-center text-gray-600">
          No pricing data available for this product.
        </div>
      );
    }

    const hasProductTabs = product.isBundle ? uniqueProductNames.length >= 1 : uniqueProductNames.length > 1;
    const pricingTabs = product.isBundle ? [BUNDLE_TAB_ID, ...uniqueProductNames] : uniqueProductNames;

    if (showingBundle) {
      const { ages, configOptions, configLabel } = bundleSimulatorOptions;
      return (
        <div className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h3 className="text-lg font-medium text-gray-900">Pricing</h3>
            {renderPricingExportButton()}
          </div>
          {hasProductTabs && (
            <div className="border-b border-gray-200">
              <nav className="-mb-px flex gap-4" aria-label="Pricing">
                {pricingTabs.map((tabId: string) => (
                  <button
                    key={tabId}
                    onClick={() => setSelectedPricingProductTab(tabId)}
                    className={`whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium ${
                      effectivePricingTab === tabId
                        ? 'border-[#1f8dbf] text-[#1f8dbf]'
                        : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
                    }`}
                  >
                    {tabId === BUNDLE_TAB_ID ? 'Bundle' : tabId}
                  </button>
                ))}
              </nav>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-gray-600">
              Estimated monthly total for the selected scenario (includes non-included processing fees and member-paid system fees). Included-fee products use the same baked-in premium for ACH and card.
            </p>
            {isBundleSimRefreshing && (
              <span
                className="inline-flex items-center gap-1.5 text-xs text-gray-500 shrink-0"
                role="status"
                aria-live="polite"
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[#1f8dbf]" aria-hidden />
                Updating prices…
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <label htmlFor="bundle-sim-tobacco" className="text-sm font-medium text-gray-700">Tobacco</label>
              <select
                id="bundle-sim-tobacco"
                value={bundleTobacco}
                onChange={(e) => setBundleTobacco(e.target.value as 'Y' | 'N')}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
              >
                <option value="N">No</option>
                <option value="Y">Yes</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor="bundle-sim-age" className="text-sm font-medium text-gray-700">Age</label>
              <select
                id="bundle-sim-age"
                value={effectiveBundleAge}
                onChange={(e) => setBundleAge(Number(e.target.value))}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
              >
                {ages.map(age => (
                  <option key={age} value={age}>{age}</option>
                ))}
              </select>
            </div>
            {configOptions.length > 0 && (
              <div className="flex items-center gap-2">
                <label htmlFor="bundle-sim-config" className="text-sm font-medium text-gray-700">{configLabel || 'Configuration'}</label>
                <select
                  id="bundle-sim-config"
                  value={effectiveBundleConfig}
                  onChange={(e) => setBundleConfigValue(e.target.value)}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
                >
                  {configOptions.map(opt => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex items-center gap-2">
              <label htmlFor="bundle-pay-method" className="text-sm font-medium text-gray-700">Payment Method</label>
              <select
                id="bundle-pay-method"
                value={pricingPaymentMethod}
                onChange={(e) => setPricingPaymentMethod(e.target.value as 'ACH' | 'Card')}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
              >
                <option value="ACH">ACH</option>
                <option value="Card">Credit card</option>
              </select>
            </div>
          </div>
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            {isBundleSimLoading && !bundleTotalsFromServer ? (
              <div className="flex items-center justify-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#1f8dbf]" />
              </div>
            ) : (
            <table
              className={`min-w-full divide-y divide-gray-200 transition-opacity duration-150 ${
                isBundleSimRefreshing ? 'opacity-60' : 'opacity-100'
              }`}
            >
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Tier</th>
                  <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                    <span className="inline-flex items-center justify-end gap-1.5">
                      Total premium (est.)
                      {isBundleSimRefreshing && (
                        <Loader2
                          className="h-3 w-3 animate-spin text-[#1f8dbf]"
                          aria-label="Updating prices"
                        />
                      )}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white">
                {bundleTotalsByTier.map((row) => (
                  <tr key={row.tier} className="hover:bg-gray-50">
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-900">
                      {formatFamilyCoverageTierLabel(row.tier)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-900 text-right">
                      {(() => {
                        const allIn =
                          row.totalPremium > 0
                            ? row.totalPremium
                            : row.subtotalWithIncluded > 0
                              ? row.subtotalWithIncluded
                              : 0;
                        if (allIn <= 0) return '—';
                        return (
                          <div>
                            <div className="font-medium">{formatMemberPremiumAmount(allIn)}</div>
                            {(() => {
                              const paymentProcessingFee =
                                Number(row.processingFee || 0) + Number(row.systemFees || 0);
                              if (paymentProcessingFee <= 0) return null;
                              return (
                              <div className="mt-1 space-y-0.5 text-xs text-gray-500 text-right">
                                {row.subtotalWithIncluded > 0 &&
                                  row.subtotalWithIncluded !== allIn && (
                                  <p>Plans {formatMemberPremiumAmount(row.subtotalWithIncluded)}</p>
                                )}
                                <p>Payment Processing Fee +${paymentProcessingFee.toFixed(2)}</p>
                              </div>
                              );
                            })()}
                          </div>
                        );
                      })()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            )}
          </div>
        </div>
      );
    }

    // Use tier types as returned from oe.ProductPricing (no hardcoded tier list).
    const tierTypes = Array.from(
      new Set(
        (pricingForCurrentTab ?? [])
          .map(p => (p.TierType ?? '').toString().trim().toUpperCase())
          .filter(Boolean)
      )
    ).sort(compareFamilyTierTypes);

    const tierOptions: { value: TierFilter; label: string }[] = [
      { value: 'All', label: 'All' },
      ...tierTypes.map(t => ({ value: t, label: formatTierType(t) }))
    ];

    const filteredByTobacco = tobaccoFilter === 'All'
      ? (pricingForCurrentTab ?? [])
      : (pricingForCurrentTab ?? []).filter(p => tobaccoFilterValue(p.TobaccoStatus) === tobaccoFilter);

    const filteredByTier = tierFilter === 'All'
      ? filteredByTobacco
      : filteredByTobacco.filter(p => (p.TierType ?? '').toUpperCase() === tierFilter);

    const displayRows = [...filteredByTier].sort((a, b) => {
      const tierCmp = compareFamilyTierTypes(
        (a.TierType ?? '').toString(),
        (b.TierType ?? '').toString()
      );
      if (tierCmp !== 0) return tierCmp;
      return (a.MinAge ?? 0) - (b.MinAge ?? 0);
    });

    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-medium text-gray-900">Pricing</h3>
            {!product.isBundle && (
              <p className="mt-1 text-xs text-gray-500">
                Amounts include applicable per-product fees where configured on the subscription (included processing and fixed product system fees). Tenant platform fees on base premium are not included here.
              </p>
            )}
          </div>
          {renderPricingExportButton()}
        </div>
        {hasProductTabs && (
          <div className="border-b border-gray-200">
            <nav className="-mb-px flex gap-4" aria-label="Pricing">
              {pricingTabs.map((tabId: string) => (
                <button
                  key={tabId}
                  onClick={() => setSelectedPricingProductTab(tabId)}
                  className={`whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium ${
                    effectivePricingTab === tabId
                      ? 'border-[#1f8dbf] text-[#1f8dbf]'
                      : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
                  }`}
                >
                  {tabId === BUNDLE_TAB_ID ? 'Bundle' : tabId}
                </button>
              ))}
            </nav>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <label htmlFor="pricing-tobacco" className="text-sm font-medium text-gray-700">Tobacco</label>
            <select
              id="pricing-tobacco"
              value={tobaccoFilter}
              onChange={(e) => setTobaccoFilter(e.target.value as TobaccoFilter)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
            >
              <option value="All">All</option>
              <option value="Y">Y</option>
              <option value="N">N</option>
              <option value="N/A">N/A</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="pricing-tier" className="text-sm font-medium text-gray-700">Family size tier</label>
            <select
              id="pricing-tier"
              value={tierFilter}
              onChange={(e) => setTierFilter(e.target.value as TierFilter)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
            >
              {tierOptions.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="pricing-pay-method" className="text-sm font-medium text-gray-700">Payment Method</label>
            <select
              id="pricing-pay-method"
              value={pricingPaymentMethod}
              onChange={(e) => setPricingPaymentMethod(e.target.value as 'ACH' | 'Card')}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-[#1f8dbf] focus:border-[#1f8dbf]"
            >
              <option value="ACH">ACH</option>
              <option value="Card">Card</option>
            </select>
          </div>
        </div>
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Name
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Age Band
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Premium
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Tobacco
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {displayRows.map((pricing, index) => (
                <tr key={`${pricing.Label}-${pricing.MinAge}-${pricing.MaxAge}-${index}`} className="hover:bg-gray-50">
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-900">
                    {formatPricingLabel(pricing)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">
                    {pricing.MinAge != null && pricing.MaxAge != null
                      ? `${pricing.MinAge}–${pricing.MaxAge}`
                      : 'All Ages'}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600 align-top min-w-[11rem]">
                    {(() => {
                      const pt = pricing.computedMemberDisplay;
                      if (!pt) return '—';
                      return renderMemberPremiumDisplay(pt);
                    })()}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">
                    {pricing.TobaccoStatus ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {product.isBundle && (
          <p className="text-xs text-gray-500">
            Product tabs: MSRP (or net) plus per-product fees where configured. Use the Bundle tab for the full scenario total including tenant platform fees and payment method for non-included processing.
          </p>
        )}
      </div>
    );
  };

  const formatCommissionMoney = (n: number) =>
    new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

  /** Render a row's per-tier value for one of EE/ES/EC/EF. */
  const formatRowTier = (
    row: AgentProductCommissionPreview['rows'][number],
    tier: 'EE' | 'ES' | 'EC' | 'EF'
  ): string => {
    if (row.payoutMode === 'percent') {
      if (row.familyPercent && Object.keys(row.familyPercent).length > 0) {
        return row.familyPercent[tier] ?? '—';
      }
      return row.percentLabel ?? '—';
    }
    if (row.familyFlat && Object.keys(row.familyFlat).length > 0) {
      const v = row.familyFlat[tier];
      return v != null ? formatCommissionMoney(v) : '—';
    }
    return row.flatAmount != null ? formatCommissionMoney(row.flatAmount) : '—';
  };

  const renderCommissionsTab = () => {
    // Agent + bundle: no dropdown, render each child's preview block stacked with a product header.
    // Same data / same calculation as before — just pulled for every child at once.
    if (bundleCommissionTableActive) {
      const anyLoading = bundleCommissionQueries.some((q) => q.isLoading);
      const anyFetching = bundleCommissionQueries.some((q) => q.isFetching);
      const anyError = bundleCommissionQueries.some((q) => q.error);

      if (anyLoading) {
        return (
          <div className="space-y-4">
            {downlinePicker}
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary" />
            </div>
          </div>
        );
      }
      if (anyError) {
        return (
          <div className="space-y-4">
            {downlinePicker}
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              Could not load commission information for one or more bundle products.
            </div>
          </div>
        );
      }

      type BundleTierBucket = { label: string; EE: number; ES: number; EC: number; EF: number };
      const tierBuckets = new Map<number, BundleTierBucket>();
      let hasAnyFlat = false;
      let hasPercentSkipped = false;

      const addFlatRowToBucket = (bucket: BundleTierBucket, row: AgentProductCommissionPreview['rows'][number]) => {
        if (row.familyFlat && Object.keys(row.familyFlat).length > 0) {
          bucket.EE += row.familyFlat.EE ?? 0;
          bucket.ES += row.familyFlat.ES ?? 0;
          bucket.EC += row.familyFlat.EC ?? 0;
          bucket.EF += row.familyFlat.EF ?? 0;
        } else if (row.flatAmount != null) {
          bucket.EE += row.flatAmount;
          bucket.ES += row.flatAmount;
          bucket.EC += row.flatAmount;
          bucket.EF += row.flatAmount;
        }
      };

      for (const q of bundleCommissionQueries) {
        const preview = q.data;
        if (!preview || !preview.hasPayout) continue;
        const viewerTenant = preview.viewerRole === 'tenant';
        const showAll = viewerTenant || preview.agentsCanViewOtherCommissionLevels;
        const rows = showAll ? preview.rows : preview.rows.filter((r) => r.isAgentLevel);
        for (const row of rows) {
          if (row.payoutMode === 'percent') {
            hasPercentSkipped = true;
            continue;
          }
          hasAnyFlat = true;
          let bucket = tierBuckets.get(row.levelSortOrder);
          if (!bucket) {
            bucket = { label: row.label, EE: 0, ES: 0, EC: 0, EF: 0 };
            tierBuckets.set(row.levelSortOrder, bucket);
          }
          addFlatRowToBucket(bucket, row);
        }
      }

      const sortedTierBuckets = [...tierBuckets.entries()].sort((a, b) => a[0] - b[0]);

      const thClass =
        'px-3 py-2 text-xs font-medium text-gray-500 uppercase tracking-wider';
      const tierThClass =
        'px-3 py-2 text-xs font-medium text-gray-500 normal-case tracking-normal text-right leading-snug max-w-[10rem]';
      const tdBase = 'px-3 py-2 text-sm';

      return (
        <div className="space-y-2">
          {downlinePicker}
          {anyFetching && !anyLoading && selectedDownlineAgentId.trim() && (
            <p className="text-xs text-gray-500 flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-oe-primary" aria-hidden />
              Updating commissions for selected agent…
            </p>
          )}
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className={`${thClass} text-left`}>Product</th>
                  <th className={`${thClass} text-left`}>Level</th>
                  <th className={tierThClass}>{formatFamilyCoverageTierLabel('EE')}</th>
                  <th className={tierThClass}>{formatFamilyCoverageTierLabel('ES')}</th>
                  <th className={tierThClass}>{formatFamilyCoverageTierLabel('EC')}</th>
                  <th className={tierThClass}>{formatFamilyCoverageTierLabel('EF')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white">
                {bundleChildren.map((child, idx) => {
                  const preview = bundleCommissionQueries[idx]?.data;

                  if (!preview || !preview.hasPayout) {
                    return (
                      <tr key={child.productId} className="bg-gray-50">
                        <td className={`${tdBase} text-gray-900 font-medium`}>{child.name}</td>
                        <td colSpan={5} className={`${tdBase} italic text-gray-500`}>
                          {preview?.message || 'Does not pay commission.'}
                        </td>
                      </tr>
                    );
                  }

                  const viewerTenant = preview.viewerRole === 'tenant';
                  const showAll = viewerTenant || preview.agentsCanViewOtherCommissionLevels;
                  const displayRows = showAll
                    ? preview.rows
                    : preview.rows.filter((r) => r.isAgentLevel);

                  if (displayRows.length === 0) {
                    return (
                      <tr key={child.productId} className="bg-gray-50">
                        <td className={`${tdBase} text-gray-900 font-medium`}>{child.name}</td>
                        <td colSpan={5} className={`${tdBase} italic text-gray-500`}>
                          {viewerTenant
                            ? 'No Tier payout configured for this product in the selected commission group.'
                            : `Your level (${preview.agentLevel.displayName}) has no payout row in this rule.`}
                        </td>
                      </tr>
                    );
                  }

                  return (
                    <React.Fragment key={child.productId}>
                      {displayRows.map((row, ridx) => {
                        const highlight = row.isAgentLevel && !viewerTenant;
                        const rowClass = highlight ? 'bg-oe-light' : '';
                        const textClass = highlight ? 'text-oe-dark font-medium' : 'text-gray-900';
                        return (
                          <tr
                            key={`${child.productId}-${row.levelSortOrder}-${ridx}`}
                            className={rowClass}
                          >
                            <td className={`${tdBase} ${ridx === 0 ? 'font-medium text-gray-900' : 'text-gray-500'}`}>
                              {ridx === 0 ? child.name : ''}
                            </td>
                            <td className={`${tdBase} ${textClass}`}>
                              {row.label}
                              {highlight && (
                                <span className="ml-1 text-xs font-normal">
                                  ({preview.viewerRole === 'downlineAgent'
                                    ? (preview.subjectAgentName ?? 'agent')
                                    : 'you'})
                                </span>
                              )}
                            </td>
                            <td className={`${tdBase} text-right ${textClass}`}>
                              {formatRowTier(row, 'EE')}
                            </td>
                            <td className={`${tdBase} text-right ${textClass}`}>
                              {formatRowTier(row, 'ES')}
                            </td>
                            <td className={`${tdBase} text-right ${textClass}`}>
                              {formatRowTier(row, 'EC')}
                            </td>
                            <td className={`${tdBase} text-right ${textClass}`}>
                              {formatRowTier(row, 'EF')}
                            </td>
                          </tr>
                        );
                      })}
                    </React.Fragment>
                  );
                })}
              </tbody>
              {hasAnyFlat && sortedTierBuckets.length > 0 && (
                <tfoot className="bg-green-50">
                  {sortedTierBuckets.map(([level, bucket]) => (
                    <tr key={`bundle-total-${level}`}>
                      <td colSpan={2} className={`${tdBase} font-semibold text-green-900`}>
                        Bundle total · {bucket.label}
                      </td>
                      <td className={`${tdBase} text-right font-semibold text-green-900`}>
                        {formatCommissionMoney(bucket.EE)}
                      </td>
                      <td className={`${tdBase} text-right font-semibold text-green-900`}>
                        {formatCommissionMoney(bucket.ES)}
                      </td>
                      <td className={`${tdBase} text-right font-semibold text-green-900`}>
                        {formatCommissionMoney(bucket.EC)}
                      </td>
                      <td className={`${tdBase} text-right font-semibold text-green-900`}>
                        {formatCommissionMoney(bucket.EF)}
                      </td>
                    </tr>
                  ))}
                </tfoot>
              )}
            </table>
          </div>
          {hasPercentSkipped && (
            <p className="text-xs text-gray-500">
              Percent-based products are not included in the bundle total.
            </p>
          )}
        </div>
      );
    }

    if (tenantCommissionViewer && commissionGroupsLoading) {
      return (
        <div className="space-y-4">
          {bundleProductPicker}
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary" />
          </div>
        </div>
      );
    }
    if (tenantCommissionViewer && commissionGroupsError) {
      return (
        <div className="space-y-4">
          {bundleProductPicker}
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            Could not load commission groups. Try again later.
          </div>
        </div>
      );
    }
    if (tenantCommissionViewer && commissionGroups.length === 0) {
      return (
        <div className="space-y-4">
          {bundleProductPicker}
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-6 text-center text-gray-700 text-sm">
            No active commission groups for this tenant. Create one under Commission Rules.
          </div>
        </div>
      );
    }

    const tenantGroupPicker =
      tenantCommissionViewer && commissionGroups.length > 0 ? (
        <div className="mb-4">
          <label className="block text-xs font-medium text-gray-700 mb-1">Commission group</label>
          <SearchableDropdown
            options={commissionGroupDropdownOptions}
            value={effectiveCommissionGroupId ?? ''}
            onChange={(value) => setSelectedCommissionGroupId(value)}
            placeholder="Select a commission group"
            searchPlaceholder="Search groups..."
            loading={isCommissionPreviewLoading}
            disabled={commissionGroups.length === 0}
            className="w-full"
          />
        </div>
      ) : null;

    if (!tenantCommissionViewer && isCommissionPreviewLoading) {
      return (
        <div className="space-y-4">
          {bundleProductPicker}
          {downlinePicker}
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary" />
          </div>
        </div>
      );
    }
    if (tenantCommissionViewer && isCommissionPreviewLoading) {
      return (
        <div className="space-y-4">
          {bundleProductPicker}
          {tenantGroupPicker}
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary" />
          </div>
        </div>
      );
    }
    if (commissionPreviewError) {
      return (
        <div className="space-y-4">
          {bundleProductPicker}
          {downlinePicker}
          {tenantGroupPicker}
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            Could not load commission information. Try again later.
          </div>
        </div>
      );
    }
    if (!commissionPreview) {
      return (
        <div className="space-y-4">
          {bundleProductPicker}
          {downlinePicker}
          {tenantGroupPicker}
        </div>
      );
    }

    const viewerTenant = commissionPreview.viewerRole === 'tenant';
    const showAll = viewerTenant || commissionPreview.agentsCanViewOtherCommissionLevels;
    const displayRows = showAll
      ? commissionPreview.rows
      : commissionPreview.rows.filter((r) => r.isAgentLevel);

    const sourceLabel =
      commissionPreview.ruleSource === 'product'
        ? 'This product'
        : commissionPreview.ruleSource === 'allProducts'
          ? 'All products (default)'
          : null;

    const hasPercentRow = commissionPreview.rows.some((r) => r.payoutMode === 'percent');

    if (!commissionPreview.hasPayout) {
      return (
        <div className="space-y-4">
          {bundleProductPicker}
          {downlinePicker}
          {tenantGroupPicker}
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-6 text-center text-gray-700 text-sm">
            {commissionPreview.message || 'This product does not pay out commission.'}
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        {bundleProductPicker}
        {downlinePicker}
        {tenantGroupPicker}
        {commissionPreview.ruleName && (
          <div>
            <h3 className="text-sm font-medium text-gray-900">{commissionPreview.ruleName}</h3>
            {sourceLabel && <p className="text-xs text-gray-500 mt-0.5">{sourceLabel}</p>}
          </div>
        )}
        {!commissionPreview.ruleName && sourceLabel && (
          <p className="text-xs text-gray-500">{sourceLabel}</p>
        )}

        <CommissionTierTable
          rows={displayRows}
          viewerTenant={viewerTenant}
          agentLevelDisplayName={commissionPreview.agentLevel.displayName}
          highlightPillLabel={
            commissionPreview.viewerRole === 'downlineAgent'
              ? (commissionPreview.subjectAgentName ?? undefined)
              : undefined
          }
        />

        {hasPercentRow && (
          <p className="text-xs text-gray-500">
            Percentages apply to the commission allocation for the sale (not the full premium).
          </p>
        )}

        {!viewerTenant && !showAll && commissionPreview.rows.length > 1 && (
          <p className="text-xs text-gray-500">
            Other commission levels are hidden for your group. Only your level is shown.
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-gray-900">Product Details</h2>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-500">
              <XCircle className="h-6 w-6" />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="border-b border-gray-200">
          <nav className="flex -mb-px">
            <button
              onClick={() => setActiveTab('details')}
              className={`py-3 px-6 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'details'
                  ? 'border-[#1f8dbf] text-[#1f8dbf]'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Details
            </button>
            <button
              onClick={() => setActiveTab('pricing')}
              className={`py-3 px-6 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'pricing'
                  ? 'border-[#1f8dbf] text-[#1f8dbf]'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              Pricing
            </button>
            {showCommissionsTab && (
              <button
                type="button"
                onClick={() => setActiveTab('commissions')}
                className={`py-3 px-6 text-sm font-medium border-b-2 transition-colors inline-flex items-center gap-2 ${
                  activeTab === 'commissions'
                    ? 'border-[#1f8dbf] text-[#1f8dbf]'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                <Wallet className="h-4 w-4" />
                Commissions
              </button>
            )}
            {showSubscribersTab && (
              <button
                type="button"
                onClick={() => setActiveTab('subscribers')}
                className={`py-3 px-6 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === 'subscribers'
                    ? 'border-[#1f8dbf] text-[#1f8dbf]'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                Subscribers
              </button>
            )}
          </nav>
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'details' && renderDetailsTab()}
          {activeTab === 'pricing' && renderPricingTab()}
          {showCommissionsTab && activeTab === 'commissions' && renderCommissionsTab()}
          {showSubscribersTab && activeTab === 'subscribers' && product.productId && (
            <ProductSubscribersPanel
              productId={product.productId}
              productName={product.productName}
              ownerView={subscribersTabOwnerView}
              onChanged={onSubscribersChanged}
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end space-x-3 p-6 border-t border-gray-200">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-white bg-[#1f8dbf] border border-transparent rounded-md hover:bg-[#175a7a]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default SubscribedProductDetailsModal;
