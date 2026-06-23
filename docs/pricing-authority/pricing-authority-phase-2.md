# Pricing Authority Migration — Phase 2 Summary

**Branch:** `feat/pricing-authority-phase-2`
**Commits vs master:** 4
**Context:** Phase 2 of the pricing-authority migration Jeremy started in Phase 1 (`5a18c916`). Phase 3 (proposals + plan modifications) and Phase 4 (cleanup) are still TODO. Full plan: `docs/plans/2026-04-17-pricing-authority-migration-phases-2-4.md`.

---

## The issue Phase 2 solves

**Agent-portal pricing drifted from what members actually got charged.** When an agent viewed the product catalog, bundle simulator, or built a quick-quote for a prospect, the displayed price assumed ACH-rate processing fees. But for any product/bundle whose tenant subscription had `IncludeProcessingFee=true`, the actual charge at enrollment time uses the **Highest (Card) rate** per the policy Jeremy encoded in Phase 1. Consequences:

- Agents quoted $X to a prospect; the member later saw $X+delta on the enrollment review.
- Same drift pattern as the HSA Preventative bundle bug ($355 quoted / $357 charged) Jeremy's Phase 1 fixed for the enrollment flow — but the agent entry points still had it.
- Three direct callers of fee primitives in `backend/routes/me/agent/products.js` were hardcoding `paymentMethod: 'ACH'` or passing an ACH/Card variable instead of delegating to `pricingAuthority`.
- Seven client-side computation helpers in `frontend/src/utils/agentPricingDisplay.ts` were doing their own fee math (also ACH-hardcoded), creating a second drift attractor. Turned out no component was actually calling them — they were dead code, but deleting them was still load-bearing so a future contributor doesn't reach for them.

## The fix

One architectural rule enforced across two files:

> **All agent-portal pricing math goes through `pricingAuthority.computePricing`.** No direct calls to `calculateIncludedProcessingFeeForDisplay` or `calculateProcessingFeeBreakdownByProduct` outside the authority service. No client-side fee math.

The authority internally enforces "included fees always at Highest, non-included fees at member's method, `zeroFeeForACH` honored." Callers pass the member's real payment method and trust the service to apply the policy.

Drift from this rule now surfaces as a cryptographic runtime error: the authority response contains a `pricingFingerprint` (SHA256 of the canonical pricing state) that clients echo back at submit time, and the backend rejects any mismatch with `PRICING_FINGERPRINT_MISMATCH`.

---

## File-by-file change breakdown

### `backend/routes/me/agent/products.js`
Three direct primitive-call sites were replaced:

