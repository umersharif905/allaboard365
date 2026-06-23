// src/types/index.ts
/**
 * Clean Type Index - Re-exports existing comprehensive types
 */

// ===============================
// Core API Types
// ===============================
export type { User, UserProfile, UserRole } from './user.types';

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  message?: string;
  error?: { message: string; code?: string; };
  /** Set on some tenant-admin user flows when the API returns 400 with a structured body */
  isAlreadyTenantAdmin?: boolean;
  isDifferentTenant?: boolean;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

// ===============================
// Re-export Agent Types (if they exist)
// ===============================
export type {
    AgentMember, AgentMetrics, CommissionRecord,
    SalesActivity
} from './agent/agent.types';

// ===============================
// Re-export Tenant Admin Types (if they exist)
// ===============================
export type {
    TenantFinancialSummary, TenantGroup, TenantMetrics, TenantProductSubscription,
    TenantSettings, TenantUser
} from './tenant-admin/tenant-admin.types';

export * from './tenant-admin/tenant-admin.types';

// ===============================
// New Tenant Type Export
// ===============================
export type { Tenant } from './tenant.types';

// ===============================
// Email & Domain Settings (for TenantSettings component)
// ===============================
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

export interface BrandingSettings {
  logoUrl?: string;
  primaryColor?: string;
  secondaryColor?: string;
  primaryColorHex?: string;
  secondaryColorHex?: string;
}

export interface DomainSettings {
  customDomain?: string;
  verified?: boolean;
}

export interface NotificationSettings {
  emailNotifications?: boolean;
  smsNotifications?: boolean;
  pushNotifications?: boolean;
}

// ===============================
// Additional Response Types
// ===============================
export interface DkimResponse {
  selector: string;
  privateKey: string;
  publicKey: string;
}

export interface VerificationResponse {
  isValid: boolean;
  message?: string;
}

export interface UploadResponse {
  logoUrl: string;
  fileName: string;
}

export interface PasswordResetResponse {
  temporaryPassword: string;
  userId: string;
}

// Export types from member.types.ts
export * from './member.types';

