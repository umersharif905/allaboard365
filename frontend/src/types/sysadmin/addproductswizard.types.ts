// Updated types.ts - Wizard Type Definitions
export interface ConfigurationField {
  id: string;
  fieldName: string;  
  fieldOptions: string[];
  isDeductible?: boolean; // Only one field can be marked as deductible, and options must be numeric
}

export interface AgeBandOverride {
  OverrideId: string;
  ProductId?: string;
  ProductPricingId?: string | null;
  TenantId?: string;
  OverrideACHId?: string;
  OverrideName?: string | null;
  OverrideAmount: number;
  Priority?: number | null;
  IsActive: boolean;
  EffectiveDate?: string | null;
  ExpirationDate?: string | null;
  TenantName?: string | null;
  ACHAccountHolderName?: string | null;
  ACHBankName?: string | null;
  ACHAccountType?: string | null;
  PricingName?: string | null;
  PricingLabel?: string | null;
  PricingTierType?: string | null;
  PricingTobaccoStatus?: string | null;
  PricingMinAge?: number | null;
  PricingMaxAge?: number | null;
}

export interface AgeBand {
  id: string;
  tobaccoStatus: string;
  minAge: number;
  maxAge: number;
  netRate: number;
  overrideRate: number;
  commission: number;
  systemFees: number;
  msrpRate: number;
  /** Per-tier stored included processing fee (saved to ProductPricing.IncludedProcessingFee). */
  includedProcessingFee?: number;
  affiliateRate: number; // Keep for backward compatibility
  locked?: boolean;
  effectiveDate?: string | null;
  terminationDate?: string | null;
  configValue1?: string;
  configValue2?: string;
  configValue3?: string;
  configValue4?: string;
  configValue5?: string;
  configField1?: string;
  configField2?: string;
  configField3?: string;
  configField4?: string;
  configField5?: string;
  productPricingId?: string | null;
  overrides?: AgeBandOverride[];
}

export interface PricingTier {
  id: string;
  tierType: string;
  label?: string;
  ageBands: AgeBand[];
}

export interface AcknowledgementQuestion {
  id: string;
  question: string;
  fieldType: string;
  required: boolean;
  options?: string[];
  customAction?: string;
}

export interface CardSection {
  Image: string;
  Header: string;
  Text1: string;
  Link_Name1: string;
  URL1: string;
  Link_Name2: string;
  URL2: string;
}

export interface IDCardSection {
  Image?: string;
  Header?: string;
  Text1?: string;
  Text2?: string;
  Link_Name1?: string;
  URL1?: string;
  Link_Name2?: string;
  URL2?: string;
}

export interface IDCardData {
  DisableIDCard?: boolean;
  Card_Front: {
    Header: {
      Image: string;
      ImagePlacement?: 'Center' | 'Left' | 'Right';
      HeaderText?: string;
    };
    Footer: {
      Header: string;
      Text1: string;
      Text2: string;
    };
  };
  Card_Back: {
    Top_Left: IDCardSection;
    Top_Right: IDCardSection;
    Middle: IDCardSection;
    Bottom_Left: IDCardSection;
    Bottom_Right: IDCardSection;
  };
  /** Optional per-vendor-network overrides. Missing fields fall back to default. */
  NetworkVariations?: Record<string, IDCardVariation>;
}

/** Per-network variation. Same shape as the default ID card minus NetworkVariations. */
export interface IDCardVariation {
  DisableIDCard?: boolean;
  Card_Front: {
    Header: {
      Image: string;
      ImagePlacement?: 'Center' | 'Left' | 'Right';
      HeaderText?: string;
    };
    Footer: {
      Header: string;
      Text1: string;
      Text2: string;
    };
  };
  Card_Back: {
    Top_Left: IDCardSection;
    Top_Right: IDCardSection;
    Middle: IDCardSection;
    Bottom_Left: IDCardSection;
    Bottom_Right: IDCardSection;
  };
}

export interface IDCardBackImageFiles {
  Top_Left?: File | null;
  Top_Right?: File | null;
  Middle?: File | null;
  Bottom_Left?: File | null;
  Bottom_Right?: File | null;
}

