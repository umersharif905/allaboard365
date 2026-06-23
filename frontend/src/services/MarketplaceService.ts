// frontend/src/services/MarketplaceService.ts
import type { ProductFormData } from '../components/forms/AddProductWizard';
import type {
    ApiResponse,
    Product
} from '../types/marketplace';
import { apiService } from './api.service';

export interface Tenant {
  TenantId: string;
  Name: string;
  ContactEmail: string;
  Status: string;
  LogoUrl?: string;
}

export interface FilterParams {
  search?: string;
  productType?: string;
  salesType?: string;
  minPrice?: string;
  maxPrice?: string;
  productOwner?: string;
  requiredLicenses?: string[];
}

export interface MarketplaceStats {
  totalProducts: number;
  totalTenants: number;
  activeSubscriptions?: number;
  pendingRequests?: number;
}

export interface ProductOwner {
  ProductOwnerId: string;
  Name: string;
  LogoUrl?: string;
  ProductCount: number;
}

export interface ProductType {
  ProductType: string;
  ProductCount: number;
}

class MarketplaceService {
  async getProducts(filters?: FilterParams): Promise<ApiResponse<{ products: Product[] }>> {
    try {
      const queryParams = new URLSearchParams();
      
      if (filters) {
        Object.entries(filters).forEach(([key, value]) => {
          if (value !== undefined && value !== '') {
            if (Array.isArray(value)) {
              queryParams.append(key, value.join(','));
            } else {
              queryParams.append(key, String(value));
            }
          }
        });
      }

      const endpoint = `/api/marketplace/products${queryParams.toString() ? `?${queryParams.toString()}` : ''}`;
      const response = await apiService.get<ApiResponse<{ products: Product[] }>>(endpoint);
      return response;
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to fetch products'
      };
    }
  }

  async getProductById(productId: string): Promise<ApiResponse<Product>> {
    try {
      const response = await apiService.get<ApiResponse<Product>>(`/api/marketplace/products/${productId}`);
      return response;
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to fetch product'
      };
    }
  }

  /**
   * Get multiple products by IDs (batch request)
   * @param productIds Array of product IDs
   * @returns Promise with products array
   */
  async getProductsBatch(productIds: string[]): Promise<ApiResponse<Product[]>> {
    try {
      const response = await apiService.post<ApiResponse<Product[]>>('/api/products/batch', {
        productIds
      });
      return response;
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to fetch products batch'
      };
    }
  }

  async getTenants(): Promise<ApiResponse<{ tenants: Tenant[] }>> {
    try {
      const response = await apiService.get<ApiResponse<{ tenants: Tenant[] }>>('/api/marketplace/tenants');
      return response;
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to fetch tenants'
      };
    }
  }

  async uploadFile(file: File, fileType: 'images' | 'logos' | 'documents'): Promise<ApiResponse<{ url: string; filename: string }>> {
    const formData = new FormData();
    formData.append('files', file);
    formData.append('fileType', fileType);
    formData.append('uploadType', 'products');
    formData.append('entityId', 'marketplace');

    try {
      const result = await apiService.post<{
        success: boolean;
        url?: string;
        data?: Array<{ url: string; filename: string }>;
        filename?: string;
        message?: string;
      }>('/api/uploads', formData);
      
      if (result.success) {
        return {
          success: true,
          data: {
            url: result.url || (result.data && result.data[0]?.url),
            filename: result.filename || (result.data && result.data[0]?.filename)
          }
        };
      } else {
        throw new Error(result.message || 'Upload failed');
      }
    } catch (error: any) {
      console.error('MarketplaceService upload error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async createProduct(productData: ProductFormData): Promise<ApiResponse<{ productId: string }>> {
    try {
      let productImageUrl = undefined;
      let productLogoUrl = undefined;
      let productDocumentUrl = undefined;

      if (productData.productImageFile) {
        const imageResponse = await this.uploadFile(productData.productImageFile, 'images');
        if (imageResponse.success && imageResponse.data) {
          productImageUrl = imageResponse.data.url;
        }
      }

      if (productData.productLogoFile) {
        const logoResponse = await this.uploadFile(productData.productLogoFile, 'logos');
        if (logoResponse.success && logoResponse.data) {
          productLogoUrl = logoResponse.data.url;
        }
      }

      if (productData.productDocumentFile) {
        const docResponse = await this.uploadFile(productData.productDocumentFile, 'documents');
        if (docResponse.success && docResponse.data) {
          productDocumentUrl = docResponse.data.url;
        }
      }

      const apiProductData: any = {
        ...productData,
        // Only include URL fields if they are defined (files were uploaded)
        ...(productImageUrl !== undefined && { productImageUrl }),
        ...(productLogoUrl !== undefined && { productLogoUrl }),
        ...(productDocumentUrl !== undefined && { productDocumentUrl })
      };

      delete apiProductData.productImageFile;
      delete apiProductData.productLogoFile;
      delete apiProductData.productDocumentFile;

      const response = await apiService.post<ApiResponse<{ productId: string }>>('/api/products', apiProductData);
      return response;

    } catch (error: any) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async updateProduct(productId: string, productData: Partial<ProductFormData>): Promise<ApiResponse<{ productId: string }>> {
    try {
      let updateData: any = { ...productData };

      if (productData.productImageFile) {
        const imageResponse = await this.uploadFile(productData.productImageFile, 'images');
        if (imageResponse.success && imageResponse.data) {
          updateData.productImageUrl = imageResponse.data.url;
        }
      }

      if (productData.productLogoFile) {
        const logoResponse = await this.uploadFile(productData.productLogoFile, 'logos');
        if (logoResponse.success && logoResponse.data) {
          updateData.productLogoUrl = logoResponse.data.url;
        }
      }

      if (productData.productDocumentFile) {
        const docResponse = await this.uploadFile(productData.productDocumentFile, 'documents');
        if (docResponse.success && docResponse.data) {
          updateData.productDocumentUrl = docResponse.data.url;
        }
      }

      delete updateData.productImageFile;
      delete updateData.productLogoFile;
      delete updateData.productDocumentFile;

      const response = await apiService.put<ApiResponse<{ productId: string }>>(`/api/products/${productId}`, updateData);
      return response;

    } catch (error: any) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async subscribeToProduct(productId: string, notes?: string): Promise<ApiResponse<any>> {
    try {
      const response = await apiService.post<ApiResponse<any>>('/api/marketplace/subscribe', { productId, notes });
      return response;
    } catch (error: any) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getStats(): Promise<ApiResponse<MarketplaceStats>> {
    try {
      const response = await apiService.get<ApiResponse<MarketplaceStats>>('/api/marketplace/stats');
      return response;
    } catch (error: any) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getProductOwners(): Promise<ApiResponse<{ productOwners: ProductOwner[] }>> {
    try {
      const response = await apiService.get<ApiResponse<{ productOwners: ProductOwner[] }>>('/api/marketplace/product-owners');
      return response;
    } catch (error: any) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getProductTypes(): Promise<ApiResponse<{ productTypes: ProductType[] }>> {
    try {
      const response = await apiService.get<ApiResponse<{ productTypes: ProductType[] }>>('/api/marketplace/product-types');
      return response;
    } catch (error: any) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getAvailableProducts(): Promise<ApiResponse<{ products: Product[] }>> {
    try {
      const response = await apiService.get<ApiResponse<{ products: Product[] }>>('/api/marketplace/products?excludeBundles=true');
      return response;
    } catch (error: any) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async updateSubscriptionStatus(
    subscriptionId: string, 
    status: 'Approved' | 'Denied', 
    notes?: string
  ): Promise<ApiResponse<any>> {
    try {
      const response = await apiService.put<ApiResponse<any>>(`/api/marketplace/subscriptions/${subscriptionId}`, {
        status,
        notes
      });
      return response;
    } catch (error: any) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getPendingSubscriptions(): Promise<ApiResponse<any[]>> {
    try {
      const response = await apiService.get<ApiResponse<any[]>>('/api/marketplace/subscriptions/pending');
      return response;
    } catch (error: any) {
      return {
        success: false,
        error: error.message
      };
    }
  }
}

export const marketplaceService = new MarketplaceService();