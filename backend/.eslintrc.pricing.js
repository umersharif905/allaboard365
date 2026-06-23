/**
 * Pricing-authority architecture lint rules.
 *
 * Prevents direct imports of the fee primitives outside the authority service,
 * the primitives themselves, and tests. Enforces that new pricing surfaces go
 * through pricingAuthority.computePricing (single source of truth).
 *
 * To enable:
 *   npx eslint --rulesdir .eslintrc.pricing.js .
 * Or wire via `overrides` in the repo-root ESLint config.
 */

const FEE_COMPOSITION_MSG =
  'Use pricingAuthority.computePricing instead. calculateProcessingFeeBreakdownByProduct ' +
  'is the multi-product fee-composition primitive reserved for the authority service, so ' +
  'the pricingFingerprint covers every surface consistently. ' +
  'NOTE: the scalar primitive calculateIncludedProcessingFeeForDisplay (applies included-fee ' +
  'math to ONE amount) remains allowed for per-amount display math — it does not compose ' +
  'totals across products. Utility helpers like loadSubscriptionFeeSettingsByProductId ' +
  'or defaultProductFeeSettings are also allowed.';

module.exports = {
  rules: {
    // Flag multi-product fee composition anywhere outside the authority service.
    // Scope: ONLY calculateProcessingFeeBreakdownByProduct, because that's the call
    // that composes multi-product totals. The scalar calculateIncludedProcessingFeeForDisplay
    // primitive (one amount → one fee) is legitimately used by display-layer code that
    // doesn't produce a pricingFingerprint, so it is NOT flagged by this rule.
    'no-restricted-syntax': [
      'error',
      {
        selector: "CallExpression[callee.property.name='calculateProcessingFeeBreakdownByProduct']",
        message: FEE_COMPOSITION_MSG
      },
      // Also catch direct-name calls (e.g. when imported via destructuring).
      {
        selector: "CallExpression[callee.name='calculateProcessingFeeBreakdownByProduct']",
        message: FEE_COMPOSITION_MSG
      }
    ]
  }
};
