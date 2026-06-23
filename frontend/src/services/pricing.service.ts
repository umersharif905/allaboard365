/**
 * UNIFIED PRICING SERVICE - Frontend service for all pricing calculations
 * 
 * This service provides a unified interface for all pricing scenarios:
 * - Enrollment wizard pricing
 * - Current member pricing
 * - Pricing simulations (add/remove dependents, change products)
 * - Role-aware endpoint selection
 */

import { apiService } from './api.service';

// ============================================================================
// INTERFACES
// ============================================================================

export interface PricingCalculationParams {
  memberId?: string;
  calculationType: 'enrollment' | 'current' | 'simulation';
  productSelections?: ProductSelection[];
  memberCriteria?: MemberCriteria;
  groupId?: string;
  simulationContext?: SimulationContext;
  effectiveDate?: string; // Effective date for pricing (YYYY-MM-DD format) - used to select correct pricing tiers
}

export interface ProductSelection {
  productId: string;
  configValues?: Record<string, any>;
  isBundle?: boolean;
}

export interface MemberCriteria {
  age: number;
  tobaccoUse: string;
  tier: string; // EE, ES, EC, EF
  householdSize: number;
}

export interface SimulationContext {
  type?: 'add-dependent' | 'remove-dependent' | 'change-products';
  changes?: {
    addDependents?: Array<{ relationshipType?: string }>;
    /** Backend tier preview uses relationshipType on each entry */
    removeDependents?: Array<{ relationshipType?: string }>;
    addProducts?: string[];
    removeProducts?: string[];
  };
}

export interface ProductPricing {
  productId: string;
  productName: string;
  productType: string;
  isBundle: boolean;
  tierType: string;
  tobaccoStatus: string;
  memberAge: number;
  monthlyPremium: number;
  basePremium: number;
  configAdjustment: number;
  hasConfigurationFields?: boolean;
  requiredDataFields?: Array<{
    fieldName: string;
    fieldType: string;
    options: string[];
  }>;
  pricingDetails: {
    netRate: number;
    overrideRate: number;
    vendorCommission: number;
    isVendorPrice: boolean;
  };
  configValues: Record<string, any>;
  calculatedAt: string;
  // Contribution fields
  employerContribution: number;
  employeeContribution: number;
  // Pricing variations for configuration switching
  pricingVariations?: Array<{
    configValue: string;
    monthlyPremium: number;
    employerContribution: number;
    employeeContribution: number;
  }>;
}

export interface ContributionResult {
  employerTotal: number;
  employeeTotal: number;
  productContributions: Record<string, ProductContribution>;
  allProductsContribution: number;
  appliedRules: any[];
  calculationDetails: string | any;
}

export interface ProductContribution {
  productSpecific: number;
  allProductsShare: number;
  total: number;
  employeeContribution: number;
  proportion?: number;
}

export interface PricingError {
  productId: string;
  error: string;
  errorType: 'MISSING_PRICING_CONFIG' | 'PRICING_ERROR';
}

export interface PricingResult {
  products: ProductPricing[];
  contributions: ContributionResult;
  totals: {
    totalPremium: number;
    totalEmployerContribution: number;
    totalEmployeeContribution: number;
  };
  calculationType: string;
  memberId?: string;
  groupId?: string;
  calculatedAt: string;
  pricingErrors?: PricingError[];
}

export interface PricingComparison {
  hasComparison: boolean;
  currentTotal: number;
  newTotal: number;
  difference: number;
  percentageChange: number;
  isIncrease: boolean;
  formattedDifference: string;
  formattedPercentageChange: string;
  currentPricing?: PricingResult;
  newPricing?: PricingResult;
}

// ============================================================================
// PRICING SERVICE CLASS
// ============================================================================

