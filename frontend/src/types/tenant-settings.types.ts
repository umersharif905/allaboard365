// src/types/tenant-settings.types.ts
export interface EmailSettings {
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

export interface TenantFormData {
  emailSettings?: EmailSettings;
  branding?: {
    logoUrl?: string;
    primaryColor?: string;
    secondaryColor?: string;
  };
  domainSettings?: {
    customDomain?: string;
    verified?: boolean;
  };
}

export interface TenantSettings {
  tenantId: string;
  name: string;
  settings: TenantFormData;
  createdDate: string;
  modifiedDate: string;
}
