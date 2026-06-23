/**
 * Golden cross-surface parity: same tenant + bundle component bases MUST agree across
 * pricingAuthority callers used by —
 *   - Agent bundle-simulator (`computePricing`, nested bundle + includedProducts)
 *   - Business proposals (`proposalCalculation.applyQuoteFeesToParts` → flattened pricingProducts)
 *   - Enrollment product-pricing UA math (`computeDisplayPremiums`, per-variation rollup)
 *
 * This does not invoke Express handlers or enrollment-links POST /product-pricing; it freezes
 * the numeric contract authority must satisfy so wizard vs agent vs proposal totals cannot drift silently.
 */

jest.mock('../../../config/database', () => ({
  getPool: jest.fn(),
  sql: new Proxy({}, { get: () => 'MOCK_SQL_TYPE' })
}));

const { getPool } = require('../../../config/database');
const pricingAuthority = require('../pricingAuthority.service');
const proposalCalculation = require('../../proposalCalculation.service');

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

const BUNDLE_PRODUCT_ID = '22222222-2222-2222-2222-222222222222';
const COMPONENT_A_ID = '33333333-3333-3333-3333-333333333333';
const COMPONENT_B_ID = '44444444-4444-4444-4444-444444444444';

const TENANT_ROW = {
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

/** Matches agent simulator fixture: MightyWELL-style bundle components with Highest-policy included fees. */
const SUBSCRIPTION_ROWS = {
  [COMPONENT_A_ID]: {
    ProductId: COMPONENT_A_ID,
    IncludeProcessingFee: true,
    RoundUpProcessingFee: true,
    ZeroFeeForACH: false,
    CustomSystemFeeEnabled: false,
    CustomSystemFeeAmount: null
  },
  [COMPONENT_B_ID]: {
    ProductId: COMPONENT_B_ID,
    IncludeProcessingFee: true,
    RoundUpProcessingFee: true,
    ZeroFeeForACH: false,
    CustomSystemFeeEnabled: false,
    CustomSystemFeeAmount: null
  },
  [BUNDLE_PRODUCT_ID]: {
    ProductId: BUNDLE_PRODUCT_ID,
    IncludeProcessingFee: false,
    RoundUpProcessingFee: false,
    ZeroFeeForACH: false,
    CustomSystemFeeEnabled: false,
    CustomSystemFeeAmount: null
  }
};

/** ES-tier mocked premiums aligned with POST bundle-simulator + ProductPricing stubs (Agent test file). */
const BASE_A_ES = 260;
const BASE_B_ES = 270;

function scriptedQuery(sqlText, params) {
  if (/FROM oe\.Tenants\b/i.test(sqlText) && /PaymentProcessorSettings/i.test(sqlText)) {
    return { recordset: [TENANT_ROW] };
  }
  if (/FROM oe\.TenantProductSubscriptions\b/i.test(sqlText)) {
    const ids = Object.keys(params)
      .filter((k) => k.startsWith('productId_') || k.startsWith('sub_pid_'))
      .map((k) => params[k]);
    const rows = ids.map((id) => SUBSCRIPTION_ROWS[id]).filter(Boolean);
    return { recordset: rows };
  }
  if (/FROM oe\.Products\b/i.test(sqlText)) {
    const ids = Object.keys(params)
      .filter((k) => k.startsWith('productId_'))
      .map((k) => params[k]);
    const rows = ids.map((id) => {
      const sub = SUBSCRIPTION_ROWS[id];
      return {
        ProductId: id,
        IncludeProcessingFee: sub?.IncludeProcessingFee === true ? 1 : 0,
        RoundUpProcessingFee: sub?.RoundUpProcessingFee === true ? 1 : 0,
        ProcessingFeePercentage: null
      };
    });
    return { recordset: rows };
  }
  throw new Error(`crossSurfaceBundlePricingParity: unexpected SQL\n${sqlText}\nparams=${JSON.stringify(params)}`);
}

function makeFakePool() {
  return {
    request() {
      const params = {};
      const self = {
        input(name, _type, value) {
          params[name] = value;
          return self;
        },
        async query(text) {
          return scriptedQuery(text, params);
        }
      };
      return self;
    }
  };
}

describe('cross-surface bundle pricing parity (agent vs proposal vs enrollment display rollup)', () => {
  let consoleLogSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    getPool.mockImplementation(async () => makeFakePool());
    // pricingAuthority exercises real fee calculators, which noisy-log every calc path.
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  test('bundle computePricing nested display matches sum of flattened standalone premiums (proposal-style decomposition)', async () => {
    const pool = await getPool();

    const nestedPricingProducts = [
      {
        productId: BUNDLE_PRODUCT_ID,
        productName: 'Parity Fixture Bundle',
        isBundle: true,
        monthlyPremium: BASE_A_ES + BASE_B_ES,
        includedProducts: [
          {
            productId: COMPONENT_A_ID,
            productName: 'Component A',
            monthlyPremium: BASE_A_ES
          },
          {
            productId: COMPONENT_B_ID,
            productName: 'Component B',
            monthlyPremium: BASE_B_ES
          }
        ]
      }
    ];

    const flatPricingProducts = [
      {
        productId: COMPONENT_A_ID,
        productName: 'Component A',
        isBundle: false,
        monthlyPremium: BASE_A_ES
      },
      {
        productId: COMPONENT_B_ID,
        productName: 'Component B',
        isBundle: false,
        monthlyPremium: BASE_B_ES
      }
    ];

    const nestedOut = await pricingAuthority.computePricing({
      poolOrTransaction: pool,
      tenantId: TENANT_ID,
      pricingProducts: nestedPricingProducts,
      paymentMethodType: 'ACH'
    });

    const flatOut = await pricingAuthority.computePricing({
      poolOrTransaction: pool,
      tenantId: TENANT_ID,
      pricingProducts: flatPricingProducts,
      paymentMethodType: 'ACH'
    });

    const nestedBundleRow = nestedOut.products[0];
    const nestedDisplaySum = nestedBundleRow.displayPremium;
    const flatDisplaySum = flatOut.products.reduce((s, row) => s + Number(row.displayPremium || 0), 0);

    expect(nestedDisplaySum).toBeCloseTo(flatDisplaySum, 4);
    expect(nestedDisplaySum).toBeGreaterThan(BASE_A_ES + BASE_B_ES);
    expect(nestedOut.totals.monthlyContribution).toBeCloseTo(flatOut.totals.monthlyContribution, 4);
  });

  test('proposal applyQuoteFeesToParts (flattened parts) matches bundled computePricing totals', async () => {
    const pool = await getPool();

    const bundledOut = await pricingAuthority.computePricing({
      poolOrTransaction: pool,
      tenantId: TENANT_ID,
      pricingProducts: [
        {
          productId: BUNDLE_PRODUCT_ID,
          productName: 'Parity Fixture Bundle',
          isBundle: true,
          monthlyPremium: BASE_A_ES + BASE_B_ES,
          includedProducts: [
            {
              productId: COMPONENT_A_ID,
              productName: 'Component A',
              monthlyPremium: BASE_A_ES
            },
            {
              productId: COMPONENT_B_ID,
              productName: 'Component B',
              monthlyPremium: BASE_B_ES
            }
          ]
        }
      ],
      paymentMethodType: 'ACH'
    });

    const proposalFees = await proposalCalculation.applyQuoteFeesToParts(
      [
        { productId: COMPONENT_A_ID, productName: 'Component A', basePremium: BASE_A_ES },
        { productId: COMPONENT_B_ID, productName: 'Component B', basePremium: BASE_B_ES }
      ],
      { tenantId: TENANT_ID },
      'ACH'
    );

    expect(proposalFees.totalPremium).toBeCloseTo(bundledOut.totals.monthlyContribution, 4);
    expect(proposalFees.authority.totals.displayPremiumTotal).toBeCloseTo(
      bundledOut.totals.displayPremiumTotal,
      4
    );
  });

  test('computeDisplayPremiums bundle UA rollup equals nested bundle computePricing displayPremium (enrollment UA shape)', async () => {
    const pool = await getPool();

    const UA_KEY = '5000';

    const nestedOut = await pricingAuthority.computePricing({
      poolOrTransaction: pool,
      tenantId: TENANT_ID,
      pricingProducts: [
        {
          productId: BUNDLE_PRODUCT_ID,
          productName: 'Parity Fixture Bundle',
          isBundle: true,
          monthlyPremium: BASE_A_ES + BASE_B_ES,
          includedProducts: [
            {
              productId: COMPONENT_A_ID,
              productName: 'Component A',
              monthlyPremium: BASE_A_ES
            },
            {
              productId: COMPONENT_B_ID,
              productName: 'Component B',
              monthlyPremium: BASE_B_ES
            }
          ]
        }
      ],
      paymentMethodType: 'ACH'
    });

    const productsForDisplay = [
      {
        productId: BUNDLE_PRODUCT_ID,
        monthlyPremium: BASE_A_ES + BASE_B_ES,
        isBundle: true,
        pricingVariations: [],
        includedProducts: [
          {
            productId: COMPONENT_A_ID,
            monthlyPremium: BASE_A_ES,
            pricingVariations: [{ configValue: UA_KEY, monthlyPremium: BASE_A_ES }]
          },
          {
            productId: COMPONENT_B_ID,
            monthlyPremium: BASE_B_ES,
            pricingVariations: [{ configValue: UA_KEY, monthlyPremium: BASE_B_ES }]
          }
        ]
      }
    ];

    const dp = await pricingAuthority.computeDisplayPremiums({
      poolOrTransaction: pool,
      tenantId: TENANT_ID,
      productsForDisplay
    });

    const entry = dp.byProductId.get(String(BUNDLE_PRODUCT_ID));
    expect(entry).toBeDefined();

    const perUaRollup = entry.variationDisplayPremiumByConfig.get(UA_KEY);
    expect(perUaRollup).toBeDefined();
    expect(perUaRollup).toBeCloseTo(nestedOut.products[0].displayPremium, 4);
  });

  test('Agent Highest-policy: ACH bundle display equals Card bundle display', async () => {
    const pool = await getPool();

    const body = [
      {
        productId: BUNDLE_PRODUCT_ID,
        productName: 'Parity Fixture Bundle',
        isBundle: true,
        monthlyPremium: BASE_A_ES + BASE_B_ES,
        includedProducts: [
          {
            productId: COMPONENT_A_ID,
            productName: 'Component A',
            monthlyPremium: BASE_A_ES
          },
          {
            productId: COMPONENT_B_ID,
            productName: 'Component B',
            monthlyPremium: BASE_B_ES
          }
        ]
      }
    ];

    const ach = await pricingAuthority.computePricing({
      poolOrTransaction: pool,
      tenantId: TENANT_ID,
      pricingProducts: body,
      paymentMethodType: 'ACH'
    });

    const card = await pricingAuthority.computePricing({
      poolOrTransaction: pool,
      tenantId: TENANT_ID,
      pricingProducts: body,
      paymentMethodType: 'Card'
    });

    expect(ach.products[0].displayPremium).toBeCloseTo(card.products[0].displayPremium, 4);
    expect(ach.products[0].displayPremium).toBeGreaterThan(0);
  });
});
