// frontend/src/services/onboardingLinks.service.ts
import { apiService } from './api.service';

export interface OnboardingLink {
  LinkId: string;
  LinkName: string;
  LinkToken: string;
  IsActive: boolean;
  CurrentUses: number;
  CreatedDate: string;
  ModifiedDate: string;
  ContractDocumentId?: string;
  ContractFileName?: string;
  ContractDocumentUrl?: string;
  AgentId?: string;
  AgencyId?: string;
  AgentName?: string;
  AgentEmail?: string;
  AgencyName?: string;
  CommissionCodeCount?: number;
  TotalSessions?: number;
  CompletedSessions?: number;
  CompletionRate?: number;
}

export interface CreateOnboardingLinkRequest {
  linkName: string;
  agencyId?: string;
  agentId?: string;
  contractDocumentId?: string;
}

export interface UpdateOnboardingLinkRequest {
  linkName?: string;
  isActive?: boolean;
  contractDocumentId?: string;
}


export interface OnboardingSession {
  SessionId: string;
  SessionToken: string;
  Status: 'Pending' | 'InProgress' | 'Completed' | 'Expired' | 'Failed' | 'Cancelled';
  StartedDate: string;
  CompletedDate?: string;
  ExpiresDate: string;
  IPAddress?: string;
  UserAgent?: string;
  AgentId?: string;
  AgentName?: string;
  AgentEmail?: string;
  AgentData?: any;
}

export interface OnboardingStats {
  TotalLinks: number;
  ActiveLinks: number;
  TotalUses: number;
  TotalSessions: number;
  CompletedSessions: number;
  InProgressSessions: number;
  PendingSessions: number;
  FailedSessions: number;
  OverallCompletionRate: number;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
}

export class OnboardingLinksService {
  /**
   * Get base URL based on current role
   */
  private static getBaseUrl(currentRole: string): string {
    switch (currentRole) {
      case 'Agent':
        return '/api/me/agent/onboarding-links';
      case 'TenantAdmin':
      case 'SysAdmin':
        return '/api/me/tenant-admin/onboarding-links';
      default:
        throw new Error(`Unsupported role for onboarding links: ${currentRole}`);
    }
  }

  /**
   * Get all onboarding links for the current user (role-aware)
   * @param currentRole - Current user role
   * @param agentId - Optional agent ID to filter by (TenantAdmin only)
   * @param agencyId - Optional agency ID to filter by (TenantAdmin only)
   * @param page - Optional page number for pagination
   * @param limit - Optional limit per page for pagination
   */
  static async getOnboardingLinks(
    currentRole: string,
    agentId?: string,
    agencyId?: string,
    page?: number,
    limit?: number
  ): Promise<ApiResponse<OnboardingLink[]>> {
    const baseUrl = this.getBaseUrl(currentRole);
    const params = new URLSearchParams();
    
    if (agentId) {
      params.append('agentId', agentId);
    }
    if (agencyId) {
      params.append('agencyId', agencyId);
    }
    if (page) {
      params.append('page', page.toString());
    }
    if (limit) {
      params.append('limit', limit.toString());
    }
    
    const url = params.toString() ? `${baseUrl}?${params.toString()}` : baseUrl;
    return apiService.get(url);
  }

  /**
   * Create a new onboarding link (role-aware)
   */
  static async createOnboardingLink(linkData: CreateOnboardingLinkRequest, currentRole: string): Promise<ApiResponse<OnboardingLink>> {
    const baseUrl = this.getBaseUrl(currentRole);
    return apiService.post(baseUrl, linkData);
  }

  /**
   * Update an existing onboarding link (role-aware)
   */
  static async updateOnboardingLink(linkId: string, linkData: UpdateOnboardingLinkRequest, currentRole: string): Promise<ApiResponse<void>> {
    const baseUrl = this.getBaseUrl(currentRole);
    return apiService.put(`${baseUrl}/${linkId}`, linkData);
  }

  /**
   * Deactivate an onboarding link (soft delete) (role-aware)
   */
  static async deleteOnboardingLink(linkId: string, currentRole: string): Promise<ApiResponse<void>> {
    const baseUrl = this.getBaseUrl(currentRole);
    return apiService.delete(`${baseUrl}/${linkId}`);
  }

  /**
   * Get onboarding sessions for a specific link (role-aware)
   */
  static async getLinkSessions(linkId: string, currentRole: string): Promise<ApiResponse<OnboardingSession[]>> {
    const baseUrl = this.getBaseUrl(currentRole);
    return apiService.get(`${baseUrl}/${linkId}/sessions`);
  }

  /**
   * Get onboarding statistics (role-aware)
   */
  static async getOnboardingStats(currentRole: string): Promise<ApiResponse<OnboardingStats>> {
    const baseUrl = this.getBaseUrl(currentRole);
    return apiService.get(`${baseUrl}/stats`);
  }


  /**
   * Save onboarding progress (public API)
   */
  static async saveOnboardingProgress(sessionToken: string, currentStep: number, agentData: any): Promise<ApiResponse<void>> {
    return apiService.post('/api/public/onboarding/save-progress', { 
      sessionToken, 
      currentStep, 
      agentData 
    });
  }

