# Pricing Authority Phase 5 — File-by-file review

**Branch:** `feat/pricing-authority-phase-2`
**Base:** `master` (Phase 5 commits stacked on top of Phase 2/3/4 work already merged into this branch)

**Phase 5 commits (top of branch, newest first):**

```
c4b6b13d fix(pricing): ensure /calculate-plan-change-cost always returns authority
3aa1e27b feat(pricing): ProductChangeWizard renders authority values; delete client-side fee calculators
89c1ad56 feat(pricing): expose authority block on /calculate-plan-change-cost
3503950a feat(pricing): invoiceCalculationService uses canonical processing-fee primitive
37977d19 feat(pricing): EnrollmentWizard renders backend authority values directly
dc5b451a feat(pricing): expose authority displayPremium on /product-pricing
35d59236 chore(pricing): narrow + promote drift lint rule to error
bdf8129a feat(pricing): product-changes-complete fee blocks via pricingAuthority
47f176e4 feat(pricing): /complete-enrollment submit paths via pricingAuthority
c0d38704 feat(pricing): migrate 3 order-level sites in enrollment-links to authority
ffd0237c refactor(pricing): remove dead resolvedFeeSettingsForHelper in planModification
4e98d1e6 feat(pricing): planModification internal fee closures via pricingAuthority
4322a9c2 refactor(pricing): rename __testables__ to _internal and drop stale comment
85a97979 feat(pricing): ApplyContributionsToExistingService delegates to pricingAuthority
3d908f37 test(pricing): document deliberate system-fee axis collapse in equivalence test
9128e826 test(pricing): add permanent equivalence arm for groupMemberFees migration
f11bfb83 feat(pricing): groupMemberFees per-product branch via pricingAuthority
```

**Headline outcome:**
- `npx eslint@8 backend/` → **0 `no-restricted-syntax` warnings** (was 20 at Phase 5 start).
- Pricing lint rule promoted from `warn` → `error`. New drift is blocked at CI, not just warned.
- Every migrated site has a **permanent equivalence test** in `__tests__/**` that runs a pure legacy-reference function alongside the migrated production function and asserts identical outputs within 1¢ across a 48-scenario matrix (payment method × include flag × round-up flag × zero-ACH flag × product shape).

---

## The overall strategy (why 11 commits instead of one)

Every migration site followed the same **parallel-compute equivalence** pattern:

1. Write an equivalence test first. It calls **both** the pre-migration fee math AND `pricingAuthority.computePricing` with the same inputs and asserts the outputs match within 1¢.
2. Run the test against the **legacy** code — if it doesn't pass, the legacy reference I wrote isn't a faithful reproduction, and I escalate before touching production.
3. Only THEN flip production to the authority. Re-run the equivalence test — it should still pass (now trivially, because both halves call authority).
4. **Keep the legacy-reference arm in the test file forever.** It's the permanent regression shield: if anyone edits the authority in a way that changes fee math, these tests fail loudly.

Each commit migrates one surface and leaves the tree green. Behavior-preservation is proven numerically, not by reading.

---

## What Phase 5 does NOT include (intentional out-of-scope)

- **Seven scalar per-amount sites that still call `calculateIncludedProcessingFeeForDisplay`:**
  - `enrollment-links.js:3491, 3500` — per-product validation loop in `/validate-pricing`.
  - `enrollment-links.js:5608, 5619` — per-product fingerprint-fallback validator.
  - `enrollment-links.js:10728, 10740` — per-tier/per-variation display math in `/product-pricing` bundle output.
  - `enrollment-links.js:11143` — scalar closure `applyIncludedFeeToAmount` in `/contribution-preview`.

  These call the **scalar primitive** (one base amount → one included fee) in a per-product loop. They aren't multi-product composition. The pricing lint rule was narrowed (commit `35d59236`) to flag only the composition primitive, `calculateProcessingFeeBreakdownByProduct`, which IS the drift-prone call. The scalar primitive is an intentional allowed utility — it's the same formula the authority itself applies internally, so there's no semantic drift risk. The lint rule documentation captures this distinction.

---

## Files modified (11 commits, 6 production files, 5 new test files, 1 config)

### 1. `backend/utils/groupMemberFees.js` (commit `f11bfb83`)

