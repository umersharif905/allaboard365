# E2E Test Scenarios — Pricing Authority & Enrollment Fee Calculations

> **Audience:** Developer building the e2e test suite for the enrollment flow.
> **Scope:** Covers every real product/group/fee combination currently in the `allaboard-testing` database so tests exercise the new backend Pricing Authority fingerprint (`backend/services/pricing/pricingAuthority.service.js`) plus every fee policy the UI is expected to render.
> **Environment:** `allaboard-testing` (SQL Server `allboard-prod.database.windows.net`), frontend pointed at the corresponding API.

---

## 1. Feature under test (one-screen summary)

The enrollment wizard calls `POST /api/enrollment-links/:linkToken/contribution-preview` to get a priced quote. The response now includes:

```json
{
  "authority": {
    "products": [...],
    "totals": { "basePremiumTotal", "includedFeeTotal", "nonIncludedFeeTotal", "systemFees", "displayPremiumTotal", "monthlyContribution" },
    "display":  { "lineItems", "summary", "policies" },
    "pricingFingerprint": "<sha256 hex>"
  }
}
```

At submit (`complete-enrollment`) the wizard sends `pricingFingerprint` back. The backend recomputes pricing from the pristine engine output and rejects the request if the fingerprint drifts (HTTP 400, transaction rolled back, row written to `oe.SystemIntegrationErrors` with `ErrorType = 'PRICING_FINGERPRINT_MISMATCH'`).

Every test case below should assert:

1. `contribution-preview.authority.totals` match the expected math (below).
2. `complete-enrollment` succeeds when fingerprint is unchanged.
3. `complete-enrollment` returns `400` with `code = PRICING_FINGERPRINT_MISMATCH` if any line item, total, or payment method is tampered with before submit.
4. The persisted `oe.Enrollments.MonthlyPremium`, `ProcessingFeeAmount`, `IncludedProcessingFeeAmount`, `SystemFeeAmount`, `TotalMonthlyAmount` match `authority.totals`.

---

## 2. Test tenant

| Field | Value |
|---|---|
| Tenant | **MightyWELL Health** |
| `TenantId` | `1CD92AF7-B6F2-4E48-A8F3-EC6316158826` |
| `chargeFeeToMember` | `true` |
| ACH rate | `0.8%` (no flat, no per-transaction) |
| Credit Card rate | `3.0%` (no flat) |
| System fees (tenant level) | **disabled** (null) |
| Active processor | `openenroll` |

> All active testing-DB tenants currently have the same 0.8% ACH / 3% CC rates with `chargeFeeToMember = true`, so fee math is consistent across tenants. MightyWELL is used because it owns the richest product catalog (included-fee products, a zeroFeeForACH product, and bundles).

---

## 3. Product cheat-sheet (MightyWELL)

All rows below come from `oe.TenantProductSubscriptions` + `oe.Products` + `oe.ProductPricing` for `TenantId = 1CD92AF7-B6F2-4E48-A8F3-EC6316158826`, `SubscriptionStatus = 'Active'`.

### 3.1 Standalone / component products

| Product | ProductId | IncludeFee | RoundUp | ZeroFeeForACH | CustomSystemFee | Notes |
|---|---|---|---|---|---|---|
| **MightyWELL CoPay Basic** | `AA7B7E6C-6350-4148-92F2-1908B8AA445E` | **true** | true | false | enabled, `$0` | Included fee baked in at **Highest (Card)** rate |
| **MightyWELL CoPay Gold** | `6976233B-60F2-4D44-AE9E-A6885FAC1000` | **true** | true | false | enabled, `$0` | Included fee baked in at Card rate |
| **MightyWELL Copay Silver** | `467071D2-FF13-4637-A4A3-FCFF7E898D1E` | **true** | true | false | enabled, `$0` | Included fee baked in at Card rate |
| **MightyWELL Preventative HSA** | `C20D8FCF-0C23-40FA-917C-1EFE646D46BC` | **true** | true | false | enabled, `$0` | Included fee baked in at Card rate |
| **MightyWELL Vision** | `BA9B249F-22A3-4151-8717-E503BF9FA916` | **true** | true | false | disabled | Included fee + `$0.01` rounding edge case (low premium) |
| **Essential (ShareWELL)** | `F165AF93-8268-448D-9DD6-F02FB338EEAE` | false | false | **true** | disabled | Fee charged on CC, **zero** on ACH (never rounded) |
| **MightyWELL Dental** | `49FC601D-789D-4D93-A9E5-5D3546BB5DF9` | false | **false** | false | disabled | Non-included, **no rounding** (exact cents) |
| **MightyWELL Dental (arm)** | `8FF2BA96-E1B9-4691-AD9B-C746BC109F1D` | false | true | false | disabled | Non-included, rounded up to whole dollar |
| **Lyric** | `C311D191-A013-4908-B2FB-F8D02B3D034C` | false | true | false | disabled | $0 telemed — exercises $0 premium + $0 fee path |
| **Quest Select** | `306D87F6-83FD-40E1-9BC3-B0D8DE8AD533` | false | true | false | disabled | Other/addon |
| **Copay MEC (Individual)** | `261E5540-A9E5-4973-9D93-B068009C5AD5` | false | true | false | disabled | Non-included |
| **HSA MEC (Individual)** | `13130A78-FC66-4945-977E-B04ED425B4A2` | false | true | false | disabled | Non-included |

