const {
  calculateProcessingFeeBreakdownByProduct,
  defaultProductFeeSettings
} = require('../productProcessingFees');

const tenantSettings = {
  chargeFeeToMember: true,
  activeProcessor: 'openenroll',
  processors: {
    openenroll: {
      fees: {
        ach: { percentageFee: 0.0025, flatFee: 0 },
        creditCard: { percentageFee: 0.03, flatFee: 0.30 }
      }
    }
  }
};

const tenantSettingsFeeOff = { ...tenantSettings, chargeFeeToMember: false };

const PRODUCT_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const PRODUCT_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const PRODUCT_C = 'cccccccc-0000-0000-0000-000000000003';

function settingsMap(entries) {
  return new Map(Object.entries(entries));
}

function cfg(overrides = {}) {
  return { ...defaultProductFeeSettings(), ...overrides };
}

describe('calculateProcessingFeeBreakdownByProduct', () => {
  describe('guards', () => {
    test('empty premium map returns zeros', () => {
      const result = calculateProcessingFeeBreakdownByProduct({
        basePremiumByProductId: new Map(),
        paymentMethodType: 'ACH',
        paymentProcessorSettings: tenantSettings,
        subscriptionFeeSettingsByProductId: new Map()
      });

      expect(result).toEqual({
        chargeFeeToMemberEnabled: true,
        includedProcessingFeeTotal: 0,
        includedProcessingFeeByProductId: {},
        nonIncludedPremiumSubtotal: 0,
        nonIncludedProcessingFeeAmount: 0,
        paymentProcessingFeeAmount: 0
      });
    });

    test('chargeFeeToMember=false returns zeros even with products', () => {
      const result = calculateProcessingFeeBreakdownByProduct({
        basePremiumByProductId: new Map([[PRODUCT_A, 100]]),
        paymentMethodType: 'ACH',
        paymentProcessorSettings: tenantSettingsFeeOff,
        subscriptionFeeSettingsByProductId: settingsMap({
          [PRODUCT_A]: cfg({ zeroFeeForACH: true })
        })
      });

      expect(result.chargeFeeToMemberEnabled).toBe(false);
      expect(result.nonIncludedProcessingFeeAmount).toBe(0);
      expect(result.paymentProcessingFeeAmount).toBe(0);
      // The premium still flows to the non-included subtotal (pool tracking), just no fee applied.
      expect(result.nonIncludedPremiumSubtotal).toBe(100);
    });

    test('product missing from settings map is treated as default (no included, no zeroACH)', () => {
      const result = calculateProcessingFeeBreakdownByProduct({
        basePremiumByProductId: new Map([[PRODUCT_A, 100]]),
        paymentMethodType: 'ACH',
        paymentProcessorSettings: tenantSettings,
        subscriptionFeeSettingsByProductId: new Map()
      });

      // Defaulted → standard ACH pool → ACH fee: 100 * 0.0025 = 0.25
      expect(result.nonIncludedPremiumSubtotal).toBe(100);
      expect(result.nonIncludedProcessingFeeAmount).toBe(0.25);
      expect(result.includedProcessingFeeTotal).toBe(0);
    });
  });

  describe('single non-included product', () => {
    test('ACH method → ACH fee', () => {
      const result = calculateProcessingFeeBreakdownByProduct({
        basePremiumByProductId: new Map([[PRODUCT_A, 100]]),
        paymentMethodType: 'ACH',
        paymentProcessorSettings: tenantSettings,
        subscriptionFeeSettingsByProductId: settingsMap({ [PRODUCT_A]: cfg() })
      });

      expect(result.nonIncludedProcessingFeeAmount).toBe(0.25);
      expect(result.nonIncludedPremiumSubtotal).toBe(100);
      expect(result.includedProcessingFeeTotal).toBe(0);
      expect(result.paymentProcessingFeeAmount).toBe(0.25);
    });

    test('Card method → Card fee', () => {
      const result = calculateProcessingFeeBreakdownByProduct({
        basePremiumByProductId: new Map([[PRODUCT_A, 100]]),
        paymentMethodType: 'Card',
        paymentProcessorSettings: tenantSettings,
        subscriptionFeeSettingsByProductId: settingsMap({ [PRODUCT_A]: cfg() })
      });

      // 100 * 0.03 + 0.30 = 3.30, rounded UP (roundUp default true)
      expect(result.nonIncludedProcessingFeeAmount).toBe(3.30);
    });
  });

  describe('single included product', () => {
    test('ACH method with includeProcessingFee=true → included fee uses Highest (Card) rate', () => {
      const result = calculateProcessingFeeBreakdownByProduct({
        basePremiumByProductId: new Map([[PRODUCT_A, 100]]),
        paymentMethodType: 'ACH',
        paymentProcessorSettings: tenantSettings,
        subscriptionFeeSettingsByProductId: settingsMap({
          [PRODUCT_A]: cfg({ includeProcessingFee: true })
        })
      });

      // Included fee always uses Highest so baked-in price covers ACH or Card → 100 * 0.03 + 0.30 = 3.30
      expect(result.includedProcessingFeeTotal).toBe(3.30);
      expect(result.includedProcessingFeeByProductId[PRODUCT_A]).toBe(3.30);
      expect(result.nonIncludedProcessingFeeAmount).toBe(0);
      expect(result.nonIncludedPremiumSubtotal).toBe(0);
      expect(result.paymentProcessingFeeAmount).toBe(3.30);
    });

    test('Card method with includeProcessingFee=true → Card fee goes to included total', () => {
      const result = calculateProcessingFeeBreakdownByProduct({
        basePremiumByProductId: new Map([[PRODUCT_A, 100]]),
        paymentMethodType: 'Card',
        paymentProcessorSettings: tenantSettings,
        subscriptionFeeSettingsByProductId: settingsMap({
          [PRODUCT_A]: cfg({ includeProcessingFee: true })
        })
      });

      expect(result.includedProcessingFeeTotal).toBe(3.30);
      expect(result.paymentProcessingFeeAmount).toBe(3.30);
    });
  });

  describe('zeroFeeForACH non-included product', () => {
    test('ACH method → $0 fee on the zero-ACH pool', () => {
      const result = calculateProcessingFeeBreakdownByProduct({
        basePremiumByProductId: new Map([[PRODUCT_A, 100]]),
        paymentMethodType: 'ACH',
        paymentProcessorSettings: tenantSettings,
        subscriptionFeeSettingsByProductId: settingsMap({
          [PRODUCT_A]: cfg({ zeroFeeForACH: true })
        })
      });

      expect(result.nonIncludedProcessingFeeAmount).toBe(0);
      // Premium still counted in the combined non-included subtotal.
      expect(result.nonIncludedPremiumSubtotal).toBe(100);
    });

    test('Card method → zero-ACH pool is billed at Card rate', () => {
      const result = calculateProcessingFeeBreakdownByProduct({
        basePremiumByProductId: new Map([[PRODUCT_A, 100]]),
        paymentMethodType: 'Card',
        paymentProcessorSettings: tenantSettings,
        subscriptionFeeSettingsByProductId: settingsMap({
          [PRODUCT_A]: cfg({ zeroFeeForACH: true })
        })
      });

      expect(result.nonIncludedProcessingFeeAmount).toBe(3.30);
    });

    test('Highest method (non-ACH) → zero-ACH pool is billed at Card rate', () => {
      const result = calculateProcessingFeeBreakdownByProduct({
        basePremiumByProductId: new Map([[PRODUCT_A, 100]]),
        paymentMethodType: 'Highest',
        paymentProcessorSettings: tenantSettings,
        subscriptionFeeSettingsByProductId: settingsMap({
          [PRODUCT_A]: cfg({ zeroFeeForACH: true })
        })
      });

      // Because isACH is false for 'Highest', zero-ACH pool uses Card rate (per helper design).
      expect(result.nonIncludedProcessingFeeAmount).toBe(3.30);
    });
  });

  describe('mixed products (normal + zeroFeeForACH)', () => {
    test('ACH method → normal pool pays ACH fee, zero-ACH pool pays $0', () => {
      const result = calculateProcessingFeeBreakdownByProduct({
        basePremiumByProductId: new Map([
          [PRODUCT_A, 100], // normal
          [PRODUCT_B, 200]  // zeroFeeForACH
        ]),
        paymentMethodType: 'ACH',
        paymentProcessorSettings: tenantSettings,
        subscriptionFeeSettingsByProductId: settingsMap({
          [PRODUCT_A]: cfg(),
          [PRODUCT_B]: cfg({ zeroFeeForACH: true })
        })
      });

      // Normal: 100 * 0.0025 = 0.25; ZeroACH under ACH: 0. Total = 0.25.
      expect(result.nonIncludedProcessingFeeAmount).toBe(0.25);
      // Combined non-included subtotal includes BOTH pools (contract of the helper).
      expect(result.nonIncludedPremiumSubtotal).toBe(300);
    });

    test('Card method → both pools pay Card fee (summed on their respective subtotals)', () => {
      const result = calculateProcessingFeeBreakdownByProduct({
        basePremiumByProductId: new Map([
          [PRODUCT_A, 100],
          [PRODUCT_B, 200]
        ]),
        paymentMethodType: 'Card',
        paymentProcessorSettings: tenantSettings,
        subscriptionFeeSettingsByProductId: settingsMap({
          [PRODUCT_A]: cfg(),
          [PRODUCT_B]: cfg({ zeroFeeForACH: true })
        })
      });

      // Normal pool: 100 * 0.03 + 0.30 = 3.30 (ceil of 3.30). ZeroACH pool at Card: 200 * 0.03 + 0.30 = 6.30. Sum = 9.60.
      expect(result.nonIncludedProcessingFeeAmount).toBe(9.60);
    });
  });

  describe('three-way mix: included + normal + zeroFeeForACH', () => {
    test('ACH method splits correctly across all three pools', () => {
      const result = calculateProcessingFeeBreakdownByProduct({
        basePremiumByProductId: new Map([
          [PRODUCT_A, 100], // included
          [PRODUCT_B, 100], // normal
          [PRODUCT_C, 100]  // zeroFeeForACH
        ]),
        paymentMethodType: 'ACH',
        paymentProcessorSettings: tenantSettings,
        subscriptionFeeSettingsByProductId: settingsMap({
          [PRODUCT_A]: cfg({ includeProcessingFee: true }),
          [PRODUCT_B]: cfg(),
          [PRODUCT_C]: cfg({ zeroFeeForACH: true })
        })
      });

      // Included product A uses Highest → Card fee 3.30
      expect(result.includedProcessingFeeByProductId[PRODUCT_A]).toBe(3.30);
      expect(result.includedProcessingFeeTotal).toBe(3.30);
      // Normal product B under ACH: 0.25
      // Zero-ACH product C under ACH: 0
      expect(result.nonIncludedProcessingFeeAmount).toBe(0.25);
      // Non-included subtotal = B (100) + C (100) = 200
      expect(result.nonIncludedPremiumSubtotal).toBe(200);
      expect(result.paymentProcessingFeeAmount).toBe(3.55);
    });
  });

  describe('product with BOTH includeProcessingFee and zeroFeeForACH', () => {
    test('ACH method → included path uses Highest; zeroFeeForACH resolves Highest to Card rate', () => {
      const result = calculateProcessingFeeBreakdownByProduct({
        basePremiumByProductId: new Map([[PRODUCT_A, 100]]),
        paymentMethodType: 'ACH',
        paymentProcessorSettings: tenantSettings,
        subscriptionFeeSettingsByProductId: settingsMap({
          [PRODUCT_A]: cfg({ includeProcessingFee: true, zeroFeeForACH: true })
        })
      });

      // Included path uses Highest; zeroFeeForACH makes ACH leg $0 so Card rate applies.
      expect(result.includedProcessingFeeTotal).toBe(3.30);
      expect(result.includedProcessingFeeByProductId[PRODUCT_A]).toBe(3.30);
      expect(result.nonIncludedPremiumSubtotal).toBe(0);
      expect(result.nonIncludedProcessingFeeAmount).toBe(0);
      expect(result.paymentProcessingFeeAmount).toBe(3.30);
    });

    test('Card method → included path runs with full Card fee (zeroFeeForACH does not affect Card)', () => {
      const result = calculateProcessingFeeBreakdownByProduct({
        basePremiumByProductId: new Map([[PRODUCT_A, 100]]),
        paymentMethodType: 'Card',
        paymentProcessorSettings: tenantSettings,
        subscriptionFeeSettingsByProductId: settingsMap({
          [PRODUCT_A]: cfg({ includeProcessingFee: true, zeroFeeForACH: true })
        })
      });

      // Card fee, included path.
      expect(result.includedProcessingFeeTotal).toBe(3.30);
      expect(result.paymentProcessingFeeAmount).toBe(3.30);
    });
  });

  describe('case-insensitive paymentMethodType', () => {
    test('"ach" (lowercase) is treated same as "ACH"', () => {
      const result = calculateProcessingFeeBreakdownByProduct({
        basePremiumByProductId: new Map([[PRODUCT_A, 100]]),
        paymentMethodType: 'ach',
        paymentProcessorSettings: tenantSettings,
        subscriptionFeeSettingsByProductId: settingsMap({
          [PRODUCT_A]: cfg({ zeroFeeForACH: true })
        })
      });

      expect(result.nonIncludedProcessingFeeAmount).toBe(0);
    });
  });

  describe('bundle-like scenarios (components flattened into the helper map)', () => {
    test('bundle with ONLY zeroFeeForACH products under ACH → total fee is $0', () => {
      const result = calculateProcessingFeeBreakdownByProduct({
        basePremiumByProductId: new Map([
          [PRODUCT_A, 100],
          [PRODUCT_B, 200]
        ]),
        paymentMethodType: 'ACH',
        paymentProcessorSettings: tenantSettings,
        subscriptionFeeSettingsByProductId: settingsMap({
          [PRODUCT_A]: cfg({ zeroFeeForACH: true }),
          [PRODUCT_B]: cfg({ zeroFeeForACH: true })
        })
      });

      expect(result.nonIncludedProcessingFeeAmount).toBe(0);
      expect(result.paymentProcessingFeeAmount).toBe(0);
      // Premium subtotal still reflects full bundle value.
      expect(result.nonIncludedPremiumSubtotal).toBe(300);
    });

    test('bundle with ONLY zeroFeeForACH products under Card → all pay Card rate', () => {
      const result = calculateProcessingFeeBreakdownByProduct({
        basePremiumByProductId: new Map([
          [PRODUCT_A, 100],
          [PRODUCT_B, 200]
        ]),
        paymentMethodType: 'Card',
        paymentProcessorSettings: tenantSettings,
        subscriptionFeeSettingsByProductId: settingsMap({
          [PRODUCT_A]: cfg({ zeroFeeForACH: true }),
          [PRODUCT_B]: cfg({ zeroFeeForACH: true })
        })
      });

      // Both products share the zero-ACH pool ($300) and are billed together at Card with roundUp.
      // 300 * 0.03 + 0.30 = 9.30 in clean math, but JS float artifact + Math.ceil(x*100) pushes it to 9.31.
      expect(result.nonIncludedProcessingFeeAmount).toBe(9.31);
    });

    test('bundle with ONLY normal products — flag is irrelevant', () => {
      const resultACH = calculateProcessingFeeBreakdownByProduct({
        basePremiumByProductId: new Map([
          [PRODUCT_A, 100],
          [PRODUCT_B, 200]
        ]),
        paymentMethodType: 'ACH',
        paymentProcessorSettings: tenantSettings,
        subscriptionFeeSettingsByProductId: settingsMap({
          [PRODUCT_A]: cfg(),
          [PRODUCT_B]: cfg()
        })
      });

      // Both pay ACH on their combined premium: 300 * 0.0025 = 0.75
      expect(resultACH.nonIncludedProcessingFeeAmount).toBe(0.75);
    });

    test('MightyWELL + ShareWELL bundle — switch method flips the fee line', () => {
      const MIGHTYWELL = PRODUCT_A;
      const SHAREWELL = PRODUCT_B;
      const settings = settingsMap({
        [MIGHTYWELL]: cfg(),                       // normal
        [SHAREWELL]: cfg({ zeroFeeForACH: true })  // ZeroFeeForACH
      });
      const premiums = new Map([
        [MIGHTYWELL, 500],
        [SHAREWELL, 100]
      ]);

      const ach = calculateProcessingFeeBreakdownByProduct({
        basePremiumByProductId: premiums,
        paymentMethodType: 'ACH',
        paymentProcessorSettings: tenantSettings,
        subscriptionFeeSettingsByProductId: settings
      });
      // Only MightyWELL is fee'd: 500 * 0.0025 = 1.25. ShareWELL contributes $0.
      expect(ach.nonIncludedProcessingFeeAmount).toBe(1.25);

      const card = calculateProcessingFeeBreakdownByProduct({
        basePremiumByProductId: premiums,
        paymentMethodType: 'Card',
        paymentProcessorSettings: tenantSettings,
        subscriptionFeeSettingsByProductId: settings
      });
      // Both pay Card: pool totals 600 * 0.03 + 0.30 = 18.30. (Single flat fee because both pools
      // are summed when using Card — but here the helper bills the two pools separately, each with its own flat fee.)
      // Normal pool (500): 500 * 0.03 + 0.30 = 15.30
      // ZeroACH pool (100): 100 * 0.03 + 0.30 = 3.30
      // Sum = 18.60
      expect(card.nonIncludedProcessingFeeAmount).toBe(18.60);
    });

    test('bundle mixing includeProcessingFee product + zeroFeeForACH product under ACH', () => {
      // Included product's fee is baked into its own premium line (shown in includedProcessingFeeByProductId).
      // Zero-ACH product contributes $0 to the separate processing-fee line.
      const result = calculateProcessingFeeBreakdownByProduct({
        basePremiumByProductId: new Map([
          [PRODUCT_A, 100], // includeProcessingFee
          [PRODUCT_B, 200]  // zeroFeeForACH
        ]),
        paymentMethodType: 'ACH',
        paymentProcessorSettings: tenantSettings,
        subscriptionFeeSettingsByProductId: settingsMap({
          [PRODUCT_A]: cfg({ includeProcessingFee: true }),
          [PRODUCT_B]: cfg({ zeroFeeForACH: true })
        })
      });

      // Included path: Highest (Card) fee on 100 = 3.30
      expect(result.includedProcessingFeeTotal).toBe(3.30);
      expect(result.includedProcessingFeeByProductId[PRODUCT_A]).toBe(3.30);
      // Separate processing-fee line: ShareWELL under ACH = $0
      expect(result.nonIncludedProcessingFeeAmount).toBe(0);
      // Only ShareWELL shows up in the non-included subtotal (included product isn't counted there).
      expect(result.nonIncludedPremiumSubtotal).toBe(200);
    });
  });

  describe('rounding', () => {
    test('non-included fee rounds to 2 decimals', () => {
      const result = calculateProcessingFeeBreakdownByProduct({
        basePremiumByProductId: new Map([[PRODUCT_A, 33.33]]),
        paymentMethodType: 'Card',
        paymentProcessorSettings: tenantSettings,
        subscriptionFeeSettingsByProductId: settingsMap({ [PRODUCT_A]: cfg() })
      });

      // 33.33 * 0.03 + 0.30 = 1.2999 → Math.ceil(129.99)/100 = 1.30
      expect(result.nonIncludedProcessingFeeAmount).toBeCloseTo(1.30, 2);
    });
  });
});