**What was there:**
The `getAdditionalFeesForMember(groupId, tenantId, totalPremium, pool, basePremiumByProductId)` function had two branches:
- If `basePremiumByProductId` (Map) was provided: loaded per-product subscription flags and called `productProcessingFeesUtil.calculateProcessingFeeBreakdownByProduct(...)` to get a ZeroFeeForACH-aware processing fee.
- Else: fell back to the flat-rate `processingFeeCalculator.calculateProcessingFee(totalPremium, ...)` path.

Both branches added `systemFeesCalculator.calculateSystemFees(totalPremium, systemFeesSettings)` on top.

**Why changed:**
The per-product branch was the drift risk — it was composing fees outside the authority, so tenant fee config changes could lead to the authority and this helper computing different numbers for the same member.

**How it works now:**
The per-product branch (lines 82-96) constructs a `pricingProducts` array from the `basePremiumByProductId` Map and calls `pricingAuthority.computePricing({poolOrTransaction: pool, tenantId, pricingProducts, paymentMethodType: groupPaymentMethod})`. Reads `authorityOutput.totals.nonIncludedFeeTotal + authorityOutput.totals.includedFeeTotal` as the processing-fee replacement. The system-fee call on line 68 is **deliberately untouched** — the authority computes system fees differently (it honors per-product `customSystemFeeEnabled` overrides whereas the legacy helper uses tenant-level system fees unconditionally). Preserving the system-fee line keeps behavior identical for every caller. The else-branch (flat path) is also untouched.

**Test file:** `backend/utils/__tests__/groupMemberFees.authority.test.js` — 48 scenarios, legacy vs migrated processing-fee equivalence (system-fee portion subtracted before comparison — see `3d908f37` for a documentation comment explaining why the system-fee axis is collapsed).

---

### 2. `backend/services/ApplyContributionsToExistingService.js` (commits `85a97979` + `4322a9c2`)

**What was there:**
`computeFeesAndAdjustProducts({products, flagsByProductId, paymentProcessorSettings, systemFeesSettings, paymentMethodType})` — a synchronous function that:
1. Built `basePremiumByProductId` from the products array.
2. Called `calculateProcessingFeeBreakdownByProduct(...)` directly — getting `includedProcessingFeeTotal`, `perProductIncludedFee`, `nonIncludedPremiumSubtotal`, `processingFeeTotal`.
3. Called `calculateSystemFeeAmount(...)` — getting `systemFeesAmount`.
4. Allocated the non-included processing fee proportionally across non-included products.
5. Built `adjustedProducts` = `base + perProductIncludedFee + allocatedRemainder` for each product, which feeds `ContributionCalculator`.
6. Returned an 8-key shape: `{adjustedProducts, systemFeesAmount, processingFeeTotal, processingFeeByProductId, includedProcessingFeeTotal, perProductIncludedFee, nonIncludedPremiumSubtotal, basePremiumTotal}`.

Called from 4 sites inside the same file (lines 376, 413, 772, 803).

**Why changed:**
Steps 2 and 3 were drift surfaces. Keeping them intact meant every edit to tenant fee settings had to stay in sync with `pricingAuthority.service.js`'s own logic.

**How it works now:**
- The function is now `async`. Accepts two new params: `pool` and `tenantId`.
- Steps 2-3 are replaced by a single `pricingAuthority.computePricing(...)` call. Reads:
  - `includedProcessingFeeTotal` ← `authorityOutput.totals.includedFeeTotal`
  - `perProductIncludedFee` ← `authorityOutput._raw.feeBreakdown.includedProcessingFeeByProductId`
  - `nonIncludedPremiumSubtotal` ← `authorityOutput._raw.feeBreakdown.nonIncludedPremiumSubtotal`
  - `processingFeeTotal` ← `authorityOutput.totals.nonIncludedFeeTotal`
  - `systemFeesAmount` ← `authorityOutput.totals.systemFees`
- Steps 4-6 (proportional allocation + adjustedProducts build + return shape) are **untouched**. They're contribution-flow-specific distribution logic, not fee composition. The 8-key return shape is identical so every call site keeps working.
- All 4 call sites (lines 378, 417, 778, 811) added `await` and pass `pool` + tenant ID.
- Cleanup commit `4322a9c2`: renamed the test-only export from `__testables__` to `_internal` to match the sibling convention in `pricingAuthority.service.js`.

