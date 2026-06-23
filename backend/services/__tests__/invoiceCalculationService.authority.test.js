/**
 * Permanent equivalence test for invoiceCalculationService.calculateLocationFees
 * (Phase 5.7 — final Pricing Authority migration).
 *
 * Purpose: parallel-compute proof — across a 108-scenario parametrization matrix —
 * that the migrated calculateLocationFees (which now delegates to the canonical
 * processing-fee primitive in utils/processingFeeCalculator.js) produces the SAME
 * return shape and the SAME numbers as the pre-migration inline math at
 * backend/services/invoiceCalculationService.js:87-103 (commit 271a2b6d — last
 * commit before Phase 5.7).
 *
 * This file is the permanent regression shield for the migration. Do NOT remove
 * the legacy reference arm or the equivalence assertions — they are the only
 * record of the pre-migration behavior. If a future change to the primitive or
 * the service diverges from the legacy breakdown, one or more of these 108
 * parametrizations will fail and the divergence must be resolved before the
 * change can ship.
 *
 * Design note: invoiceCalculationService.calculateLocationFees operates on a
 * flat basePremium total (one number), not a pricingProducts array. The
 * authority's computePricing entry point expects per-product inputs, so it's
 * the wrong abstraction here. Instead, calculateLocationFees now calls the
 * scalar primitive calculateProcessingFee directly — the same primitive the
 * authority calls internally. This keeps invoice preview math and authority
 * enrollment math pinned to a single source of truth.
 *
 * Lint note: this file exercises both the pre- and post-migration code paths
 * directly, which is allowed — __tests__/** is excluded from the pricing lint
 * rule in backend/.eslintrc.json.
 */

const invoiceCalculationService = require('../invoiceCalculationService');

// MightyWELL-style paymentProcessorSettings per
// docs/pricing-authority/pricing-authority-numbers-test-plan.md: ACH 0.8%, Card 3%, flat $0.
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

/**
 * Legacy reference — EXACT reproduction of the pre-migration body of
 * calculateLocationFees at backend/services/invoiceCalculationService.js:67-119
 * (commit 271a2b6d — the last commit before Phase 5.7). Pure, synchronous.
 *
 * This is the ground truth the migrated function must match for every one of
 * the 108 scenarios below. DO NOT modify this function — if it needs to change,
 * the migration has diverged from the pre-migration behavior and the spec
 * reviewer needs to sign off.
 */
function legacyCalculateLocationFees(
  basePremium,
  householdCount,
  paymentMethodType,
  systemFeesSettings,
  paymentProcessorSettings,
  unpaidSetupFees = 0
) {
  // System-fee subtotal — identical to the service's calculateGroupMonthlyTotal,
  // which is NOT migrated in Phase 5.7. Reuse directly from the service so the
  // legacy reference and the production function share the (unchanged) system-fee
  // path and the test isolates the processing-fee drift site.
  const subtotalWithSystemFees = invoiceCalculationService.calculateGroupMonthlyTotal(
    basePremium,
    householdCount,
    systemFeesSettings
  );

  const systemFeesAmount = Math.round((subtotalWithSystemFees - basePremium) * 100) / 100;

  // --- BEGIN pre-migration inline processing-fee formula (the drift site) ---
  let paymentProcessingFee = 0;

  const processors = paymentProcessorSettings?.processors || {};
  const activeKey = paymentProcessorSettings?.activeProcessor
    ? String(paymentProcessorSettings.activeProcessor)
    : null;
  const activeProcessor = activeKey && processors ? processors[activeKey] : null;
  const fallbackProcessor = processors?.openenroll || null;
  const processorToUse = activeProcessor || fallbackProcessor;
  const fees = processorToUse?.fees;

  if (paymentProcessorSettings?.chargeFeeToMember && fees) {
    const feeConfig =
      (paymentMethodType === 'Card' || paymentMethodType === 'CreditCard')
        ? fees.creditCard
        : fees.ach;

    if (feeConfig) {
      let percentageValue = feeConfig.percentageFee || 0;

      // Handle both decimal (0.0025 = 0.25%) and whole number (3 = 3%) formats
      if (percentageValue >= 1) {
        percentageValue = percentageValue / 100;
      }

      const percentageFee = subtotalWithSystemFees * percentageValue;
      const flatFee = feeConfig.flatFee || 0;
      // Processing fees ALWAYS round UP to nearest cent
      paymentProcessingFee = Math.ceil((percentageFee + flatFee) * 100) / 100;
    }
  }
  // --- END pre-migration inline processing-fee formula ---

  const setupFeesAmount = Math.round((unpaidSetupFees || 0) * 100) / 100;

  const totalAmount = Math.round(
    (subtotalWithSystemFees + paymentProcessingFee + setupFeesAmount) * 100
  ) / 100;
  const processingFees = Math.round(
    (systemFeesAmount + paymentProcessingFee) * 100
  ) / 100;

  return {
    systemFeesAmount,
    paymentProcessingFee,
    setupFeesAmount,
    totalAmount,
    processingFees,
    subtotalWithSystemFees
  };
}

// Build the scenario matrix — 3 * 3 * 3 * 2 * 2 = 108 parametrizations.
const SCENARIOS = [];
for (const paymentMethodType of ['ACH', 'Card', 'CreditCard']) {
  for (const basePremium of [500, 1000, 5000]) {
    for (const householdCount of [1, 5, 20]) {
      for (const chargeFeeToMember of [true, false]) {
        for (const unpaidSetupFees of [0, 150]) {
          SCENARIOS.push({
            paymentMethodType,
            basePremium,
            householdCount,
            chargeFeeToMember,
            unpaidSetupFees
          });
        }
      }
    }
  }
}

describe('invoiceCalculationService.calculateLocationFees — permanent equivalence vs pre-migration (Phase 5.7)', () => {
  test.each(SCENARIOS)(
    'matches legacy for method=$paymentMethodType basePremium=$basePremium households=$householdCount chargeFee=$chargeFeeToMember setupFees=$unpaidSetupFees',
    (scenario) => {
      const paymentProcessorSettings = {
        ...DEFAULT_PAYMENT_PROCESSOR_SETTINGS,
        chargeFeeToMember: scenario.chargeFeeToMember
      };

      const legacyResult = legacyCalculateLocationFees(
        scenario.basePremium,
        scenario.householdCount,
        scenario.paymentMethodType,
        DEFAULT_SYSTEM_FEES_SETTINGS,
        paymentProcessorSettings,
        scenario.unpaidSetupFees
      );

      const migratedResult = invoiceCalculationService.calculateLocationFees(
        scenario.basePremium,
        scenario.householdCount,
        scenario.paymentMethodType,
        DEFAULT_SYSTEM_FEES_SETTINGS,
        paymentProcessorSettings,
        scenario.unpaidSetupFees
      );

      // Equivalence within 1¢ across every returned field.
      expect(migratedResult.systemFeesAmount).toBeCloseTo(legacyResult.systemFeesAmount, 2);
      expect(migratedResult.paymentProcessingFee).toBeCloseTo(legacyResult.paymentProcessingFee, 2);
      expect(migratedResult.setupFeesAmount).toBeCloseTo(legacyResult.setupFeesAmount, 2);
      expect(migratedResult.totalAmount).toBeCloseTo(legacyResult.totalAmount, 2);
      expect(migratedResult.processingFees).toBeCloseTo(legacyResult.processingFees, 2);
      expect(migratedResult.subtotalWithSystemFees).toBeCloseTo(legacyResult.subtotalWithSystemFees, 2);
    }
  );
});
