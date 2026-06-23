import { describe, it, expect } from 'vitest';
import {
  extractCalendarYyyyMmDd,
  filterProductPricingAsOf,
  isPricingRowValidOnYyyyMmDd,
  tierFingerprint,
  buildPricingWaveSelectOptions,
  resolvePricingAsOfYyyyMmDd
} from '../pricingAsOf';

describe('pricingAsOf', () => {
  it('extractCalendarYyyyMmDd parses ISO prefix', () => {
    expect(extractCalendarYyyyMmDd('2025-06-15T00:00:00.000Z')).toBe('2025-06-15');
  });

  it('isPricingRowValidOnYyyyMmDd matches PricingEngine window', () => {
    expect(
      isPricingRowValidOnYyyyMmDd(
        { EffectiveDate: '2025-01-01', TerminationDate: '2025-12-31' },
        '2025-06-01'
      )
    ).toBe(true);
    expect(
      isPricingRowValidOnYyyyMmDd(
        { EffectiveDate: '2025-01-01', TerminationDate: '2025-12-31' },
        '2024-12-31'
      )
    ).toBe(false);
    expect(
      isPricingRowValidOnYyyyMmDd(
        { EffectiveDate: '2025-01-01', TerminationDate: '2025-12-31' },
        '2026-01-01'
      )
    ).toBe(false);
    expect(
      isPricingRowValidOnYyyyMmDd({ EffectiveDate: '2025-01-01', TerminationDate: null }, '2026-01-01')
    ).toBe(true);
  });

  it('filterProductPricingAsOf keeps latest EffectiveDate per fingerprint', () => {
    const fp = tierFingerprint({
      ProductId: 'p1',
      TierType: 'EE',
      TobaccoStatus: 'N',
      MinAge: 18,
      MaxAge: 64,
      Label: 'Standard',
      ConfigValue1: ''
    });
    expect(fp.length).toBeGreaterThan(0);

    const rows = [
      {
        ProductId: 'p1',
        TierType: 'EE',
        TobaccoStatus: 'N',
        MinAge: 18,
        MaxAge: 64,
        Label: 'Standard',
        EffectiveDate: '2024-01-01',
        TerminationDate: null,
        ProductPricingId: 'aaa',
        ConfigValue1: ''
      },
      {
        ProductId: 'p1',
        TierType: 'EE',
        TobaccoStatus: 'N',
        MinAge: 18,
        MaxAge: 64,
        Label: 'Standard',
        EffectiveDate: '2025-01-01',
        TerminationDate: null,
        ProductPricingId: 'bbb',
        ConfigValue1: ''
      }
    ];
    const out = filterProductPricingAsOf(rows, '2025-06-01');
    expect(out).toHaveLength(1);
    expect(out[0].EffectiveDate).toBe('2025-01-01');
    expect(out[0].ProductPricingId).toBe('bbb');
  });

  it('filterProductPricingAsOf tie-breaks ProductPricingId when same effective', () => {
    const rows = [
      {
        ProductId: 'p1',
        TierType: 'EE',
        TobaccoStatus: 'N',
        MinAge: 18,
        MaxAge: 64,
        Label: 'Standard',
        EffectiveDate: '2025-01-01',
        TerminationDate: null,
        ProductPricingId: '11111111-1111-1111-1111-111111111111',
        ConfigValue1: ''
      },
      {
        ProductId: 'p1',
        TierType: 'EE',
        TobaccoStatus: 'N',
        MinAge: 18,
        MaxAge: 64,
        Label: 'Standard',
        EffectiveDate: '2025-01-01',
        TerminationDate: null,
        ProductPricingId: '22222222-2222-2222-2222-222222222222',
        ConfigValue1: ''
      }
    ];
    const out = filterProductPricingAsOf(rows, '2025-06-01');
    expect(out).toHaveLength(1);
    expect(out[0].ProductPricingId).toBe('22222222-2222-2222-2222-222222222222');
  });

  it('buildPricingWaveSelectOptions sorts newest effective first', () => {
    const opts = buildPricingWaveSelectOptions([
      { EffectiveDate: '2024-01-01', TerminationDate: '2024-12-31' },
      { EffectiveDate: '2025-01-01', TerminationDate: null }
    ]);
    expect(opts[0].value).toBe('2025-01-01');
    expect(opts[1].value).toBe('2024-01-01');
  });

  it('resolvePricingAsOfYyyyMmDd handles today and iso', () => {
    const t = resolvePricingAsOfYyyyMmDd('today');
    expect(/^\d{4}-\d{2}-\d{2}$/.test(t)).toBe(true);
    expect(resolvePricingAsOfYyyyMmDd('2025-03-15')).toBe('2025-03-15');
  });
});