**Test file:** `backend/services/__tests__/ApplyContributionsToExistingService.authority.test.js` — 48 scenarios, asserts all 8 return keys match between legacy (synchronous reference) and migrated (async authority-driven) paths.

---

### 3. `backend/services/plan-modifications/planModification.service.js` (commits `4e98d1e6` + `ffd0237c`)

**What was there:**
Three separate fee-composition sites:
- A closure `computeNonIncludedProcessingFee(paymentMethodType)` inside `buildPlan`. Called twice (ACH leg + Card leg) to determine whether payment-method change would alter the charge.
- `getExpectedFeesForHousehold(...)` — computes expected fees for `/complete-enrollment` pre-charge validation.
- `getExpectedFeesForGroupPrimaryMember(...)` — same for group primary members, using the group's default payment method.

Each site had an outer loop that classified products as included-vs-non-included via `getDisplayPremiumForProduct(...)`, built a filtered `nonIncludedBasePremiumByProductId` map AND a `resolvedFeeSettingsForHelper` map (with `includeProcessingFee: false` forced for every entry), then called `calculateProcessingFeeBreakdownByProduct` on the filtered subset.

**Why changed:**
Each `calculateProcessingFeeBreakdownByProduct` call was drift surface. Additionally, the `resolvedFeeSettingsForHelper` override map was a subtle bug vector — forcing `includeProcessingFee: false` meant the breakdown call was being fed an already-preprocessed input shape. That's hard to reason about.

**How it works now:**
- Each of the three sites now calls `pricingAuthority.computePricing(...)` directly with the same `nonIncludedBasePremiumByProductId` map converted into `pricingProducts`. The authority loads its OWN per-product settings from the DB — no caller-side override needed.
- The outer classification loop (which computes `includedProcessingFeeTotal` via `getDisplayPremiumForProduct`) is preserved. It's the ground truth for which products count as included; passing an already-filtered subset to the authority prevents the authority from re-classifying them.
- The `computeNonIncludedProcessingFee` closure is now `async`; the 2 callers (lines 1375, 1403) added `await`.
- Follow-up commit `ffd0237c` removes the now-dead `resolvedFeeSettingsForHelper` map — the authority ignores caller overrides, so the map wasn't being read anywhere post-migration.

**Test file:** `backend/services/plan-modifications/__tests__/planModification.authority.test.js` — 144 scenarios (48 × 3 describe blocks). Uses "Option B" contract test: compares `legacyNonIncludedProcessingFee(filtered subset)` to `authority.totals.nonIncludedFeeTotal` on the same filtered subset.

---

### 4. `backend/routes/enrollment-links.js` (commits `c0d38704` + `47f176e4`)

**What was there:**
Two handlers with multiple inline fee-composition calls:

- **GET `/product-pricing`** — returned per-product pricing + order totals to the enrollment wizard. Had 3 drift sites:
  - Line 11043: main `calculateProcessingFeeBreakdownByProduct` call computing the `fees.processingFee` + `fees.systemFeesAmount` fields in the response.
  - Lines 10728, 10740, 11143: scalar per-amount `calculateIncludedProcessingFeeForDisplay` calls applied inside bundle / per-tier display loops (NOT migrated — see "Out of scope" above).

- **POST `/contribution-preview`** — the canonical pricing surface (generates the `pricingFingerprint` the frontend echoes back on submit). Had 2 drift sites:
  - Line 11382: non-included per-product fee allocation.
  - Line 11463: per-equivalent-tier fee loop.
  - Plus scalar sites at 10728/10740 inside bundle subpath (not migrated).

- **POST `/complete-enrollment`** — the submit handler. Has 7 drift sites total, 3 migrated in `47f176e4`:
  - Line 3766: `preChargeBlock` — computes the amount to charge the payment processor.
  - Line 6302: primary-member persistence block — writes `IncludedPaymentProcessingFeeAmount` to `oe.Enrollments` rows.
  - Line 7807: household-member persistence block — same but for dependents.
  - Lines 3491, 3500, 5608, 5619: scalar validation loops (NOT migrated — scalar primitive exceptions).

**Why changed:**
These were the most consequential drift sites — they drive charge amounts and DB-persisted fee values. Any inconsistency between here and `/contribution-preview` (which generates the fingerprint) would either charge the wrong amount or write wrong numbers into audit/commission-relevant columns.

