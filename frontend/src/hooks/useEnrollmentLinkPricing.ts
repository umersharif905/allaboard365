/**
 * ENROLLMENT LINK PRICING HOOKS - React hooks for enrollment link pricing
 * 
 * This module provides hooks specifically for enrollment link pricing scenarios:
 * - Getting available products from enrollment link
 * - Calculating pricing for selected products
 * - Managing enrollment link state
 */

import { useQuery } from '@tanstack/react-query';
import { EnrollmentLinkPricingResponse, EnrollmentLinkService, ProductWithPricing } from '../services/enrollment-link.service';

// ============================================================================
// ENROLLMENT LINK PRICING HOOKS
// ============================================================================

/**
 * Hook to get available products from enrollment link
 * @param linkToken Enrollment link token
 * @param enabled Whether the query should be enabled
 * @returns Query result with available products
 */
export const useEnrollmentLinkProducts = (linkToken: string | null, enabled = true) => {
  return useQuery<ProductWithPricing[]>({
    queryKey: ['enrollmentLinkProducts', linkToken],
    queryFn: () => EnrollmentLinkService.getAvailableProducts(linkToken!),
    enabled: enabled && !!linkToken,
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: 2
  });
};

/**
 * Hook to calculate pricing for selected products in enrollment link
 * @param linkToken Enrollment link token
 * @param memberCriteria Member criteria for pricing
 * @param selectedProducts Selected product IDs
 * @param selectedConfigs Selected product configurations
 * @param effectiveDate Effective date for pricing (YYYY-MM-DD format)
 * @param enabled Whether the query should be enabled
 * @returns Query result with pricing data
 */
export const useEnrollmentLinkPricing = (
  linkToken: string | null,
  memberCriteria: {
    age: number;
    tobaccoUse: string;
    tier: string;
    householdSize: number;
    jobPosition?: string;
  } | null,
  effectiveDate?: string,
  enabled = true
) => {
  return useQuery<EnrollmentLinkPricingResponse['data']>({
    // IMPORTANT: We fetch ALL pricing variations up-front for this member criteria + effective date.
    // Frontend handles product selection, config/UA changes, and contribution math locally
    // using the cached pricingVariations + contribution rules.
    //
    // Therefore, the query key MUST NOT depend on selectedProducts or selectedConfigs,
    // otherwise every toggle would refetch and visually reload the UI.
    queryKey: ['enrollmentLinkPricing', linkToken, memberCriteria, effectiveDate],
    queryFn: async () => {
      const response = await EnrollmentLinkService.getProductsWithPricing(
        linkToken!,
        memberCriteria!,
        [],            // Fetch pricing for ALL template products; selections handled on frontend
        {},            // Do NOT send selectedConfigs – frontend switches variations locally
        effectiveDate
      );
      return response.data; // Extract the data property
    },
    enabled: enabled && !!linkToken && !!memberCriteria,
    staleTime: 2 * 60 * 1000, // 2 minutes
    retry: 2,
    placeholderData: (previousData) => previousData
  });
};

/**
 * Hook to get totals for current selection (product-pricing with selectedProducts + selectedConfigs).
 * Used for individual links so the Total display uses backend config-aware totals instead of summing default premiums.
 * Can be debounced or enabled only when selection exists; refetches when selection or config changes.
 */
export const useEnrollmentLinkTotals = (
  linkToken: string | null,
  memberCriteria: {
    age: number;
    tobaccoUse: string;
    tier: string;
    householdSize: number;
    jobPosition?: string;
  } | null,
  selectedProducts: string[],
  selectedConfigs: Record<string, any>,
  effectiveDate?: string,
  enabled = true,
  /** Pass when known (e.g. confirmation) so backend returns fee calculated on config-aware premium */
  paymentMethod?: 'ACH' | 'Card'
) => {
  return useQuery<EnrollmentLinkPricingResponse['data']>({
    queryKey: ['enrollmentLinkTotals', linkToken, memberCriteria, selectedProducts, selectedConfigs, effectiveDate, paymentMethod],
    queryFn: async () => {
      const response = await EnrollmentLinkService.getProductsWithPricing(
        linkToken!,
        memberCriteria!,
        selectedProducts,
        selectedConfigs,
        effectiveDate,
        paymentMethod
      );
      return response.data;
    },
    enabled: enabled && !!linkToken && !!memberCriteria && selectedProducts.length > 0,
    staleTime: 60 * 1000,
    retry: 2
  });
};

/**
 * Hook to get enrollment link details
 * @param linkToken Enrollment link token
 * @param enabled Whether the query should be enabled
 * @returns Query result with enrollment link data
 */
export const useEnrollmentLink = (linkToken: string | null, enabled = true) => {
  return useQuery({
    queryKey: ['enrollmentLink', linkToken],
    queryFn: () => EnrollmentLinkService.getEnrollmentLink(linkToken!),
    enabled: enabled && !!linkToken,
    staleTime: 10 * 60 * 1000, // 10 minutes
    retry: 2
  });
};

export default {
  useEnrollmentLinkProducts,
  useEnrollmentLinkPricing,
  useEnrollmentLinkTotals,
  useEnrollmentLink
};