export class PricingService {
  /**
   * Main pricing calculation method
   * @param params Pricing calculation parameters
   * @returns Promise<PricingResult>
   */
  static async calculatePricing(params: PricingCalculationParams): Promise<PricingResult> {
    try {
      console.log('🔍 DEBUG: PricingService.calculatePricing called with:', {
        calculationType: params.calculationType,
        memberId: params.memberId ? 'provided' : 'not provided',
        productSelectionsCount: params.productSelections?.length || 0,
        groupId: params.groupId ? 'provided' : 'not provided'
      });

      const response = await apiService.post<{ success: boolean; data: PricingResult }>(
        '/api/pricing/calculate',
        params
      );

      if (!response.success) {
        throw new Error('Failed to calculate pricing');
      }

      return response.data;
    } catch (error) {
      console.error('❌ Error in PricingService.calculatePricing:', error);
      throw error;
    }
  }

  /**
   * Get current pricing - role-aware endpoint selection
   * @param memberId Member ID (optional for current user)
   * @param currentRole Current user role
   * @returns Promise<PricingResult>
   */
  static async getCurrentPricing(memberId?: string, currentRole?: string): Promise<PricingResult> {
    try {
      const url = this.getCurrentPricingUrl(currentRole, memberId);
      
      console.log('🔍 DEBUG: PricingService.getCurrentPricing called with:', {
        url,
        memberId,
        currentRole
      });

      const response = await apiService.get<{ success: boolean; data: PricingResult }>(url);

      if (!response.success) {
        throw new Error('Failed to get current pricing');
      }

      return response.data;
    } catch (error) {
      console.error('❌ Error in PricingService.getCurrentPricing:', error);
      throw error;
    }
  }

  /**
   * Get current pricing URL based on role
   * @param currentRole Current user role
   * @param memberId Member ID
   * @returns URL string
   */
  private static getCurrentPricingUrl(currentRole: string, memberId?: string): string {
    switch (currentRole) {
      case 'Member':
        return '/api/me/member/pricing/current';
      case 'Agent':
        return `/api/me/agent/pricing/current/${memberId}`;
      case 'TenantAdmin':
        return `/api/me/tenant-admin/pricing/current/${memberId}`;
      case 'SysAdmin':
        return `/api/pricing/current/${memberId}`;
      default:
        throw new Error(`Unsupported role: ${currentRole}`);
    }
  }

  /**
   * Simulate adding a dependent
   * @param memberId Member ID
   * @param newDependent New dependent data
   * @returns Promise<PricingResult>
   */
  static async simulateAddDependent(memberId: string, newDependent: any): Promise<PricingResult> {
    return this.calculatePricing({
      memberId,
      calculationType: 'simulation',
      simulationContext: {
        type: 'add-dependent',
        changes: {
          addDependents: [newDependent]
        }
      }
    });
  }

  /**
   * Simulate removing a dependent
   * @param memberId Member ID
   * @param dependentId Dependent ID to remove
   * @returns Promise<PricingResult>
   */
  static async simulateRemoveDependent(
    memberId: string,
    dependentId: string,
    relationshipType: string = 'C'
  ): Promise<PricingResult> {
    void dependentId;
    return this.calculatePricing({
      memberId,
      calculationType: 'simulation',
      simulationContext: {
        type: 'remove-dependent',
        changes: {
          removeDependents: [{ relationshipType }]
        }
      }
    });
  }

  /**
   * Simulate changing products
   * @param memberId Member ID
   * @param addProducts Products to add
   * @param removeProducts Products to remove
   * @returns Promise<PricingResult>
   */
  static async simulateProductChanges(
    memberId: string, 
    addProducts: string[] = [], 
    removeProducts: string[] = []
  ): Promise<PricingResult> {
    return this.calculatePricing({
      memberId,
      calculationType: 'simulation',
      simulationContext: {
        type: 'change-products',
        changes: {
          addProducts,
          removeProducts
        }
      }
    });
  }