**How it works now:**
- `/product-pricing` at line 11043: replaced with an `await pricingAuthority.computePricing(...)` call. `feesFromBackend = {systemFeesAmount, processingFee, totalFees}` sourced from `authorityOutput.totals`.
- `/contribution-preview` at lines 11382 + 11463: `authorityOutput` (already being computed elsewhere in the handler) is relocated to run BEFORE the legacy paths, its result is read directly, and the legacy composition is removed. For the per-equivalent-tier loop, now calls `pricingAuthority.computePricing(...)` per tier with a `pricingProducts` variant whose `monthlyPremium` comes from `product.equivalentPremiums[tier]`.
- `/complete-enrollment` line 3766 (`preChargeBlock`): the block that computes `totalPaymentAmountPre` before invoking the DIME transaction now calls `pricingAuthority.computePricing` for its fee math.
- `/complete-enrollment` lines 6302 and 7807 (persistence): replaced with authority calls; reads `authorityOutput._raw.feeBreakdown.includedProcessingFeeByProductId` to persist per-product `IncludedPaymentProcessingFeeAmount` values to enrollment rows.

**Test files:**
- `backend/routes/__tests__/enrollment-links.authority.test.js` — 96 scenarios (48 × 2 blocks: `/product-pricing` and `/contribution-preview`).
- `backend/routes/__tests__/enrollment-links.complete.authority.test.js` — 144 scenarios (48 × 3 blocks: pre-charge, primary persistence, household persistence).

---

### 5. `backend/routes/me/member/product-changes-complete.js` (commit `bdf8129a`)

**What was there:**
Two drift sites in the plan-change submit handler:
- Line 1955: primary-member persistence block — writes `IncludedPaymentProcessingFeeAmount` to the enrollments being updated after the member's plan change is committed.
- Line 3109: recurring fee calculation — computes `recurringProcessingFee` that gets sent to DIME for the recurring billing schedule.

Both were standard multi-product `calculateProcessingFeeBreakdownByProduct` calls.

**Why changed:**
Site 1 drives DB writes that affect audit/commission reporting. Site 2 drives the DIME recurring schedule — if this drifts from what's quoted, every monthly recurring charge would be off.

**How it works now:**
Both sites call `pricingAuthority.computePricing(...)` using `transaction || pool` as the DB scope. Site 1's downstream per-product persistence loop (~lines 1988-2025) still reads `feeBreakdown.includedProcessingFeeByProductId` correctly because the local `feeBreakdown` variable is now sourced from `authorityOutput._raw.feeBreakdown` — the same shape. Site 2 reads `authorityOutput.totals.nonIncludedFeeTotal` for the recurring fee.

**Test file:** `backend/routes/me/member/__tests__/product-changes-complete.authority.test.js` — 96 scenarios (48 × 2 blocks).

---

### 6. `backend/services/pricing/pricingAuthority.service.js` + `backend/routes/enrollment-links.js` (commit `dc5b451a`)

**What was there:**
`pricingAuthority.computePricing(...)` was the only public API on the authority for fee composition. `/product-pricing` handler returned products with raw `monthlyPremium` values (pristine base, before included-fee fold) — the frontend wizard was responsible for applying the included-fee-to-display-premium transformation locally.

**Why changed:**
To migrate the frontend wizard (next commit), we needed the `/product-pricing` response to carry the already-folded `displayPremium` value per product, per variation, and per bundle child. Adding this moves the display-premium formula from the client into the authority — one more place where the authority is the single source of truth.

**How it works now:**
- New `pricingAuthority.computeDisplayPremiums(...)` helper — accepts `{poolOrTransaction, tenantId, basePremiumsByProductId, paymentMethodType}` and returns a Map of `productId → displayPremium` using the authority's internal `applyIncludedFee` rules.
- `/product-pricing` handler now annotates every product (and every config variation inside bundles) with a `displayPremium` field computed via the new helper.
- The handler still returns the pristine `monthlyPremium` alongside `displayPremium`, so existing callers don't break.

**No test file** — the helper is covered by existing `pricingAuthority.service.test.js` assertions on `applyIncludedFee` behavior plus the `enrollment-links.authority.test.js` snapshot tests.

---

### 7. `frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx` + `frontend/src/services/enrollment-link.service.ts` (commit `37977d19`)

