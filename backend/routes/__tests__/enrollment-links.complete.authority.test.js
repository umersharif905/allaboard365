/**
 * Permanent equivalence test for the three submit-path fee-composition sites
 * in backend/routes/enrollment-links.js migrated in Task 5.4:
 *
 *   Site 3766 — /complete-enrollment preChargeBlock (pre-transaction charge amount)
 *   Site 6302 — primary member persistence block (DB-written IncludedPaymentProcessingFeeAmount)
 *   Site 7807 — household/group member persistence block (DB-written IncludedPaymentProcessingFeeAmount)
 *
 * Purpose: byte-for-byte proof — across a 48-scenario parametrization matrix —
 * that pricingAuthority.computePricing produces the SAME numbers as the legacy
 * direct calls to calculateProcessingFeeBreakdownByProduct / calculateSystemFeeAmount.
 *
 * Critical: sites 6302 and 7807 drive DB writes for IncludedPaymentProcessingFeeAmount.
 * Audit reports depend on those numbers staying consistent across the migration.
 *
 * ---
 * Option B (CONTRACT test): identical pattern to Task 5.3's
 * enrollment-links.authority.test.js. We isolate the fee-composition boundary
 * rather than spinning up a full Express handler with DB mocks.
 *
 * Site 3766 contract:
 *   Legacy path extracts:
 *     processingFeeAmountPre = feeBreakdownPre.paymentProcessingFeeAmount
 *                             (= includedProcessingFeeTotal + nonIncludedProcessingFeeAmount)
 *   Authority path equivalent:
 *     totals.includedFeeTotal + totals.nonIncludedFeeTotal
 *
 * Sites 6302 + 7807 contract:
 *   Legacy path extracts from breakdown:
 *     chargeFeeToMemberEnabled
 *     includedProcessingFeeTotal
 *     nonIncludedPremiumSubtotal
 *     nonIncludedProcessingFeeAmount
 *     includedProcessingFeeByProductId   (← written to DB per-product)
 *   Authority path equivalents:
 *     _raw.chargeFeeToMemberEnabled
 *     totals.includedFeeTotal
 *     _raw.feeBreakdown.nonIncludedPremiumSubtotal
 *     totals.nonIncludedFeeTotal
 *     _raw.feeBreakdown.includedProcessingFeeByProductId
 *   Also: calculateSystemFeeAmount(...) === totals.systemFees.
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
// per-scenario map the legacy reference receives directly. The rest of
// productProcessingFees (calculateProcessingFeeBreakdownByProduct and
// calculateSystemFeeAmount) is kept as the real implementation so the legacy
// arm exercises the production code path.
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
 * SITE 3766 — preChargeBlock (pre-transaction charge amount)
 * Contract: processingFeeAmountPre = breakdown.paymentProcessingFeeAmount
 *                                  = includedProcessingFeeTotal + nonIncludedProcessingFeeAmount
 * Authority equivalent: totals.includedFeeTotal + totals.nonIncludedFeeTotal.
 * -------------------------------------------------------------------------- */
