// frontend/src/pages/vendor/VendorProductDetailsModal.tsx
import React, { useEffect, useMemo, useState } from 'react';
import {
  X,
  FileText,
  Package,
  Layers,
  MapPin,
  DollarSign,
} from 'lucide-react';
import { apiService } from '../../services/api.service';
import ProductDocumentsLinks from '../../components/shared/ProductDocumentsLinks';
import type { ProductDocumentItem } from '../../utils/productDocuments';

export interface BundleProductSummary {
  productId: string;
  name: string;
  productType?: string;
  description?: string;
  status?: string;
  isRequired?: boolean;
  sortOrder?: number;
  productLogoUrl?: string | null;
  productDocuments?: ProductDocumentItem[];
}

export interface VendorProductDetails {
  ProductId: string;
  ProductName?: string;
  Name?: string;
  Description?: string;
  ProductType?: string;
  SalesType?: string;
  Status?: string;
  Price?: number;
  IsBundle?: boolean;
  IsVendorPrice?: boolean;
  VendorCommission?: number;
  ProductImageUrl?: string;
  ProductLogoUrl?: string;
  ProductDocumentUrl?: string;
  productDocuments?: ProductDocumentItem[];
  BundleProducts?: BundleProductSummary[];
  MinAge?: number;
  MaxAge?: number;
  AllowedStates?: string;
  RequiresTobaccoInfo?: boolean;
  EffectiveDateLogic?: string;
  TerminationLogic?: string;
  RequiredLicenses?: string;
  CreatedDate?: string;
  ModifiedDate?: string;
}

interface PricingRow {
  ProductPricingId: string;
  ProductId: string;
  ProductName?: string | null;
  Label?: string;
  TierType?: string | null;
  TobaccoStatus?: string | null;
  MinAge?: number | null;
  MaxAge?: number | null;
  NetRate?: number;
  MSRPRate?: number;
  VendorCommission?: number;
  ConfigField1?: string; ConfigValue1?: string;
  ConfigField2?: string; ConfigValue2?: string;
  ConfigField3?: string; ConfigValue3?: string;
  ConfigField4?: string; ConfigValue4?: string;
  ConfigField5?: string; ConfigValue5?: string;
  EffectiveDate?: string;
  TerminationDate?: string | null;
  Status?: string;
}

interface Props {
  product: VendorProductDetails;
  onClose: () => void;
}

const TIER_LABELS: Record<string, string> = {
  EE: 'Individual',
  ES: 'Individual + Spouse',
  EC: 'Individual + Child(ren)',
  EF: 'Family',
};

const formatCurrency = (n: number | undefined | null): string => {
  if (n === undefined || n === null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
};

const formatDate = (s?: string | null): string => {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
};

const statusBadge = (status?: string) => {
  const s = (status || '').toLowerCase();
  if (s === 'active') return 'bg-green-100 text-green-800';
  if (s === 'inactive' || s === 'archived') return 'bg-gray-200 text-gray-700';
  if (s === 'pending' || s === 'draft') return 'bg-yellow-100 text-yellow-800';
  return 'bg-gray-100 text-gray-700';
};

const parseStates = (raw?: string): string[] => {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((s) => String(s || '').trim()).filter(Boolean);
      }
    } catch (_) {
      // fall through to CSV
    }
  }
  return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
};

const ageBand = (min?: number | null, max?: number | null): string => {
  const hasMin = min !== undefined && min !== null;
  const hasMax = max !== undefined && max !== null;
  if (!hasMin && !hasMax) return 'All ages';
  if (hasMin && hasMax) return `${min}–${max}`;
  if (hasMin) return `${min}+`;
  return `≤ ${max}`;
};

const SALES_TYPE_LABELS: Record<string, string> = {
  Both: 'Individual & Group',
  Individual: 'Individual only',
  Group: 'Group only',
};

const SALES_TYPE_TOOLTIPS: Record<string, string> = {
  Both: 'Sales channel: sold through both individual checkout and group enrollment',
  Individual: 'Sales channel: sold direct-to-member only (no group enrollment)',
  Group: 'Sales channel: sold via group/employer enrollment only',
};

const tobaccoLabel = (t?: string | null): string => {
  if (!t) return 'N/A';
  const v = String(t).trim().toUpperCase();
  if (v === 'Y' || v === 'YES' || v === 'TRUE') return 'Yes';
  if (v === 'N' || v === 'NO' || v === 'FALSE') return 'No';
  return v;
};