### 3.2 Bundles (MightyWELL)

Bundles are parent "container" products with `IncludedProcessingFee = false` on the parent row; the **component** products own their own fee policies. This is the hardest scenario and must be covered.

| Bundle | BundleId | Components (in order) | Fee mix |
|---|---|---|---|
| **MightyWELL CoPay - Basic** | `BEE69D08-A022-452E-9724-8BA78126BD13` | CoPay Basic → Essential (ShareWELL) → Lyric | included + zeroFeeForACH + non-included |
| **MightyWELL CoPay - Gold** | `C8A5BBB9-2FEC-406A-B96D-069F571F343A` | CoPay Gold → Essential (ShareWELL) → Lyric | included + zeroFeeForACH + non-included |
| **MightyWELL CoPay - Silver** | `29A99408-4643-41EE-9AA6-F33FBA82DDCE` | CoPay Silver → Essential (ShareWELL) → Lyric | included + zeroFeeForACH + non-included |
| **MightyWELL - Preventative HSA** | `D353F315-1184-48B9-9F53-81557CC78FFF` | Preventative HSA → Essential (ShareWELL) → Lyric | included + zeroFeeForACH + non-included |
| **MightyWELL CoPay (arm)** | `9ABA9433-6BD9-4C3C-A210-6AA56DBBC423` | Copay MEC (arm) → Essential (ShareWELL) → Lyric (Bundle) | all non-included + zeroFeeForACH |
| **MightyWELL CoPay (Individual)** | `8941BEE7-FAD0-4027-B234-D3331603E053` | Copay MEC (Ind) → Essential (ShareWELL) → Lyric (Bundle) | all non-included + zeroFeeForACH |
| **HSA Preventative (Individual)** | `5F045456-DE15-4583-AB01-0188DDD1C66D` | HSA MEC (Ind) → Essential (ShareWELL) → Lyric (Bundle) | all non-included + zeroFeeForACH |

### 3.3 Rate card (age 40, non-tobacco, base plan variant)

Premium amounts used in worked examples below. Real DB rows may have multiple `ProductPricing` variants per tier — tests should **pin to a single variant** by passing explicit `ConfigValue1…5` through the wizard so reruns stay stable.

| Product | EE | ES | EC | EF |
|---|---:|---:|---:|---:|
| MightyWELL CoPay Basic | 210 | 300 | 300 | 380 |
| MightyWELL CoPay Gold | 315 | 521 | 521 | 738 |
| MightyWELL Copay Silver | 273 | 353 | 353 | 431 |
| Essential (ShareWELL) (EE 18-64 NT, base variant) | 410 | 410 | 410 | 575 |
| MightyWELL Dental | 48 | 76 | 76 | 114 |
| MightyWELL Vision | 9.43 | 14.06 | 14.06 | 23.58 |
| Lyric | 0 | 0 | 0 | 0 |

> Tier codes: **EE** = employee only, **ES** = employee+spouse, **EC** = employee+children, **EF** = employee+family.

---

## 4. Fee math reference

The authority service applies fees in this exact order; tests must reproduce it:

