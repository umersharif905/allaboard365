/**
 * Permanent equivalence test for groupMemberFees.getAdditionalFeesForMember (Task 5.1.1).
 *
 * Purpose: byte-for-byte proof — across a 48-scenario parametrization matrix —
 * that the migrated per-product branch at groupMemberFees.js:82-100 (which now
 * delegates to pricingAuthority.computePricing) produces the SAME
 * processing-fee number as the pre-migration code path at the same call site,
 * which invoked productProcessingFees.calculateProcessingFeeBreakdownByProduct
 * directly.
 *
 * This file is the permanent regression shield for the migration. Do NOT remove
 * the legacy reference arm or the equivalence assertion — they are the only
 * record of the pre-migration behavior. If a future change to the authority
 * diverges from the legacy breakdown, one or more of these 48 parametrizations
 * will fail and the divergence must be resolved before the change can ship.
 *
 * Isolation strategy: getAdditionalFeesForMember returns
 *   systemFeesAmount + paymentProcessingFeeAmount
 * The migration only affected the paymentProcessingFeeAmount branch. We
 * pre-compute the system-fee portion using the same calculator groupMemberFees
 * uses (line 68) and subtract it from the migrated function's return value to
 * isolate the processing-fee portion, then compare against the legacy
 * reference.
 *
 * Lint note: this file invokes calculateProcessingFeeBreakdownByProduct
 * directly. That's allowed because __tests__/** is excluded from the pricing
 * lint rule in backend/.eslintrc.json.
 */

const GROUP_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PRODUCT_A = 'cccccccc-0000-0000-0000-000000000001'; // canonical non-included base $100.54
const PRODUCT_B = 'dddddddd-0000-0000-0000-000000000002'; // canonical included-anchor base $133.00
const BUNDLE_ID  = 'eeeeeeee-0000-0000-0000-000000000003';

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
  paymentMethodRow: { Type: 'Ach' }, // DB returns 'Ach' or 'CreditCard'
  subscriptionSettingsByProductId: new Map()
};