const UNSHARED_RE = /unshared\s*amount/i;

const getUnsharedAmount = (row: PricingRow): string | null => {
  for (let i = 1; i <= 5; i += 1) {
    const field = String((row as any)[`ConfigField${i}`] || '').trim();
    const value = String((row as any)[`ConfigValue${i}`] || '').trim();
    if (value && UNSHARED_RE.test(field)) return value;
  }
  return null;
};

const formatUnsharedAmount = (raw: string): string => {
  const n = Number(String(raw).replace(/[^0-9.\-]/g, ''));
  if (!Number.isFinite(n) || n === 0) return raw;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
};

type TabKey = 'details' | 'pricing';

const BUNDLE_PRICING_KEY = '__bundle__';
const BUNDLE_SIM_TIERS = ['EE', 'ES', 'EC', 'EF'] as const;

const premiumFromRow = (row: PricingRow): number => {
  const msrp = Number(row.MSRPRate || 0);
  if (msrp > 0) return msrp;
  return Number(row.NetRate || 0);
};

// Mirrors backend pickBestBundleRowForTier — chooses the lowest-positive-premium row
// from a single child product matching the simulator's tier/age/tobacco/config inputs.
// Config filter is ConfigValue1 ONLY, matching the agent's behavior exactly.
const pickBestRowForTier = (
  rows: PricingRow[],
  tier: string,
  tobacco: 'Y' | 'N',
  age: number,
  configValue: string,
  tobaccoMode: 'strict' | 'na_only' | 'any',
): PricingRow | null => {
  const tierAge = rows.filter((r) => {
    const rt = String(r.TierType || '').toUpperCase().trim();
    if (rt && rt !== tier) return false;
    const min = r.MinAge != null ? Number(r.MinAge) : 0;
    const max = r.MaxAge != null ? Number(r.MaxAge) : 999;
    return age >= min && age <= max;
  });
  const tob = tierAge.filter((r) => {
    const rt = String(r.TobaccoStatus || '').trim().toUpperCase();
    const norm = rt === 'Y' || rt === 'YES' ? 'Y' : rt === 'N' || rt === 'NO' ? 'N' : 'N/A';
    if (tobaccoMode === 'any') return true;
    if (tobaccoMode === 'na_only') return norm === 'N/A';
    return norm === 'N/A' || norm === tobacco;
  });
  const cfg =
    configValue.trim().length > 0
      ? tob.filter((r) => String((r as any).ConfigValue1 || '').trim() === configValue.trim())
      : tob;
  const candidates = cfg.length > 0 ? cfg : tob;
  return candidates.reduce<PricingRow | null>((best, cur) => {
    const cp = premiumFromRow(cur);
    if (cp <= 0) return best;
    if (!best) return cur;
    return cp < premiumFromRow(best) ? cur : best;
  }, null);
};

