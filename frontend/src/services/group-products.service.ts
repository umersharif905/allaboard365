// frontend/src/services/group-products.service.ts
import type { ApiResponse } from '../types/api.types';
import { apiService } from './api.service';

export interface Product {
  ProductId: string;
  Name: string;
  ProductType: string;
  Description?: string;
  BasePrice: number;
  ProductOwner: string;
  AllowedStates: string[];
  MinAge: number;
  MaxAge: number;
  SalesType: string;
  IsActive: boolean;
  ProductImageUrl?: string;
  ProductLogoUrl?: string;
  ProductDocumentUrl?: string;
  productDocuments?: { productDocumentId?: string; documentUrl: string; displayName?: string; sortOrder?: number }[];
}

export interface ConfigurationField {
  fieldName: string;
  fieldOptions: string[];
  isDeductible?: boolean;
  markAsDeductible?: boolean;
  /** When product is a bundle: which included product this field belongs to (avoids same-name conflict) */
  sourceProductId?: string;
  sourceProductName?: string;
  /** Options enabled at product/bundle level (from AllowedConfigOptions). When set, options not in this list are shown but disabled in group config. */
  productAllowedOptions?: string[];
}

export interface GroupProduct {
  GroupProductId: string;
  GroupId: string;
  ProductId: string;
  IsAssigned: boolean;
  IsActive: boolean;
  CustomSettings: any;
  CreatedDate: string;
  ModifiedDate?: string;
  CreatedBy?: string;
  ModifiedBy?: string;
  Name: string;
  ProductType: string;
  Description?: string;
  ProductStatus: string;
  MinAge: number;
  MaxAge: number;
  SalesType: string;
  AllowedStates: string[];
  BasePrice: number;
  ProductOwner: string;
  ProductImageUrl?: string;
  ProductLogoUrl?: string;
  ProductDocumentUrl?: string;
  productDocuments?: { productDocumentId?: string; documentUrl: string; displayName?: string; sortOrder?: number }[];
  RequiredDataFields?: ConfigurationField[];
  DeductibleFields?: ConfigurationField[];
  IsHidden?: number | boolean;
  IsCatalogHidden?: number | boolean;
}

export interface GroupProductUpdate {
  productId: string;
  IsAssigned: boolean;
  CustomSettings?: any;
}

export interface GroupProductsResponse {
  groupProducts: GroupProduct[];
  availableProducts: Product[];
  group: {
    GroupId: string;
    Name: string;
    TenantId: string;
    Status: string;
  };
  accessDenied?: boolean;
  routeNotFound?: boolean;
  message?: string;
}

export class GroupProductsService {
  /**
   * Fetches products for a specific group
   * @param groupId The ID of the group
   */
  static async getGroupProducts(
    groupId: string,
    options?: { includeHidden?: boolean }
  ): Promise<ApiResponse<GroupProductsResponse>> {
    try {
      // Get user role from localStorage for debugging
      const currentRole = localStorage.getItem('currentRole');
      const storedRoles = localStorage.getItem('roles');
      const roles = storedRoles ? JSON.parse(storedRoles) : [];
      const userType = roles[0] || null;
      
      console.log('🔍 GroupProductsService - User role info:', {
        currentRole,
        userType,
        groupId,
        includeHidden: options?.includeHidden
      });
      
      // Use the unified endpoint that returns the proper structure
      // This endpoint handles role-based authorization internally
      const qs =
        options?.includeHidden === true
          ? '?includeHidden=true'
          : '';
      console.log('🔍 Using unified endpoint: /api/groups/${groupId}/products');
      const response = await apiService.get<ApiResponse<GroupProductsResponse>>(
        `/api/groups/${groupId}/products${qs}`
      );
      
      console.log('🔍 GroupProductsService response:', {
        success: response.success,
        hasData: !!response.data,
        hasGroupProducts: !!response.data?.groupProducts,
        hasAvailableProducts: !!response.data?.availableProducts,
        groupProductsCount: response.data?.groupProducts?.length || 0,
        availableProductsCount: response.data?.availableProducts?.length || 0,
        message: response.message
      });
      
      return response;
    } catch (error) {
      console.error(`Error fetching products for group ${groupId}:`, error);
      return { success: false, data: { groupProducts: [], availableProducts: [], group: { GroupId: '', Name: '', TenantId: '', Status: '' } }, message: `Failed to fetch products for group ${groupId}` };
    }
  }

