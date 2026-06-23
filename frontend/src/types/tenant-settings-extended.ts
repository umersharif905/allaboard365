// src/types/tenant-settings-extended.ts
/**
 * Extended types specifically for TenantSettings component
 */

export interface ExtendedEmailSettings {
  customFromAddress?: string;
  smtpSettings?: {
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password?: string;
  };
  dkimEnabled?: boolean;
  dkimSelector?: string;
  dkimPublicKey?: string;
  dkimPrivateKey?: string;
  dkimDomain?: string;
}

export interface ExtendedTenantFormData {
  branding?: {
    logoUrl?: string;
    primaryColor?: string;
    secondaryColor?: string;
    primaryColorHex?: string;
    secondaryColorHex?: string;
  };
  emailSettings?: ExtendedEmailSettings;
  domainSettings?: {
    customDomain?: string;
    verified?: boolean;
  };
  notificationSettings?: {
    emailNotifications?: boolean;
    smsNotifications?: boolean;
    pushNotifications?: boolean;
  };
}
