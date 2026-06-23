import type { ApiResponse } from '../types/index';
import { apiService } from './api.service';

export interface ProductOverride {
  OverrideId: string;
  ProductId: string;
  TenantId: string;
  OverrideACHId?: string;
  OverrideName?: string;
  OverrideAmount: number;
  Priority: number | null;
  IsActive: boolean;
  EffectiveDate?: string;
  ExpirationDate?: string;
  CreatedDate: string;
  ModifiedDate: string;
  TenantName?: string;
  ACHAccountName?: string;
  ACHAccountHolderName?: string;
  ACHBankName?: string;
  ACHAccountType?: string;
  ProductPricingId?: string | null;
  PricingName?: string | null;
  PricingLabel?: string | null;
  PricingTierType?: string | null;
  PricingTobaccoStatus?: string | null;
  PricingMinAge?: number | null;
  PricingMaxAge?: number | null;
}

export interface OverrideACHAccount {
  OverrideACHId: string;
  AccountName?: string | null;
  AccountHolderName: string;
  BankName: string;
  BankAccountType: 'Checking' | 'Savings' | 'Business' | 'Individual';
  IsActive: boolean;
  IsDefault: boolean;
  VerificationStatus: 'Pending' | 'Verified' | 'Failed';
  CreatedDate: string;
  maskedAccountNumber?: string | null;
  maskedRoutingNumber?: string | null;
}

export interface CreateOverrideData {
  tenantId: string;
  overrideACHId?: string;
  overrideName?: string;
  overrideAmount: number | string;
  priority?: number | string;
  isActive?: boolean;
  effectiveDate?: string;
  expirationDate?: string;
  productPricingId?: string | null;
}

export interface UpdateOverrideData extends CreateOverrideData {
  // Same as create but for updates
}

export class ProductOverridesService {
  /**
   * Get all overrides for a product
   */
  static async getProductOverrides(productId: string): Promise<ApiResponse<ProductOverride[]>> {
    return await apiService.get<ApiResponse<ProductOverride[]>>(
      `/api/me/tenant-admin/products/${productId}/overrides`
    );
  }

  /**
   * Create a new override for a product
   */
  static async createOverride(
    productId: string, 
    overrideData: CreateOverrideData
  ): Promise<ApiResponse<ProductOverride>> {
    return await apiService.post<ApiResponse<ProductOverride>>(
      `/api/me/tenant-admin/products/${productId}/overrides`,
      overrideData
    );
  }

  /**
   * Update an existing override
   */
  static async updateOverride(
    productId: string,
    overrideId: string,
    overrideData: UpdateOverrideData
  ): Promise<ApiResponse<ProductOverride>> {
    return await apiService.put<ApiResponse<ProductOverride>>(
      `/api/me/tenant-admin/products/${productId}/overrides/${overrideId}`,
      overrideData
    );
  }

  /**
   * Delete an override
   */
  static async deleteOverride(
    productId: string,
    overrideId: string
  ): Promise<ApiResponse<void>> {
    return await apiService.delete<ApiResponse<void>>(
      `/api/me/tenant-admin/products/${productId}/overrides/${overrideId}`
    );
  }

  /**
   * Get available ACH accounts for overrides
   */
  static async getOverrideACHAccounts(tenantId?: string): Promise<ApiResponse<OverrideACHAccount[]>> {
    const query = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : '';
    return await apiService.get<ApiResponse<OverrideACHAccount[]>>(
      `/api/me/tenant-admin/override-ach-accounts${query}`
    );
  }

  /**
   * Single override ACH account with decrypted routing/account (SysAdmin: pass source tenantId)
   */
  static async getOverrideACHAccountForEdit(
    overrideAchId: string,
    tenantId?: string
  ): Promise<ApiResponse<OverrideACHAccount & { routingNumber?: string; accountNumber?: string }>> {
    const query = new URLSearchParams();
    query.set('includeDecrypted', 'true');
    if (tenantId) query.set('tenantId', tenantId);
    return await apiService.get<
      ApiResponse<OverrideACHAccount & { routingNumber?: string; accountNumber?: string }>
    >(`/api/me/tenant-admin/override-ach-accounts/${overrideAchId}?${query.toString()}`);
  }

  /**
   * Create a new ACH account for overrides
   */
  static async createACHAccount(achData: {
    accountName: string;
    accountHolderName: string;
    bankName: string;
    accountNumber: string;
    routingNumber: string;
    bankAccountType: 'Checking' | 'Savings' | 'Business' | 'Individual';
    isDefault?: boolean;
  }, tenantId?: string): Promise<ApiResponse<OverrideACHAccount>> {
    const payload = {
      ...achData,
      ...(tenantId ? { tenantId } : {})
    };

    return await apiService.post<ApiResponse<OverrideACHAccount>>(
      `/api/me/tenant-admin/override-ach-accounts`,
      payload
    );
  }

  static async updateACHAccount(
    overrideAchId: string,
    achData: {
      accountName?: string;
      accountHolderName?: string;
      bankName?: string;
      accountNumber?: string;
      routingNumber?: string;
      bankAccountType?: 'Checking' | 'Savings' | 'Business' | 'Individual';
      isDefault?: boolean;
    },
    tenantId?: string
  ): Promise<ApiResponse<OverrideACHAccount>> {
    const payload = {
      ...achData,
      ...(tenantId ? { tenantId } : {})
    };

    return await apiService.put<ApiResponse<OverrideACHAccount>>(
      `/api/me/tenant-admin/override-ach-accounts/${overrideAchId}`,
      payload
    );
  }

  /**
   * Get available tenants for override assignment (TenantAdmin accessible)
   */
  static async getAvailableTenants(): Promise<ApiResponse<{ TenantId: string; Name: string }[]>> {
    return await apiService.get<ApiResponse<{ TenantId: string; Name: string }[]>>(
      `/api/me/tenant-admin/available-tenants`
    );
  }

  /**
   * Get current tenant info (TenantAdmin's own tenant)
   */
  static async getCurrentTenant(): Promise<ApiResponse<{ TenantId: string; Name: string }>> {
    return await apiService.get<ApiResponse<{ TenantId: string; Name: string }>>(
      `/api/me/tenant-admin/tenant`
    );
  }
}

