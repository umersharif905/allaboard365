'use strict';

const { sameProductId, normalizeProductId } = require('../productIdMatch');

describe('productIdMatch', () => {
  test('sameProductId ignores case and hyphens', () => {
    const a = '8941BEE7-FAD0-4027-B234-D3331603E053';
    const b = '{8941bee7-fad0-4027-b234-d3331603e053}';
    expect(normalizeProductId(a)).toBe(normalizeProductId(b));
    expect(sameProductId(a, b)).toBe(true);
  });

  test('sameProductId returns false for mismatched GUIDs', () => {
    expect(
      sameProductId('8941BEE7-FAD0-4027-B234-D3331603E053', '11111111-1111-1111-1111-111111111111')
    ).toBe(false);
  });
});