describe('enrollment-links /complete-enrollment preChargeBlock — paymentProcessingFeeAmount equivalence (Task 5.4 Site 3766)', () => {
  function legacyProcessingFeeAmount({
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
    return Number(breakdown.paymentProcessingFeeAmount || 0);
  }

  async function authorityProcessingFeeAmount({ basePremiumByProductId, paymentMethodType }) {
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
    return round2(out.totals.includedFeeTotal + out.totals.nonIncludedFeeTotal);
  }

  test.each(SCENARIOS)(
    'matches legacy for paymentMethodType=$paymentMethodType include=$includeProcessingFee roundUp=$roundUpProcessingFee zeroACH=$zeroFeeForACH shape=$productShape',
    async (scenario) => {
      const { basePremiumByProductId, subs } = buildScenarioInputs(scenario);
      mockState.subscriptionSettingsByProductId = subs;

      const legacy = legacyProcessingFeeAmount({
        basePremiumByProductId,
        paymentMethodType: scenario.paymentMethodType,
        paymentProcessorSettings: DEFAULT_PAYMENT_PROCESSOR_SETTINGS,
        subscriptionFeeSettingsByProductId: subs
      });

      const authority = await authorityProcessingFeeAmount({
        basePremiumByProductId,
        paymentMethodType: scenario.paymentMethodType
      });

      expect(authority).toBeCloseTo(legacy, 2);
      expect(Number.isFinite(authority)).toBe(true);
      expect(authority).toBeGreaterThanOrEqual(0);
    }
  );
});

/* --------------------------------------------------------------------------
 * SITE 6302 — primary member persistence block (DB-written fees)
 * Contract fields consumed downstream of the breakdown:
 *   chargeFeeToMemberEnabled, includedProcessingFeeTotal, nonIncludedPremiumSubtotal,
 *   nonIncludedProcessingFeeAmount, includedProcessingFeeByProductId (DB write),
 *   and calculateSystemFeeAmount(...).
 * Authority equivalents live on _raw.feeBreakdown and totals.
 * -------------------------------------------------------------------------- */
describe('enrollment-links /complete-enrollment primary-member persistence — breakdown equivalence (Task 5.4 Site 6302)', () => {
  function legacyBreakdownShape({
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
    const basePremiumTotal = Array.from(basePremiumByProductId.values())
      .reduce((s, v) => s + Number(v || 0), 0);
    const systemFees = productProcessingFeesUtil.calculateSystemFeeAmount({
      subscriptionFeeSettingsByProductId,
      basePremiumTotal,
      systemFeesSettings
    });
    return {
      chargeFeeToMemberEnabled: breakdown.chargeFeeToMemberEnabled,
      includedProcessingFeeTotal: round2(breakdown.includedProcessingFeeTotal),
      nonIncludedPremiumSubtotal: round2(breakdown.nonIncludedPremiumSubtotal),
      nonIncludedProcessingFeeAmount: round2(breakdown.nonIncludedProcessingFeeAmount),
      includedProcessingFeeByProductId: breakdown.includedProcessingFeeByProductId,
      systemFeesAmount: round2(systemFees)
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
      includedProcessingFeeByProductId: rawBreakdown.includedProcessingFeeByProductId,
      systemFeesAmount: round2(out.totals.systemFees)
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
        systemFeesSettings: DEFAULT_SYSTEM_FEES_SETTINGS,
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
      expect(authority.systemFeesAmount).toBeCloseTo(legacy.systemFeesAmount, 2);

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
 * SITE 7807 — household/group member persistence block (DB-written fees)
 * Same contract as site 6302; different scope (group-enrollment path). We keep
 * a separate describe block so the two DB-write paths have independent coverage.
 * -------------------------------------------------------------------------- */
describe('enrollment-links /complete-enrollment household-member persistence — breakdown equivalence (Task 5.4 Site 7807)', () => {
  function legacyBreakdownShape({
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
    const basePremiumTotal = Array.from(basePremiumByProductId.values())
      .reduce((s, v) => s + Number(v || 0), 0);
    const systemFees = productProcessingFeesUtil.calculateSystemFeeAmount({
      subscriptionFeeSettingsByProductId,
      basePremiumTotal,
      systemFeesSettings
    });
    return {
      chargeFeeToMemberEnabled: breakdown.chargeFeeToMemberEnabled,
      includedProcessingFeeTotal: round2(breakdown.includedProcessingFeeTotal),
      nonIncludedPremiumSubtotal: round2(breakdown.nonIncludedPremiumSubtotal),
      nonIncludedProcessingFeeAmount: round2(breakdown.nonIncludedProcessingFeeAmount),
      includedProcessingFeeByProductId: breakdown.includedProcessingFeeByProductId,
      systemFeesAmount: round2(systemFees)
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
      includedProcessingFeeByProductId: rawBreakdown.includedProcessingFeeByProductId,
      systemFeesAmount: round2(out.totals.systemFees)
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
        systemFeesSettings: DEFAULT_SYSTEM_FEES_SETTINGS,
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
      expect(authority.systemFeesAmount).toBeCloseTo(legacy.systemFeesAmount, 2);

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
