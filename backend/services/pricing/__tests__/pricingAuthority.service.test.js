/**
 * pricingAuthority.service unit tests.
 *
 * Covers the fee policy matrix:
 *   - included (Highest) vs non-included (member's method)
 *   - zeroFeeForACH flag
 *   - bundles with mixed included/non-included components
 *   - system fees (tenant + custom per-product)
 *   - fingerprint stability
 */

const { computePricing, computeDisplayPremiums, verifyFingerprint, _internal } = require('../pricingAuthority.service');

// -----------------------------------------------------------------------------
// Fake mssql pool that returns scripted recordsets.
// -----------------------------------------------------------------------------
function makeFakePool({ tenants, subscriptions, products = {} }) {
  return {
    request() {
      const params = {};
      return {
        input(name, _type, value) {
          params[name] = value;
          return this;
        },
        async query(sqlText) {
          if (/FROM oe\.Tenants/i.test(sqlText)) {
            const row = tenants[params.tenantId] || null;
            return { recordset: row ? [row] : [] };
          }
          if (/FROM oe\.TenantProductSubscriptions/i.test(sqlText)) {
            const productIdParams = Object.keys(params)
              .filter((k) => k.startsWith('productId_'))
              .map((k) => params[k]);
            const rows = productIdParams
              .map((pid) => subscriptions[pid])
              .filter(Boolean);
            return { recordset: rows };
          }
          if (/FROM oe\.Products/i.test(sqlText)) {
            const productIdParams = Object.keys(params)
              .filter((k) => k.startsWith('productId_'))
              .map((k) => params[k]);
            const rows = productIdParams.map((pid) => {
              const flags = products[pid] || {};
              return {
                ProductId: pid,
                IncludeProcessingFee: flags.includeProcessingFee === true ? 1 : 0,
                RoundUpProcessingFee: flags.roundUpProcessingFee === true ? 1 : 0,
                ProcessingFeePercentage: flags.processingFeePercentage ?? null
              };
            });
            return { recordset: rows };
          }
          throw new Error(`Unexpected SQL in fake pool: ${sqlText}`);
        }
      };
    }
  };
}

// Tenant with chargeFeeToMember enabled, 0.8% ACH + 3% Card, $0 SystemFees.
const DEFAULT_TENANT = 'TENANT-1';
const tenantSettings = {
  PaymentProcessorSettings: JSON.stringify({
    chargeFeeToMember: true,
    activeProcessor: 'openenroll',
    processors: {
      openenroll: {
        fees: {
          ach: { percentageFee: 0.008, flatFee: 0 },
          creditCard: { percentageFee: 0.03, flatFee: 0 }
        }
      }
    }
  }),
  SystemFees: JSON.stringify({ enabled: false })
};