```
step 1  basePremium         from ProductPricing (net/MSRP depending on product config)
step 2  includedFee         if IncludeProcessingFee=true → applied at HIGHEST rate (Card 3% here)
                            if RoundUpProcessingFee=true → ceiling to whole dollar
                            if ZeroFeeForACH=true AND the highest rate is ACH → fee = 0
step 3  displayPremium      = basePremium + includedFee   (what the UI shows as the plan price)
step 4  nonIncludedFee      for products where IncludeFee=false:
                              CC: pct=3% * basePremium  (rounded up to whole $ if RoundUp)
                              ACH: pct=0.8% * basePremium (zero if ZeroFeeForACH=true)
step 5  systemFees          only if CustomSystemFeeEnabled=true or tenant SystemFees.enabled=true
                              applied over basePremiumTotal (NOT over fees)
step 6  monthlyContribution = displayPremiumTotal + nonIncludedFeeTotal + systemFees
```

**Critical invariants to assert:**

- `includedFee` is always computed at the **Card** rate even when the member pays by ACH (this is the whole point of "included" — the product absorbs either payment method, so it always uses the worst case).
- `nonIncludedFee` is recomputed per the member's selected `paymentMethodType` (`ACH` | `Card`).
- Changing the payment method in the wizard **must change the fingerprint** and therefore trigger a re-preview.
- Bundle totals must equal the sum of component `basePremium + includedFee`; never apply included fee to the bundle parent row.

---

## 5. Group fixtures (contributions)

All groups below belong to MightyWELL and have `Status = 'Active'` with active `EnrollmentLinkTemplates`. Use these for contribution scenarios.

| Group | GroupId | Contribution rule | Type | Direction |
|---|---|---|---|---|
| **Killgore & Associates** | `A3290978-B163-42B3-98C2-FD43AD1212B2` | Kilgore 100% of employees | `percentage` 100% | Employer |
| **MightyWELL** | `27335A80-6CB1-441E-AFE9-AE6C8B73745C` | Master Rule (50% + $200 floor) | `percentage` 50% w/ $200 flat floor | Employer |
| **Neal's Heating & Cooling** | `4562F79C-3643-4C08-8032-A4B9E129A8DF` | Neal's Rule $250 flat | `flat_rate` $250 | Employer |
| **Premier Appearance Inc.** | `7613B706-5C7B-4E04-B5DE-32C9843AC593` | Employer Contribution 50% | `percentage` 50% | Employer |
| **Loiselle & Associates CPAs** | `A6519923-FEF6-4309-9A64-DB6BA47289C8` | Medical contribution $2166.67 | `flat_rate` $2166.67 | **MaxEmployee** |
| **Keith McDonald Plumbing** | `F1AB8755-599F-4552-A1F8-CE31972B0224` | Employee Rule 30% ($120.28), Executive Rule 65% ($260.61) | multi-rule `flat_rate` | Employer |
| **Cramerton Christian Academy** | `824603B6-A4E3-4238-8152-ECEF455E5945` | Tier Based Contribution | `tier_based` | **MaxEmployee** |
| **HPH Mechanical** | `26D305A2-954D-4033-973B-39FCCA6AFC47` | Employee Medical $158, Owner <40 $361.01, Owner ≥40 $401.01 | multi-rule `flat_rate` (age split) | Employer |
| **Hybrid Turf Care** | `BF0C789B-E068-421D-817A-FD1BD08E5316` | 50% | `percentage` 50% | Employer |
| **Vision Eye Group** | `339D1E83-D3C4-4441-940C-C5A41EA105F3` | Over40 / Under40 age rules + Physicians $350 | `age_based` + `flat_rate` MaxEmployee | mixed |
| **Powerlink Technologies** | `C8C5AD26-1B37-4364-9C32-7F088FA7B90A` | 50% Coverage of EE Equivalent CoPay | `percentage` 50% | Employer |

**Non-group scenarios:** use any active `Member`-type enrollment link (there are 250+ on MightyWELL). No group contribution is applied; member pays 100%.

---

## 6. Scenario matrix

Each row produces one e2e spec. Target matrix size: **~40 tests**. Spec naming suggestion: `enrollment-pricing-<section>.<case>.cy.ts`.

### A. Single-product, included fee, CC vs ACH