export interface AIChunk {
  id?: string;
  chunk_text: string;
  created_at?: string;
}

/** Training module: video, image, text, or link */
export interface TrainingModule {
  id: string;
  type: 'video' | 'image' | 'text' | 'link';
  title: string;
  order: number;
  url?: string;
  text?: string;
  label?: string; // for link type
}

/** Training question for scoring */
export interface TrainingQuestion {
  id: string;
  question: string;
  fieldType: 'multiple_choice' | 'true_false';
  options?: { key: string; label: string }[];
  correctResponseKey: string;
}

/** Per-audience training config (agent or member) */
export interface AudienceTrainingConfig {
  modules: TrainingModule[];
  questions: TrainingQuestion[];
  requiredForSell?: boolean;  // agents only
  passingScorePercent?: number;
}

/** Top-level training config stored in oe.Products.TrainingConfig */
export interface TrainingConfig {
  agentTraining?: AudienceTrainingConfig;
  memberTraining?: AudienceTrainingConfig;
}

export type MedicalNeedsLinkType = 'tenantForm' | 'custom';

/** One outbound link on the member Medical Needs Requests page */
export interface MedicalNeedsLinkItem {
  id: string;
  label: string;
  linkType: MedicalNeedsLinkType;
  formTemplateId?: string;
  customUrl?: string;
  /** Preset key (teal, purple, oePrimary, …) or #RRGGBB */
  buttonColor: string;
}

/** Stored in oe.Products.MedicalNeedsLinksConfig */
export interface MedicalNeedsLinksConfig {
  categoryTitle: string;
  links: MedicalNeedsLinkItem[];
  /** 1 = highest (listed first on member portal), max 25 */
  displayPriority: number;
}

/** A single question in a product questionnaire */
export interface ProductQuestionnaireQuestion {
  id: string;
  text: string;
  type: 'yes_no' | 'text' | 'textarea' | 'checkbox' | 'dropdown' | 'number';
  required: boolean;
  options?: string[]; // For dropdown type
  triggersConditionalAcknowledgement?: boolean; // When answered "yes", shows the conditional acknowledgement
}

/** Product questionnaire JSON schema stored in oe.Products.ProductQuestionnaires */
export interface ProductQuestionnaire {
  version: number;
  enabled: boolean;
  title: string;
  description: string;
  questions: ProductQuestionnaireQuestion[];
  acknowledgement: {
    required: boolean;
    text: string;
  };
  conditionalAcknowledgement?: {
    required: boolean;
    text: string;
  };
  requiresHeightWeight: boolean;
}

export interface ProductFormData {
  // Step 1: Vendor Selection
  vendorId: string;
  isVendorPricing: boolean;
  vendorCommission: number;
  /** Vendor group ID product type for vendor export (e.g. ARM): Master (0), CoPay (1), HSA (2). None = skip / infer from name. */
  vendorGroupIdProductType?: string;
  /** Default vendor group ID for individual (no-group) enrollments in eligibility export */
  eligibilityIndividualVendorGroupId?: string;
  /** Use another same-vendor product's resolved vendor group ID chain before this product's Master (eligibility export) */
  eligibilityVendorGroupFallbackProductId?: string;
  /** Optional vendor-assigned plan identifier (e.g. SBC plan ID, contract number) */
  planId?: string;

  // Step 2: Basic Details
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
  maxEffectiveDateDays: number;
  terminationLogic: string;
  requiredLicenses: string[];
  partNumber?: string;
  isPublic: boolean;
  isHidden: boolean; // Hide product from agents (typically for bundle components)
  isSSNRequired: boolean; // Require SSN for enrollment in this product
  /** Billing/reporting: how base premium is classified for group invoice breakdown (oe.Products.PremiumReportingCategory) */
  premiumReportingCategory: 'NonProfit' | 'ForProfit';
 
  // Step 3: Configuration Fields
  configurationFields: ConfigurationField[];
 
