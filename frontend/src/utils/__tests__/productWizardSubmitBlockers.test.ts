import { describe, expect, it } from 'vitest';
import { getProductWizardSubmitBlockers } from '../productWizardSubmitBlockers';
import type { ProductFormData } from '../../types/sysadmin/addproductswizard.types';

const okCtx = {
  dataReady: true,
  loading: false,
  pricingValidationErrors: false,
  pricingReviewRequired: false,
};

const minimalForm = {
  vendorId: 'v1',
  name: 'Test',
  productType: 'Medical',
  productOwnerId: 't1',
  requiredLicenses: ['Life'],
  pricingTiers: [{ id: '1', tierType: 'EE', label: 'EE', ageBands: [] }],
} as unknown as ProductFormData;

describe('productWizardSubmitBlockers', () => {
  it('returns no blockers when form is complete', () => {
    expect(getProductWizardSubmitBlockers(minimalForm, okCtx)).toEqual([]);
  });

  it('does not require product logo', () => {
    const blockers = getProductWizardSubmitBlockers(
      { ...minimalForm, productLogoUrl: '', productLogoFile: null } as ProductFormData,
      okCtx
    );
    expect(blockers.some((b) => /logo/i.test(b))).toBe(false);
  });

  it('lists missing vendor and pricing review', () => {
    const blockers = getProductWizardSubmitBlockers(
      { ...minimalForm, vendorId: '' } as ProductFormData,
      { ...okCtx, pricingReviewRequired: true }
    );
    expect(blockers.some((b) => /vendor/i.test(b))).toBe(true);
    expect(blockers.some((b) => /AI pricing/i.test(b))).toBe(true);
  });
});
