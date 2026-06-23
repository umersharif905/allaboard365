# Pricing Authority — How the numbers work, and how to verify them by eye

**Context:** this is the "I just want to trust the numbers" follow-up to the Phase 3+4 report. It's written assuming you haven't looked at the code yet — so it starts by teaching you Jeremy's rules, then maps every surface we migrated back to those rules, then gives you a concrete by-the-numbers test script.

---

## Part 1 — Jeremy's rules (Phase 1, `backend/services/pricing/pricingAuthority.service.js`)

The authority service is the **one** place these rules live. Everything else is supposed to ask it: "given these products and this payment method, what are the numbers?"

### Rule 1. Every product's fee lives in one of two buckets

Per-tenant, per-product, there's a subscription flag called `IncludeProcessingFee`:

- **Included (`IncludeProcessingFee = true`)** — the processing fee is *folded into* the quoted premium. The member sees a single line: "HSA Preventative, $137/mo." There's no separate "fees" row for this product.
- **Non-included (`IncludeProcessingFee = false`)** — the fee is a *separate* line item at the bottom of the order. "Bento Dental $100.54, Fees $X".

### Rule 2. The "Highest" policy applies to Included fees only

For an **Included** product, the fee is always computed at the **more expensive** of the tenant's ACH/Card rates. In practice that's always **Card (3%)** — because Card > ACH (0.8%) for every tenant you'll ever see.

**Why:** the member ends up paying the same quoted price whether they picked ACH or Card at enrollment. The tenant eats the ~2.2% delta when the member picks ACH (because they only actually pay the processor the ACH rate, but they folded the higher Card rate into what they quoted).

**Translation:** on screens that price an Included product, switching the payment method dropdown between ACH and Card should NOT change the displayed total.

For a **Non-included** product, the fee uses the member's actual payment method. The separate fees line WILL change when the method switches.

### Rule 3. `roundUpProcessingFee` — how the Included fee becomes a whole-cent number

For every MightyWELL product except "MightyWELL Dental" (base subscription), the flag `RoundUpProcessingFee = true`. The math:

1. Take the base premium, call it `B`.
2. Compute raw Card fee: `B × 0.03` (plus any flat fee — $0 at MightyWELL).
3. Total before rounding: `B + (B × 0.03)`.
4. Round that total **UP to the nearest whole dollar**.
5. Included fee = rounded total − B.

**Worked example on MightyWELL Preventative HSA EE @ $133:**

```
B = 133.00
raw fee = 133 × 0.03 = 3.99
raw total = 136.99
round UP = 137.00     ← Jeremy's formula: Math.ceil(total)
included fee = 137 − 133 = 4.00
```

Display premium = $137.00. Same on ACH. Same on Card.

When `RoundUpProcessingFee = false` (only MightyWELL Dental on MightyWELL), included fee is just the raw percentage rounded to 2 decimals — no "bump up to whole dollar" step.

### Rule 4. `zeroFeeForACH` — override for members paying ACH

If a subscription has `ZeroFeeForACH = true`:
- Member paying ACH → $0 processing fee for that product.
- Member paying Card → normal Card rate.
- On screens using "Highest" (the quoted price logic for Included products), the ACH leg becomes $0, so "Highest" reduces to just the Card rate — same number as without the flag. `zeroFeeForACH` only produces a visible difference when the member has actually picked ACH and we're in a non-Highest context.

