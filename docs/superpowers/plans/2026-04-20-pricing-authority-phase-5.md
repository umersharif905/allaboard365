# Pricing Authority Migration — Phase 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the remaining 20 ESLint warnings from the pricing-authority drift rule by migrating every remaining ad-hoc callsite of `productProcessingFeesUtil.calculateProcessingFeeBreakdownByProduct` (+ companion `calculateSystemFeeAmount` calls + frontend fallback math) to call `pricingAuthority.computePricing`. Leaves zero code paths that re-derive fee semantics.

**Architecture:** Risk-ordered phased migration. Each phase leaves the tree green. For every migration site, the task writes a **parallel-compute equivalence test** (invokes BOTH the old ad-hoc path and the new `pricingAuthority` path with identical inputs, asserts outputs match within 1¢), then flips the production code to the new path, then re-runs the test (now both halves call authority — becomes a tautology proving no regression), then removes the old path and the test. This guarantees byte-identical behavior before a single production line changes.

**Behavior-preservation contract (the core user-facing promise of this migration):**

> Every surface that currently computes a fee MUST produce the exact same number after migration for every valid input combination. No user-visible display moves. No DB write value changes. No charge amount changes.

The parallel-compute tests in this plan are not optional safety nets — they are the evidence that this contract holds. A task cannot be marked complete until its equivalence test passes across the **full scenario matrix** below.

**Scenario matrix (every equivalence test MUST cover):**

Each test uses `test.each` to parametrize across this matrix, plus any site-specific input shape:

| Axis | Values | Exercises |
|---|---|---|
| `paymentMethodType` | `'ACH'`, `'Card'` | Rule 1 (included) vs Rule 2 (non-included) fee source |
| `IncludeProcessingFee` | `true`, `false` | Which fee bucket applies |
| `RoundUpProcessingFee` | `true`, `false` | Rule 3 (round-up to whole dollar) |
| `ZeroFeeForACH` | `true`, `false` | Rule 4 (ACH zero override) |
| Product shape | single non-included, single included, bundle (mixed children) | Rule 5 (bundle sums children) |
| Tenant system fee | enabled, disabled, per-product custom | Rule 6 (order-level system fees) |

That's a minimum of 24 parametrizations per site test. Use the canonical MightyWELL numbers from `docs/pricing-authority/pricing-authority-numbers-test-plan.md` (Tests 1–7) as the concrete fixtures so any failure is immediately greppable against a known-good spec. When a site under test only exposes a subset of this matrix (e.g., `groupMemberFees.js` always uses one payment method per call), the irrelevant axes collapse — but the test MUST still show `test.each` exercised the applicable axes, not silently skip them.

**Tech Stack:** Node 22, Jest for backend (mssql pool + transaction mocking); React 18, TypeScript, Vitest for frontend; Azure SQL Server via `mssql`. Branch: `feat/pricing-authority-phase-2` (yes, Phase 5 lands on the Phase-2 branch — all phases have staged here).

**Scope recap (from Phase 3+4 report):**
- Phases 1–4: 7 display/charge surfaces migrated (`/contribution-preview`, `/complete-enrollment` validator, agent products/bundle/quick-quote, proposalCalculation, planModification.computeNewPlanCost, EnrollmentCompletionService).
- Phase 5 (this plan): the 20 lint warnings — spread across 6 backend files and 1 frontend file.

**Policy (enforced by `pricingAuthority.computePricing` — NEVER re-implement at any site):**
- Included fees (`IncludeProcessingFee=true`): `'Highest'` policy, baked into display premium.
- Non-included fees: member's actual `paymentMethodType`.
- `zeroFeeForACH` honored per-subscription.
- `roundUpProcessingFee` honored per-subscription (`Math.ceil` to whole dollar).
- System fees: computed on base premium (pre-fee) total, with per-subscription `customSystemFeeEnabled` override.

---

## File Structure

### Files modified

| File | Phase | What changes |
|---|---|---|
| `backend/utils/groupMemberFees.js` | 5.1 | `getAdditionalFeesForMember` delegates to `pricingAuthority.computePricing`. |
| `backend/services/ApplyContributionsToExistingService.js` | 5.1 | Internal fee-allocation loop replaced with authority call; per-product allocation read from `authority._raw.feeBreakdown`. |
| `backend/services/plan-modifications/planModification.service.js` | 5.2 | Three internal fee-math blocks (lines 1318, 1906, 2020) replaced with authority calls. |
| `backend/routes/enrollment-links.js` | 5.3 | `/product-pricing` endpoint: one coordinated refactor replaces 7 callsites (lines 10844, 10856, 11043, 11277, 11382, 11463 + implicit). |
| `backend/routes/enrollment-links.js` | 5.4 | `/complete-enrollment` persistence blocks (lines 6302, 7807) and pre-charge block (line 3766) replaced with authority. |
| `backend/routes/enrollment-links.js` | 5.4 | Line 5623 — delegate fingerprint validation path to `pricingAuthority.verifyFingerprint`. |
| `backend/routes/me/member/product-changes-complete.js` | 5.5 | Two fee sites (lines 1955, 3109) replaced with authority. |
| `frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx` | 5.6 | Delete local `calculateIncludedProcessingFeeForDisplay` (line 371) and 4 callsites; render from `contributionPreviewData.authority.display` directly. |
| `frontend/src/services/processingFeeCalculator.ts` | 5.6 | Delete all three retained exports (`calculateProcessingFee`, `calculateHighestProcessingFee`, `calculateProcessingFeeWithOptions`) once wizard migrates. |
| `frontend/src/services/feeCalculationService.ts` | 5.6 | Remove re-exports of deleted functions; delete if empty after. |
| `backend/.eslintrc.pricing.js` | 5.7 | Promote `no-restricted-syntax` from `warn` to `error`. |

