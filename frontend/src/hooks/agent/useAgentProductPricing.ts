// File: frontend/src/hooks/agent/useAgentProductPricing.ts
import { useQuery } from '@tanstack/react-query';
import type { AgentPricingFeeContext } from '../../utils/agentPricingDisplay';
import { apiService } from '../../services/api.service';

/** Populated by GET /api/me/agent/products/:id/pricing using backend processing-fee utils only. */
export interface ComputedMemberDisplay {
  basePremium: number;
  displayPremium: number;
  hasIncludedProcessingAdjustment: boolean;
  includedProcessingFee: number;
  nonIncludedProcessingFee?: number;
  assumedPaymentMethod?: 'ACH' | 'Card';
  roundUpProcessingFeeEnabled: boolean;
  usesCustomSystemFeeHandling: boolean;
  customSystemFeeAmount: number;
}

export interface ProductPricing {
  ProductPricingId?: string | null;
  IsVendorPrice: boolean;
  /** Included product id (bundle rows) or main product id (single product). */
  ProductId?: string | null;
  ProductName: string | null;
  /** Server-side member-facing premium breakdown (backend includedProcessingFee + processingFee calculators). */
  computedMemberDisplay?: ComputedMemberDisplay;
  Label: string;
  TierType: string | null;
  TobaccoStatus: string | null;
  MinAge: number | null;
  MaxAge: number | null;
  VendorNetRate: number;
  OwnerOverRide: number | null;
  AffiliateNetRate: number;
  VendorCommission: number | null;
  TenantOverride: number | null;
  SystemFees: number | null;
  MSRPRate: number | null;
  DiscountAmount: number | null;
  DiscountEffectiveDate: string | null;
  DiscountEndDate: string | null;
  EffectiveDate: string;
  TerminationDate: string | null;
  ConfigField1: string | null;
  ConfigValue1: string | null;
  ConfigField2: string | null;
  ConfigValue2: string | null;
  ConfigField3: string | null;
  ConfigValue3: string | null;
  ConfigField4: string | null;
  ConfigValue4: string | null;
  ConfigField5: string | null;
  ConfigValue5: string | null;
  Status: string;
}

export interface AgentProductPricingResponse {
  rows: ProductPricing[];
  feeContext: AgentPricingFeeContext | null;
}

export const useAgentProductPricing = (
  productId: string | null,
  paymentMethod: 'ACH' | 'Card' = 'ACH'
) => {
  return useQuery<AgentProductPricingResponse, Error>({
    queryKey: ['agentProductPricing', productId, paymentMethod],
    queryFn: async () => {
      if (!productId) {
        throw new Error('Product ID is required');
      }

      const url = `/api/me/agent/products/${productId}/pricing?paymentMethod=${encodeURIComponent(paymentMethod)}`;

      const response = await apiService.get<{
        success: boolean;
        data: ProductPricing[];
        feeContext?: AgentPricingFeeContext | null;
        message?: string;
      }>(url);

      if (response.success && response.data) {
        return {
          rows: response.data,
          feeContext: response.feeContext ?? null,
        };
      }
      throw new Error(response.message || 'Failed to fetch product pricing');
    },
    enabled: !!productId,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 1
  });
};