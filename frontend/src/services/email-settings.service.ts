// frontend/src/services/email-settings.service.ts
import { apiService } from './api.service';

export interface DnsRecord {
  type: 'CNAME' | 'TXT';
  host: string;
  value: string;
  status: 'pending' | 'verified' | 'failed';
}

export interface EmailSettings {
  customFromAddress: string;
  dkimEnabled: boolean;
  dkimDomain: string;
  dkimSelector: string;
  sendgridDomainId: string | null;
  dnsRecords: DnsRecord[];
  verificationStatus: 'none' | 'pending' | 'verified' | 'failed';
}

export interface GenerateDkimResponse {
  success: boolean;
  data?: {
    domain: string;
    sendgridDomainId: string;
    dnsRecords: DnsRecord[];
    verificationStatus: 'pending';
    needsReset: boolean;
  };
  message?: string;
  error?: {
    message: string;
    code: string;
  };
}

export interface VerifyDkimResponse {
  success: boolean;
  data?: {
    verificationStatus: 'pending' | 'verified' | 'failed';
    dkimEnabled: boolean;
    dnsRecords: DnsRecord[];
    validationResult: any;
  };
  message?: string;
  error?: {
    message: string;
    code: string;
  };
}

export interface UpdateEmailSettingsResponse {
  success: boolean;
  data?: {
    customFromAddress: string;
    dkimEnabled: boolean;
    dkimDomain: string;
    verificationStatus: 'none' | 'pending' | 'verified' | 'failed';
  };
  message?: string;
  error?: {
    message: string;
    code: string;
  };
}

