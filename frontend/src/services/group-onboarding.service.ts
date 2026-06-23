import type { ApiResponse } from '../types/api.types';
import type { ApiError } from './api.service';
import { apiService } from './api.service';

/** Backend codes from POST /api/me/agent/groups/:groupId/onboarding-links when the recipient email conflicts */
const ONBOARDING_LINK_DUPLICATE_EMAIL_CODES = new Set([
  'RECIPIENT_EMAIL_IS_AGENT',
  'RECIPIENT_EMAIL_OTHER_GROUP',
  'RECIPIENT_EMAIL_EXISTS_IN_TENANT'
]);

export const ONBOARDING_LINK_DUPLICATE_EMAIL_MESSAGE =
  'User with this email already exists in our system, please try a different email';

function getApiErrorPayload(error: unknown): { code?: string; message?: string } | null {
  if (typeof error !== 'object' || error === null) return null;
  const e = error as ApiError & { responseData?: { code?: string; message?: string } };
  const code = typeof e.code === 'string' ? e.code : undefined;
  const fromBody =
    e.responseData && typeof e.responseData === 'object' && e.responseData !== null
      ? (e.responseData as { code?: string }).code
      : undefined;
  const resolvedCode = code || (typeof fromBody === 'string' ? fromBody : undefined);
  const message =
    typeof e.message === 'string' && e.message.trim() ? e.message : undefined;
  if (!resolvedCode && !message) return null;
  return { code: resolvedCode, message };
}

