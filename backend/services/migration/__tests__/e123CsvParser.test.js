'use strict';

const {
  vendorBucket,
  resolveVendorAllocationBucket,
  deriveTierAllocations,
  isVendorCostActive,
  isMerchantOrProcessingFeeVendor
} = require('../e123CsvExport/csvParser');

describe('e123CsvParser vendor routing', () => {
  test('vendorBucket maps Sharewell to net and Lyric to override', () => {
    expect(vendorBucket('Sharewell', 'Product')).toBe('net');
    expect(vendorBucket('Sharewell Partners', 'Product')).toBe('override');
    expect(vendorBucket('Lyric', 'Product')).toBe('override');
    expect(vendorBucket('Apex', 'Product')).toBe('net');
    expect(vendorBucket('MWP Admin Vendor', 'Product')).toBe('override');
    expect(vendorBucket('Processor Fee', 'Processor Fee')).toBe('exclude');
    expect(vendorBucket('Merchant Fee', 'Product')).toBe('exclude');
  });

  test('isMerchantOrProcessingFeeVendor detects merchant and processor fees', () => {
    expect(isMerchantOrProcessingFeeVendor('Merchant Fee', 'Product')).toBe(true);
    expect(isMerchantOrProcessingFeeVendor('Sharewell', 'Processor Fee')).toBe(true);
    expect(isMerchantOrProcessingFeeVendor('Sharewell', 'Product')).toBe(false);
  });

  test('resolveVendorAllocationBucket remaps legacy other buckets', () => {
    expect(resolveVendorAllocationBucket({
      vendorName: 'Lyric',
      bucket: 'other',
      amount: 3.25
    })).toBe('override');
    expect(resolveVendorAllocationBucket({
      vendorName: 'Sharewell',
      bucket: 'other',
      amount: 20.48
    })).toBe('net');
    expect(resolveVendorAllocationBucket({
      vendorName: 'Apex',
      bucket: 'net',
      amount: 159.4
    })).toBe('net');
  });

  test('isVendorCostActive treats benefit-scoped Sharewell rows as active', () => {
    const { isVendorCostActive, isCurrentVendorRow } = require('../e123CsvExport/csvParser');
    const rawRow = {
      Label: 'Sharewell',
      'Agent ID': '782734',
      feeType: 'dollar',
      cost: '20.48',
      benefit_id: '9392',
      benefit_label: 'Member Only',
      includedPriceTypes: 'Product'
    };
    expect(isCurrentVendorRow(rawRow)).toBe(true);
    expect(isVendorCostActive({
      vendorName: 'Sharewell',
      vendorId: 782734,
      amount: 20.48,
      benefitId: 9392,
      benefitLabel: 'Member Only',
      priceTypes: 'Product',
      isCurrent: false
    })).toBe(true);
  });

  test('deriveTierAllocations attaches benefit-scoped Sharewell and flat Lyric fees', () => {
    const pricingRows = [{
      Type: 'Product',
      Price: '180',
      'Benefit Label': 'Member Only',
      'Benefit ID': '9392',
      'Member Age Minimum': '50',
      'Member Age Maximum': '64',
      'Display Start': '01/01/2025'
    }];
    const vendorRows = [{
      Label: 'Sharewell',
      'Agent ID': '782734',
      feeType: 'dollar',
      cost: '20.48',
      benefit_id: '9392',
      benefit_label: 'Member Only',
      minAge: '',
      maxAge: '',
      includedPriceTypes: 'Product',
      transactionCoverageStartDate: '01/01/2026'
    }, {
      Label: 'Lyric',
      'Agent ID': '883564',
      feeType: 'dollar',
      cost: '3.25',
      benefit_id: '',
      benefit_label: '',
      minAge: '',
      maxAge: '',
      includedPriceTypes: 'Product',
      transactionStartDate: '10/01/2025'
    }];

    const [tier] = deriveTierAllocations(pricingRows, vendorRows);
    expect(tier.netRate).toBe(20.48);
    expect(tier.overrideRate).toBe(3.25);
    expect(tier.commission).toBe(156.27);
    expect(tier.vendorBreakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ vendorName: 'Sharewell', bucket: 'net', amount: 20.48 }),
        expect.objectContaining({ vendorName: 'Lyric', bucket: 'override', amount: 3.25 })
      ])
    );
  });

  test('isVendorCostActive treats product-wide flat fees as active regardless of start date', () => {
    expect(isVendorCostActive({
      vendorName: 'Sharewell Partners',
      priceTypes: 'Product',
      transactionStart: '01/01/2026'
    })).toBe(true);
  });

  test('pickVendorRows prefers tier-scoped Sharewell over flat product fee', () => {
    const pricingRows = [{
      Type: 'Product',
      Price: '375',
      'Benefit Label': 'Member + Child(ren)',
      'Benefit ID': '9400',
      'Member Age Minimum': '18',
      'Member Age Maximum': '64',
      'Display Start': '03/01/2026'
    }];
    const vendorRows = [{
      Label: 'Sharewell',
      'Agent ID': '782734',
      feeType: 'dollar',
      cost: '65',
      benefit_id: '',
      benefit_label: '',
      minAge: '',
      maxAge: '',
      includedPriceTypes: 'Product'
    }, {
      Label: 'Sharewell',
      'Agent ID': '782734',
      feeType: 'dollar',
      cost: '343',
      benefit_id: '9400',
      benefit_label: 'Member + Child(ren)',
      minAge: '',
      maxAge: '',
      includedPriceTypes: 'Product',
      transactionCoverageStartDate: '01/01/2026'
    }, {
      Label: 'Sharewell Partners',
      'Agent ID': '782735',
      feeType: 'dollar',
      cost: '11.02',
      benefit_id: '',
      benefit_label: '',
      minAge: '',
      maxAge: '',
      includedPriceTypes: 'Product',
      transactionStartDate: '01/01/2026'
    }, {
      Label: 'Lyric',
      'Agent ID': '883564',
      feeType: 'dollar',
      cost: '3.25',
      benefit_id: '',
      benefit_label: '',
      minAge: '',
      maxAge: '',
      includedPriceTypes: 'Product',
      transactionStartDate: '10/01/2025'
    }];

    const [tier] = deriveTierAllocations(pricingRows, vendorRows);
    expect(tier.netRate).toBe(343);
    expect(tier.overrideRate).toBe(14.27);
    expect(tier.commission).toBe(17.73);
  });
});
