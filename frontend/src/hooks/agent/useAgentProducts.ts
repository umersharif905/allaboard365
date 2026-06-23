import { useQuery } from '@tanstack/react-query';
import {
  normalizeBundleProduct,
  type SubscribedProduct,
} from '../../components/products/SubscribedProductDetailsModal';
import AgentService from '../../services/agent/agent.service';

const toNumberOrUndefined = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const transformProductData = (data: unknown[]): SubscribedProduct[] => {
  if (!data) return [];
  return data.map((rawProduct) => {
    const product = rawProduct as Record<string, unknown>;
    return ({
    subscriptionId: String(
      product.subscriptionId ?? product.SubscriptionId ?? product.ProductId ?? ''
    ),
    productId: String(product.ProductId ?? ''),
    productName: String(product.Name ?? ''),
    productType: String(product.ProductType ?? 'Other'),
    description: product.Description != null && product.Description !== '' ? String(product.Description) : '',
    productImageUrl:
      product.ProductImageUrl != null ? String(product.ProductImageUrl) : undefined,
    productLogoUrl:
      product.ProductLogoUrl != null ? String(product.ProductLogoUrl) : undefined,
    productDocumentUrl:
      product.ProductDocumentUrl != null ? String(product.ProductDocumentUrl) : undefined,
    productDocuments: (product.productDocuments || product.ProductDocuments || []) as SubscribedProduct['productDocuments'],
    basicPrice: 0,
    productOwner: {
      tenantName: String(product.ProductOwnerName ?? 'Unknown Provider'),
    },
    subscriptionStatus: String(
      product.SubscriptionStatus ?? product.subscriptionStatus ?? 'Active'
    ),
    isConfigured: product.isConfigured !== false,
    status: String(product.Status ?? 'Active'),
    salePrice: toNumberOrUndefined(
      product.SalePrice ??
      product.salePrice ??
      product.DisplayPremium ??
      product.displayPremium ??
      product.MonthlyPremium ??
      product.monthlyPremium
    ) ?? 0,
    tenantRate: toNumberOrUndefined(product.TenantRate ?? product.tenantRate) ?? 0,
    isBundle: Boolean(product.IsBundle),
    bundleProducts: ((product.BundleProducts as unknown[]) || []).map((bundleProductRaw) =>
      normalizeBundleProduct(bundleProductRaw as Record<string, unknown>)
    ),
    salesType:
      product.SalesType != null || product.salesType != null
        ? String(product.SalesType ?? product.salesType)
        : undefined,
    isHidden: product.IsHidden === true || product.IsHidden === 1,
  });
  });
};

export const useAgentProducts = () => {
  return useQuery({
    queryKey: ['agentProducts'],
    queryFn: async () => {
      const response = await AgentService.getAgentProducts();
      if (response.success && Array.isArray(response.data)) {
        return transformProductData(response.data);
      }
      throw new Error(response.message || 'Failed to fetch products');
    },
  });
}; 