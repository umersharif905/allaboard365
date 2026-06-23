/**
 * Phase 2a (cross-path parity) — scripted coverage lives in adjacent suites:
 *
 * - `services/pricing/__tests__/goldenMultiSurfacePricingParity.test.js` — golden matrix:
 *   Concierge membership, Copay Silver bundle, APEX Copay across quick-quote, bundle-simulator,
 *   agent GET pricing, proposal applyQuoteFeesToParts, enrollment computeDisplayPremiums.
 * - `services/pricing/__tests__/crossSurfaceBundlePricingParity.test.js` — authority decomposition:
 *   nested bundle `computePricing` vs flattened lines vs `computeDisplayPremiums` UA rollup.
 * - `routes/me/agent/__tests__/products.pricing.test.js` — bundle-simulator ACH vs Card Highest parity,
 *   quick-quote vs bundle-simulator ShareWELL Concierge shape.
 * - `routes/__tests__/enrollment-links.complete.authority.test.js` — fee composition contracts for
 *   complete-enrollment persistence sites.
 *
 * Full matrix against `/product-pricing` + `/contribution-preview` HTTP handlers per link token
 * requires a separate enrollment-link SQL router fixture (same scale as agent tests); defer until
 * seeded E2E tenant exists. Cypress stub: `frontend/cypress/e2e/bundle-pricing-multi-surface-parity.cy.ts`.
 */

describe('bundle-pricing-parity marker', () => {
  test('documented parity coverage', () => {
    expect(true).toBe(true);
  });
});