const VendorProductDetailsModal: React.FC<Props> = ({ product, onClose }) => {
  const name = product.ProductName || product.Name || 'Untitled';
  const Icon = product.IsBundle ? Layers : Package;
  const showImage = product.ProductImageUrl || product.ProductLogoUrl;
  const states = useMemo(() => parseStates(product.AllowedStates), [product.AllowedStates]);

  const [tab, setTab] = useState<TabKey>('details');
  const [pricing, setPricing] = useState<PricingRow[]>([]);
  const [pricingLoading, setPricingLoading] = useState(false);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const [pricingFetched, setPricingFetched] = useState(false);

  const [tierFilter, setTierFilter] = useState<string>('');
  const [tobaccoFilter, setTobaccoFilter] = useState<string>('');
  const [unsharedFilter, setUnsharedFilter] = useState<string>('');
  const [bundlePricingTab, setBundlePricingTab] = useState<string>(BUNDLE_PRICING_KEY);

  // Bundle simulator inputs
  const [simAge, setSimAge] = useState<number>(35);
  const [simTobacco, setSimTobacco] = useState<'Y' | 'N'>('N');
  const [simConfigValue, setSimConfigValue] = useState<string>('');

  useEffect(() => {
    if (tab !== 'pricing' || pricingFetched) return;
    let cancelled = false;
    (async () => {
      setPricingLoading(true);
      setPricingError(null);
      try {
        const res = await apiService.get<{ success: boolean; data?: PricingRow[]; message?: string }>(
          `/api/me/vendor/products/${product.ProductId}/pricing`
        );
        if (cancelled) return;
        if (res?.success) {
          setPricing(res.data || []);
        } else {
          setPricingError(res?.message || 'Failed to load pricing');
        }
      } catch (err: any) {
        if (cancelled) return;
        setPricingError(err?.message || 'Failed to load pricing');
      } finally {
        if (!cancelled) {
          setPricingLoading(false);
          setPricingFetched(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, pricingFetched, product.ProductId]);

  // Distinct product names across pricing rows (bundle case only — single products return null)
  const bundleProductNames = useMemo(() => {
    if (!product.IsBundle) return [];
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const row of pricing) {
      const n = row.ProductName?.trim();
      if (n && !seen.has(n)) {
        seen.add(n);
        ordered.push(n);
      }
    }
    return ordered;
  }, [pricing, product.IsBundle]);

  // Rows for the currently selected pricing inner tab. Bundle tab uses a separate
  // simulator (see bundleSimulatorTiers) and ignores this list.
  const pricingForActiveBundleTab = useMemo(() => {
    if (!product.IsBundle || bundlePricingTab === BUNDLE_PRICING_KEY) return pricing;
    return pricing.filter((row) => row.ProductName === bundlePricingTab);
  }, [pricing, bundlePricingTab, product.IsBundle]);

  // Bundle simulator options: age range + ConfigValue1 distinct values + ConfigField1 label.
  // Mirrors the agent's SubscribedProductDetailsModal.bundleSimulatorOptions exactly.
  const bundleSimOptions = useMemo(() => {
    if (!product.IsBundle) {
      return { ageMin: 18, ageMax: 64, ages: [] as number[], configOptions: [] as string[], configLabel: '' };
    }
    let ageMin = 999;
    let ageMax = 0;
    const configValues = new Set<string>();
    let configLabel = '';
    for (const p of pricing) {
      if (p.MinAge != null) ageMin = Math.min(ageMin, p.MinAge);
      if (p.MaxAge != null) ageMax = Math.max(ageMax, p.MaxAge);
      const cv1 = String((p as any).ConfigValue1 ?? '').trim();
      if (cv1) {
        configValues.add(cv1);
        if (!configLabel) {
          const cf1 = String((p as any).ConfigField1 ?? '').trim();
          if (cf1) configLabel = cf1;
        }
      }
    }
    if (ageMin === 999) ageMin = 18;
    if (ageMax === 0) ageMax = 64;
    const ages = Array.from({ length: ageMax - ageMin + 1 }, (_, i) => ageMin + i);
    const configOptions = Array.from(configValues).sort(
      (a, b) => Number(a) - Number(b) || a.localeCompare(b)
    );
    return { ageMin, ageMax, ages, configOptions, configLabel: configLabel || 'Configuration' };
  }, [pricing, product.IsBundle]);

  // Default the simulator's config selection to the first option and clamp age to the data range.
  useEffect(() => {
    if (!product.IsBundle) return;
    if (simConfigValue === '' && bundleSimOptions.configOptions.length > 0) {
      setSimConfigValue(bundleSimOptions.configOptions[0]);
    }
  }, [bundleSimOptions.configOptions, simConfigValue, product.IsBundle]);

  useEffect(() => {
    if (!product.IsBundle || bundleSimOptions.ages.length === 0) return;
    if (simAge < bundleSimOptions.ageMin || simAge > bundleSimOptions.ageMax) {
      setSimAge(Math.max(bundleSimOptions.ageMin, Math.min(bundleSimOptions.ageMax, simAge)));
    }
  }, [bundleSimOptions.ageMin, bundleSimOptions.ageMax, bundleSimOptions.ages.length, simAge, product.IsBundle]);

  // Per-tier bundle simulator totals — sum the best-match row from each included product.
  const bundleSimulatorTiers = useMemo(() => {
    if (!product.IsBundle) return [];
    const productNames = Array.from(
      new Set(pricing.map((r) => r.ProductName).filter(Boolean) as string[])
    );
    return BUNDLE_SIM_TIERS.map((tier) => {
      let netRate = 0;
      let msrp = 0;
      let matched = 0;
      for (const pn of productNames) {
        const rows = pricing.filter((r) => r.ProductName === pn);
        let best = pickBestRowForTier(rows, tier, simTobacco, simAge, simConfigValue, 'strict');
        if (!best) best = pickBestRowForTier(rows, tier, simTobacco, simAge, simConfigValue, 'na_only');
        if (!best) best = pickBestRowForTier(rows, tier, simTobacco, simAge, simConfigValue, 'any');
        if (best) {
          netRate += Number(best.NetRate || 0);
          msrp += Number(best.MSRPRate || 0);
          matched += 1;
        }
      }
      return {
        tier,
        netRate,
        msrp,
        matchedProducts: matched,
        totalProducts: productNames.length,
      };
    });
  }, [pricing, simTobacco, simAge, simConfigValue, product.IsBundle]);

  const { tiers, tobaccoOptions, unsharedOptions } = useMemo(() => {
    const t = new Set<string>();
    const tb = new Set<string>();
    const ua = new Set<string>();
    for (const row of pricingForActiveBundleTab) {
      if (row.TierType) t.add(row.TierType);
      if (row.TobaccoStatus) tb.add(String(row.TobaccoStatus).toUpperCase());
      const u = getUnsharedAmount(row);
      if (u) ua.add(u);
    }
    const uaSorted = Array.from(ua).sort((a, b) => {
      const na = Number(String(a).replace(/[^0-9.\-]/g, ''));
      const nb = Number(String(b).replace(/[^0-9.\-]/g, ''));
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.localeCompare(b);
    });
    return {
      tiers: Array.from(t).sort(),
      tobaccoOptions: Array.from(tb).sort(),
      unsharedOptions: uaSorted,
    };
  }, [pricingForActiveBundleTab]);

  const filteredPricing = useMemo(() => {
    return pricingForActiveBundleTab.filter((row) => {
      if (tierFilter && row.TierType !== tierFilter) return false;
      if (tobaccoFilter && String(row.TobaccoStatus || '').toUpperCase() !== tobaccoFilter) return false;
      if (unsharedFilter && getUnsharedAmount(row) !== unsharedFilter) return false;
      return true;
    });
  }, [pricingForActiveBundleTab, tierFilter, tobaccoFilter, unsharedFilter]);


  const renderConfig = (row: PricingRow): React.ReactNode => {
    const pairs: { field: string; value: string }[] = [];
    for (let i = 1; i <= 5; i += 1) {
      const f = String((row as any)[`ConfigField${i}`] || '').trim();
      const v = String((row as any)[`ConfigValue${i}`] || '').trim();
      if (v) pairs.push({ field: f || `Field ${i}`, value: v });
    }
    if (pairs.length === 0) return <span className="text-gray-400">—</span>;
    return (
      <div className="flex flex-wrap gap-1">
        {pairs.map((p, idx) => (
          <span
            key={idx}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 text-xs"
            title={`${p.field}: ${p.value}`}
          >
            <span className="text-gray-500">{p.field}:</span>
            <span className="font-medium">{p.value}</span>
          </span>
        ))}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-gray-200 bg-gradient-to-r from-oe-primary/10 to-oe-primary/5">
          <div className="flex items-start gap-3 min-w-0 flex-1">
            {showImage ? (
              <div className="h-14 w-24 rounded-lg bg-white border border-gray-200 flex-shrink-0 p-1">
                <img
                  src={product.ProductLogoUrl || product.ProductImageUrl}
                  alt={name}
                  className="h-full w-full object-contain"
                />
              </div>
            ) : (
              <div className="h-14 w-24 rounded-lg bg-white flex items-center justify-center flex-shrink-0">
                <Icon className="h-7 w-7 text-oe-primary" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold text-gray-900 truncate">{name}</h2>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                {product.ProductType && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded bg-gray-100 text-gray-700">
                    {product.ProductType}
                  </span>
                )}
                {product.SalesType && (
                  <span
                    className="inline-flex items-center px-2 py-0.5 rounded bg-gray-100 text-gray-700 cursor-help"
                    title={SALES_TYPE_TOOLTIPS[product.SalesType] || `Sales channel: ${product.SalesType}`}
                  >
                    {SALES_TYPE_LABELS[product.SalesType] || product.SalesType}
                  </span>
                )}
                {product.Status && (
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded font-medium ${statusBadge(product.Status)}`}
                  >
                    {product.Status}
                  </span>
                )}
                {product.IsBundle && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-oe-light text-oe-dark font-medium">
                    <Layers className="h-3 w-3" />
                    Bundle
                  </span>
                )}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-3 p-2 rounded-md text-gray-500 hover:bg-gray-100 flex-shrink-0"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200 px-5 gap-1">
          <button
            type="button"
            onClick={() => setTab('details')}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === 'details'
                ? 'border-oe-primary text-gray-900'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            <FileText className="h-4 w-4" />
            Details
          </button>
          <button
            type="button"
            onClick={() => setTab('pricing')}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === 'pricing'
                ? 'border-oe-primary text-gray-900'
                : 'border-transparent text-gray-600 hover:text-gray-900'
            }`}
          >
            <DollarSign className="h-4 w-4" />
            Pricing
          </button>
        </div>

        {/* Body */}
        <div className="p-5 overflow-y-auto flex-1 min-w-0">
          {tab === 'details' && (
            <div className="space-y-6">
              {/* Product Information */}
              <section>
                <h3 className="text-lg font-medium text-gray-900 mb-3">Product Information</h3>
                <div className="bg-gray-50 rounded-lg p-4 space-y-3 text-sm">
                  <div className="flex justify-between gap-4">
                    <span className="text-gray-600 flex-shrink-0">Product Name</span>
                    <span className="font-medium text-gray-900 text-right break-words min-w-0">{name}</span>
                  </div>
                  {product.ProductType && (
                    <div className="flex justify-between gap-4">
                      <span className="text-gray-600 flex-shrink-0">Product Type</span>
                      <span className="font-medium text-gray-900">{product.ProductType}</span>
                    </div>
                  )}
                  {product.SalesType && (
                    <div className="flex justify-between gap-4">
                      <span className="text-gray-600 flex-shrink-0">Sales Channel</span>
                      <span
                        className="font-medium text-gray-900 cursor-help"
                        title={SALES_TYPE_TOOLTIPS[product.SalesType] || `Sales channel: ${product.SalesType}`}
                      >
                        {SALES_TYPE_LABELS[product.SalesType] || product.SalesType}
                      </span>
                    </div>
                  )}
                  {product.Status && (
                    <div className="flex justify-between gap-4">
                      <span className="text-gray-600 flex-shrink-0">Status</span>
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${statusBadge(product.Status)}`}
                      >
                        {product.Status}
                      </span>
                    </div>
                  )}
                  {product.IsBundle && (
                    <div className="flex justify-between gap-4">
                      <span className="text-gray-600 flex-shrink-0">Product Bundle</span>
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-oe-light text-oe-dark">
                        <Layers className="h-3 w-3 mr-1" />
                        Bundle with {product.BundleProducts?.length ?? 0} products
                      </span>
                    </div>
                  )}
                </div>
              </section>

              {/* Bundle Products */}
              {product.IsBundle && product.BundleProducts && product.BundleProducts.length > 0 && (
                <section>
                  <h3 className="text-lg font-medium text-gray-900 mb-3">
                    Bundle Products ({product.BundleProducts.length})
                  </h3>
                  <div className="space-y-3">
                    {product.BundleProducts.map((bp) => (
                      <div
                        key={bp.productId}
                        className="bg-gray-50 rounded-lg p-4 border border-gray-200"
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex items-start gap-3 min-w-0 flex-1">
                            {bp.productLogoUrl ? (
                              <img
                                src={bp.productLogoUrl}
                                alt={bp.name}
                                className="h-10 w-16 rounded bg-white object-contain p-1 border border-gray-200 flex-shrink-0"
                              />
                            ) : (
                              <div className="h-10 w-16 rounded bg-white border border-gray-200 flex items-center justify-center flex-shrink-0">
                                <Package className="h-5 w-5 text-oe-primary" />
                              </div>
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <h4 className="font-medium text-gray-900 truncate">{bp.name}</h4>
                                {bp.isRequired && (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
                                    Required
                                  </span>
                                )}
                              </div>
                              {bp.productType && (
                                <p className="text-sm text-gray-600 mt-1">{bp.productType}</p>
                              )}
                              {bp.description && (
                                <p className="text-sm text-gray-700 mt-2 line-clamp-3">{bp.description}</p>
                              )}
                            </div>
                          </div>
                          <div className="flex-shrink-0">
                            <ProductDocumentsLinks
                              product={{ productDocuments: bp.productDocuments }}
                              variant="button"
                              size="sm"
                              label="View Document"
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Eligibility */}
              <section>
                <h3 className="text-lg font-medium text-gray-900 mb-3">Eligibility</h3>
                <div className="bg-gray-50 rounded-lg p-4 space-y-3 text-sm">
                  <div className="flex justify-between gap-4">
                    <span className="text-gray-600 flex-shrink-0">Age range</span>
                    <span className="font-medium text-gray-900">
                      {product.MinAge ?? '—'} – {product.MaxAge ?? '—'}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-gray-600 flex-shrink-0">Requires tobacco info</span>
                    <span className="font-medium text-gray-900">
                      {product.RequiresTobaccoInfo ? 'Yes' : 'No'}
                    </span>
                  </div>
                  {product.RequiredLicenses && (
                    <div className="flex justify-between gap-4">
                      <span className="text-gray-600 flex-shrink-0">Required licenses</span>
                      <span className="font-medium text-gray-900 text-right break-words min-w-0">
                        {product.RequiredLicenses}
                      </span>
                    </div>
                  )}
                  {states.length > 0 && (
                    <div className="pt-1">
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <span className="text-gray-600">Available in</span>
                        <span className="text-xs text-gray-500">{states.length} state{states.length === 1 ? '' : 's'}</span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {states.map((s) => (
                          <span
                            key={s}
                            className="inline-flex items-center px-1.5 py-0.5 rounded bg-white border border-gray-200 text-gray-700 text-xs font-medium"
                          >
                            <MapPin className="h-3 w-3 mr-0.5 text-gray-400" />
                            {s}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </section>

              {/* Effective / Termination */}
              {(product.EffectiveDateLogic || product.TerminationLogic) && (
                <section>
                  <h3 className="text-lg font-medium text-gray-900 mb-3">Effective &amp; Termination</h3>
                  <div className="bg-gray-50 rounded-lg p-4 space-y-3 text-sm">
                    {product.EffectiveDateLogic && (
                      <div className="flex justify-between gap-4">
                        <span className="text-gray-600 flex-shrink-0">Effective date logic</span>
                        <span className="font-medium text-gray-900 text-right break-words min-w-0">
                          {product.EffectiveDateLogic}
                        </span>
                      </div>
                    )}
                    {product.TerminationLogic && (
                      <div className="flex justify-between gap-4">
                        <span className="text-gray-600 flex-shrink-0">Termination logic</span>
                        <span className="font-medium text-gray-900 text-right break-words min-w-0">
                          {product.TerminationLogic}
                        </span>
                      </div>
                    )}
                  </div>
                </section>
              )}

              {/* Description */}
              {product.Description && (
                <section>
                  <h3 className="text-lg font-medium text-gray-900 mb-3">Description</h3>
                  <div className="bg-gray-50 rounded-lg p-4">
                    <p className="text-sm text-gray-700 whitespace-pre-wrap break-words">
                      {product.Description}
                    </p>
                  </div>
                </section>
              )}

              {/* Product Documentation */}
              <section>
                <h3 className="text-lg font-medium text-gray-900 mb-3">Product Documentation</h3>
                <div className="bg-gray-50 rounded-lg p-4">
                  {product.productDocuments && product.productDocuments.length > 0 ? (
                    <ProductDocumentsLinks
                      product={{
                        productDocuments: product.productDocuments,
                        ProductDocumentUrl: product.ProductDocumentUrl,
                      }}
                      variant="button"
                      size="md"
                      label="View Product Documentation"
                    />
                  ) : product.ProductDocumentUrl ? (
                    <ProductDocumentsLinks
                      product={{ ProductDocumentUrl: product.ProductDocumentUrl }}
                      variant="button"
                      size="md"
                      label="View Product Documentation"
                    />
                  ) : (
                    <p className="text-sm text-gray-500">No documentation available.</p>
                  )}
                </div>
              </section>

              {/* Meta */}
              <section className="text-xs text-gray-500 grid grid-cols-1 sm:grid-cols-2 gap-2 border-t border-gray-100 pt-3">
                <div>Created: {formatDate(product.CreatedDate)}</div>
                <div>Last updated: {formatDate(product.ModifiedDate)}</div>
              </section>
            </div>
          )}

          {tab === 'pricing' && (
            <div className="space-y-4 min-w-0">
              {/* Bundle inner tabs */}
              {product.IsBundle && bundleProductNames.length > 0 && (
                <div className="border-b border-gray-200 -mx-1">
                  <nav className="flex flex-wrap gap-1 px-1" aria-label="Bundle pricing">
                    <button
                      type="button"
                      onClick={() => setBundlePricingTab(BUNDLE_PRICING_KEY)}
                      className={`inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                        bundlePricingTab === BUNDLE_PRICING_KEY
                          ? 'border-oe-primary text-gray-900'
                          : 'border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300'
                      }`}
                    >
                      <Layers className="h-4 w-4" />
                      Bundle
                    </button>
                    {bundleProductNames.map((pn) => (
                      <button
                        key={pn}
                        type="button"
                        onClick={() => setBundlePricingTab(pn)}
                        className={`inline-flex items-center whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                          bundlePricingTab === pn
                            ? 'border-oe-primary text-gray-900'
                            : 'border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300'
                        }`}
                      >
                        {pn}
                      </button>
                    ))}
                  </nav>
                </div>
              )}

              {/* Loading / error / empty states (shared) */}
              {pricingLoading ? (
                <div className="text-center py-10 text-sm text-gray-500">Loading pricing...</div>
              ) : pricingError ? (
                <div className="text-center py-10 text-sm text-red-600">{pricingError}</div>
              ) : pricing.length === 0 ? (
                <div className="text-center py-10">
                  <DollarSign className="h-8 w-8 text-gray-300 mx-auto mb-2" />
                  <p className="text-sm text-gray-500">No pricing tiers configured for this product.</p>
                </div>
              ) : product.IsBundle && bundlePricingTab === BUNDLE_PRICING_KEY ? (
                /* ============ Bundle simulator ============ */
                <div className="space-y-4">
                  <div className="flex flex-wrap items-end gap-3">
                    <label className="flex flex-col gap-1 text-xs text-gray-600">
                      <span>Tobacco</span>
                      <select
                        value={simTobacco}
                        onChange={(e) => setSimTobacco(e.target.value === 'Y' ? 'Y' : 'N')}
                        className="px-2.5 py-1.5 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-oe-primary"
                      >
                        <option value="N">No</option>
                        <option value="Y">Yes</option>
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-gray-600">
                      <span>Age</span>
                      <select
                        value={simAge}
                        onChange={(e) => setSimAge(Number(e.target.value))}
                        className="px-2.5 py-1.5 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-oe-primary"
                      >
                        {bundleSimOptions.ages.map((a) => (
                          <option key={a} value={a}>
                            {a}
                          </option>
                        ))}
                      </select>
                    </label>
                    {bundleSimOptions.configOptions.length > 0 && (
                      <label className="flex flex-col gap-1 text-xs text-gray-600">
                        <span>{bundleSimOptions.configLabel}</span>
                        <select
                          value={simConfigValue}
                          onChange={(e) => setSimConfigValue(e.target.value)}
                          className="px-2.5 py-1.5 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-oe-primary"
                        >
                          {bundleSimOptions.configOptions.map((u) => (
                            <option key={u} value={u}>
                              {/unshared\s*amount/i.test(bundleSimOptions.configLabel)
                                ? formatUnsharedAmount(u)
                                : u}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>

                  <div className="overflow-x-auto border border-gray-200 rounded-md">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wide">
                        <tr>
                          <th className="text-left px-3 py-2 font-medium">Tier</th>
                          <th className="text-right px-3 py-2 font-medium">Net Rate</th>
                          <th className="text-right px-3 py-2 font-medium">MSRP</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {bundleSimulatorTiers.map((row) => {
                          const none = row.matchedProducts === 0;
                          return (
                            <tr key={row.tier} className="hover:bg-gray-50">
                              <td className="px-3 py-2 font-medium text-gray-900">
                                {TIER_LABELS[row.tier]}
                              </td>
                              <td className="px-3 py-2 text-right text-gray-900 font-medium">
                                {none ? '—' : formatCurrency(row.netRate)}
                              </td>
                              <td className="px-3 py-2 text-right text-gray-900 font-medium">
                                {none ? '—' : formatCurrency(row.msrp)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-xs text-gray-500">
                    Net Rate and MSRP are summed across all included products using each
                    product&apos;s best-matching tier row for the selected age, tobacco, and
                    configuration. This is the raw vendor-side total — it does <strong>not</strong>{' '}
                    include any tenant-specific processing or system fees, so the agent
                    portal&apos;s member-facing price for the same bundle may be slightly higher.
                    Switch tabs above to see the underlying pricing per included product.
                  </p>
                </div>
              ) : (
                /* ============ Per-product (or non-bundle) tier table ============ */
                <>
                  <div className="flex flex-wrap gap-2">
                    <select
                      value={tobaccoFilter}
                      onChange={(e) => setTobaccoFilter(e.target.value)}
                      className="px-2.5 py-1.5 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    >
                      <option value="">All tobacco</option>
                      {tobaccoOptions.map((t) => (
                        <option key={t} value={t}>
                          Tobacco: {tobaccoLabel(t)}
                        </option>
                      ))}
                    </select>
                    <select
                      value={tierFilter}
                      onChange={(e) => setTierFilter(e.target.value)}
                      className="px-2.5 py-1.5 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    >
                      <option value="">All tiers</option>
                      {tiers.map((t) => (
                        <option key={t} value={t}>
                          {TIER_LABELS[t] || t}
                        </option>
                      ))}
                    </select>
                    {unsharedOptions.length > 0 && (
                      <select
                        value={unsharedFilter}
                        onChange={(e) => setUnsharedFilter(e.target.value)}
                        className="px-2.5 py-1.5 border border-gray-300 rounded-md text-sm bg-white focus:outline-none focus:ring-2 focus:ring-oe-primary"
                      >
                        <option value="">All unshared amounts</option>
                        {unsharedOptions.map((u) => (
                          <option key={u} value={u}>
                            Unshared: {formatUnsharedAmount(u)}
                          </option>
                        ))}
                      </select>
                    )}
                    <div className="ml-auto text-xs text-gray-500 self-center">
                      {filteredPricing.length} of {pricingForActiveBundleTab.length} tier
                      {pricingForActiveBundleTab.length === 1 ? '' : 's'}
                    </div>
                  </div>

                  <div className="overflow-x-auto border border-gray-200 rounded-md">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wide">
                        <tr>
                          <th className="text-left px-3 py-2 font-medium">Tier</th>
                          <th className="text-left px-3 py-2 font-medium">Tobacco</th>
                          <th className="text-left px-3 py-2 font-medium">Age</th>
                          <th className="text-left px-3 py-2 font-medium">Label</th>
                          <th className="text-left px-3 py-2 font-medium">Config</th>
                          <th className="text-right px-3 py-2 font-medium">Net Rate</th>
                          <th className="text-right px-3 py-2 font-medium">MSRP</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {filteredPricing.length === 0 ? (
                          <tr>
                            <td colSpan={7} className="text-center px-3 py-6 text-gray-500">
                              No tiers match the current filters.
                            </td>
                          </tr>
                        ) : (
                          filteredPricing.map((row) => (
                            <tr key={row.ProductPricingId} className="hover:bg-gray-50">
                              <td className="px-3 py-2 text-gray-900">
                                {row.TierType ? TIER_LABELS[row.TierType] || row.TierType : '—'}
                              </td>
                              <td className="px-3 py-2 text-gray-700">{tobaccoLabel(row.TobaccoStatus)}</td>
                              <td className="px-3 py-2 text-gray-700">{ageBand(row.MinAge, row.MaxAge)}</td>
                              <td className="px-3 py-2 text-gray-700">{row.Label || '—'}</td>
                              <td className="px-3 py-2">{renderConfig(row)}</td>
                              <td className="px-3 py-2 text-right text-gray-900 font-medium">
                                {formatCurrency(row.NetRate)}
                              </td>
                              <td className="px-3 py-2 text-right text-gray-900 font-medium">
                                {formatCurrency(row.MSRPRate)}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {/* Vendor-level pricing meta */}
              {(product.IsVendorPrice !== undefined || product.VendorCommission !== undefined) && (
                <div className="flex flex-wrap gap-4 text-xs text-gray-500 pt-2 border-t border-gray-100">
                  {product.IsVendorPrice !== undefined && (
                    <div>
                      Vendor pricing:{' '}
                      <span className="text-gray-900 font-medium">
                        {product.IsVendorPrice ? 'Yes' : 'No'}
                      </span>
                    </div>
                  )}
                  {product.VendorCommission !== undefined && product.VendorCommission !== null && (
                    <div>
                      Vendor commission:{' '}
                      <span className="text-gray-900 font-medium">{product.VendorCommission}%</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-200 bg-gray-50 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-md border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 text-sm font-medium"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default VendorProductDetailsModal;
