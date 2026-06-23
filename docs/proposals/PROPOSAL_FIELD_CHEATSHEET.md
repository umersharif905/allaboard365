# Business Proposal PDF Field Reference Cheat Sheet

**Branch:** `proposal-updates`
**Date:** 2026-03-26

---

## Field Types

| Type | How to configure | What it does |
|------|-----------------|--------------|
| **text** | Set `AutoFillType` | Auto-fills agent/client info at PDF generation |
| **calculation** | Set `FieldName` to a calc key (use # numbers below) | Runs a backend calculation and displays the result |
| **price** | Select Product + Config Value + Tier | Pulls live pricing from PricingEngine for that product/config/tier combo |
| **image** | Set `AutoFillType` to `AgentPhoto` | Embeds agent headshot |
| **custom** | Set `CustomFieldId` | Agent fills in value manually at send time |
| **link** | Set URL or enrollment link | Clickable hyperlink on PDF |
| **whitespace** | N/A | Blank rectangle to cover/mask areas |

---

## Text AutoFill Fields

| What It Displays | AutoFillType | Format |
|---|---|---|
| Agent full name | `AgentName` | "John Smith" |
| Agent phone | `AgentPhone` | "(804) 555-1234" |
| Agent email | `AgentEmail` | Text |
| Agent address | `AgentAddress` | Text (set addressFormat: full/streetOnly/multiline) |
| Agency name | `AgencyName` | Text |
| Company/prospect name | `ClientName` | Text |
| Company/prospect address | `ClientAddress` | Text (set addressFormat: full/streetOnly/multiline) |
| Today's date (readable) | `TodaysDate` | "November 5, 2025" |
| Today's date (numeric) | `TodaysDateNumeric` | "11/05/2025" |
| Tier description | `TierDescription` | "Individual", "Husband + Wife", etc. |
| Custom static text | `CustomText` | Value comes from FieldName |

## Image Fields

| What It Displays | AutoFillType |
|---|---|
| Agent photo/headshot | `AgentPhoto` |

---

## Price Fields (NEW: Per-Field Tier + Config Selection)

Price fields pull live pricing from the PricingEngine. When adding a price field in the PDF editor:

1. **Select Product** — which product to price (from product slots)
2. **Select Config Value** — only shows if the product has config options (e.g., $1500, $3000, $6000 unshared amounts). Hidden for products like dental/vision with no config values.
3. **Select Tier** — always shows when a product is selected:
   - **Use Document Tier** (default) — uses the global tier from the send modal
   - **Employee Only (EE)**
   - **Employee + One (E1)**
   - **Employee + Family (EF)**

This means you can place multiple price fields on one page showing different tier/config combos:
- ShareWELL, Tier EE, UA $3000
- ShareWELL, Tier E1, UA $3000
- ShareWELL, Tier EF, UA $6000
- Dental (slot 2), Tier EE (no config dropdown)
- Vision (slot 3), Tier EF (no config dropdown)

---

## Calculation Fields (#1–#145)

### Individual Member Pricing (#1–#6)

| # | Label | Key | Format |
|---|---|---|---|
| 1 | Total Monthly Price | `total_monthly` | Currency |
| 2 | Total Yearly Price | `total_yearly` | Currency |
| 3 | Family Size Monthly Price | `tier_monthly` | Currency |
| 4 | Family Size Yearly Price | `tier_yearly` | Currency |
| 5 | Total Employee Count | `total_employee_count` | Number |
| 6 | Family Size Percentage | `percentage` | Percentage |

### Enrollment & Participation (#7–#34)

| # | Label | Key | Format |
|---|---|---|---|
| 7 | Total MW Enrollees | `calcTotalMwEnrollees` | Number |
| 8 | MW Tier Mix % — EE | `calcTierMixPct_EE` | Percentage |
| 9 | MW Tier Mix % — E1 | `calcTierMixPct_E1` | Percentage |
| 10 | MW Tier Mix % — EF | `calcTierMixPct_EF` | Percentage |
| 11 | MW Enrollment % | `calcMwEnrollmentPct` | Percentage |
| 12 | Current Enrollment % | `calcCurrentEnrollmentPct` | Percentage |
| 13 | Current Total Enrolled | `calcCurrentTotalEnrolled` | Number |
| 14 | Not Enrolled Count (Partial Switch) | `calcNotEnrolledCount` | Number |
| 15 | Not Enrolled Count (Generic) | `calcNotEnrolledCountGeneric` | Number |
| 16 | Not Enrolled Count (Current) | `calcCurrentNotEnrolledCount` | Number |
| 17 | Total Projected Enrolled | `calcTotalProjectedEnrolled` | Number |
| 18 | Projected Enrollment % | `calcProjectedEnrollmentPct` | Percentage |
| 19 | Remain on Current Plan % | `calcCurrentRemainEnrollmentPct` | Percentage |
| 20 | Net Enrollment Change (Count) | `calcNetEnrollmentChangeCount` | Signed number |
| 21 | Net Enrollment Change (%) | `calcNetEnrollmentChangePct` | Signed percentage |
| 22 | Participation — MW Count | `calcPartMixMwCount` | Number |
| 23 | Participation — Remain Count | `calcPartMixRemainCount` | Number |
| 24 | Participation — Not Enrolled | `calcPartMixNotEnrolled` | Number |
| 25 | Net Business Impact Text | `calcNetBusinessImpact` | Text |
| 26 | Total Employees (Display) | `calcTotalEmployeesDisplay` | Number |
| 27 | Currently Enrolled (Display) | `calcCurrentlyEnrolledDisplay` | Number |
| 28 | Current Remain Count (Display) | `calcCurrentRemainCountDisplay` | Number |
| 29 | MW Tier Count (Display) — EE | `calcMwTierCountDisplay_EE` | Number |
| 30 | MW Tier Count (Display) — E1 | `calcMwTierCountDisplay_E1` | Number |
| 31 | MW Tier Count (Display) — EF | `calcMwTierCountDisplay_EF` | Number |
| 32 | Remain on Current Tier Count — EE | `calcCurrentRemainTierCountDisplay_EE` | Number |
| 33 | Remain on Current Tier Count — E1 | `calcCurrentRemainTierCountDisplay_E1` | Number |
| 34 | Remain on Current Tier Count — EF | `calcCurrentRemainTierCountDisplay_EF` | Number |

### MW Plan Pricing (#35–#43)

| # | Label | Key | Format |
|---|---|---|---|
| 35 | MW Tier Price — EE | `calcMwTierPrice_EE` | Currency |
| 36 | MW Tier Price — E1 | `calcMwTierPrice_E1` | Currency |
| 37 | MW Tier Price — EF | `calcMwTierPrice_EF` | Currency |
| 38 | MW Tier Cost — EE | `calcMwTierCost_EE` | Currency |
| 39 | MW Tier Cost — E1 | `calcMwTierCost_E1` | Currency |
| 40 | MW Tier Cost — EF | `calcMwTierCost_EF` | Currency |
| 41 | MW Total Monthly | `calcMwTotalMonthly` | Currency |
| 42 | MW Total Yearly | `calcMwTotalYearly` | Currency |
| 43 | Unshared Amount (Display) | `calcUnsharedAmountDisplay` | Text ("$3,000") |

### Employer Cost — Proposed MW (#44–#56)

| # | Label | Key | Format |
|---|---|---|---|
| 44 | Employer Contrib/Member — EE | `calcEmployerContrib_EE` | Currency |
| 45 | Employer Contrib/Member — E1 | `calcEmployerContrib_E1` | Currency |
| 46 | Employer Contrib/Member — EF | `calcEmployerContrib_EF` | Currency |
| 47 | Total Employer MW Monthly | `calcTotalEmployerMwMonthly` | Currency |
| 48 | Total Employer MW Yearly | `calcTotalEmployerMwYearly` | Currency |
| 49 | Mixed Employer Monthly (MW + Remain) | `calcMixedEmployerMonthly` | Currency |
| 50 | Mixed Employer Yearly (MW + Remain) | `calcMixedEmployerYearly` | Currency |
| 51 | Current Remain Monthly Cost | `calcCurrentRemainMonthly` | Currency |
| 52 | Current Remain Yearly Cost | `calcCurrentRemainYearly` | Currency |
| 53 | Combined Premium Monthly (MW + Current) | `calcCombinedPremiumMonthly` | Currency |
| 54 | Combined Premium Yearly (MW + Current) | `calcCombinedPremiumYearly` | Currency |
| 55 | Combined Employer Monthly (After Contribs) | `calcCombinedEmployerMonthly` | Currency |
| 56 | Combined Employer Yearly (After Contribs) | `calcCombinedEmployerYearly` | Currency |

### Employee Cost — Proposed MW (#57–#81)

| # | Label | Key | Format |
|---|---|---|---|
| 57 | Employee Cost — EE | `calcEmployeeCost_EE` | Currency |
| 58 | Employee Cost — E1 | `calcEmployeeCost_E1` | Currency |
| 59 | Employee Cost — EF | `calcEmployeeCost_EF` | Currency |
| 60 | Total Employee Cost Monthly | `calcTotalEmployeeCostMonthly` | Currency |
| 61 | Total Employee Cost Yearly | `calcTotalEmployeeCostYearly` | Currency |
| 62 | Avg Employee Cost Monthly | `calcAvgEmployeeCostMonthly` | Currency |
| 63 | Avg Employee Cost Yearly | `calcAvgEmployeeCostYearly` | Currency |
| 64 | Employer Contrib Display — EE | `calcEmployerContribDisplay_EE` | Text ("$400 (80% of premium)") |
| 65 | Employer Contrib Display — E1 | `calcEmployerContribDisplay_E1` | Text |
| 66 | Employer Contrib Display — EF | `calcEmployerContribDisplay_EF` | Text |
| 67 | Employer Share % — EE | `calcEmployerSharePct_EE` | Percentage |
| 68 | Employer Share % — E1 | `calcEmployerSharePct_E1` | Percentage |
| 69 | Employer Share % — EF | `calcEmployerSharePct_EF` | Percentage |
| 70 | Employee Share % — EE | `calcEmployeeSharePct_EE` | Percentage |
| 71 | Employee Share % — E1 | `calcEmployeeSharePct_E1` | Percentage |
| 72 | Employee Share % — EF | `calcEmployeeSharePct_EF` | Percentage |
| 73 | Employee Monthly Cost — EE | `calcEmployeeMonthlyCost_EE` | Currency |
| 74 | Employee Monthly Cost — E1 | `calcEmployeeMonthlyCost_E1` | Currency |
| 75 | Employee Monthly Cost — EF | `calcEmployeeMonthlyCost_EF` | Currency |
| 76 | Employee Annual Cost — EE | `calcEmployeeAnnualCost_EE` | Currency |
| 77 | Employee Annual Cost — E1 | `calcEmployeeAnnualCost_E1` | Currency |
| 78 | Employee Annual Cost — EF | `calcEmployeeAnnualCost_EF` | Currency |
| 79 | Employer Annual Contrib — EE | `calcEmployerAnnualContrib_EE` | Currency |
| 80 | Employer Annual Contrib — E1 | `calcEmployerAnnualContrib_E1` | Currency |
| 81 | Employer Annual Contrib — EF | `calcEmployerAnnualContrib_EF` | Currency |

### Current Plan Details (#82–#108)

| # | Label | Key | Format |
|---|---|---|---|
| 82 | Current Tier Price — EE | `calcCurrentTierPriceDisplay_EE` | Currency |
| 83 | Current Tier Price — E1 | `calcCurrentTierPriceDisplay_E1` | Currency |
| 84 | Current Tier Price — EF | `calcCurrentTierPriceDisplay_EF` | Currency |
| 85 | Current Tier Count — EE | `calcCurrentTierCountDisplay_EE` | Number |
| 86 | Current Tier Count — E1 | `calcCurrentTierCountDisplay_E1` | Number |
| 87 | Current Tier Count — EF | `calcCurrentTierCountDisplay_EF` | Number |
| 88 | Current Tier Cost — EE | `calcCurrentTierCost_EE` | Currency |
| 89 | Current Tier Cost — E1 | `calcCurrentTierCost_E1` | Currency |
| 90 | Current Tier Cost — EF | `calcCurrentTierCost_EF` | Currency |
| 91 | Current Tier Mix % — EE | `calcCurrentTierMixPct_EE` | Percentage |
| 92 | Current Tier Mix % — E1 | `calcCurrentTierMixPct_E1` | Percentage |
| 93 | Current Tier Mix % — EF | `calcCurrentTierMixPct_EF` | Percentage |
| 94 | Current Total Monthly | `calcCurrentTotalMonthly` | Currency |
| 95 | Current Total Yearly | `calcCurrentTotalYearly` | Currency |
| 96 | Current Premium Monthly (Display) | `calcCurrentPremiumMonthly` | Currency |
| 97 | Current Premium Yearly (Display) | `calcCurrentPremiumYearly` | Currency |
| 98 | Current Employer Contrib — EE | `calcCurrentEmployerContrib_EE` | Currency |
| 99 | Current Employer Contrib — E1 | `calcCurrentEmployerContrib_E1` | Currency |
| 100 | Current Employer Contrib — EF | `calcCurrentEmployerContrib_EF` | Currency |
| 101 | Current Employee Cost — EE | `calcCurrentEmployeeCost_EE` | Currency |
| 102 | Current Employee Cost — E1 | `calcCurrentEmployeeCost_E1` | Currency |
| 103 | Current Employee Cost — EF | `calcCurrentEmployeeCost_EF` | Currency |
| 104 | Current Total Employer Monthly | `calcCurrentTotalEmployerMonthly` | Currency |
| 105 | Current Total Employer Yearly | `calcCurrentTotalEmployerYearly` | Currency |
| 106 | Current Total Employee Cost Monthly | `calcCurrentTotalEmployeeCostMonthly` | Currency |
| 107 | Avg Current Per-Employee Cost | `calcAvgCurrentPerEmployee` | Currency |
| 108 | Avg Current Employee Cost Monthly | `calcAvgCurrentEmployeeCostMonthly` | Currency |

### Cost Comparison & Savings (#109–#135)

| # | Label | Key | Format |
|---|---|---|---|
| 109 | Net Employer Cost Change — Monthly | `calcNetCostChangeMonthly` | Currency (signed) |
| 110 | Net Employer Cost Change — Yearly | `calcNetCostChangeYearly` | Currency (signed) |
| 111 | Net Employer Cost Change — Monthly (Partial, After Contribs) | `calcNetCostChangeMonthly_partial` | Currency (signed) |
| 112 | Net Employer Cost Change — Yearly (Partial, After Contribs) | `calcNetCostChangeYearly_partial` | Currency (signed) |
| 113 | Net Employer Cost Change — Monthly (Generic) | `calcNetCostChangeMonthly_generic` | Currency (signed) |
| 114 | Net Employer Cost Change — Yearly (Generic) | `calcNetCostChangeYearly_generic` | Currency (signed) |
| 115 | Employer Savings — Monthly | `calcSavingsMonthly` | Currency (signed) |
| 116 | Employer Savings — Yearly | `calcSavingsYearly` | Currency (signed) |
| 117 | Employer Savings — Monthly (Partial, After Contribs) | `calcSavingsMonthly_partial` | Currency (signed) |
| 118 | Employer Savings — Yearly (Partial, After Contribs) | `calcSavingsYearly_partial` | Currency (signed) |
| 119 | Employer Savings — Monthly (Generic) | `calcSavingsMonthly_generic` | Currency (signed) |
| 120 | Employer Savings — Yearly (Generic) | `calcSavingsYearly_generic` | Currency (signed) |
| 121 | Net Premium Change — Monthly (Before Split) | `calcNetChangePremiumMonthly` | Currency (signed) |
| 122 | Net Premium Change — Yearly (Before Split) | `calcNetChangePremiumYearly` | Currency (signed) |
| 123 | Overall Savings — Yearly (Partial, Before Contribs) | `calcOverallSavingsYearly_partial_beforeContrib` | Currency |
| 124 | Avg Employee Cost Change — Monthly | `calcAvgEmployeeCostChangeMonthly` | Currency (signed) |
| 125 | Avg Employee Cost Change — Yearly | `calcAvgEmployeeCostChangeYearly` | Currency (signed) |
| 126 | Headline — Partial Switch | `calcHeadlinePartialSwitch` | Text ("Saving $X / Year") |
| 127 | Headline — Generic Quote | `calcHeadlineGenericQuote` | Text |
| 128 | Employee Savings Monthly — EE | `calcEmployeeSavingsMonthly_EE` | Currency (signed) |
| 129 | Employee Savings Monthly — E1 | `calcEmployeeSavingsMonthly_E1` | Currency (signed) |
| 130 | Employee Savings Monthly — EF | `calcEmployeeSavingsMonthly_EF` | Currency (signed) |
| 131 | Employee Savings Yearly — EE | `calcEmployeeSavingsYearly_EE` | Currency (signed) |
| 132 | Employee Savings Yearly — E1 | `calcEmployeeSavingsYearly_E1` | Currency (signed) |
| 133 | Employee Savings Yearly — EF | `calcEmployeeSavingsYearly_EF` | Currency (signed) |
| 134 | Employer Cost Reduction % — Partial (After Contribs) | `calcEmployerCostReductionPct_partial` | Signed percentage |
| 135 | Employee Cost Reduction % — Partial | `calcEmployeeCostReductionPct_partial` | Signed percentage |

### Calculation Steps & Display (#136–#145)

| # | Label | Key | Format |
|---|---|---|---|
| 136 | Calc Step — Tier Alloc EE | `calcStepTierAlloc_EE` | Text ("X x Y% = Z") |
| 137 | Calc Step — Tier Alloc E1 | `calcStepTierAlloc_E1` | Text |
| 138 | Calc Step — Tier Alloc EF | `calcStepTierAlloc_EF` | Text |
| 139 | Calc Step — Tier Cost EE | `calcStepTierCost_EE` | Text ("X x $Y = $Z") |
| 140 | Calc Step — Tier Cost E1 | `calcStepTierCost_E1` | Text |
| 141 | Calc Step — Tier Cost EF | `calcStepTierCost_EF` | Text |
| 142 | Calc Step — Total Cost | `calcStepTotalCost` | Text |
| 143 | Calc Step — Enrollment | `calcStepEnrollment` | Text |
| 144 | Enrollment Date (Display) | `calcEnrollmentDatesDisplay` | Text (MM/DD/YY) |
| **145** | **Employer Contribution Strategy (Text)** | **`calcEmployerContribStrategyText`** | **Text (NEW)** |

### Dynamic Fields (#146)

| # | Label | Key | Format |
|---|---|---|---|
| **146** | **Dynamic Price** | **`dynamicPrice`** | **Currency (NEW)** |

**#146 Dynamic Price** — When selected in the PDF editor, shows 3 additional dropdowns:
1. **Product Slot** — select which product (defaults to slot 1)
2. **Tier** — EE, E+1, or EF (always shown, required)
3. **Configuration Value** — unshared amount like $1500, $3000, $6000 (only shows if the product has config values; hidden for dental/vision)

Use this for product pricing tables where you need to show specific tier + config combos:
- Slot 1 (Co-Pay Gold), Tier EE, UA $3000 → shows that price
- Slot 1 (Co-Pay Gold), Tier E1, UA $6000 → shows that price
- Slot 2 (Dental), Tier EE → shows that price (no config dropdown)
- Slot 3 (Vision), Tier EF → shows that price (no config dropdown)

---

## #145 Employer Contribution Strategy — Output Examples

| Scenario | Output |
|---|---|
| All tiers same % | "Employer covers 80% of each tier's premium" |
| All tiers same $ | "Employer covers $400 per employee (all tiers)" |
| Per-tier different % | "Employer covers 80% for EE, 70% for E+1, and 60% for EF" |
| Per-tier different $ | "Employer covers $400 for EE, $350 for E+1, and $300 for EF" |
| Mixed % and $ | "Employer covers 80% for EE, $350 for E+1, and 60% for EF" |
| Apply EE % to others | "Employer covers 80% of EE premium, applied as $320 to E+1 and EF" |
| Apply EE $ to others | "Employer covers $400 per employee (all tiers)" |

---

## Multi-Product Slots

All calculation fields (#35–#81, #109–#135) support `_slot_N` suffixes for multi-product proposals. When a document has multiple product slots, the system auto-generates slot-specific variants (e.g., `calcMwTierPrice_EE_slot_2`).

Price fields use the product slot dropdown to select which product to price.

---

## Quick Reference: Common PDF Sections

### "Prepared for / Prepared by" footer
- Prepared for: `ClientName` (text AutoFill)
- Prepared by: `AgentName` (text AutoFill)
- Date: `TodaysDate` (text AutoFill) or `#144` (calculation)

### "Total Cost" section
- Before employer contributions (monthly): **#41**
- Before employer contributions (yearly): **#42**
- After employer contributions — employer pays (monthly): **#47**
- After employer contributions — employer pays (yearly): **#48**
- Employee cost (monthly): **#60**
- Employee cost (yearly): **#61**

### "Participation Mix" section
- Total employees: **#26**
- On new plan: **#22**
- Not enrolled: **#24**
- Remain on current: **#23**

### "Per-Tier Pricing" table
- EE price: **#35**, E1 price: **#36**, EF price: **#37**
- EE count: **#29**, E1 count: **#30**, EF count: **#31**
- EE employer contrib: **#44**, E1: **#45**, EF: **#46**
- EE employee cost: **#57**, E1: **#58**, EF: **#59**

### "Employer Contribution Strategy"
- Strategy text sentence: **#145**
- Per-tier display (with %): **#64**, **#65**, **#66**

### "Product Pricing Table" (multiple tiers + config values)
- Use **#146 Dynamic Price** calculation fields with product slot, tier, and config selection
- Example: Slot 1 (Co-Pay Gold), Tier EE, Config $3000 → **#146**
- Example: Slot 1 (Co-Pay Gold), Tier E1, Config $3000 → **#146**
- Example: Slot 1 (Co-Pay Gold), Tier EF, Config $6000 → **#146**
- Example: Slot 2 (Dental), Tier EE → **#146** (no config dropdown)
- Example: Slot 3 (Vision), Tier EF → **#146** (no config dropdown)
