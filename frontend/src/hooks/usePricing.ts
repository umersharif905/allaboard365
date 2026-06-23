/**
 * UNIFIED PRICING HOOKS - React hooks for all pricing scenarios
 * 
 * This module provides unified hooks that replace multiple existing pricing hooks:
 * - useMemberPricing (deprecated)
 * - useCurrentMemberPricing (new)
 * - usePricingSimulation (new)
 * - usePricingComparison (new)
 */

import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import {
    PricingCalculationParams,
    PricingComparison,
    PricingResult,
    PricingService
} from '../services/pricing.service';

// ============================================================================
// MAIN PRICING HOOK
// ============================================================================

/**
 * Main pricing hook - replaces multiple existing hooks
 * @param params Pricing calculation parameters
 * @param enabled Whether the query should be enabled
 * @returns Query result with pricing data
 */
export const usePricing = (params: PricingCalculationParams | null, enabled = true) => {
  return useQuery<PricingResult>({
    queryKey: ['pricing', params],
    queryFn: () => PricingService.calculatePricing(params!),
    enabled: enabled && !!params,
    staleTime: 2 * 60 * 1000, // 2 minutes
    retry: 2
  });
};

// ============================================================================
// CURRENT MEMBER PRICING HOOK
// ============================================================================

/**
 * Current member pricing hook - role-aware
 * @param memberId Member ID (optional for current user)
 * @returns Query result with current pricing data
 */
export const useCurrentPricing = (memberId?: string) => {
  const { user, isLoading: isAuthLoading } = useAuth();

  return useQuery<PricingResult>({
    queryKey: ['currentPricing', memberId, user?.currentRole],
    queryFn: () => PricingService.getCurrentPricing(
      user?.currentRole === 'Member' ? undefined : memberId,
      user?.currentRole
    ),
    enabled: !isAuthLoading && !!user?.currentRole,
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: 2
  });
};

// ============================================================================
// PRICING SIMULATION HOOKS
// ============================================================================

/**
 * Pricing simulation hook for adding dependents
 * @param memberId Member ID
 * @param newDependent New dependent data
 * @param enabled Whether the query should be enabled
 * @returns Query result with simulation pricing data
 */
export const useAddDependentSimulation = (
  memberId: string | null,
  newDependent: any,
  enabled = true
) => {
  return useQuery<PricingResult>({
    queryKey: ['addDependentSimulation', memberId, newDependent],
    queryFn: () => PricingService.simulateAddDependent(memberId!, newDependent),
    enabled: enabled && !!memberId && !!newDependent,
    staleTime: 1 * 60 * 1000, // 1 minute for simulations
    retry: 1
  });
};

/**
 * Pricing simulation hook for removing dependents
 * @param memberId Member ID
 * @param dependentId Dependent ID to remove
 * @param enabled Whether the query should be enabled
 * @returns Query result with simulation pricing data
 */
export const useRemoveDependentSimulation = (
  memberId: string | null,
  dependentId: string | null,
  enabled = true
) => {
  return useQuery<PricingResult>({
    queryKey: ['removeDependentSimulation', memberId, dependentId],
    queryFn: () => PricingService.simulateRemoveDependent(memberId!, dependentId!),
    enabled: enabled && !!memberId && !!dependentId,
    staleTime: 1 * 60 * 1000, // 1 minute for simulations
    retry: 1
  });
};

/**
 * Pricing simulation hook for product changes
 * @param memberId Member ID
 * @param addProducts Products to add
 * @param removeProducts Products to remove
 * @param enabled Whether the query should be enabled
 * @returns Query result with simulation pricing data
 */
export const useProductChangeSimulation = (
  memberId: string | null,
  addProducts: string[] = [],
  removeProducts: string[] = [],
  enabled = true
) => {
  return useQuery<PricingResult>({
    queryKey: ['productChangeSimulation', memberId, addProducts, removeProducts],
    queryFn: () => PricingService.simulateProductChanges(memberId!, addProducts, removeProducts),
    enabled: enabled && !!memberId && (addProducts.length > 0 || removeProducts.length > 0),
    staleTime: 1 * 60 * 1000, // 1 minute for simulations
    retry: 1
  });
};

/**
 * Generic pricing simulation hook
 * @param memberId Member ID
 * @param simulationType Type of simulation
 * @param simulationData Simulation data
 * @param enabled Whether the query should be enabled
 * @returns Query result with simulation pricing data
 */
export const usePricingSimulation = (
  memberId: string | null,
  simulationType: 'add-dependent' | 'remove-dependent' | 'change-products',
  simulationData: any,
  enabled = true
) => {
  return useQuery<PricingResult>({
    queryKey: ['pricingSimulation', memberId, simulationType, simulationData],
    queryFn: () => PricingService.calculatePricing({
      memberId: memberId!,
      calculationType: 'simulation',
      simulationContext: {
        type: simulationType,
        changes: simulationData
      }
    }),
    enabled: enabled && !!memberId && !!simulationData,
    staleTime: 1 * 60 * 1000, // 1 minute for simulations
    retry: 1
  });
};

