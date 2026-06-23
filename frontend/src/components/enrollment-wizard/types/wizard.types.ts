// frontend/src/components/enrollment-wizard/types/wizard.types.ts

export interface WizardHouseholdData {
  collectSSN: boolean;
  collectDOB: boolean;
  collectGender: boolean;
  collectAddress: boolean;
  collectPhone: boolean;
}

export interface WizardProductSection {
  id: string; // Unique ID for React keys
  page: string; // Section title like "Medical Plans"
  productType: string; // Product type like "Medical", "Dental", etc.
  description: string; // Description for users
  specificProducts?: string[]; // Array of specific product IDs to include (when includeAllProducts is false)
  includeAllProducts?: boolean; // If true, include all products of this type. If false, use specificProducts array
  specificBundles?: string[]; // Array of specific bundle IDs to include
  includeAllBundles?: boolean; // If true, include all available bundles
  sectionType?: 'products' | 'bundles'; // Indicates if this section is for products or bundles
}

export interface EnrollmentWizardData {
  // Step 1: Basic Info
  templateName: string;
  templateType: 'Individual' | 'Group';
  description: string;
  tenantId?: string;
  agentId?: string;
  groupId?: string; // Required for Group templates
  /** When true: selected agency has no assigned agent; user cannot proceed in marketing/static link mode */
  agencyHasNoAgent?: boolean;

  // Step 2: Household Data
  household: WizardHouseholdData;
  
  // Step 3: Products
  products: WizardProductSection[];
  
  // NEW: Option to create as static public enrollment link (Agent only)
  createAsStaticLink?: boolean;
  
  // Field interaction tracking (for better UX - only show errors after user interaction)
  touched?: {
    templateName?: boolean;
    templateType?: boolean;
    tenantId?: boolean;
    agentId?: boolean;
    groupId?: boolean;
  };
}

export interface WizardStepProps {
  data: EnrollmentWizardData;
  onDataChange: (updates: Partial<EnrollmentWizardData>) => void;
  onNext: () => void;
  onPrevious: () => void;
  isValid: boolean;
  isFirstStep: boolean;
  isLastStep: boolean;
  editingAgentName?: string; // For pre-populating agent/agency name when editing
  staticLinkMode?: boolean; // For static enrollment links
  marketingLinkMode?: boolean; // For marketing enrollment links
}

export type WizardStep =
  | 'basic-info'
  | 'healthcare'
  | 'dental'
  | 'vision'
  | 'life'
  | 'telemedicine'
  | 'supplemental'
  | 'other-products'
  | 'review';

export interface AvailableProductType {
  productType: string;
  count: number; // How many products of this type are available
}