  // Step 4: Pricing
  pricingTiers: PricingTier[];
  /** Product-level: bake Highest-policy processing fee into per-tier IncludedProcessingFee. */
  includeProcessingFee?: boolean;
  /** When true, per-tier includedProcessingFee $ amounts are hand-entered (not auto-calculated). */
  manualIncludedProcessingFee?: boolean;
  roundUpProcessingFee?: boolean;
  /** Wizard display / recalc hint only (owner tenant ACH/CC %). */
  processingFeePercentage?: number | null;
 
  // Step 5: Acknowledgement Questions
  acknowledgementQuestions: AcknowledgementQuestion[];

  // Step 5: Product Questionnaire (optional, stored as JSON)
  productQuestionnaires?: ProductQuestionnaire;
 
  // Step 6: Media & Documents
  productImageFile: File | null;
  productLogoFile: File | null;
  productDocumentFile: File | null;
  /** Pending new document files (unlimited) - uploaded on save */
  productDocumentFiles?: { file: File; displayName: string }[];
  /** Multiple documents per product (from API or built on save) */
  productDocuments?: { productDocumentId?: string; documentUrl: string; displayName?: string; sortOrder?: number }[];
  planDetailsHeaderLogoFile?: File | null;
  // AI-generated file URLs and names (for AI product creation)
  productImageUrl?: string;
  productImageName?: string;
  productLogoUrl?: string;
  productLogoName?: string;
  productDocumentUrl?: string;
  productDocumentName?: string;
  // Deletion flags for existing media
  deleteProductImage?: boolean;
  deleteProductLogo?: boolean;
  deleteProductDocument?: boolean;
 
  // Step 7: ID Card
  /** When true, show vendor group ID on member ID cards (oe.Products.ShowGroupIdOnIDCard) */
  showGroupIdOnIDCard?: boolean;
  idCardLogoFile?: File | null;
  idCardBackImageFiles?: IDCardBackImageFiles;
  /** Per-network pending logo file uploads (keyed by VendorNetworkId) */
  idCardLogoFileByNetwork?: Record<string, File | null>;
  /** Per-network pending back-section image uploads (keyed by VendorNetworkId) */
  idCardBackImageFilesByNetwork?: Record<string, IDCardBackImageFiles>;
  /** Optional: replace tenant group prefix on this product's ID card and eligibility Alternate ID */
  idCardMemberIdPrefixMask?: string;
  idCardData: {
    DisableIDCard?: boolean;
    Card_Front: {
      Header: {
        Image: string;
        ImagePlacement?: 'Center' | 'Left' | 'Right';
        HeaderText?: string;
      };
      Footer: {
        Header: string;
        Text1: string;
        Text2: string;
      };
    };
    Card_Back: {
      Top_Left: CardSection;
      Top_Right: CardSection;
      Middle: CardSection;
      Bottom_Left: CardSection;
      Bottom_Right: CardSection;
    };
    /** Optional per-vendor-network overrides keyed by VendorNetworkId.
     *  Variations start as a clone of default and only carry their own changes. */
    NetworkVariations?: Record<string, IDCardVariation>;
  };
 
  // Step 8: Plan Details
  planDetailsData: any;
 
  // Step 9: AI Chunks
  aiChunks: AIChunk[];

  // Step 10: Required ASA
  requiredASA?: {
    documentId: string;
    documentName: string;
    documentUrl: string;
  };

  // Step 11: Training (agent / member)
  trainingConfig?: TrainingConfig;

  /** Step 11 UI: Medical needs request links (member portal); persisted as MedicalNeedsLinksConfig */
  medicalNeedsLinksConfig?: MedicalNeedsLinksConfig;
}

export interface AddProductWizardProps {
  isOpen?: boolean;
  onClose?: () => void;
  onComplete?: () => void;
  onCancel?: () => void;
  onSave?: (productData: ProductFormData) => void;
  editingProduct?: any;
  vendorId?: string;
  prefilledVendorId?: string;
  isTenantAdmin?: boolean;
  /** When resyncing a linked product, overlay fresh E123 draft fields after loading the existing product. */
  e123ResyncDraft?: ProductFormData;
  /** Pre-built wizard form for E123 create flow (not an existing DB product). */
  prefilledDraft?: ProductFormData;
}