(Currently no MightyWELL product has `ZeroFeeForACH = true`, so you can't exercise this by eye on MightyWELL — noted for completeness.)

### Rule 5. Bundles apply the rule per sub-product

A bundle is just a wrapper. Each sub-product is priced under its *own* `IncludeProcessingFee` flag. So a bundle that contains some Included and some Non-included children would show some of its pricing folded (Included children) and the rest as separate fees (Non-included children).

The bundle-level numbers are sums of the children's numbers. There's no bundle-specific fee logic.

### Rule 6. System fees are order-level, not per-product

Applied once at the ORDER total, computed off the pre-fee base premium total. `customSystemFeeEnabled` + `customSystemFeeAmount` on a subscription override the tenant-level system-fee ladder. Not typically where drift shows up, but it's the 3rd line of the summary.

---

## Part 2 — Where those rules now get applied (post Phase 2+3+4)

Every surface below calls `pricingAuthority.computePricing(...)` and renders the response. If the numbers are right on one surface and wrong on another, the bug isn't in the math — it's in how the surface is reading the authority response.

| # | Surface | File touched | Rules exercised |
|---|---|---|---|
| 1 | **Agent product catalog → Pricing tab** (per-tier table) | `backend/routes/me/agent/products.js` `/:productId/pricing` | Rules 1, 2, 3, 4 per row |
| 2 | **Agent bundle pricing simulator** | `backend/routes/me/agent/products.js` `/:productId/pricing/bundle-simulator` | Rules 1, 2, 3, 5 (bundle sum) |
| 3 | **Agent quick-quote** | `backend/routes/me/agent/products.js` `/quick-quote/calculate` | Rules 1, 2, 3, 5, 6 (system fees in totals) |
| 4 | **Business proposal PDF pricing sections** | `backend/services/proposalCalculation.service.js` `applyQuoteFeesToParts` | Rules 1, 2, 3, 5, 6 |
| 5 | **Member plan-change cost preview (MaxEmployee path)** | `backend/routes/me/member/calculate-plan-change-cost.js` + `planModification.computeNewPlanCost` | Rules 1, 2, 3 (feeds ContributionCalculator) |
| 6 | **Group enrollment completion (MaxEmployee additionalFees)** | `backend/services/EnrollmentCompletionService.js` | Rules 1, 2, 3 |
| 7 | **Member enrollment `/contribution-preview` + `/complete-enrollment`** | Phase 1 (Jeremy) — `backend/routes/enrollment-links.js` | All rules — this is the canonical reference surface |

Every surface reads its numbers from the same code path inside `pricingAuthority.service.js`. If #7 (Jeremy's enrollment flow) shows $137 for a MightyWELL Preventative HSA EE, then #1–#6 must also show $137 for the same inputs, or one of them is failing.

**What the migration actually guarantees:** #1 through #6 are no longer allowed to compute fees themselves. They either ask the authority or they show a broken number.

---

## Part 3 — Test script (numbers only, no fingerprints)

**Prereqs:** backend on :3001, frontend on :5173 (both are up as of restart). Log in as `agent@allaboard365.com` / `testpass` (MightyWELL Health agent — Jeremy Francis's test account). For member-side tests you'll need an active MightyWELL member; any household from the MightyWELL tenant works.

The MightyWELL fee rates (confirmed live in DB): **ACH 0.8%, Card 3%, flat $0.**

### Test bed — two anchor products

These are the two products you'll use as controls. Both live in MightyWELL Health.

| Nickname | Real name | ProductId | `IncludeProcessingFee` | `RoundUp` | `ZeroACH` |
|---|---|---|---|---|---|
| **"Included anchor"** | MightyWELL Preventative HSA | `C20D8FCF-0C23-40FA-917C-1EFE646D46BC` | **true** | true | false |
| **"Non-included anchor"** | Bento Dental | `1D5DA922-31E6-401D-8346-D3340FDC4294` | **false** | true | false |

### Expected numbers

#### Included anchor — MightyWELL Preventative HSA

| Tier | Base premium | Card 3% | Round-up total | Included fee | Display premium |
|---|---|---|---|---|---|
| **EE** | $133.00 | $3.99 | **$137** | **$4.00** | **$137.00** |
| ES / EC (same pricing) | $187.00 | $5.61 | **$193** | **$6.00** | **$193.00** |
| EF (Family) | $229.00 | $6.87 | **$236** | **$7.00** | **$236.00** |

Same numbers on ACH and Card. This is Rule 2 — the number cannot change when you toggle payment method.

#### Non-included anchor — Bento Dental at EC tier

Base premium was $100.54 when I checked; may drift if configs change. Rule for the fees row:

| Payment method | Fees line item |
|---|---|
| ACH | `$100.54 × 0.008 = $0.80` → **$0.80** |
| Card | `$100.54 × 0.03 = $3.02` → **$3.02** |

The base premium line stays at $100.54 either way. Only the "Fees" row changes.

---

### Test 1 — Agent product catalog / Pricing tab (surface #1)

1. Agent Portal → **Products** → click **View Details** on any MightyWELL product → **Pricing** tab.
2. Select age 35 (or any age in range), config value 1500 if applicable.
3. Look at the tier rows. For **MightyWELL Preventative HSA**:
   - EE row should say **$137** (or $137.00).
   - ES / EC should say **$193**.
   - EF should say **$236**.
4. Switch the Payment Method dropdown from ACH → Card. **Numbers must not change.** (Rule 2.)

Then pick a non-included product (e.g. **Bento Dental**). The per-tier total should match the raw tier base premium (no fold), and switching ACH ↔ Card produces two different totals — because the non-included fee is elsewhere (not folded into this per-tier row).

### Test 2 — Agent bundle simulator (surface #2)

1. Same nav, but open a product marked "Bundle" — **HSA Preventative (Individual)**.
2. Pricing tab → you'll see the tier matrix. For age 35, config 1500, ACH:
   - EE row: **$317.97** (this is `Lyric $3.25 + HSA MEC $90.47 + ShareWELL $125.00 = $218.72` base, plus non-included fees at ACH rate plus system fees).
   - EF row: **$789.84**.
3. Switch the Payment Method dropdown to Card. These numbers WILL change, because the 3 sub-products in this particular bundle are all `IncludeProcessingFee=false` → their fees are non-included and switch with method.

**Contrast:** in principle a bundle containing a MightyWELL CoPay Silver sub-product (Included=true) would show a PARTIAL fold. MightyWELL doesn't currently bundle those sub-products, so this contrast is a mental exercise not a click target.

### Test 3 — Agent quick-quote (surface #3)

1. Agent Portal → Products → **Quick Quote** button at the top.
2. Build a quote with **MightyWELL Preventative HSA** only, age 35, tier EE, tobacco No.
3. Monthly contribution row should read **$137.00** on ACH.
4. Toggle payment method to Card. Still **$137.00**. (Rule 2 passes.)
5. Add **Bento Dental** as a second line. Monthly contribution changes; the delta between ACH and Card is `(Bento base × 0.03) − (Bento base × 0.008)` = roughly 2.2% of Bento's base. So if Bento base is $100.54, ACH total should be ~$2.22 cheaper than Card total.

### Test 4 — Proposal PDF pricing section (surface #4)

1. Agent Portal → **Quote** → **Generate a proposal** for a prospect selecting MightyWELL Preventative HSA at tier EE.
2. Open the rendered PDF. The pricing section line item for the MightyWELL Preventative HSA tier should read **$137** (allowing for whole-dollar rounding in the PDF formatter).
3. For a quote with multiple products (mix included and non-included), the pricing section total should match what the quick-quote screen showed.

*Implementation note for this test:* `proposalCalculation.service.js` now returns an `authority` field from `applyQuoteFeesToParts` that contains `authority.display.lineItems` — if the PDF formatter is still rendering from the legacy `totalPremium` field instead, the number is still correct (since both come from the same authority math), just not drawn from the fingerprint-verified path. Either way, the number you see should match Test 3's quick-quote.

### Test 5 — Member plan-change cost preview (surface #5)

This one requires an existing group member in MightyWELL who has MaxEmployee contribution rules. The migration affected the **additionalFees** piece of the preview, not the plan premium itself.

1. Log in as a group member whose group uses the MaxEmployee contribution strategy.
2. Navigate to Plan Changes / Product Changes.
3. Select adding a new plan. Observe the cost breakdown on the preview screen.
4. The **employer contribution** and **employee cost** you see here come from `ContributionCalculator.calculateContributions` — we didn't touch that. What we DID touch is the `additionalFees` input it receives.
5. Sanity check: the `additionalFees` total should equal `(system fees) + (included fee total, at Card rate) + (non-included fee total, at the group's payment method rate)`.

Since this is a back-end quantity fed into another calculator, the eye test is: does the contribution split look consistent with prior plan-change previews you've reviewed? If it shifted by a couple of dollars after this merge, the shift matches the previous "Highest" vs "ACH-hardcoded" fix.

### Test 6 — Group enrollment completion (surface #6)

Same pattern as Test 5 but on initial group enrollment. Test this by completing a group enrollment for a MightyWELL group with MaxEmployee rules, and check that the enrolled household rows persist the correct employer/employee split.

### Test 7 — Canonical reference: member enrollment (surface #7, Phase 1)

This is Jeremy's original migration — **use it as the source of truth when cross-checking other surfaces.**

1. Enter the individual enrollment link flow as a prospect for MightyWELL Preventative HSA.
2. Fill in age 35, EE tier.
3. Review screen should show **$137.00 monthly contribution** on ACH, same on Card.
4. Any other surface that shows a different number for the same product + same member inputs is the bug. (None of our Phase 2+3+4 surfaces will — they all call the same authority — but this is the one to trust when in doubt.)

---

## Part 4 — What to do if a number looks wrong

Not a bug report template, a thought process:

1. **Is it an Included product showing different numbers on ACH vs Card?** Rule 2 violation. The surface is ignoring the authority response and computing its own fee somewhere.
2. **Is it a Non-included product showing the SAME number on ACH and Card?** Surface is frozen to one method or passing `paymentMethodType` wrong.
3. **Is the Included-product total $X.80 instead of $X.00 (whole dollar)?** `roundUpProcessingFee` was skipped. Check that the product's subscription actually has the flag set.
4. **Is the Included fee showing as the ACH rate (~0.8% of base) instead of Card rate (~3% of base)?** Old ACH-hardcoded path — exactly what Phase 2 fixed. Either the surface missed the migration or it's reading a stale response.

In all four cases, compare against Test 7 (canonical enrollment flow). If Test 7 is right and the failing surface is wrong, the surface is bypassing the authority.

---

## Live servers

- Backend: `http://localhost:3001` (PID running under `nohup node app.js`)
- Frontend: `http://localhost:5173` (Vite dev server, already running before merge)
- Branch state: merged master `48d87496` (Jeremy's payment refactor) into `feat/pricing-authority-phase-2` as `271a2b6d`. No conflicts.