### New files

| File | Purpose |
|---|---|
| `backend/utils/__tests__/groupMemberFees.authority.test.js` | Equivalence + migration test. |
| `backend/services/__tests__/ApplyContributionsToExistingService.authority.test.js` | Equivalence test for contribution allocation. |
| `backend/services/plan-modifications/__tests__/planModification.expectedFees.test.js` | Equivalence tests for `getExpectedFeesForHousehold` and `getExpectedFeesForGroupPrimaryMember`. |
| `backend/routes/enrollment-links/__tests__/product-pricing.authority.test.js` | Integration equivalence test for `/product-pricing` endpoint response. |
| `backend/routes/enrollment-links/__tests__/complete-enrollment.authority.test.js` | Integration equivalence test for `/complete-enrollment` persistence + pre-charge. |
| `backend/routes/me/member/__tests__/product-changes-complete.authority.test.js` | Equivalence test for `/product-changes-complete`. |

### Files NEVER touched (canonical)

- `backend/utils/includedProcessingFee.js` (primitive)
- `backend/utils/productProcessingFees.js` (composite helper — still called BY authority)
- `backend/services/pricing/pricingAuthority.service.js` (the authority itself)
- `backend/services/pricing/PricingEngine.js`

---

## Helper: the parallel-compute equivalence test pattern

Every migration task uses the same pattern. Here's the canonical shape so subsequent tasks can reference it:

```js
// backend/<suite>/__tests__/<site>.authority.test.js
const sql = require('mssql');

// The two paths we're proving equivalent.
const productProcessingFeesUtil = require('../../utils/productProcessingFees');
const systemFeesCalculator = require('../../utils/systemFeesCalculator');
const pricingAuthority = require('../../services/pricing/pricingAuthority.service');

describe('Equivalence: <site-name>', () => {
  // Shared test fixtures — mimic the real shape of the runtime call.
  const tenantId = 'E4F5...'; // test tenant, MightyWELL-style: ACH 0.8%, Card 3%, flat $0.
  const paymentProcessorSettings = {
    chargeFeeToMember: true,
    achProcessingFeePercentage: 0.008,
    cardProcessingFeePercentage: 0.03,
    achProcessingFeeFlat: 0,
    cardProcessingFeeFlat: 0
  };
  const systemFeesSettings = { memberSystemFee: { enabled: true, amount: 2.10 } };

  const poolMock = { /* returns paymentProcessorSettings + systemFeesSettings on Tenants SELECT */ };

  const subscriptionFeeSettingsByProductId = new Map([
    ['pid-INCLUDED', { includeProcessingFee: true,  roundUpProcessingFee: true,  zeroFeeForACH: false }],
    ['pid-NONINCL',  { includeProcessingFee: false, roundUpProcessingFee: false, zeroFeeForACH: false }],
  ]);
  const basePremiumByProductId = new Map([
    ['pid-INCLUDED', 133.00],
    ['pid-NONINCL', 100.54],
  ]);
  const pricingProducts = [
    { productId: 'pid-INCLUDED', monthlyPremium: 133.00, productName: 'MightyWELL Preventative HSA' },
    { productId: 'pid-NONINCL',  monthlyPremium: 100.54, productName: 'Bento Dental' },
  ];

  test.each([['ACH'], ['Card']])('matches for paymentMethodType=%s', async (paymentMethodType) => {
    // OLD PATH — reproduce the ad-hoc call exactly as the production site does it.
    const oldBreakdown = productProcessingFeesUtil.calculateProcessingFeeBreakdownByProduct({
      basePremiumByProductId,
      paymentMethodType,
      paymentProcessorSettings,
      subscriptionFeeSettingsByProductId
    });
    const oldSystemFees = systemFeesCalculator.calculateSystemFeeAmount({
      subscriptionFeeSettingsByProductId,
      basePremiumTotal: 133.00 + 100.54,
      systemFeesSettings
    });

    // NEW PATH — pricingAuthority.
    const authority = await pricingAuthority.computePricing({
      poolOrTransaction: poolMock,
      tenantId,
      pricingProducts,
      paymentMethodType
    });

    // ASSERT equivalence within 1¢.
    expect(authority.totals.nonIncludedFeeTotal).toBeCloseTo(oldBreakdown.nonIncludedProcessingFeeAmount, 2);
    expect(authority.totals.systemFees).toBeCloseTo(oldSystemFees, 2);
    // Total processing fee (included + non-included) equivalence if the caller uses paymentProcessingFeeAmount:
    expect(authority.totals.nonIncludedFeeTotal + authority.totals.includedFeeTotal)
      .toBeCloseTo(oldBreakdown.paymentProcessingFeeAmount, 2);
  });
});
```

**Why this works:** the test invokes both code paths with identical inputs against identical tenant settings. When we flip production to call only the authority, the test passes trivially (both halves call authority). That trivial pass is the proof the production switch cannot regress the number.

**Keep the old-path arm in the test file permanently.** That arm is the permanent regression shield — anyone editing the authority in a way that changes fee math will trip the equivalence assertions. The `**/__tests__/**` glob in `backend/.eslintrc.json` already excludes tests from the pricing lint rule, so the test can call `productProcessingFeesUtil.calculateProcessingFeeBreakdownByProduct` forever without tripping lint. (Earlier drafts of this plan said to delete the arm in Step 6 — that was wrong; corrected.)