export interface StepProps {
  formData: ProductFormData;
  updateFormData: (updates: Partial<ProductFormData>) => void;
  isTenantAdmin?: boolean;
  isVendorAdmin?: boolean;
  isSysAdmin?: boolean;
  /** When editing, exclude this product id from fallback-product dropdown */
  editingProductId?: string;
}

export interface MediaStepProps extends StepProps {
  existingMediaUrls: {
    productImageUrl: string;
    productLogoUrl: string;
    productDocumentUrl: string;
  };
  documentMetadata?: {
    originalName?: string;
    uploadedBy?: string;
    contentType?: string;
    contentLength?: number;
    lastModified?: string;
  };
  onOpenLogoGenerate?: () => void;
}

export interface ReviewStepProps {
  formData: ProductFormData;
  editingProduct?: any;
  isTenantAdmin?: boolean;
}

export interface Vendor {
  Id: string;
  VendorName: string;
  ContactName?: string;
  Email?: string;
  Phone?: string;
  City?: string;
  State?: string;
}

export interface Tenant {
  TenantId: string;
  Name: string;
  ContactEmail: string;
  Status: string;
  LogoUrl?: string;
}

// Bundle-specific types
/** Per-field allowed config values when product is offered in this bundle. e.g. { "Unshared amount": ["1500", "3000", "6000"] }. All selected by default if not set. */
export type AllowedConfigOptions = Record<string, string[]>;

export interface BundleProduct {
  id: string;
  productId: string;
  productName: string;
  isRequired: boolean;
  sortOrder: number;
  productType?: string;
  description?: string;
  productImageUrl?: string;
  productLogoUrl?: string;
  hidePricing?: boolean; // Hide product pricing on enrollment links and invoices
  linkedToProductId?: string | null; // Link hidden product to a main product
  /** Limit which configuration values are available when this product is in the bundle. All options selected by default. */
  allowedConfigOptions?: AllowedConfigOptions | null;
  /** Product's config fields (from RequiredDataFields); used to build allowedConfigOptions UI. */
  requiredDataFields?: Array<{ fieldName: string; fieldOptions: string[] }> | null;
}

export interface BundleFormData {
  // Step 1: Basic Details
  name: string;
  description: string;
  productOwnerId: string;
  salesType: string;
  isPublic: boolean;
  isHidden: boolean; // Hide bundle from agents, enrollment links, and groups

  // Step 2: Bundle Products
  bundleProducts: BundleProduct[];

  // Media (optional)
  productLogoFile: File | null;
  productLogoUrl?: string | null;

  // Step 3: Documents (optional) — bundle-level docs become AI chunks
  // that Columbus treats as authoritative over individual product chunks
  productDocumentFiles?: { file: File; displayName: string }[];
  productDocuments?: { productDocumentId?: string; documentUrl: string; displayName?: string; sortOrder?: number; extractionStatus?: string | null }[];
}

export interface AddBundleWizardProps {
  isOpen?: boolean;
  onClose?: () => void;
  onComplete?: () => void;
  onCancel?: () => void;
  onSave?: (bundleData: any) => void; // Changed to any to accept extended bundle data with all product fields
  editingBundle?: any;
  /** When set, the bundle product picker uses this list instead of `/api/marketplace/products` (e.g. tenant-owned + subscribed). */
  bundleProductCatalog?: any[];
  /** True while `bundleProductCatalog` is being loaded for the tenant-scoped picker. */
  bundleProductCatalogLoading?: boolean;
}

export interface BundleStepProps {
  formData: BundleFormData;
  updateFormData: (updates: Partial<BundleFormData>) => void;
}

export interface BundleProductsStepProps extends BundleStepProps {
  availableProducts: any[];
  onAddProduct: (product: any) => void;
  onRemoveProduct: (productId: string) => void;
  onUpdateProduct: (productId: string, updates: Partial<BundleProduct>) => void;
}

/** Step 1 "Use vendor group ID for this product" — required before ID-card vendor group ID display. */
export function productUsesVendorGroupId(vendorGroupIdProductType?: string | null): boolean {
  if (vendorGroupIdProductType == null) return false;
  const t = String(vendorGroupIdProductType).trim();
  return t !== '' && t.toLowerCase() !== 'none';
}