| # | Product | Tier | Payment | What's exercised |
|---|---|---|---|---|
| A1 | MightyWELL CoPay Basic | EE | **Card** | Included fee baked in at Card rate (3%), rounded up to whole $ |
| A2 | MightyWELL CoPay Basic | EE | **ACH** | Included fee **still computed at Card rate** (Highest policy), ACH member gets same displayPremium |
| A3 | MightyWELL CoPay Gold | EF | Card | Higher premium → bigger fee, family tier |
| A4 | MightyWELL Copay Silver | ES | ACH | Spouse tier, ACH path |
| A5 | MightyWELL Preventative HSA | EE | Card | HSA variant, CustomSystemFee=$0 must not add a line item |
| A6 | MightyWELL Vision | EE | Card | Low-$ premium ($9.43) → tests rounding edge (3% = $0.29, RoundUp → $1) |

**Worked example — A1 (CoPay Basic, EE, Card):**

```
basePremium        = 210.00
includedFee        = ceil(210 * 0.03) = ceil(6.30) = 7.00   (RoundUp=true, CustomSystemFee $0 so no system fee)
displayPremium     = 217.00
nonIncludedFee     = 0     (IncludeFee=true so all fee is included)
systemFees         = 0
monthlyContribution = 217.00
```

**Worked example — A2 (CoPay Basic, EE, ACH):** **identical to A1** — included fee is always Highest, so ACH members still pay $217.00.

**Worked example — A6 (Vision, EE, Card):**

```
basePremium = 9.43
includedFee = ceil(9.43 * 0.03) = ceil(0.2829) = 1.00   (RoundUp=true)
displayPremium = 10.43
monthlyContribution = 10.43
```

### B. Single-product, non-included fee, CC vs ACH

| # | Product | Tier | Payment | Notes |
|---|---|---|---|---|
| B1 | MightyWELL Dental | EE | Card | `RoundUpProcessingFee=false` — **exact cents**, no ceil |
| B2 | MightyWELL Dental | EE | ACH | Exact cents on ACH |
| B3 | MightyWELL Dental (arm) | EE | Card | Same premium, but `RoundUp=true` — fee ceils to $1 |
| B4 | Essential (ShareWELL) | EE | Card | Non-included + Card → fee shown as separate line |
| B5 | Essential (ShareWELL) | EE | **ACH** | `ZeroFeeForACH=true` → fee = $0.00 **even though basePremium > 0** |
| B6 | Lyric | EE | Card | Zero-premium product → fee = $0, displayPremium = $0, must not appear as a "free fee" line |

**Worked example — B1 (Dental, EE, Card, no roundup):**

```
basePremium = 48.00
nonIncludedFee = 48.00 * 0.03 = 1.44   (RoundUp=false → exact)
displayPremium = 48.00
monthlyContribution = 48.00 + 1.44 = 49.44
```

**Worked example — B3 (Dental arm, EE, Card, roundup):**

```
basePremium = 48.00  (assume same rate card)
nonIncludedFee = ceil(48.00 * 0.03) = ceil(1.44) = 2.00
monthlyContribution = 48.00 + 2.00 = 50.00
```

**Worked example — B5 (Essential, EE, ACH, zeroFeeForACH):**

```
basePremium = 410.00
nonIncludedFee = 0.00   (ZeroFeeForACH=true)
monthlyContribution = 410.00
```

### C. Bundles (mixed fee policies — highest value test class)

| # | Bundle | Tier | Payment | What's covered |
|---|---|---|---|---|
| C1 | MightyWELL CoPay - Basic | EE | Card | Included + ZeroFeeForACH + non-included all in one bundle |
| C2 | MightyWELL CoPay - Basic | EE | **ACH** | Same bundle on ACH — Essential fee drops to $0, CoPay included stays baked, Lyric fee = $0 |
| C3 | MightyWELL CoPay - Gold | EF | Card | Family tier on Gold bundle |
| C4 | MightyWELL CoPay - Silver | ES | ACH | Spouse tier on Silver bundle |
| C5 | MightyWELL - Preventative HSA | EE | Card | HSA bundle |
| C6 | MightyWELL CoPay (Individual) | EE | Card | All-non-included bundle (no baked fees) |
| C7 | HSA Preventative (Individual) | EF | ACH | All-non-included bundle on ACH |

**Worked example — C1 (CoPay - Basic bundle, EE, Card):**

Components (all @ EE, age 40 NT, base plan variant):

