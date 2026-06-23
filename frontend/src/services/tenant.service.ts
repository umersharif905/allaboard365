import { apiService } from './api.service';

export interface TenantSettings {
  tenantId: string;
  name?: string;
  contactEmail?: string;
  contactPhone?: string;
  website?: string;
  address?: {
    street?: string;
    city?: string;
    state?: string;
    zip?: string;
  };
  branding: {
    logoUrl?: string;
    primaryColorHex: string;
    secondaryColorHex: string;
    accentColorHex: string;
    fontFamily: string;
    customCSS?: string;
    customDomain?: string;
  };
  domainSettings: {
    customUrl?: string;
    defaultUrlPath?: string;
    verificationStatus: 'Pending' | 'Verified' | 'Failed' | 'pending' | 'verified' | 'failed';
    sslEnabled: boolean;
    dnsInstructions?: string;
  };
  emailSettings: {
    customFromAddress?: string;
    dkimEnabled: boolean;
    dkimDomain?: string;
    dkimSelector?: string;
    dkimPublicKey?: string;
    dkimPrivateKey?: string;
    smtpEnabled: boolean;
    smtpHost?: string;
    smtpPort?: number;
    smtpUsername?: string;
    smtpSettings?: {
      host: string;
      port: number;
      username: string;
    };
  };
  notificationSettings: {
    enrollmentNotifications: boolean;
    paymentNotifications: boolean;
    systemAlerts: boolean;
    marketingEmails: boolean;
  };
  features: {
    showLandingPage: boolean;
    enableSelfService: boolean;
    requireEmailVerification: boolean;
    allowGuestCheckout: boolean;
    enableReferrals: boolean;
  };
  apiKeys: {
    enabled: boolean;
    keyCount: number;
    keys?: any[];
  };
}

class TenantService {
  /**
   * Get my tenant information - role-aware endpoint selection
   */
  static async getMyTenant(user: any): Promise<{ success: boolean; data?: any; message?: string }> {
    // Use role-specific endpoint based on current role
    const currentRole = user?.currentRole || localStorage.getItem('currentRole');
    
    switch (currentRole) {
      case 'TenantAdmin':
        return apiService.get('/api/me/tenant-admin/tenant');
      case 'Agent':
        // Use the agent tenant endpoint
        return apiService.get('/api/me/agent/tenant');
      case 'SysAdmin':
        // SysAdmin would get specific tenant by ID, not "my tenant"
        return { success: false, message: 'SysAdmin should use /api/tenants/:id endpoint' };
      default:
        console.error('Unknown role for getMyTenant:', currentRole);
        return { success: false, message: 'Unknown role' };
    }
  }

  /**
   * Get tenant settings including custom domain
   */
  static async getTenantSettings(): Promise<{ success: boolean; data?: TenantSettings; message?: string }> {
    return apiService.get('/api/me/tenant-admin/settings');
  }

  /**
   * Get the onboarding URL with custom domain
   */
  static async getOnboardingUrl(): Promise<string> {
    try {
      const settingsResponse = await this.getTenantSettings();
      
      if (settingsResponse.success && settingsResponse.data) {
        const customDomain = settingsResponse.data.domainSettings.customUrl;
        
        if (customDomain && settingsResponse.data.domainSettings.verificationStatus?.toLowerCase() === 'verified') {
          // Use custom domain with HTTPS
          return `https://${customDomain}/agent-onboarding`;
        }
      }
      
      // Fallback to current origin
      return `${window.location.origin}/agent-onboarding`;
    } catch (error) {
      console.error('Error getting onboarding URL:', error);
      // Fallback to current origin
      return `${window.location.origin}/agent-onboarding`;
    }
  }
}

export default TenantService;