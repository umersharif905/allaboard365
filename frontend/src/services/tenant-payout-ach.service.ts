import type { ApiResponse } from '../types/index';
import { apiService } from './api.service';

export interface TenantPayoutACHAccount {
  TenantPayoutACHId: string;
  AccountName?: string | null;
  AccountHolderName: string;
  BankName: string;
  CompanyIdentification?: string | null;
  BankAccountType: 'Checking' | 'Savings';
  IsActive: boolean;
  IsDefault: boolean;
  VerificationStatus: 'Pending' | 'Verified' | 'Failed';
  CreatedDate: string;
  ModifiedDate?: string;
  maskedAccountNumber?: string | null;
  maskedRoutingNumber?: string | null;
}

export class TenantPayoutACHService {
  /**
   * Get a single tenant payout ACH account with decrypted routing/account numbers for editing
   */
  static async getTenantPayoutACHAccountForEdit(
    tenantPayoutAchId: string,
    tenantId?: string
  ): Promise<ApiResponse<TenantPayoutACHAccount & { routingNumber?: string; accountNumber?: string }>> {
    const query = new URLSearchParams();
    query.set('includeDecrypted', 'true');
    if (tenantId) query.set('tenantId', tenantId);
    return await apiService.get<ApiResponse<TenantPayoutACHAccount & { routingNumber?: string; accountNumber?: string }>>(
      `/api/me/tenant-admin/tenant-payout-ach-accounts/${tenantPayoutAchId}?${query.toString()}`
    );
  }

  /**
   * Get all tenant payout ACH accounts for a tenant
   */
  static async getTenantPayoutACHAccounts(tenantId?: string): Promise<ApiResponse<TenantPayoutACHAccount[]>> {
    const query = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : '';
    return await apiService.get<ApiResponse<TenantPayoutACHAccount[]>>(
      `/api/me/tenant-admin/tenant-payout-ach-accounts${query}`
    );
  }

  /**
   * Create a new tenant payout ACH account
   */
  static async createACHAccount(achData: {
    accountName?: string;
    accountHolderName: string;
    bankName: string;
    companyIdentification?: string;
    accountNumber: string;
    routingNumber: string;
    bankAccountType: 'Checking' | 'Savings';
    isDefault?: boolean;
  }, tenantId?: string): Promise<ApiResponse<TenantPayoutACHAccount>> {
    const payload = {
      ...achData,
      ...(tenantId ? { tenantId } : {})
    };

    return await apiService.post<ApiResponse<TenantPayoutACHAccount>>(
      `/api/me/tenant-admin/tenant-payout-ach-accounts`,
      payload
    );
  }

  /**
   * Update an existing tenant payout ACH account
   */
  static async updateACHAccount(
    tenantPayoutAchId: string,
    achData: {
      accountName?: string;
      accountHolderName?: string;
      bankName?: string;
      companyIdentification?: string;
      accountNumber?: string;
      routingNumber?: string;
      bankAccountType?: 'Checking' | 'Savings';
      isDefault?: boolean;
      isActive?: boolean;
    },
    tenantId?: string
  ): Promise<ApiResponse<TenantPayoutACHAccount>> {
    const payload = {
      ...achData,
      ...(tenantId ? { tenantId } : {})
    };

    return await apiService.put<ApiResponse<TenantPayoutACHAccount>>(
      `/api/me/tenant-admin/tenant-payout-ach-accounts/${tenantPayoutAchId}`,
      payload
    );
  }

  /**
   * Delete a tenant payout ACH account (soft delete)
   */
  static async deleteACHAccount(
    tenantPayoutAchId: string,
    tenantId?: string
  ): Promise<ApiResponse<void>> {
    const query = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : '';
    return await apiService.delete<ApiResponse<void>>(
      `/api/me/tenant-admin/tenant-payout-ach-accounts/${tenantPayoutAchId}${query}`
    );
  }
}

