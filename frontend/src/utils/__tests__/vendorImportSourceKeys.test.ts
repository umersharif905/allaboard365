import { describe, expect, it } from 'vitest';
import {
  filterSourceKeysForImportRules,
  sourceKeyIncludedByRules,
  staleSourceKeysForImportRules,
} from '../vendorImportSourceKeys';
import type { VendorImportRules } from '../../types/vendor/vendorImportRules.types';

const alignRules: VendorImportRules = {
  tobacco: {
    columns: ['Tobacco Surcharge'],
    yesValues: ['100'],
    yesWhenNumericGreaterThan: 0,
    yesTextPatterns: [],
  },
  planKey: {
    tierUaSuffixRegex: '(\\d{3,6})(EE|ES|EC|EF)$',
    uaRelabel: [{ from: '3000', to: '2500' }],
    sourceKeyIncludeRegex: '^11321_AH',
  },
  productMapping: {
    defaultProductNameContains: 'Essential',
    planCodePrefixes: [],
  },
};

describe('vendorImportSourceKeys', () => {
  it('filters keys when sourceKeyIncludeRegex is set', () => {
    const filtered = filterSourceKeysForImportRules(
      ['11321_AH3000ES', 'EF', 'ES_6000'],
      alignRules,
    );
    expect(filtered).toEqual(['11321_AH3000ES']);
  });

  it('passes all keys when no include regex', () => {
    const keys = ['EF', 'ES_6000'];
    expect(filterSourceKeysForImportRules(keys, null)).toEqual(keys);
  });

  it('detects stale saved keys outside include pattern', () => {
    expect(staleSourceKeysForImportRules(['EF_6000', '11321_AH1500EE'], alignRules)).toEqual([
      'EF_6000',
    ]);
  });

  it('matches include pattern per key', () => {
    expect(sourceKeyIncludedByRules('11321_AH3000EF', alignRules)).toBe(true);
    expect(sourceKeyIncludedByRules('EF_6000', alignRules)).toBe(false);
  });
});