Where the legacy math is too wide to invoke directly (e.g., inline code blocks inside route handlers), write a **legacy reference function** inside the test file that reproduces what the old production code did — a pure function over `{ basePremiumByProductId, paymentProcessorSettings, subscriptionFeeSettingsByProductId, paymentMethodType, systemFeesSettings }`. The test compares the migrated production function's output to the legacy-reference output across the full scenario matrix, every run, forever.

---

## Phase 5.1 — Isolated utilities (lowest blast radius)

Start here because these have no DB side-effects and no payment-flow coupling. If the pattern breaks, it breaks in isolation.

### Task 5.1.1: Migrate `backend/utils/groupMemberFees.js:91`

**Files:**
- Modify: `backend/utils/groupMemberFees.js:44-103` (the `getAdditionalFeesForMember` function)
- Test: `backend/utils/__tests__/groupMemberFees.authority.test.js`

**Context:** `getAdditionalFeesForMember` is a utility called by contribution math. Signature: `async (tenantId, memberId, totalPremium, options)` where `options.basePremiumByProductId` optionally triggers the per-product ZeroFeeForACH-aware path. Return: `{ systemFeeAmount, processingFee, totalFees }`.

Today at line 91 it calls `calculateProcessingFeeBreakdownByProduct` directly. We replace with an authority call constructing `pricingProducts` from the provided Map.

- [ ] **Step 1: Write the parallel-compute equivalence test**

Create `backend/utils/__tests__/groupMemberFees.authority.test.js` using the canonical pattern above, but call `getAdditionalFeesForMember` as the old path and `pricingAuthority.computePricing` as the new path. Assert `oldResult.processingFee` ≈ `authority.totals.nonIncludedFeeTotal + authority.totals.includedFeeTotal` and `oldResult.systemFeeAmount` ≈ `authority.totals.systemFees`.

- [ ] **Step 2: Run the test, expect PASS on old path**

```bash
cd backend && npx jest utils/__tests__/groupMemberFees.authority.test.js -t 'matches for paymentMethodType'
```

Expected: both `ACH` and `Card` parametrizations pass. If they fail, STOP — the old path is doing something the authority doesn't model, and we need to understand why before proceeding.

- [ ] **Step 3: Flip `getAdditionalFeesForMember` to call `pricingAuthority.computePricing`**

Replace lines 80–100 (the entire `if (basePremiumByProductId)` branch) with:

```js
const pricingAuthority = require('../services/pricing/pricingAuthority.service');

// Surgical scope: only the processing-fee assignment inside the per-product
// branch changes. The function's signature, return type (Promise<number>),
// and the system-fee call at line 68 are PRESERVED. Do not change the
// caller-facing return shape — that would ripple to every caller of
// getAdditionalFeesForMember and violate the behavior-preservation contract.
if (basePremiumByProductId instanceof Map && basePremiumByProductId.size > 0) {
  const pricingAuthority = require('../services/pricing/pricingAuthority.service');
  const pricingProducts = Array.from(basePremiumByProductId.entries()).map(([productId, monthlyPremium]) => ({
    productId,
    monthlyPremium: Number(monthlyPremium || 0)
  }));
  const authorityOutput = await pricingAuthority.computePricing({
    poolOrTransaction: pool,
    tenantId,
    pricingProducts,
    paymentMethodType: groupPaymentMethod
  });
  paymentProcessingFeeAmount =
    Number(authorityOutput.totals.nonIncludedFeeTotal || 0) +
    Number(authorityOutput.totals.includedFeeTotal || 0);
}
// else retain legacy flat path — it's a different branch unaffected by this migration.
// The outer `additionalFees = systemFeesAmount + paymentProcessingFeeAmount` at the
// end of the function is unchanged; system-fee math at line 68 stays as-is.
```

- [ ] **Step 4: Re-run the equivalence test**

```bash
cd backend && npx jest utils/__tests__/groupMemberFees.authority.test.js
```

Expected: PASS (both halves now call authority — tautologically equal).

- [ ] **Step 5: Run the full backend suite to catch callers we didn't anticipate**

```bash
cd backend && npx jest --testPathIgnorePatterns=jest.live
```

Expected: no new failures relative to the baseline documented in the Phase 3+4 report (4 pre-existing failing suites are unchanged).

- [ ] **Step 6: Leave the equivalence arm intact.**

The test keeps BOTH the legacy-reference call AND the migrated `getAdditionalFeesForMember` call, and keeps asserting their outputs match within 1¢ across the full scenario matrix. This is the permanent regression shield — it stays in the repo forever. `**/__tests__/**` is already excluded from the pricing lint rule, so calls to `calculateProcessingFeeBreakdownByProduct` in tests do NOT trip lint.

- [ ] **Step 7: Confirm lint warning count dropped**

```bash
cd backend && npx eslint . --quiet 2>&1 | grep -c no-restricted-syntax
```

Expected: `19` (was 20).

- [ ] **Step 8: Commit**

```bash
git add backend/utils/groupMemberFees.js backend/utils/__tests__/groupMemberFees.authority.test.js
git commit -m "feat(pricing): groupMemberFees delegates to pricingAuthority"
```

---

### Task 5.1.2: Migrate `backend/services/ApplyContributionsToExistingService.js:228`

**Files:**
- Modify: `backend/services/ApplyContributionsToExistingService.js:176-285`
- Test: `backend/services/__tests__/ApplyContributionsToExistingService.authority.test.js`

**Context:** The function computes per-product fee allocation used to adjust premiums before feeding ContributionCalculator. Current code at line 228 does the per-product breakdown; line 240 does system fees. Both collapse to one authority call.

- [ ] **Step 1: Write the parallel-compute equivalence test**

