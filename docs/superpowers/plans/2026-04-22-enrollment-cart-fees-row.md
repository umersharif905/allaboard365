# Enrollment Cart Fees Row Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the **Fees** row in the enrollment cart/summary during product selection, for both individual and group enrollments, sourced from the pricing authority.

**Architecture:** Two targeted edits in a single file (`frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx`). (1) Default the individual-enrollment payment method to `'ACH'` in the three places that currently default to `'Card'` or `undefined`, so the `/contribution-preview` response is keyed on ACH and the cart shows ACH-default fees. (2) Collapse the Individual-vs-Group branches of `renderCostSummaryComponent` so individuals render the same Fees / Subtotal / Total block the Group branch already renders. No backend changes; no pricing math changes. Verification is a new Cypress spec that stubs `/contribution-preview` and asserts the Fees row.

**Tech Stack:** React + TypeScript (Vite), Tailwind, TanStack Query, Cypress (stub-driven), Node/Express backend (unchanged).

**Reference spec:** `docs/superpowers/specs/2026-04-22-enrollment-cart-fees-row-design.md`

---

## File Structure

**Modify:**
- `frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx`
  - Lines 1187-1189: `paymentMethodForTotals` default.
  - Lines 1210-1212: `contributionPreviewKey` default.
  - Lines 1245-1247: inside the contribution-preview `useEffect`.
  - Lines 9715-9731: the Individual branch of `renderCostSummaryComponent`.

**Create:**
- `frontend/cypress/e2e/enrollment/cart-fees-row.cy.ts` — stub-driven test asserting the Fees row renders with ACH-default value for an individual enrollment.

**Do NOT modify:**
- `backend/services/pricing/pricingAuthority.service.js` — already emits the correct data.
- `frontend/src/components/enrollment-wizard/steps/MarketingProductSelectionStep.tsx` — has no cart.
- Any other component, hook, service, or test.

---

## Task 1: Default individual payment method to `'ACH'` in all three call sites

Currently the individual enrollment flow defaults `paymentMethodData.paymentMethodType` to `'Card'` or `undefined` in three separate expressions, each of which flows into a different pricing query. The spec requires ACH by default. All three must be changed together to keep the React Query key, the fetch body, and the downstream `useEnrollmentLinkTotals` consistent — otherwise cache keys and responses drift.

**Files:**
- Modify: `frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx:1187-1189`
- Modify: `frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx:1210-1212`
- Modify: `frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx:1245-1247`

- [ ] **Step 1: Open the file and confirm the three target regions exist at the expected line numbers**

Run: `grep -n "paymentMethodForTotals\|paymentMethodData.paymentMethodType as any" frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx`
Expected: shows lines near 1187, 1212, 1247 (line numbers may have shifted by a few — use the surrounding context to confirm).

- [ ] **Step 2: Change `paymentMethodForTotals` to default to `'ACH'`**

In the block currently at lines 1186-1189:

```tsx
  const isIndividualEnrollmentForTotals = enrollmentData?.enrollmentLink?.templateType === 'Individual';
  const paymentMethodForTotals: 'ACH' | 'Card' | undefined = isIndividualEnrollmentForTotals && paymentMethodData?.paymentMethodType
    ? (paymentMethodData.paymentMethodType === 'ACH' || paymentMethodData.paymentMethodType === 'Card' ? paymentMethodData.paymentMethodType : 'ACH')
    : undefined;
```

Replace with:

```tsx
  const isIndividualEnrollmentForTotals = enrollmentData?.enrollmentLink?.templateType === 'Individual';
  // Default to ACH for individuals during product selection (before the Payment Method step).
  // This makes the pricing authority return fees keyed on ACH, matching the cart's ACH-default display.
  const paymentMethodForTotals: 'ACH' | 'Card' | undefined = isIndividualEnrollmentForTotals
    ? (paymentMethodData?.paymentMethodType === 'Card' ? 'Card' : 'ACH')
    : undefined;
```

- [ ] **Step 3: Change `contributionPreviewKey` individual default from `'Card'` to `'ACH'`**

