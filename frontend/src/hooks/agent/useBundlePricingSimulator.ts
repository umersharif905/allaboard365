import { useQuery } from '@tanstack/react-query';
import { apiService } from '../../services/api.service';

export interface BundleSimulatorTierRow {
  tier: string;
  totalPremium: number;
  subtotalWithIncluded: number;
  nonIncludedSubtotal: number;
  processingFee: number;
  systemFees: number;
  matchedProducts: number;
  totalProducts: number;
}

export interface BundleSimulatorCriteria {
  tobacco: 'Y' | 'N';
  age: number;
  configValue: string;
  paymentMethod: 'ACH' | 'Card';
  /** YYYY-MM-DD anchor — matches phased bundle simulator filtering */
  asOf?: string;
  bundleProductIds?: string[];
}

/**
 * Server computes bundle tier totals using backend/utils/processingFeeCalculator.js
 * and backend/utils/includedProcessingFee.js only for processing fees.
 */
export function useBundlePricingSimulator(
  productId: string | null,
  enabled: boolean,
  criteria: BundleSimulatorCriteria | null
) {
  return useQuery({
    queryKey: [
      'bundlePricingSimulator',
      productId,
      criteria?.tobacco,
      criteria?.age,
      criteria?.configValue,
      criteria?.paymentMethod,
      criteria?.asOf,
      criteria?.bundleProductIds,
    ],
    queryFn: async () => {
      if (!productId || !criteria) {
        throw new Error('productId and criteria required');
      }
      const res = await apiService.post<{
        success: boolean;
        data?: { bundleTotalsByTier: BundleSimulatorTierRow[] };
        message?: string;
      }>(`/api/me/agent/products/${productId}/pricing/bundle-simulator`, {
        tobacco: criteria.tobacco,
        age: criteria.age,
        configValue: criteria.configValue,
        paymentMethod: criteria.paymentMethod,
        asOf: criteria.asOf,
        bundleProductIds: criteria.bundleProductIds,
      });
      if (!res.success || !res.data?.bundleTotalsByTier) {
        throw new Error(res.message || 'Bundle simulator failed');
      }
      return res.data.bundleTotalsByTier;
    },
    enabled: Boolean(enabled && productId && criteria),
    staleTime: 60 * 1000,
    placeholderData: (previousData) => previousData,
  });
}
