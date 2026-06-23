// frontend/src/services/member/member-tenant.service.ts
import { apiService } from '../api.service';

export interface MemberTenantInfo {
  TenantId: string;
  Name?: string;
  LogoUrl?: string;
  PrimaryColor?: string;
  AppStoreUrl?: string;
  PlayStoreUrl?: string;
  name?: string;
  logoUrl?: string;
  primaryColor?: string;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
}

export class MemberTenantService {
  static async getTenant(): Promise<ApiResponse<MemberTenantInfo>> {
    return apiService.get<ApiResponse<MemberTenantInfo>>('/api/me/member/tenant');
  }
}