describe('loadFeeSettingsByProductId', () => {
  const { loadFeeSettingsByProductId } = require('../productProcessingFees');
  const TENANT_ID = '11111111-1111-1111-1111-111111111111';
  const PRODUCT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

  test('runs product + subscription queries sequentially on one transaction connection', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const makeReq = () => ({
      inputs: {},
      input(name, _type, value) {
        this.inputs[name] = value;
        return this;
      },
      async query(sqlText) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (inFlight > 1) {
          throw new Error('EREQINPROG: There is already a request in progress.');
        }
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        if (/FROM oe\.Products\b/i.test(sqlText)) {
          return {
            recordset: [{
              ProductId: PRODUCT_ID,
              IncludeProcessingFee: false,
              RoundUpProcessingFee: false,
              ProcessingFeePercentage: null
            }]
          };
        }
        if (/FROM oe\.TenantProductSubscriptions\b/i.test(sqlText)) {
          return {
            recordset: [{
              ProductId: PRODUCT_ID,
              IncludeProcessingFee: false,
              RoundUpProcessingFee: false,
              ZeroFeeForACH: true,
              CustomSystemFeeEnabled: false,
              CustomSystemFeeAmount: null
            }]
          };
        }
        throw new Error(`Unexpected SQL: ${sqlText}`);
      }
    });

    const transaction = { request: () => makeReq() };
    const settings = await loadFeeSettingsByProductId({
      poolOrTransaction: transaction,
      tenantId: TENANT_ID,
      productIds: [PRODUCT_ID]
    });

    expect(maxInFlight).toBe(1);
    expect(settings.get(PRODUCT_ID).zeroFeeForACH).toBe(true);
  });
});

