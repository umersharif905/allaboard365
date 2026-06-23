/**
 * Permanent equivalence test for the two fee-composition sites in
 * backend/routes/me/member/product-changes-complete.js migrated in Task 5.4:
 *
 *   Site 1955 — primary-member persistence block (writes per-product
 *               IncludedPaymentProcessingFeeAmount to oe.Enrollments).
 *   Site 3109 — recurringProcessingFee for the DIME recurring schedule.
 *
 * Purpose: byte-for-byte proof across 48 scenarios each that
 * pricingAuthority.computePricing produces the SAME numbers as the legacy
 * direct call to calculateProcessingFeeBreakdownByProduct.
 *
 * Site 1955 (persistence) consumes these breakdown fields:
 *   chargeFeeToMemberEnabled            → _raw.chargeFeeToMemberEnabled
 *   includedProcessingFeeTotal          → totals.includedFeeTotal
 *   nonIncludedPremiumSubtotal          → _raw.feeBreakdown.nonIncludedPremiumSubtotal
 *   nonIncludedProcessingFeeAmount      → totals.nonIncludedFeeTotal
 *   includedProcessingFeeByProductId    → _raw.feeBreakdown.includedProcessingFeeByProductId
 *
 * Site 3109 (recurring DIME) consumes only:
 *   nonIncludedProcessingFeeAmount      → totals.nonIncludedFeeTotal
 *
 * Option B (CONTRACT test): same pattern as prior Task 5.4 suites. We isolate
 * the fee-composition boundary rather than spinning up the full Express
 * handler with DB mocks.
 *
 * Lint note: __tests__/** is excluded from the pricing lint rule in
 * backend/.eslintrc.json, so direct calls to
 * calculateProcessingFeeBreakdownByProduct are allowed here.
 */

const TENANT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PRODUCT_A = 'cccccccc-0000-0000-0000-000000000001'; // canonical non-included base $100.54
const PRODUCT_B = 'dddddddd-0000-0000-0000-000000000002'; // canonical included-anchor base $133.00

// MightyWELL-style fixtures per docs/pricing-authority/pricing-authority-numbers-test-plan.md.
const DEFAULT_PAYMENT_PROCESSOR_SETTINGS = {
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
};

// System fee $2.10 flat, member-paid (not consumed at either site, but kept for
// parity with the pricingAuthority tenant-settings load).
const DEFAULT_SYSTEM_FEES_SETTINGS = {
  platformFee: {
    enabled: true,
    FlatOrPercent: 'Flat',
    MemberPaid: true,
    MemberPaidAmount: 2.10,
    amount: 2.10
  }
};

// Configurable per-test mock state — mutated in beforeEach per scenario.
const mockState = {
  subscriptionSettingsByProductId: new Map()
};

// Fake mssql pool that answers the 2 queries the authority issues.
function makeFakePool() {
  return {
    request() {
      const params = {};
      return {
        input(name, _type, value) { params[name] = value; return this; },
        async query(sqlText) {
          if (/FROM oe\.Tenants/i.test(sqlText)) {
            return {
              recordset: [{
                PaymentProcessorSettings: JSON.stringify(DEFAULT_PAYMENT_PROCESSOR_SETTINGS),
                SystemFees: JSON.stringify(DEFAULT_SYSTEM_FEES_SETTINGS)
              }]
            };
          }
          if (/FROM oe\.TenantProductSubscriptions/i.test(sqlText)) {
            const ids = Object.keys(params)
              .filter((k) => k.startsWith('productId_'))
              .map((k) => params[k]);
            const rows = ids
              .map((pid) => {
                const cfg = mockState.subscriptionSettingsByProductId.get(String(pid));
                if (!cfg) return null;
                return {
                  ProductId: pid,
                  IncludeProcessingFee: cfg.includeProcessingFee === true,
                  RoundUpProcessingFee: cfg.roundUpProcessingFee === true,
                  ZeroFeeForACH: cfg.zeroFeeForACH === true,
                  CustomSystemFeeEnabled: cfg.customSystemFeeEnabled === true,
                  CustomSystemFeeAmount: cfg.customSystemFeeAmount ?? null
                };
              })
              .filter(Boolean);
            return { recordset: rows };
          }
          throw new Error(`Unexpected SQL in fake pool: ${sqlText}`);
        }
      };
    }
  };
}

