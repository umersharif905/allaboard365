import type { ProductFormData } from '../types/sysadmin/addproductswizard.types';
import type { ProductAiSnapshot } from '../types/ai/productWizardAssistant.types';
import { buildProductAiPricingPhaseContext } from './productAiPricingPhase';

const STEP_LABELS: Record<number, string> = {
  1: 'Vendor',
  2: 'Details',
  3: 'Licensing',
  4: 'Config',
  5: 'Pricing',
  6: 'Acknowledgement',
  7: 'Media',
  8: 'ID Card',
  9: 'Plan Details',
  10: 'AI Chunks',
  11: 'Training',
  12: 'Required ASA',
  13: 'Review',
};

function truncateText(value: string | undefined, max: number): string | undefined {
  if (!value || typeof value !== 'string') return undefined;
  const t = value.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

/** Structured wizard snapshot for AI turns (no File blobs / huge base64). */
export function buildProductFormSnapshot(
  formData: ProductFormData,
  currentStep: number,
  editingProductId?: string | null
): ProductAiSnapshot {
  const pricingTierIds = (formData.pricingTiers || []).map((tier, index) => ({
    index: index + 1,
    id: tier.id,
    tierType: tier.tierType,
    label: tier.label || 'Unnamed',
    ageBandCount: tier.ageBands?.length || 0,
  }));

  const pricingTiersSummary = (formData.pricingTiers || []).map((tier) => ({
    id: tier.id,
    tierType: tier.tierType,
    label: tier.label || '',
    ageBands: (tier.ageBands || []).slice(0, 24).map((b) => ({
      id: b.id,
      minAge: b.minAge,
      maxAge: b.maxAge,
      tobaccoStatus: b.tobaccoStatus || 'N/A',
      netRate: b.netRate,
      overrideRate: b.overrideRate,
      commission: b.commission,
      includedProcessingFee: b.includedProcessingFee,
      msrpRate: b.msrpRate,
      effectiveDate: b.effectiveDate ?? null,
      terminationDate: b.terminationDate ?? null,
      configValue1: b.configValue1 ?? null,
      configValue2: b.configValue2 ?? null,
      configValue3: b.configValue3 ?? null,
      configValue4: b.configValue4 ?? null,
      configValue5: b.configValue5 ?? null,
    })),
  }));

  const pricingPhase = buildProductAiPricingPhaseContext(formData.pricingTiers);

  const configFields = formData.configurationFields || [];

  return {
    productId: editingProductId || null,
    name: formData.name || undefined,
    vendorId: formData.vendorId,
    productOwnerId: formData.productOwnerId,
    productType: formData.productType,
    salesType: formData.salesType,
    currentStep,
    currentStepLabel: STEP_LABELS[currentStep] || `Step ${currentStep}`,
    minAge: formData.minAge,
    maxAge: formData.maxAge,
    includeProcessingFee: formData.includeProcessingFee === true,
    manualIncludedProcessingFee: formData.manualIncludedProcessingFee === true,
    roundUpProcessingFee: formData.roundUpProcessingFee !== false,
    processingFeePercentage:
      formData.processingFeePercentage != null ? Number(formData.processingFeePercentage) : null,
    pricingTierIds,
    pricingTiersSummary,
    pricingPhase,
    configurationFieldCount: configFields.length,
    configurationFieldNames: configFields.map((f) => f.fieldName).slice(0, 20),
    acknowledgementQuestionCount: formData.acknowledgementQuestions?.length || 0,
    aiChunkCount: formData.aiChunks?.length || 0,
    productQuestionnaireCount: formData.productQuestionnaires ? 1 : 0,
    idCardDisabled: formData.idCardData?.DisableIDCard === true,
    networkVariationCount: Object.keys(formData.idCardData?.NetworkVariations || {}).length,
    vendorGroupIdProductType: formData.vendorGroupIdProductType || undefined,
    eligibilityVendorGroupFallbackProductId:
      formData.eligibilityVendorGroupFallbackProductId || undefined,
    showGroupIdOnIDCard: formData.showGroupIdOnIDCard,
    descriptionPreview: truncateText(formData.description, 500),
    hasProductImage: Boolean(formData.productImageUrl || formData.productImageFile),
    hasProductLogo: Boolean(formData.productLogoUrl || formData.productLogoFile),
    hasProductDocument: Boolean(
      formData.productDocumentUrl ||
        formData.productDocumentFile ||
        (formData.productDocuments && formData.productDocuments.length > 0)
    ),
  };
}
