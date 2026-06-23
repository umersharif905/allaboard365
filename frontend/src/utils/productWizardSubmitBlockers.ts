import type { ProductFormData } from '../types/sysadmin/addproductswizard.types';

export type ProductWizardSubmitContext = {
  dataReady: boolean;
  loading: boolean;
  pricingValidationErrors: boolean;
  pricingReviewRequired: boolean;
};

/** Human-readable reasons Create/Update Product is disabled on the Review step. */
export function getProductWizardSubmitBlockers(
  formData: ProductFormData,
  ctx: ProductWizardSubmitContext
): string[] {
  const blockers: string[] = [];

  if (!ctx.dataReady) {
    blockers.push('Product data is still loading — wait a moment and try again.');
  }
  if (ctx.loading) {
    blockers.push('Save is already in progress.');
  }
  if (ctx.pricingReviewRequired) {
    blockers.push('Open the Pricing step to review AI pricing changes before saving.');
  }
  if (ctx.pricingValidationErrors) {
    blockers.push('Fix pricing validation errors on the Pricing step (overlapping age bands, missing tier type, etc.).');
  }
  if (!formData.vendorId) {
    blockers.push('Select a vendor (Step 1 — Vendor).');
  }
  if (!formData.name?.trim()) {
    blockers.push('Enter a product name (Step 2 — Details).');
  }
  if (!formData.productType) {
    blockers.push('Select a product type (Step 2 — Details).');
  }
  if (!formData.productOwnerId) {
    blockers.push('Select a product owner / tenant (Step 2 — Details).');
  }
  if (!formData.requiredLicenses?.length) {
    blockers.push('Select at least one required license (Step 3 — Licensing).');
  }
  if (!formData.pricingTiers?.length) {
    blockers.push('Add at least one pricing tier (Step 5 — Pricing).');
  } else if (formData.pricingTiers.some((t) => !t.tierType || t.tierType === 'N/A')) {
    blockers.push('Every pricing tier must have a tier type (Step 5 — Pricing).');
  }

  return blockers;
}

export function isProductWizardSubmitDisabled(
  formData: ProductFormData,
  ctx: ProductWizardSubmitContext
): boolean {
  return getProductWizardSubmitBlockers(formData, ctx).length > 0;
}
