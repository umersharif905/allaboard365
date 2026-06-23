// src/types/marketplace.ts
export interface Product {
  ProductId: string;
  Name: string;
  Description: string;
  ProductType: string;
  Status: string;
  IsMarketplaceProduct: boolean;
  IsPublic: boolean;
  IsBundle: boolean;
  IsHidden?: boolean | number; // Hide product from agents (typically for bundle components)
  BundleProducts?: string; // Comma-separated list of included product names
  ProductImageUrl?: string;
  ProductLogoUrl?: string;
  ProductDocumentUrl?: string;
  ContactDetails?: string;
  PartNumber?: string; // Product part number or policy ID
  MinAge?: number;
  MaxAge?: number;
  AllowedStates?: string[];
  SalesType?: string;
  RequiresTobaccoInfo: boolean;
  EffectiveDateLogic?: string;
  RequiredLicenses?: string[];
  ProductOwnerName: string;
  ProductOwnerId: string;
  ProductOwnerEmail: string;
  ProductOwnerLogo?: string;
  BasePrice?: number;
  ActiveSubscribers: number;
  IsSubscribed?: boolean;
  SubscriptionStatus?: string;
  
  // Vendor fields - FIXED to match backend expectations
  VendorId?: string;
  VendorName?: string;
  IsVendorPrice?: boolean;
  VendorCommission?: number;  // Backend returns this as uppercase
  vendorCommission?: number;  // Lowercase version for compatibility
  
  // Other fields that might be needed for editing
  TerminationLogic?: string;
  MaxEffectiveDateDays?: number;
  ConfigurationFields?: any[];
  AcknowledgementQuestions?: any[];
  PricingTiers?: any[];
  IDCardData?: any;
  PlanDetailsData?: any;
  AIChunks?: any[];
}

export interface FilterState {
  search: string;
  productType: string;
  salesType: string;
  minPrice: string;
  maxPrice: string;
  requiredLicenses: string[];
  productOwner: string;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  products?: T[];
  message?: string;
  error?: string;
}

export interface FilterParams {
  search?: string;
  productType?: string;
  salesType?: string;
  minPrice?: string;
  maxPrice?: string;
  productOwner?: string;
  requiredLicenses?: string[];
}

export interface MarketplaceStats {
  totalProducts: number;
  totalTenants: number;
  activeSubscriptions?: number;
  pendingRequests?: number;
}

export interface ProductOwner {
  ProductOwnerId: string;
  Name: string;
  LogoUrl?: string;
  ProductCount: number;
}

export interface ProductType {
  ProductType: string;
  ProductCount: number;
}

export interface ProductSubscription {
  SubscriptionId: string;
  ProductId: string;
  ProductName: string;
  TenantId: string;
  TenantName: string;
  RequestDate: Date;
  ApprovalDate?: Date;
  Status: 'Pending' | 'Approved' | 'Denied';
  Notes?: string;
  ApprovedBy?: string;
}

export interface CreateProductRequest {
  name: string;
  description: string;
  productType: string;
  productOwnerId: string;
  salesType: string;
  minAge: number;
  maxAge: number;
  allowedStates: string[];
  requiresTobaccoInfo: boolean;
  effectiveDateLogic: string;
  requiredLicenses: string[];
  isBundle: boolean;
  bundleProducts?: string[];
  productImageUrl?: string;
  productLogoUrl?: string;
  productDocumentUrl?: string;
  pricingTiers?: any[];
  configurationFields?: any[];
  acknowledgementQuestions?: any[];
  
  // Vendor fields - using lowercase to match backend
  vendorId?: string;
  isVendorPricing?: boolean;
  vendorCommission?: number;
}

export interface UpdateProductRequest extends Partial<CreateProductRequest> {
  productId: string;
}