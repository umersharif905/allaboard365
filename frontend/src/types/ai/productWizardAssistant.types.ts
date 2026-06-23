import type { ProductFormData } from '../sysadmin/addproductswizard.types';
import type { ProductFieldChange } from '../../utils/productAiMerge';
import type { ProductAiPricingPhaseContext } from '../../utils/productAiPricingPhase';

export type AIProductReply =
  | { kind: 'question'; text: string }
  | {
      kind: 'proposal';
      summary: string;
      patch: Partial<ProductFormData>;
      warnings?: string[];
      changes?: ProductFieldChange[];
    }
  | { kind: 'error'; text: string };

export type ProductWizardChatMessage =
  | { id: string; role: 'user'; content: string }
  | { id: string; role: 'assistant'; kind: 'question'; text: string }
  | { id: string; role: 'assistant'; kind: 'streaming'; text: string }
  | { id: string; role: 'assistant'; kind: 'proposal'; reply: Extract<AIProductReply, { kind: 'proposal' }> }
  | { id: string; role: 'assistant'; kind: 'error'; text: string }
  | { id: string; role: 'assistant'; kind: 'system'; text: string };

export type ProductAiSnapshot = {
  productId?: string | null;
  name?: string;
  vendorId?: string;
  productOwnerId?: string;
  productType?: string;
  salesType?: string;
  currentStep: number;
  currentStepLabel: string;
  minAge?: number;
  maxAge?: number;
  includeProcessingFee?: boolean;
  manualIncludedProcessingFee?: boolean;
  roundUpProcessingFee?: boolean;
  processingFeePercentage?: number | null;
  pricingTierIds: Array<{
    index: number;
    id: string;
    tierType: string;
    label: string;
    ageBandCount: number;
  }>;
  pricingTiersSummary: Array<{
    id: string;
    tierType: string;
    label: string;
    ageBands: Array<{
      id: string;
      minAge: number;
      maxAge: number;
      tobaccoStatus: string;
      netRate: number;
      overrideRate?: number;
      commission?: number;
      msrpRate: number;
      effectiveDate?: string | null;
      terminationDate?: string | null;
      configValue1?: string | null;
      configValue2?: string | null;
      configValue3?: string | null;
      configValue4?: string | null;
      configValue5?: string | null;
    }>;
  }>;
  pricingPhase: ProductAiPricingPhaseContext;
  configurationFieldCount: number;
  configurationFieldNames: string[];
  acknowledgementQuestionCount: number;
  aiChunkCount: number;
  productQuestionnaireCount: number;
  idCardDisabled?: boolean;
  networkVariationCount: number;
  vendorGroupIdProductType?: string;
  eligibilityVendorGroupFallbackProductId?: string;
  showGroupIdOnIDCard?: boolean;
  descriptionPreview?: string;
  hasProductImage: boolean;
  hasProductLogo: boolean;
  hasProductDocument: boolean;
};

export type ProductWizardAiSessionPayload = {
  messages: ProductWizardChatMessage[];
  sessionDocExtract?: string;
  draftSessionId?: string;
  updatedAt: number;
};

export type ProductWizardAIAssistantProps = {
  open: boolean;
  onClose: () => void;
  formData: ProductFormData;
  currentStep: number;
  storageKey: string;
  draftSessionId: string;
  editingProductId?: string | null;
  onApplyPatch: (patch: Partial<ProductFormData>) => void;
};
