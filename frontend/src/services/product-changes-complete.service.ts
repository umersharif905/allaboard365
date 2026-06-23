// frontend/src/services/product-changes-complete.service.ts
import { apiService } from './api.service';

export interface ProductAcknowledgement {
  productId: string;
  productName: string;
  productType: string;
  selectionType: string;
  acknowledgements: Array<{
    id: string;
    question: string;
    fieldType: string;
    required: boolean;
    options?: string[];
    customAction?: string;
  }>;
}

export interface ProductChangesCompleteData {
  selectedProducts: string[];
  removedProducts: string[];
  configValues: Record<string, string>;
  initialConfigValues?: Record<string, string>; // Original config values before changes
  effectiveDate: string;
  frontendPricing: Array<{
    productId: string;
    productName: string;
    monthlyPremium: number;
    selectedConfig: string | null;
  }>;
  acknowledgements?: any[];
  digitalSignature?: string;
  memberInfo?: any;
  // Wizard-specific fields
  dependentsToAdd?: any[];
  dependentsToRemove?: string[];
  newTobaccoUse?: string | null;
  calculatedTier?: string | null;
  isGroupMember?: boolean;
  // Payment verification fields
  expectedChargeAmount?: number | null;
  expectedIsIncremental?: boolean | null;
  expectedMonthlyTotal?: number | null;
  // Member ID for admin/agent managing another member's plan
  memberId?: string | null;
}

export class ProductChangesCompleteService {
  /**
   * Get acknowledgements for selected products
   */
  static async getProductAcknowledgements(selectedProducts: string[]): Promise<any> {
    try {
      const queryParams = new URLSearchParams();
      queryParams.append('selectedProducts', selectedProducts.join(','));
      
      const response = await apiService.get(`/api/me/member/product-changes-complete/acknowledgements?${queryParams.toString()}`);
      return response;
    } catch (error: any) {
      console.error('❌ Error fetching product acknowledgements:', error);
      return {
        success: false,
        message: error.message || 'Failed to fetch acknowledgements',
        error: error.response?.data?.error
      };
    }
  }

  /**
   * Complete product changes with acknowledgements and signatures
   */
  static async completeProductChanges(data: ProductChangesCompleteData): Promise<any> {
    try {
      const response = await apiService.post('/api/me/member/product-changes-complete', data);
      return response;
    } catch (error: any) {
      console.error('❌ Error completing product changes:', error);
      // Extract the most detailed error message available
      const errorMessage = error.response?.data?.message || 
                          error.response?.data?.error || 
                          error.message || 
                          'Failed to complete product changes';
      throw new Error(errorMessage);
    }
  }
}

export default ProductChangesCompleteService;