| Component | basePremium | IncludeFee | Math |
|---|---:|---|---|
| MightyWELL CoPay Basic | 210.00 | **yes** | includedFee = ceil(210 * 0.03) = **7.00** → display 217.00 |
| Essential (ShareWELL) | 410.00 | no | nonIncludedFee = 410 * 0.03 = **12.30** (no roundup on Essential) |
| Lyric | 0.00 | no | nonIncludedFee = 0.00 |

Totals:

```
basePremiumTotal    = 210 + 410 + 0 = 620.00
includedFeeTotal    = 7.00
nonIncludedFeeTotal = 12.30
systemFees          = 0
displayPremiumTotal = 217.00 + 410.00 + 0.00 = 627.00
monthlyContribution = 627.00 + 12.30 = 639.30
```

**Worked example — C2 (same bundle, EE, ACH):**

```
Essential non-included fee → 0 (ZeroFeeForACH)
CoPay Basic included fee  → still 7.00 (Highest=Card)
Lyric                     → 0

monthlyContribution = 627.00 + 0.00 = 627.00
```

> **Hard assertion for C1 vs C2:** `displayPremium` per component is identical across payment methods; only `nonIncludedFee` changes. `pricingFingerprint` **must differ** between C1 and C2 because `paymentMethodType` is part of the hash input.

### D. Group contribution scenarios

For every case below, the backend must compute:

```
employerContribution = min(contributionRule applied to basePremiumTotal, basePremiumTotal)
employeeCost         = monthlyContribution - employerContribution   (never negative)
```

Assert both `authority.totals.monthlyContribution` **and** the `employerContribution` / `employeeCost` fields returned by the preview endpoint.

| # | Group | Product | Tier | Payment | Expected behavior |
|---|---|---|---|---|---|
| D1 | **Killgore & Associates** (100% employer) | CoPay Basic bundle | EE | Card | Employer pays full premium; employee pays fees only |
| D2 | **Neal's Heating & Cooling** ($250 flat) | CoPay Gold bundle | EE | Card | Flat $250 off premium |
| D3 | **Neal's Heating & Cooling** ($250 flat) | Dental only | EE | Card | Contribution **capped** at basePremium = $48 (floor $0, not negative) |
| D4 | **Premier Appearance Inc.** (50%) | CoPay Silver bundle | EF | Card | Percentage split |
| D5 | **MightyWELL** (50% + $200 floor) | CoPay Basic bundle | EE | ACH | Floor rule: max(50%, $200) |
| D6 | **Loiselle & Associates CPAs** ($2166.67 MaxEmployee) | CoPay Gold | EF | Card | Direction = MaxEmployee means employee pays at most $2166.67 |
| D7 | **Keith McDonald Plumbing** (multi-rule 30%/65%) | CoPay Basic bundle | EE | Card | Member role = "Employee" → $120.28 rule; role = "Executive" → $260.61 rule |
| D8 | **HPH Mechanical** (age-split) | CoPay Silver bundle | EE | Card | Member DOB < 40 → $361.01 owner rule; DOB ≥ 40 → $401.01 |
| D9 | **Vision Eye Group** (age-based rules) | CoPay Gold bundle | EE | Card | `age_based` rule must pick correct bucket |
| D10 | **Cramerton Christian Academy** (tier-based) | CoPay Basic bundle | EE vs EF | Card | Same plan, two tiers → different contribution |
| D11 | Any Member-link (no group) | CoPay Basic bundle | EE | Card | No contribution — employee pays 100% of monthlyContribution |

**Worked example — D1 (Killgore, 100%, CoPay Basic bundle, EE, Card) continuing from C1:**

```
monthlyContribution  = 639.30
employerContribution = min(1.00 * 620.00, 620.00) = 620.00    (applied over premium total, not fees)
employeeCost         = 639.30 - 620.00 = 19.30                (the 7 included fee + 12.30 non-included)
```

