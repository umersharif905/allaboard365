'use strict';

const {
  mergeBundleTemplateShell,
  pickTemplatePrimaryIncludedProduct,
  mapProductRecordToWizardForm
} = require('../productWizardTemplate.service');

const MIGHTYWELL_COPAY_BUNDLE = {
  ProductId: '8941BEE7-FAD0-4027-B234-D3331603E053',
  Name: 'MightyWELL CoPay',
  Description: 'Short bundle marketing blurb for MightyWELL CoPay.',
  ProductType: 'Healthcare',
  IsBundle: true,
  SalesType: 'Individual',
  MinAge: 18,
  MaxAge: 65,
  EffectiveDateLogic: 'FirstOfMonth',
  VendorId: 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6',
  VendorName: 'ShareWELL Health/Partners',
  VendorGroupIdProductType: null,
  EligibilityIndividualVendorGroupId: null,
  ShowGroupIdOnIDCard: false
};

const MIGHTYWELL_INCLUDED = [
  {
    SortOrder: 1,
    ProductId: 'copay-ind',
    Name: 'Copay MEC (Individual)',
    Description: 'Copay MEC member-facing description with plan overview and benefits summary text.',
    ProductType: 'Healthcare',
    SalesType: 'Individual',
    MinAge: 18,
    MaxAge: 64,
    VendorId: 'apex-vendor-id',
    VendorName: 'APEX',
    VendorGroupIdProductType: '0',
    EligibilityIndividualVendorGroupId: '10543'
  },
  {
    SortOrder: 2,
    ProductId: 'essential',
    Name: 'Essential (ShareWELL)',
    VendorName: 'ShareWELL Health/Partners',
    MinAge: 18,
    MaxAge: 64
  },
  {
    SortOrder: 3,
    ProductId: 'lyric',
    Name: 'Lyric (Bundle)',
    VendorName: 'Lyric',
    MinAge: 18,
    MaxAge: 65
  }
];

describe('productWizardTemplate MightyWELL CoPay shell', () => {
  test('pickTemplatePrimaryIncludedProduct chooses copay row with vendor group config', () => {
    const pick = pickTemplatePrimaryIncludedProduct(MIGHTYWELL_INCLUDED);
    expect(pick.Name).toBe('Copay MEC (Individual)');
    expect(pick.VendorGroupIdProductType).toBe('0');
  });

  test('mergeBundleTemplateShell rolls copay vendor settings onto bundle template', () => {
    const merged = mergeBundleTemplateShell(MIGHTYWELL_COPAY_BUNDLE, MIGHTYWELL_INCLUDED);

    expect(merged.VendorId).toBe('apex-vendor-id');
    expect(merged.VendorName).toBe('APEX');
    expect(merged.VendorGroupIdProductType).toBe('0');
    expect(merged.EligibilityIndividualVendorGroupId).toBe('10543');
    expect(merged.SalesType).toBe('Individual');
    expect(merged.MinAge).toBe(18);
    expect(merged.MaxAge).toBe(64);
    expect(merged.EffectiveDateLogic).toBe('FirstOfMonth');
    expect(merged.Description).toContain('Copay MEC member-facing description');
  });

  test('mapProductRecordToWizardForm preserves vendor group id zero', () => {
    const merged = mergeBundleTemplateShell(MIGHTYWELL_COPAY_BUNDLE, MIGHTYWELL_INCLUDED);
    const form = mapProductRecordToWizardForm(merged);

    expect(form.vendorId).toBe('apex-vendor-id');
    expect(form.vendorGroupIdProductType).toBe('0');
    expect(form.eligibilityIndividualVendorGroupId).toBe('10543');
    expect(form.salesType).toBe('Individual');
    expect(form.maxAge).toBe(64);
    expect(form.description).toContain('Copay MEC member-facing description');
  });
});
