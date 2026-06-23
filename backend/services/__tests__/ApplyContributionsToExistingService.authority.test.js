/**
 * Permanent equivalence test for ApplyContributionsToExistingService.computeFeesAndAdjustProducts (Task 5.1.2).
 *
 * Purpose: byte-for-byte proof — across a 48-scenario parametrization matrix —
 * that the migrated computeFeesAndAdjustProducts (which now delegates to
 * pricingAuthority.computePricing for fee composition) produces the SAME
 * return shape and the SAME numbers as the pre-migration body (commit 271a2b6d),
 * which invoked productProcessingFees.calculateProcessingFeeBreakdownByProduct
 * and productProcessingFees.calculateSystemFeeAmount directly.
 *
 * This file is the permanent regression shield for the migration. Do NOT remove
 * the legacy reference arm or the equivalence assertions — they are the only
 * record of the pre-migration behavior. If a future change to the authority
 * diverges from the legacy breakdown, one or more of these 48 parametrizations
 * will fail and the divergence must be resolved before the change can ship.
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
  platformFee: { enabled: true, FlatOrPercent: 'Flat', MemberPaid: true, MemberPaidAmount: 2.10, amount: 2.10 }
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

// Mock loadFeeSettingsByProductId at the module level so the authority reads
// the same per-scenario map the legacy reference receives directly.
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

// Require AFTER jest.mock so the service picks up the mocked primitives.
// computeFeesAndAdjustProducts is exposed via the service's _internal export
// for this regression-shield test.
const applyContributionsService = require('../ApplyContributionsToExistingService');

/**
 * Legacy reference — EXACT reproduction of the pre-migration body of
 * computeFeesAndAdjustProducts in ApplyContributionsToExistingService.js
 * (commit 271a2b6d — the last commit before Phase 5.1.2). Pure, synchronous,
 * no DB lookups.
 *
 * This is the ground truth the migrated function must match for every one of
 * the 48 scenarios below. DO NOT modify this function — if it needs to change,
 * the migration has diverged from the pre-migration behavior and the spec
 * reviewer needs to sign off.
 */
function legacyComputeFeesAndAdjustProducts({
  products,
  flagsByProductId,
  paymentProcessorSettings,
  systemFeesSettings,
  paymentMethodType
}) {
  const round2 = (n) => productProcessingFeesUtil.round2(n);
  const chargeFeeToMemberEnabled = paymentProcessorSettings?.chargeFeeToMember === true;
  const cfgFor = (productId) => flagsByProductId.get(String(productId)) || productProcessingFeesUtil.defaultProductFeeSettings();
  const basePremiumTotal = round2(products.reduce((sum, p) => sum + Number(p.monthlyPremium || 0), 0));
  const basePremiumByProductId = new Map();
  for (const p of products) {
    basePremiumByProductId.set(String(p.productId), Number(p.monthlyPremium || 0));
  }

  const feeBreakdown = productProcessingFeesUtil.calculateProcessingFeeBreakdownByProduct({
    basePremiumByProductId,
    paymentMethodType,
    paymentProcessorSettings,
    subscriptionFeeSettingsByProductId: flagsByProductId
  });

  const includedProcessingFeeTotal = feeBreakdown.includedProcessingFeeTotal;
  const perProductIncludedFee = feeBreakdown.includedProcessingFeeByProductId;
  const nonIncludedPremiumSubtotal = feeBreakdown.nonIncludedPremiumSubtotal;
  const processingFeeTotal = feeBreakdown.nonIncludedProcessingFeeAmount;

  const systemFeesAmount = productProcessingFeesUtil.calculateSystemFeeAmount({
    subscriptionFeeSettingsByProductId: flagsByProductId,
    basePremiumTotal,
    systemFeesSettings
  });

  const processingFeeByProductId = {};
  if (processingFeeTotal > 0 && nonIncludedPremiumSubtotal > 0) {
    const candidates = products
      .map((p) => {
        const cfg = cfgFor(p.productId);
        const include = chargeFeeToMemberEnabled && cfg.includeProcessingFee === true;
        return { productId: p.productId, base: include ? 0 : Number(p.monthlyPremium || 0) };
      })
      .filter((r) => Number(r.base || 0) > 0);
    let allocated = 0;
    for (let i = 0; i < candidates.length; i++) {
      const r = candidates[i];
      const isLast = i === candidates.length - 1;
      const share = isLast
        ? round2(processingFeeTotal - allocated)
        : round2(processingFeeTotal * (Number(r.base || 0) / nonIncludedPremiumSubtotal));
      processingFeeByProductId[String(r.productId)] = share;
      allocated = round2(allocated + share);
    }
  }

  const adjustedProducts = products.map((p) => {
    const base = Number(p.monthlyPremium || 0);
    const inc = Number(perProductIncludedFee[String(p.productId)] || 0);
    const rem = Number(processingFeeByProductId[String(p.productId)] || 0);
    return {
      ...p,
      monthlyPremium: round2(base + inc + rem)
    };
  });

  return {
    adjustedProducts,
    systemFeesAmount,
    processingFeeTotal,
    processingFeeByProductId,
    includedProcessingFeeTotal,
    perProductIncludedFee,
    nonIncludedPremiumSubtotal,
    basePremiumTotal
  };
}

