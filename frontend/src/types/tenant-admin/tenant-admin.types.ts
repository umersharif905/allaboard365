// src/types/tenant-admin/tenant-admin.types.ts
/**
 * Type definitions for Tenant Admin portal
 * Handles organization-scoped administration
 */

export interface TenantMetrics {
  employeeCount?: number; // Deprecated - use activeHouseholds instead
  activeHouseholds: number;
  groupHouseholds: number;
  individualHouseholds: number;
  memberCount: number;
  groupCount: number;
  activeEnrollments: number;
  monthlyPremiumRevenue: number;
  quarterlyGrowth: number;
  productSubscriptions: number;
  topAgents: Array<{
    agentId: string;
    agentName: string;
    agentEmail: string;
    activeHouseholds: number;
    totalRevenue: number;
  }>;
}

export interface TenantUser {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  roles: string[];
  status: 'Active' | 'Inactive' | 'Suspended';
  lastLoginDate?: string;
  createdDate: string;
  assignedGroups?: string[];
  /** Other tenants this user can access besides the org being viewed */
  otherTenantAccessCount?: number;
  /** True when this org is the user's primary TenantId */
  isPrimaryForThisOrg?: boolean;
  performanceMetrics?: {
    enrollments: number;
    revenue: number;
    conversionRate: number;
  };
}

export interface CreateTenantUserRequest {
  firstName?: string;
  lastName?: string;
  email: string;
  sendWelcomeEmail: boolean;
}

export interface TenantGroup {
  GroupId: string;
  Name: string;
  Status: 'Active' | 'Inactive' | 'Pending';
  PrimaryContact?: string;
  ContactEmail: string;
  ContactPhone?: string;
  ContactTitle?: string;
  Address?: string;
  Address2?: string;
  City?: string;
  State?: string;
  Zip?: string;
  ContactPhone2?: string;
  FaxNumber?: string;
  Website?: string;
  TaxIdNumber?: string;
  BusinessType?: string;
  CreditCardNumber?: string;  // Last 4 digits only
  CreditCardType?: string;
  CreditCardExpiry?: string;
  CreditCardName?: string;
  ACHBankName?: string;
  ACHAccountType?: string;
  ACHRoutingNumber?: string;
  ACHAccountNumber?: string;  // Last 4 digits only
  ACHAccountName?: string;
  LogoUrl?: string;
  DocumentsFolder?: string;
  CreatedDate: string;
  ModifiedDate?: string;
  AgentId?: string;
  TenantName: string;
  TenantId: string;
  AgentName?: string;
  AgentUserId?: string;
  AllAboardMasterGroupId?: string | null;
  TotalMembers: number;
  ActiveEnrollments: number;
  MonthlyPremium: number;
  EnrollmentSettings?: any;
  CreatedBy?: string;
  ModifiedBy?: string;
  
  // Additional properties for frontend compatibility
  memberCount?: number;
  description?: string;
  assignedAgentName?: string;
  assignedAgentId?: string;
  lastActivityDate?: string;
}

export interface CreateTenantGroupRequest {
  name: string;
  contactEmail: string;  // Required field
  description?: string;  // Added optional description
  assignedAgentId?: string;  // Added optional agent assignment
  primaryContact?: string;
  contactPhone?: string;
  contactTitle?: string;
  address?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  contactPhone2?: string;
  faxNumber?: string;
  website?: string;
  taxIdNumber?: string;
  businessType?: string;
  creditCardNumber?: string;
  creditCardType?: string;
  creditCardExpiry?: string;
  creditCardName?: string;
  achBankName?: string;
  achAccountType?: string;
  achRoutingNumber?: string;
  achAccountNumber?: string;
  achAccountName?: string;
  agentId?: string;  // This is actually UserId that will be converted to AgentId
  tenantId?: string; // For SysAdmin users
}

export interface UpdateTenantGroupRequest {
  name?: string;
  primaryContact?: string;
  contactEmail?: string;
  contactPhone?: string;
  contactTitle?: string;
  address?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  contactPhone2?: string;
  faxNumber?: string;
  website?: string;
  taxIdNumber?: string;
  businessType?: string;
  creditCardNumber?: string;
  creditCardType?: string;
  creditCardExpiry?: string;
  creditCardName?: string;
  achBankName?: string;
  achAccountType?: string;
  achRoutingNumber?: string;
  achAccountNumber?: string;
  achAccountName?: string;
  logoUrl?: string;
  documentsFolder?: string;
  status?: 'Active' | 'Inactive';
  agentId?: string;  // This is actually UserId that will be converted to AgentId
}