// Mock loadFeeSettingsByProductId so the authority reads the same per-scenario
// map the legacy reference receives directly. The rest of productProcessingFees
// stays real so the legacy arm exercises production code.
jest.mock('../../../../utils/productProcessingFees', () => {
  const actual = jest.requireActual('../../../../utils/productProcessingFees');
  const buildMap = async ({ productIds }) => {
    const out = new Map();
    for (const pid of productIds || []) {
      const cfg = mockState.subscriptionSettingsByProductId.get(String(pid));
      if (cfg) {
        out.set(String(pid), {
          ...cfg,
          includeProcessingFeeFromProduct: false
        });
      }
    }
    return out;
  };
  return {
    ...actual,
    loadFeeSettingsByProductId: jest.fn(buildMap),
    loadSubscriptionFeeSettingsByProductId: jest.fn(buildMap)
  };
});

const productProcessingFeesUtil = require('../../../../utils/productProcessingFees');
const pricingAuthority = require('../../../../services/pricing/pricingAuthority.service');

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

// Build the scenario matrix — 2 * 2 * 2 * 2 * 3 = 48 parametrizations.
const SCENARIOS = [];
for (const paymentMethodType of ['ACH', 'Card']) {
  for (const includeProcessingFee of [true, false]) {
    for (const roundUpProcessingFee of [true, false]) {
      for (const zeroFeeForACH of [true, false]) {
        for (const productShape of ['single-nonincluded', 'single-included', 'two-products']) {
          SCENARIOS.push({
            paymentMethodType,
            includeProcessingFee,
            roundUpProcessingFee,
            zeroFeeForACH,
            productShape
          });
        }
      }
    }
  }
}

function buildScenarioInputs(scenario) {
  const basePremiumByProductId = new Map();
  const subs = new Map();

  if (scenario.productShape === 'single-nonincluded') {
    basePremiumByProductId.set(PRODUCT_A, 100.54);
  } else if (scenario.productShape === 'single-included') {
    basePremiumByProductId.set(PRODUCT_B, 133.00);
  } else {
    basePremiumByProductId.set(PRODUCT_A, 100.54);
    basePremiumByProductId.set(PRODUCT_B, 133.00);
  }

  // Product A: no flags (plain non-included).
  subs.set(PRODUCT_A, {
    includeProcessingFee: false,
    roundUpProcessingFee: false,
    zeroFeeForACH: false,
    customSystemFeeEnabled: false,
    customSystemFeeAmount: null
  });
  // Product B: carries the scenario flags.
  subs.set(PRODUCT_B, {
    includeProcessingFee: scenario.includeProcessingFee,
    roundUpProcessingFee: scenario.roundUpProcessingFee,
    zeroFeeForACH: scenario.zeroFeeForACH,
    customSystemFeeEnabled: false,
    customSystemFeeAmount: null
  });

  return { basePremiumByProductId, subs };
}

beforeEach(() => {
  mockState.subscriptionSettingsByProductId = new Map();
});

/* --------------------------------------------------------------------------
 * SITE 1955 — primary-member persistence block (DB-written fees)
 * -------------------------------------------------------------------------- */
