/**
 * ENROLLMENT LINK SERVICE - Service for enrollment link operations
 * 
 * This service handles enrollment link specific operations:
 * - Getting enrollment link details
 * - Getting available products with pricing
 * - Managing enrollment link state
 */

import { apiService } from './api.service';

// ============================================================================
// INTERFACES
// ============================================================================

export interface EnrollmentLink {
  linkId: string;
  linkToken: string;
  groupId: string;
  groupName: string;
  tenantId: string;
  isActive: boolean;
  expiresAt?: string;
  createdBy: string;
  createdAt: string;
}

export interface ProductWithPricing {
  productId: string;
  productName: string;
  description?: string;
  productType: string;
  isBundle: boolean;
  contributionRules: Array<{
    type: string;
    amount: number;
    description: string;
    appliesTo: string;
    contributionDirection?: 'Employer' | 'MaxEmployee';
    /** When type is percentage: null = % of actual premium; EE/ES/EC/EF = % of that tier's equivalent premium */
    equivalentTier?: 'EE' | 'ES' | 'EC' | 'EF' | null;
  }>;
  pricingVariations: Array<{
    configValue: string;
    monthlyPremium: number;
    /** Authority-computed display premium = basePremium + Highest-policy included fee. Backend-only math. */
    displayPremium?: number;
    netRate?: number;
    overrideRate?: number;
    msrpRate?: number;
    tierType?: string;
    tobaccoStatus?: string;
  }>;
  /** Authority-computed display premium for the top-level product (base + Highest-policy included fee). Backend-only math. */
  displayPremium?: number;
  /** When group has percentage + equivalentTier rules: premiums by tier (EE, ES, EC, EF) */
  equivalentPremiums?: Partial<Record<'EE' | 'ES' | 'EC' | 'EF', number>>;
  includedProducts?: Array<{
    productId: string;
    productName: string;
    /** Authority-computed display premium for the bundle-included product (base + Highest-policy included fee). */
    displayPremium?: number;
    pricingVariations: Array<{
      configValue: string;
      monthlyPremium: number;
      /** Authority-computed display premium for this bundle-child variation. */
      displayPremium?: number;
    }>;
  }>;
  // Legacy fields for backward compatibility
  tierType?: string;
  tobaccoStatus?: string;
  memberAge?: number;
  monthlyPremium?: number;
  basePremium?: number;
  configAdjustment?: number;
  pricingDetails?: {
    netRate: number;
    overrideRate: number;
    vendorCommission: number;
    isVendorPrice: boolean;
  };
  configValues?: Record<string, any>;
  calculatedAt?: string;
  hasConfigurationFields?: boolean;
  availableConfigs?: string[];
  requiredDataFields?: string[];
  defaultConfig?: Record<string, any>;
  employerContribution?: number;
  employeeContribution?: number;
  setupFee?: number | null;
}

export interface EnrollmentLinkPricingResponse {
  success: boolean;
  data: {
    products: ProductWithPricing[];
    allProductsRules: Array<{
      type: string;
      amount: number;
      description: string;
      appliesTo: string;
      contributionDirection?: 'Employer' | 'MaxEmployee';
      equivalentTier?: 'EE' | 'ES' | 'EC' | 'EF' | null;
      tierContributions?: any;
      ageRules?: Array<{
        minAge: number;
        maxAge: number | null;
        contributionAmount: number;
        contributionType: 'flat' | 'percentage';
      }>;
      jobPositions?: string[];
      tenureRules?: any;
      roleContributions?: any;
      priority?: number;
      stacking?: boolean;
      appliesToRestrictions?: any;
    }>;
    totals: {
      totalPremium: number;
      totalEmployerContribution: number;
      totalEmployeeContribution: number;
    };
    /** Present when product-pricing is called with selectedProducts + selectedConfigs (e.g. totals query) */
    contributions?: {
      employerTotal?: number;
      employeeTotal?: number;
      productContributions?: Record<string, { total?: number; productSpecific?: number; employeeContribution?: number; allProductsShare?: number }>;
      appliedRules?: any[];
    };
    /** When backend computes fee from config-aware premium (selected products + paymentMethod), use this instead of frontend calc */
    fees?: { systemFeesAmount: number; processingFee: number; totalFees: number };
    enrollmentInfo: {
      linkId: string;
      groupId: string;
      groupName: string;
      tenantId: string;
    };
  };
  message: string;
}

export interface EnrollmentLinkContributionPreviewResponse {
  success: boolean;
  data: {
    products: ProductWithPricing[];
    contributions: any;
    totals: {
      totalPremium: number;
      totalEmployerContribution: number;
      totalEmployeeContribution: number;
    };
  };
  message?: string;
}

// Helper type for easier access to pricing data
export interface PricingData {
  products: ProductWithPricing[];
  contributions: any;
  totals: {
    totalPremium: number;
    totalEmployerContribution: number;
    totalEmployeeContribution: number;
  };
  calculationType: string;
  memberId?: string;
  groupId?: string;
  calculatedAt: string;
}

// ============================================================================
// ENROLLMENT LINK SERVICE CLASS
// ============================================================================

export class EnrollmentLinkService {
  /**
   * Get enrollment link details
   * @param linkToken Enrollment link token
   * @returns Promise<EnrollmentLink>
   */
  static async getEnrollmentLink(linkToken: string): Promise<EnrollmentLink> {
    try {
      console.log('🔍 DEBUG: EnrollmentLinkService.getEnrollmentLink called with:', linkToken);

      const response = await apiService.get<{ success: boolean; data: EnrollmentLink }>(
        `/api/enrollment-links/${linkToken}`
      );

      if (!response.success) {
        throw new Error('Failed to get enrollment link');
      }

      return response.data;
    } catch (error) {
      console.error('❌ Error in EnrollmentLinkService.getEnrollmentLink:', error);
      throw error;
    }
  }