  /**
   * Complete onboarding process (public API)
   */
  static async completeOnboarding(sessionToken: string, agentData: any, digitalSignature?: string, signatureDate?: string): Promise<ApiResponse<any>> {
    return apiService.post('/api/public/onboarding/complete', { 
      sessionToken, 
      agentData, 
      digitalSignature, 
      signatureDate 
    });
  }

  /**
   * Get session details by token (public API)
   */
  static async getSessionDetails(sessionToken: string): Promise<ApiResponse<any>> {
    return apiService.get(`/api/public/onboarding/session/${sessionToken}`);
  }

  /**
   * Get public onboarding link details by commission code (public API)
   */
  static async getPublicLink(linkToken: string): Promise<ApiResponse<any>> {
    console.log('🌐 OnboardingLinksService.getPublicLink called with token:', linkToken);
    const response = await apiService.get(`/api/public/onboarding/link/${linkToken}`) as ApiResponse<any>;
    console.log('📡 OnboardingLinksService.getPublicLink response:', response);
    return response;
  }

  static async validateCommissionCode(linkToken: string, commissionCode: string, sessionToken?: string): Promise<ApiResponse<any>> {
    return apiService.post('/api/public/onboarding/validate-code', { linkToken, commissionCode, sessionToken });
  }

  /**
   * Start an onboarding session (public API)
   */
  static async startSession(linkToken: string): Promise<ApiResponse<any>> {
    return apiService.post('/api/public/onboarding/start', { linkToken });
  }

  /**
   * Save onboarding progress (public API)
   */
  static async saveProgress(sessionToken: string, agentData: any, currentStep: number): Promise<ApiResponse<any>> {
    return apiService.post('/api/public/onboarding/save-progress', { 
      sessionToken, 
      agentData, 
      currentStep 
    });
  }

  /**
   * Get session progress (public API)
   */
  static async getSessionProgress(sessionToken: string): Promise<ApiResponse<any>> {
    return apiService.get(`/api/public/onboarding/session/${sessionToken}`);
  }

  // Commission Codes Management (role-aware)
  static async getCommissionCodes(linkId: string, currentRole: string): Promise<any[]> {
    const baseUrl = this.getBaseUrl(currentRole);
    const response = await apiService.get(`${baseUrl}/${linkId}/codes`) as ApiResponse<any[]>;
    return (response.success && response.data) ? response.data : [];
  }

  static async addCommissionCode(linkId: string, commissionCode: string, commissionGroupId: string | null, currentRole: string, grantTierLevel?: number | null): Promise<ApiResponse<any>> {
    const baseUrl = this.getBaseUrl(currentRole);
    const body: Record<string, unknown> = { commissionCode };
    if (commissionGroupId && commissionGroupId !== '__none__') {
      body.commissionGroupId = commissionGroupId;
    }
    if (grantTierLevel !== undefined && grantTierLevel !== null) {
      body.grantTierLevel = grantTierLevel;
    }
    return apiService.post(`${baseUrl}/${linkId}/codes`, body);
  }

  static async updateCommissionCode(linkId: string, codeId: string, updates: {
    commissionCode?: string;
    commissionGroupId?: string;
    isActive?: boolean;
    grantTierLevel?: number | null;
  }, currentRole: string): Promise<ApiResponse<any>> {
    const baseUrl = this.getBaseUrl(currentRole);
    return apiService.put(`${baseUrl}/${linkId}/codes/${codeId}`, updates);
  }

  static async removeCommissionCode(linkId: string, codeId: string, currentRole: string): Promise<ApiResponse<any>> {
    const baseUrl = this.getBaseUrl(currentRole);
    return apiService.delete(`${baseUrl}/${linkId}/codes/${codeId}`);
  }

  /** Server-side idempotent bulk generation (transaction + row lock). */
  static async autoGenerateCommissionCodes(
    linkId: string,
    currentRole: string,
    mode: 'empty' | 'missing'
  ): Promise<ApiResponse<{ skipped?: boolean; added?: number }>> {
    const baseUrl = this.getBaseUrl(currentRole);
    return apiService.post(`${baseUrl}/${linkId}/codes/auto-generate`, { mode });
  }

  /**
   * Resend verification email (public API)
   */
  static async resendVerificationEmail(sessionToken: string): Promise<ApiResponse<any>> {
    console.log('🌐 OnboardingLinksService.resendVerificationEmail called');
    console.log('📝 SessionToken:', sessionToken ? sessionToken.substring(0, 20) + '...' : 'NONE');
    console.log('📍 Endpoint: /api/public/onboarding/resend-verification');
    
    try {
      const response = await apiService.post('/api/public/onboarding/resend-verification', { sessionToken }) as ApiResponse<any>;
      console.log('📡 Service response:', response);
      return response;
    } catch (error: any) {
      console.error('❌ Error in resendVerificationEmail:', error);
      
      // Handle 429 rate limit errors
      if (error?.status === 429 || error?.response?.status === 429) {
        return {
          success: false,
          message: error?.message || 'Too many requests. Please wait a few minutes before requesting another verification email.',
          error: 'RATE_LIMIT_EXCEEDED'
        };
      }
      
      // Handle other errors
      return {
        success: false,
        message: error?.message || 'Failed to resend verification email. Please try again later.',
        error: error?.code || 'RESEND_ERROR'
      };
    }
  }
}
