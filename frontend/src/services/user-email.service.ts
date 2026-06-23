/**
 * User Email Service
 * Role-aware service for checking email availability and changing user emails.
 * Used by SysAdmin, TenantAdmin, GroupAdmin, Agent, and AgencyOwner (scoped per role).
 */
import { apiService } from './api.service';

function getBaseUrl(currentRole: string): string {
  switch (currentRole) {
    case 'SysAdmin':
      return '/api/me/sysadmin/users';
    case 'TenantAdmin':
      return '/api/me/tenant-admin/users';
    case 'GroupAdmin':
      return '/api/me/group-admin/users';
    case 'Agent':
    case 'AgencyOwner':
      return '/api/me/agent/users';
    default:
      throw new Error(`Unsupported role for email change: ${currentRole}`);
  }
}

export interface CheckEmailResponse {
  success: boolean;
  data: { available: boolean };
}

export interface ChangeEmailResponse {
  success: boolean;
  data?: { email: string };
  message?: string;
}

export const UserEmailService = {
  async checkEmailAvailable(
    email: string,
    excludeUserId?: string | null,
    currentRole?: string
  ): Promise<CheckEmailResponse> {
    const baseUrl = getBaseUrl(currentRole || 'SysAdmin');
    const params = new URLSearchParams({ email });
    if (excludeUserId) params.set('excludeUserId', excludeUserId);
    return apiService.get<CheckEmailResponse>(`${baseUrl}/check-email-availability?${params}`);
  },

  async changeEmail(
    userId: string,
    email: string,
    currentRole?: string
  ): Promise<ChangeEmailResponse> {
    const baseUrl = getBaseUrl(currentRole || 'SysAdmin');
    return apiService.put<ChangeEmailResponse>(`${baseUrl}/${userId}/email`, { email });
  },
};
