# Proposal System — Cheatsheet

3 tiers: **EE** (Individual), **E1** (Employee+One), **EF** (Employee+Family). All priced at Over 40 rate. Product known from PDF template (Gold/Silver). Agent info & date auto-filled.

## Inputs

| Field | Description |
|-------|-------------|
| Company Name | Business name |
| Company Address | Street, city, state, zip |
| Total Employees | Total headcount |
| Has Existing Coverage | Y/N — does the business have a current health plan? |
| **Current Coverage (per-tier, shown when Has Existing Coverage = Y)** | |
| Current Count — EE/E1/EF | Current plan enrollment count per tier |
| Current Premium — EE/E1/EF | Current monthly premium per member per tier |
| Current Contribution — EE/E1/EF | Per-tier contribution value ($ amount or %) |
| Current Contribution Value Type — EE/E1/EF | Dollar or Percentage, set independently per tier |
| OOP Level | $1,500 or $3,000 unshared amount |
| MW Count — EE | Expected Employee Only enrollees |
| MW Count — E1 | Expected Employee+One enrollees |
| MW Count — EF | Expected Employee+Family enrollees |
| MW Contribution — EE/E1/EF | Per-tier contribution value ($ amount or %) |
| MW Contribution Value Type — EE/E1/EF | Dollar or Percentage, set independently per tier. "Apply EE to E1 & EF" toggle available. |
| Current Remain Count — EE/E1/EF | *(Partial Switch only)* Per-tier count of employees staying on old plan. Total derived from sum. |
| Enrollment Date | Single enrollment date |

## Calculations (~76 unique functions)

> All currency values rounded to whole dollars. All percentages rounded to whole numbers. No decimals anywhere.