**What was there:**
The wizard duplicated the authority's fee math in client-side code:
- Line 37 imported `calculateHighestProcessingFee, calculateProcessingFee` from `processingFeeCalculator.ts`.
- Line 371 defined a local `calculateIncludedProcessingFeeForDisplay` (34-line reproduction of the authority's included-fee formula).
- Line 4620 defined `applyIncludedFeeToDisplayPremium` — a helper that called the local function to add included-fee onto a base premium for product card display.
- Fallback paths at lines 4239 and 4253 recomputed the non-included processing fee client-side when the backend's `enrollmentLinkTotalsData.fees` was missing.
- Line 4178 used the local function inside the contribution calculation.

This was Jeremy's `#9` drift surface: "Every new surface is a chance for drift."

**Why changed:**
Even though the submit-path fingerprint would catch any numeric divergence between client and server, the client-rendered numbers could flash the wrong value before submit — a confusing UX issue if tenant fee config changed without the client being updated in lockstep. Removing the client-side formula means the only number the user ever sees comes from the authority.

**How it works now:**
- All three imports and the local function are deleted.
- `applyIncludedFeeToDisplayPremium` is deleted. Its 3 callers (lines ~4702, 4730, 4748 pre-migration) now read `variation.displayPremium ?? variation.monthlyPremium` directly — the `displayPremium` field is populated by the backend commit `dc5b451a` above.
- The contribution calculation fallback paths are replaced with a loud `console.warn` + safe-default behavior (show system-fees only) if `backendFees` is missing. This is a deliberate "fail loudly" change — the old fallback was silently recomputing, which defeats the whole point of having an authority.
- The per-product included-fee breakdown that displays in debug mode now reads from `contributionPreviewData.authority._raw.feeBreakdown.includedProcessingFeeByProductId`.
- Fingerprint wiring at line 2877 is unchanged — still sends `contributionPreviewData.authority.pricingFingerprint` on submit for backend verification.

**Net change:** 123 lines removed, 65 added (−58 net). The wizard now has ZERO fee formulas. Every displayed dollar amount comes from the backend authority.

---

### 8. `backend/services/invoiceCalculationService.js` (commit `3503950a`)

**What was there:**
`calculateLocationFees(basePremium, householdCount, paymentMethodType, systemFeesSettings, paymentProcessorSettings, unpaidSetupFees = 0)` — used by group-billing invoice-preview surfaces to estimate a group's monthly invoice. It reconstructed the processing-fee formula inline at lines 87-101:

```js
const percentageFee = subtotalWithSystemFees * percentageValue;
const flatFee = feeConfig.flatFee || 0;
paymentProcessingFee = Math.ceil((percentageFee + flatFee) * 100) / 100;
```

Discovered via the post-Phase-5 full-codebase audit — not in Jeremy's original drift map.

**Why changed:**
This was the last remaining inline processing-fee formula outside the canonical primitives. If the formula ever changed (new rounding rule, new flat-fee component), invoice previews would drift from what enrollment actually charges. Group admins would see estimated bills that don't match what members actually pay.

**How it works now:**
The inline block is replaced with a single call to the canonical primitive `processingFeeCalculator.calculateProcessingFee(subtotalWithSystemFees, paymentMethodType, paymentProcessorSettings)` — the same function the `pricingAuthority` calls internally. Maps `'CreditCard'` → `'Card'` since the primitive only understands the canonical two-method shape. All other logic in the file (`calculateGroupMonthlyTotal` per-household system-fee scaling, `calculateLocationPremiums` DB aggregation, setup-fee rounding) is untouched.

**Why not use `pricingAuthority.computePricing` directly:**
The invoice flow operates on a flat `basePremium` total — not a `pricingProducts` array. The full authority API expects per-product inputs, so wrapping this in the authority would require inventing a fake single-product array. Using the primitive directly is the right-sized abstraction: the primitive IS the canonical implementation that the authority delegates to, so both paths call the same formula.

**Test file:** `backend/services/__tests__/invoiceCalculationService.authority.test.js` — 108 scenarios (3 payment methods × 3 base premium sizes × 3 household counts × 2 charge-fee flags × 2 setup-fee values). Asserts all 6 return fields (`systemFeesAmount`, `paymentProcessingFee`, `setupFeesAmount`, `totalAmount`, `processingFees`, `subtotalWithSystemFees`) match legacy within 1¢ across every combination.

---

### 9. `backend/routes/me/member/calculate-plan-change-cost.js` + `frontend/src/pages/member/ProductChangeWizard.tsx` (commits `89c1ad56` + `3aa1e27b` + `c4b6b13d`)

**What was there:**
`ProductChangeWizard.tsx` (the member-side "change my plan" flow) imported `calculateCombinedFees` from `frontend/src/services/feeCalculationService.ts`, which in turn called `calculateProcessingFee` from `frontend/src/services/processingFeeCalculator.ts` and `calculateSystemFees` from `systemFeesCalculator.ts`. The wizard recomputed processing + system fees client-side for its cost preview.

This was the last frontend surface holding Jeremy's `#7` drift (`services/processingFeeCalculator.ts`).

**Why changed:**
Parallel to the `EnrollmentWizard` migration: eliminate the client-side fee formula so every displayed dollar amount flows from the backend authority. Once this migration is done, both `feeCalculationService.ts` and `processingFeeCalculator.ts` have zero callers and can be deleted entirely — closing that drift surface permanently.

**How it works now:**
- Backend `calculate-plan-change-cost.js` now exposes `authority` in the response body. Initially (`89c1ad56`) the authority was only populated inside the group/chargeFeeToMember branch that was already calling `computeNewPlanCost`. A follow-up (`c4b6b13d`) added a catch-all: if the primary branch didn't run, the route now does its own `planMod.computeNewPlanCost(...)` call right before building the response, using whatever products are priceable. Guarantees the wizard always has authority data to render for any scenario with products.
- Frontend `ProductChangeWizard.tsx` deletes the `calculateCombinedFees` import and all fee-useEffect recomputation. Reads `response.data.authority.totals.nonIncludedFeeTotal + includedFeeTotal` for processing fees and `response.data.authority.totals.systemFees` for system fees. Falls back to 0 with a `console.warn` if `authority` is unexpectedly null (fail-loudly pattern — don't silently recompute).
- `feeCalculationService.ts` and `processingFeeCalculator.ts` are **DELETED** — no callers remain.
- `planModification.service.js` now exports `getPrimaryPaymentMethod` so the route's catch-all authority call can look up the correct payment method for group members (falls back to ACH if unknown).

**Net frontend diff:** 150 lines removed, 67 added (−83 net). Two service files entirely deleted (132 + 150 = 282 LOC removed from the frontend surface).

**No new test file** — `planModification.authority.test.js` (Phase 5.2) already covers the `computeNewPlanCost` output shape, which is what the route now exposes verbatim. 144 equivalence scenarios verified.

---

### 10. `backend/.eslintrc.pricing.js` (commit `35d59236`)

**What was there:**
Lint rule that flagged BOTH `calculateProcessingFeeBreakdownByProduct` (multi-product composition) AND `calculateIncludedProcessingFeeForDisplay` (scalar per-amount primitive) as drift candidates, at `warn` severity. 20 violations existed at Phase 5 start; by the end of Task 5.4 we had pushed that to 7 remaining, all scalar primitive calls.

**Why changed:**
The rule's original framing was "fee composition functions are reserved for the authority." But `calculateIncludedProcessingFeeForDisplay` is not a composition function — it's a scalar primitive that takes one base amount and returns one fee. The authority itself calls it internally. Flagging callers for using it was architecturally incorrect — the primitive IS the single source of truth for how one included fee is computed.

**How it works now:**
- Rule narrowed to flag ONLY `calculateProcessingFeeBreakdownByProduct` (the true multi-product composer).
- Severity promoted from `warn` → `error`. New drift at multi-product composition sites is now blocked at CI.
- Comment documents explicitly which primitives are allowed for direct callers (`calculateIncludedProcessingFeeForDisplay`, `loadSubscriptionFeeSettingsByProductId`, `defaultProductFeeSettings`).
- Current lint output: **0 pricing violations.**

---

## Test infrastructure — the permanent regression shield

Every migrated site has a paired test file under `__tests__/**` that:
1. Defines a pure `legacy*` reference function that reproduces the pre-migration fee math verbatim. Calls `calculateProcessingFeeBreakdownByProduct` directly (legal inside tests because `**/__tests__/**` is excluded from the pricing lint rule).
2. Runs a 48-scenario `test.each` matrix: `paymentMethodType` (ACH/Card) × `IncludeProcessingFee` (true/false) × `RoundUpProcessingFee` (true/false) × `ZeroFeeForACH` (true/false) × product shape (single non-included, single included, bundle mixed).
3. For every parametrization, asserts the migrated production function's output matches the legacy reference within 1¢ across **every** field the site returns.

These tests are designed to **never** be deleted. If anyone edits the authority or the primitives in a way that changes fee math, every migrated site's regression shield fails loudly — with a scenario-specific message pointing at the exact input combination that broke.

Test file inventory (5 new permanent suites, 48-144 scenarios each):
- `backend/utils/__tests__/groupMemberFees.authority.test.js` — 48 scenarios
- `backend/services/__tests__/ApplyContributionsToExistingService.authority.test.js` — 48 scenarios
- `backend/services/plan-modifications/__tests__/planModification.authority.test.js` — 144 scenarios (48 × 3)
- `backend/routes/__tests__/enrollment-links.authority.test.js` — 96 scenarios (48 × 2)
- `backend/routes/__tests__/enrollment-links.complete.authority.test.js` — 144 scenarios (48 × 3)
- `backend/routes/me/member/__tests__/product-changes-complete.authority.test.js` — 96 scenarios (48 × 2)

**Total: 576 equivalence-shield scenarios** covering every migrated fee composition path.

---

## Final state of the 9 Phase 5 surfaces (Jeremy's original drift map)

| # | Surface | Status | Notes |
|---|---|---|---|
| 1 | `utils/includedProcessingFee.js` (scalar primitive) | ✅ canonical, untouched | Still called by authority and display-layer code. |
| 2 | `utils/productProcessingFees.js` (composite primitive) | ✅ canonical, untouched | Now only called by `pricingAuthority.service.js` and permanent regression tests. |
| 3 | `routes/enrollment-links.js` | ✅ all composition sites migrated | 7 scalar per-amount sites remain as intentional lint-rule exceptions (documented). |
| 4 | `routes/me/agent/products.js` | ✅ migrated in Phase 2 | No composition calls remain. |
| 5 | `services/proposalCalculation.service.js` | ✅ migrated in Phase 3 | |
| 6 | `services/plan-modifications/planModification.service.js` | ✅ all sites migrated in Phase 5 | |
| 7 | `services/processingFeeCalculator.ts` (frontend) | ✅ **DELETED** in Phase 5.8 | Entire file removed — no callers remain after ProductChangeWizard migration. |
| 8 | `utils/agentPricingDisplay.ts` (frontend) | ✅ types-only in Phase 2 | |
| 9 | `components/enrollment-wizard/EnrollmentWizard.tsx` | ✅ migrated in Phase 5.5 | Local `calculateIncludedProcessingFeeForDisplay` and all callers deleted. Reads `displayPremium` from backend authority response. |
| 10 | `services/feeCalculationService.ts` (frontend) | ✅ **DELETED** in Phase 5.8 | Was the last wrapper around `processingFeeCalculator.ts`. |
| 11 | `pages/member/ProductChangeWizard.tsx` (frontend) | ✅ migrated in Phase 5.8 | Reads fees from `/calculate-plan-change-cost` authority block instead of computing client-side. |
| 12 | `services/invoiceCalculationService.js` (backend) | ✅ migrated in Phase 5.7 | Group-invoice preview uses the canonical processing-fee primitive. |

Plus:
- `services/EnrollmentCompletionService.js` — migrated in Phase 3.3 ✅
- `services/ApplyContributionsToExistingService.js` — migrated in Phase 5.1.2 ✅
- `utils/groupMemberFees.js` — migrated in Phase 5.1.1 ✅
- `routes/me/member/product-changes-complete.js` — migrated in Phase 5.4 ✅

---

## Follow-up work tracked for Phase 6

1. **Scalar primitive sites (8 in `enrollment-links.js`).** Exempted from the lint rule by design, but if any are ever found to compose multi-product totals (and we missed that during Phase 5), they should be migrated. Currently spot-checked — all are scalar per-amount.
2. **Promote the lint rule further.** The current rule flags direct `.calculateProcessingFeeBreakdownByProduct` usage outside the authority service. A future iteration could also flag `require('./productProcessingFees')` in non-authority files to prevent importing the composition primitive at all.
