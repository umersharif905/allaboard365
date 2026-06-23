import { apiService } from '../services/api.service';
import {
  capsMapToPoolsByTierJson,
  getGlobalMaxCommissionPool,
  mergeTierCommissionCapsMaps,
  TierCommissionCapsMap,
  tierCommissionCapsFromProductPayload,
} from './productCommissionPoolCaps';

type ProductDetailResponse = {
  success?: boolean;
  product?: unknown;
  data?: { product?: unknown };
};

export type ProductCommissionAiEnrichment = {
  productId: string;
  productName: string;
  vendorId: string;
  vendorName: string;
  salesType: string;
  isBundle: boolean;
  caps: TierCommissionCapsMap;
  globalMaxUsd: number | null;
  poolsByTier: Record<string, { minUsd: number; maxUsd: number }>;
};

async function loadProduct(productId: string): Promise<Record<string, unknown> | null> {
  const res = await apiService.get<ProductDetailResponse>(`/api/products/${productId}`);
  const product = res?.product ?? res?.data?.product;
  return product && typeof product === 'object' ? (product as Record<string, unknown>) : null;
}

/** Merged VendorCommission caps map (bundle = intersection/tightest caps across components). */
export async function fetchMergedCommissionCapsMap(productId: string): Promise<TierCommissionCapsMap> {
  const e = await fetchProductCommissionAiEnrichment(productId);
  return e.caps;
}

export async function fetchProductCommissionAiEnrichment(productId: string): Promise<ProductCommissionAiEnrichment> {
  const product = await loadProduct(productId);
  if (!product) {
    return {
      productId,
      productName: '',
      vendorId: '',
      vendorName: '',
      salesType: 'Unknown',
      isBundle: false,
      caps: {},
      globalMaxUsd: null,
      poolsByTier: {},
    };
  }

  const productName = String(product.Name ?? '');
  const vendorId =
    product.VendorId != null && String(product.VendorId).trim() !== ''
      ? String(product.VendorId)
      : '';
  const vendorName = String(product.VendorName ?? (product as { vendorName?: string }).vendorName ?? '').trim();
  const salesType = String(product.SalesType ?? 'Both');
  const isBundle = Boolean(product.IsBundle === true || product.IsBundle === 1);

  const primaryCaps = tierCommissionCapsFromProductPayload(product);
  let caps = primaryCaps;

  if (isBundle && Array.isArray(product.BundleProducts) && product.BundleProducts.length > 0) {
    const childMaps = await Promise.all(
      (product.BundleProducts as string[]).map(async (childId: string) => {
        try {
          const child = await loadProduct(childId);
          return child ? tierCommissionCapsFromProductPayload(child) : {};
        } catch {
          return {};
        }
      })
    );
    caps = mergeTierCommissionCapsMaps([primaryCaps, ...childMaps]);
  }

  const globalMaxUsd = getGlobalMaxCommissionPool(caps);

  return {
    productId,
    productName,
    vendorId,
    vendorName,
    salesType,
    isBundle,
    caps,
    globalMaxUsd,
    poolsByTier: capsMapToPoolsByTierJson(caps),
  };
}