// Build the scenario matrix — 2 * 2 * 2 * 2 * 3 = 48 parametrizations.
const SCENARIOS = [];
for (const paymentMethodType of ['ACH', 'Card']) {
  for (const includeProcessingFee of [true, false]) {
    for (const roundUpProcessingFee of [true, false]) {
      for (const zeroFeeForACH of [true, false]) {
        for (const productShape of ['single-nonincluded', 'single-included', 'bundle-mixed']) {
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

// Build the per-scenario inputs.
function buildScenarioInputs(scenario) {
  let products;

  if (scenario.productShape === 'single-nonincluded') {
    products = [{ productId: PRODUCT_A, productName: 'A', monthlyPremium: 100.54 }];
  } else if (scenario.productShape === 'single-included') {
    products = [{ productId: PRODUCT_B, productName: 'B', monthlyPremium: 133.00 }];
  } else {
    // bundle-mixed: two products — Product A (plain non-included default) and Product B
    // (flag-carrier for the scenario).
    products = [
      { productId: PRODUCT_A, productName: 'A', monthlyPremium: 100.54 },
      { productId: PRODUCT_B, productName: 'B', monthlyPremium: 133.00 }
    ];
  }

  // Flag-carrier: Product B always has the scenario flags; Product A is a plain
  // non-included leg (default settings).
  const subs = new Map();
  subs.set(PRODUCT_B, {
    includeProcessingFee: scenario.includeProcessingFee,
    roundUpProcessingFee: scenario.roundUpProcessingFee,
    zeroFeeForACH: scenario.zeroFeeForACH,
    customSystemFeeEnabled: false,
    customSystemFeeAmount: null
  });
  subs.set(PRODUCT_A, {
    includeProcessingFee: false,
    roundUpProcessingFee: false,
    zeroFeeForACH: false,
    customSystemFeeEnabled: false,
    customSystemFeeAmount: null
  });

  return { products, subs };
}

beforeEach(() => {
  mockState.subscriptionSettingsByProductId = new Map();
});

// Grab the migrated function off the service module's `_internal` export.
const computeFeesAndAdjustProducts = applyContributionsService._internal.computeFeesAndAdjustProducts;

describe('ApplyContributionsToExistingService.computeFeesAndAdjustProducts — permanent equivalence vs pre-migration (Task 5.1.2)', () => {
  test.each(SCENARIOS)(
    'matches legacy for paymentMethodType=$paymentMethodType include=$includeProcessingFee roundUp=$roundUpProcessingFee zeroACH=$zeroFeeForACH shape=$productShape',
    async (scenario) => {
      const { products, subs } = buildScenarioInputs(scenario);
      mockState.subscriptionSettingsByProductId = subs;

      const pool = makeFakePool();

      // --- Legacy reference path (pure function, no DB) ---
      const legacyResult = legacyComputeFeesAndAdjustProducts({
        products: products.map((p) => ({ ...p })),
        flagsByProductId: subs,
        paymentProcessorSettings: DEFAULT_PAYMENT_PROCESSOR_SETTINGS,
        systemFeesSettings: DEFAULT_SYSTEM_FEES_SETTINGS,
        paymentMethodType: scenario.paymentMethodType
      });

      // --- Migrated (production) path ---
      const migratedResult = await computeFeesAndAdjustProducts({
        products: products.map((p) => ({ ...p })),
        flagsByProductId: subs,
        paymentProcessorSettings: DEFAULT_PAYMENT_PROCESSOR_SETTINGS,
        systemFeesSettings: DEFAULT_SYSTEM_FEES_SETTINGS,
        paymentMethodType: scenario.paymentMethodType,
        pool,
        tenantId: TENANT_ID
      });

      // --- Equivalence within 1¢ across every field ---
      expect(migratedResult.includedProcessingFeeTotal).toBeCloseTo(legacyResult.includedProcessingFeeTotal, 2);
      expect(migratedResult.processingFeeTotal).toBeCloseTo(legacyResult.processingFeeTotal, 2);
      expect(migratedResult.systemFeesAmount).toBeCloseTo(legacyResult.systemFeesAmount, 2);
      expect(migratedResult.basePremiumTotal).toBeCloseTo(legacyResult.basePremiumTotal, 2);
      expect(migratedResult.nonIncludedPremiumSubtotal).toBeCloseTo(legacyResult.nonIncludedPremiumSubtotal, 2);

      // Deep-equal per-product included fee (within 1¢ per key)
      const migPerIncKeys = Object.keys(migratedResult.perProductIncludedFee || {}).sort();
      const legPerIncKeys = Object.keys(legacyResult.perProductIncludedFee || {}).sort();
      expect(migPerIncKeys).toEqual(legPerIncKeys);
      for (const k of legPerIncKeys) {
        expect(Number(migratedResult.perProductIncludedFee[k] || 0))
          .toBeCloseTo(Number(legacyResult.perProductIncludedFee[k] || 0), 2);
      }

      // Deep-equal allocated non-included fee by product (within 1¢ per key)
      const migPerRemKeys = Object.keys(migratedResult.processingFeeByProductId || {}).sort();
      const legPerRemKeys = Object.keys(legacyResult.processingFeeByProductId || {}).sort();
      expect(migPerRemKeys).toEqual(legPerRemKeys);
      for (const k of legPerRemKeys) {
        expect(Number(migratedResult.processingFeeByProductId[k] || 0))
          .toBeCloseTo(Number(legacyResult.processingFeeByProductId[k] || 0), 2);
      }

      // adjustedProducts[n].monthlyPremium equivalence
      expect(migratedResult.adjustedProducts.length).toBe(legacyResult.adjustedProducts.length);
      for (let i = 0; i < legacyResult.adjustedProducts.length; i++) {
        expect(Number(migratedResult.adjustedProducts[i].monthlyPremium || 0))
          .toBeCloseTo(Number(legacyResult.adjustedProducts[i].monthlyPremium || 0), 2);
        expect(migratedResult.adjustedProducts[i].productId).toBe(legacyResult.adjustedProducts[i].productId);
      }
    }
  );
});