| Handler | Before | After |
|---|---|---|
| `/:productId/pricing` product-tab display (~line 227) | Direct call to `includedProcessingFeeUtil.calculateIncludedProcessingFeeForDisplay` with hardcoded `paymentMethod: 'ACH'` | Calls `pricingAuthority._internal.applyIncludedFee` (catalog-shape endpoint, full `computePricing` isn't structurally applicable because it returns rows of many tiers, not a single quote) |
| `/:productId/pricing/bundle-simulator` (~line 406) | Inline fee-folding loop + direct `calculateProcessingFeeBreakdownByProduct` | Single `pricingAuthority.computePricing` call per tier; each tier row now carries an `authority` block, plus top-level `authority` from the EE tier |
| `/quick-quote/calculate` (~line 1591) | Inline included-fee loop + direct `calculateProcessingFeeBreakdownByProduct` | Single `pricingAuthority.computePricing` call per scenario; top-level `authority` block mirrors the first scenario's fingerprint |

Secondary cleanup:
- Removed unused imports (`includedProcessingFeeUtil`, `processingFeeCalculator`).
- Deleted ~40 lines of dead state (former `chargeFeeToMember` / `customSystemFees` locals that had been silenced with `void` statements).
- Extracted `pickBundleSimulatorTierSelections` to separate sync row-selection from async authority pricing.
- Replaced a fragile positional lookup (`filter((_, idx) => pickedRows[idx].productId)`) with a productId-keyed map read against `authorityOutput._raw.subscriptionFeeSettingsByProductId`.
- Legacy response fields (`bundleTotalsByTier`, `breakdown`, `totals`, `quoteOptions`) still populated — `authority` is additive, nothing breaks.

### `backend/routes/me/agent/__tests__/products.pricing.test.js` (new)
12 supertest-based integration tests. Mocks: `getPool`, auth middleware, `PricingEngine`. Does **not** mock `pricingAuthority` — the real service runs so a drift regression would fail the suite. Key assertions:
- Each handler response has `authority.pricingFingerprint` matching `/^sha256:[0-9a-f]{64}$/`.
- Fingerprint is deterministic across two identical requests (lock against non-determinism bugs).
- `authority.totals.monthlyContribution` is a finite number.
- `authority.display.lineItems` length > 0 when products were returned.
- **Highest-policy regression:** $100 premium with `IncludeProcessingFee=true` produces `$3.00` included fee (Card 3% rate), not `$0.80` (the old ACH hardcode).
- Legacy field backward-compat assertions.

### `frontend/src/utils/agentPricingDisplay.ts`
Shrunk 236 → 139 lines. Removed seven computation helpers that duplicated backend math client-side: `getMemberPricingBreakdown`, `getDisplayedMemberPremiumForRow`, `getProductTabPremiumDisplay`, `getBundleTierSystemFees`, `getFeeConfigForProductId`, `getBasePremiumFromPricingRow`, `enrichPricingRowsWithMemberDisplay`.

Kept type exports (still referenced by `useAgentProductPricing.ts`): `ProductFeeConfig`, `DEFAULT_PRODUCT_FEE_CONFIG`, `AgentPricingFeeContext`.

Added TypeScript types mirroring the backend `pricingAuthority.computePricing` return shape so downstream consumers can type the response:
- `AuthorityProductRow` — per-product row with `basePremium`, `includedFee`, `displayPremium`, nested `includedProducts[]` for bundles
- `AuthorityTotals` — six scalar totals (`basePremiumTotal`, `includedFeeTotal`, `nonIncludedFeeTotal`, `systemFees`, `displayPremiumTotal`, `monthlyContribution`)
- `AuthorityDisplay` — pre-formatted `lineItems` and `summary.rows` that the UI renders verbatim; `policies` block documents the rate choices in effect
- `AuthorityBlock` — top-level shape including `pricingFingerprint`; opaque `_raw?: unknown` field models the backend's internal-debug data

File-header docblock calls out the "no client-side math" contract explicitly so a future contributor doesn't re-add a helper.

### `frontend/src/utils/__tests__/agentPricingDisplay.test.ts` (new)
7 Vitest-based tests that enforce the types-only contract:
- Only runtime value export is `DEFAULT_PRODUCT_FEE_CONFIG` (a future contributor adding `export function calcFoo()` fails this).
- `DEFAULT_PRODUCT_FEE_CONFIG` shape matches backend `defaultProductFeeSettings()`.
- Exercises `AuthorityProductRow` / `AuthorityBlock` sample data to type-check.

This test catches regressions `tsc --noEmit` cannot (function exports are runtime-observable, not type-level).

---

## Commit history on this branch

```
7581b96f fix(pricing): address Task 2.2 review — model _raw + narrow summary.row.key
524870ef feat(pricing): agent portal consumes authority display blocks
2397f3f2 fix(pricing): address Task 2.1 code review — remove positional dep + dead code
3b753eed feat(pricing): migrate agent product routes to pricingAuthority
```

---

## Manual test plan

**Prereqs:** Backend on `http://localhost:3001`, frontend on `http://localhost:5173`. Both are running (dev). Log in as an **agent** for **MightyWELL Health** (the tenant that has `IncludeProcessingFee=true` subscriptions — the HSA Preventative family and the CoPay bundles).

Every test below is structured: **step → expected outcome → what to check in DevTools/DB**.

### Test 1 — Bundle simulator shows authority fingerprint

1. Navigate to the agent product catalog and open a bundle product (e.g. **MightyWELL - Preventative HSA**).
2. Trigger the bundle pricing simulator (tier/age/tobacco matrix).
3. Open DevTools → Network tab → find the `POST` to `/api/me/agent/products/*/pricing/bundle-simulator`.
4. Inspect the response JSON body.

**Expected:**
- Top-level `authority` block with `pricingFingerprint` matching `sha256:<64 hex chars>`.
- Each tier row also has its own `authority` object.
- `authority.display.policies.includedFeeMethod === "Highest"`.
- Legacy fields like `bundleTotalsByTier` still populated.

### Test 2 — Fingerprint determinism

1. Immediately re-trigger the same simulator request (same inputs).
2. Compare the two `authority.pricingFingerprint` values.

**Expected:** bit-for-bit identical hashes. Non-deterministic hashes would be a bug.

### Test 3 — Highest policy verified against a known product

1. Pick an `IncludeProcessingFee=true` sub-product — `MightyWELL Preventative HSA` at config value `1500` (base premium $133).
2. Either via the simulator or a quick-quote, get the price.
3. Read `authority.products[i].includedFee` and `authority.products[i].displayPremium`.

**Expected:** included fee is **$4** (Card rate 3% of $133 = $3.99 → rounds up to $4 per `roundUpProcessingFee`), NOT $1–2 (the old ACH-based $0.80–$1.06 → $1 or $2 outcome). Display premium is $137.

### Test 4 — Quick-quote carries authority per scenario

1. Build an agent quick-quote with at least one bundle and at least one standalone product that have different fee policies.
2. Network tab → find `POST /api/me/agent/quick-quote/calculate`.

**Expected:**
- Response has top-level `authority` block.
- Each scenario in `data[]` has its own `authority` block with a distinct `pricingFingerprint`.
- `totals.monthlyContribution` matches `authority.totals.monthlyContribution`.

### Test 5 — Frontend renders authority values, not client-computed

1. On the agent product list or detail page, open React DevTools (or inspect the rendered DOM).
2. Confirm the displayed price strings match `response.authority.products[i].displayPremium` (or `computedMemberDisplay.totalMemberPrice` for the catalog endpoint).
3. Check the Sources tab: `frontend/src/utils/agentPricingDisplay.ts` should only export types — no computation functions should be callable.

**Expected:** prices come from backend response fields. Setting a breakpoint inside `applyIncludedFeeToDisplayPremium` or `calculateIncludedProcessingFeeForDisplay` (if those are still defined — Phase 4 will delete them) should NOT hit during agent-portal navigation.

### Test 6 — Agent-quoted price equals member-facing price

This is the **money test** — the whole point of Phase 2.

1. As agent: quote a member for the HSA Preventative bundle. Note the `monthlyContribution` shown.
2. Log out, enter the flow as a member on an enrollment link for the same bundle (MightyWELL Health tenant).
3. Navigate to the Review step.

**Expected:** Review total matches what the agent saw exactly. If they differ, Phase 2 is incomplete.

### Test 7 — DB sanity on a test enrollment (optional)

1. Complete a test member enrollment for `MightyWELL Preventative HSA` bundle.
2. Query:
   ```
   cd ai_scripts
   ./db-query.sh "SELECT TOP 1 EnrollmentId, PremiumAmount, IncludedPaymentProcessingFeeAmount, CreatedDate FROM oe.Enrollments WHERE ProductId IN (SELECT ProductId FROM oe.Products WHERE Name = 'MightyWELL Preventative HSA') ORDER BY CreatedDate DESC"
   ```

**Expected:** `PremiumAmount` = $133, `IncludedPaymentProcessingFeeAmount` = $4. Matches what the Review screen and the agent quote both showed.

### Test 8 — Regression: no non-agent flow breaks

1. As a member, complete a plain enrollment (not via the agent quote) for a product without `IncludeProcessingFee`. Ensure display and charge both succeed at the expected price.
2. As an agent, view commissions / downlines / any non-pricing feature.

**Expected:** no regression in unrelated agent or member flows. This migration was scoped to pricing only.

---

## Known follow-ups (not blocking)

- **`_internal.applyIncludedFee` and `_raw.subscriptionFeeSettingsByProductId` are production consumers of "private" authority surface.** Promote to public API in a Phase 2 polish PR, or expose equivalent first-class fields.
- **Per-scenario / per-tier `computePricing` calls re-read tenant settings + subscription rows** — N+1 DB pattern for quick-quote with many scenarios (typically 1–4, acceptable). Consider batching / caching in Phase 4.
- **4 pre-existing test failures** in `backend/utils/__tests__/productProcessingFees.test.js` — these assert the OLD ACH-rate behavior for included fees and date from before Jeremy's Phase 1 policy change. Need updating to match the new "always Highest" contract; file is not touched by Phase 2 so not addressed here.
- **`routes/me/agent/products.js:1460-1486`** still loads `feeSettingsByProductId` that is no longer read by any surviving code path. Left in place pending the Phase 4 cleanup task.

---

## Run local

Backend: `http://localhost:3001` — `cd backend && NODE_ENV=development node_modules/.bin/nodemon app.js`
Frontend: `http://localhost:5173` — `cd frontend && npm run dev`
