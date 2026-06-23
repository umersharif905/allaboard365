import { AlertCircle, CheckCircle, ChevronLeft, ChevronRight, Sparkles, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../../contexts/AuthContext';
import { apiService } from '../../services/api.service';
import ProductWizardAIAssistant from '../ai/ProductWizardAIAssistant';
import ProductLogoGenerateModal from '../ai/ProductLogoGenerateModal';
import PlanDetailsGenerateModal from '../ai/PlanDetailsGenerateModal';
import { applyProductAiPatch, buildProductAiApplySummary, normalizeProductAiPatch } from '../../utils/productAiMerge';
import {
  clearProductAiChatSession,
  createDraftSessionId,
  productAiChatStorageKey,
} from '../../utils/productWizardAiSession';
import { mergeE123DraftIntoExistingProduct } from '../../utils/e123ProductResyncMerge';
import {
  getProductWizardSubmitBlockers,
  isProductWizardSubmitDisabled,
} from '../../utils/productWizardSubmitBlockers';
import {
  calculatePricingComponentBase,
  resolveWizardRetailMsrpRate,
} from '../../utils/wizardPricingMsrp';
import { normalizeWizardPricingTiers } from '../../utils/normalizeWizardPricingTiers';

// Import all step components
import Step10Review from './steps/Step10Review';
import Step11RequiredASA from './steps/Step11RequiredASA';
import Step1VendorSelection from './steps/Step1VendorSelection';
import Step2BasicDetails from './steps/Step2BasicDetails';
import Step2Licensing from './steps/Step2Licensing';
import Step3ConfigurationFields from './steps/Step3ConfigurationsFields';
import Step4Pricing from './steps/Step4Pricing';
import Step5AcknowledgementQuestions from './steps/Step5AcknowledgementQuestions';
import Step6MediaDocuments from './steps/Step6MediaDocuments';
import Step7IDCard from './steps/Step7IDCard';
import Step8PlanDetails from './steps/Step8PlanDetails';
import Step9AIChunks from './steps/Step9AIChunks';
import StepMedicalNeedsLinks from './steps/StepMedicalNeedsLinks';
import { clampMedicalNeedsDisplayPriority } from '../../utils/medicalNeedsDisplayPriority';

// Types - Import and re-export for convenience
import { AddProductWizardProps, ProductFormData, productUsesVendorGroupId } from '../../types/sysadmin/addproductswizard.types';
export type { ProductFormData } from '../../types/sysadmin/addproductswizard.types';

// Constants
export const PRICING_TIERS = [
  { value: 'EE', label: 'Employee Only (EE)' },
  { value: 'ES', label: 'Employee + Spouse (ES)' },
  { value: 'EC', label: 'Employee + Child(ren) (EC)' },
  { value: 'EF', label: 'Employee + Family (EF)' },
  { value: 'N/A', label: 'Not Applicable (N/A)' }
];

export const TOBACCO_OPTIONS = [
  { value: 'N/A', label: 'N/A' },
  { value: 'Yes', label: 'Yes' },
  { value: 'No', label: 'No' }
];

export const PRODUCT_TYPES = [
  'Healthcare',
  'Dental',
  'Vision',
  'Telemedicine',
  'Life Insurance',
  'Disability',
  'Accident',
  'Critical Illness',
  'Hospital Indemnity',
  'Other'
];

export const REQUIRED_LICENSES = [
  'Life Insurance',
  'Health',
  'Casualty',
  'Medicare Advantage',
  'Accident',
  'Property',
  'Medicare Supplement',
  // 'Personal Lines',
  // 'Variable Contracts',
  // 'Limited Lines',
  // 'Surplus Lines',
  // 'Navigator / Exchange License',
  'None'
];

export const LICENSE_DESCRIPTIONS = {
  'Life Insurance': {
    description: 'Permits sale of life insurance, annuities, and related products.',
    products: 'Life, Term Life, Whole Life, Final Expense'
  },
  'Health': {
    description: 'Required for health-related coverage including MEC, Health Share, and Supplemental Plans.',
    products: 'Health Share, MEC, Critical Illness, Supplemental Plans'
  },
  'Casualty': {
    description: 'For liability and commercial risks.',
    products: 'Auto, Workers Comp, General Liability'
  },
  'Medicare Advantage': {
    description: 'Carrier-specific certification for Medicare Advantage plans, renewed annually.',
    products: 'Medicare Advantage Plans'
  },
  'Accident': {
    description: 'Required for accident insurance coverage and related products.',
    products: 'Accident Insurance, Critical Illness'
  },
  'Property': {
    description: 'Covers personal/commercial property insurance lines.',
    products: 'Property, Homeowners, Renters'
  },
  'Medicare Supplement': {
    description: 'Carrier-specific certification for Medicare Supplement plans, renewed annually.',
    products: 'Medicare Supplement, Part D'
  },
  // 'Personal Lines': {
  //   description: 'Simplified license for property/casualty in some states.',
  //   products: 'Auto, Renters'
  // },
  // 'Variable Contracts': {
  //   description: 'For variable annuities or products tied to market performance.',
  //   products: 'Variable Life, Indexed Annuities'
  // },
  // 'Limited Lines': {
  //   description: 'For niche products like travel or discount programs.',
  //   products: 'Travel, Credit, Dental/Vision Discount'
  // },
  // 'Surplus Lines': {
  //   description: 'For non-standard risks placed through excess markets.',
  //   products: 'Non-admitted or specialty markets'
  // },
  // 'Navigator / Exchange License': {
  //   description: 'Required for ACA marketplace enrollments.',
  //   products: 'ACA Health, Marketplace Plans'
  // },
  'None': {
    description: 'No specific insurance license required for this product.',
    products: 'General products not requiring insurance licensing'
  }
};

export const FIELD_TYPES = [
  { value: 'text', label: 'Single Line Text' },
  { value: 'textarea', label: 'Multi-line Text' },
  { value: 'dropdown', label: 'Dropdown' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'yesno', label: 'Yes/No' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' }
];

export const MAX_CONFIGURATION_FIELDS = 5;

const initialFormData: ProductFormData = {
  // Step 1: Vendor Selection
  vendorId: '',
  isVendorPricing: false,
  vendorCommission: 0,
  vendorGroupIdProductType: '',
  eligibilityIndividualVendorGroupId: '',
  eligibilityVendorGroupFallbackProductId: '',
  planId: '',
  showGroupIdOnIDCard: false,
  partNumber: '',
  
  // Step 2: Basic Details (no longer bundle selection)
  name: '',
  description: '',
  productType: '',
  productOwnerId: '',
  salesType: 'Both',
  minAge: 18,
  maxAge: 65,
  allowedStates: [],
  requiresTobaccoInfo: false,
  effectiveDateLogic: 'FirstOfMonth',
  maxEffectiveDateDays: 60,
  terminationLogic: '',
      requiredLicenses: [],
      isPublic: false,
      isHidden: false,
      isSSNRequired: false,
      premiumReportingCategory: 'ForProfit',
  
  // Step 3: Configuration Fields
  configurationFields: [],
  
  // Step 4: Pricing
  pricingTiers: [],
  includeProcessingFee: false,
  manualIncludedProcessingFee: false,
  roundUpProcessingFee: true,
  processingFeePercentage: null,
  
  // Step 5: Acknowledgement Questions
  acknowledgementQuestions: [],

  // Step 5: Product Questionnaire
  productQuestionnaires: undefined,
  
  // Step 6: Media & Documents
  productImageFile: null,
  productLogoFile: null,
  productDocumentFile: null,
  productDocumentFiles: [],

  // Step 7: ID Card
  idCardLogoFile: null,  // ADD THIS LINE - File for ID card logo
  idCardMemberIdPrefixMask: '',
  idCardData: {
    DisableIDCard: false,
    Card_Front: {
      Header: { Image: '' },
      Footer: { Header: '', Text1: '', Text2: '' }
    },
    Card_Back: {
      Top_Left: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
      Top_Right: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
      Middle: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
      Bottom_Left: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' },
      Bottom_Right: { Image: '', Header: '', Text1: '', Link_Name1: '', URL1: '', Link_Name2: '', URL2: '' }
    }
  },
  
  // Step 8: Plan Details
  planDetailsData: {},
  
  // Step 9: AI Chunks
  aiChunks: [],

  // Step 10: Required ASA
  requiredASA: undefined,

  // Step 11: Training (still persisted when present; step UI is Medical Needs links)
  trainingConfig: undefined,
  medicalNeedsLinksConfig: undefined
};

/**
 * Deep-merge ID card JSON from the API into wizard defaults. A shallow spread breaks when the API
 * returns partial Card_Front / Card_Back (a common “only set what changed” shape): entire sections
 * get replaced and back-of-card image URLs in untouched sections are lost in the editor.
 */
function mergeIdCardDataFromApi(
  base: ProductFormData['idCardData'],
  parsed: Record<string, unknown> | null | undefined
): ProductFormData['idCardData'] {
  if (!parsed || typeof parsed !== 'object') {
    return { ...base, DisableIDCard: base.DisableIDCard === true };
  }
  const p = parsed as {
    DisableIDCard?: boolean;
    Card_Front?: { Header?: { Image?: string } & Record<string, unknown>; Footer?: Record<string, string> };
    Card_Back?: Partial<Record<'Top_Left' | 'Top_Right' | 'Middle' | 'Bottom_Left' | 'Bottom_Right', Record<string, unknown>>>;
    NetworkVariations?: Record<string, Record<string, unknown>>;
  };
  const cf = p.Card_Front;
  const cb = p.Card_Back;
  const mergedDefault = {
    DisableIDCard: p.DisableIDCard === true,
    Card_Front: {
      Header: {
        ...base.Card_Front.Header,
        ...(cf?.Header && typeof cf.Header === 'object' ? cf.Header : {}),
      },
      Footer: {
        ...base.Card_Front.Footer,
        ...(cf?.Footer && typeof cf.Footer === 'object' ? cf.Footer : {}),
      },
    },
    Card_Back: {
      Top_Left: { ...base.Card_Back.Top_Left, ...(cb?.Top_Left && typeof cb.Top_Left === 'object' ? cb.Top_Left : {}) },
      Top_Right: { ...base.Card_Back.Top_Right, ...(cb?.Top_Right && typeof cb.Top_Right === 'object' ? cb.Top_Right : {}) },
      Middle: { ...base.Card_Back.Middle, ...(cb?.Middle && typeof cb.Middle === 'object' ? cb.Middle : {}) },
      Bottom_Left: { ...base.Card_Back.Bottom_Left, ...(cb?.Bottom_Left && typeof cb.Bottom_Left === 'object' ? cb.Bottom_Left : {}) },
      Bottom_Right: { ...base.Card_Back.Bottom_Right, ...(cb?.Bottom_Right && typeof cb.Bottom_Right === 'object' ? cb.Bottom_Right : {}) },
    },
  };

  // Recursively merge NetworkVariations using the (now-merged) default as the base for each variation
  if (p.NetworkVariations && typeof p.NetworkVariations === 'object') {
    const variations: Record<string, ProductFormData['idCardData']> = {};
    for (const [networkId, variation] of Object.entries(p.NetworkVariations)) {
      if (variation && typeof variation === 'object') {
        const mergedVariation = mergeIdCardDataFromApi(mergedDefault as ProductFormData['idCardData'], variation as Record<string, unknown>);
        // Strip nested NetworkVariations so we only carry one level
        const { NetworkVariations: _omit, ...rest } = mergedVariation as any;
        variations[networkId] = rest as ProductFormData['idCardData'];
      }
    }
    return { ...mergedDefault, NetworkVariations: variations } as ProductFormData['idCardData'];
  }

  return mergedDefault as ProductFormData['idCardData'];
}

export default function AddProductWizard({ 
  isOpen = true, 
  onClose, 
  onComplete,
  onCancel,
  onSave, 
  editingProduct,
  vendorId,
  prefilledVendorId,
  isTenantAdmin = false,
  e123ResyncDraft,
  prefilledDraft
}: AddProductWizardProps) {
  console.log('🎯 AddProductWizard rendered with:', { isOpen, editingProduct: !!editingProduct, hasVendorId: !!vendorId });
  const { user } = useAuth();
  const providedVendorId = vendorId || prefilledVendorId;
  const isSysAdmin = user?.roles?.includes('SysAdmin') || user?.currentRole === 'SysAdmin';
  // Vendor portal users only — SysAdmin may open this wizard with a prefilled vendor but still picks tenant owner.
  const isVendorAdmin = !isTenantAdmin && !isSysAdmin && (
    user?.roles?.includes('VendorAdmin') || user?.currentRole === 'VendorAdmin'
  );
  
  const [currentStep, setCurrentStep] = useState(1); // Always start with Step 1 (Vendor Selection)
  const [loading, setLoading] = useState(false);
  const [dataReady, setDataReady] = useState(false); // Track when data is ready
  const [isAIGenerated, setIsAIGenerated] = useState(false); // Track if this is AI-generated product
  const [pricingValidationErrors, setPricingValidationErrors] = useState(false); // Track pricing validation errors
  /** After AI edits pricing off step 5, require opening Pricing once before submit. */
  const [pricingReviewRequired, setPricingReviewRequired] = useState(false);
  const [pricingTiersRevision, setPricingTiersRevision] = useState(0);
  const [aiApplyBanner, setAiApplyBanner] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null); // Track submission errors
  const [isMounted, setIsMounted] = useState(false);
  const [formData, setFormData] = useState<ProductFormData>({
    ...initialFormData,
    vendorId: providedVendorId || ''
  });
  const [aiChatOpen, setAiChatOpen] = useState(false);
  const [logoGenerateOpen, setLogoGenerateOpen] = useState(false);
  const [planDetailsGenerateOpen, setPlanDetailsGenerateOpen] = useState(false);
  const [draftSessionId] = useState(() => createDraftSessionId());
  const wizardInitKeyRef = useRef<string | null>(null);

  const editingProductId =
    editingProduct?.ProductId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(editingProduct.ProductId)
      ? editingProduct.ProductId
      : null;

  const productAiStorageKey = useMemo(
    () =>
      productAiChatStorageKey({
        editingProductId,
        draftSessionId,
      }),
    [editingProductId, draftSessionId]
  );

  const [existingMediaUrls, setExistingMediaUrls] = useState({
    productImageUrl: '',
    productLogoUrl: '',
    productDocumentUrl: ''
  });
  const [documentMetadata, setDocumentMetadata] = useState<{
    originalName?: string;
    uploadedBy?: string;
    contentType?: string;
    contentLength?: number;
    lastModified?: string;
  } | undefined>(undefined);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (currentStep === 5) {
      setPricingReviewRequired(false);
    }
  }, [currentStep]);

  const clearProductAiSession = useCallback(() => {
    clearProductAiChatSession(productAiStorageKey);
  }, [productAiStorageKey]);

  // Handler for closing the modal
  const handleClose = () => {
    clearProductAiSession();
    setAiChatOpen(false);
    if (onClose) {
      onClose();
    } else if (onCancel) {
      onCancel();
    }
  };

  const handleApplyAiPatch = useCallback((patch: Partial<ProductFormData>) => {
    const normalized = normalizeProductAiPatch(patch);
    setFormData((prev) => {
      const next = applyProductAiPatch(prev, normalized);
      const messages = buildProductAiApplySummary(prev, next, normalized);
      setAiApplyBanner(
        messages.length > 0
          ? messages.join(' · ')
          : 'Applied to wizard — no visible field changes. Save product changes to implement the changes.'
      );
      return next;
    });
    if (
      normalized.pricingTiers !== undefined ||
      normalized.includeProcessingFee !== undefined ||
      normalized.roundUpProcessingFee !== undefined ||
      normalized.processingFeePercentage !== undefined
    ) {
      setPricingTiersRevision((n) => n + 1);
      setPricingReviewRequired(true);
      setPricingValidationErrors(false);
    }
  }, []);

  // Handler for completing the wizard
  const handleComplete = () => {
    if (onComplete) {
      onComplete();
    } else if (onClose) {
      onClose();
    }
  };

  // Fetch complete product details for editing
  const fetchCompleteProductDetails = async (productId: string) => {
    try {
      console.log('🔍 Fetching product details for ID:', productId);

      const endpoint = isTenantAdmin
        ? `/api/me/tenant-admin/my-products/${productId}`
        : `/api/products/${productId}`;

      const data = await apiService.get<{
        product?: any;
        data?: any;
        [key: string]: any;
      }>(endpoint);
      
      console.log('✅ Product fetched successfully:', data);
      
      // Extract the product from the response
      const product = data.product || data.data || data;
      
      // ENHANCED AI CHUNKS DEBUGGING
      console.log('🤖 AI Chunks Debug:', {
        hasAIChunks: !!product.AIChunks,
        aiChunksType: typeof product.AIChunks,
        aiChunksIsArray: Array.isArray(product.AIChunks),
        aiChunksCount: product.AIChunks?.length || 0,
        aiChunksData: product.AIChunks,
        firstChunk: product.AIChunks?.[0],
        allProductKeys: Object.keys(product)
      });
      
      // Also check for ID Card and Plan Details
      console.log('📋 ID Card Data:', {
        hasIDCardData: !!product.IDCardData,
        idCardDataType: typeof product.IDCardData,
        idCardData: product.IDCardData
      });
      
      console.log('📄 Plan Details Data:', {
        hasPlanDetailsData: !!product.PlanDetailsData,
        planDetailsDataType: typeof product.PlanDetailsData,
        planDetailsData: product.PlanDetailsData
      });
      
      return product;
    } catch (error) {
      console.error('❌ Error fetching product details:', error);
      return null;
    }
  };

  // Map API response to form data structure
  const mapProductToFormData = (product: any): ProductFormData => {
    console.log('📦 Mapping product data:', product);

    const wizardPricingTiers = normalizeWizardPricingTiers(
      product.PricingTiers ?? product.pricingTiers
    );
    
    // Add specific logging for configuration and pricing data
    console.log('🔍 Configuration data check:', {
      RequiredDataFields: product.RequiredDataFields,
      ConfigurationFields: product.ConfigurationFields,
      hasRequiredDataFields: !!product.RequiredDataFields,
      hasConfigurationFields: !!product.ConfigurationFields,
      typeOfRequiredDataFields: typeof product.RequiredDataFields,
      typeOfConfigurationFields: typeof product.ConfigurationFields
    });
    
    console.log('💰 Pricing data check:', {
      PricingTiers: product.PricingTiers,
      hasPricingTiers: !!product.PricingTiers,
      pricingTiersCount: product.PricingTiers?.length || 0,
      firstTier: product.PricingTiers?.[0]
    });
    
    // Parse JSON fields safely
    const allowedStatesRaw = product.AllowedStates ?
      (Array.isArray(product.AllowedStates) ? product.AllowedStates : JSON.parse(product.AllowedStates)) :
      [];
    const allowedStates = (allowedStatesRaw || []).map((state: any) => String(state).trim());
    
    const requiredLicenses = product.RequiredLicenses ? 
      (Array.isArray(product.RequiredLicenses) ? product.RequiredLicenses : JSON.parse(product.RequiredLicenses)) : 
      [];
    
    // Fix: Check both possible field names for configuration fields
    const rawConfigFields = product.ConfigurationFields || product.RequiredDataFields;
    let configFields = rawConfigFields ? 
      (Array.isArray(rawConfigFields) ? rawConfigFields : 
       typeof rawConfigFields === 'string' ? JSON.parse(rawConfigFields) : 
       rawConfigFields) : 
      [];
    
    console.log('📋 Parsed configuration fields:', configFields);
    
    // If no configuration fields in RequiredDataFields, extract from pricing tiers (ConfigValue1-5)
    // BUT: Only extract if there are actually config values in pricing tiers
    // If user deleted configuration fields, ConfigValue1-5 should have been cleared, so nothing to extract
    if (configFields.length === 0 && wizardPricingTiers.length > 0) {
      console.log('🔍 No configuration fields found in RequiredDataFields, checking pricing tiers for config values...');
      
      // Collect all unique config values from all pricing tiers
      const configValuesMap = new Map<string, Set<string>>(); // Map of field index -> set of unique values
      const configFieldNames = new Map<string, string>(); // Map of field index -> field name (from ConfigField1-5 if available)
      
      wizardPricingTiers.forEach((tier: any) => {
        if (tier.ageBands && Array.isArray(tier.ageBands)) {
          tier.ageBands.forEach((band: any) => {
            // Check ConfigValue1-5 and ConfigField1-5
            for (let i = 1; i <= 5; i++) {
              const configValue = band[`ConfigValue${i}`] || band[`configValue${i}`];
              const configField = band[`ConfigField${i}`] || band[`configField${i}`];
              
              if (configValue && configValue !== null && configValue !== '' && String(configValue).trim() !== '') {
                const fieldKey = `field${i}`;
                if (!configValuesMap.has(fieldKey)) {
                  configValuesMap.set(fieldKey, new Set<string>());
                }
                configValuesMap.get(fieldKey)!.add(String(configValue).trim());
                
                // Store field name if available
                if (configField && configField !== null && configField !== '' && !configFieldNames.has(fieldKey)) {
                  configFieldNames.set(fieldKey, String(configField).trim());
                }
              }
            }
          });
        }
      });
      
      // Only create configuration fields if we found actual config values
      // If user deleted configuration fields, ConfigValue1-5 should be empty, so nothing to extract
      if (configValuesMap.size > 0) {
        console.log('✅ Found config values in pricing tiers, extracting configuration field...');
        
        // Get the first field with values (usually ConfigValue1)
        const firstFieldKey = Array.from(configValuesMap.keys())[0];
        const uniqueValues = Array.from(configValuesMap.get(firstFieldKey)!);
        
        if (uniqueValues.length > 0) {
          // Sort values for consistency
          uniqueValues.sort();
          
          // Get field name from ConfigField if available, otherwise use default
          const fieldName = configFieldNames.get(firstFieldKey) || 'Configuration';
          
          // Create a configuration field with these options
          configFields = [{
            fieldName: fieldName, // Use ConfigField name if available, otherwise "Configuration"
            fieldOptions: uniqueValues,
            isDeductible: false
          }];
          
          console.log('✅ Extracted configuration field from pricing tiers:', {
            fieldName: fieldName,
            options: uniqueValues,
            optionsCount: uniqueValues.length
          });
        }
      } else {
        console.log('ℹ️ No config values found in pricing tiers - configuration fields were likely deleted');
      }
    }
    
    const ackQuestions = product.AcknowledgementQuestions ? 
      (Array.isArray(product.AcknowledgementQuestions) ? product.AcknowledgementQuestions : JSON.parse(product.AcknowledgementQuestions)) : 
      [];
    
    // Parse ID Card Data (deep-merge so partial API Card_Back / Card_Front does not wipe other sections)
    const parsedIdCardData = product.IDCardData
      ? (typeof product.IDCardData === 'string' ? JSON.parse(product.IDCardData) : product.IDCardData)
      : {};
    const idCardData = mergeIdCardDataFromApi(initialFormData.idCardData, parsedIdCardData);

    console.log('🎴 Parsed ID Card Data:', idCardData);
    
    // Parse Plan Details Data
    const planDetailsData = product.PlanDetailsData ? 
      (typeof product.PlanDetailsData === 'string' ? JSON.parse(product.PlanDetailsData) : product.PlanDetailsData) : 
      {};
    
    console.log('📑 Parsed Plan Details Data:', planDetailsData);
    
    // ENHANCED AI CHUNKS PARSING WITH DEBUGGING
    let aiChunks = [];
    if (product.AIChunks) {
      console.log('🤖 Processing AI Chunks:', {
        original: product.AIChunks,
        isArray: Array.isArray(product.AIChunks),
        length: product.AIChunks.length
      });
      
      if (Array.isArray(product.AIChunks)) {
        aiChunks = product.AIChunks.map((chunk: any, index: number) => {
          console.log(`  Chunk ${index}:`, chunk);
          return {
            id: chunk.id || chunk.AIChunkId || Date.now().toString() + Math.random(),
            chunk_text: chunk.chunk_text || chunk.ChunkData || '',
            created_at: chunk.created_at || chunk.CreatedDate || new Date().toISOString()
          };
        });
      }
    }
    
    console.log('🤖 Final AI Chunks mapping:', {
      aiChunksCount: aiChunks.length,
      aiChunksData: aiChunks,
      firstMappedChunk: aiChunks[0]
    });

    // Map pricing tiers (grouped API shape or flat list fallback)
    const pricingTiers: any[] = [];
    const includeProcessingFeeFromProduct =
      product.includeProcessingFee === true ||
      product.IncludeProcessingFee === true ||
      product.IncludeProcessingFee === 1;
    if (wizardPricingTiers.length > 0) {
      console.log('🏷️ Processing pricing tiers, count:', wizardPricingTiers.length);
      wizardPricingTiers.forEach((tier: any, index: number) => {
        console.log(`  Tier ${index}:`, tier);
        const ageBandRows = Array.isArray(tier.ageBands) ? tier.ageBands : [];
        const mappedTier = {
          id: tier.id || Date.now().toString() + Math.random(),
          tierType: tier.tierType || '',
          label: tier.label || tier.Label || '',
          ageBands: ageBandRows.map((band: any) => {
            const lockedValue = typeof band.locked === 'boolean'
              ? band.locked
              : (typeof band.Locked === 'boolean' ? band.Locked : false);
            const effectiveSource = band.effectiveDate || band.EffectiveDate || null;
            const terminationSource = band.terminationDate || band.TerminationDate || null;
            const netRate = band.netRate || band.NetRate || 0;
            const overrideRate = band.overrideRate || band.OverrideRate || 0;
            const commission = band.commission || band.VendorCommission || 0;
            const componentBase = calculatePricingComponentBase(netRate, overrideRate, commission);
            const includedProcessingFee =
              Number(band.includedProcessingFee ?? band.IncludedProcessingFee ?? 0) || 0;
            return {
              id: band.id || band.ProductPricingId || Date.now().toString() + Math.random(),
              tobaccoStatus: band.tobaccoStatus || band.TobaccoStatus || tier.tobaccoStatus || 'N/A',
              minAge: band.minAge || band.MinAge || 18,
              maxAge: band.maxAge || band.MaxAge || 65,
              netRate,
              overrideRate,
              commission,
              systemFees: band.systemFees || band.SystemFees || 0,
              msrpRate: resolveWizardRetailMsrpRate({
                msrpFromDb:
                  band.msrpRate ||
                  band.MSRPRate ||
                  componentBase,
                componentBase,
                includedProcessingFee,
                includeProcessingFee: includeProcessingFeeFromProduct,
              }),
              includedProcessingFee,
              affiliateRate: band.affiliateRate || band.MSRPRate || ((band.netRate || band.NetRate || 0) + (band.overrideRate || band.OverrideRate || 0)), // Keep for backward compatibility
              locked: Boolean(lockedValue),
              effectiveDate: effectiveSource ? new Date(effectiveSource).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
              terminationDate: terminationSource ? new Date(terminationSource).toISOString().split('T')[0] : null,
              configValue1: band.configValue1 || band.ConfigValue1 || band.configField1Value || '',
              configValue2: band.configValue2 || band.ConfigValue2 || band.configField2Value || '',
              configValue3: band.configValue3 || band.ConfigValue3 || band.configField3Value || '',
              configValue4: band.configValue4 || band.ConfigValue4 || band.configField4Value || '',
              configValue5: band.configValue5 || band.ConfigValue5 || band.configField5Value || '',
              productPricingId: band.ProductPricingId || band.id || null,
              overrides: Array.isArray(band.overrides || band.Overrides)
                ? (band.overrides || band.Overrides)
                    .filter((o: any) => o)
                    .map((o: any) => ({
                      OverrideId: o.OverrideId || o.id,
                      ProductId: o.ProductId,
                      ProductPricingId: o.ProductPricingId || o.productPricingId || band.ProductPricingId || band.id,
                      TenantId: o.TenantId,
                      OverrideACHId: o.OverrideACHId,
                      OverrideName: o.OverrideName,
                      OverrideAmount: parseFloat(o.OverrideAmount ?? o.amount ?? 0),
                      Priority: o.Priority ?? null,
                      IsActive: typeof o.IsActive === 'boolean' ? o.IsActive : o.isActive !== false,
                      EffectiveDate: o.EffectiveDate || null,
                      ExpirationDate: o.ExpirationDate || null,
                      TenantName: o.TenantName || null,
                      ACHAccountHolderName: o.ACHAccountHolderName || null,
                      ACHBankName: o.ACHBankName || null,
                      ACHAccountType: o.ACHAccountType || null,
                      PricingName: o.PricingName || null,
                      PricingLabel: o.PricingLabel || null,
                      PricingTierType: o.PricingTierType || null,
                      PricingTobaccoStatus: o.PricingTobaccoStatus || null,
                      PricingMinAge: o.PricingMinAge ?? null,
                      PricingMaxAge: o.PricingMaxAge ?? null
                    }))
                : []
            };
          })
        };
        if (mappedTier.ageBands.length > 0) {
          pricingTiers.push(mappedTier);
        }
      });
    } else {
      console.log('⚠️ No pricing tiers found or not an array');
    }

    const inferredIncludeFromTiers = pricingTiers.some((tier) =>
      tier.ageBands.some((band: { includedProcessingFee?: number }) => Number(band.includedProcessingFee || 0) > 0)
    );
    
    console.log('🔍 Product vendor data:', {
      VendorId: product.VendorId,
      IsVendorPrice: product.IsVendorPrice,
      VendorCommission: product.VendorCommission
    });
    
    const mappedData = {
      // Vendor fields - Map from API response
      vendorId: product.VendorId || providedVendorId || '',
      isVendorPricing: Boolean(product.IsVendorPrice),  // Ensure boolean
      vendorCommission: parseFloat(product.VendorCommission) || 0,
      vendorGroupIdProductType: (() => {
        const raw = product.VendorGroupIdProductType ?? product.vendorGroupIdProductType;
        if (raw === null || raw === undefined || raw === '') return '';
        return String(raw);
      })(),
      eligibilityIndividualVendorGroupId: (product.EligibilityIndividualVendorGroupId ?? product.eligibilityIndividualVendorGroupId ?? '').trim() || '',
      planId: (product.PlanId ?? product.planId ?? '').trim() || '',
      eligibilityVendorGroupFallbackProductId: (() => {
        const raw = product.EligibilityVendorGroupFallbackProductId ?? product.eligibilityVendorGroupFallbackProductId;
        if (raw == null || raw === '') return '';
        return String(raw);
      })(),
      // Rest of the fields
      name: product.Name || '',
      description: product.Description || '',
      productType: product.ProductType || '',
      productOwnerId: product.ProductOwnerId || '',
      salesType: product.SalesType || 'Both',
      minAge: product.MinAge || 18,
      maxAge: product.MaxAge || 65,
      allowedStates,
      requiresTobaccoInfo: product.RequiresTobaccoInfo || false,
      effectiveDateLogic: (product.EffectiveDateLogic === 'SelectedDay' ? 'SameDay' : product.EffectiveDateLogic) || 'FirstOfMonth',
      maxEffectiveDateDays: product.MaxEffectiveDateDays || 60,
      terminationLogic: product.TerminationLogic || '',
      requiredLicenses,
      isPublic: Boolean(product.IsPublic),
      isHidden: Boolean(product.IsHidden),
      isSSNRequired: Boolean(product.IsSSNRequired),
      premiumReportingCategory: (
        product.PremiumReportingCategory === 'NonProfit' || product.premiumReportingCategory === 'NonProfit'
          ? 'NonProfit'
          : 'ForProfit'
      ) as 'NonProfit' | 'ForProfit',
      configurationFields: configFields.map((field: any) => ({
        id: field.id || Date.now().toString() + Math.random(),
        fieldName: field.fieldName || '',
        fieldOptions: field.fieldOptions || [''],
        isDeductible: field.isDeductible || false
      })),
      pricingTiers,
      includeProcessingFee: includeProcessingFeeFromProduct || inferredIncludeFromTiers,
      manualIncludedProcessingFee:
        product.manualIncludedProcessingFee === true ||
        product.ManualIncludedProcessingFee === true ||
        product.ManualIncludedProcessingFee === 1,
      roundUpProcessingFee:
        product.roundUpProcessingFee === false ||
        product.RoundUpProcessingFee === false ||
        product.RoundUpProcessingFee === 0
          ? false
          : product.roundUpProcessingFee !== false &&
            (product.RoundUpProcessingFee === undefined ||
              product.RoundUpProcessingFee === null ||
              product.RoundUpProcessingFee === true ||
              product.RoundUpProcessingFee === 1),
      processingFeePercentage:
        product.processingFeePercentage != null && !Number.isNaN(Number(product.processingFeePercentage))
          ? Number(product.processingFeePercentage)
          : product.ProcessingFeePercentage != null && !Number.isNaN(Number(product.ProcessingFeePercentage))
            ? Number(product.ProcessingFeePercentage)
            : null,
      productImageFile: null,
      productLogoFile: null,
      productDocumentFile: null,
      productDocumentFiles: [],
      productDocuments: (product.productDocuments && Array.isArray(product.productDocuments))
        ? product.productDocuments.map((d: any) => ({
            productDocumentId: d.productDocumentId || d.ProductDocumentId,
            documentUrl: d.documentUrl || d.DocumentUrl || '',
            displayName: d.displayName || d.DisplayName,
            sortOrder: d.sortOrder ?? d.SortOrder ?? 0
          }))
        : (product.ProductDocumentUrl || product.productDocumentUrl)
          ? [{ documentUrl: product.ProductDocumentUrl || product.productDocumentUrl || '', displayName: 'Document', sortOrder: 0 }]
          : [],
      idCardLogoFile: null,  // ADD THIS LINE
      // Preserve URLs if they exist (from AI-generated data)
      productImageUrl: product.ProductImageUrl || product.productImageUrl || '',
      productLogoUrl: product.ProductLogoUrl || product.productLogoUrl || '',
      productDocumentUrl: product.ProductDocumentUrl || product.productDocumentUrl || '',
      productQuestionnaires: product.ProductQuestionnaires
        ? (typeof product.ProductQuestionnaires === 'string'
          ? JSON.parse(product.ProductQuestionnaires)
          : product.ProductQuestionnaires)
        : undefined,
      acknowledgementQuestions: ackQuestions.map((q: any) => ({
        id: q.id || Date.now().toString() + Math.random(),
        question: q.question || '',
        fieldType: q.fieldType || 'checkbox',
        required: q.required || false,
        options: Array.isArray(q.options) ? q.options : 
               (typeof q.options === 'string' && q.options.length > 0) ? 
               q.options.split('\n').filter((opt: string) => opt.trim()) : 
               [],
        customAction: q.customAction || ''
      })),
      idCardData,
      showGroupIdOnIDCard:
        product.ShowGroupIdOnIDCard === true ||
        product.ShowGroupIdOnIDCard === 1 ||
        product.ShowGroupIdOnIDCard === '1' ||
        product.showGroupIdOnIDCard === true ||
        product.showGroupIdOnIDCard === 1,
      idCardMemberIdPrefixMask: product.IDCardMemberIdPrefixMask ?? product.idCardMemberIdPrefixMask ?? '',
      planDetailsData,
      aiChunks,  // Use the processed AI chunks
      requiredASA: product.RequiredASA ? 
        (typeof product.RequiredASA === 'string' ? JSON.parse(product.RequiredASA) : product.RequiredASA) : 
        undefined,
      trainingConfig: product.TrainingConfig != null
        ? (typeof product.TrainingConfig === 'string' ? JSON.parse(product.TrainingConfig) : product.TrainingConfig)
        : undefined,
      medicalNeedsLinksConfig: (() => {
        const raw = product.MedicalNeedsLinksConfig ?? product.medicalNeedsLinksConfig;
        if (raw == null) return undefined;
        try {
          const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (!p || typeof p !== 'object') return undefined;
          return {
            ...p,
            categoryTitle: typeof (p as { categoryTitle?: unknown }).categoryTitle === 'string'
              ? (p as { categoryTitle: string }).categoryTitle
              : '',
            links: Array.isArray((p as { links?: unknown }).links) ? (p as { links: [] }).links : [],
            displayPriority: clampMedicalNeedsDisplayPriority(
              (p as { displayPriority?: unknown }).displayPriority
            )
          };
        } catch {
          return undefined;
        }
      })()
    };
    
    console.log('✅ Final mapped form data:', {
      configurationFieldsCount: mappedData.configurationFields.length,
      pricingTiersCount: mappedData.pricingTiers.length,
      aiChunksCount: mappedData.aiChunks.length,
      hasIDCardData: !!mappedData.idCardData,
      hasPlanDetailsData: !!mappedData.planDetailsData,
      hasRequiredASA: !!mappedData.requiredASA,
      requiredASA: mappedData.requiredASA,
      configurationFields: mappedData.configurationFields,
      pricingTiers: mappedData.pricingTiers,
      aiChunks: mappedData.aiChunks
    });
    
    return mappedData;
  };

  // Reset form when modal opens or closes (skip re-init if parent re-renders with same session key)
  useEffect(() => {
    const wizardInitKey = (() => {
      if (prefilledDraft) return `prefilled:${providedVendorId || ''}`;
      if (editingProduct?.ProductId && /^[0-9a-f-]{36}$/i.test(editingProduct.ProductId)) {
        return `edit:${editingProduct.ProductId}`;
      }
      if (editingProduct && ((editingProduct as ProductFormData).name || (editingProduct as ProductFormData).vendorId)) {
        return `ai-draft:${providedVendorId || ''}`;
      }
      return `new:${providedVendorId || ''}`;
    })();

    if (isOpen) {
      if (wizardInitKeyRef.current === wizardInitKey) {
        return;
      }
      wizardInitKeyRef.current = wizardInitKey;
      setDataReady(false); // Reset data ready state
      
      if (prefilledDraft) {
        console.log('🧩 Using prefilled E123 migration draft');
        setIsAIGenerated(true);
        setFormData({
          ...initialFormData,
          ...prefilledDraft,
          vendorId: prefilledDraft.vendorId || providedVendorId || ''
        });
        setExistingMediaUrls({
          productImageUrl: prefilledDraft.productImageUrl || '',
          productLogoUrl: prefilledDraft.productLogoUrl || '',
          productDocumentUrl: prefilledDraft.productDocumentUrl || ''
        });
        setDataReady(true);
      } else if (editingProduct) {
        console.log('🔧 EditingProduct data:', editingProduct);
        console.log('🔍 EditingProduct keys:', Object.keys(editingProduct));
        console.log('🔍 Has ProductId:', !!editingProduct.ProductId);
        console.log('🔍 Has name:', !!editingProduct.name);
        console.log('🔍 Has vendorId:', !!editingProduct.vendorId);
        
        // Check if this is AI-generated data (already in ProductFormData format) or a database product
        // AI data has lowercase properties (name, vendorId), database has uppercase (Name, ProductId)
        // CRITICAL: AI-generated products should NEVER have a ProductId - if they do, it's invalid and should be ignored
        const hasValidProductId = editingProduct.ProductId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(editingProduct.ProductId);
        const isAIGeneratedData = !hasValidProductId && (editingProduct.name || editingProduct.vendorId);
        
        console.log('🔍 Detected as AI-generated data:', isAIGeneratedData);
        
        if (isAIGeneratedData) {
          // AI-generated data is already in the correct format, use it directly
          console.log('🤖 Using AI-generated product data directly');
          console.log('🤖 AI Data being set:', editingProduct);
          setIsAIGenerated(true); // Mark this as AI-generated
          setFormData(editingProduct as ProductFormData);
          setExistingMediaUrls({
            productImageUrl: editingProduct.productImageUrl || '',
            productLogoUrl: editingProduct.productLogoUrl || '',
            productDocumentUrl: editingProduct.productDocumentUrl || ''
          });
          setDataReady(true);
        } else {
          // Database product - fetch full product details to ensure we get all data including AI Chunks
          console.log('📡 Fetching complete product details for editing...');
          
          fetchCompleteProductDetails(editingProduct.ProductId)
            .then(productDetails => {
            if (productDetails) {
              console.log('✅ Fetched complete product with all data');
              console.log('🤖 AI Chunks received:', productDetails.AIChunks);
              
              setExistingMediaUrls({
                productImageUrl: (productDetails.ProductImageUrl && productDetails.ProductImageUrl !== 'NULL') ? productDetails.ProductImageUrl : '',
                productLogoUrl: (productDetails.ProductLogoUrl && productDetails.ProductLogoUrl !== 'NULL') ? productDetails.ProductLogoUrl : '',
                productDocumentUrl: (productDetails.ProductDocumentUrl && productDetails.ProductDocumentUrl !== 'NULL') ? productDetails.ProductDocumentUrl : ''
              });
              
              // Set document metadata if available
              if (productDetails.DocumentMetadata) {
                setDocumentMetadata(productDetails.DocumentMetadata);
              }
              
              const updatedData = mapProductToFormData(productDetails);
              const nextData = e123ResyncDraft
                ? mergeE123DraftIntoExistingProduct(updatedData, e123ResyncDraft)
                : updatedData;
              console.log('📝 Setting form data with AI Chunks:', nextData.aiChunks);
              setFormData(nextData);
              setDataReady(true);
            } else {
              console.warn('⚠️ Could not fetch full data, using partial product data');
              const mappedData = mapProductToFormData(editingProduct);
              setFormData(mappedData);
              setDataReady(true);
            }
          })
          .catch(error => {
            console.error('❌ Failed to fetch complete product details:', error);
            const mappedData = mapProductToFormData(editingProduct);
            setFormData(mappedData);
            setDataReady(true);
          });
        }
      } else {
        // New product
        console.log('🆕 Creating new product');
        setIsAIGenerated(false); // Reset flag
        setFormData({
          ...initialFormData,
          vendorId: providedVendorId || '',
          allowedStates: []
        });
        setExistingMediaUrls({
          productImageUrl: '',
          productLogoUrl: '',
          productDocumentUrl: ''
        });
        setDataReady(true);
      }
      
      setCurrentStep(1);
      setLoading(false);
    } else {
      wizardInitKeyRef.current = null;
      setLogoGenerateOpen(false);
      setPlanDetailsGenerateOpen(false);
      // Modal closed - reset everything
      setIsAIGenerated(false); // Reset flag
      setFormData({
        ...initialFormData,
        vendorId: providedVendorId || ''
      });
      setExistingMediaUrls({
        productImageUrl: '',
        productLogoUrl: '',
        productDocumentUrl: ''
      });
      setCurrentStep(1);
      setLoading(false);
      setDataReady(false);
      setPricingValidationErrors(false);
      setSubmitError(null); // Clear errors when modal closes
    }
  }, [isOpen, editingProduct?.ProductId, providedVendorId, e123ResyncDraft, prefilledDraft]);

  const updateFormData = (updates: Partial<ProductFormData>) => {
    console.log('📝 Updating form data:', updates);
    setFormData(prev => ({ ...prev, ...updates }));
  };

  const applyGeneratedProductLogo = useCallback((file: File) => {
    setFormData((prev) => ({
      ...prev,
      productImageFile: file,
      productLogoFile: file,
      deleteProductImage: false,
      deleteProductLogo: false,
    }));
  }, []);

  const applyGeneratedPlanDetails = useCallback((generated: Record<string, unknown>) => {
    setFormData((prev) => {
      const prevPlan = (prev.planDetailsData || {}) as Record<string, any>;
      const prevHeader = prevPlan.Plan_Data?.Header || {};
      const prevFooter = prevPlan.Plan_Data?.Footer || {};
      const genPlan = generated as Record<string, any>;
      const genHeader = genPlan.Plan_Data?.Header || {};
      const genFooter = genPlan.Plan_Data?.Footer || {};

      return {
        ...prev,
        planDetailsData: {
          Plan_Data: {
            Header: {
              ...prevHeader,
              Image: prevHeader.Image ?? '',
              Background_color: prevHeader.Background_color || genHeader.Background_color || '#1f8dbf',
              Text_color: prevHeader.Text_color || genHeader.Text_color || '#FFFFFF',
              Text1: genHeader.Text1 || prevHeader.Text1 || prev.name || '',
              Text2: genHeader.Text2 ?? prevHeader.Text2 ?? '',
            },
            Footer: {
              ...prevFooter,
              Header: genFooter.Header || prevFooter.Header || 'Contact Information',
              Text1: genFooter.Text1 || prevFooter.Text1 || '',
              Text2: genFooter.Text2 ?? prevFooter.Text2 ?? '',
              Background_color: prevFooter.Background_color || genFooter.Background_color || '#FFFFFF',
              Text_color: prevFooter.Text_color || genFooter.Text_color || '#000000',
            },
          },
          Plan_Body: genPlan.Plan_Body,
        },
      };
    });
  }, []);

  const canProceedToNextStep = (): boolean => {
    switch (currentStep) {
      case 1: // Vendor Selection
        return !!formData.vendorId;
      case 2: // Basic Details
        return !!(formData.name && formData.productType && formData.productOwnerId);
      case 3: // Licensing
        return formData.requiredLicenses.length > 0;
      case 4: // Configuration
        return true;
      case 5: // Pricing
        return formData.pricingTiers.length > 0 &&
          formData.pricingTiers.every(tier => tier.tierType) &&
          !pricingValidationErrors;
      case 6: // Acknowledgement Questions
        return true;
      case 7: // Media
        return true;
      case 8: // ID Card
        return true;
      case 9: // Plan Details
        return true;
      case 10: // AI Chunks
        return true;
      case 11: // Training (placeholder)
        return true;
      case 12: // Required ASA
        return true;
      case 13: // Review
        return true;
      default:
        return true;
    }
  };

  const submitBlockers = useMemo(
    () =>
      getProductWizardSubmitBlockers(formData, {
        dataReady,
        loading,
        pricingValidationErrors,
        pricingReviewRequired,
      }),
    [formData, dataReady, loading, pricingValidationErrors, pricingReviewRequired]
  );

  const submitDisabled = isProductWizardSubmitDisabled(formData, {
    dataReady,
    loading,
    pricingValidationErrors,
    pricingReviewRequired,
  });

  const handleSubmit = async () => {
    if (submitDisabled) {
      if (pricingReviewRequired) {
        setSubmitError('Open the Pricing step to review AI pricing changes before saving.');
        setCurrentStep(5);
      }
      return;
    }
    
    setLoading(true);
    try {
      if (onSave) {
        // Process pricing tiers to ensure ConfigField1-5 are populated
        // CRITICAL: If configuration fields are empty, clear all ConfigValue1-5 from pricing tiers
        // This prevents re-extraction of configuration fields from pricing tiers on reload
        const hasConfigurationFields = formData.configurationFields && formData.configurationFields.length > 0;
        
        const processedPricingTiers = formData.pricingTiers.map(tier => ({
          ...tier,
          ageBands: tier.ageBands.map(band => {
            console.log('🔧 Processing band before spread:', {
              id: band.id,
              netRate: band.netRate,
              overrideRate: band.overrideRate,
              commission: band.commission,
              msrpRate: band.msrpRate
            });
            
            const processedBand = { ...band };
            
            console.log('🔧 Processing band after spread:', {
              id: processedBand.id,
              netRate: processedBand.netRate,
              overrideRate: processedBand.overrideRate,
              commission: processedBand.commission,
              msrpRate: processedBand.msrpRate
            });
            
            // If no configuration fields, clear all config values from pricing tiers
            if (!hasConfigurationFields) {
              console.log('🧹 Clearing config values from pricing tier (no configuration fields)');
              processedBand.configValue1 = '';
              processedBand.configValue2 = '';
              processedBand.configValue3 = '';
              processedBand.configValue4 = '';
              processedBand.configValue5 = '';
            } else {
              // Ensure each configValue has a corresponding configField name
              for (let i = 1; i <= 5; i++) {
                const configValueKey = `configValue${i}` as keyof typeof band;
                const configFieldKey = `configField${i}` as keyof typeof band;
                
                if (band[configValueKey] && formData.configurationFields[i - 1]) {
                  // Set the configField name based on the configuration field definition
                  (processedBand as any)[configFieldKey] = formData.configurationFields[i - 1].fieldName;
                } else if (band[configValueKey] && !formData.configurationFields[i - 1]) {
                  // If configValue exists but no corresponding configuration field, clear it
                  (processedBand as any)[configValueKey] = '';
                }
              }
            }
            
            // Default locked flag to boolean and normalize dates
            processedBand.locked = Boolean(processedBand.locked);
            processedBand.effectiveDate = band.effectiveDate || new Date().toISOString().split('T')[0];
            processedBand.terminationDate = band.terminationDate || null;
            
            console.log('🔧 Final processed band:', {
              id: processedBand.id,
              netRate: processedBand.netRate,
              overrideRate: processedBand.overrideRate,
              commission: processedBand.commission,
              msrpRate: processedBand.msrpRate
            });
            
            return processedBand;
          })
        }));

        // Ensure vendor fields are included when saving
        // Single product image: preserve one URL for both ProductImageUrl and ProductLogoUrl when no new file (same field we keep in wizard)
        const productImageOrLogoUrl = formData.productImageUrl || formData.productLogoUrl;
        const manualAiChunks = (formData.aiChunks || []).filter(
          (c) => !(c as { _fromDocumentExtraction?: boolean })._fromDocumentExtraction
        );
        const saveData = {
          ...formData,
          allowedStates: formData.allowedStates || [],
          pricingTiers: processedPricingTiers,
          aiChunks: editingProductId ? manualAiChunks : formData.aiChunks,
          vendorId: formData.vendorId,
          isVendorPricing: formData.isVendorPricing,
          vendorCommission: 0, // VendorCommission is now stored at the pricing band level
          showGroupIdOnIDCard: productUsesVendorGroupId(formData.vendorGroupIdProductType)
            ? formData.showGroupIdOnIDCard === true
            : false,
          ...(productImageOrLogoUrl && !formData.productImageFile && {
            productImageUrl: productImageOrLogoUrl,
            productLogoUrl: productImageOrLogoUrl
          }),
          ...(formData.productDocumentUrl && !formData.productDocumentFile && { productDocumentUrl: formData.productDocumentUrl }),
          productDocuments: (formData.productDocuments && formData.productDocuments.length > 0)
            ? formData.productDocuments
            : (formData.productDocumentUrl ? [{ documentUrl: formData.productDocumentUrl, displayName: (formData as any).productDocumentName || 'Document', sortOrder: 0 }] : [])
        };
        
        console.log('💾 Submitting product data:', {
          vendorId: saveData.vendorId,
          isVendorPricing: saveData.isVendorPricing,
          vendorCommission: saveData.vendorCommission,
          originalFormCommission: formData.vendorCommission,
          aiChunksCount: saveData.aiChunks.length,
          aiChunks: saveData.aiChunks,
          hasIdCardLogoFile: !!saveData.idCardLogoFile,
          pricingTiersProcessed: processedPricingTiers.length,
          configFieldsMapped: formData.configurationFields.length,
          requiredASA: saveData.requiredASA,
          // Log URL preservation
          productImageUrl: saveData.productImageUrl || 'none',
          productLogoUrl: saveData.productLogoUrl || 'none',
          productDocumentUrl: saveData.productDocumentUrl || 'none',
          hasProductImageFile: !!saveData.productImageFile,
          hasProductLogoFile: !!saveData.productLogoFile,
          hasProductDocumentFile: !!saveData.productDocumentFile,
          pricingTiersWithCommission: saveData.pricingTiers.map(tier => ({
            tierType: tier.tierType,
            label: tier.label,
            ageBands: tier.ageBands.map(band => ({
              id: band.id,
              netRate: band.netRate,
              commission: band.commission,
              msrpRate: band.msrpRate,
              tobaccoStatus: band.tobaccoStatus
            }))
          }))
        });
        
        await onSave(saveData);
      }
      setSubmitError(null); // Clear any previous errors
      clearProductAiSession();
      setAiChatOpen(false);
      handleComplete();
    } catch (error: any) {
      console.error('❌ Error saving product:', error);
      const errorMessage = error?.response?.data?.message || error?.message || 'Failed to save product. Please try again.';
      setSubmitError(errorMessage);
      // Scroll to top to show error
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setLoading(false);
    }
  };

  const nextStep = () => {
    const maxStep = 13;
    if (currentStep < maxStep && canProceedToNextStep()) {
      if (currentStep === 10 || currentStep === 11) {
        console.log('🤖 AI Chunks at step transition:', {
          currentStep,
          aiChunksCount: formData.aiChunks.length,
          aiChunks: formData.aiChunks
        });
      }
      setCurrentStep(currentStep + 1);
    }
  };

  const prevStep = () => {
    const minStep = 1;
    if (currentStep > minStep) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleStepClick = (step: number) => {
    // Allow navigation to any step
    setCurrentStep(step);
  };


  const renderStepIndicator = () => {
    // Define the step order, labels, and determine completion status
    const stepOrder = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
    const stepLabels = [
      'Vendor',
      'Details',
      'Licensing',
      'Config',
      'Pricing',
      'Questions',
      'Media',
      'ID Card',
      'Plans',
      'AI',
      'Med Needs',
      'ASA',
      'Review'
    ];
    
    const isStepCompleted = (step: number) => {
      if (step === 12) {
        return currentStep >= 12;
      } else if (step === 13) {
        return currentStep >= 13;
      } else {
        // Regular steps are completed when current step is greater
        return currentStep > step;
      }
    };

    const hasStepErrors = (step: number) => {
      if (step === 5) {
        return pricingValidationErrors;
      }
      return false;
    };

    return (
      <div className="flex items-center justify-center mb-8">
        {stepOrder.map((step, index) => {
          const hasErrors = hasStepErrors(step);
          const isCurrent = step === currentStep;
          const isCompleted = isStepCompleted(step);

          let buttonClass = '';
          if (hasErrors) {
            buttonClass = 'bg-red-500 text-white hover:bg-red-600';
          } else if (isCurrent) {
            buttonClass = 'bg-oe-primary text-white shadow-lg transform scale-105';
          } else if (isCompleted) {
            buttonClass = 'bg-oe-success text-white hover:bg-green-600 cursor-pointer';
          } else {
            buttonClass = 'bg-gray-200 text-gray-600 hover:bg-gray-300 cursor-pointer';
          }

          let labelClass = '';
          if (hasErrors) {
            labelClass = 'text-red-600';
          } else if (isCurrent) {
            labelClass = 'text-oe-primary';
          } else if (isCompleted) {
            labelClass = 'text-green-600';
          } else {
            labelClass = 'text-gray-500';
          }

          return (
            <div key={step} className="flex items-center">
              <div className="flex flex-col items-center">
                <button
                  onClick={() => handleStepClick(step)}
                  className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold transition-all duration-200 ${buttonClass} hover:shadow-md`}
                >
                  <span className="sr-only">{`Step ${step}: ${stepLabels[index]}`}</span>
                </button>
                <span className={`text-xs mt-1 font-medium ${labelClass}`}>
                  {stepLabels[index]}
                </span>
              </div>
              {index < stepOrder.length - 1 && (
                <div className={`w-12 h-1 mx-2 transition-all duration-200 ${
                  isStepCompleted(step) ? 'bg-oe-success' : 'bg-gray-200'
                }`} />
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const renderCurrentStep = () => {
    // Don't render steps until data is ready when editing
    if (editingProduct && !dataReady) {
      return (
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary mx-auto mb-4"></div>
            <p className="text-oe-text">Loading product data...</p>
          </div>
        </div>
      );
    }
    
    // Log current step and AI Chunks when rendering AI step
    if (currentStep === 11) {
      console.log('🎯 Rendering Step 11 - AI Chunks:', {
        aiChunksCount: formData.aiChunks.length,
        aiChunks: formData.aiChunks
      });
    }
    
    switch (currentStep) {
      case 1:
        return (
          <Step1VendorSelection
            formData={formData}
            updateFormData={updateFormData}
            isVendorAdmin={isVendorAdmin}
            editingProductId={editingProduct?.ProductId}
          />
        );
      case 2:
        return (
          <Step2BasicDetails
            formData={formData}
            updateFormData={updateFormData}
            isTenantAdmin={isTenantAdmin}
            isVendorAdmin={isVendorAdmin}
            isSysAdmin={isSysAdmin}
            editingProductId={editingProductId}
          />
        );
      case 3:
        return <Step2Licensing formData={formData} updateFormData={updateFormData} />;
      case 4:
        return <Step3ConfigurationFields formData={formData} updateFormData={updateFormData} />;
      case 5:
        return <Step4Pricing
          key={`pricing-step-${pricingTiersRevision}`}
          formData={formData}
          updateFormData={updateFormData}
          pricingTiersRevision={pricingTiersRevision}
          onValidationChange={setPricingValidationErrors}
          editingProductId={editingProduct?.ProductId}
          isTenantAdmin={isTenantAdmin}
        />;
      case 6:
        return <Step5AcknowledgementQuestions formData={formData} updateFormData={updateFormData} />;
      case 7:
        return <Step6MediaDocuments 
          formData={formData} 
          updateFormData={updateFormData}
          existingMediaUrls={existingMediaUrls}
          documentMetadata={documentMetadata}
          onOpenLogoGenerate={() => setLogoGenerateOpen(true)}
        />;
      case 8:
        return <Step7IDCard 
          formData={formData} 
          updateFormData={updateFormData}
          existingMediaUrls={existingMediaUrls}
        />;
      case 9:
        return <Step8PlanDetails 
          formData={formData} 
          updateFormData={updateFormData}
          existingMediaUrls={existingMediaUrls}
          onOpenPlanDetailsGenerate={() => setPlanDetailsGenerateOpen(true)}
        />;
      case 10:
        return <Step9AIChunks formData={formData} updateFormData={updateFormData} editingProductId={editingProductId} />;
      case 11:
        return <StepMedicalNeedsLinks formData={formData} updateFormData={updateFormData} isTenantAdmin={isTenantAdmin} />;
      case 12:
        return <Step11RequiredASA formData={formData} updateFormData={updateFormData} />;
      case 13:
        return (
          <Step10Review
            formData={formData}
            editingProduct={editingProduct}
            isTenantAdmin={isTenantAdmin}
            submitBlockers={submitBlockers}
          />
        );
      default:
        return null;
    }
  };

  if (!isOpen || !isMounted) return null;

  return createPortal(
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-start justify-center z-[2147483647]">
      <div className="bg-white rounded-lg w-full max-w-[90rem] h-[90vh] max-h-[90vh] overflow-hidden shadow-2xl flex flex-col mt-8">
        <div className="flex justify-between items-center p-3 border-b border-gray-200 bg-gradient-to-r from-oe-primary to-oe-dark">
          <h2 className="text-xl font-bold text-white">
            {editingProduct && !isAIGenerated ? 'Edit Product' : 'Add New Product'}
          </h2>
          <button
            onClick={handleClose}
            className="text-white hover:bg-white hover:bg-opacity-20 p-2 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {loading && (
          <div className="absolute inset-0 bg-white bg-opacity-75 flex items-center justify-center z-10">
            <div className="text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary mx-auto mb-2"></div>
              <p className="text-oe-text">Processing...</p>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-hidden flex flex-col">
          <div className="px-4 pt-3 pb-1">
            {renderStepIndicator()}
          </div>
          
          {/* Error Message - Display prominently at top */}
          {submitError && (
            <div className="mx-4 mb-4 bg-red-50 border-l-4 border-red-500 p-4 rounded shadow-lg z-50">
              <div className="flex items-start">
                <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5 mr-3" />
                <div className="flex-1">
                  <h3 className="text-sm font-medium text-red-900 mb-1">Error Saving Product</h3>
                  <p className="text-sm text-red-700">{submitError}</p>
                </div>
                <button
                  onClick={() => setSubmitError(null)}
                  className="text-red-600 hover:text-red-800 ml-4"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {aiApplyBanner && (
            <div className="mx-4 mb-4 bg-green-50 border-l-4 border-green-500 p-4 rounded shadow-sm">
              <div className="flex items-start">
                <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5 mr-3" />
                <div className="flex-1">
                  <h3 className="text-sm font-medium text-green-900 mb-1">AI changes applied</h3>
                  <p className="text-sm text-green-800">{aiApplyBanner}</p>
                </div>
                <button
                  onClick={() => setAiApplyBanner(null)}
                  className="text-green-700 hover:text-green-900 ml-4"
                  type="button"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
          
          <div className="flex-1 px-4 pb-4 overflow-y-auto">
            {renderCurrentStep()}
          </div>
        </div>

        <div className="flex justify-between items-center p-4 border-t border-gray-200 bg-oe-light bg-opacity-30">
          <div className="flex items-center gap-3">
            <button
              onClick={prevStep}
              disabled={currentStep === 1 || loading}
              className={`btn-secondary flex items-center ${
                currentStep === 1 || loading ? 'opacity-50 cursor-not-allowed' : ''
              }`}
            >
              <ChevronLeft className="w-4 h-4 mr-1" />
              Previous
            </button>
            
            <button
              onClick={() => setAiChatOpen(true)}
              disabled={loading || !dataReady || !formData.productOwnerId}
              className="btn-secondary flex items-center gap-2 disabled:opacity-50"
              title={
                !formData.productOwnerId
                  ? 'Complete Basic Details (tenant) first.'
                  : 'Edit product with AI'
              }
            >
              <Sparkles className="w-4 h-4" />
              Edit with AI
            </button>
          </div>

          <div className="text-sm text-gray-600 font-medium">
            Step {currentStep} of 13
          </div>

          {currentStep === 13 ? (
            <button
              onClick={handleSubmit}
              disabled={submitDisabled}
              className="btn-success flex items-center disabled:opacity-50"
              title={submitBlockers.length > 0 ? submitBlockers.join(' ') : undefined}
            >
              {loading ? (editingProduct && !isAIGenerated ? 'Updating...' : 'Creating...') : (editingProduct && !isAIGenerated ? 'Update Product' : 'Create Product')}
            </button>
          ) : (
            <button
              onClick={nextStep}
              disabled={!canProceedToNextStep() || loading || !dataReady}
              className={`btn-primary flex items-center ${
                !canProceedToNextStep() || loading || !dataReady ? 'opacity-50 cursor-not-allowed' : ''
              }`}
            >
              Next
              <ChevronRight className="w-4 h-4 ml-1" />
            </button>
          )}
        </div>


        <ProductWizardAIAssistant
          open={aiChatOpen}
          onClose={() => setAiChatOpen(false)}
          formData={formData}
          currentStep={currentStep}
          storageKey={productAiStorageKey}
          draftSessionId={draftSessionId}
          editingProductId={editingProductId}
          onApplyPatch={handleApplyAiPatch}
        />

        <ProductLogoGenerateModal
          open={logoGenerateOpen}
          onClose={() => setLogoGenerateOpen(false)}
          context={{
            productName: formData.name,
            productType: formData.productType,
            description: formData.description,
          }}
          onApply={applyGeneratedProductLogo}
        />

        <PlanDetailsGenerateModal
          open={planDetailsGenerateOpen}
          onClose={() => setPlanDetailsGenerateOpen(false)}
          formData={formData}
          existingProductDocumentUrl={existingMediaUrls.productDocumentUrl}
          onApply={applyGeneratedPlanDetails}
        />
      </div>
    </div>,
    document.body
  );
}