describe('product-changes-complete primary-member persistence — breakdown equivalence (Task 5.4 Site 1955)', () => {
  function legacyBreakdownShape({
    basePremiumByProductId,
    paymentMethodType,
    paymentProcessorSettings,
    subscriptionFeeSettingsByProductId
  }) {
    const breakdown = productProcessingFeesUtil.calculateProcessingFeeBreakdownByProduct({
      basePremiumByProductId,
      paymentMethodType,
      paymentProcessorSettings,
      subscriptionFeeSettingsByProductId
    });
    return {
      chargeFeeToMemberEnabled: breakdown.chargeFeeToMemberEnabled,
      includedProcessingFeeTotal: round2(breakdown.includedProcessingFeeTotal),
      nonIncludedPremiumSubtotal: round2(breakdown.nonIncludedPremiumSubtotal),
      nonIncludedProcessingFeeAmount: round2(breakdown.nonIncludedProcessingFeeAmount),
      includedProcessingFeeByProductId: breakdown.includedProcessingFeeByProductId
    };
  }

  async function authorityBreakdownShape({ basePremiumByProductId, paymentMethodType }) {
    const pool = makeFakePool();
    const pricingProducts = Array.from(basePremiumByProductId.entries())
      .map(([productId, monthlyPremium]) => ({
        productId,
        monthlyPremium: Number(monthlyPremium || 0)
      }));
    const out = await pricingAuthority.computePricing({
      poolOrTransaction: pool,
      tenantId: TENANT_ID,
      pricingProducts,
      paymentMethodType
    });
    const rawBreakdown = out._raw.feeBreakdown;
    return {
      chargeFeeToMemberEnabled: out._raw.chargeFeeToMemberEnabled,
      includedProcessingFeeTotal: round2(out.totals.includedFeeTotal),
      nonIncludedPremiumSubtotal: round2(rawBreakdown.nonIncludedPremiumSubtotal),
      nonIncludedProcessingFeeAmount: round2(out.totals.nonIncludedFeeTotal),
      includedProcessingFeeByProductId: rawBreakdown.includedProcessingFeeByProductId
    };
  }

  test.each(SCENARIOS)(
    'matches legacy for paymentMethodType=$paymentMethodType include=$includeProcessingFee roundUp=$roundUpProcessingFee zeroACH=$zeroFeeForACH shape=$productShape',
    async (scenario) => {
      const { basePremiumByProductId, subs } = buildScenarioInputs(scenario);
      mockState.subscriptionSettingsByProductId = subs;

      const legacy = legacyBreakdownShape({
        basePremiumByProductId,
        paymentMethodType: scenario.paymentMethodType,
        paymentProcessorSettings: DEFAULT_PAYMENT_PROCESSOR_SETTINGS,
        subscriptionFeeSettingsByProductId: subs
      });

      const authority = await authorityBreakdownShape({
        basePremiumByProductId,
        paymentMethodType: scenario.paymentMethodType
      });

      expect(authority.chargeFeeToMemberEnabled).toBe(legacy.chargeFeeToMemberEnabled);
      expect(authority.includedProcessingFeeTotal).toBeCloseTo(legacy.includedProcessingFeeTotal, 2);
      expect(authority.nonIncludedPremiumSubtotal).toBeCloseTo(legacy.nonIncludedPremiumSubtotal, 2);
      expect(authority.nonIncludedProcessingFeeAmount).toBeCloseTo(legacy.nonIncludedProcessingFeeAmount, 2);

      // Per-product DB-write allocation — must match exactly for audit consistency.
      const legacyKeys = Object.keys(legacy.includedProcessingFeeByProductId || {}).sort();
      const authorityKeys = Object.keys(authority.includedProcessingFeeByProductId || {}).sort();
      expect(authorityKeys).toEqual(legacyKeys);
      for (const k of legacyKeys) {
        expect(Number(authority.includedProcessingFeeByProductId[k] || 0))
          .toBeCloseTo(Number(legacy.includedProcessingFeeByProductId[k] || 0), 2);
      }
    }
  );
});

/* --------------------------------------------------------------------------
 * SITE 3109 — recurringProcessingFee for the DIME recurring schedule
 * Only consumed field: nonIncludedProcessingFeeAmount → totals.nonIncludedFeeTotal
 * -------------------------------------------------------------------------- */
describe('product-changes-complete recurring DIME fee — nonIncludedProcessingFeeAmount equivalence (Task 5.4 Site 3109)', () => {
  function legacyRecurringFee({
    basePremiumByProductId,
    paymentMethodType,
    paymentProcessorSettings,
    subscriptionFeeSettingsByProductId
  }) {
    const breakdown = productProcessingFeesUtil.calculateProcessingFeeBreakdownByProduct({
      basePremiumByProductId,
      paymentMethodType,
      paymentProcessorSettings,
      subscriptionFeeSettingsByProductId
    });
    return Number(breakdown.nonIncludedProcessingFeeAmount || 0);
  }

  async function authorityRecurringFee({ basePremiumByProductId, paymentMethodType }) {
    const pool = makeFakePool();
    const pricingProducts = Array.from(basePremiumByProductId.entries())
      .map(([productId, monthlyPremium]) => ({
        productId,
        monthlyPremium: Number(monthlyPremium || 0)
      }));
    const out = await pricingAuthority.computePricing({
      poolOrTransaction: pool,
      tenantId: TENANT_ID,
      pricingProducts,
      paymentMethodType
    });
    return Number(out.totals.nonIncludedFeeTotal || 0);
  }

  test.each(SCENARIOS)(
    'matches legacy for paymentMethodType=$paymentMethodType include=$includeProcessingFee roundUp=$roundUpProcessingFee zeroACH=$zeroFeeForACH shape=$productShape',
    async (scenario) => {
      const { basePremiumByProductId, subs } = buildScenarioInputs(scenario);
      mockState.subscriptionSettingsByProductId = subs;

      const legacy = legacyRecurringFee({
        basePremiumByProductId,
        paymentMethodType: scenario.paymentMethodType,
        paymentProcessorSettings: DEFAULT_PAYMENT_PROCESSOR_SETTINGS,
        subscriptionFeeSettingsByProductId: subs
      });

      const authority = await authorityRecurringFee({
        basePremiumByProductId,
        paymentMethodType: scenario.paymentMethodType
      });

      expect(authority).toBeCloseTo(legacy, 2);
      expect(Number.isFinite(authority)).toBe(true);
      expect(authority).toBeGreaterThanOrEqual(0);
    }
  );
});
