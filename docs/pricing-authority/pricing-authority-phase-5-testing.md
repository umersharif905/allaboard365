# Pricing Authority Phase 5 — Pre-PR testing walkthrough

Use this doc to manually verify everything works end-to-end before opening the PR. Expected total time: ~30 minutes if the dev servers are already running.

**Branch:** `feat/pricing-authority-phase-2` (head: `c4b6b13d`)

**The big test:** Phase 5 includes a frontend migration (commit `37977d19`) that deleted all client-side fee math from the enrollment wizard. The wizard now reads `displayPremium` from the backend authority response. **Browser verification of the 5 canonical flows in Part 2 is the gate** — if any flow shows a different number than it did before this branch, the migration regressed something.

---

## Part 1 — Automated checks (5 minutes)

Run these from the repo root. All three must pass before proceeding to manual verification.

### 1a. Backend test suite

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365-wt3/backend && npx jest --testPathIgnorePatterns=jest.live 2>&1 | tail -5
```

**Expected output:**
```
Test Suites: 4 failed, 24 passed, 28 total
Tests:       16 failed, 714 passed, 730 total
```

The 4 failing suites are pre-existing and unchanged by Phase 5:
- `backend/services/__tests__/bugReportWebhookService/bugReportWebhookService.live.test.js` — `.live` suite, needs live service.
- `backend/utils/__tests__/productProcessingFees.test.js` — asserts old ACH-hardcoded behavior replaced in Phase 1.
- `backend/routes/test.js` — pre-existing.
- `backend/routes/me/member/__tests__/plan-changes.test.js` — pre-existing `mockPool.request is not a function`.

If the failing count is HIGHER than 4, a Phase 5 change regressed something — don't merge until fixed.

### 1b. Permanent equivalence tests (the new regression shield)

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365-wt3/backend && npx jest \
  utils/__tests__/groupMemberFees.authority.test.js \
  services/__tests__/ApplyContributionsToExistingService.authority.test.js \
  services/plan-modifications/__tests__/planModification.authority.test.js \
  routes/__tests__/enrollment-links.authority.test.js \
  routes/__tests__/enrollment-links.complete.authority.test.js \
  routes/me/member/__tests__/product-changes-complete.authority.test.js \
  services/__tests__/invoiceCalculationService.authority.test.js \
  2>&1 | tail -5
```

**Expected output:**
```
Test Suites: 7 passed, 7 total
Tests:       684 passed, 684 total
```

If anything fails here, a migration broke something. Every parametrization compares the migrated production function against a pre-migration legacy reference — a failure means real behavior divergence.

### 1c. Lint rule (pricing drift prevention)

```bash
cd /Users/rova/Documents/AllAboard365/allaboard365-wt3/backend && npx eslint@8 . 2>&1 | tail -3
```

**Expected output:**
```
✖ 1 problem (1 error, 0 warnings)
```

The 1 error is the pre-existing parse error in the untracked `backend/services/NACHAService_temp.js` (unrelated to pricing). **Zero pricing warnings** is the goal.

Note the `@8`: the repo uses legacy `.eslintrc.json` which ESLint 10 doesn't support. The npx cache may pull 10 by default — pinning to v8 ensures the config loads.

---

## Part 2 — Canonical number verification (10 minutes)

Manually walk through the 7 test-plan surfaces and confirm every one shows the same numbers it showed before Phase 5. The full test plan lives at `docs/pricing-authority/pricing-authority-numbers-test-plan.md`.

**Prereqs:**
- Backend: `http://localhost:3001` (start from `backend/`: `node app.js`).
- Frontend: `http://localhost:5173` (start from `frontend/`: `npm run dev`).
- Login: `agent@allaboard365.com` / `testpass` (MightyWELL Health agent).

**Two anchor products to use:**
- **Included anchor:** MightyWELL Preventative HSA (ProductId `C20D8FCF-0C23-40FA-917C-1EFE646D46BC`).
- **Non-included anchor:** Bento Dental (ProductId `1D5DA922-31E6-401D-8346-D3340FDC4294`).

MightyWELL's fee rates: **ACH 0.8%, Card 3%, flat $0.**

### Test 1 — Agent Product Catalog / Pricing tab

1. Agent Portal → **Products** → View Details on **MightyWELL Preventative HSA** → **Pricing** tab.
2. Select age 35, config 1500.
3. Verify tier rows:
   - **EE:** $137
   - **ES / EC:** $193
   - **EF:** $236