Same canonical pattern; the old path calls the service's existing logic via `require(... ApplyContributionsToExistingService)` with a realistic product array; the new path calls `pricingAuthority.computePricing`. Assert `adjustedProducts[n].monthlyPremium` matches between runs.

- [ ] **Step 2: Run test, expect PASS**

```bash
cd backend && npx jest services/__tests__/ApplyContributionsToExistingService.authority.test.js
```

- [ ] **Step 3: Flip the production code**

Replace the block at lines 224-260 (the `basePremiumByProductId` construction + `calculateProcessingFeeBreakdownByProduct` call + `calculateSystemFeeAmount` call + per-product allocation) with:

```js
const pricingAuthority = require('./pricing/pricingAuthority.service');

const pricingProducts = products.map(p => ({
  productId: p.productId,
  monthlyPremium: Number(p.monthlyPremium || 0),
  productName: p.productName
}));
const authorityOutput = await pricingAuthority.computePricing({
  poolOrTransaction: pool,
  tenantId,
  pricingProducts,
  paymentMethodType
});
// Per-product allocation: read from authority._raw.feeBreakdown.byProductId (same shape the old code produced).
const allocationByProductId = authorityOutput._raw.feeBreakdown.byProductId || {};
const adjustedProducts = products.map(p => ({
  ...p,
  monthlyPremium: Number(p.monthlyPremium || 0)
    + Number(allocationByProductId[p.productId]?.nonIncludedProcessingFeeAmount || 0)
    + Number(allocationByProductId[p.productId]?.includedProcessingFeeAmount || 0)
}));
const totalSystemFees = authorityOutput.totals.systemFees;
```

If `authority._raw.feeBreakdown.byProductId` is not already in the expected shape (check the authority service), add a small adapter in the authority itself (NOT here). Do this in a separate PR if needed — DO NOT inline fee math here.

- [ ] **Step 4: Re-run test**

```bash
cd backend && npx jest services/__tests__/ApplyContributionsToExistingService.authority.test.js
```

Expected: PASS.

- [ ] **Step 5: Run full suite**

Same command as Task 5.1.1 Step 5. Expected: no new failures.

- [ ] **Step 6: Keep equivalence arm in test (permanent regression shield). Step 7: Lint count 19 → 18.**

- [ ] **Step 8: Commit**

```bash
git commit -m "feat(pricing): ApplyContributionsToExistingService delegates to pricingAuthority"
```

---

## Phase 5.2 — planModification internal validations

Three sites in `planModification.service.js`. All are read-only validation helpers (no DB writes). Migrate together because they share fixture setup.

### Task 5.2.1: Migrate `computeNonIncludedProcessingFee` closure (line 1318)

**Files:**
- Modify: `backend/services/plan-modifications/planModification.service.js:1316-1325` (the closure)
- Test: `backend/services/plan-modifications/__tests__/planModification.expectedFees.test.js`

**Context:** Closure inside the plan-modification cost path. Called twice (ACH leg + Card leg) to detect whether switching payment method would change the quoted charge. Returns a single scalar.

- [ ] **Step 1: Write equivalence test**

Canonical parallel-compute pattern. Old path: call the closure directly by exporting it under a test-only symbol. New path: `pricingAuthority.computePricing`. Assert `oldResult` ≈ `authority.totals.nonIncludedFeeTotal`.

- [ ] **Step 2: Run test, expect PASS**

- [ ] **Step 3: Flip the closure**

Replace lines 1316-1325 with:

```js
const pricingAuthority = require('../pricing/pricingAuthority.service');

const computeNonIncludedProcessingFee = async (paymentMethodType) => {
  if (!chargeFeeToMemberEnabled || !paymentProcessorSettings) return 0;
  if (nonIncludedBasePremiumByProductId.size === 0) return 0;
  const pricingProducts = Array.from(nonIncludedBasePremiumByProductId.entries())
    .map(([productId, monthlyPremium]) => ({ productId, monthlyPremium: Number(monthlyPremium || 0) }));
  const authorityOutput = await pricingAuthority.computePricing({
    poolOrTransaction: pool,
    tenantId,
    pricingProducts,
    paymentMethodType
  });
  return authorityOutput.totals.nonIncludedFeeTotal;
};
```

Note: the closure becomes `async`. Update the two call sites (search for `computeNonIncludedProcessingFee(` within the same function) to add `await`.

- [ ] **Step 4: Re-run test, expect PASS. Step 5: Run full suite. Step 6: Keep equivalence arm (permanent). Step 7: Lint count 18 → 17.**

- [ ] **Step 8: Commit**

```bash
git commit -m "feat(pricing): planModification non-included fee closure via pricingAuthority"
```

### Task 5.2.2: Migrate `getExpectedFeesForHousehold` (line 1906)

**Files:**
- Modify: `backend/services/plan-modifications/planModification.service.js:1823-1921`
- Test: same file as 5.2.1

**Context:** Pre-charge expected-fee computation for an individual/household. Returns `{ expectedSystemFeeAmount, expectedPaymentProcessingFeeAmount, expectedIncludedProcessingFeeTotal }` consumed by `/complete-enrollment` validation.

- [ ] **Step 1: Add equivalence test in same file.** Old path: call `planMod.getExpectedFeesForHousehold(...)`. New path: `pricingAuthority.computePricing(...)`. Assert matching fields.

- [ ] **Step 2: Run test, expect PASS.**

- [ ] **Step 3: Flip the function body.** Replace the entire computation block (lines 1870-1920) with:

```js
const pricingAuthority = require('../pricing/pricingAuthority.service');

const pricingProducts = buildPricingProductsFromEnrollments(enrollments); // helper — defined once near top of file; returns bundle-aware array
const authorityOutput = await pricingAuthority.computePricing({
  poolOrTransaction: pool,
  tenantId,
  pricingProducts,
  paymentMethodType
});

return {
  expectedSystemFeeAmount: authorityOutput.totals.systemFees,
  expectedPaymentProcessingFeeAmount:
    authorityOutput.totals.nonIncludedFeeTotal + authorityOutput.totals.includedFeeTotal,
  expectedIncludedProcessingFeeTotal: authorityOutput.totals.includedFeeTotal
};
```

Define `buildPricingProductsFromEnrollments` near the top of the file if not already present — it reads the enrollments list and constructs `{ productId, monthlyPremium, isBundle, includedProducts, productName }`. If the file already has a similar helper for `computeNewPlanCost`, reuse it (DRY).

- [ ] **Step 4: Re-run test. Step 5: Full suite. Step 6: Keep equivalence arm (permanent). Step 7: Lint count 17 → 16.**

- [ ] **Step 8: Commit**

```bash
git commit -m "feat(pricing): getExpectedFeesForHousehold via pricingAuthority"
```

### Task 5.2.3: Migrate `getExpectedFeesForGroupPrimaryMember` (line 2020)

**Files:**
- Modify: `backend/services/plan-modifications/planModification.service.js:1928-2035`
- Test: same file

**Context:** Same shape as 5.2.2 but for group primary members — uses the group's active `paymentMethod` (looked up from group row) instead of individual choice.

- [ ] **Step 1: Add equivalence test pair (ACH + Card).**

- [ ] **Step 2: Run test, expect PASS.**

- [ ] **Step 3: Flip the function body.** Same pattern as 5.2.2 but source `paymentMethodType` from the group lookup at lines 2007-2013. Use the shared `buildPricingProductsFromEnrollments` helper.

- [ ] **Step 4: Re-run test. Step 5: Full suite. Step 6: Keep equivalence arm (permanent). Step 7: Lint count 16 → 15.**

- [ ] **Step 8: Commit**

```bash
git commit -m "feat(pricing): getExpectedFeesForGroupPrimaryMember via pricingAuthority"
```

---

## Phase 5.3 — `/product-pricing` endpoint consolidation

Six separate callsites in this one endpoint, but they all compute fractions of the same response object. One coordinated refactor replaces all six. This is the biggest single task in the plan — do it in one atomic commit with end-to-end integration test coverage.

### Task 5.3.1: Integration equivalence snapshot test for `/product-pricing`

**Files:**
- Test: `backend/routes/enrollment-links/__tests__/product-pricing.authority.test.js`

**Context:** Before touching the endpoint, capture its current response shape as a snapshot against three representative scenarios:
1. Individual enrollment, single non-included product (Bento Dental EE, ACH).
2. Individual enrollment, single included product (MightyWELL Preventative HSA EE, Card).
3. Bundle enrollment (HSA Preventative Individual bundle, EE, ACH).

- [ ] **Step 1: Write the snapshot test**

Use supertest to hit the real route with mocked pool. Assert `response.body.data.fees.processingFee`, `response.body.data.fees.systemFeesAmount`, `response.body.data.totals.*`, `response.body.data.pricingFingerprint`.

```js
const request = require('supertest');
const app = require('../../../app');

describe('/enrollment-links/:token/product-pricing authority equivalence', () => {
  test.each([
    ['individual non-included ACH', { products: ['pid-NONINCL'], tier: 'EE', paymentMethodType: 'ACH' }],
    ['individual included Card',    { products: ['pid-INCLUDED'], tier: 'EE', paymentMethodType: 'Card' }],
    ['bundle ACH',                  { products: ['pid-BUNDLE'], tier: 'EE', paymentMethodType: 'ACH' }],
  ])('response shape matches snapshot: %s', async (_name, scenario) => {
    const res = await request(app)
      .post(`/api/enrollment-links/${testLinkToken}/product-pricing`)
      .send(scenario)
      .expect(200);
    expect(res.body.data.fees).toMatchInlineSnapshot(/* filled in after first run */);
    expect(res.body.data.pricingFingerprint).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test. Inspect the snapshot output. Verify the numbers match Test 7 of the canonical test plan (`docs/pricing-authority/pricing-authority-numbers-test-plan.md`).**

```bash
cd backend && npx jest routes/enrollment-links/__tests__/product-pricing.authority.test.js -u
```

If snapshot numbers do NOT match Test 7's expectations, STOP — we have a pre-existing bug to understand before migrating.

### Task 5.3.2: Replace all 6 callsites with a single authority call

**Files:**
- Modify: `backend/routes/enrollment-links.js:10000-11500` (the entire `/product-pricing` handler)

- [ ] **Step 1: Read the full handler** from route declaration to `res.json(...)`. Note every `basePremiumByProductId` construction, every `calculateProcessingFeeBreakdownByProduct` call, every `calculateSystemFeeAmount` call, every `calculateIncludedProcessingFeeForDisplay` call, and every place the computed fee flows INTO the response body.

- [ ] **Step 2: Build the `pricingProducts` array ONCE near the top of the handler.**

After the PricingEngine has computed tier premiums and bundle decomposition, build a single bundle-aware `pricingProducts` array. Pass it to `pricingAuthority.computePricing` exactly once.

```js
const pricingAuthority = require('../services/pricing/pricingAuthority.service');

