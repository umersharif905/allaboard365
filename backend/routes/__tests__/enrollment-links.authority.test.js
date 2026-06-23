/**
 * Permanent equivalence test for the three order-level fee-composition sites
 * in backend/routes/enrollment-links.js migrated in Task 5.3:
 *
 *   Block A — GET  /product-pricing       site ~line 11043
 *   Block B — POST /contribution-preview  sites ~lines 11382 (non-included
 *             per-product allocation) and 11463 (per-equivalent-tier fee).
 *
 * Purpose: byte-for-byte proof — across a 48-scenario parametrization matrix —
 * that pricingAuthority.computePricing produces the SAME numbers as the legacy
 * direct calls to calculateProcessingFeeBreakdownByProduct /
 * calculateSystemFeeAmount that the three migrated call sites used
 * pre-migration.
 *
 * ---
 * Option B (CONTRACT test): identical pattern to Task 5.2's
 * planModification.authority.test.js. We don't spin up a full Express handler
 * with DB mocks; instead we isolate the fee-composition boundary.
 *
 * Block A contract (the site at line 11043):
 *   Given a basePremiumByProductId map + tenant settings + per-product
 *   subscription settings, the legacy code composed a
 *   `feesFromBackend = { systemFeesAmount, processingFee, totalFees }` shape
 *   from:
 *     breakdown = calculateProcessingFeeBreakdownByProduct(...);
 *     processingFee = breakdown.paymentProcessingFeeAmount;
 *     systemFeesAmount = calculateSystemFeeAmount(...);
 *   The migrated site must reproduce the SAME three numbers via
 *   pricingAuthority.computePricing:
 *     systemFeesAmount = totals.systemFees
 *     processingFee    = totals.nonIncludedFeeTotal + totals.includedFeeTotal
 *                      = (see note below — authority's nonIncludedFeeTotal
 *                         covers only the member-paid non-included portion,
 *                         and the legacy paymentProcessingFeeAmount is
 *                         includedProcessingFeeTotal + non-included — so
 *                         authority's includedFeeTotal + nonIncludedFeeTotal).
 *     totalFees        = systemFeesAmount + processingFee
 *
 * Block B contract (the sites at lines 11382 + 11463):
 *   Given a pristine per-product base premium map, both sites consume
 *   `breakdown.nonIncludedProcessingFeeAmount`. The migrated sites must
 *   produce the SAME number via `authorityOutput.totals.nonIncludedFeeTotal`.
 *
 * Both contracts are what the three migrated call sites now depend on.
 *
 * Lint note: this file invokes calculateProcessingFeeBreakdownByProduct and
 * calculateSystemFeeAmount directly. That's allowed because __tests__/** is
 * excluded from the pricing lint rule in backend/.eslintrc.json.
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

// System fee $2.10 flat, member-paid.
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

// Fake mssql pool that answers the 2 queries the authority issues:
//   - SELECT PaymentProcessorSettings, SystemFees FROM oe.Tenants
//   - SELECT ... FROM oe.TenantProductSubscriptions
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

// Mock loadSubscriptionFeeSettingsByProductId so the authority reads the same
// per-scenario map the legacy reference receives directly. We keep the
// rest of productProcessingFees (calculateProcessingFeeBreakdownByProduct
// and calculateSystemFeeAmount) as the real implementation so the legacy arm
// exercises the production code path.
jest.mock('../../utils/productProcessingFees', () => {
  const actual = jest.requireActual('../../utils/productProcessingFees');
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

const productProcessingFeesUtil = require('../../utils/productProcessingFees');
const pricingAuthority = require('../../services/pricing/pricingAuthority.service');

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

/**
 * Build the per-scenario base-premium map + per-product subscription settings.
 *
 * `single-nonincluded` — just Product A (non-included).
 * `single-included`    — just Product B (may be flagged include/zeroACH).
 * `two-products`       — both A and B.
 *
 * The includeProcessingFee / roundUpProcessingFee / zeroFeeForACH flags in
 * the scenario always apply to Product B. Product A is always a baseline
 * (no flags) so scenarios with two products exercise the mixed case.
 */
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

  // Product A: no flags.
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
 * BLOCK A — /product-pricing site (line ~11043).
 * Contract: feesFromBackend = { systemFeesAmount, processingFee, totalFees }.
 * Legacy path  ---> calculateProcessingFeeBreakdownByProduct (paymentProcessingFeeAmount)
 *                   + calculateSystemFeeAmount.
 * Authority path -> totals.systemFees + totals.includedFeeTotal + totals.nonIncludedFeeTotal.
 * -------------------------------------------------------------------------- */