4. Toggle Payment Method ACH ↔ Card. **Numbers must not change.** (Rule 2 — Included fees use 'Highest' policy, locked in Phase 1.)

Then View Details on **Bento Dental**:
5. Per-tier rows show the raw base premiums (no fee fold).
6. Toggle ACH ↔ Card — **numbers DO change** here (non-included fees follow method).

### Test 2 — Agent Bundle Simulator

1. Same nav, but View Details on a bundle product — **HSA Preventative (Individual)**.
2. Pricing tab → tier matrix. Age 35, config 1500, **ACH**:
   - EE row: **$317.97**
   - EF row: **$789.84**
3. Toggle to Card. Numbers change (sub-products are all non-included, fees switch with method).

### Test 3 — Agent Quick Quote

1. Agent Portal → Products → **Quick Quote** button.
2. Build: MightyWELL Preventative HSA only, age 35, EE, tobacco No.
3. Monthly Contribution on ACH: **$137.00**.
4. Toggle to Card: still **$137.00**.
5. Add Bento Dental at EE — total changes; ACH is ~2.2% cheaper than Card.

### Test 4 — Proposal PDF

1. Agent Portal → **Quote** → Generate proposal for a prospect selecting MightyWELL Preventative HSA EE.
2. Open the PDF. Line item for the MightyWELL Preventative HSA at EE should read **$137**.
3. Mixed-product quote totals should match what Quick Quote showed for the same selection.

### Test 5 — Member Plan-Change Cost Preview

Requires an existing group member whose group uses the **MaxEmployee** contribution strategy.

1. Log in as that member.
2. Navigate to Plan Changes / Product Changes.
3. Select adding a new plan. Observe the cost breakdown preview.
4. The `additionalFees` component (visible as fees on the preview) should equal `systemFees + includedFeeTotal(Card rate) + nonIncludedFeeTotal(group method rate)`.
5. If this member's preview previously displayed the same dollar amount for this same plan addition, it should show the same number today. Any movement by more than rounding is a regression.

### Test 6 — Group Enrollment Completion

1. Complete a group enrollment for a MightyWELL group with MaxEmployee contribution rules.
2. After submit, inspect the enrolled household's rows: employer/employee split should match the Phase 3.3 migration's output.
3. `oe.Enrollments` rows for the primary member: `IncludedPaymentProcessingFeeAmount` + `IncludedSystemFeeAmount` should be present and non-negative.

### Test 7 — Canonical Member Enrollment (the gold standard)

**This is the most important test. If this number is right and the others are right, Phase 5 is correct.**

1. Open the individual enrollment link flow as a **prospect** for MightyWELL Preventative HSA.
2. Fill in age 35, EE tier. Leave tobacco No.
3. Proceed to the product selection step. **Verify the HSA product card shows $137.00** (this is the `displayPremium` from commit `dc5b451a`, now rendered directly from the backend authority response).
4. Continue to the Review step.
5. **Monthly contribution must show $137.00 on ACH.**
6. Change payment method to Card.
7. **Monthly contribution must still show $137.00** (Rule 2 — locked in Phase 1 and preserved throughout).
8. Submit with `Submit without payment` or a test card. Verify no `PRICING_FINGERPRINT_MISMATCH` error.

If Test 7 shows anything other than $137.00 on either payment method at either step 3 or step 5, **STOP**. Do not merge. The core promise of the migration has failed.

### Test 7b — Bundle with variations (HSA Preventative Individual)

Phase 5 specifically reworked bundle display via the `computeDisplayPremiums` helper. Verify bundle variations still display correctly:

1. Open the enrollment link for **HSA Preventative (Individual)** bundle, age 35, EE, tobacco No.
2. On the product selection step, switch the HSA deductible variation (1500 / 3000 / 6000).
3. For each variation:
   - Bundle total card updates as expected.
   - Per-child-product pricing on the card reflects the variation's configValue.
4. Proceed to Review. On ACH, the Total should match Test 2's expected value ($317.97 at config 1500 EE).
5. Submit and verify fingerprint round-trip works (no `PRICING_FINGERPRINT_MISMATCH`).

---

## Part 3 — Submit-path spot-checks (10 minutes)

Phase 5 migrated the code that **actually charges** the payment processor and writes fees to the DB. Three spot-checks to confirm those paths are correct.

### 3a. /complete-enrollment pre-charge

