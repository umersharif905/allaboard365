// =====================================================
// Enrollment Link Templates TypeScript Interfaces
// frontend/src/types/enrollment-link-templates.types.ts
// =====================================================

// Configuration field types for product pricing
export interface ProductConfiguration {
  productPricingId: string;
  tierType: string;
  tobaccoStatus: string;
  minAge: number;
  maxAge: number;
  configValue1?: string;
  configValue2?: string;
  configValue3?: string;
  configValue4?: string;
  configValue5?: string;
  monthlyPremium: number;
  employerContribution: number;
  employeeContribution: number;
  employerPercent: number;
  employeePercent: number;
  appliedRules: string;
}

// Enhanced product interface with configuration support
export interface ProductWithPricing {
  productId: string;
  productName: string;
  description: string;
  productType: string;
  status: string;
  allowedStates?: string[];
  isAvailableForState?: boolean;
  coverageDetails: string;
  pricingModel: string;
  isApplicable: boolean;
  applicabilityReason: string;
  pricingOptions: ProductConfiguration[];
  // Configuration fields
  hasConfigurationFields: boolean;
  requiredDataFields: string[] | null;
  pricingByConfig: Record<string, ProductConfiguration>;
  defaultConfig: string | null;
  availableConfigs: string[];
  // Pricing variations for configuration switching
  pricingVariations?: Array<{
    configValue: string;
    monthlyPremium: number;
    employerContribution: number;
    employeeContribution: number;
  }>;
  // Image fields
  productImageUrl?: string | null;
  productLogoUrl?: string | null;
  productDocumentUrl?: string | null;
  productDocuments?: { productDocumentId?: string; documentUrl: string; displayName?: string; sortOrder?: number }[];
  // Bundle fields
  isBundle?: boolean;
  includedProducts?: Array<{
    productId: string;
    productName: string;
    description: string;
    productType: string;
    isAvailable: boolean;
    allowedStates?: string[];
    isAvailableForState?: boolean;
    monthlyPremium: number;
    employerContribution: number;
    employeeContribution: number;
    productDocumentUrl?: string | null;
    productDocuments?: { productDocumentId?: string; documentUrl: string; displayName?: string; sortOrder?: number }[];
    requiredDataFields?: any[] | null;
    planDetailsData?: any | null;
    pricingTiers?: Array<{
      tierType: string;
      minMSRP: number;
      maxMSRP: number;
      count?: number;
    }> | null;
    productQuestionnaires?: {
      version: number;
      enabled: boolean;
      title: string;
      description: string;
      questions: Array<{
        id: string;
        text: string;
        type: 'yes_no' | 'text' | 'textarea' | 'checkbox' | 'dropdown' | 'number';
        required: boolean;
        options?: string[];
      }>;
      acknowledgement: {
        required: boolean;
        text: string;
      };
      requiresHeightWeight: boolean;
    } | null;
  }>;
  // Setup fee (one-time fee for first payment only)
  setupFee?: number | null;
  // Subscription-level processing-fee inclusion (tenant product subscription config)
  includeProcessingFee?: boolean;
  customSystemFeeEnabled?: boolean;
  customSystemFeeAmount?: number | null;
  roundUpProcessingFee?: boolean;
  /** When true, this product's processing fee is $0 when paid via ACH (CC still uses tenant rate). */
  zeroFeeForACH?: boolean;
  // Product Questionnaire (optional, from product owner)
  productQuestionnaires?: {
    version: number;
    enabled: boolean;
    title: string;
    description: string;
    questions: Array<{
      id: string;
      text: string;
      type: 'yes_no' | 'text' | 'textarea' | 'checkbox' | 'dropdown' | 'number';
      required: boolean;
      options?: string[];
    }>;
    acknowledgement: {
      required: boolean;
      text: string;
    };
    requiresHeightWeight: boolean;
  } | null;
  // Plan Details Data (Mobile App Plan Details)
  planDetailsData?: any | null;
  // Pricing Tiers with min/max MSRP rates
  pricingTiers?: Array<{
    tierType: string;
    minMSRP: number;
    maxMSRP: number;
    count?: number;
  }>;
  // Bundle-specific aggregated pricing (sum of all included products)
  bundleMinMSRP?: number | null;
  bundleMaxMSRP?: number | null;
}

// Base template data structure
export interface EnrollmentLinkTemplate {
  TemplateId: string;
  TemplateName: string;
  TemplateType: 'Individual' | 'Group';
  GroupId?: string;
  GroupName?: string;
  TenantId: string;
  TenantName: string;
  LinkMetaData: LinkMetaDataWorkflow;
  IsActive: boolean;
  Description?: string;
  CreatedDate: string;
  ModifiedDate: string;
  CreatedByName: string;
  ModifiedByName: string;
  ActiveLinksCount: number;
}

// JSON Workflow Structure
export interface LinkMetaDataWorkflow {
  household: HouseholdSection;
  products: ProductSection[];
  additionalDetails?: AdditionalDetailsSection;
  payment?: PaymentSection;
}

export interface HouseholdSection {
  header: string;
  fields: string[];
  prepopulate?: boolean;
}

export interface ProductSection {
  page: string;
  header: string;
  productType: string;
  bundles?: string[];
  includePdfLinks?: boolean;
  includeVideos?: boolean;
  effectiveDateRules?: EffectiveDateRules;
}