function resolveCreateOnboardingLinkErrorMessage(error: unknown): string {
  const payload = getApiErrorPayload(error);
  if (payload?.code && ONBOARDING_LINK_DUPLICATE_EMAIL_CODES.has(payload.code)) {
    return ONBOARDING_LINK_DUPLICATE_EMAIL_MESSAGE;
  }
  if (payload?.message) {
    return payload.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'Failed to create onboarding link';
}

export interface GroupOnboardingData {
  linkId: string;
  groupId: string;
  groupName: string;
  tenantName: string;
  tenantLogoUrl?: string;
  groupLogoUrl?: string;
  groupStatus: string;
  expiresAt: string;
  currentData: {
    name: string;
    primaryContact: string;
    contactEmail: string;
    contactPhone: string;
    address: string;
    city: string;
    state: string;
    zip: string;
    taxIdNumber: string;
    businessType: string;
  };
  requiredFields: {
    name: boolean;
    primaryContact: boolean;
    contactEmail: boolean;
    contactPhone: boolean;
    address: boolean;
    city: boolean;
    state: boolean;
    zip: boolean;
    taxIdNumber: boolean;
    businessType: boolean;
  };
  isComplete: boolean;
  asaAgreement?: {
    documentId: string;
    documentName: string;
    documentUrl: string;
    productId?: string;
  };
  requiresASA: boolean;
  agentName?: string;
  agentEmail?: string;
}

export interface GroupInfoData {
  name: string;
  primaryContact: string;
  primaryContactFirstName: string;
  primaryContactLastName: string;
  contactEmail: string;
  contactPhone: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  taxIdNumber: string;
  businessType: string;
}

export interface GroupAdminInfoData {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

export interface CompleteOnboardingRequest {
  groupInfo: GroupInfoData;
  groupAdminInfo: GroupAdminInfoData;
  bankingInfo?: any;
  billingInfo?: any;
  logoFile?: File;
  existingLogoUrl?: string;
}

export interface CompleteOnboardingResponse {
  success: boolean;
  data: {
    email: string;
    userId: string;
  };
  message?: string;
}

export interface SetupPasswordRequest {
  password: string;
}

export interface SetupPasswordResponse {
  success: boolean;
  data: {
    token: string;
    userId: string;
    email: string;
    groupId: string;
  };
  message?: string;
}

export class GroupOnboardingService {
  static async getOnboardingData(linkToken: string): Promise<{ success: boolean; data: GroupOnboardingData; message?: string; linkStatus?: string }> {
    return await apiService.get(`/api/group-onboarding/${linkToken}/group-data`);
  }

  static async completeOnboarding(linkToken: string, data: CompleteOnboardingRequest): Promise<CompleteOnboardingResponse> {
    // Handle logo upload first if there's a new logo file
    // Logo upload is optional - if it fails, we continue without it
    let logoUrl = data.existingLogoUrl;
    
    if (data.logoFile) {
      try {
        console.log('📤 Uploading logo file for group onboarding completion (token-protected)');
        const formData = new FormData();
        formData.append('files', data.logoFile);
        formData.append('uploadType', 'logos');
        formData.append('type', 'logos');
        formData.append('entityId', 'temp');
        formData.append('linkToken', linkToken);
        const uploadResponse = await apiService.post<ApiResponse<any[]>>('/api/public/onboarding-upload', formData);
        if (uploadResponse.success && (uploadResponse as any).url) {
          logoUrl = (uploadResponse as any).url;
          console.log('✅ Logo uploaded successfully:', logoUrl);
        } else if (uploadResponse.success && uploadResponse.data?.[0]?.url) {
          logoUrl = uploadResponse.data[0].url;
          console.log('✅ Logo uploaded successfully:', logoUrl);
        } else {
          console.warn('⚠️ Logo upload failed (continuing without logo):', (uploadResponse as any).message);
        }
      } catch (error: any) {
        console.warn('⚠️ Logo upload failed (continuing without logo):', error?.message || 'Upload service unavailable');
        // Don't throw - logo is optional
      }
    }
    
    // Remove logoFile from data and add logoUrl
    const { logoFile, existingLogoUrl, ...cleanData } = data;
    const finalData = {
      ...cleanData,
      ...(logoUrl && { logoUrl })
    };
    
    return await apiService.post(`/api/group-onboarding/${linkToken}/complete`, finalData);
  }

  static async setupPassword(linkToken: string, data: SetupPasswordRequest): Promise<SetupPasswordResponse> {
    return await apiService.post(`/api/group-onboarding/${linkToken}/setup-password`, data);
  }

  static async createOnboardingLink(
    groupId: string,
    sendEmail: boolean,
    groupAdminEmail?: string,
    groupAdminName?: string,
    linkBaseUrl?: string
  ): Promise<{ success: boolean; data: any; message?: string }> {
    console.log('🚀 Service: createOnboardingLink called with:', {
      groupId,
      sendEmail,
      groupAdminEmail,
      groupAdminName,
      linkBaseUrl
    });

    try {
      const body: Record<string, unknown> = {
        sendEmail,
        groupAdminEmail,
        groupAdminName
      };
      if (linkBaseUrl != null && linkBaseUrl.trim() !== '') {
        body.linkBaseUrl = linkBaseUrl.trim();
      }
      const response = await apiService.post(`/api/me/agent/groups/${groupId}/onboarding-links`, body);
      
      console.log('📥 Service: Received response:', response);
      
      // Ensure the response has the expected structure
      if (response && typeof response === 'object' && 'success' in response) {
        return response as { success: boolean; data: any; message?: string };
      } else {
        // If response doesn't have expected structure, return a default error response
        return {
          success: false,
          data: null,
          message: 'Invalid response format from server'
        };
      }
    } catch (error) {
      console.error('Error creating onboarding link:', error);
      return {
        success: false,
        data: null,
        message: resolveCreateOnboardingLinkErrorMessage(error)
      };
    }
  }

  static async getOnboardingLinks(groupId: string): Promise<{ success: boolean; data: any[]; message?: string }> {
    try {
      const response = await apiService.get(`/api/me/agent/groups/${groupId}/onboarding-links`);
      return response as { success: boolean; data: any[]; message?: string };
    } catch (error) {
      console.error('Error fetching onboarding links:', error);
      return {
        success: false,
        data: [],
        message: error instanceof Error ? error.message : 'Failed to fetch onboarding links'
      };
    }
  }

  static async getOnboardingStatus(groupId: string): Promise<{ success: boolean; data: any; message?: string }> {
    try {
      const response = await apiService.get(`/api/me/agent/groups/${groupId}/onboarding-status`);
      return response as { success: boolean; data: any; message?: string };
    } catch (error) {
      console.error('Error fetching onboarding status:', error);
      return {
        success: false,
        data: null,
        message: error instanceof Error ? error.message : 'Failed to fetch onboarding status'
      };
    }
  }

  static async markOnboardingComplete(groupId: string): Promise<{ success: boolean; message?: string }> {
    try {
      const response = await apiService.post(`/api/me/agent/groups/${groupId}/onboarding-status/mark-complete`, {});
      return response as { success: boolean; message?: string };
    } catch (error) {
      console.error('Error marking onboarding complete:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to mark onboarding complete'
      };
    }
  }

  static async resendOnboardingLink(groupId: string): Promise<{ success: boolean; data: any; message?: string }> {
    try {
      const response = await apiService.post(`/api/me/agent/groups/${groupId}/onboarding-links/resend`);
      return response as { success: boolean; data: any; message?: string };
    } catch (error) {
      console.error('Error resending onboarding link:', error);
      return {
        success: false,
        data: null,
        message: error instanceof Error ? error.message : 'Failed to resend onboarding link'
      };
    }
  }

  static async invalidateOnboardingLink(groupId: string, linkId: string): Promise<{ success: boolean; message?: string }> {
    try {
      const response = await apiService.delete(`/api/me/agent/groups/${groupId}/onboarding-links/${linkId}`);
      return response as { success: boolean; message?: string };
    } catch (error) {
      console.error('Error invalidating onboarding link:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to invalidate onboarding link'
      };
    }
  }
}

export default GroupOnboardingService;