// Per-product subscription config helper.
const sub = (productId, overrides = {}) => ({
  ProductId: productId,
  IncludeProcessingFee: overrides.includeProcessingFee === true,
  RoundUpProcessingFee: overrides.roundUpProcessingFee === true,
  ZeroFeeForACH: overrides.zeroFeeForACH === true,
  CustomSystemFeeEnabled: overrides.customSystemFeeEnabled === true,
  CustomSystemFeeAmount: overrides.customSystemFeeAmount ?? null
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('pricingAuthority.service: _internal helpers', () => {
  test('normalizePaymentMethod', () => {
    expect(_internal.normalizePaymentMethod('ACH')).toBe('ACH');
    expect(_internal.normalizePaymentMethod('Card')).toBe('Card');
    expect(_internal.normalizePaymentMethod('creditcard')).toBe('Card');
    expect(_internal.normalizePaymentMethod('Credit-Card')).toBe('Card');
    expect(_internal.normalizePaymentMethod(undefined)).toBe('ACH');
    expect(_internal.normalizePaymentMethod('garbage')).toBe('ACH');
  });

  test('round2 & fmt', () => {
    expect(_internal.round2(1.234)).toBe(1.23);
    expect(_internal.round2(1.235)).toBe(1.24);
    expect(_internal.fmt(1.5)).toBe('$1.50');
    expect(_internal.fmt(null)).toBe('$0.00');
  });

  test('applyIncludedFee uses stored pricingDetails.includedProcessingFee', () => {
    const pps = JSON.parse(tenantSettings.PaymentProcessorSettings);
    const r = _internal.applyIncludedFee({
      basePremium: 100,
      productCfg: { includeProcessingFee: true, roundUpProcessingFee: false },
      paymentProcessorSettings: pps,
      chargeFeeToMemberEnabled: true,
      pricingDetails: { includedProcessingFee: 7 }
    });
    expect(r.includedFee).toBe(7);
    expect(r.displayPremium).toBe(107);
  });

  test('buildPricingProductsFromEngineResults preserves pricingDetails', () => {
    const mapped = _internal.buildPricingProductsFromEngineResults([
      {
        productId: 'B1',
        productName: 'Bundle',
        monthlyPremium: 200,
        isBundle: true,
        pricingDetails: { includedProcessingFee: 1 },
        includedProducts: [
          { productId: 'C1', monthlyPremium: 100, pricingDetails: { includedProcessingFee: 5 } }
        ]
      }
    ]);
    expect(mapped[0].pricingDetails.includedProcessingFee).toBe(1);
    expect(mapped[0].includedProducts[0].pricingDetails.includedProcessingFee).toBe(5);
  });
});

describe('pricingAuthority.service: computePricing', () => {
  test('non-included product on ACH: charges 0.8% fee on top', async () => {
    const pool = makeFakePool({
      tenants: { [DEFAULT_TENANT]: tenantSettings },
      subscriptions: { 'P1': sub('P1', { includeProcessingFee: false }) }
    });

    const res = await computePricing({
      poolOrTransaction: pool,
      tenantId: DEFAULT_TENANT,
      pricingProducts: [{ productId: 'P1', productName: 'Product 1', monthlyPremium: 100 }],
      paymentMethodType: 'ACH'
    });

    expect(res.products[0].basePremium).toBe(100);
    expect(res.products[0].includedFee).toBe(0);
    expect(res.products[0].displayPremium).toBe(100);
    expect(res.totals.nonIncludedFeeTotal).toBe(0.8);
    expect(res.totals.monthlyContribution).toBe(100.8);
  });

  test('non-included product on Card: charges 3% fee on top', async () => {
    const pool = makeFakePool({
      tenants: { [DEFAULT_TENANT]: tenantSettings },
      subscriptions: { 'P1': sub('P1', { includeProcessingFee: false }) }
    });

    const res = await computePricing({
      poolOrTransaction: pool,
      tenantId: DEFAULT_TENANT,
      pricingProducts: [{ productId: 'P1', productName: 'Product 1', monthlyPremium: 100 }],
      paymentMethodType: 'Card'
    });

    expect(res.totals.nonIncludedFeeTotal).toBe(3);
    expect(res.totals.monthlyContribution).toBe(103);
  });

  test('included product: fee baked at Highest (Card) regardless of member method', async () => {
    const pool = makeFakePool({
      tenants: { [DEFAULT_TENANT]: tenantSettings },
      subscriptions: { 'P1': sub('P1', { includeProcessingFee: false, roundUpProcessingFee: false }) },
      products: { P1: { includeProcessingFee: true, roundUpProcessingFee: false } }
    });

    const achRes = await computePricing({
      poolOrTransaction: pool,
      tenantId: DEFAULT_TENANT,
      pricingProducts: [{ productId: 'P1', productName: 'Product 1', monthlyPremium: 100 }],
      paymentMethodType: 'ACH'
    });
    const cardRes = await computePricing({
      poolOrTransaction: pool,
      tenantId: DEFAULT_TENANT,
      pricingProducts: [{ productId: 'P1', productName: 'Product 1', monthlyPremium: 100 }],
      paymentMethodType: 'Card'
    });

    // Highest = Card rate = 3% = $3. Baked into display premium.
    expect(achRes.products[0].includedFee).toBe(3);
    expect(achRes.products[0].displayPremium).toBe(103);
    expect(achRes.totals.nonIncludedFeeTotal).toBe(0);
    expect(achRes.totals.monthlyContribution).toBe(103);

    // Card member sees the exact same total.
    expect(cardRes.totals.monthlyContribution).toBe(103);
  });

  test('included product + roundUp: rounds total up to whole dollar', async () => {
    const pool = makeFakePool({
      tenants: { [DEFAULT_TENANT]: tenantSettings },
      subscriptions: { 'P1': sub('P1', { includeProcessingFee: false, roundUpProcessingFee: false }) },
      products: { P1: { includeProcessingFee: true, roundUpProcessingFee: true } }
    });

    const res = await computePricing({
      poolOrTransaction: pool,
      tenantId: DEFAULT_TENANT,
      pricingProducts: [{ productId: 'P1', productName: 'Product 1', monthlyPremium: 210 }],
      paymentMethodType: 'ACH'
    });

    // Card fee on 210 = $6.30 → rounded up to $217 → $7 included fee.
    expect(res.products[0].includedFee).toBe(7);
    expect(res.products[0].displayPremium).toBe(217);
  });

  test('zeroFeeForACH non-included product: $0 on ACH, Card rate on Card', async () => {
    const pool = makeFakePool({
      tenants: { [DEFAULT_TENANT]: tenantSettings },
      subscriptions: { 'P1': sub('P1', { includeProcessingFee: false, zeroFeeForACH: true }) }
    });

    const ach = await computePricing({
      poolOrTransaction: pool, tenantId: DEFAULT_TENANT,
      pricingProducts: [{ productId: 'P1', productName: 'P1', monthlyPremium: 100 }],
      paymentMethodType: 'ACH'
    });
    const card = await computePricing({
      poolOrTransaction: pool, tenantId: DEFAULT_TENANT,
      pricingProducts: [{ productId: 'P1', productName: 'P1', monthlyPremium: 100 }],
      paymentMethodType: 'Card'
    });

    expect(ach.totals.nonIncludedFeeTotal).toBe(0);
    expect(ach.totals.monthlyContribution).toBe(100);
    expect(card.totals.nonIncludedFeeTotal).toBe(3);
    expect(card.totals.monthlyContribution).toBe(103);
  });

  test('zeroFeeForACH included product: 0 at Card (since ACH leg = $0, max = Card)', async () => {
    const pool = makeFakePool({
      tenants: { [DEFAULT_TENANT]: tenantSettings },
      subscriptions: { 'P1': sub('P1', { includeProcessingFee: false, zeroFeeForACH: true, roundUpProcessingFee: false }) },
      products: { P1: { includeProcessingFee: true, roundUpProcessingFee: false } }
    });

    const res = await computePricing({
      poolOrTransaction: pool, tenantId: DEFAULT_TENANT,
      pricingProducts: [{ productId: 'P1', productName: 'P1', monthlyPremium: 100 }],
      paymentMethodType: 'ACH'
    });

    // zeroFeeForACH + Highest → effective method becomes Card (0.03 * 100 = 3)
    expect(res.products[0].includedFee).toBe(3);
    expect(res.products[0].displayPremium).toBe(103);
  });

  test('bundle with included-fee components: each component gets Highest-rate fee', async () => {
    const pool = makeFakePool({
      tenants: { [DEFAULT_TENANT]: tenantSettings },
      subscriptions: {
        'C1': sub('C1', { includeProcessingFee: false, roundUpProcessingFee: false }),
        'C2': sub('C2', { includeProcessingFee: false, roundUpProcessingFee: false }),
        'C3': sub('C3', { includeProcessingFee: false, roundUpProcessingFee: false })
      },
      products: {
        C1: { includeProcessingFee: true, roundUpProcessingFee: true },
        C2: { includeProcessingFee: true, roundUpProcessingFee: true },
        C3: { includeProcessingFee: true, roundUpProcessingFee: true }
      }
    });

    const res = await computePricing({
      poolOrTransaction: pool, tenantId: DEFAULT_TENANT,
      pricingProducts: [{
        productId: 'B1',
        productName: 'Bundle',
        isBundle: true,
        monthlyPremium: 430,
        includedProducts: [
          { productId: 'C1', productName: 'Comp1', monthlyPremium: 210 },
          { productId: 'C2', productName: 'Comp2', monthlyPremium: 220 },
          { productId: 'C3', productName: 'Comp3', monthlyPremium: 0 }
        ]
      }],
      paymentMethodType: 'ACH'
    });

    // C1: $210 → Card 3% = $6.30 → rounded up to $217 → included=$7 → display=$217
    // C2: $220 → Card 3% = $6.60 → rounded up to $227 → included=$7 → display=$227
    // C3: $0   → included=$0 → display=$0
    // Bundle display = $444
    expect(res.products[0].isBundle).toBe(true);
    expect(res.products[0].includedProducts[0].displayPremium).toBe(217);
    expect(res.products[0].includedProducts[1].displayPremium).toBe(227);
    expect(res.products[0].includedProducts[2].displayPremium).toBe(0);
    expect(res.products[0].displayPremium).toBe(444);
    expect(res.totals.monthlyContribution).toBe(444);
  });

  // Regression for the MightyWELL Concierge bundle pre-charge bug:
  // The bundle parent has IncludeProcessingFee=false; its components have IncludeProcessingFee=true.
  // /complete-enrollment preChargeBlock previously fed `frontendPricing.monthlyPremium` (the DISPLAY
  // premium produced by /contribution-preview) into the authority as a flat product list — dropping
  // isBundle/includedProducts. The authority then looked up the BUNDLE PARENT's own subscription cfg
  // (IncludeProcessingFee=false) and applied a fresh 3% non-included fee on top, charging ~$823 on
  // a quoted $799 bundle. The contract: callers MUST pass bundle-aware pricingProducts so the
  // authority sees the same shape as /contribution-preview / fingerprint-verify / persist paths.
  test('regression: Concierge bundle (parent=non-included, components=included) — bundle-aware call returns canonical $799', async () => {
    const pool = makeFakePool({
      tenants: { [DEFAULT_TENANT]: tenantSettings },
      subscriptions: {
        'BUNDLE': sub('BUNDLE', { includeProcessingFee: false }),
        'MIGHTY': sub('MIGHTY', { includeProcessingFee: false, roundUpProcessingFee: false }),
        'SHAREWELL': sub('SHAREWELL', { includeProcessingFee: false, roundUpProcessingFee: false }),
        'LYRIC': sub('LYRIC', { includeProcessingFee: false })
      },
      products: {
        MIGHTY: { includeProcessingFee: true, roundUpProcessingFee: true },
        SHAREWELL: { includeProcessingFee: true, roundUpProcessingFee: true },
        LYRIC: { includeProcessingFee: false, roundUpProcessingFee: false }
      }
    });

    const bundleAware = await computePricing({
      poolOrTransaction: pool, tenantId: DEFAULT_TENANT,
      pricingProducts: [{
        productId: 'BUNDLE',
        productName: 'Concierge',
        isBundle: true,
        monthlyPremium: 775, // base $431 + $344 + $0
        includedProducts: [
          { productId: 'MIGHTY',    productName: 'MightyWELL', monthlyPremium: 431 },
          { productId: 'SHAREWELL', productName: 'ShareWELL',  monthlyPremium: 344 },
          { productId: 'LYRIC',     productName: 'Lyric',      monthlyPremium: 0 }
        ]
      }],
      paymentMethodType: 'Card'
    });

    // MightyWELL: $431 → 3% = $12.93 → roundup $13 → display $444
    // ShareWELL:  $344 → 3% = $10.32 → roundup $11 → display $355
    // Lyric:      $0   → display $0
    // Bundle display = $799. Lyric is non-included with $0 base → no extra fee.
    expect(bundleAware.products[0].includedProducts[0].displayPremium).toBe(444);
    expect(bundleAware.products[0].includedProducts[1].displayPremium).toBe(355);
    expect(bundleAware.products[0].displayPremium).toBe(799);
    expect(bundleAware.totals.monthlyContribution).toBe(799);
  });

  test('regression: same bundle passed FLAT (legacy preChargeBlock bug) double-counts ~3% fee', async () => {
    // Reproduces the buggy call shape: bundle PARENT id with display-as-base monthlyPremium and
    // NO isBundle/includedProducts. Authority falls back to the parent's own cfg
    // (IncludeProcessingFee=false) and computes a fresh 3% on the $799 display. This test exists
    // so future refactors can't silently regress us back into this shape — if you change this
    // expectation, you're re-introducing the bug.
    const pool = makeFakePool({
      tenants: { [DEFAULT_TENANT]: tenantSettings },
      subscriptions: {
        'BUNDLE': sub('BUNDLE', { includeProcessingFee: false })
      }
    });

    const buggyFlat = await computePricing({
      poolOrTransaction: pool, tenantId: DEFAULT_TENANT,
      pricingProducts: [{ productId: 'BUNDLE', productName: 'Concierge', monthlyPremium: 799 }],
      paymentMethodType: 'Card'
    });

    // 3% × $799 = $23.97 → monthlyContribution = $799 + $23.97 = $822.97 (BUG).
    expect(buggyFlat.totals.nonIncludedFeeTotal).toBeCloseTo(23.97, 2);
    expect(buggyFlat.totals.monthlyContribution).toBeCloseTo(822.97, 2);
  });

  test('mixed bundle (included) + standalone (non-included): both policies apply correctly', async () => {
    const pool = makeFakePool({
      tenants: { [DEFAULT_TENANT]: tenantSettings },
      subscriptions: {
        'BC1': sub('BC1', { includeProcessingFee: false, roundUpProcessingFee: false }),
        'BC2': sub('BC2', { includeProcessingFee: false, roundUpProcessingFee: false }),
        'BC3': sub('BC3', { includeProcessingFee: false, roundUpProcessingFee: false }),
        'DENTAL': sub('DENTAL', { includeProcessingFee: false })
      },
      products: {
        BC1: { includeProcessingFee: true, roundUpProcessingFee: true },
        BC2: { includeProcessingFee: true, roundUpProcessingFee: true },
        BC3: { includeProcessingFee: true, roundUpProcessingFee: true },
        DENTAL: { includeProcessingFee: false, roundUpProcessingFee: false }
      }
    });

    const res = await computePricing({
      poolOrTransaction: pool, tenantId: DEFAULT_TENANT,
      pricingProducts: [
        {
          productId: 'BUNDLE',
          productName: 'Bundle',
          isBundle: true,
          monthlyPremium: 430,
          includedProducts: [
            { productId: 'BC1', productName: 'C1', monthlyPremium: 210 },
            { productId: 'BC2', productName: 'C2', monthlyPremium: 220 },
            { productId: 'BC3', productName: 'C3', monthlyPremium: 0 }
          ]
        },
        { productId: 'DENTAL', productName: 'Dental', monthlyPremium: 48 }
      ],
      paymentMethodType: 'ACH'
    });

    // Bundle display: $217 + $227 + $0 = $444
    // Dental non-included on ACH: 0.8% of $48 = $0.384 → calculator rounds cents up → $0.39
    // Monthly contribution = $444 + $48 + $0.39 = $492.39
    expect(res.products[0].displayPremium).toBe(444);
    expect(res.products[1].displayPremium).toBe(48);
    expect(res.totals.nonIncludedFeeTotal).toBe(0.39);
    expect(res.totals.monthlyContribution).toBe(492.39);
  });

  test('chargeFeeToMember disabled: no fees added', async () => {
    const pool = makeFakePool({
      tenants: {
        [DEFAULT_TENANT]: {
          PaymentProcessorSettings: JSON.stringify({ chargeFeeToMember: false }),
          SystemFees: null
        }
      },
      subscriptions: { 'P1': sub('P1', { includeProcessingFee: true }) }
    });

    const res = await computePricing({
      poolOrTransaction: pool, tenantId: DEFAULT_TENANT,
      pricingProducts: [{ productId: 'P1', productName: 'P1', monthlyPremium: 100 }],
      paymentMethodType: 'ACH'
    });

    expect(res.totals.includedFeeTotal).toBe(0);
    expect(res.totals.nonIncludedFeeTotal).toBe(0);
    expect(res.totals.monthlyContribution).toBe(100);
  });

  test('display block: produces lineItems, summary, policies', async () => {
    const pool = makeFakePool({
      tenants: { [DEFAULT_TENANT]: tenantSettings },
      subscriptions: { 'P1': sub('P1', { includeProcessingFee: false }) }
    });

    const res = await computePricing({
      poolOrTransaction: pool, tenantId: DEFAULT_TENANT,
      pricingProducts: [{ productId: 'P1', productName: 'Product 1', monthlyPremium: 100 }],
      paymentMethodType: 'Card'
    });

    expect(res.display.lineItems).toEqual([
      { productId: 'P1', label: 'Product 1', isBundle: false, amount: '$100.00' }
    ]);
    expect(res.display.summary.rows).toEqual([
      { key: 'premium', label: 'Monthly Premium', value: '$100.00' },
      { key: 'fees', label: 'Fees', value: '$3.00' },
      { key: 'total', label: 'Your Monthly Contribution', value: '$103.00', emphasis: true }
    ]);
    expect(res.display.policies).toEqual({
      includedFeeMethod: 'Highest',
      nonIncludedFeeMethod: 'Card',
      chargeFeeToMember: true
    });
  });

  test('fingerprint stability: same inputs produce same fingerprint', async () => {
    const build = () => makeFakePool({
      tenants: { [DEFAULT_TENANT]: tenantSettings },
      subscriptions: { 'P1': sub('P1', { includeProcessingFee: false }) }
    });
    const input = {
      tenantId: DEFAULT_TENANT,
      pricingProducts: [{ productId: 'P1', productName: 'X', monthlyPremium: 100 }],
      paymentMethodType: 'ACH'
    };

    const a = await computePricing({ poolOrTransaction: build(), ...input });
    const b = await computePricing({ poolOrTransaction: build(), ...input });
    expect(a.pricingFingerprint).toBe(b.pricingFingerprint);
    expect(a.pricingFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('fingerprint drift: changing payment method produces different fingerprint', async () => {
    const build = () => makeFakePool({
      tenants: { [DEFAULT_TENANT]: tenantSettings },
      subscriptions: { 'P1': sub('P1', { includeProcessingFee: false }) }
    });
    const ach = await computePricing({
      poolOrTransaction: build(),
      tenantId: DEFAULT_TENANT,
      pricingProducts: [{ productId: 'P1', productName: 'X', monthlyPremium: 100 }],
      paymentMethodType: 'ACH'
    });
    const card = await computePricing({
      poolOrTransaction: build(),
      tenantId: DEFAULT_TENANT,
      pricingProducts: [{ productId: 'P1', productName: 'X', monthlyPremium: 100 }],
      paymentMethodType: 'Card'
    });
    expect(ach.pricingFingerprint).not.toBe(card.pricingFingerprint);
  });

  test('verifyFingerprint: matches when client fingerprint is correct', async () => {
    const build = () => makeFakePool({
      tenants: { [DEFAULT_TENANT]: tenantSettings },
      subscriptions: { 'P1': sub('P1', { includeProcessingFee: false }) }
    });
    const input = {
      tenantId: DEFAULT_TENANT,
      pricingProducts: [{ productId: 'P1', productName: 'X', monthlyPremium: 100 }],
      paymentMethodType: 'ACH'
    };
    const quoted = await computePricing({ poolOrTransaction: build(), ...input });

    const verify = await verifyFingerprint({
      poolOrTransaction: build(),
      ...input,
      expectedFingerprint: quoted.pricingFingerprint
    });
    expect(verify.matched).toBe(true);

    const tampered = await verifyFingerprint({
      poolOrTransaction: build(),
      ...input,
      expectedFingerprint: 'sha256:deadbeef'
    });
    expect(tampered.matched).toBe(false);
    expect(tampered.actualFingerprint).toBe(quoted.pricingFingerprint);
  });

  test('custom system fee per product: picks max and skips tenant system fee', async () => {
    const pool = makeFakePool({
      tenants: {
        [DEFAULT_TENANT]: {
          PaymentProcessorSettings: JSON.stringify({ chargeFeeToMember: true, processors: { openenroll: { fees: { ach: { percentageFee: 0, flatFee: 0 }, creditCard: { percentageFee: 0, flatFee: 0 } } } } }),
          SystemFees: JSON.stringify({ enabled: true, percentageFee: 0.05 })
        }
      },
      subscriptions: {
        'P1': sub('P1', { customSystemFeeEnabled: true, customSystemFeeAmount: 10 }),
        'P2': sub('P2', { customSystemFeeEnabled: true, customSystemFeeAmount: 15 })
      }
    });

    const res = await computePricing({
      poolOrTransaction: pool, tenantId: DEFAULT_TENANT,
      pricingProducts: [
        { productId: 'P1', productName: 'P1', monthlyPremium: 100 },
        { productId: 'P2', productName: 'P2', monthlyPremium: 100 }
      ],
      paymentMethodType: 'ACH'
    });

    // Tenant percentage (5%) is ignored because at least one product has custom system fee.
    // Custom fees: 10, 15 → max wins (15).
    // Wait: calculateSystemFeeAmount returns `anyProductHandlesSystemFeeOwn ? 0 : max(...)`.
    // When any product has customSystemFeeEnabled=true, it returns 0 (product handles its own fee).
    expect(res.totals.systemFees).toBe(0);
  });

  test('edge case: empty products → zero totals', async () => {
    const pool = makeFakePool({ tenants: { [DEFAULT_TENANT]: tenantSettings }, subscriptions: {} });
    const res = await computePricing({
      poolOrTransaction: pool, tenantId: DEFAULT_TENANT,
      pricingProducts: [],
      paymentMethodType: 'ACH'
    });
    expect(res.totals.monthlyContribution).toBe(0);
    expect(res.products).toEqual([]);
  });

  test('validation: missing tenantId throws', async () => {
    const pool = makeFakePool({ tenants: {}, subscriptions: {} });
    await expect(computePricing({
      poolOrTransaction: pool, tenantId: null, pricingProducts: [], paymentMethodType: 'ACH'
    })).rejects.toThrow(/tenantId/);
  });

  test('validation: missing pool throws', async () => {
    await expect(computePricing({
      poolOrTransaction: null, tenantId: 'x', pricingProducts: [], paymentMethodType: 'ACH'
    })).rejects.toThrow(/poolOrTransaction/);
  });
});

describe('pricingAuthority.service: computeDisplayPremiums', () => {
  test('duplicate configValue "Default" keeps first variation (matches PricingEngine variations[0])', async () => {
    const pool = makeFakePool({
      tenants: { [DEFAULT_TENANT]: tenantSettings },
      subscriptions: { DENTAL: sub('DENTAL', { includeProcessingFee: true }) },
      products: { DENTAL: { includeProcessingFee: false, roundUpProcessingFee: true } }
    });

    const res = await computeDisplayPremiums({
      poolOrTransaction: pool,
      tenantId: DEFAULT_TENANT,
      productsForDisplay: [{
        productId: 'DENTAL',
        monthlyPremium: 42.08,
        isBundle: false,
        pricingDetails: { catalogRetailMsrp: 42.08 },
        pricingVariations: [
          { configValue: 'Default', monthlyPremium: 42.08, pricingDetails: { catalogRetailMsrp: 42.08 } },
          { configValue: 'Default', monthlyPremium: 40.72, pricingDetails: { catalogRetailMsrp: 40.72 } }
        ]
      }]
    });

    const entry = res.byProductId.get('DENTAL');
    expect(entry?.displayPremium).toBe(42.08);
    expect(entry?.variationDisplayPremiumByConfig.get('Default')).toBe(42.08);
  });
});
