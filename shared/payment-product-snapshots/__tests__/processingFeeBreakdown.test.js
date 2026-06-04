'use strict';

const {
  resolveProcessingFeeTotalFromParts,
  n2
} = require('../index');

describe('payment-product-snapshots processing fee breakdown', () => {
  test('resolveProcessingFeeTotalFromParts sums remainder + included (post-backfill)', () => {
    const r = resolveProcessingFeeTotalFromParts(10.25, 3.5);
    expect(r.includedOnProducts).toBe(10.25);
    expect(r.remainderOnFeeRow).toBe(3.5);
    expect(r.total).toBe(13.75);
    expect(r.isLegacyFullPpfRow).toBe(false);
  });

  test('resolveProcessingFeeTotalFromParts legacy shim when PPF row equals included (flat portfolio)', () => {
    const r = resolveProcessingFeeTotalFromParts(10.25, 10.25);
    expect(r.total).toBe(10.25);
    expect(r.isLegacyFullPpfRow).toBe(true);
  });

  test('resolveProcessingFeeTotalFromParts legacy full row when remainder embeds included allocation', () => {
    const r = resolveProcessingFeeTotalFromParts(2.7, 10.84);
    expect(r.total).toBe(10.84);
    expect(r.isLegacyFullPpfRow).toBe(true);
  });

  test('resolveProcessingFeeTotalFromParts post-backfill remainder row', () => {
    const r = resolveProcessingFeeTotalFromParts(2.7, 8.14);
    expect(r.total).toBe(10.84);
    expect(r.isLegacyFullPpfRow).toBe(false);
  });

  test('resolveProcessingFeeTotalFromParts all-included household (no PPF row)', () => {
    const r = resolveProcessingFeeTotalFromParts(6.98, 0);
    expect(r.total).toBe(6.98);
    expect(r.isLegacyFullPpfRow).toBe(false);
  });

  test('n2 rounds to cents', () => {
    expect(n2(10.256)).toBe(10.26);
  });
});
