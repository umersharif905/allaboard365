import type { ProductFormData } from '../components/forms/AddProductWizard';

type AgeBand = {
  tierType?: string;
  tobaccoStatus?: string;
  minAge?: number;
  maxAge?: number;
  configValue1?: string;
  [key: string]: unknown;
};

type PricingTier = {
  tierType?: string;
  ageBands?: AgeBand[];
  [key: string]: unknown;
};

function bandMatchKey(band: AgeBand) {
  return [
    band.tierType || '',
    band.tobaccoStatus || 'No',
    band.minAge ?? '',
    band.maxAge ?? '',
    band.configValue1 || ''
  ].join('|');
}

function mergePricingTiers(existing: PricingTier[] = [], draft: PricingTier[] = []): PricingTier[] {
  if (!draft.length) return existing;
  const merged = existing.map((tier) => ({
    ...tier,
    ageBands: [...(tier.ageBands || [])]
  }));

  for (const draftTier of draft) {
    let targetTier = merged.find((tier) => tier.tierType === draftTier.tierType);
    if (!targetTier) {
      merged.push({
        ...draftTier,
        ageBands: [...(draftTier.ageBands || [])]
      });
      continue;
    }

    for (const draftBand of draftTier.ageBands || []) {
      const key = bandMatchKey(draftBand);
      const existingIndex = (targetTier.ageBands || []).findIndex((band) => bandMatchKey(band) === key);
      if (existingIndex >= 0) {
        targetTier.ageBands![existingIndex] = {
          ...targetTier.ageBands![existingIndex],
          ...draftBand
        };
      } else {
        targetTier.ageBands!.push({ ...draftBand });
      }
    }
  }

  return merged;
}

/** Overlay fresh E123 wizard draft fields onto an existing AB365 product form. */
export function mergeE123DraftIntoExistingProduct(
  existing: ProductFormData,
  draft: ProductFormData
): ProductFormData {
  const mergedPricingTiers = draft.pricingTiers?.length
    ? mergePricingTiers(
        existing.pricingTiers as unknown as PricingTier[],
        draft.pricingTiers as unknown as PricingTier[]
      )
    : existing.pricingTiers;

  const merged: ProductFormData = {
    ...existing,
    // Catalog / pricing from latest E123 data
    name: draft.name || existing.name,
    description: draft.description ?? existing.description,
    productType: draft.productType || existing.productType,
    salesType: draft.salesType || existing.salesType,
    minAge: draft.minAge ?? existing.minAge,
    maxAge: draft.maxAge ?? existing.maxAge,
    allowedStates: draft.allowedStates?.length ? draft.allowedStates : existing.allowedStates,
    requiresTobaccoInfo: draft.requiresTobaccoInfo ?? existing.requiresTobaccoInfo,
    effectiveDateLogic: draft.effectiveDateLogic || existing.effectiveDateLogic,
    maxEffectiveDateDays: draft.maxEffectiveDateDays ?? existing.maxEffectiveDateDays,
    terminationLogic: draft.terminationLogic || existing.terminationLogic,
    requiredLicenses: draft.requiredLicenses?.length ? draft.requiredLicenses : existing.requiredLicenses,
    configurationFields: draft.configurationFields?.length
      ? draft.configurationFields
      : existing.configurationFields,
    pricingTiers: mergedPricingTiers as ProductFormData['pricingTiers'],
    isVendorPricing: draft.isVendorPricing ?? existing.isVendorPricing,
    vendorCommission: draft.vendorCommission ?? existing.vendorCommission,
    vendorGroupIdProductType: draft.vendorGroupIdProductType || existing.vendorGroupIdProductType,
    eligibilityIndividualVendorGroupId:
      draft.eligibilityIndividualVendorGroupId ?? existing.eligibilityIndividualVendorGroupId,
    eligibilityVendorGroupFallbackProductId:
      draft.eligibilityVendorGroupFallbackProductId ?? existing.eligibilityVendorGroupFallbackProductId,
    // Keep tenant ownership + visibility from existing product
    productOwnerId: existing.productOwnerId,
    isPublic: existing.isPublic,
    isHidden: existing.isHidden,
    isSSNRequired: existing.isSSNRequired,
    premiumReportingCategory: existing.premiumReportingCategory,
    // Prefer draft content when present; keep existing media URLs
    idCardData: draft.idCardData ?? existing.idCardData,
    planDetailsData: draft.planDetailsData ?? existing.planDetailsData,
    aiChunks: draft.aiChunks?.length ? draft.aiChunks : existing.aiChunks,
    acknowledgementQuestions: draft.acknowledgementQuestions?.length
      ? draft.acknowledgementQuestions
      : existing.acknowledgementQuestions,
    productQuestionnaires: draft.productQuestionnaires?.questions?.length
      ? draft.productQuestionnaires
      : existing.productQuestionnaires,
    requiredASA: draft.requiredASA ?? existing.requiredASA,
    trainingConfig: draft.trainingConfig ?? existing.trainingConfig,
    medicalNeedsLinksConfig: draft.medicalNeedsLinksConfig ?? existing.medicalNeedsLinksConfig,
    productImageUrl: existing.productImageUrl,
    productLogoUrl: existing.productLogoUrl,
    productDocumentUrl: existing.productDocumentUrl,
    productDocuments: existing.productDocuments,
  };
  return merged;
}