// ============================================================================
// PRICING COMPARISON HOOK
// ============================================================================

/**
 * Pricing comparison hook
 * @param currentPricing Current pricing data
 * @param newPricing New pricing data
 * @returns Comparison data
 */
export const usePricingComparison = (
  currentPricing: PricingResult | null,
  newPricing: PricingResult | null
): PricingComparison => {
  return PricingService.comparePricing(currentPricing, newPricing);
};

// ============================================================================
// TIER CALCULATION HOOKS
// ============================================================================

/**
 * Hook to calculate tier changes when adding dependents
 * @param currentTier Current member tier
 * @param hasSpouse Whether member has a spouse
 * @param childrenCount Number of children
 * @returns Object with tier change information
 */
export const useTierChange = (currentTier: string, hasSpouse: boolean, childrenCount: number) => {
  const newTier = PricingService.calculateMemberTier(hasSpouse, childrenCount);
  
  return {
    currentTier,
    newTier,
    hasChanged: currentTier !== newTier,
    changeDescription: getTierChangeDescription(currentTier, newTier)
  };
};

/**
 * Get human-readable description of tier change
 * @param currentTier Current tier
 * @param newTier New tier
 * @returns Description of the change
 */
function getTierChangeDescription(currentTier: string, newTier: string): string {
  if (currentTier === newTier) {
    return 'No change in coverage tier';
  }

  const currentName = PricingService.getTierDisplayName(currentTier);
  const newName = PricingService.getTierDisplayName(newTier);

  return `Changes from ${currentName} to ${newName}`;
}

// ============================================================================
// UTILITY HOOKS
// ============================================================================

/**
 * Hook to validate pricing parameters
 * @param params Pricing parameters
 * @returns Validation result
 */
export const usePricingValidation = (params: PricingCalculationParams | null) => {
  if (!params) {
    return { isValid: false, errors: ['Parameters are required'] };
  }

  return PricingService.validatePricingParams(params);
};

/**
 * Hook to get member criteria from household data
 * @param householdData Household data
 * @param primaryMemberId Primary member ID
 * @returns Member criteria object
 */
export const useMemberCriteria = (householdData: any, primaryMemberId?: string) => {
  if (!householdData || !householdData.householdMembers) {
    return null;
  }

  const primaryMember = householdData.householdMembers.find((member: any) => 
    member.MemberId === primaryMemberId || member.IsCurrentUser
  );

  if (!primaryMember) {
    return null;
  }

  const dependents = householdData.householdMembers.filter((member: any) => 
    member.MemberId !== primaryMemberId && !member.IsCurrentUser
  );

  const hasSpouse = dependents.some((dep: any) => 
    dep.RelationshipType === 'S' || dep.RelationshipType === 'Spouse'
  );
  const childrenCount = dependents.filter((dep: any) => 
    dep.RelationshipType === 'C' || dep.RelationshipType === 'Child'
  ).length;

  const tier = PricingService.calculateMemberTier(hasSpouse, childrenCount);
  const age = PricingService.calculateAge(primaryMember.DateOfBirth || '1990-01-01');

  return {
    age,
    tobaccoUse: primaryMember.TobaccoUse || 'No',
    tier,
    householdSize: PricingService.getTierDisplayName(tier) === 'Employee Only' ? 1 : 
                   PricingService.getTierDisplayName(tier) === 'Employee + Spouse' ? 2 : 
                   PricingService.getTierDisplayName(tier) === 'Employee + Children' ? 1 + childrenCount :
                   PricingService.getTierDisplayName(tier) === 'Employee + Family' ? 2 + childrenCount : 1
  };
};

// ============================================================================
// DEPRECATED HOOKS (for backward compatibility)
// ============================================================================

/**
 * @deprecated Use usePricing instead
 * Legacy hook for member pricing - maintained for backward compatibility
 */
export const useMemberPricing = (params: any, enabled = true) => {
  console.warn('useMemberPricing is deprecated. Use usePricing instead.');
  
  // Convert legacy params to new format
  const newParams: PricingCalculationParams = {
    calculationType: 'enrollment',
    memberCriteria: {
      age: params.memberAge || 35,
      tobaccoUse: params.tobaccoUse || 'No',
      tier: params.memberTier || 'EE',
      householdSize: 1
    },
    productSelections: (params.selectedProducts || []).map((productId: string) => ({
      productId,
      configValues: params.productConfigs?.[productId] || {}
    }))
  };

  return usePricing(newParams, enabled);
};
