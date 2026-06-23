# Restore Fees Row in Enrollment Cart Summary

**Date:** 2026-04-22
**Branch:** `fix/product-tile-fees`
**Scope:** Single-file change in `frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx`.

## Problem

During product selection in the enrollment wizard, the cart/summary box no longer shows the processing/system fees that a member will be billed. Before the pricing-authority refactor (commit `37977d19`, Apr 20), the cart displayed a **Fees** line alongside the subtotal and total. That line has been silently dropped for individual enrollments, and the cart therefore understates what the member actually owes until they reach the confirmation page.

This contradicts the user's stated invariant: "pricing authority is the only source of truth — no inline calculations." The authority already computes the correct fees per product, respecting `IncludeProcessingFee`, `ZeroFeeForACH`, `CustomSystemFeeAmount`, and payment method. We just aren't rendering its output in the cart.

## Why the fees row disappeared

The cart's fee line (`EnrollmentWizard.tsx:9733-9741`) is gated on `confirmationMonthlyBreakdown.hasFeesLine`. That memo (lines 4384-4426) sources data from `contributionPreviewData.fees`, which comes from the `useContributionPreview` hook. That hook's `enabled` predicate requires `paymentMethodForTotals` to be defined.

For **individual** enrollments, `paymentMethodForTotals` (lines 1187-1188) stays `undefined` until the member reaches the Payment Method step — which is *after* Product Selection. So during product selection: preview never fires → `fees` object is absent → `hasFeesLine` is false → the row doesn't render.

For **group** enrollments the payment method is resolved early from group defaults, so fees appear correctly there; but the Individual branch of `renderCostSummaryComponent` (lines 9715-9730) explicitly skips the fee rendering with a now-stale comment ("fees only on confirmation page").

## Design

### Guiding principles

- **No inline fee math.** The cart reads the authority's computed values verbatim.
- **ACH default.** When the member hasn't chosen a payment method, assume ACH (the cheapest path; matches Quick Quote).
- **One display shape.** Group and Individual carts render the same rows: selected products → Fees (if > 0) → Subtotal → Employer contribution (group only) → Total.
- **Minimal change.** The data pipeline already exists. The fix is unblocking it for individuals.

### Change 1 — Default `paymentMethodForTotals` to `'ACH'`

**File:** `frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx`, around line 1187-1188.

**Before:**
```ts
const paymentMethodForTotals: 'ACH' | 'Card' | undefined =
  isIndividualEnrollmentForTotals && paymentMethodData?.paymentMethodType
    ? (paymentMethodData.paymentMethodType === 'ACH' ||
       paymentMethodData.paymentMethodType === 'Card'
        ? paymentMethodData.paymentMethodType
        : 'ACH')
    : undefined;
```

**After:** For individual enrollments, always resolve to a concrete `'ACH' | 'Card'`. If the member has picked a method, use it (normalizing unknown values to `'ACH'`); otherwise default to `'ACH'`. Result: `useContributionPreview`'s `enabled` gate passes during product selection, the backend returns `fees`, and the cart's existing fee-row code path activates.

When the member later selects Card on the Payment Method step, the hook's dependency array picks up the new value, React Query refetches, and the fee row updates to Card rates.

### Change 2 — Unify the Individual and Group cart branches

**File:** `frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx`, inside `renderCostSummaryComponent` (lines 9555-9852).

Currently the Individual branch (lines 9715-9730) renders only a Total; the Group branch (lines 9731-9821) renders Fees / Subtotal / Employer / Total. With Change 1 in place, individuals now have authoritative fee data during product selection, so both branches should render the same block.

**Action:** Replace the Individual-only "Total-only" display with the same fees/subtotal/total block the Group branch uses. Keep the Employer Contribution row conditional on group enrollment (it's already gated by `displayEmployerContribution !== 0`, which stays zero for individuals).

### Change 3 — Leave the authority as-is; trust its output

`pricingAuthority.buildDisplayBlock` (`backend/services/pricing/pricingAuthority.service.js:137-185`) already emits the correct rows:

```
summary.rows: [
  { key: 'premium', label: 'Monthly Premium',           value: ... },
  { key: 'fees',    label: 'Fees',                       value: ... },   // only when > 0
  { key: 'total',   label: 'Your Monthly Contribution',  value: ..., emphasis: true }
]
```

It already respects:
- **`IncludeProcessingFee=true`** — fee folded into `displayPremium`; `nonIncludedFeeTotal` excludes it. **No double count.**
- **`ZeroFeeForACH=true`** with `paymentMethodType='ACH'` — processing fee is `$0` for that product; switches to Card rate when `paymentMethodType='Card'`.
- **`CustomSystemFeeAmount`** — per-product system fee override.

No backend changes needed. The cart already routes data through `confirmationMonthlyBreakdown`, which is a thin pass-through over `contributionPreviewData.fees`.

### Out of scope

- Product tiles (unchanged; remain premium-only).
- `MarketingProductSelectionStep.tsx` (has no cart UI — only a floating "Start (N)" button).
- The pricing authority itself (already produces the right shape).
- The confirmation page (already correct — reads the same `confirmationMonthlyBreakdown`).
- Splitting fees into separate system-fee / processing-fee rows (user chose the single "Fees" row that matches authority and Quick Quote).

## Testing

**Cypress (enrollment specs, `frontend/cypress/e2e/enrollment/`):**
- Individual enrollment, select a product → **Fees** row appears; value equals the `summary.rows[key='fees']` value in the `/contribution-preview` response for `paymentMethodType='ACH'`.
- Select a product with `IncludeProcessingFee=true` (e.g. a bundle with the "fees included" flag) → Fees row either absent or shows only the system-fee portion; subtotal does **not** double-count.
- Select a product with `ZeroFeeForACH=true` (Cherwell) → under ACH default, no processing fee contribution from that product.
- Advance to Payment Method step, pick Card → cart's Fees row value updates upward.

**Jest (backend):** existing authority unit tests already cover the fee math; no new backend tests needed.

**Vitest:** unit-test the `paymentMethodForTotals` resolution — undefined input produces `'ACH'` for individual enrollments.

**Manual parity check:** for a chosen product/tier/age, cart subtotal should match Quick Quote's Total Premium to the cent (same authority, same inputs).

## Risks

- **Extra network call on mount:** enabling the preview during product selection adds one `/contribution-preview` call per selection change for individuals. Acceptable — React Query dedupes, and the hook still gates on `selectedProducts.length > 0`.
- **Cart value changes when member picks Card:** this is correct, intentional, and matches the confirmation page. Worth a brief visual moment; if jarring, a later enhancement can add a loading indicator on the Fees row during refetch (not in scope here).
- **Stale comment removal:** the Individual branch's "fees only on confirmation page" comment will be deleted along with the branch collapse; no other code depends on that assumption.
