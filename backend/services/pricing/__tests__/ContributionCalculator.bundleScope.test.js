// backend/services/pricing/__tests__/ContributionCalculator.bundleScope.test.js
const ContributionCalculator = require('../ContributionCalculator');

// Stub the pool — the only DB hit in this test path is enrichRulesWithBundleProductIds,
// which queries oe.ProductBundles. Return a deterministic mapping.
//
// enrichRulesWithBundleProductIds calls:
//   const request = pool.request();
//   request.input('pid0', sql.UniqueIdentifier, value);  // mutates request, returns void
//   const result = await request.query(`SELECT ...`);
//
// So `input` must return the same request object (for chaining isn't used here, but
// the call pattern requires query to live on the request itself).
function makePoolStub({ bundleId, componentIds }) {
  return {
    request: () => {
      const req = {
        query: async () => ({
          recordset: componentIds.map(cid => ({
            BundleProductId: bundleId,
            IncludedProductId: cid
          }))
        })
      };
      req.input = () => req;
      return req;
    }
  };
}

describe('ContributionCalculator — bundle-scoped rule must not leak to standalone components', () => {
  const BUNDLE_ID    = '11111111-1111-1111-1111-111111111111';
  const COMPONENT_ID = '22222222-2222-2222-2222-222222222222';

  it('rule on bundle B applies to bundle line, NOT to standalone line that shares a component ProductId', async () => {
    const rules = [{
      Name: 'Bundle 100%',
      ContributionType: 'percentage',
      PercentageAmount: 100,
      ProductId: BUNDLE_ID,
      Status: 'Active',
      Stacking: false,
      Priority: 1
    }];

    const pool = makePoolStub({ bundleId: BUNDLE_ID, componentIds: [COMPONENT_ID] });
    await ContributionCalculator.enrichRulesWithBundleProductIds(rules, pool);

    const productPricingResults = [
      { productId: BUNDLE_ID,    monthlyPremium: 500 },   // bundle line
      { productId: COMPONENT_ID, monthlyPremium: 200 }    // standalone line that happens to share a component ProductId
    ];

    const { productContributions } = await ContributionCalculator._applyProductSpecificRules(
      rules,
      productPricingResults,
      { age: 35, tier: 'EE' },
      {},   // equivalentTierBases
      700,  // totalPremium
      0     // additionalFees
    );

    expect(productContributions[BUNDLE_ID]).toBe(500);    // 100% of bundle covered
    expect(productContributions[COMPONENT_ID]).toBe(0);   // standalone NOT covered (this assertion is the bug repro)
  });

  it('rule on bundle B still applies to the bundle line when a component is also priced as part of that bundle (parentBundleId set)', async () => {
    const rules = [{
      Name: 'Bundle 100%',
      ContributionType: 'percentage',
      PercentageAmount: 100,
      ProductId: BUNDLE_ID,
      Status: 'Active',
      Stacking: false,
      Priority: 1
    }];

    const pool = makePoolStub({ bundleId: BUNDLE_ID, componentIds: [COMPONENT_ID] });
    await ContributionCalculator.enrichRulesWithBundleProductIds(rules, pool);

    // Caller indicates this component line is part of the bundle's breakdown.
    // Today the matcher doesn't read parentBundleId; Task 3 will add that. Either way,
    // the bundle line should get its 100% contribution.
    const productPricingResults = [
      { productId: BUNDLE_ID,    monthlyPremium: 500 },
      { productId: COMPONENT_ID, monthlyPremium: 0, parentBundleId: BUNDLE_ID }
    ];

    const { productContributions } = await ContributionCalculator._applyProductSpecificRules(
      rules,
      productPricingResults,
      { age: 35, tier: 'EE' },
      {},
      500,
      0
    );

    expect(productContributions[BUNDLE_ID]).toBe(500);
  });

  it('recalc shape: bundle stored as decomposed component lines (no bundle line, each child carries parentBundleId) — bundle rule still covers each child', async () => {
    // Mirrors how oe.Enrollments stores a bundle: one row per child with ProductBundleID set
    // pointing at the parent bundle (no separate row for the bundle itself).
    // ApplyContributionsToExistingService maps these into productPricingResults with
    // parentBundleId carried through, so the bundle's contribution rule must still apply.
    const COMPONENT_A = '33333333-3333-3333-3333-333333333333';
    const COMPONENT_B = '44444444-4444-4444-4444-444444444444';

    const rules = [{
      Name: 'Bundle 100%',
      ContributionType: 'percentage',
      PercentageAmount: 100,
      ProductId: BUNDLE_ID,
      Status: 'Active',
      Stacking: false,
      Priority: 1
    }];

    const pool = makePoolStub({ bundleId: BUNDLE_ID, componentIds: [COMPONENT_A, COMPONENT_B] });
    await ContributionCalculator.enrichRulesWithBundleProductIds(rules, pool);

    const productPricingResults = [
      { productId: COMPONENT_A, monthlyPremium: 200, parentBundleId: BUNDLE_ID },
      { productId: COMPONENT_B, monthlyPremium: 300, parentBundleId: BUNDLE_ID }
    ];

    const { productContributions } = await ContributionCalculator._applyProductSpecificRules(
      rules,
      productPricingResults,
      { age: 35, tier: 'EE' },
      {},
      500,
      0
    );

    expect(productContributions[COMPONENT_A]).toBe(200);
    expect(productContributions[COMPONENT_B]).toBe(300);
  });
});