// After PricingEngine returns `pricingResult`:
const pricingProducts = pricingResult.products.map(p => ({
  productId: p.productId,
  monthlyPremium: p.monthlyPremium,
  productName: p.productName,
  isBundle: !!p.isBundle,
  includedProducts: p.isBundle ? p.includedProducts?.map(ip => ({
    productId: ip.productId,
    monthlyPremium: ip.monthlyPremium,
    productName: ip.productName
  })) : undefined,
  equivalentPremiums: p.equivalentPremiums  // per-tier map for equiv-tier output
}));

const authorityOutput = await pricingAuthority.computePricing({
  poolOrTransaction: pool,
  tenantId: enrollmentLink.TenantId,
  pricingProducts,
  paymentMethodType: effectivePaymentMethodType
});
```

- [ ] **Step 3: Delete the 6 ad-hoc fee calls.**

Lines 10844, 10856, 11043, 11277, 11382, 11463 — and their surrounding scaffolding (`basePremiumByProductId` construction, `loadSubscriptionFeeSettingsByProductId`, `calculateSystemFeeAmount`). All superseded by the single authority call.

- [ ] **Step 4: Render the response body from `authorityOutput` directly.**

```js
res.json({
  success: true,
  data: {
    products: transformedProducts,
    allProductsRules,
    contributions: pricingResult.contributions,
    totals: pricingResult.totals,
    fees: {
      systemFeesAmount: authorityOutput.totals.systemFees,
      processingFee: authorityOutput.totals.nonIncludedFeeTotal,
      totalFees: authorityOutput.totals.systemFees + authorityOutput.totals.nonIncludedFeeTotal
    },
    authority: authorityOutput,           // expose the full block so the frontend can drop local math
    pricingFingerprint: authorityOutput.pricingFingerprint,
    // ... all the other fields the endpoint already returns
  }
});
```

- [ ] **Step 5: For per-tier equivalent-tier output (line 11463 use case), iterate the authority's `_raw.feeBreakdown` per tier.**

The old code looped `equivalentPremiums` and called the breakdown fn per tier. Replace with per-tier authority calls or have the authority service expose a `computeTieredPricing` helper. If the helper doesn't exist, add it to `pricingAuthority.service.js` in a separate commit BEFORE this one (authority gets a new method; site switches to use it).

- [ ] **Step 6: Re-run the snapshot test.**

```bash
cd backend && npx jest routes/enrollment-links/__tests__/product-pricing.authority.test.js
```

Expected: all 3 scenarios PASS against the snapshot captured in 5.3.1.

- [ ] **Step 7: Run the full backend suite.**

Expected: no new failures.

- [ ] **Step 8: Manual smoke test.**

Start backend on :3001, frontend on :5173. Log in as `agent@allaboard365.com`. Open the enrollment link for MightyWELL. Walk through the wizard picking MightyWELL Preventative HSA at EE tier. Verify the review step shows $137.00 on both ACH and Card (Test 7 canonical). Then switch to Bento Dental EE — verify $100.54 + $0.80 ACH / $3.02 Card.

- [ ] **Step 9: Lint count drops by 7 (10844, 10856, 11043, 11277, 11382, 11463 + any nearby `calculateIncludedProcessingFeeForDisplay`). Expected: 15 → 8.**

- [ ] **Step 10: Commit**

```bash
git commit -m "feat(pricing): /product-pricing endpoint via pricingAuthority (collapses 7 callsites)"
```

---

## Phase 5.4 — `/complete-enrollment` and `/product-changes-complete`

Submit/charge paths. Highest risk. Take them one at a time. Manual smoke after each.

### Task 5.4.1: Migrate primary-member persistence block (line 6302)

**Files:**
- Modify: `backend/routes/enrollment-links.js:6200-6350`
- Test: `backend/routes/enrollment-links/__tests__/complete-enrollment.authority.test.js`

**Context:** After DIME transaction succeeds, this block computes per-product `IncludedPaymentProcessingFeeAmount` and `IncludedSystemFeeAmount` to write into primary member enrollment rows. Must produce byte-identical DB writes relative to current code or accounting/commission reports break.

- [ ] **Step 1: Add equivalence test** that captures current DB-write column values for the 3 canonical scenarios (individual non-included ACH, individual included Card, bundle ACH).

- [ ] **Step 2: Run test, expect PASS.**

- [ ] **Step 3: Flip the fee block.** Construct `pricingProducts` from the enrollment array (share the `buildPricingProductsFromEnrollments` helper introduced in Phase 5.2). Call `pricingAuthority.computePricing`. Read per-product `IncludedPaymentProcessingFeeAmount` from `authorityOutput.products[].includedFee`, `IncludedSystemFeeAmount` from the appropriate authority field.

  If per-product included system fee allocation isn't yet exposed by authority (it currently returns `totals.systemFees` as a single number), add a method to authority that returns per-product allocation — in a **separate** preceding commit. Do NOT inline the allocation math in the route.

- [ ] **Step 4: Re-run test. Step 5: Full suite. Step 6: Manual smoke — complete a test enrollment and verify DB rows show expected values.**

- [ ] **Step 7: Keep equivalence arm (permanent). Step 8: Lint 8 → 7. Step 9: Commit.**

```bash
git commit -m "feat(pricing): primary-member persistence block via pricingAuthority"
```

### Task 5.4.2: Migrate household-member persistence block (line 7807)

Same shape as 5.4.1 but for dependents. Follows identical steps. Lint 7 → 6. Commit message: `"feat(pricing): household-member persistence block via pricingAuthority"`.

### Task 5.4.3: Migrate pre-charge block (line 3766)

**Files:**
- Modify: `backend/routes/enrollment-links.js:3735-3800` (`preChargeBlock`)

**Context:** Computes `totalPaymentAmountPre` that gets sent to the payment processor. If this drifts from authority math, we literally charge the wrong amount. The fingerprint safety net catches it (verify earlier in the function), but don't rely on that — migrate.

- [ ] **Step 1: Add equivalence test** covering the 3 scenarios.

- [ ] **Step 2: Run test, expect PASS.**

- [ ] **Step 3: Flip the pre-charge computation.** The block already has `frontendPricing` with base premium shape. Convert to `pricingProducts` (bundle-aware), call authority, use `authorityOutput.totals.monthlyContribution` + setup fees for `totalPaymentAmountPre`.

- [ ] **Step 4: Re-run test. Step 5: Full suite. Step 6: Manual smoke — complete an enrollment that actually charges $1.00 (use DIME sandbox), verify the amount charged matches the display.**

- [ ] **Step 7: Lint 6 → 5. Step 8: Commit**

```bash
git commit -m "feat(pricing): /complete-enrollment pre-charge block via pricingAuthority"
```

### Task 5.4.4: Migrate fingerprint validation block (line 5623)

**Files:**
- Modify: `backend/routes/enrollment-links.js:5615-5670`

**Context:** This block re-validates the frontend-claimed price before persisting. Currently it calls `calculateIncludedProcessingFeeForDisplay` directly. Replace with `pricingAuthority.verifyFingerprint` — which already exists and does exactly this job.

- [ ] **Step 1: Equivalence test** — old path vs `verifyFingerprint`. Assert both return the same `matched: boolean` for the 3 scenarios AND a simulated drift case (mutated fingerprint expected to fail).

- [ ] **Step 2: Run test, expect PASS.**

- [ ] **Step 3: Flip.** Replace the entire validation block with:

```js
const fpVerify = await pricingAuthority.verifyFingerprint({
  poolOrTransaction: pool,
  tenantId: enrollmentLink.TenantId,
  pricingProducts,
  paymentMethodType: effectivePaymentMethodType,
  expectedFingerprint: clientSentFingerprint
});
if (!fpVerify.matched) {
  return res.status(400).json({
    error: 'PRICING_FINGERPRINT_MISMATCH',
    detail: { expected: clientSentFingerprint, actual: fpVerify.actualFingerprint }
  });
}
```

- [ ] **Step 4–6: Test, suite, smoke. Step 7: Lint 5 → 4. Step 8: Commit**

```bash
git commit -m "feat(pricing): fingerprint validation via pricingAuthority.verifyFingerprint"
```

### Task 5.4.5: Migrate `product-changes-complete.js` — persistence (line 1955)

**Files:**
- Modify: `backend/routes/me/member/product-changes-complete.js:1900-2020`
- Test: `backend/routes/me/member/__tests__/product-changes-complete.authority.test.js`

Same pattern as 5.4.1 but for the plan-change path. Lint 4 → 3. Commit: `"feat(pricing): product-changes-complete persistence via pricingAuthority"`.

### Task 5.4.6: Migrate `product-changes-complete.js` — recurring fee (line 3109)

**Files:**
- Modify: `backend/routes/me/member/product-changes-complete.js:3090-3170`

**Context:** Computes the recurring processing fee that gets scheduled with DIME. Safety-critical — wrong amount means the member gets charged the wrong amount every month going forward.

- [ ] **Step 1–8:** same pattern as 5.4.3 (pre-charge). Manual smoke includes verifying the DIME recurring schedule amount matches what the member was quoted.

Lint 3 → 2. Commit: `"feat(pricing): product-changes-complete recurring fee via pricingAuthority"`.

---

## Phase 5.5 — Frontend wizard migration

### Task 5.5.1: Delete local `calculateIncludedProcessingFeeForDisplay` in EnrollmentWizard

**Files:**
- Modify: `frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx:371-405` (delete), plus callsites at 4116, 4177, 4191, 4563

**Context:** After Phase 5.3, `/product-pricing` and `/contribution-preview` both return `authority.display.lineItems` + `authority.display.summary` + `pricingFingerprint`. The wizard can render directly from those fields and drop all local fee math.

- [ ] **Step 1: Verify backend response shape.**

Start backend + frontend. In browser devtools Network tab, capture the `/enrollment-link/totals` (if present) and `/contribution-preview` response bodies. Confirm each has `authority.display.lineItems` and `authority.display.summary.rows` in the expected shape (see `pricingAuthority.service.js:139` for `buildDisplayBlock`).

- [ ] **Step 2: Identify every read of `processingFee` / `nonIncludedFee` / `includedFee` / `systemFees` in the wizard rendering path.**

Use Grep:

```bash
cd frontend && grep -nE 'processingFee|includedFee|nonIncludedFee|systemFee' src/components/enrollment-wizard/EnrollmentWizard.tsx
```

For each render use, map it to the corresponding field in `contributionPreviewData.authority.display`.

- [ ] **Step 3: Replace each read.**

For totals: render `contributionPreviewData.authority.display.summary.rows` directly (each row has `key`, `label`, `value` pre-formatted as a `$X.YZ` string).

For per-product line items: render `contributionPreviewData.authority.display.lineItems` (each has `label`, `amount`, and nested `includedProducts` for bundles).

- [ ] **Step 4: Delete the local `calculateIncludedProcessingFeeForDisplay` function (lines 371-405) AND the three imports from `../../services/processingFeeCalculator`.**

- [ ] **Step 5: Run the frontend test suite.**

```bash
cd frontend && npx vitest run
```

Expected: no new failures.

- [ ] **Step 6: Run type check.**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 7: Manual smoke — walk the full enrollment flow in the browser.**

Cover:
- MightyWELL Preventative HSA EE on ACH → review shows $137.00.
- Same product on Card → review still shows $137.00 (Rule 2 by-eye check).
- Bento Dental EE on ACH → review shows $100.54 + $0.80 fees.
- Bento Dental EE on Card → review shows $100.54 + $3.02 fees.
- HSA Preventative bundle on ACH → review shows the value captured in our snapshot from Phase 5.3.1.

If any number moves, STOP — the backend authority numbers and the old frontend numbers were not identical. Do not ship.

- [ ] **Step 8: Commit**

```bash
git commit -m "feat(pricing): EnrollmentWizard renders authority display block directly"
```

### Task 5.5.2: Delete `processingFeeCalculator.ts` retained exports

**Files:**
- Modify: `frontend/src/services/processingFeeCalculator.ts` (delete the file OR shrink to types only)
- Modify: `frontend/src/services/feeCalculationService.ts` (remove re-exports of deleted functions)
- Check: `frontend/src/pages/members/ProductChangeWizard.tsx` — still imports `calculateProcessingFee`?

- [ ] **Step 1: Grep for remaining callers.**

```bash
cd frontend && grep -rn "from '.*processingFeeCalculator'" src/
```

If any callers remain besides `ProductChangeWizard.tsx`, address them first (same pattern as 5.5.1).

- [ ] **Step 2: Migrate `ProductChangeWizard.tsx`** — same approach as wizard. It already calls `/calculate-plan-change-cost` which returns `authority` block post-Phase-3. Render from that block.

- [ ] **Step 3: Delete the three exports** from `processingFeeCalculator.ts`. If the file is now empty, delete it.

- [ ] **Step 4: Delete re-exports from `feeCalculationService.ts`.** If empty, delete.

- [ ] **Step 5: Type check + vitest + manual smoke on plan-change flow.**

- [ ] **Step 6: Commit**

```bash
git commit -m "chore(pricing): delete processingFeeCalculator.ts — authority is sole source"
```

---

## Phase 5.6 — Cleanup & promotion

### Task 5.6.1: Promote ESLint rule from `warn` to `error`

**Files:**
- Modify: `backend/.eslintrc.pricing.js:26` (change `'warn'` → `'error'`)

- [ ] **Step 1: Run lint.**

```bash
cd backend && npx eslint . --quiet | grep -c no-restricted-syntax
```

Expected: `0`. If not 0, a callsite was missed — go back and finish the phase that covers it.

- [ ] **Step 2: Change severity to `'error'`.**

```js
'no-restricted-syntax': ['error', ...]  // was 'warn'
```

- [ ] **Step 3: Run lint again — expect exit 0.**

- [ ] **Step 4: Add a CI script** in `backend/package.json`:

```json
"scripts": {
  "lint:pricing": "eslint . --quiet --rule 'no-restricted-syntax: error'"
}
```

- [ ] **Step 5: Commit**

```bash
git commit -m "chore(pricing): promote drift-prevention rule from warn to error"
```

### Task 5.6.2: End-to-end verification

- [ ] **Step 1: Backend full suite.**

```bash
cd backend && npx jest --testPathIgnorePatterns=jest.live
```

Expected: same pass count as the baseline documented in the Phase 3+4 report (4 pre-existing failures unchanged, everything else green).

- [ ] **Step 2: Frontend type check + vitest.**

```bash
cd frontend && npx tsc --noEmit 2>&1 | grep -v TS6133
cd frontend && npx vitest run
```

Expected: no new errors or failures.

- [ ] **Step 3: Manual smoke on all 7 canonical test-plan surfaces.**

Walk through `docs/pricing-authority/pricing-authority-numbers-test-plan.md` Test 1 through Test 7. Every surface must show the same number it showed before this phase started — that's the equivalence guarantee.

- [ ] **Step 4: Update the migration report.**

Open `docs/pricing-authority/pricing-authority-phases-3-4-report.md` and add a Phase 5 section documenting what was migrated, final lint count (0), and the promotion to `error`.

- [ ] **Step 5: Commit the doc update.**

```bash
git commit -m "docs(pricing): Phase 5 completion — zero drift, lint promoted to error"
```

### Task 5.6.3: Open the PR

- [ ] **Step 1: Push the branch.**

```bash
git push -u origin feat/pricing-authority-phase-2
```

- [ ] **Step 2: Open PR with description covering:**
  - Overall strategy: "All surfaces now call pricingAuthority.computePricing. Zero ESLint violations. Drift rule promoted from warn to error."
  - File-by-file breakdown of what changed (per user's PR preferences captured in memory).
  - Omit Test Plan section (per user preference).

---

## Exit criteria

Phase 5 is complete when ALL of the following hold:

1. `npx eslint backend/ --quiet | grep -c no-restricted-syntax` returns `0`.
2. `backend/.eslintrc.pricing.js` severity is `'error'`, not `'warn'`.
3. Full backend suite passes (relative to pre-existing baseline).
4. Frontend type-check + vitest pass.
5. All 7 canonical test-plan surfaces show identical numbers to pre-migration (manual verified).
6. No file in `backend/` or `frontend/src/` imports `calculateProcessingFee`, `calculateHighestProcessingFee`, `calculateIncludedProcessingFeeForDisplay`, or `calculateProcessingFeeBreakdownByProduct` except `backend/services/pricing/pricingAuthority.service.js` and the primitives themselves.

When all six hold, `pricingAuthority.computePricing` is the sole source of truth for pricing math in the entire codebase. Drift is prevented by the lint rule; divergence in calling code is prevented by the fingerprint verification at submit time.