export interface TenantProductSubscription {
  subscriptionId: string;
  productId: string;
  productName: string;
  productType: string;
  status: 'Active' | 'Pending' | 'Denied' | 'Suspended';
  requestDate: string;
  approvalDate?: string;
  effectiveDate?: string;
  basePrice: number;
  negotiatedPrice?: number;
  systemFees: {
    platformFee: number;
    mobileAppFee: number;
    aiFee: number;
  };
  markupStructure: {
    commission: number;
    internalMarkup: number;
    totalMarkup: number;
  };
  enrollmentCount: number;
  monthlyRevenue: number;
}

export interface ProductSubscriptionRequest {
  productId: string;
  requestMessage?: string;
  estimatedVolume: number;
  requestedPricing?: {
    requestedDiscount: number;
    justification: string;
  };
}

export interface TenantSettings {
  tenantId: string;
  /** Display name (optional on some API responses) */
  name?: string;
  branding: {
    logoUrl?: string;
    primaryColorHex?: string;
    secondaryColorHex?: string;
    customDomain?: string;
    memberIDPrefix?: string;
  };
  emailSettings: {
    dkimEnabled: boolean;
    dkimDomain?: string;
    dkimSelector?: string;
    dkimPrivateKey?: string;
    dkimPublicKey?: string;
    customFromAddress?: string;
    smtpSettings?: {
      host: string;
      port: number;
      secure: boolean;
      username: string;
    };
  };
  domainSettings: {
    customUrl?: string;
    defaultUrlPath?: string;
    dnsInstructions?: string;
    verificationStatus: 'Pending' | 'Verified' | 'Failed';
  };
  notificationSettings: {
    enrollmentNotifications: boolean;
    paymentNotifications: boolean;
    systemAlerts: boolean;
  };
  /** Feature flags / toggles when returned by the API */
  features?: Record<string, unknown>;
  /** When true, billing is external; merchant settings are locked. SysAdmin can update via tenant settings. */
  isExternalBilling?: boolean;
}

export interface UpdateTenantSettingsRequest {
  branding?: {
    logoUrl?: string;
    primaryColorHex?: string;
    secondaryColorHex?: string;
    customDomain?: string;
  };
  emailSettings?: {
    customFromAddress?: string;
    smtpSettings?: {
      host: string;
      port: number;
      secure: boolean;
      username: string;
    };
  };
  domainSettings?: {
    customUrl?: string;
  };
  notificationSettings?: {
    enrollmentNotifications?: boolean;
    paymentNotifications?: boolean;
    systemAlerts?: boolean;
  };
}

export interface TenantFinancialSummary {
  monthlyRevenue: number;
  quarterlyRevenue: number;
  annualRevenue: number;
  commissionsPaid: number;
  outstandingCommissions: number;
  profitMargin: number;
  revenueByProduct: Array<{
    productId: string;
    productName: string;
    revenue: number;
    enrollmentCount: number;
  }>;
  revenueByAgent: Array<{
    agentId: string;
    agentName: string;
    revenue: number;
    commission: number;
  }>;
}

// API Response types
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  isAlreadyTenantAdmin?: boolean;
  isDifferentTenant?: boolean;
}

// Additional types for API responses
export interface DkimResponse {
  publicKey: string;
  privateKey: string;
  selector: string;
  dnsRecord: string;
}

export interface VerificationResponse {
  verified: boolean;
  message: string;
  details?: any;
}

export interface UploadResponse {
  url: string;
  fileName: string;
  fileSize: number;
}

export interface PasswordResetResponse {
  temporaryPassword: string;
  userId: string;
  message: string;
}

export type TenantAdminRemovalMode = 'removeRoleOnly' | 'softDelete' | 'permanentDelete';

export type TenantAdminRemovalScenario = 'additional_only' | 'primary_with_others' | 'last_tenant';

export interface TenantAdminRemovalPreview {
  scenario: TenantAdminRemovalScenario;
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  isPrimaryHere: boolean;
  otherTenantAccessCount: number;
  requiresNewPrimaryTenant: boolean;
  candidatePrimaryTenants?: Array<{ tenantId: string; name: string }>;
  hasOtherRoles?: boolean;
  otherRoles?: string[];
  canPermanentDelete?: boolean;
  allowedRemovalModes: TenantAdminRemovalMode[];
}

export interface RemoveTenantAdminRequest {
  newPrimaryTenantId?: string;
  removalMode?: TenantAdminRemovalMode;
}

export interface PrimaryTenantOption {
  tenantId: string;
  name: string;
  isPrimary: boolean;
}

export interface PrimaryTenantChangePreview {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  currentPrimaryTenantId: string;
  accessibleTenants: PrimaryTenantOption[];
  canChangePrimary: boolean;
}

export interface ChangePrimaryTenantRequest {
  newPrimaryTenantId: string;
}