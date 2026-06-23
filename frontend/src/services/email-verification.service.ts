import { apiService } from './apiServices';

export interface EmailVerificationStatus {
  isPrimary: boolean;
  emailVerified: boolean;
  email: string | null;
  syntheticEmail: boolean;
}

interface ApiEnvelope<T> {
  success: boolean;
  message?: string;
  data?: T;
}

export const MemberEmailVerificationService = {
  async getStatus(): Promise<EmailVerificationStatus | null> {
    const res = await apiService.get<ApiEnvelope<EmailVerificationStatus>>(
      '/api/me/member/email-verification/status'
    );
    return res?.data || null;
  },

  async sendCode(): Promise<{ success: boolean; message?: string }> {
    const res = await apiService.post<ApiEnvelope<{ email: string; expiresIn: number }>>(
      '/api/me/member/email-verification/send',
      {}
    );
    return { success: !!res?.success, message: res?.message };
  },

  async verifyCode(code: string): Promise<{ success: boolean; message?: string }> {
    const res = await apiService.post<ApiEnvelope<{ verified: boolean }>>(
      '/api/me/member/email-verification/verify',
      { code }
    );
    return { success: !!res?.success, message: res?.message };
  },
};