**Worked example — D3 (Neal's, $250 flat, Dental only):**

```
basePremiumTotal     = 48.00
monthlyContribution  = 49.44
employerContribution = min(250.00, 48.00) = 48.00            (capped at premium)
employeeCost         = 49.44 - 48.00 = 1.44                  (fees only)
```

### E. Payment-method toggle / fingerprint drift

These are focused security tests. Use the wizard to the review step, then intercept and tamper.

| # | Setup | Tamper action | Expected |
|---|---|---|---|
| E1 | Any C1-style bundle on Card | Change preview response in-flight: bump `authority.totals.monthlyContribution` by $1 but keep fingerprint | `complete-enrollment` returns **400** `PRICING_FINGERPRINT_MISMATCH`; no rows written; DB row in `oe.SystemIntegrationErrors` |
| E2 | Same, on Card | Change `selectedProducts` to an unrelated product after preview, keep fingerprint | 400 mismatch |
| E3 | Bundle on Card → switch to ACH in wizard **without re-calling preview** | Submit with old fingerprint | 400 mismatch |
| E4 | Preview on Card, submit with `paymentMethodType: ACH` | Tamper payment method only | 400 mismatch |
| E5 | Legitimate preview → submit identical payload | No tampering | 200, enrollment created, `authority.totals` persisted |
| E6 | Replay the same exact request twice back-to-back | Idempotency | Second call handled per existing idempotency rules, pricing row unchanged |

### F. Persisted values / round-trip

After a successful enrollment (e.g. D1 succeeded), assert rows in SQL:

```sql
SELECT EnrollmentId, MonthlyPremium, IncludedProcessingFeeAmount, ProcessingFeeAmount,
       SystemFeeAmount, TotalMonthlyAmount, PaymentMethodType
FROM oe.Enrollments WHERE EnrollmentId = <from API response>;
```

Expected (for D1 / C1 Card path):

| Column | Value |
|---|---|
| `MonthlyPremium` | `620.00` (basePremiumTotal) |
| `IncludedProcessingFeeAmount` | `7.00` |
| `ProcessingFeeAmount` | `12.30` (non-included only) |
| `SystemFeeAmount` | `0.00` |
| `TotalMonthlyAmount` | `639.30` |
| `PaymentMethodType` | `Card` |

Repeat for one ACH bundle (C2) and one Essential-only ACH case (B5).

### G. Household / dependents (tier determination)

Same fee rules but exercise tier inference from household composition. The wizard sends `householdMembers`; the backend infers tier (EE/ES/EC/EF).

| # | Household | Expected tier | Product |
|---|---|---|---|
| G1 | Member only (age 40) | EE | CoPay Basic bundle |
| G2 | Member + spouse | ES | CoPay Basic bundle |
| G3 | Member + 1 child | EC | CoPay Basic bundle |
| G4 | Member + spouse + child | EF | CoPay Basic bundle |
| G5 | Member + 3 children | EC (still family-child) | CoPay Basic bundle |
| G6 | Under-age member (e.g. 17) | Should fail pricing lookup, wizard blocks submit | CoPay Basic |

---

## 7. Assertion library (shared across specs)

Helper suggestions (pseudocode):

```ts
function assertAuthorityTotals(preview, expected) {
  const a = preview.authority.totals;
  expect(a.basePremiumTotal).toBeCloseTo(expected.basePremiumTotal, 2);
  expect(a.includedFeeTotal).toBeCloseTo(expected.includedFeeTotal, 2);
  expect(a.nonIncludedFeeTotal).toBeCloseTo(expected.nonIncludedFeeTotal, 2);
  expect(a.systemFees).toBeCloseTo(expected.systemFees, 2);
  expect(a.displayPremiumTotal).toBeCloseTo(expected.displayPremiumTotal, 2);
  expect(a.monthlyContribution).toBeCloseTo(expected.monthlyContribution, 2);
  expect(preview.authority.pricingFingerprint).toMatch(/^[a-f0-9]{64}$/);
}

function assertFingerprintStableOnReload(linkToken, payload) {
  const first  = post('/contribution-preview', payload);
  const second = post('/contribution-preview', payload);
  expect(first.authority.pricingFingerprint).toBe(second.authority.pricingFingerprint);
}

function assertFingerprintChangesOn(field, payload) {
  const a = post('/contribution-preview', payload);
  const b = post('/contribution-preview', { ...payload, [field]: mutated });
  expect(a.authority.pricingFingerprint).not.toBe(b.authority.pricingFingerprint);
}
```

**Fingerprint drift coverage:** call `assertFingerprintChangesOn` for each of:
`paymentMethodType`, `selectedProducts`, `householdMembers[0].dateOfBirth` (tier shift), `selectedConfigs` (plan variant).

---

## 8. Getting active enrollment link tokens for each group

Use the templates (group-wide, reusable links):

```sql
SELECT elt.TemplateName, g.Name, elt.TemplateId
FROM oe.EnrollmentLinkTemplates elt
JOIN oe.Groups g ON g.GroupId = elt.GroupId
WHERE elt.TenantId = '1CD92AF7-B6F2-4E48-A8F3-EC6316158826'
  AND elt.IsActive = 1
  AND elt.TemplateType = 'Group';
```

Key template → group → contribution mapping for the matrix above:

| TemplateId | Group | Use for scenarios |
|---|---|---|
| `A68087FC-5D0B-4914-998E-55D06462AB47` | Killgore & Associates | D1 |
| `2BDCE720-06AE-437A-9F4D-1888B115C669` | Neal's Heating & Cooling | D2, D3 |
| `9C1BAF8D-F9B4-400E-B45F-C1ECDA62AFD3` | Premier Appearance Inc. | D4 |
| `01D71641-16EA-4A2E-9461-D18890B4A0F1` | MightyWELL (test group) | D5 |
| `A5ECF60A-F7A2-43F3-BC32-145CC9F6D45A` | Loiselle & Associates CPAs | D6 |
| `E4AA6434-7779-4983-8F52-6F8FA2519C1A` | Keith McDonald Plumbing | D7 |
| `BD318D30-2506-498E-8E8E-21E0CC02A74E` | HPH Mechanical | D8 |
| `478243BE-A89A-43F8-B07D-7BD8D68BF5A5` | Vision Eye Group | D9 |
| `BAACD058-00D9-4C36-A316-5DE85B0C5CF8` | Hybrid Turf Care | D4 alternate |

The wizard URL is:

```
https://<frontend>/enroll/g/<template-short-url>  OR  /enroll/<linkToken>
```

The actual per-use `linkToken` is issued from the template. Agent links live in `oe.EnrollmentLinkTemplates.LinkMetaData`.

---

## 9. Cleanup / test-data hygiene

- After each test, **delete the test enrollment** by `EnrollmentId` (use the admin cleanup endpoint or direct SQL: `DELETE FROM oe.Enrollments WHERE EnrollmentId = <id>`).
- Always create fresh test members per run — reusing the same SSN/email across runs collides with the dedup logic in `complete-enrollment`.
- Use SSN `999-00-XXXX` patterns (already reserved for test data per existing test helpers).
- Always set `householdMembers[0].dateOfBirth` to a deterministic value (e.g. `1985-06-15` = age 40 in 2026) so rate rows don't drift as time passes.

---

## 10. What "green" looks like

- All ~40 specs pass on `allaboard-testing`.
- Every bundle test in section C produces identical `displayPremiumTotal` across Card and ACH (included fee is Highest).
- Every B-series test produces lower `nonIncludedFeeTotal` on ACH than Card except B5 where it's `$0`.
- Every E-series tamper test returns HTTP 400 with `code = PRICING_FINGERPRINT_MISMATCH` and leaves `oe.Enrollments` untouched.
- Every D-series test produces `employerContribution + employeeCost = monthlyContribution` (within $0.01 tolerance).
- No test leaves a row in `oe.Enrollments` without a matching `oe.PricingCalculationLog` row.

---

## Appendix A — Fee rates quick-reference

```
Tenant MightyWELL (1CD92AF7-B6F2-4E48-A8F3-EC6316158826)
  Card:  percentageFee = 0.03   flatFee = 0.00
  ACH:   percentageFee = 0.008  flatFee = 0.00
  chargeFeeToMember = true
  SystemFees.enabled = false
```

## Appendix B — "Gotchas" found during Phase 1 refactor

1. `processingFeeCalculator.calc(x, 0.03)` with `$12.80` → `$0.39` not `$0.38` (it ceils at the cent level when RoundUp=true). Tests must use the backend's rounding, not `Math.round(x * 100) / 100`.
2. `includedFee` is computed per **component** even inside a bundle; summing before applying fee gives wrong totals for mixed bundles (C1–C5).
3. `CustomSystemFeeAmount = 0` with `CustomSystemFeeEnabled = true` means "override system fee to $0" — not "use tenant default". Tests that rely on tenant-level system fees being applied should **not** use the CoPay Basic/Gold/Silver products (they override to $0).
4. `Lyric` has `$0` net rate but `RoundUp = true`; ensure `ceil(0 * 0.03) = 0` (don't accidentally round to $1).
5. `Essential (ShareWELL)` has multiple `ProductPricing` rows per tier (different deductible variants). Pin to a specific `ConfigValue*` in the test payload.
