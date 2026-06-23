import { apiService } from './api.service';

export interface ProductChangeData {
  selectedProducts: string[];
  removedProducts: string[];
  configValues: Record<string, string>;
  effectiveDate: string;
  // NEW: Include frontend-calculated pricing for validation
  frontendPricing: Array<{
    productId: string;
    productName: string;
    monthlyPremium: number;
    selectedConfig: string | null;
  }>;
}

export interface ProductChangeResponse {
  success: boolean;
  data?: any;
  message?: string;
  error?: {
    message: string;
    code: string;
    details?: any;
  };
}

export class ProductChangesService {
  /**
   * Submit product changes with pricing validation
   * Used by member portal for plan modifications
   */
  static async submitProductChanges(
    productChangeData: ProductChangeData
  ): Promise<ProductChangeResponse> {
    try {
      console.log('🔍 DEBUG: ProductChangesService.submitProductChanges - Submitting product changes:', productChangeData);
      console.log('🔍 DEBUG: selectedProducts from ProductChangesService:', productChangeData.selectedProducts);
      console.log('🔍 DEBUG: configValues from ProductChangesService:', productChangeData.configValues);
      console.log('🔍 DEBUG: frontendPricing from ProductChangesService:', productChangeData.frontendPricing);

      const response = await apiService.post<ProductChangeResponse>(
        '/api/me/member/product-changes',
        productChangeData
      );

      return response;
    } catch (error) {
      console.error('❌ ProductChangesService.submitProductChanges error:', error);
      throw error;
    }
  }
}

export default ProductChangesService;