describe('enrollment-links GET /product-pricing — feesFromBackend equivalence (Task 5.3 Site 1, line 11043)', () => {
  /**
   * Legacy reference — EXACT reproduction of the pre-migration fees block.
   */
  function legacyComputeFees({
    basePremiumByProductId,
    paymentMethodType,
    paymentProcessorSettings,
    systemFeesSettings,
    subscriptionFeeSettingsByProductId
  }) {
    const breakdown = productProcessingFeesUtil.calculateProcessingFeeBreakdownByProduct({
      basePremiumByProductId,
      paymentMethodType,
      paymentProcessorSettings,
      subscriptionFeeSettingsByProductId
    });
    const processingFee = breakdown.paymentProcessingFeeAmount;
    const basePremiumTotal = Array.from(basePremiumByProductId.values())
      .reduce((s, v) => s + Number(v || 0), 0);
    const systemFeesAmount = productProcessingFeesUtil.calculateSystemFeeAmount({
      subscriptionFeeSettingsByProductId,
      basePremiumTotal,
      systemFeesSettings
    });
    return {
      systemFeesAmount: round2(systemFeesAmount),
      processingFee: round2(processingFee),
      totalFees: round2(systemFeesAmount + processingFee)
    };
  }

  /**
   * Authority arm — mirrors the migrated site that builds `pricingProducts`
   * from basePremiumByProductId entries, calls computePricing, and assembles
   * the same feesFromBackend shape from totals.
   */
  async function authorityComputeFees({ basePremiumByProductId, paymentMethodType }) {
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
    const processingFee = round2(out.totals.includedFeeTotal + out.totals.nonIncludedFeeTotal);
    const systemFeesAmount = round2(out.totals.systemFees);
    return {
      systemFeesAmount,
      processingFee,
      totalFees: round2(systemFeesAmount + processingFee)
    };
  }

  test.each(SCENARIOS)(
    'matches legacy for paymentMethodType=$paymentMethodType include=$includeProcessingFee roundUp=$roundUpProcessingFee zeroACH=$zeroFeeForACH shape=$productShape',
    async (scenario) => {
      const { basePremiumByProductId, subs } = buildScenarioInputs(scenario);
      mockState.subscriptionSettingsByProductId = subs;

      const legacy = legacyComputeFees({
        basePremiumByProductId,
        paymentMethodType: scenario.paymentMethodType,
        paymentProcessorSettings: DEFAULT_PAYMENT_PROCESSOR_SETTINGS,
        systemFeesSettings: DEFAULT_SYSTEM_FEES_SETTINGS,
        subscriptionFeeSettingsByProductId: subs
      });

      const authority = await authorityComputeFees({
        basePremiumByProductId,
        paymentMethodType: scenario.paymentMethodType
      });

      expect(authority.systemFeesAmount).toBeCloseTo(legacy.systemFeesAmount, 2);
      expect(authority.processingFee).toBeCloseTo(legacy.processingFee, 2);
      expect(authority.totalFees).toBeCloseTo(legacy.totalFees, 2);
      expect(Number.isFinite(authority.totalFees)).toBe(true);
      expect(authority.totalFees).toBeGreaterThanOrEqual(0);
    }
  );
});

/* --------------------------------------------------------------------------
 * BLOCK B — /contribution-preview sites (lines ~11382 + ~11463).
 * Both sites consume `breakdown.nonIncludedProcessingFeeAmount`.
 * Authority arm reads `totals.nonIncludedFeeTotal`.
 * -------------------------------------------------------------------------- */
describe('enrollment-links POST /contribution-preview — nonIncludedProcessingFee equivalence (Task 5.3 Sites 2 + 3, lines 11382 + 11463)', () => {
  function legacyNonIncludedTotal({
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

  async function authorityNonIncludedTotal({ basePremiumByProductId, paymentMethodType }) {
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

      const legacy = legacyNonIncludedTotal({
        basePremiumByProductId,
        paymentMethodType: scenario.paymentMethodType,
        paymentProcessorSettings: DEFAULT_PAYMENT_PROCESSOR_SETTINGS,
        subscriptionFeeSettingsByProductId: subs
      });

      const authority = await authorityNonIncludedTotal({
        basePremiumByProductId,
        paymentMethodType: scenario.paymentMethodType
      });

      expect(authority).toBeCloseTo(legacy, 2);
      expect(Number.isFinite(authority)).toBe(true);
      expect(authority).toBeGreaterThanOrEqual(0);
    }
  );
});