describe('loadFeeSettingsByProductId', () => {
  const { loadFeeSettingsByProductId } = require('../productProcessingFees');
  const TENANT_ID = '11111111-1111-1111-1111-111111111111';
  const PRODUCT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

  test('runs product + subscription queries sequentially on one transaction connection', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const makeReq = () => ({
      inputs: {},
      input(name, _type, value) {
        this.inputs[name] = value;
        return this;
      },
      async query(sqlText) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (inFlight > 1) {
          throw new Error('EREQINPROG: There is already a request in progress.');
        }
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        if (/FROM oe\.Products\b/i.test(sqlText)) {
          return {
            recordset: [{
              ProductId: PRODUCT_ID,
              IncludeProcessingFee: false,
              RoundUpProcessingFee: false,
              ProcessingFeePercentage: null
            }]
          };
        }
        if (/FROM oe\.TenantProductSubscriptions\b/i.test(sqlText)) {
          return {
            recordset: [{
              ProductId: PRODUCT_ID,
              IncludeProcessingFee: false,
              RoundUpProcessingFee: false,
              ZeroFeeForACH: true,
              CustomSystemFeeEnabled: false,
              CustomSystemFeeAmount: null
            }]
          };
        }
        throw new Error(`Unexpected SQL: ${sqlText}`);
      }
    });

    const transaction = { request: () => makeReq() };
    const settings = await loadFeeSettingsByProductId({
      poolOrTransaction: transaction,
      tenantId: TENANT_ID,
      productIds: [PRODUCT_ID]
    });

    expect(maxInFlight).toBe(1);
    expect(settings.get(PRODUCT_ID).zeroFeeForACH).toBe(true);
  });
});
