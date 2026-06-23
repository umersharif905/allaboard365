import { apiService } from '../api.service';

export interface TelemedicineStatusData {
  hasTelemedicine: boolean;
  ssoConfigured: boolean;
  productName?: string | null;
  effectiveDate?: string | null;
  message?: string | null;
}

export interface TelemedicineStatusResponse {
  success: boolean;
  data?: TelemedicineStatusData;
  message?: string;
}

export class TelemedicineService {
  static async getStatus(): Promise<TelemedicineStatusResponse> {
    return apiService.get<TelemedicineStatusResponse>('/api/me/member/telemedicine-status');
  }

  static async getSsoUrl(): Promise<{ success: boolean; data?: { url: string }; message?: string }> {
    return apiService.post<{ success: boolean; data?: { url: string }; message?: string }>('/api/me/member/telemedicine-sso-url');
  }
}