  /**
   * Get products with pricing for enrollment link
   * @param linkToken Enrollment link token
   * @param memberCriteria Member criteria for pricing
   * @param selectedProducts Currently selected products
   * @param effectiveDate Effective date for pricing (YYYY-MM-DD format)
   * @returns Promise<EnrollmentLinkPricingResponse>
   */
  static async getProductsWithPricing(
    linkToken: string,
    memberCriteria: {
      age: number;
      tobaccoUse: string;
      tier: string;
      householdSize: number;
      jobPosition?: string;
    },
    selectedProducts: string[] = [],
    selectedConfigs: Record<string, any> = {},
    effectiveDate?: string,
    /** Optional: ACH | Card so backend can return fee calculated on config-aware premium */
    paymentMethod?: 'ACH' | 'Card'
  ): Promise<EnrollmentLinkPricingResponse> {
    try {
      console.log('🔍 DEBUG: EnrollmentLinkService.getProductsWithPricing called with:', {
        linkToken,
        memberCriteria,
        selectedProducts,
        selectedConfigs,
        effectiveDate,
        paymentMethod
      });

      const queryParams = new URLSearchParams({
        memberAge: memberCriteria.age.toString(),
        tobaccoUse: memberCriteria.tobaccoUse,
        memberTier: memberCriteria.tier,
        householdSize: (memberCriteria.householdSize ?? 1).toString(),
        selectedProducts: JSON.stringify(selectedProducts),
        selectedConfigs: JSON.stringify(selectedConfigs)
      });
      
      if (memberCriteria.jobPosition) {
        queryParams.append('jobPosition', memberCriteria.jobPosition);
      }
      
      if (effectiveDate) {
        queryParams.append('effectiveDate', effectiveDate);
      }
      if (paymentMethod === 'ACH' || paymentMethod === 'Card') {
        queryParams.append('paymentMethod', paymentMethod);
      }

      const response = await apiService.get<EnrollmentLinkPricingResponse>(
        `/api/enrollment-links/${linkToken}/product-pricing?${queryParams}`
      );

      console.log('🔍 DEBUG: Backend response:', {
        success: response.success,
        hasData: !!response.data,
        hasPricingResult: !!response.data,
        hasProducts: !!response.data?.products,
        productsLength: response.data?.products?.length || 0,
        fullResponse: response
      });

      if (!response.success) {
        throw new Error('Failed to get products with pricing');
      }

      return response;
    } catch (error) {
      console.error('❌ Error in EnrollmentLinkService.getProductsWithPricing:', error);
      throw error;
    }
  }

  static async getContributionPreview(
    linkToken: string,
    payload: {
      memberCriteria: { age: number; tobaccoUse: string; tier: string; householdSize: number; jobPosition?: string };
      selectedProducts: string[];
      selectedConfigs?: Record<string, any>;
      effectiveDate?: string;
      paymentMethodType?: 'ACH' | 'Card';
    }
  ): Promise<EnrollmentLinkContributionPreviewResponse> {
    const response = await apiService.post<EnrollmentLinkContributionPreviewResponse>(
      `/api/enrollment-links/${linkToken}/contribution-preview`,
      payload
    );
    return response as any;
  }

  /**
   * Get available products without pricing (for initial load)
   * @param linkToken Enrollment link token
   * @returns Promise<ProductWithPricing[]>
   */
  static async getAvailableProducts(linkToken: string): Promise<ProductWithPricing[]> {
    try {
      console.log('🔍 DEBUG: EnrollmentLinkService.getAvailableProducts called with:', linkToken);

      // Use default member criteria to get available products
      const defaultCriteria = {
        age: 35,
        tobaccoUse: 'No',
        tier: 'EE',
        householdSize: 1
      };

      const response = await this.getProductsWithPricing(linkToken, defaultCriteria, []);
      
      return response.data.products;
    } catch (error) {
      console.error('❌ Error in EnrollmentLinkService.getAvailableProducts:', error);
      throw error;
    }
  }

  /**
   * Calculate pricing for selected products
   * @param linkToken Enrollment link token
   * @param memberCriteria Member criteria for pricing
   * @param selectedProducts Selected product IDs
   * @param selectedConfigs Selected product configurations
   * @param effectiveDate Effective date for pricing (YYYY-MM-DD format)
   * @returns Promise<EnrollmentLinkPricingResponse>
   */
  static async calculatePricing(
    linkToken: string,
    memberCriteria: {
      age: number;
      tobaccoUse: string;
      tier: string;
      householdSize: number;
      jobPosition?: string;
    },
    selectedProducts: string[],
    selectedConfigs: Record<string, any> = {},
    effectiveDate?: string
  ): Promise<EnrollmentLinkPricingResponse> {
    try {
      console.log('🔍 DEBUG: EnrollmentLinkService.calculatePricing called with:', {
        linkToken,
        memberCriteria,
        selectedProducts,
        selectedConfigs,
        effectiveDate,
        hasJobPosition: !!memberCriteria.jobPosition,
        jobPosition: memberCriteria.jobPosition
      });

      // Get pricing for all products - backend will return all products but calculate contributions only for selected ones
      const response = await this.getProductsWithPricing(linkToken, memberCriteria, selectedProducts, selectedConfigs, effectiveDate);
      
      // Backend now returns all products regardless of selectedProducts, so no need to filter here

      return response;
    } catch (error) {
      console.error('❌ Error in EnrollmentLinkService.calculatePricing:', error);
      throw error;
    }
  }
}

export default EnrollmentLinkService;
