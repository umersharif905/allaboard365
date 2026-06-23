const {
  normalizePan,
  mapValidatorTypeToDime,
  mapDisplayBrandToDime,
  getDimeCcBrandFromPan,
  getCardBrandOrNull
} = require('./dimeCardBrand');

describe('dimeCardBrand', () => {
  test('normalizePan strips non-digits', () => {
    expect(normalizePan('4111-1111-1111-1111')).toBe('4111111111111111');
    expect(normalizePan('')).toBe('');
  });

  test('mapValidatorTypeToDime maps known types', () => {
    expect(mapValidatorTypeToDime('visa')).toBe('Visa');
    expect(mapValidatorTypeToDime('mastercard')).toBe('MasterCard');
    expect(mapValidatorTypeToDime('american-express')).toBe('Amex');
    expect(mapValidatorTypeToDime('discover')).toBe('Discover');
    expect(mapValidatorTypeToDime('jcb')).toBe('JCB');
    expect(mapValidatorTypeToDime('diners-club')).toBe('Diners');
    expect(mapValidatorTypeToDime('unionpay')).toBeNull();
  });

  test('mapDisplayBrandToDime maps UI labels', () => {
    expect(mapDisplayBrandToDime('American Express')).toBe('Amex');
    expect(mapDisplayBrandToDime('amex')).toBe('Amex');
    expect(mapDisplayBrandToDime('Visa')).toBe('Visa');
  });

  test('Visa test PAN resolves to Visa', () => {
    const r = getDimeCcBrandFromPan('4111111111111111');
    expect(r.brand).toBe('Visa');
    expect(r.code).toBe('OK');
  });

  test('Amex test PAN resolves to Amex', () => {
    const r = getDimeCcBrandFromPan('378282246310005');
    expect(r.brand).toBe('Amex');
    expect(r.code).toBe('OK');
  });

  test('Mastercard test PAN', () => {
    const r = getDimeCcBrandFromPan('5555555555554444');
    expect(r.brand).toBe('MasterCard');
  });

  test('Discover test PAN', () => {
    const r = getDimeCcBrandFromPan('6011111111111117');
    expect(r.brand).toBe('Discover');
  });

  test('getCardBrandOrNull returns null for empty', () => {
    expect(getCardBrandOrNull('')).toBeNull();
  });

  test('unsupported network returns no DIME brand', () => {
    const r = getDimeCcBrandFromPan('6221260000000000');
    expect(r.code).toBe('UNSUPPORTED');
    expect(r.brand).toBeNull();
  });
});