In the block currently at lines 1209-1212:

```tsx
    const isGroupEnrollment = enrollmentData?.enrollmentLink?.templateType === 'Group';
    const paymentMethodType: 'ACH' | 'Card' = isGroupEnrollment
      ? (groupPaymentMethodType || 'ACH')
      : ((paymentMethodData.paymentMethodType as any) || 'Card');
```

Replace with:

```tsx
    const isGroupEnrollment = enrollmentData?.enrollmentLink?.templateType === 'Group';
    const paymentMethodType: 'ACH' | 'Card' = isGroupEnrollment
      ? (groupPaymentMethodType || 'ACH')
      : (paymentMethodData.paymentMethodType === 'Card' ? 'Card' : 'ACH');
```

- [ ] **Step 4: Change the contribution-preview fetch effect's individual default from `'Card'` to `'ACH'`**

In the block currently at lines 1243-1247:

```tsx
      const isGroupEnrollment = enrollmentData?.enrollmentLink?.templateType === 'Group';
      try {
        const paymentMethodType: 'ACH' | 'Card' = isGroupEnrollment
          ? (groupPaymentMethodType || 'ACH')
          : ((paymentMethodData.paymentMethodType as any) || 'Card');
```

Replace with:

```tsx
      const isGroupEnrollment = enrollmentData?.enrollmentLink?.templateType === 'Group';
      try {
        const paymentMethodType: 'ACH' | 'Card' = isGroupEnrollment
          ? (groupPaymentMethodType || 'ACH')
          : (paymentMethodData.paymentMethodType === 'Card' ? 'Card' : 'ACH');
```

- [ ] **Step 5: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors introduced by this task. (Pre-existing errors elsewhere in the repo are fine — only changes regressions matter.)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx
git commit -m "fix(enrollment): default individual pricing queries to ACH