export interface AdditionalDetailsSection {
  header: string;
  fields: string[];
}

export interface PaymentSection {
  header: string;
  required: boolean;
  methods: string[];
}

export interface EffectiveDateRules {
  type: 'ProductBased' | 'GroupDefined' | 'Immediate';
  customRules?: any;
}

// API Request/Response Types
export interface CreateTemplateRequest {
  templateName: string;
  templateType: 'Individual' | 'Group';
  groupId?: string;
  tenantId?: string; // Only for SysAdmin
  linkMetaData: string; // JSON string
  description?: string;
}

export interface UpdateTemplateRequest {
  templateName?: string;
  templateType?: 'Individual' | 'Group';
  groupId?: string;
  linkMetaData?: string; // JSON string
  description?: string;
  isActive?: boolean;
}

export interface TemplateListResponse {
  success: boolean;
  data: EnrollmentLinkTemplate[];
  message?: string;
}

export interface TemplateDetailResponse {
  success: boolean;
  data: EnrollmentLinkTemplate;
  message?: string;
}

export interface CreateTemplateResponse {
  success: boolean;
  data: {
    templateId: string;
    templateName: string;
    templateType: string;
    message: string;
  };
  message?: string;
}

export interface ApiErrorResponse {
  success: false;
  message: string;
  error?: {
    message: string;
    code: string;
  };
}

// Form State Types for Frontend Components
export interface TemplateFormData {
  templateName: string;
  templateType: 'Individual' | 'Group';
  groupId: string;
  tenantId: string; // For SysAdmin only
  description: string;
  isActive: boolean;
  workflow: LinkMetaDataWorkflow;
}

// Available form field options
export const HOUSEHOLD_FIELDS = [
  'FirstName',
  'LastName', 
  'Email',
  'Phone',
  'ZipCode',
  'DateOfBirth',
  'HouseholdSize',
  'TobaccoUse',
  'Gender',
  'MaritalStatus'
] as const;

export const PRODUCT_TYPES = [
  'Medical',
  'Dental', 
  'Vision',
  'Life',
  'Disability',
  'Accident',
  'Critical Illness'
] as const;

export const ADDITIONAL_DETAIL_FIELDS = [
  'Address',
  'Dependents',
  'EmploymentInfo',
  'BeneficiaryInfo',
  'MedicalHistory'
] as const;

export const PAYMENT_METHODS = [
  'CC', // Credit Card
  'ACH', // Bank Transfer
  'Check',
  'Money Order'
] as const;

export const BUNDLE_OPTIONS = PRODUCT_TYPES;

// Filter and search types
export interface TemplateFilters {
  tenantName?: string;
  templateType?: 'Individual' | 'Group' | '';
  isActive?: boolean | '';
  searchTerm?: string;
}

// Component Props Types
export interface TemplateListProps {
  userType: 'SysAdmin' | 'TenantAdmin';
  tenantId?: string;
}

export interface TemplateFormProps {
  template?: EnrollmentLinkTemplate;
  onSave: (template: TemplateFormData) => Promise<void>;
  onCancel: () => void;
  isEditing?: boolean;
  userType: 'SysAdmin' | 'TenantAdmin';
  availableGroups?: Array<{ GroupId: string; Name: string }>;
  availableTenants?: Array<{ TenantId: string; Name: string }>;
}

export interface WorkflowBuilderProps {
  workflow: LinkMetaDataWorkflow;
  onChange: (workflow: LinkMetaDataWorkflow) => void;
  templateType: 'Individual' | 'Group';
}

// Default workflow templates
export const DEFAULT_INDIVIDUAL_WORKFLOW: LinkMetaDataWorkflow = {
  household: {
    header: "Tell Us About Your Household",
    fields: ["FirstName", "LastName", "Email", "Phone", "ZipCode", "DateOfBirth", "HouseholdSize", "TobaccoUse"],
    prepopulate: true
  },
  products: [
    {
      page: "Healthcare",
      header: "Choose a Healthcare Bundle",
      productType: "Medical",
      bundles: ["Dental", "Vision"],
      includePdfLinks: true,
      includeVideos: true,
      effectiveDateRules: { type: "ProductBased" }
    }
  ],
  additionalDetails: {
    header: "Your Address and Family",
    fields: ["Address", "Dependents"]
  },
  payment: {
    header: "Secure Your Coverage",
    required: true,
    methods: ["CC", "ACH"]
  }
};

export const DEFAULT_GROUP_WORKFLOW: LinkMetaDataWorkflow = {
  household: {
    header: "Employee Information",
    fields: ["FirstName", "LastName", "Email", "Phone", "DateOfBirth", "HouseholdSize"],
    prepopulate: false
  },
  products: [
    {
      page: "Healthcare",
      header: "Select Your Healthcare Coverage",
      productType: "Medical",
      bundles: ["Dental", "Vision", "Life"],
      includePdfLinks: true,
      includeVideos: false,
      effectiveDateRules: { type: "GroupDefined" }
    },
    {
      page: "Dental",
      header: "Add Dental Coverage",
      productType: "Dental"
    },
    {
      page: "Vision",
      header: "Add Vision Coverage", 
      productType: "Vision"
    }
  ],
  additionalDetails: {
    header: "Additional Information",
    fields: ["Address", "Dependents"]
  }
  // Note: No payment section for Group workflows
};