| Name | Function | Description |
|------|----------|-------------|
| Total MW Enrollees | `calcTotalMwEnrollees` | EE + E1 + EF counts |
| Tier Mix Pct | `calcTierMixPct(tier)` | tierCount / totalEnrollees × 100 |
| MW Enrollment Pct | `calcMwEnrollmentPct` | totalMwEnrollees / totalEmployees × 100 |
| Current Enrollment Pct | `calcCurrentEnrollmentPct` | currentlyEnrolled / totalEmployees × 100 |
| Not Enrolled Count (Partial Switch) | `calcNotEnrolledCount` | totalEmployees − mwEnrollees − remainCount |
| Not Enrolled Count (Generic) | `calcNotEnrolledCountGeneric` | totalEmployees − mwEnrollees (no remain deduction) |
| MW Tier Price | `calcMwTierPrice(tier)` | Monthly rate per tier from pricing engine (Over 40) |
| MW Tier Cost | `calcMwTierCost(tier)` | tierCount × tierPrice |
| MW Total Monthly | `calcMwTotalMonthly` | Sum of all tier costs |
| MW Total Yearly | `calcMwTotalYearly` | monthly × 12 |
| Unshared Amount Display | `calcUnsharedAmountDisplay` | Format OOP as "$1,500" or "$3,000" |
| Employer Contrib/Member | `calcEmployerContrib(tier)` | $ employer pays per member. Each tier has its own $/% type. Capped at tier price. |
| Employee Cost/Tier | `calcEmployeeCost(tier)` | tierPrice − employerContrib. Min $0. |
| Total Employer MW Monthly | `calcTotalEmployerMwMonthly` | Sum of (tierCount × employerContrib) all tiers |
| Total Employer MW Yearly | `calcTotalEmployerMwYearly` | monthly × 12 |
| Total Employee Cost Monthly | `calcTotalEmployeeCostMonthly` | Sum of (tierCount × employeeCost) all tiers |
| Current Premium Yearly | `calcCurrentPremiumYearly` | currentMonthlyPremium × 12 |
| Net Cost Change Monthly | `calcNetCostChangeMonthly` | **After split**: employer's MW cost − currentPremium (what the employer actually pays after contributions). `_partial` and `_generic` suffixes available. For `_partial`, baseline is current employer-paid after contributions and proposed is combined employer-paid after contributions. |
| Net Cost Change Yearly | `calcNetCostChangeYearly` | Above × 12 |
| Savings Monthly | `calcSavingsMonthly` | Inverse of net cost change (positive = saving). `_partial` and `_generic` suffixes available. For `_partial`, this is current employer-paid after contributions minus combined employer-paid after contributions. |
| Savings Yearly | `calcSavingsYearly` | Above × 12 |
| Employer Cost Reduction % (Partial) | `calcEmployerCostReductionPct_partial` | Percent change in employer-paid monthly cost for partial switch (after contributions): (combinedEmployerMonthly − currentTotalEmployerMonthly) / currentTotalEmployerMonthly × 100. Negative means cost reduction. |
| Employee Cost Reduction % (Partial) | `calcEmployeeCostReductionPct_partial` | Percent change in average employee monthly cost for partial switch: (avgMwEmployeeCostMonthly − avgCurrentEmployeeCostMonthly) / avgCurrentEmployeeCostMonthly × 100. Negative means cost reduction. |
| Net Enrollment Change | `calcNetEnrollmentChangeCount` | projectedEnrolled − currentlyEnrolled |
| Net Enrollment Change Pct | `calcNetEnrollmentChangePct` | projectedPct − currentPct |
| Step: Tier Allocation | `calcStepTierAlloc(tier)` | Display: "X × Y% = Z" |
| Step: Tier Cost | `calcStepTierCost(tier)` | Display: "X × $Y = $Z" |
| Step: Total Cost | `calcStepTotalCost` | Display: "Total: $X / month" |
| Current Remain Monthly | `calcCurrentRemainMonthly` | Employer cost for employees staying on old plan (uses S32 avg) |
| Current Remain Yearly | `calcCurrentRemainYearly` | monthly × 12 |
| Total Projected Enrolled | `calcTotalProjectedEnrolled` | mwEnrollees + remainCount |
| Projected Enrollment Pct | `calcProjectedEnrollmentPct` | projectedEnrolled / totalEmployees × 100 |
| Mixed Employer Monthly | `calcMixedEmployerMonthly` | MW employer cost + remain cost (legacy avg-based) |
| Mixed Employer Yearly | `calcMixedEmployerYearly` | monthly × 12 |
| Combined Premium Monthly | `calcCombinedPremiumMonthly` | Full premium across both plans (MW + per-tier remain × current price) |
| Combined Premium Yearly | `calcCombinedPremiumYearly` | monthly × 12 |
| Combined Employer Monthly | `calcCombinedEmployerMonthly` | Employer cost after contributions on both plans, per-tier |
| Combined Employer Yearly | `calcCombinedEmployerYearly` | monthly × 12 |
| Headline (Partial Switch) | `calcHeadlinePartialSwitch` | "Saving $X / Year" or "+$X / Year" |
| Headline (Generic Quote) | `calcHeadlineGenericQuote` | Savings if switching, total cost if new business |
| Participation Mix MW | `calcPartMixMwCount` | MW enrollee count for display |
| Participation Mix Remain | `calcPartMixRemainCount` | Remain on old plan count for display |
| Participation Mix Not Enrolled | `calcPartMixNotEnrolled` | Not enrolled count for display |
| Net Business Impact | `calcNetBusinessImpact` | Summary text for enrollment change |
| Step: Enrollment | `calcStepEnrollment` | Display: "X × Y% = Z" |
| Employer Contrib Display | `calcEmployerContribDisplay(tier)` | "$X/mo (XX% of premium)" |
| Employer Share Pct | `calcEmployerSharePct(tier)` | employerContrib / tierPrice × 100 |
| Employee Share Pct | `calcEmployeeSharePct(tier)` | employeeCost / tierPrice × 100 |
| Employee Monthly Display | `calcEmployeeMonthlyCost(tier)` | Employee cost formatted "$XX/mo" |
| Employee Annual Cost | `calcEmployeeAnnualCost(tier)` | employeeCost × 12 |
| Employer Annual Contrib | `calcEmployerAnnualContrib(tier)` | employerContrib × 12 |
| Enrollment Date Display | `calcEnrollmentDatesDisplay` | Formats the single enrollment date for PDF display as MM/DD/YY |
| Total Employees Display | `calcTotalEmployeesDisplay` | Pass-through of totalEmployees for PDF use |
| Current Premium Monthly | `calcCurrentPremiumMonthly` | Employer's current full monthly cost, formatted |
| Net Change Premium Monthly | `calcNetChangePremiumMonthly` | **Before split**: full MW quoted premium − currentPremium (total plan sticker price, ignoring who pays what) |
| Net Change Premium Yearly | `calcNetChangePremiumYearly` | Above × 12 |
| Overall Savings Yearly (Partial, Before Contribs) | `calcOverallSavingsYearly_partial_beforeContrib` | For hybrid/partial modeling before contributions: current total yearly premium − combined yearly premium (MW + remaining on current). |
| Current Remain Count Display | `calcCurrentRemainCountDisplay` | Total remain count (sum of per-tier) for PDF use |
| MW Tier Count Display | `calcMwTierCountDisplay(tier)` | Pass-through of MW tier enrollment count per tier |
| Current Remain Tier Count Display | `calcCurrentRemainTierCountDisplay(tier)` | Pass-through of per-tier remain count for PDF use |
| Avg Current Per-Employee | `calcAvgCurrentPerEmployee` | currentPremium / currentlyEnrolled. Used by E7/E8 for savings comparison. |
| Employee Savings Monthly | `calcEmployeeSavingsMonthly(tier)` | avgCurrentPerEmployee (S32) − employeeCost[tier]. Positive = employee saves by switching. |
| Employee Savings Yearly | `calcEmployeeSavingsYearly(tier)` | Above × 12 |
| **Current Plan Detail Calculations** | | |
| Current Total Enrolled | `calcCurrentTotalEnrolled` | Sum of current tier counts (EE+E1+EF) |
| Current Tier Price Display | `calcCurrentTierPriceDisplay(tier)` | Passthrough of current per-member premium |
| Current Tier Count Display | `calcCurrentTierCountDisplay(tier)` | Passthrough of current tier enrollment count |
| Current Tier Cost | `calcCurrentTierCost(tier)` | currentCount × currentPremium per tier |
| Current Total Monthly | `calcCurrentTotalMonthly` | Sum of all current tier costs |
| Current Total Yearly | `calcCurrentTotalYearly` | Above × 12 |
| Current Not Enrolled | `calcCurrentNotEnrolledCount` | totalEmployees − currentTotalEnrolled |
| Current Employer Contrib | `calcCurrentEmployerContrib(tier)` | Employer contribution per member on current plan. Each tier has its own $/% type. |
| Current Employee Cost | `calcCurrentEmployeeCost(tier)` | currentPremium − currentEmployerContrib. Min $0. |
| Current Total Employer Monthly | `calcCurrentTotalEmployerMonthly` | Sum of (count × contrib) all tiers |
| Current Total Employer Yearly | `calcCurrentTotalEmployerYearly` | Above × 12 |
| Current Total Employee Cost Monthly | `calcCurrentTotalEmployeeCostMonthly` | Sum of (count × employeeCost) all tiers |
| Current Tier Mix Pct | `calcCurrentTierMixPct(tier)` | tierCount / totalEnrolled × 100 |
| Current Remain Enrollment Pct | `calcCurrentRemainEnrollmentPct` | remainCount / totalEmployees × 100 |
| **MW Employee Aggregates** | | |
| Total Employee Cost Yearly | `calcTotalEmployeeCostYearly` | totalEmployeeCostMonthly × 12 |
| Avg Employee Cost Monthly | `calcAvgEmployeeCostMonthly` | totalEmployeeCostMonthly / totalMwEnrollees |
| Avg Employee Cost Yearly | `calcAvgEmployeeCostYearly` | Above × 12 |
| **Net Employee Cost Change** | | |
| Avg Current Employee Cost Monthly | `calcAvgCurrentEmployeeCostMonthly` | currentTotalEmployeeCostMonthly / currentTotalEnrolled |
| Avg Employee Cost Change Monthly | `calcAvgEmployeeCostChangeMonthly` | avgCurrent − avgMW. Positive = employees save. |
| Avg Employee Cost Change Yearly | `calcAvgEmployeeCostChangeYearly` | Above × 12 |
