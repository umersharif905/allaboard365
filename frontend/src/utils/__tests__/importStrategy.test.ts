import { describe, expect, it } from 'vitest';
import { evalProductMatch, previewKeysForRow } from '../importStrategy';
import { normalizeVendorImportRules } from '../vendorImportRulesNormalize';

describe('importStrategy', () => {
  it('evalProductMatch fieldEquals', () => {
    expect(
      evalProductMatch({ Status: 'ACTIVE' }, { mode: 'fieldEquals', field: 'Status', values: ['ACTIVE'] }),
    ).toBe(true);
    expect(
      evalProductMatch({ Status: 'inactive' }, { mode: 'fieldEquals', field: 'Status', values: ['ACTIVE'] }),
    ).toBe(false);
  });

  it('previewKeysForRow returns multiple products', () => {
    const rules = normalizeVendorImportRules({
      products: [
        {
          id: 'a',
          label: 'Med',
          targetProductId: null,
          match: { mode: 'fieldNonBlank', field: 'Medical Option' },
          keyStrategy: { type: 'planCode', strategies: ['planCode'], planCodeFields: 'Medical Option' },
        },
        {
          id: 'b',
          label: 'Den',
          targetProductId: null,
          match: { mode: 'fieldNonBlank', field: 'Dental Option' },
          keyStrategy: { type: 'planCode', strategies: ['planCode'], planCodeFields: 'Dental Option' },
        },
      ],
    });
    const keys = previewKeysForRow(
      { 'Medical Option': 'Plan A', 'Dental Option': 'Plan B' },
      rules,
    );
    expect(keys.length).toBe(2);
  });
});