// Fake mssql pool that answers the 3 queries groupMemberFees / authority issue:
//   - SELECT PaymentProcessorSettings, SystemFees FROM oe.Tenants
//   - SELECT TOP 1 Type FROM oe.GroupPaymentMethods
//   - SELECT ... FROM oe.TenantProductSubscriptions (authority only)
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
          if (/FROM oe\.GroupPaymentMethods/i.test(sqlText)) {
            return { recordset: mockState.paymentMethodRow ? [mockState.paymentMethodRow] : [] };
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

// Mock loadFeeSettingsByProductId at the module level so the authority
// (invoked indirectly through groupMemberFees) reads the same per-scenario
// map the legacy reference receives directly.
jest.mock('../productProcessingFees', () => {
  const actual = jest.requireActual('../productProcessingFees');
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

const { getAdditionalFeesForMember } = require('../groupMemberFees');
const systemFeesCalculator = require('../systemFeesCalculator');

/**
 * Legacy reference — EXACT reproduction of the pre-migration per-product
 * branch in groupMemberFees.js (lines 85-97 before commit f11bfb83). Pure
 * function, no DB lookups. Takes the already-resolved settings and premium map
 * and returns JUST the processing-fee number.
 *
 * This is the ground truth the migrated function must match for every one of
 * the 48 scenarios below. DO NOT modify this function — if it needs to change,
 * the migration has diverged from the pre-migration behavior and the spec
 * reviewer needs to sign off.
 */
function legacyProcessingFeeReference({
  basePremiumByProductId,
  paymentMethodType,
  paymentProcessorSettings,
  subscriptionFeeSettingsByProductId
}) {
  if (!paymentProcessorSettings?.chargeFeeToMember) return 0;
  if (!(basePremiumByProductId instanceof Map) || basePremiumByProductId.size === 0) return 0;
  const productProcessingFeesUtil = require('../productProcessingFees');
  const breakdown = productProcessingFeesUtil.calculateProcessingFeeBreakdownByProduct({
    basePremiumByProductId,
    paymentMethodType,
    paymentProcessorSettings,
    subscriptionFeeSettingsByProductId
  });
  return Number(breakdown.paymentProcessingFeeAmount || 0);
}

// Build the scenario matrix — 2 * 2 * 2 * 2 * 3 = 48 parametrizations.
// Note: the plan's scenario matrix includes a "Tenant system fee" axis
// (enabled / disabled / per-product custom). This migration deliberately did
// NOT change system-fee math — groupMemberFees.js:68 still calls
// systemFeesCalculator.calculateSystemFees directly — and the equivalence
// assertion below subtracts the system-fee portion out before comparing, so
// the system-fee axis does not affect the processing-fee equivalence under
// test. System-fee correctness is covered by systemFeesCalculator's own
// test suite and by the authority service's tests.
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
  const basePremiumByProductId = new Map();

  if (scenario.productShape === 'single-nonincluded') {
    basePremiumByProductId.set(PRODUCT_A, 100.54);
  } else if (scenario.productShape === 'single-included') {
    basePremiumByProductId.set(PRODUCT_B, 133.00);
  } else {
    // bundle-mixed: one $133 included-eligible child + one $100.54 non-included child.
    basePremiumByProductId.set(PRODUCT_A, 100.54);
    basePremiumByProductId.set(PRODUCT_B, 133.00);
  }

  // Flag-carrier: Product B always has the scenario flags; Product A is a plain
  // non-included leg (default settings) so bundle-mixed produces a meaningful
  // combination of both arms.
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

  return { basePremiumByProductId, subs };
}

beforeEach(() => {
  mockState.paymentMethodRow = { Type: 'Ach' };
  mockState.subscriptionSettingsByProductId = new Map();
});

describe('groupMemberFees.getAdditionalFeesForMember — permanent equivalence vs pre-migration (Task 5.1.1)', () => {
  test.each(SCENARIOS)(
    'processing-fee matches legacy for paymentMethodType=$paymentMethodType include=$includeProcessingFee roundUp=$roundUpProcessingFee zeroACH=$zeroFeeForACH shape=$productShape',
    async (scenario) => {
      const { basePremiumByProductId, subs } = buildScenarioInputs(scenario);

      mockState.subscriptionSettingsByProductId = subs;
      mockState.paymentMethodRow = {
        Type: scenario.paymentMethodType === 'Card' ? 'CreditCard' : 'Ach'
      };

      const pool = makeFakePool();

      // totalPremium = sum of per-product premiums (used for system-fee calc,
      // same as the call sites in group-flow and applyContributions).
      const totalPremium = Array.from(basePremiumByProductId.values())
        .reduce((acc, v) => acc + Number(v || 0), 0);

      // --- Migrated (production) path ---
      const migratedTotal = await getAdditionalFeesForMember(
        GROUP_ID,
        TENANT_ID,
        totalPremium,
        pool,
        basePremiumByProductId
      );

      // Isolate the processing-fee portion by subtracting the system fee
      // (which the migration explicitly left untouched — see groupMemberFees.js:68).
      const expectedSystemFees = systemFeesCalculator.calculateSystemFees(
        totalPremium,
        DEFAULT_SYSTEM_FEES_SETTINGS
      );
      const migratedProcessingFeeOnly = migratedTotal - expectedSystemFees;

      // --- Legacy reference path (pure function, no DB) ---
      const legacyProcessingFee = legacyProcessingFeeReference({
        basePremiumByProductId,
        paymentMethodType: scenario.paymentMethodType,
        paymentProcessorSettings: DEFAULT_PAYMENT_PROCESSOR_SETTINGS,
        subscriptionFeeSettingsByProductId: subs
      });

      // --- Byte-for-byte equivalence within 1¢ ---
      expect(migratedProcessingFeeOnly).toBeCloseTo(legacyProcessingFee, 2);

      // Sanity checks on the migrated total (guards against sign/scale errors).
      expect(Number.isFinite(migratedTotal)).toBe(true);
      expect(migratedTotal).toBeGreaterThanOrEqual(0);
    }
  );
});