  /**
   * Fetches product IDs that have at least one enrollment in this group (members already enrolled).
   * Used to prevent removing those products from the group in edit modal.
   */
  static async getGroupProductIdsWithEnrollments(groupId: string): Promise<ApiResponse<{ productIds: string[] }>> {
    try {
      const response = await apiService.get<ApiResponse<{ productIds: string[] }>>(
        `/api/groups/${groupId}/products-with-enrollments`
      );
      return response;
    } catch (error) {
      console.error(`Error fetching products-with-enrollments for group ${groupId}:`, error);
      return { success: false, data: { productIds: [] }, message: 'Failed to fetch products with enrollments' };
    }
  }

  /**
   * Updates product assignments for a group
   * @param groupId The ID of the group
   * @param updates Array of product updates
   */
  static async updateGroupProducts(groupId: string, updates: GroupProductUpdate[]): Promise<ApiResponse<any>> {
    try {
      return await apiService.put<ApiResponse<any>>(`/api/groups/${groupId}/products`, { updates });
    } catch (error) {
      console.error(`Error updating products for group ${groupId}:`, error);
      return { success: false, data: null, message: `Failed to update products for group ${groupId}` };
    }
  }

  /**
   * Updates deductible configuration for a group product.
   * For bundles use allowedOptionsByProduct: { [includedProductId]: { fieldName: [options] } } so config is scoped per product.
   */
  static async toggleProductVisibility(groupId: string, productId: string, isHidden: boolean): Promise<ApiResponse<any>> {
    try {
      return await apiService.patch<ApiResponse<any>>(
        `/api/groups/${groupId}/products/${productId}/visibility`,
        { isHidden }
      );
    } catch (error) {
      console.error(`Error toggling visibility for product ${productId} in group ${groupId}:`, error);
      return { success: false, data: null, message: 'Failed to update product visibility' };
    }
  }

  static async updateDeductibleConfig(
    groupId: string,
    productId: string,
    payload: { allowedOptions?: Record<string, string[]>; allowedOptionsByProduct?: Record<string, Record<string, string[]>> }
  ): Promise<ApiResponse<any>> {
    try {
      return await apiService.put<ApiResponse<any>>(
        `/api/groups/${groupId}/products/${productId}/deductible-config`,
        payload.allowedOptionsByProduct != null ? { allowedOptionsByProduct: payload.allowedOptionsByProduct } : { allowedOptions: payload.allowedOptions }
      );
    } catch (error) {
      console.error(`Error updating deductible config for product ${productId} in group ${groupId}:`, error);
      return { success: false, data: null, message: `Failed to update deductible configuration` };
    }
  }

  /**
   * GET /api/groups/:groupId/products/:productId/enrollment-count
   * Used by the Delete confirmation modal to show how many members are enrolled.
   */
  static async getEnrollmentCount(
    groupId: string,
    productId: string
  ): Promise<{ count: number }> {
    const res = await apiService.get<ApiResponse<{ count: number }>>(
      `/api/groups/${groupId}/products/${productId}/enrollment-count`
    );
    return (res as any).data;
  }

  /**
   * GET /api/groups/:groupId/products/hidden-with-enrollments
   * Used by the "Products with Active Enrollments" section.
   */
  static async getHiddenWithEnrollments(
    groupId: string
  ): Promise<HiddenProductWithEnrollments[]> {
    const res = await apiService.get<ApiResponse<HiddenProductWithEnrollments[]>>(
      `/api/groups/${groupId}/products/hidden-with-enrollments`
    );
    return (res as any).data;
  }
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface HiddenProductWithEnrollments {
  productId: string;
  productName: string;
  enrollmentCount: number;
  members: Array<{
    memberId: string;
    fullName: string;
    enrolledDate: string;
  }>;
}

// ── Free-function wrappers (for hook imports) ──────────────────────────────────

/**
 * GET /api/groups/:groupId/products/:productId/enrollment-count
 * Used by the Delete confirmation modal.
 */
export async function getEnrollmentCount(
  groupId: string,
  productId: string
): Promise<{ count: number }> {
  return GroupProductsService.getEnrollmentCount(groupId, productId);
}

/**
 * GET /api/groups/:groupId/products/hidden-with-enrollments
 * Used by the "Products with Active Enrollments" section.
 */
export async function getHiddenWithEnrollments(
  groupId: string
): Promise<HiddenProductWithEnrollments[]> {
  return GroupProductsService.getHiddenWithEnrollments(groupId);
} 