// frontend/src/services/password.service.ts
import type { ApiResponse } from '../types/api.types';
import { apiService } from './api.service';

export interface PasswordSetupData {
  token: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}

export interface PasswordSetupResponse {
  success: boolean;
  message?: string;
  data?: {
    userId: string;
    email: string;
    token: string;
    roles: string[];
  };
}

export class PasswordService {
  /**
   * Get password setup information by token (PUBLIC)
   */
  static async getPasswordSetupInfo(token: string): Promise<ApiResponse<PasswordSetupData>> {
    return apiService.get(`/api/password-setup/${token}`);
  }

  /**
   * Setup password for new user (PUBLIC)
   */
  static async setupPassword(token: string, password: string): Promise<PasswordSetupResponse> {
    return apiService.post(`/api/password-setup/${token}`, { password });
  }

  /**
   * Reset password with token (PUBLIC)
   */
  static async resetPassword(token: string, password: string): Promise<ApiResponse<any>> {
    return apiService.post(`/api/auth/reset-password/${token}`, { password });
  }

  /**
   * Request password reset (PUBLIC)
   */
  static async requestPasswordReset(email: string): Promise<ApiResponse<any>> {
    return apiService.post(`/api/auth/forgot-password`, { email });
  }
}

export default PasswordService;