1. Walk through an enrollment that triggers an immediate charge (pick a setup-fee product, or a tenant where `chargeFirstPaymentWithRecurring = false`).
2. On the Review step, note the displayed "First Payment Total" dollar amount.
3. Submit. In the DIME sandbox (or whatever payment processor log you have access to), verify the amount charged **exactly matches** the displayed total.
4. If there's a mismatch, the pre-charge block migration (commit `47f176e4`, site 3766) has a bug.

### 3b. /complete-enrollment persistence

1. After a successful individual enrollment, query:
   ```sql
   SELECT
     ProductId,
     PremiumAmount,
     IncludedPaymentProcessingFeeAmount,
     IncludedSystemFeeAmount
   FROM oe.Enrollments
   WHERE MemberId = '<test-member-id>'
     AND Status = 'Active'
   ORDER BY CreatedDate DESC
   ```
2. For each row, `IncludedPaymentProcessingFeeAmount` should match the displayed included fee per product (from the Review step breakdown).
3. The per-product sum should equal the total shown on Review.

### 3c. /product-changes-complete recurring fee

1. For a member whose recurring schedule runs in DIME, trigger a product change.
2. After submit, inspect DIME's updated recurring schedule entry. The recurring monthly amount should equal what the plan-change preview showed.
3. If DIME is charging a different amount than quoted, commit `bdf8129a` (product-changes-complete.js site 3109) has a bug.

---

## Part 3.4 — Member plan-change preview (3 minutes)

Commits `89c1ad56` + `3aa1e27b` + `c4b6b13d` migrated the member-side "Change my plan" wizard (`ProductChangeWizard.tsx`) to render fees from the backend authority instead of computing client-side. Deleted `frontend/src/services/feeCalculationService.ts` and `frontend/src/services/processingFeeCalculator.ts` entirely.

**Key flows to verify:**

1. Log in as an existing **group member whose tenant has `chargeFeeToMember: true`**. Navigate to the Product Change / Change my plan page (may be behind a feature flag — check `ProductChangeWizard.tsx:39` `IS_WIZARD_ENABLED` if needed).
2. Add a new product or change an existing one. Advance to the cost preview step.
3. **Verify**: "Processing Fee" and "System Fees" lines match what they showed for the same selection before this branch landed.
4. Open browser devtools → Network tab. Confirm the `/api/me/member/calculate-plan-change-cost` response body includes an `authority` object with `products`, `totals`, `display`, `pricingFingerprint`.
5. Submit the plan change (if feature flag allows). Confirm DIME recurring schedule updates to the expected amount (no `PRICING_FINGERPRINT_MISMATCH` in server logs).

**Edge cases specifically fixed by commit `c4b6b13d`:**

6. **Individual (non-group) member changing a plan** — `authority` field must be populated, not `null`. Before `c4b6b13d`, individual members would have seen $0 fees in the wizard (a regression from the old client-side fallback). The catch-all authority call added in `c4b6b13d` covers this case.
7. **Group member whose tenant has `chargeFeeToMember: false`** — same: `authority` should be populated, system-fee portion should match legacy behavior.

**What to watch for:** any member who previously saw non-zero fees in the plan-change preview now seeing $0. If that happens, the catch-all authority call isn't firing for that member — check server logs for `⚠️ Catch-all authority computation failed` warnings.

---

## Part 3.5 — Group invoice preview (2 minutes)

Commit `3503950a` migrated `invoiceCalculationService.calculateLocationFees` to use the same processing-fee primitive the enrollment authority calls internally. Before this commit, invoice previews could drift from enrollment charges if fee rules changed. Spot-check:

1. Log in as a GroupAdmin for a MightyWELL group that has multiple locations.
2. Navigate to Group Billing → Invoice Preview (or whatever the group-admin billing page is in your portal).
3. For each location shown, note the four fee line items:
   - Base Premium
   - System Fees
   - Payment Processing Fee
   - Setup Fees (if any)
   - Total
4. Compare to the same numbers from an equivalent month before this branch landed (if you have an older screenshot or production snapshot). They should be **identical** — the equivalence test proves the migrated function produces the same output for every input combination, including MightyWELL's ACH 0.8% / Card 3% rates and the per-household system-fee scaling.

**What to watch for:** if a location's "Payment Processing Fee" moves by ≥$0.01 from the pre-migration value, investigate — though the 108-scenario equivalence test should have caught that. If it shifts on one tenant but not others, check that tenant's `paymentProcessorSettings` for an unusual fee config (rare edge cases like flat-only or combo flat+percentage).

