// frontend/src/types/tenant.types.ts

export interface Tenant {
  TenantId: string;
  Name: string;
  Status: 'Active' | 'Inactive' | 'Suspended';
  CreatedDate: string;
  ModifiedDate: string;
  Address?: string;
  City?: string;
  State?: string;
  Zip?: string;
  Country?: string;
  PrimaryContact?: string;
  PrimaryEmail?: string;
  PrimaryPhone?: string;
  BillingContact?: string;
  BillingEmail?: string;
  BillingPhone?: string;
  TechnicalContact?: string;
  TechnicalEmail?: string;
  TechnicalPhone?: string;
  SubscriptionPlan?: string;
  SubscriptionStartDate?: string;
  SubscriptionEndDate?: string;
  Domain?: string;
  LogoUrl?: string;
} 