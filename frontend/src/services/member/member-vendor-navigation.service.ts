import { apiService } from '../api.service';

export interface VendorNavigationPage {
  vendorId: string;
  vendorName: string;
  routeKey: string;
  label: string;
  description?: string | null;
  iconName?: string | null;
  contentType: 'markdown' | 'static_html' | 'iframe' | 'component' | string;
  contentRef: string;
  sortOrder: number;
  effectiveDate?: string | null;
  expirationDate?: string | null;
  tenantScoped: boolean;
  visibilityRule?: Record<string, unknown> | null;
}

export interface VendorNavigationGroup {
  vendorId: string;
  vendorName: string;
  pages: VendorNavigationPage[];
}

export interface VendorNavigationResponse {
  success: boolean;
  data?: VendorNavigationGroup[];
  message?: string;
}

export class MemberVendorNavigationService {
  static async getVendorNavigationPages(): Promise<VendorNavigationResponse> {
    return apiService.get<VendorNavigationResponse>('/api/me/member/vendor-navigation/pages');
  }
}