export class EmailSettingsService {
  /**
   * Generate DKIM records for a domain
   * @param domain - The domain to generate DKIM records for
   * @param tenantId - Optional tenant ID (for SysAdmin access)
   * @returns Promise<GenerateDkimResponse>
   */
  static async generateDkimRecords(domain: string, tenantId?: string): Promise<GenerateDkimResponse> {
    try {
      console.log(`🔧 Generating DKIM records for domain: ${domain}`);
      
      const url = tenantId ? `/api/email-config/dkim/generate?tenantId=${tenantId}` : '/api/email-config/dkim/generate';
      const response = await apiService.post<GenerateDkimResponse>(url, {
        domain: domain
      });

      if (response.success) {
        console.log(`✅ DKIM records generated successfully for domain: ${domain}`);
      } else {
        console.error(`❌ Failed to generate DKIM records: ${response.message}`);
      }

      return response;
    } catch (error) {
      console.error('❌ Error generating DKIM records:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to generate DKIM records',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'DKIM_GENERATION_FAILED'
        }
      };
    }
  }

  /**
   * Verify DKIM domain authentication
   * @param tenantId - Optional tenant ID (for SysAdmin access)
   * @returns Promise<VerifyDkimResponse>
   */
  static async verifyDkimDomain(tenantId?: string): Promise<VerifyDkimResponse> {
    try {
      console.log('🔧 Verifying DKIM domain authentication...');
      
      const url = tenantId ? `/api/email-config/dkim/verify?tenantId=${tenantId}` : '/api/email-config/dkim/verify';
      const response = await apiService.post<VerifyDkimResponse>(url, {});

      if (response.success) {
        console.log(`✅ DKIM verification completed: ${response.data?.verificationStatus}`);
      } else {
        console.error(`❌ Failed to verify DKIM domain: ${response.message}`);
      }

      return response;
    } catch (error) {
      console.error('❌ Error verifying DKIM domain:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to verify DKIM domain',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'DKIM_VERIFICATION_FAILED'
        }
      };
    }
  }

  /**
   * Delete DKIM configuration
   * @param tenantId - Optional tenant ID (for SysAdmin access)
   * @returns Promise<{success: boolean, message?: string}>
   */
  static async deleteDkimConfiguration(tenantId?: string): Promise<{success: boolean, message?: string}> {
    try {
      console.log('🔧 Deleting DKIM configuration...');
      
      const url = tenantId ? `/api/email-config/dkim?tenantId=${tenantId}` : '/api/email-config/dkim';
      const response = await apiService.delete<{success: boolean, message?: string}>(url);

      if (response.success) {
        console.log('✅ DKIM configuration deleted successfully');
      } else {
        console.error(`❌ Failed to delete DKIM configuration: ${response.message}`);
      }

      return response;
    } catch (error) {
      console.error('❌ Error deleting DKIM configuration:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to delete DKIM configuration'
      };
    }
  }

  /**
   * Get email settings for current tenant
   * @param tenantId - Optional tenant ID (for SysAdmin access)
   * @returns Promise<{success: boolean, data?: EmailSettings}>
   */
  static async getEmailSettings(tenantId?: string): Promise<{success: boolean, data?: EmailSettings, message?: string}> {
    try {
      console.log('🔧 Getting email settings...');
      
      // For TenantAdmin users, we'll use a placeholder tenant ID since the backend
      // will use the tenantId from the middleware for non-SysAdmin users
      // For SysAdmin users, they can pass a specific tenantId
      const url = tenantId ? `/api/email-config/dkim/${tenantId}` : '/api/email-config/dkim/current-tenant';
      const response = await apiService.get<{success: boolean, data?: EmailSettings, message?: string}>(url);

      if (response.success) {
        console.log('✅ Email settings retrieved successfully');
      } else {
        console.error(`❌ Failed to get email settings: ${response.message}`);
      }

      return response;
    } catch (error) {
      console.error('❌ Error getting email settings:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to get email settings'
      };
    }
  }

  /**
   * Update email settings (custom from address, etc.)
   * @param settings - Email settings to update
   * @returns Promise<UpdateEmailSettingsResponse>
   */
  static async updateEmailSettings(settings: {customFromAddress?: string}): Promise<UpdateEmailSettingsResponse> {
    try {
      console.log('🔧 Updating email settings...');
      
      const response = await apiService.patch<UpdateEmailSettingsResponse>('/api/email-config/settings', settings);

      if (response.success) {
        console.log('✅ Email settings updated successfully');
      } else {
        console.error(`❌ Failed to update email settings: ${response.message}`);
      }

      return response;
    } catch (error) {
      console.error('❌ Error updating email settings:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to update email settings',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'UPDATE_EMAIL_SETTINGS_FAILED'
        }
      };
    }
  }

  /**
   * Extract domain from email address
   * @param email - Email address
   * @returns Domain part of email address
   */
  static extractDomainFromEmail(email: string): string | null {
    if (!email || typeof email !== 'string') {
      return null;
    }

    const emailRegex = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/;
    const match = email.match(emailRegex);
    return match ? match[1] : null;
  }

  /**
   * Validate email address format
   * @param email - Email address to validate
   * @returns True if email format is valid
   */
  static isValidEmail(email: string): boolean {
    if (!email || typeof email !== 'string') {
      return false;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  /**
   * Validate domain format
   * @param domain - Domain to validate
   * @returns True if domain format is valid
   */
  static isValidDomain(domain: string): boolean {
    if (!domain || typeof domain !== 'string') {
      return false;
    }

    const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.([a-zA-Z]{2,}|[a-zA-Z]{2,}\.[a-zA-Z]{2,})$/;
    return domainRegex.test(domain);
  }

  /**
   * Get status color for verification status
   * @param status - Verification status
   * @returns CSS classes for status styling
   */
  static getStatusColor(status: string): string {
    switch (status) {
      case 'verified':
        return 'bg-green-100 text-green-800';
      case 'failed':
        return 'bg-red-100 text-red-800';
      case 'pending':
        return 'bg-yellow-100 text-yellow-800';
      case 'none':
      default:
        return 'bg-gray-100 text-gray-800';
    }
  }

  /**
   * Get status icon for verification status
   * @param status - Verification status
   * @returns Icon name for status
   */
  static getStatusIcon(status: string): string {
    switch (status) {
      case 'verified':
        return 'CheckCircle';
      case 'failed':
        return 'XCircle';
      case 'pending':
        return 'Clock';
      case 'none':
      default:
        return 'Circle';
    }
  }

  /**
   * Copy text to clipboard
   * @param text - Text to copy
   * @returns Promise<boolean> - Success status
   */
  static async copyToClipboard(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      } else {
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        textArea.style.top = '-999999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        const result = document.execCommand('copy');
        textArea.remove();
        return result;
      }
    } catch (error) {
      console.error('❌ Failed to copy to clipboard:', error);
      return false;
    }
  }
}
