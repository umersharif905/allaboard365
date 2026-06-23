import { apiService } from './api.service';

export type VendorPortalRole = 'VendorAdmin' | 'VendorAgent';

export interface AdminVendorUserRow {
  UserId: string;
  FirstName: string;
  LastName: string;
  Email: string;
  PhoneNumber?: string | null;
  Status: string;
  CreatedDate?: string;
  LastLoginDate?: string | null;
  TenantId?: string;
  /** True when the user has not set a password yet (invited / pending setup). */
  NeedsPasswordSetup?: boolean;
  roles: string[];
}

export interface CreateAdminVendorUserPayload {
  firstName: string;
  lastName: string;
  email: string;
  phoneNumber?: string;
  roles?: VendorPortalRole[];
  password?: string;
  tenantId?: string;
  sendWelcomeEmail?: boolean;
}

export class AdminVendorUsersService {
  static async listUsers(vendorId: string, status?: string): Promise<{ success: boolean; data?: AdminVendorUserRow[]; message?: string }> {
    const q = status ? `?status=${encodeURIComponent(status)}` : '';
    return apiService.get<{ success: boolean; data?: AdminVendorUserRow[]; message?: string }>(
      `/api/vendors/${encodeURIComponent(vendorId)}/users${q}`
    );
  }

  static async createUser(
    vendorId: string,
    payload: CreateAdminVendorUserPayload
  ): Promise<{
    success: boolean;
    message?: string;
    data?: {
      userId: string;
      email: string;
      roles: string[];
      passwordSetupLink?: string;
    };
  }> {
    return apiService.post(`/api/vendors/${encodeURIComponent(vendorId)}/users`, payload);
  }

  static async deactivateUser(vendorId: string, userId: string): Promise<{ success: boolean; message?: string }> {
    return apiService.delete<{ success: boolean; message?: string }>(
      `/api/vendors/${encodeURIComponent(vendorId)}/users/${encodeURIComponent(userId)}`
    );
  }

  static async resendSetupLink(
    vendorId: string,
    userId: string,
    options?: { sendWelcomeEmail?: boolean }
  ): Promise<{
    success: boolean;
    message?: string;
    data?: { passwordSetupLink?: string; passwordSetupExpiry?: string };
  }> {
    return apiService.post(
      `/api/vendors/${encodeURIComponent(vendorId)}/users/${encodeURIComponent(userId)}/resend-setup-link`,
      options ?? { sendWelcomeEmail: true }
    );
  }
}