  /**
   * Calculate member tier based on household composition
   * @param hasSpouse Whether member has a spouse
   * @param childrenCount Number of children
   * @returns Tier string (EE, ES, EC, EF)
   */
  static calculateMemberTier(hasSpouse: boolean, childrenCount: number): string {
    if (!hasSpouse && childrenCount === 0) {
      return 'EE'; // Employee Only
    } else if (hasSpouse && childrenCount === 0) {
      return 'ES'; // Employee + Spouse
    } else if (!hasSpouse && childrenCount > 0) {
      return 'EC'; // Employee + Children
    } else if (hasSpouse && childrenCount > 0) {
      return 'EF'; // Employee + Family
    } else {
      return 'EE'; // Default fallback
    }
  }

  /**
   * Calculate age from date of birth
   * @param dateOfBirth Date of birth string
   * @returns Age in years
   */
  static calculateAge(dateOfBirth: string): number {
    if (!dateOfBirth) {
      throw new Error('dateOfBirth is required');
    }

    const birthDate = new Date(dateOfBirth);
    const today = new Date();
    
    if (isNaN(birthDate.getTime())) {
      throw new Error('Invalid dateOfBirth format');
    }

    if (birthDate > today) {
      throw new Error('dateOfBirth cannot be in the future');
    }

    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }

    return age;
  }

  /**
   * Format currency for display
   * @param amount Amount to format
   * @returns Formatted currency string
   */
  static formatCurrency(amount: number): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
  }

  /**
   * Compare two pricing results
   * @param currentPricing Current pricing result
   * @param newPricing New pricing result
   * @returns Pricing comparison data
   */
  static comparePricing(currentPricing: PricingResult | null, newPricing: PricingResult | null): PricingComparison {
    if (!currentPricing || !newPricing) {
      return {
        hasComparison: false,
        currentTotal: 0,
        newTotal: 0,
        difference: 0,
        percentageChange: 0,
        isIncrease: false,
        formattedDifference: '$0.00',
        formattedPercentageChange: '0%'
      };
    }

    const currentTotal = currentPricing.totals.totalEmployeeContribution;
    const newTotal = newPricing.totals.totalEmployeeContribution;
    const difference = newTotal - currentTotal;
    const percentageChange = currentTotal > 0 ? (difference / currentTotal) * 100 : 0;
    const isIncrease = difference > 0;

    return {
      hasComparison: true,
      currentTotal,
      newTotal,
      difference,
      percentageChange,
      isIncrease,
      formattedDifference: this.formatCurrency(difference),
      formattedPercentageChange: `${isIncrease ? '+' : ''}${percentageChange.toFixed(1)}%`,
      currentPricing,
      newPricing
    };
  }

  /**
   * Get tier display name
   * @param tier Tier code
   * @returns Human-readable tier name
   */
  static getTierDisplayName(tier: string): string {
    switch (tier) {
      case 'EE': return 'Employee Only';
      case 'ES': return 'Employee + Spouse';
      case 'EC': return 'Employee + Children';
      case 'EF': return 'Employee + Family';
      default: return 'Unknown Tier';
    }
  }

  /**
   * Validate pricing parameters
   * @param params Pricing parameters
   * @returns Validation result
   */
  static validatePricingParams(params: PricingCalculationParams): { isValid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!params.calculationType) {
      errors.push('calculationType is required');
    } else if (!['enrollment', 'current', 'simulation'].includes(params.calculationType)) {
      errors.push('calculationType must be one of: enrollment, current, simulation');
    }

    if (params.calculationType === 'current' && !params.memberId) {
      errors.push('memberId is required for current calculations');
    }

    if (['enrollment', 'simulation'].includes(params.calculationType) && !params.memberCriteria) {
      errors.push('memberCriteria is required for enrollment and simulation calculations');
    }

    if (params.calculationType === 'enrollment' && (!params.productSelections || !Array.isArray(params.productSelections))) {
      errors.push('productSelections array is required for enrollment calculations');
    }

    if (params.calculationType === 'simulation' && !params.simulationContext) {
      errors.push('simulationContext is required for simulation calculations');
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }
}

export default PricingService;