**Also relevant:** the group invoice preview endpoint is at `GET /api/me/group-admin/group/invoice-preview` (or similar — `routes/me/group-admin/group.js` + `routes/groupBilling.js` are the callers). If the page flat-out fails to load, check the server logs for a require error — commit `3503950a` added a new `require('../utils/processingFeeCalculator')` at the top of the service file.

---

## Part 4 — Fingerprint verification (2 minutes)

The pricing fingerprint is the hard-failure safety net. Quick check that it still rejects tampered fingerprints:

1. Open the browser devtools network panel.
2. Start an enrollment. On the Review step, capture the `POST /enrollment-links/:token/contribution-preview` response body.
3. Note the `authority.pricingFingerprint` value (looks like `sha256:abc123...`).
4. When you submit the enrollment (POST `/complete-enrollment`), the frontend should send that exact fingerprint in the request body (`pricingFingerprint` field).
5. To sanity-check the verify path: use the browser devtools to modify the outgoing `pricingFingerprint` to something different (e.g. `sha256:tampered`) before submit. The backend must respond with **400 `PRICING_FINGERPRINT_MISMATCH`**.

If you skip this step and the fingerprint path is broken, Phase 5's submit-path migration could silently charge the wrong amount. The fingerprint verify is what catches divergence between display and charge.

---

## Part 5 — Known deferrals / acceptable noise

These are NOT regressions — they're intentionally left for a Phase 6 follow-up:

### First-load flicker on product selection

When you land on the product selection step, the Total Monthly Contribution line may briefly show a system-fees-only value before `/product-pricing` returns and the Total settles to the correct number. This is intentional — commit `37977d19` deliberately removed the client-side fallback that used to recompute fees locally. The old fallback could silently drift from the backend; the new path fails loudly (console.warn) and shows a safe default until authority returns. Expect a ~200ms flicker on first load; then numbers should be correct and stable.

### Per-product debug display (`?debug=1`)

The per-product included-fee debug chip (shown on the confirmation page when you append `?debug=1` to the URL) reads from `contributionPreviewData.authority._raw.feeBreakdown.includedProcessingFeeByProductId`. If the authority's `_raw` shape changes in the future and this field disappears, the debug chip would go blank — the real pricing is unaffected. Worth a quick sanity check on one included-fee product in `?debug=1` mode during the walkthrough.

### Seven scalar lint exceptions in `enrollment-links.js`

Sites 3491, 3500, 5608, 5619, 10728, 10740, 11143 still call `calculateIncludedProcessingFeeForDisplay` (scalar primitive). These are NOT flagged by the lint rule after narrowing (commit `35d59236`) because they operate on one amount at a time, not multi-product composition. They were considered and left intentional; document in PR body if any future reviewer asks.

### Pre-existing non-Phase-5 test failures

Four Jest suites in backend fail for reasons that predate Phase 5 (see Part 1a). Don't let these distract from Phase 5 verification.

### Untracked files in working tree

`git status` on the branch shows a few untracked + modified files NOT part of Phase 5:
- `frontend/package-lock.json` — npm lockfile drift.
- `frontend/src/components/enrollment-wizard/EnrollmentWizard.tsx` — test-data autofill tweaks.
- `frontend/src/pages/enrollment-links/EnrollmentLinkTemplates.tsx` — unrelated details-modal fix from earlier in the session.
- `.playwright-mcp/`, `quick-quote-response.json` — scratch artifacts.
- `docs/pricing-authority/pricing-authority-numbers-test-plan.md`, `docs/superpowers/plans/2026-04-20-pricing-authority-phase-5.md`, `docs/pricing-authority/pricing-authority-phase-5-review.md`, `docs/pricing-authority/pricing-authority-phase-5-testing.md` — docs you may want in the PR or in a separate doc commit.

Decide which of those you want in this PR before pushing.

---

## Ship checklist

Before opening the PR:

- [ ] Part 1 all three checks pass (suite, equivalence tests, lint).
- [ ] Tests 1–7 in Part 2 all show expected numbers.
- [ ] 3a, 3b, 3c in Part 3 all match.
- [ ] Fingerprint verify in Part 4 works (tampered fingerprint → 400).
- [ ] Working-tree unrelated files resolved (commit doc files if you want them in the PR; leave scratch out).
- [ ] Push branch, open PR.

PR description should follow the user's standard format: overall strategy paragraph + per-file breakdown. The review doc at `docs/pricing-authority/pricing-authority-phase-5-review.md` can serve as source material. **Do NOT include a "Test Plan" section in the PR body** — that preference is noted in the user's persistent notes.