Individuals pick payment method after product selection. Defaulting the
three pricing-query payment-method expressions to ACH (rather than Card
or undefined) lets the pricing authority return ACH-default fees during
product selection, which the cart will render in Task 2."
```

---

## Task 2: Collapse the Individual and Group cart branches to render the same Fees / Subtotal / Total block

The cart's Individual branch currently renders only "Total: $X.XX" with a now-stale comment. With Task 1 in place, `confirmationMonthlyBreakdown` is populated with authority-sourced fee data for individuals too, so both branches should render the same block. The Group branch's Employer Contribution sub-block is already correctly gated on `employerContribution !== 0` (line 9780), which evaluates to zero for individuals — so the Employer block will naturally remain hidden for them without a template-type check.

**Files:**
- Modify: `frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx:9714-9821`

- [ ] **Step 1: Locate the Individual/Group conditional**

Run: `grep -n "Individual: no Fees row here" frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx`
Expected: exactly one match near line 9718.

- [ ] **Step 2: Replace the ternary's Individual branch with a no-op and keep the Group block as the single render path**

In the region currently at lines 9714-9821, the top of the ternary looks like:

```tsx
        {/* Individual vs Group Enrollment Cost Display */}
        {enrollmentData?.enrollmentLink?.templateType === 'Individual' ? (
          <div className="flex justify-end">
            <div className="text-right">
              {/* Individual: no Fees row here — payment method (card/ACH) is chosen later, so fees only on confirmation page */}
              <div className="text-lg font-bold text-gray-900">
                {pricingLoading || contributionPreviewLoading ? (
                  <div className="flex items-center justify-end">
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-oe-primary mr-2"></div>
                    Calculating...
                  </div>
                ) : (
                  `Total: $${(totalCosts.totalCost || 0).toFixed(2)}`
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {/* Fees — plain line like a product */}
            {confirmationMonthlyBreakdown.hasFeesLine && (
              ...
```

Replace the entire `{enrollmentData?.enrollmentLink?.templateType === 'Individual' ? ( ... ) : ( ... )}` expression with a single render of the former Group block. The replacement (keeping the existing Group body verbatim) is:

```tsx
        {/* Cost summary — Fees, Subtotal, Employer Contribution (group only), Your Monthly Contribution.
            Fees and Employer rows are self-gating: Fees hides when hasFeesLine is false,
            Employer hides when employerContribution is 0 (always true for individuals). */}
        <div className="space-y-2">
          {/* Fees — plain line like a product */}
          {confirmationMonthlyBreakdown.hasFeesLine && (
            <div className="flex justify-between items-center text-sm px-3 py-1">
              <span className="text-gray-600">Fees</span>
              <span className="text-gray-900 font-medium">
                ${confirmationMonthlyBreakdown.platformAndProcessingFees.toFixed(2)}
              </span>
            </div>
          )}

          {/* Subtle divider + Subtotal */}
          <div className="border-t border-gray-200 pt-2 px-3">
            <div className="flex justify-between items-center text-sm">
              <span className="text-gray-700 font-medium">Subtotal</span>
              <span className="text-gray-900 font-semibold">
                {pricingLoading || contributionPreviewLoading ? (
                  <span className="text-xs text-gray-400">...</span>
                ) : (
                  `$${confirmationMonthlyBreakdown.subtotalBeforeEmployer.toFixed(2)}`
                )}
              </span>
            </div>
          </div>

          {/* Employer Contribution */}
          {(() => {
            const employerContribution =
              Number(contributionPreviewData?.totals?.totalEmployerContribution ?? totalCosts.employerContribution) || 0;
            const allProductsRules = pricingData?.allProductsRules || [];
            const rulesCount = allProductsRules.length;

            // Debug display if contributions are 0 but rules exist
            if (employerContribution === 0 && rulesCount > 0 && isDebugMode()) {
              return (
                <div className="bg-yellow-50 rounded px-3 py-2 border border-yellow-200">
                  <div className="text-sm text-yellow-800">
                    <div className="font-medium mb-1">Debug: {rulesCount} contribution rule(s) found but employer contribution is $0</div>
                    <div className="text-xs">
                      Rules: {allProductsRules.map((r: any) => r.description || r.type).join(', ')}
                      <br />
                      Member: Age {memberCriteria?.age || 'N/A'}, Job: {memberCriteria?.jobPosition || 'N/A'}
                    </div>
                  </div>
                </div>
              );
            }

            if (employerContribution === 0) return null;

            return (
              <div className="bg-green-50 rounded px-3 py-2 border border-green-200">
                <div className="flex justify-between items-center">
                  <span className="text-sm font-medium text-green-800">Employer Contribution</span>
                  <span className="text-sm font-semibold text-green-800">
                    -${Math.abs(employerContribution).toFixed(2)}
                  </span>
                </div>
              </div>
            );
          })()}

          {/* Your Monthly Contribution */}
          <div className="bg-blue-50 rounded px-3 py-2 border border-blue-200">
            <div className="flex justify-between items-center">
              <span className="text-sm font-bold text-blue-800">Your Monthly Contribution</span>
              <span className="font-bold text-oe-primary text-lg">
                {pricingLoading || contributionPreviewLoading ? (
                  <div className="flex items-center">
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-oe-primary mr-2"></div>
                    <span className="text-sm">...</span>
                  </div>
                ) : (() => {
                  const displayEmployerContribution =
                    Number(contributionPreviewData?.totals?.totalEmployerContribution ?? totalCosts.employerContribution) || 0;
                  const hasEmployerShare = Math.abs(displayEmployerContribution) >= 0.01;
                  const amount = hasEmployerShare
                    ? Number(
                        contributionPreviewData?.totals?.totalEmployeeContribution ??
                          totalCosts.employeeContribution ??
                          confirmationMonthlyBreakdown.subtotalBeforeEmployer
                      )
                    : confirmationMonthlyBreakdown.subtotalBeforeEmployer;
                  return `$${amount.toFixed(2)}`;
                })()}
              </span>
            </div>
          </div>
        </div>
```

Apply this by using `Edit` on the full old expression (from `{/* Individual vs Group Enrollment Cost Display */}` through the closing `)}` of the ternary) → the new single block. The `old_string` must include the entire ternary so the Edit is unambiguous.

- [ ] **Step 3: Type-check again**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Lint**

Run: `cd frontend && npx eslint src/components/enrollment-wizard/EnrollmentWizard.tsx`
Expected: no new errors. Warnings from pre-existing rules are acceptable.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx
git commit -m "fix(enrollment): render Fees/Subtotal/Total in cart for individuals

Individual cost summary branch was deliberately skipping the Fees row
with a comment that became stale once the pricing authority started
providing authoritative fee data during product selection. Both
enrollment types now render the same cart block; Employer Contribution
remains self-gating on a non-zero value, so individuals won't see it."
```

---

## Task 3: Cypress spec — assert the Fees row renders for an individual enrollment

A targeted stub-driven Cypress test that loads an individual enrollment, selects a product, and verifies the cart renders the Fees row with the authority-returned value. Stubs mirror existing scenario-1 patterns.

**Files:**
- Create: `frontend/cypress/e2e/enrollment/cart-fees-row.cy.ts`

- [ ] **Step 1: Inspect an existing stub-driven spec to mirror its fixtures and Cypress helper usage**

Run: `cat frontend/cypress/e2e/enrollment/scenario-1-individual-new-member.cy.ts | head -80`
Expected: see the `cy.intercept` patterns for `/api/enrollment-links/**` and the `cy.visit('/enroll/...')` entrypoint. Note the fixture path convention.

- [ ] **Step 2: Inspect an existing fixture that exercises `contribution-preview`**

Run: `grep -rln "contribution-preview\|processingFeeTotal\|systemFeesAmount" frontend/cypress/e2e/enrollment/ frontend/cypress/fixtures/enrollment/`
Expected: at least one spec (likely `scenario-4-group-employee.cy.ts` or `real-backend-walkthrough.cy.ts`) shows the response shape. Use its fee shape (`data.fees.processingFeeTotal`, `data.fees.systemFeesAmount`, `data.fees.basePremiumTotal`, `data.products[*].monthlyPremium`) as the source of truth for the stub body below.

- [ ] **Step 3: Create the spec**

```ts
// frontend/cypress/e2e/enrollment/cart-fees-row.cy.ts
//
// Verifies the cart/summary box renders the Fees row sourced from the pricing
// authority during product selection for an INDIVIDUAL enrollment. Prior to
// the fix in PR fix/product-tile-fees, individuals saw only a Total line and
// no Fees breakdown because the wizard's Individual cart branch skipped it.

describe('Enrollment cart — Fees row (individual)', () => {
  const linkToken = 'test-individual-link-token';

  beforeEach(() => {
    // Bypass real backend auth / link lookup with the minimum mock link payload.
    cy.intercept('GET', `/api/enrollment-links/${linkToken}/data*`, {
      fixture: 'enrollment/mock-link.json',
    }).as('linkData');

    // Display premiums (tile prices) — shape mirrors /product-pricing response.
    cy.intercept('GET', `/api/enrollment-links/${linkToken}/product-pricing*`, {
      statusCode: 200,
      body: {
        success: true,
        data: {
          products: [
            {
              productId: 'prod-cherwell',
              productName: 'Cherwell',
              monthlyPremium: 500,
              displayPremium: 500,
            },
          ],
        },
      },
    }).as('productPricing');

    // Contribution preview — authority returns fees for ACH default.
    cy.intercept('POST', `/api/enrollment-links/${linkToken}/contribution-preview`, (req) => {
      // Sanity: the wizard MUST request ACH by default for an individual with no
      // payment method chosen. If this ever regresses to 'Card', the test fails.
      expect(req.body.paymentMethodType).to.equal('ACH');
      req.reply({
        statusCode: 200,
        body: {
          success: true,
          data: {
            products: [
              { productId: 'prod-cherwell', productName: 'Cherwell', monthlyPremium: 500 },
            ],
            fees: {
              basePremiumTotal: 500,
              processingFeeTotal: 0,     // Cherwell + ACH → zero processing fee
              systemFeesAmount: 25,      // tenant system fee still applies
              paymentMethodType: 'ACH',
            },
            contributions: { totalEmployerContribution: 0 },
            totals: { totalPremium: 525, totalEmployerContribution: 0, totalEmployeeContribution: 525 },
            authority: {
              display: {
                summary: {
                  rows: [
                    { key: 'premium', label: 'Monthly Premium', value: '$500.00' },
                    { key: 'fees', label: 'Fees', value: '$25.00' },
                    { key: 'total', label: 'Your Monthly Contribution', value: '$525.00', emphasis: true },
                  ],
                },
              },
            },
          },
        },
      });
    }).as('preview');
  });

  it('shows the Fees row with the authority value when a product is selected', () => {
    cy.visit(`/enroll/${linkToken}`);
    cy.wait('@linkData');

    // Simulate reaching the product-selection step and selecting Cherwell.
    // Adjust the selector to match your app's data-testid convention — the
    // existing scenario-1 spec shows the idiomatic pattern for this codebase.
    cy.findByRole('button', { name: /select cherwell/i }).click();

    cy.wait('@preview');

    // Assert the Fees row is visible with the stubbed value.
    cy.contains('Fees').should('be.visible');
    cy.contains('Fees')
      .parent()
      .within(() => {
        cy.contains('$25.00').should('be.visible');
      });

    // Subtotal = base + fees.
    cy.contains('Subtotal')
      .parent()
      .within(() => {
        cy.contains('$525.00').should('be.visible');
      });

    // Final "Your Monthly Contribution" line.
    cy.contains('Your Monthly Contribution')
      .parent()
      .within(() => {
        cy.contains('$525.00').should('be.visible');
      });
  });

  it('hides the Fees row when the authority reports zero fees', () => {
    // Override the default intercept with a zero-fee response.
    cy.intercept('POST', `/api/enrollment-links/${linkToken}/contribution-preview`, {
      statusCode: 200,
      body: {
        success: true,
        data: {
          products: [{ productId: 'prod-bundle', productName: 'Bundle', monthlyPremium: 600 }],
          fees: {
            basePremiumTotal: 600,
            processingFeeTotal: 0,
            systemFeesAmount: 0,
            paymentMethodType: 'ACH',
          },
          contributions: { totalEmployerContribution: 0 },
          totals: { totalPremium: 600, totalEmployerContribution: 0, totalEmployeeContribution: 600 },
          authority: {
            display: {
              summary: {
                rows: [
                  { key: 'premium', label: 'Monthly Premium', value: '$600.00' },
                  { key: 'total', label: 'Your Monthly Contribution', value: '$600.00', emphasis: true },
                ],
              },
            },
          },
        },
      },
    }).as('previewZero');

    cy.visit(`/enroll/${linkToken}`);
    cy.wait('@linkData');
    cy.findByRole('button', { name: /select bundle/i }).click();
    cy.wait('@previewZero');

    // When platformAndProcessingFees <= 0.005, hasFeesLine is false and the row should not render.
    cy.contains('Fees').should('not.exist');
    cy.contains('Subtotal')
      .parent()
      .within(() => {
        cy.contains('$600.00').should('be.visible');
      });
  });
});
```

- [ ] **Step 4: Adjust fixture + selectors to match the real app**

The spec above uses placeholder product names ("Cherwell", "Bundle") and assumes `data-testid`/accessible-name conventions match the existing scenario-1 spec. Before running, cross-reference `frontend/cypress/e2e/enrollment/scenario-1-individual-new-member.cy.ts` and `frontend/cypress/fixtures/enrollment/mock-link.json` and:
- Replace `prod-cherwell` / `prod-bundle` with product IDs that actually appear in `mock-link.json`.
- Replace `cy.findByRole('button', { name: /select cherwell/i })` with whatever selector scenario-1 uses to click a product tile (e.g. a `data-testid` or specific button text).
- If `mock-link.json` doesn't already include a product that would round-trip through `/contribution-preview`, either extend the fixture or inline-override the `GET /data` intercept with the required products.

- [ ] **Step 5: Run the spec**

Run: `cd frontend && npx cypress run --spec "cypress/e2e/enrollment/cart-fees-row.cy.ts"`
Expected: both `it` blocks pass. If selectors don't match, fix them against the rendered DOM — re-running with `npx cypress open` is useful for interactive debugging.

- [ ] **Step 6: Lint the spec**

Run: `cd frontend && npx eslint cypress/e2e/enrollment/cart-fees-row.cy.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/cypress/e2e/enrollment/cart-fees-row.cy.ts
git commit -m "test(enrollment): cypress spec for cart Fees row (individual, ACH default)

Covers two cases:
 1. Authority reports non-zero fees → Fees row visible with authority value;
    assertion on the preview request body enforces ACH default for
    individuals during product selection.
 2. Authority reports zero fees → Fees row is hidden (hasFeesLine gate)."
```

---

## Task 4: Manual parity check and final verification

Not all paths are reachable by the Cypress stub test (the stub hardcodes authority output). This task verifies against a real backend that Cart subtotal matches Quick Quote for the same inputs, and eyeballs the three flag scenarios the user called out.

**Files:** none modified.

- [ ] **Step 1: Start the backend and frontend**

Run in two terminals:
- `cd backend && node app.js`
- `cd frontend && npm run dev`

Expected: frontend available at `http://localhost:5173`, backend at `http://localhost:3001` (per `CLAUDE.md` / `project_worktree_ports` memory — this worktree may use different ports; confirm before running).

- [ ] **Step 2: Exercise scenario — individual link, product with `IncludeProcessingFee=false`**

Open an individual enrollment link for a product that does NOT have the "fees included" flag. Reach product selection. Observe:
- Cart shows **Fees** row with a non-zero value.
- Cart **Subtotal** = base premium + fees.
- Cart **Your Monthly Contribution** = Subtotal (no employer contribution for individuals).

Compare to Quick Quote (agent side) for the same product/age/tier. Subtotal values must match to the cent.

- [ ] **Step 3: Exercise scenario — bundle with `IncludeProcessingFee=true`**

Open an individual link that exposes a "fees included" bundle. Select it. Observe:
- Cart shows **no Fees row** for the processing portion (it's folded into the product price).
- If tenant has a non-zero system fee, the **Fees** row value equals only the system fee.
- **No double counting**: Subtotal ≈ product `displayPremium` + (system fee only).

- [ ] **Step 4: Exercise scenario — Cherwell with `ZeroFeeForACH=true`**

Select Cherwell (or any `ZeroFeeForACH` product). Observe:
- Cart **Fees** row shows system-fee-only contribution from that product (zero processing fee under ACH).
- Advance to Payment Method step and select **Card**. Return to cart — **Fees** value increases to include Card-rate processing fee.

- [ ] **Step 5: Exercise scenario — group enrollment (regression check)**

Open a group link that was previously showing the Fees row correctly. Confirm no visual or numerical regression. Employer Contribution block still appears when applicable.

- [ ] **Step 6: Report results**

Document scenario-by-scenario pass/fail in the PR description. Attach screenshots of each cart state.

---

## Self-review (completed before handoff)

- **Spec coverage:** Change 1 (ACH default) → Task 1. Change 2 (unify branches) → Task 2. Change 3 (trust authority, no math) → inherent in both tasks, no code change required. Testing section → Tasks 3 + 4.
- **Placeholder scan:** no TBDs, TODOs, or "implement later" language. Code blocks are complete for every code step.
- **Type consistency:** the narrowing `paymentMethodData.paymentMethodType === 'Card' ? 'Card' : 'ACH'` is identical in all three call sites (Task 1 steps 2/3/4) and returns a `'ACH' | 'Card'` value compatible with the existing `paymentMethodType` typing.
- **Out-of-scope temptations flagged:** no changes to `MarketingProductSelectionStep.tsx`, no changes to the pricing authority, no changes to the confirmation page.
