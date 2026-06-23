// calcTypeMetadata.ts
// Static metadata for calculation types: human-readable descriptions and grouped dropdown options.
// Used by the ProposalEditor to power the custom calculation-type dropdown with hover tooltips.

/** Plain-language description of what each calculation does and how it is calculated. */
export const CALC_TYPE_DESCRIPTIONS: Record<string, string> = {
  // ── Individual Proposal ──────────────────────────────────────────────
  total_monthly:
    'The total monthly premium cost for an individual member based on the selected product and their family size.',
  total_yearly:
    'The total yearly premium cost for an individual member, calculated as the monthly cost multiplied by 12.',
  tier_monthly:
    'The monthly premium price for a specific family size tier (EE, E1, or EF).',
  tier_yearly:
    'The yearly premium price for a specific family size tier, calculated as the tier monthly price multiplied by 12.',
  total_employee_count:
    'The total number of employees in the company.',
  percentage:
    'The percentage of MW enrollees in a given family size tier.',

  // ── Shared — Enrollment & Tier Mix (S1–S5) ──────────────────────────
  calcTotalMwEnrollees:
    'Adds up the three tier counts (EE + E1 + EF) to get the total number of employees expected to enroll in MightyWELL.',
  calcMwTierCountDisplay_EE:
    'Displays the MightyWELL enrollment count for the Employee Only (EE) tier. Passthrough of agent input.',
  calcMwTierCountDisplay_E1:
    'Displays the MightyWELL enrollment count for the Employee + One (E1) tier. Passthrough of agent input.',
  calcMwTierCountDisplay_EC:
    'Displays the MightyWELL enrollment count for the Employee + Children (EC) tier. Passthrough of agent input. Only used by 4-tier products.',
  calcMwTierCountDisplay_EF:
    'Displays the MightyWELL enrollment count for the Employee + Family (EF) tier. Passthrough of agent input.',
  calcTierMixPct_EE:
    'Percentage of MW enrollees in the Employee Only tier. Calculated as the EE count divided by total MW enrollees, shown as "XX.X%".',
  calcTierMixPct_E1:
    'Percentage of MW enrollees in the Employee + One tier. Calculated as the E1 count divided by total MW enrollees, shown as "XX.X%".',
  calcTierMixPct_EC:
    'Percentage of MW enrollees in the Employee + Children tier. Calculated as the EC count divided by total MW enrollees, shown as "XX.X%". Only used by 4-tier products.',
  calcTierMixPct_EF:
    'Percentage of MW enrollees in the Employee + Family tier. Calculated as the EF count divided by total MW enrollees, shown as "XX.X%".',
  calcMwEnrollmentPct:
    'What percent of the total workforce is expected to enroll in MightyWELL. Calculated as total MW enrollees divided by total employees, shown as "XX.X%".',
  calcCurrentEnrollmentPct:
    'The company\'s current participation rate on their existing health plan. Calculated as currently enrolled divided by total employees. Returns "0%" if no existing coverage.',
  calcNotEnrolledCount:
    'Employees with no coverage at all (Partial Switch). Calculated as total employees minus MW enrollees minus employees remaining on the current plan.',
  calcNotEnrolledCountGeneric:
    'Employees not enrolling in MightyWELL (Generic Quote). Calculated as total employees minus MW enrollees. Does not subtract remain-on-current count.',

  // ── Shared — MW Pricing (S6–S10) ────────────────────────────────────
  calcMwTierPrice_EE:
    'Monthly MightyWELL premium for Employee Only, fetched from the pricing engine using the product and OOP level at the Over 40 rate.',
  calcMwTierPrice_E1:
    'Monthly MightyWELL premium for Employee + One, fetched from the pricing engine using the product and OOP level at the Over 40 rate.',
  calcMwTierPrice_EC:
    'Monthly MightyWELL premium for Employee + Children, fetched from the pricing engine using the product and OOP level at the Over 40 rate. Only used by 4-tier products.',
  calcMwTierPrice_EF:
    'Monthly MightyWELL premium for Employee + Family, fetched from the pricing engine using the product and OOP level at the Over 40 rate.',
  calcMwTierCost_EE:
    'Total monthly plan cost for all Employee Only members. Calculated as the EE member count multiplied by the EE tier price.',
  calcMwTierCost_E1:
    'Total monthly plan cost for all Employee + One members. Calculated as the E1 member count multiplied by the E1 tier price.',
  calcMwTierCost_EC:
    'Total monthly plan cost for all Employee + Children members. Calculated as the EC member count multiplied by the EC tier price. Only used by 4-tier products.',
  calcMwTierCost_EF:
    'Total monthly plan cost for all Employee + Family members. Calculated as the EF member count multiplied by the EF tier price.',
  calcMwTotalMonthly:
    'Total monthly MightyWELL plan cost across all tiers (full premium, before employer/employee split). Sum of EE + E1 + EF tier costs.',
  calcMwTotalYearly:
    'Total yearly MightyWELL plan cost. Calculated as the total monthly cost multiplied by 12.',
  calcUnsharedAmountDisplay:
    'Displays the selected Out-of-Pocket / Unshared Amount level formatted for the PDF — either "$1,500" or "$3,000".',

  // ── Shared — Employer Contribution (S11–S15) ────────────────────────
  calcEmployerContrib_EE:
    'Monthly dollar amount the employer pays per Employee Only member. Uses the contribution type (flat or per-tier) and value type (dollar or percentage). Always capped at the tier price so the employee never goes negative.',
  calcEmployerContrib_E1:
    'Monthly dollar amount the employer pays per Employee + One member. Uses the contribution type (flat or per-tier) and value type (dollar or percentage). Always capped at the tier price.',
  calcEmployerContrib_EC:
    'Monthly dollar amount the employer pays per Employee + Children member. Uses the contribution type (flat or per-tier) and value type (dollar or percentage). Always capped at the tier price. Only used by 4-tier products.',
  calcEmployerContrib_EF:
    'Monthly dollar amount the employer pays per Employee + Family member. Uses the contribution type (flat or per-tier) and value type (dollar or percentage). Always capped at the tier price.',
  calcEmployeeCost_EE:
    'What each Employee Only member pays monthly after the employer contribution. Calculated as the EE tier price minus the employer contribution (minimum $0).',
  calcEmployeeCost_E1:
    'What each Employee + One member pays monthly after the employer contribution. Calculated as the E1 tier price minus the employer contribution (minimum $0).',
  calcEmployeeCost_EC:
    'What each Employee + Children member pays monthly after the employer contribution. Calculated as the EC tier price minus the employer contribution (minimum $0). Only used by 4-tier products.',
  calcEmployeeCost_EF:
    'What each Employee + Family member pays monthly after the employer contribution. Calculated as the EF tier price minus the employer contribution (minimum $0).',
  calcTotalEmployerMwMonthly:
    'The employer\'s total monthly spend on all MW members. Sum of (tier count × employer contribution per member) for each tier.',
  calcTotalEmployerMwYearly:
    'The employer\'s total yearly spend on MW members. Calculated as the total employer monthly cost multiplied by 12.',
  calcTotalEmployeeCostMonthly:
    'Combined monthly cost across all employees. Sum of (tier count × employee cost per member) for each tier.',

  // ── Shared — Current Plan & Net Change (S16–S22) ───────────────────
  calcCurrentPremiumYearly:
    'The employer\'s current yearly health plan spend. Calculated as the current monthly premium multiplied by 12.',
  calcNetCostChangeMonthly:
    'Monthly net change in employer cost. Proposed employer monthly minus current monthly premium. A negative value means the employer is saving money.',
  calcNetCostChangeYearly:
    'Yearly net change in employer cost. Calculated as the monthly net change multiplied by 12.',
  calcNetCostChangeMonthly_partial:
    'Monthly net change for partial switch using employer-paid amounts after contributions on both plans. Calculated as combined employer monthly (MW + remaining current) minus current total employer monthly.',
  calcNetCostChangeYearly_partial:
    'Yearly net change for partial switch using employer-paid amounts after contributions on both plans. Calculated as the partial monthly change multiplied by 12.',
  calcNetCostChangeMonthly_generic:
    'Monthly net change using MW-only employer cost compared to the current premium. Used when all employees switch or there is no prior coverage.',
  calcNetCostChangeYearly_generic:
    'Yearly net change using MW-only employer cost. Calculated as the generic monthly change multiplied by 12.',
  calcSavingsMonthly:
    'Monthly savings for the employer. Current premium minus proposed employer cost. A positive number means the employer is saving money. Returns $0 if no existing coverage.',
  calcSavingsYearly:
    'Yearly savings for the employer. Calculated as monthly savings multiplied by 12.',
  calcSavingsMonthly_partial:
    'Monthly employer savings for partial switch using employer-paid amounts after contributions on both plans. Calculated as current total employer monthly minus combined employer monthly. Positive means saving money.',
  calcSavingsYearly_partial:
    'Yearly employer savings for partial switch using employer-paid amounts after contributions on both plans. Calculated as partial monthly savings multiplied by 12.',
  calcSavingsMonthly_generic:
    'Monthly savings using MW-only employer cost. Used for full-switch or new-business scenarios.',
  calcSavingsYearly_generic:
    'Yearly savings using MW-only employer cost. Calculated as generic monthly savings multiplied by 12.',
  calcEmployerCostReductionPct_partial:
    'Percent change in employer-paid monthly cost for a partial switch, after contributions on both plans. Calculated as (combined employer monthly - current total employer monthly) / current total employer monthly × 100, shown as a signed percent. Negative values mean cost reduction.',
  calcEmployeeCostReductionPct_partial:
    'Percent change in average employee monthly cost for a partial switch. Calculated as (MW average employee monthly cost - current average employee monthly cost) / current average employee monthly cost × 100, shown as a signed percent. Negative values mean cost reduction.',
  calcNetEnrollmentChangeCount:
    'How many more (or fewer) employees are covered compared to the current plan. Displayed with a +/− prefix, e.g. "+4".',
  calcNetEnrollmentChangePct:
    'Change in enrollment percentage compared to the current plan. Displayed with a +/− prefix and % sign, e.g. "+25%".',

  // ── Shared — New Display Fields (S27–S30) ───────────────────────────
  calcTotalEmployeesDisplay:
    'Displays the total number of employees in the company. A pass-through of the totalEmployees input for use as a PDF calculation field.',
  calcCurrentPremiumMonthly:
    'The employer\'s current monthly health plan cost (the full premium charged, not per-employee). Formatted as a whole-dollar currency value.',
  calcNetChangePremiumMonthly:
    'Monthly net change comparing the full plan premiums (before any employer/employee split). Calculated as proposed MW total monthly minus current monthly premium. Negative means the new plan costs less overall.',
  calcNetChangePremiumYearly:
    'Yearly net change comparing full plan premiums (before employer/employee split). Calculated as the monthly net change multiplied by 12.',
  calcOverallSavingsYearly_partial_beforeContrib:
    'Overall yearly employer savings for a partial switch before contributions are applied. Calculated as current total yearly premium minus combined yearly premium (MW + remaining current plan).',
  calcCurrentRemainCountDisplay:
    'Displays the total number of employees remaining on the current plan (sum of per-tier remain counts). Auto-derived from EE + E1 + EF remain inputs.',
  calcCurrentRemainTierCountDisplay_EE:
    'Displays the number of Employee Only (EE) employees remaining on the current plan. Passthrough of agent input.',
  calcCurrentRemainTierCountDisplay_E1:
    'Displays the number of Employee + One (E1) employees remaining on the current plan. Passthrough of agent input.',
  calcCurrentRemainTierCountDisplay_EC:
    'Displays the number of Employee + Children (EC) employees remaining on the current plan. Passthrough of agent input. Only used by 4-tier products.',
  calcCurrentRemainTierCountDisplay_EF:
    'Displays the number of Employee + Family (EF) employees remaining on the current plan. Passthrough of agent input.',
  calcAvgCurrentPerEmployee:
    'Average monthly cost per employee on the current plan. Calculated as the total current monthly premium divided by the number of currently enrolled employees. Used by Employee Savings calculations.',

  // ── Shared — Display Steps & Dates (S23–S26) ───────────────────────
  calcStepTierAlloc_EE:
    'Display formula showing how the EE tier count was derived: "total enrollees × tier mix % = EE count". Used on the "How Estimates Were Calculated" PDF page.',
  calcStepTierAlloc_E1:
    'Display formula showing how the E1 tier count was derived: "total enrollees × tier mix % = E1 count". Used on the "How Estimates Were Calculated" PDF page.',
  calcStepTierAlloc_EC:
    'Display formula showing how the EC tier count was derived: "total enrollees × tier mix % = EC count". Used on the "How Estimates Were Calculated" PDF page. Only used by 4-tier products.',
  calcStepTierAlloc_EF:
    'Display formula showing how the EF tier count was derived: "total enrollees × tier mix % = EF count". Used on the "How Estimates Were Calculated" PDF page.',
  calcStepTierCost_EE:
    'Display formula showing the EE tier cost calculation: "EE count × $tier price = $tier cost". Used on the "How Estimates Were Calculated" PDF page.',
  calcStepTierCost_E1:
    'Display formula showing the E1 tier cost calculation: "E1 count × $tier price = $tier cost". Used on the "How Estimates Were Calculated" PDF page.',
  calcStepTierCost_EC:
    'Display formula showing the EC tier cost calculation: "EC count × $tier price = $tier cost". Used on the "How Estimates Were Calculated" PDF page. Only used by 4-tier products.',
  calcStepTierCost_EF:
    'Display formula showing the EF tier cost calculation: "EF count × $tier price = $tier cost". Used on the "How Estimates Were Calculated" PDF page.',
  calcStepTotalCost:
    'Display formula showing the total monthly cost: "Total: $X / month". Used on the "How Estimates Were Calculated" PDF page.',
  calcEmployerContribStrategyText:
    'A one-sentence description of the employer contribution strategy based on the agent inputs. Dynamically generated from contribution type, value, and per-tier settings. Example: "Employer covers 80% of EE premium, applied as $320 to E+1 and EF".',
  calcEnrollmentDatesDisplay:
    'Displays the enrollment date entered by the agent, formatted as M/D/YY for the PDF.',

  // ── Partial Switch Estimate (P3–P13) ────────────────────────────────
  calcCurrentRemainMonthly:
    'Monthly employer cost for employees staying on the current plan. Calculated as the average cost per employee multiplied by the number remaining on the current plan.',
  calcCurrentRemainYearly:
    'Yearly employer cost for employees staying on the current plan. Calculated as the monthly remain cost multiplied by 12.',
  calcTotalProjectedEnrolled:
    'Total employees with any coverage under the proposed model. Calculated as MW enrollees plus employees remaining on the current plan.',
  calcProjectedEnrollmentPct:
    'Projected participation rate under the proposed model. Calculated as total projected enrolled divided by total employees, shown as "XX.X%".',
  calcMixedEmployerMonthly:
    'The employer\'s combined monthly spend: MW employee costs plus costs for employees staying on the current plan.',
  calcMixedEmployerYearly:
    'The employer\'s combined yearly spend. Calculated as mixed monthly cost multiplied by 12.',
  calcCombinedPremiumMonthly:
    'Total combined monthly premium across both plans (full sticker price). Calculated as MW total monthly premium plus per-tier remain counts multiplied by current plan premiums.',
  calcCombinedPremiumYearly:
    'Total combined yearly premium across both plans. Calculated as combined premium monthly multiplied by 12.',
  calcCombinedEmployerMonthly:
    'What the employer actually pays monthly after contributions on BOTH plans. MW employer contributions plus current plan employer contributions for remaining employees, all computed per-tier.',
  calcCombinedEmployerYearly:
    'What the employer actually pays yearly after contributions on both plans. Calculated as combined employer monthly multiplied by 12.',
  // Backward-compat aliases
  calcBlendedEmployerMonthly:
    '(Renamed to Mixed) The employer\'s combined monthly spend: MW employee costs plus costs for employees staying on the current plan.',
  calcBlendedEmployerYearly:
    '(Renamed to Mixed) The employer\'s combined yearly spend. Calculated as mixed monthly cost multiplied by 12.',
  calcHeadlinePartialSwitch:
    'Cover-page headline for Partial Switch documents. Shows "Saving $X / Year" if there are savings, or "+$X / Year" if costs increase.',
  calcPartMixMwCount:
    'Participation breakdown — number of employees enrolling in MightyWELL. Same as total MW enrollees (S1). Displayed as "MightyWELL Plan: X Employees".',
  calcPartMixRemainCount:
    'Participation breakdown — number of employees staying on the current plan. Displayed as "Current Plan (Remain): X Employees".',
  calcPartMixNotEnrolled:
    'Participation breakdown — number of employees with no coverage at all. Displayed as "Not Enrolled: X Employees".',
  calcNetBusinessImpact:
    'Summary text showing the net enrollment change and participation change, e.g. "+4 employees" and "+25% participation".',

  // ── Generic Quote (G3, G8) ──────────────────────────────────────────
  calcHeadlineGenericQuote:
    'Cover-page headline for Generic Quote. If switching from existing coverage: shows net cost change per year (savings or increase). If new business with no prior coverage: shows total employer cost as "$X / Year" and "$X / Monthly".',
  calcStepEnrollment:
    'Display formula showing enrollment calculation: "total employees × enrollment % = MW enrollees". Used on the "How Estimates Were Calculated" PDF page.',

  // ── Employee Proposal (E1–E6) ───────────────────────────────────────
  calcEmployerContribDisplay_EE:
    'Formats the employer\'s EE tier contribution for employee-facing display, showing both the dollar amount and percentage: "$X (XX% of premium)".',
  calcEmployerContribDisplay_E1:
    'Formats the employer\'s E1 tier contribution for employee-facing display, showing both the dollar amount and percentage: "$X (XX% of premium)".',
  calcEmployerContribDisplay_EC:
    'Formats the employer\'s EC tier contribution for employee-facing display, showing both the dollar amount and percentage: "$X (XX% of premium)". Only used by 4-tier products.',
  calcEmployerContribDisplay_EF:
    'Formats the employer\'s EF tier contribution for employee-facing display, showing both the dollar amount and percentage: "$X (XX% of premium)".',
  calcEmployerSharePct_EE:
    'Percentage of the EE premium the employer covers. Displayed as "Your employer covers XX%."',
  calcEmployerSharePct_E1:
    'Percentage of the E1 premium the employer covers. Displayed as "Your employer covers XX%."',
  calcEmployerSharePct_EC:
    'Percentage of the EC premium the employer covers. Displayed as "Your employer covers XX%." Only used by 4-tier products.',
  calcEmployerSharePct_EF:
    'Percentage of the EF premium the employer covers. Displayed as "Your employer covers XX%."',
  calcEmployeeSharePct_EE:
    'Percentage of the EE premium the employee pays. Displayed as "You pay XX%."',
  calcEmployeeSharePct_E1:
    'Percentage of the E1 premium the employee pays. Displayed as "You pay XX%."',
  calcEmployeeSharePct_EC:
    'Percentage of the EC premium the employee pays. Displayed as "You pay XX%." Only used by 4-tier products.',
  calcEmployeeSharePct_EF:
    'Percentage of the EF premium the employee pays. Displayed as "You pay XX%."',
  calcEmployeeMonthlyCost_EE:
    'Employee\'s monthly out-of-pocket cost for the EE tier after the employer contribution. Formatted as "$XXX".',
  calcEmployeeMonthlyCost_E1:
    'Employee\'s monthly out-of-pocket cost for the E1 tier after the employer contribution. Formatted as "$XXX".',
  calcEmployeeMonthlyCost_EC:
    'Employee\'s monthly out-of-pocket cost for the EC tier after the employer contribution. Formatted as "$XXX". Only used by 4-tier products.',
  calcEmployeeMonthlyCost_EF:
    'Employee\'s monthly out-of-pocket cost for the EF tier after the employer contribution. Formatted as "$XXX".',
  calcEmployeeAnnualCost_EE:
    'Employee\'s total yearly out-of-pocket cost for the EE tier. Calculated as the monthly employee cost multiplied by 12.',
  calcEmployeeAnnualCost_E1:
    'Employee\'s total yearly out-of-pocket cost for the E1 tier. Calculated as the monthly employee cost multiplied by 12.',
  calcEmployeeAnnualCost_EC:
    'Employee\'s total yearly out-of-pocket cost for the EC tier. Calculated as the monthly employee cost multiplied by 12. Only used by 4-tier products.',
  calcEmployeeAnnualCost_EF:
    'Employee\'s total yearly out-of-pocket cost for the EF tier. Calculated as the monthly employee cost multiplied by 12.',
  calcEmployerAnnualContrib_EE:
    'What the employer contributes annually per EE employee. Calculated as the monthly employer contribution multiplied by 12.',
  calcEmployerAnnualContrib_E1:
    'What the employer contributes annually per E1 employee. Calculated as the monthly employer contribution multiplied by 12.',
  calcEmployerAnnualContrib_EC:
    'What the employer contributes annually per EC employee. Calculated as the monthly employer contribution multiplied by 12. Only used by 4-tier products.',
  calcEmployerAnnualContrib_EF:
    'What the employer contributes annually per EF employee. Calculated as the monthly employer contribution multiplied by 12.',

  // ── Employee Proposal — Savings by Switching (E7–E8) ───────────────
  calcEmployeeSavingsMonthly_EE:
    'How much the EE employee saves per month by switching to MightyWELL. Calculated as the average current per-employee cost (S32) minus the MW employee cost after employer contribution. Positive = saving money.',
  calcEmployeeSavingsMonthly_E1:
    'How much the E1 employee saves per month by switching to MightyWELL. Calculated as the average current per-employee cost (S32) minus the MW employee cost after employer contribution. Positive = saving money.',
  calcEmployeeSavingsMonthly_EC:
    'How much the EC employee saves per month by switching to MightyWELL. Calculated as the average current per-employee cost (S32) minus the MW employee cost after employer contribution. Positive = saving money. Only used by 4-tier products.',
  calcEmployeeSavingsMonthly_EF:
    'How much the EF employee saves per month by switching to MightyWELL. Calculated as the average current per-employee cost (S32) minus the MW employee cost after employer contribution. Positive = saving money.',
  calcEmployeeSavingsYearly_EE:
    'Annual savings for the EE employee by switching to MightyWELL. Calculated as the monthly savings multiplied by 12.',
  calcEmployeeSavingsYearly_E1:
    'Annual savings for the E1 employee by switching to MightyWELL. Calculated as the monthly savings multiplied by 12.',
  calcEmployeeSavingsYearly_EC:
    'Annual savings for the EC employee by switching to MightyWELL. Calculated as the monthly savings multiplied by 12. Only used by 4-tier products.',
  calcEmployeeSavingsYearly_EF:
    'Annual savings for the EF employee by switching to MightyWELL. Calculated as the monthly savings multiplied by 12.',

  // ── Additional Display Fields ────────────────────────────────────
  calcCurrentlyEnrolledDisplay:
    'Displays the number of employees currently enrolled on the existing health plan. Derived from the sum of per-tier current enrollment counts.',

  // ── Current Plan Detail Calculations ────────────────────────────
  calcCurrentTotalEnrolled:
    'Sum of current tier enrollment counts (EE + E1 + EF). Total employees currently on the existing health plan.',
  calcCurrentTierPriceDisplay_EE:
    'Displays the current plan monthly premium for the Employee Only (EE) tier. Passthrough of agent input.',
  calcCurrentTierPriceDisplay_E1:
    'Displays the current plan monthly premium for the Employee + One (E1) tier. Passthrough of agent input.',
  calcCurrentTierPriceDisplay_EC:
    'Displays the current plan monthly premium for the Employee + Children (EC) tier. Passthrough of agent input. Only used by 4-tier products.',
  calcCurrentTierPriceDisplay_EF:
    'Displays the current plan monthly premium for the Employee + Family (EF) tier. Passthrough of agent input.',
  calcCurrentTierCountDisplay_EE:
    'Displays the current enrollment count for the EE tier. Passthrough of agent input.',
  calcCurrentTierCountDisplay_E1:
    'Displays the current enrollment count for the E1 tier. Passthrough of agent input.',
  calcCurrentTierCountDisplay_EC:
    'Displays the current enrollment count for the EC tier. Passthrough of agent input. Only used by 4-tier products.',
  calcCurrentTierCountDisplay_EF:
    'Displays the current enrollment count for the EF tier. Passthrough of agent input.',
  calcCurrentTierCost_EE:
    'Monthly cost for the EE tier on the current plan. Calculated as current EE count × current EE premium.',
  calcCurrentTierCost_E1:
    'Monthly cost for the E1 tier on the current plan. Calculated as current E1 count × current E1 premium.',
  calcCurrentTierCost_EC:
    'Monthly cost for the EC tier on the current plan. Calculated as current EC count × current EC premium. Only used by 4-tier products.',
  calcCurrentTierCost_EF:
    'Monthly cost for the EF tier on the current plan. Calculated as current EF count × current EF premium.',
  calcCurrentTotalMonthly:
    'Total monthly cost of the current health plan across all tiers. Sum of all tier costs.',
  calcCurrentTotalYearly:
    'Total yearly cost of the current health plan. Current total monthly × 12.',
  calcCurrentNotEnrolledCount:
    'Number of employees not enrolled on the current plan. Calculated as total employees minus current total enrolled.',
  calcCurrentEmployerContrib_EE:
    'Employer contribution per member on the current plan for the EE tier. Based on current contribution type/value inputs.',
  calcCurrentEmployerContrib_E1:
    'Employer contribution per member on the current plan for the E1 tier. Based on current contribution type/value inputs.',
  calcCurrentEmployerContrib_EC:
    'Employer contribution per member on the current plan for the EC tier. Based on current contribution type/value inputs. Only used by 4-tier products.',
  calcCurrentEmployerContrib_EF:
    'Employer contribution per member on the current plan for the EF tier. Based on current contribution type/value inputs.',
  calcCurrentEmployeeCost_EE:
    'Employee out-of-pocket cost on the current plan for the EE tier. Current tier price minus current employer contribution.',
  calcCurrentEmployeeCost_E1:
    'Employee out-of-pocket cost on the current plan for the E1 tier. Current tier price minus current employer contribution.',
  calcCurrentEmployeeCost_EC:
    'Employee out-of-pocket cost on the current plan for the EC tier. Current tier price minus current employer contribution. Only used by 4-tier products.',
  calcCurrentEmployeeCost_EF:
    'Employee out-of-pocket cost on the current plan for the EF tier. Current tier price minus current employer contribution.',
  calcCurrentTotalEmployerMonthly:
    'Total employer monthly spend on the current plan. Sum of (count × employer contrib) across all tiers.',
  calcCurrentTotalEmployerYearly:
    'Total employer yearly spend on the current plan. Current total employer monthly × 12.',
  calcCurrentTotalEmployeeCostMonthly:
    'Total employee monthly out-of-pocket across all tiers on the current plan. Sum of (count × employee cost) per tier.',
  calcCurrentTierMixPct_EE:
    'Percentage of current plan enrollees in the EE tier. Current EE count / current total enrolled × 100.',
  calcCurrentTierMixPct_E1:
    'Percentage of current plan enrollees in the E1 tier. Current E1 count / current total enrolled × 100.',
  calcCurrentTierMixPct_EC:
    'Percentage of current plan enrollees in the EC tier. Current EC count / current total enrolled × 100. Only used by 4-tier products.',
  calcCurrentTierMixPct_EF:
    'Percentage of current plan enrollees in the EF tier. Current EF count / current total enrolled × 100.',
  calcCurrentRemainEnrollmentPct:
    'Percentage of total employees remaining on the current plan in a partial switch. currentRemainCount / totalEmployees × 100.',

  // ── MW Employee Aggregates ──────────────────────────────────────
  calcTotalEmployeeCostYearly:
    'Total yearly employee out-of-pocket cost across all MW tiers. Calculated as total employee cost monthly × 12.',
  calcAvgEmployeeCostMonthly:
    'Average monthly employee out-of-pocket cost for MW enrollees. Total employee cost monthly / total MW enrollees.',
  calcAvgEmployeeCostYearly:
    'Average yearly employee out-of-pocket cost for MW enrollees. Average monthly × 12.',

  // ── Net Employee Cost Change ────────────────────────────────────
  calcAvgCurrentEmployeeCostMonthly:
    'Average monthly out-of-pocket cost per employee on the current plan. Derived from per-tier current employee costs and enrollment counts.',
  calcAvgEmployeeCostChangeMonthly:
    'Change in average employee monthly cost when switching from current plan to MW. Current avg - MW avg. Positive = employees save money.',
  calcAvgEmployeeCostChangeYearly:
    'Change in average employee yearly cost when switching. Monthly change × 12.',

  // ── Dynamic Fields ────────────────────────────────────────────────
  dynamicPrice:
    'Displays a live price from the pricing engine for a specific product slot, tier, and configuration value (unshared amount). Configure the product slot, tier (EE/E1/EF), and config value via dropdowns.',

  combinedPrice:
    'Adds together the prices of two or more products (product slots) for the selected tier — e.g. HSA + Quest. The tier comes from the proposal form unless overridden; the unshared amount is chosen per product. Place one field per unshared-amount level.',
};

/** Grouped options for the calculation type dropdown — organized by functional category. */
export const CALC_TYPE_OPTION_GROUPS: Array<{ label: string; options: Array<{ value: string; label: string }> }> = [
  {
    label: 'Individual Member Pricing',
    options: [
      { value: 'total_monthly', label: '#1 Total Monthly Price' },
      { value: 'total_yearly', label: '#2 Total Yearly Price' },
      { value: 'tier_monthly', label: '#3 Family Size Monthly Price' },
      { value: 'tier_yearly', label: '#4 Family Size Yearly Price' },
      { value: 'total_employee_count', label: '#5 Total Employee Count' },
      { value: 'percentage', label: '#6 Family Size Percentage' },
    ],
  },
  {
    label: 'Enrollment & Participation',
    options: [
      { value: 'calcTotalMwEnrollees', label: '#7 Total MW Enrollees' },
      { value: 'calcTierMixPct_EE', label: '#8 MW Tier Mix % — EE' },
      { value: 'calcTierMixPct_E1', label: '#9 MW Tier Mix % — E1' },
      { value: 'calcTierMixPct_EC', label: '#147 MW Tier Mix % — EC' },
      { value: 'calcTierMixPct_EF', label: '#10 MW Tier Mix % — EF' },
      { value: 'calcMwEnrollmentPct', label: '#11 MW Enrollment %' },
      { value: 'calcCurrentEnrollmentPct', label: '#12 Current Enrollment %' },
      { value: 'calcCurrentTotalEnrolled', label: '#13 Current Total Enrolled' },
      { value: 'calcNotEnrolledCount', label: '#14 Not Enrolled Count (Partial Switch)' },
      { value: 'calcNotEnrolledCountGeneric', label: '#15 Not Enrolled Count (Generic)' },
      { value: 'calcCurrentNotEnrolledCount', label: '#16 Not Enrolled Count (Current)' },
      { value: 'calcTotalProjectedEnrolled', label: '#17 Total Projected Enrolled' },
      { value: 'calcProjectedEnrollmentPct', label: '#18 Projected Enrollment %' },
      { value: 'calcCurrentRemainEnrollmentPct', label: '#19 Remain on Current Plan %' },
      { value: 'calcNetEnrollmentChangeCount', label: '#20 Net Enrollment Change (Count)' },
      { value: 'calcNetEnrollmentChangePct', label: '#21 Net Enrollment Change (%)' },
      { value: 'calcPartMixMwCount', label: '#22 Participation — MW Count' },
      { value: 'calcPartMixRemainCount', label: '#23 Participation — Remain Count' },
      { value: 'calcPartMixNotEnrolled', label: '#24 Participation — Not Enrolled' },
      { value: 'calcNetBusinessImpact', label: '#25 Net Business Impact Text' },
      { value: 'calcTotalEmployeesDisplay', label: '#26 Total Employees (Display)' },
      { value: 'calcCurrentlyEnrolledDisplay', label: '#27 Currently Enrolled (Display)' },
      { value: 'calcCurrentRemainCountDisplay', label: '#28 Current Remain Count (Display)' },
      { value: 'calcMwTierCountDisplay_EE', label: '#29 MW Tier Count (Display) — EE' },
      { value: 'calcMwTierCountDisplay_E1', label: '#30 MW Tier Count (Display) — E1' },
      { value: 'calcMwTierCountDisplay_EC', label: '#148 MW Tier Count (Display) — EC' },
      { value: 'calcMwTierCountDisplay_EF', label: '#31 MW Tier Count (Display) — EF' },
      { value: 'calcCurrentRemainTierCountDisplay_EE', label: '#32 Remain on Current Tier Count — EE' },
      { value: 'calcCurrentRemainTierCountDisplay_E1', label: '#33 Remain on Current Tier Count — E1' },
      { value: 'calcCurrentRemainTierCountDisplay_EC', label: '#149 Remain on Current Tier Count — EC' },
      { value: 'calcCurrentRemainTierCountDisplay_EF', label: '#34 Remain on Current Tier Count — EF' },
    ],
  },
  {
    label: 'MW Plan Pricing',
    options: [
      { value: 'calcMwTierPrice_EE', label: '#35 MW Tier Price — EE' },
      { value: 'calcMwTierPrice_E1', label: '#36 MW Tier Price — E1' },
      { value: 'calcMwTierPrice_EC', label: '#150 MW Tier Price — EC' },
      { value: 'calcMwTierPrice_EF', label: '#37 MW Tier Price — EF' },
      { value: 'calcMwTierCost_EE', label: '#38 MW Tier Cost — EE' },
      { value: 'calcMwTierCost_E1', label: '#39 MW Tier Cost — E1' },
      { value: 'calcMwTierCost_EC', label: '#151 MW Tier Cost — EC' },
      { value: 'calcMwTierCost_EF', label: '#40 MW Tier Cost — EF' },
      { value: 'calcMwTotalMonthly', label: '#41 MW Total Monthly' },
      { value: 'calcMwTotalYearly', label: '#42 MW Total Yearly' },
      { value: 'calcUnsharedAmountDisplay', label: '#43 Unshared Amount (Display)' },
    ],
  },
  {
    label: 'Employer Cost (Proposed MW)',
    options: [
      { value: 'calcEmployerContrib_EE', label: '#44 Employer Contrib/Member — EE' },
      { value: 'calcEmployerContrib_E1', label: '#45 Employer Contrib/Member — E1' },
      { value: 'calcEmployerContrib_EC', label: '#152 Employer Contrib/Member — EC' },
      { value: 'calcEmployerContrib_EF', label: '#46 Employer Contrib/Member — EF' },
      { value: 'calcTotalEmployerMwMonthly', label: '#47 Total Employer MW Monthly' },
      { value: 'calcTotalEmployerMwYearly', label: '#48 Total Employer MW Yearly' },
      { value: 'calcMixedEmployerMonthly', label: '#49 Mixed Employer Monthly (MW + Remain)' },
      { value: 'calcMixedEmployerYearly', label: '#50 Mixed Employer Yearly (MW + Remain)' },
      { value: 'calcCurrentRemainMonthly', label: '#51 Current Remain Monthly Cost' },
      { value: 'calcCurrentRemainYearly', label: '#52 Current Remain Yearly Cost' },
      { value: 'calcCombinedPremiumMonthly', label: '#53 Combined Premium Monthly (MW + Current)' },
      { value: 'calcCombinedPremiumYearly', label: '#54 Combined Premium Yearly (MW + Current)' },
      { value: 'calcCombinedEmployerMonthly', label: '#55 Combined Employer Monthly (After Contribs)' },
      { value: 'calcCombinedEmployerYearly', label: '#56 Combined Employer Yearly (After Contribs)' },
    ],
  },
  {
    label: 'Employee Cost (Proposed MW)',
    options: [
      { value: 'calcEmployeeCost_EE', label: '#57 Employee Cost — EE' },
      { value: 'calcEmployeeCost_E1', label: '#58 Employee Cost — E1' },
      { value: 'calcEmployeeCost_EC', label: '#153 Employee Cost — EC' },
      { value: 'calcEmployeeCost_EF', label: '#59 Employee Cost — EF' },
      { value: 'calcTotalEmployeeCostMonthly', label: '#60 Total Employee Cost Monthly' },
      { value: 'calcTotalEmployeeCostYearly', label: '#61 Total Employee Cost Yearly' },
      { value: 'calcAvgEmployeeCostMonthly', label: '#62 Avg Employee Cost Monthly' },
      { value: 'calcAvgEmployeeCostYearly', label: '#63 Avg Employee Cost Yearly' },
      { value: 'calcEmployerContribDisplay_EE', label: '#64 Employer Contrib Display — EE' },
      { value: 'calcEmployerContribDisplay_E1', label: '#65 Employer Contrib Display — E1' },
      { value: 'calcEmployerContribDisplay_EC', label: '#154 Employer Contrib Display — EC' },
      { value: 'calcEmployerContribDisplay_EF', label: '#66 Employer Contrib Display — EF' },
      { value: 'calcEmployerSharePct_EE', label: '#67 Employer Share % — EE' },
      { value: 'calcEmployerSharePct_E1', label: '#68 Employer Share % — E1' },
      { value: 'calcEmployerSharePct_EC', label: '#155 Employer Share % — EC' },
      { value: 'calcEmployerSharePct_EF', label: '#69 Employer Share % — EF' },
      { value: 'calcEmployeeSharePct_EE', label: '#70 Employee Share % — EE' },
      { value: 'calcEmployeeSharePct_E1', label: '#71 Employee Share % — E1' },
      { value: 'calcEmployeeSharePct_EC', label: '#156 Employee Share % — EC' },
      { value: 'calcEmployeeSharePct_EF', label: '#72 Employee Share % — EF' },
      { value: 'calcEmployeeMonthlyCost_EE', label: '#73 Employee Monthly Cost — EE' },
      { value: 'calcEmployeeMonthlyCost_E1', label: '#74 Employee Monthly Cost — E1' },
      { value: 'calcEmployeeMonthlyCost_EC', label: '#157 Employee Monthly Cost — EC' },
      { value: 'calcEmployeeMonthlyCost_EF', label: '#75 Employee Monthly Cost — EF' },
      { value: 'calcEmployeeAnnualCost_EE', label: '#76 Employee Annual Cost — EE' },
      { value: 'calcEmployeeAnnualCost_E1', label: '#77 Employee Annual Cost — E1' },
      { value: 'calcEmployeeAnnualCost_EC', label: '#158 Employee Annual Cost — EC' },
      { value: 'calcEmployeeAnnualCost_EF', label: '#78 Employee Annual Cost — EF' },
      { value: 'calcEmployerAnnualContrib_EE', label: '#79 Employer Annual Contrib — EE' },
      { value: 'calcEmployerAnnualContrib_E1', label: '#80 Employer Annual Contrib — E1' },
      { value: 'calcEmployerAnnualContrib_EC', label: '#159 Employer Annual Contrib — EC' },
      { value: 'calcEmployerAnnualContrib_EF', label: '#81 Employer Annual Contrib — EF' },
    ],
  },
  {
    label: 'Current Plan Details',
    options: [
      { value: 'calcCurrentTierPriceDisplay_EE', label: '#82 Current Tier Price — EE' },
      { value: 'calcCurrentTierPriceDisplay_E1', label: '#83 Current Tier Price — E1' },
      { value: 'calcCurrentTierPriceDisplay_EC', label: '#160 Current Tier Price — EC' },
      { value: 'calcCurrentTierPriceDisplay_EF', label: '#84 Current Tier Price — EF' },
      { value: 'calcCurrentTierCountDisplay_EE', label: '#85 Current Tier Count — EE' },
      { value: 'calcCurrentTierCountDisplay_E1', label: '#86 Current Tier Count — E1' },
      { value: 'calcCurrentTierCountDisplay_EC', label: '#161 Current Tier Count — EC' },
      { value: 'calcCurrentTierCountDisplay_EF', label: '#87 Current Tier Count — EF' },
      { value: 'calcCurrentTierCost_EE', label: '#88 Current Tier Cost — EE' },
      { value: 'calcCurrentTierCost_E1', label: '#89 Current Tier Cost — E1' },
      { value: 'calcCurrentTierCost_EC', label: '#162 Current Tier Cost — EC' },
      { value: 'calcCurrentTierCost_EF', label: '#90 Current Tier Cost — EF' },
      { value: 'calcCurrentTierMixPct_EE', label: '#91 Current Tier Mix % — EE' },
      { value: 'calcCurrentTierMixPct_E1', label: '#92 Current Tier Mix % — E1' },
      { value: 'calcCurrentTierMixPct_EC', label: '#163 Current Tier Mix % — EC' },
      { value: 'calcCurrentTierMixPct_EF', label: '#93 Current Tier Mix % — EF' },
      { value: 'calcCurrentTotalMonthly', label: '#94 Current Total Monthly' },
      { value: 'calcCurrentTotalYearly', label: '#95 Current Total Yearly' },
      { value: 'calcCurrentPremiumMonthly', label: '#96 Current Premium Monthly (Display)' },
      { value: 'calcCurrentPremiumYearly', label: '#97 Current Premium Yearly (Display)' },
      { value: 'calcCurrentEmployerContrib_EE', label: '#98 Current Employer Contrib — EE' },
      { value: 'calcCurrentEmployerContrib_E1', label: '#99 Current Employer Contrib — E1' },
      { value: 'calcCurrentEmployerContrib_EC', label: '#164 Current Employer Contrib — EC' },
      { value: 'calcCurrentEmployerContrib_EF', label: '#100 Current Employer Contrib — EF' },
      { value: 'calcCurrentEmployeeCost_EE', label: '#101 Current Employee Cost — EE' },
      { value: 'calcCurrentEmployeeCost_E1', label: '#102 Current Employee Cost — E1' },
      { value: 'calcCurrentEmployeeCost_EC', label: '#165 Current Employee Cost — EC' },
      { value: 'calcCurrentEmployeeCost_EF', label: '#103 Current Employee Cost — EF' },
      { value: 'calcCurrentTotalEmployerMonthly', label: '#104 Current Total Employer Monthly' },
      { value: 'calcCurrentTotalEmployerYearly', label: '#105 Current Total Employer Yearly' },
      { value: 'calcCurrentTotalEmployeeCostMonthly', label: '#106 Current Total Employee Cost Monthly' },
      { value: 'calcAvgCurrentPerEmployee', label: '#107 Avg Current Per-Employee Cost' },
      { value: 'calcAvgCurrentEmployeeCostMonthly', label: '#108 Avg Current Employee Cost Monthly' },
    ],
  },
  {
    label: 'Cost Comparison & Savings',
    options: [
      { value: 'calcNetCostChangeMonthly', label: '#109 Net Employer Cost Change — Monthly' },
      { value: 'calcNetCostChangeYearly', label: '#110 Net Employer Cost Change — Yearly' },
      { value: 'calcNetCostChangeMonthly_partial', label: '#111 Net Employer Cost Change — Monthly (Partial, After Contribs)' },
      { value: 'calcNetCostChangeYearly_partial', label: '#112 Net Employer Cost Change — Yearly (Partial, After Contribs)' },
      { value: 'calcNetCostChangeMonthly_generic', label: '#113 Net Employer Cost Change — Monthly (Generic)' },
      { value: 'calcNetCostChangeYearly_generic', label: '#114 Net Employer Cost Change — Yearly (Generic)' },
      { value: 'calcSavingsMonthly', label: '#115 Employer Savings — Monthly' },
      { value: 'calcSavingsYearly', label: '#116 Employer Savings — Yearly' },
      { value: 'calcSavingsMonthly_partial', label: '#117 Employer Savings — Monthly (Partial, After Contribs)' },
      { value: 'calcSavingsYearly_partial', label: '#118 Employer Savings — Yearly (Partial, After Contribs)' },
      { value: 'calcSavingsMonthly_generic', label: '#119 Employer Savings — Monthly (Generic)' },
      { value: 'calcSavingsYearly_generic', label: '#120 Employer Savings — Yearly (Generic)' },
      { value: 'calcNetChangePremiumMonthly', label: '#121 Net Premium Change — Monthly (Before Split)' },
      { value: 'calcNetChangePremiumYearly', label: '#122 Net Premium Change — Yearly (Before Split)' },
      { value: 'calcOverallSavingsYearly_partial_beforeContrib', label: '#123 Overall Savings — Yearly (Partial, Before Contribs)' },
      { value: 'calcAvgEmployeeCostChangeMonthly', label: '#124 Avg Employee Cost Change — Monthly' },
      { value: 'calcAvgEmployeeCostChangeYearly', label: '#125 Avg Employee Cost Change — Yearly' },
      { value: 'calcHeadlinePartialSwitch', label: '#126 Headline — Partial Switch' },
      { value: 'calcHeadlineGenericQuote', label: '#127 Headline — Generic Quote' },
      { value: 'calcEmployeeSavingsMonthly_EE', label: '#128 Employee Savings Monthly — EE' },
      { value: 'calcEmployeeSavingsMonthly_E1', label: '#129 Employee Savings Monthly — E1' },
      { value: 'calcEmployeeSavingsMonthly_EC', label: '#166 Employee Savings Monthly — EC' },
      { value: 'calcEmployeeSavingsMonthly_EF', label: '#130 Employee Savings Monthly — EF' },
      { value: 'calcEmployeeSavingsYearly_EE', label: '#131 Employee Savings Yearly — EE' },
      { value: 'calcEmployeeSavingsYearly_E1', label: '#132 Employee Savings Yearly — E1' },
      { value: 'calcEmployeeSavingsYearly_EC', label: '#167 Employee Savings Yearly — EC' },
      { value: 'calcEmployeeSavingsYearly_EF', label: '#133 Employee Savings Yearly — EF' },
      { value: 'calcEmployerCostReductionPct_partial', label: '#134 Employer Cost Reduction % — Partial (After Contribs)' },
      { value: 'calcEmployeeCostReductionPct_partial', label: '#135 Employee Cost Reduction % — Partial' },
    ],
  },
  {
    label: 'Calculation Steps & Display',
    options: [
      { value: 'calcStepTierAlloc_EE', label: '#136 Calc Step — Tier Alloc EE' },
      { value: 'calcStepTierAlloc_E1', label: '#137 Calc Step — Tier Alloc E1' },
      { value: 'calcStepTierAlloc_EC', label: '#168 Calc Step — Tier Alloc EC' },
      { value: 'calcStepTierAlloc_EF', label: '#138 Calc Step — Tier Alloc EF' },
      { value: 'calcStepTierCost_EE', label: '#139 Calc Step — Tier Cost EE' },
      { value: 'calcStepTierCost_E1', label: '#140 Calc Step — Tier Cost E1' },
      { value: 'calcStepTierCost_EC', label: '#169 Calc Step — Tier Cost EC' },
      { value: 'calcStepTierCost_EF', label: '#141 Calc Step — Tier Cost EF' },
      { value: 'calcStepTotalCost', label: '#142 Calc Step — Total Cost' },
      { value: 'calcStepEnrollment', label: '#143 Calc Step — Enrollment' },
      { value: 'calcEnrollmentDatesDisplay', label: '#144 Enrollment Date (Display)' },
      { value: 'calcEmployerContribStrategyText', label: '#145 Employer Contribution Strategy (Text)' },
    ],
  },
  {
    label: 'Dynamic Fields',
    options: [
      { value: 'dynamicPrice', label: '#146 Dynamic Price' },
      { value: 'combinedPrice', label: '#171 Combined Price (Add Products)' },
    ],
  },
];

/** Flat value → label lookup built from the grouped options. */
export const CALC_TYPE_LABELS: Record<string, string> = {};
CALC_TYPE_OPTION_GROUPS.forEach(g =>
  g.options.forEach(o => {
    CALC_TYPE_LABELS[o.value] = o.label;
  }),
);

/**
 * Input section names used by the business proposal form.
 * Each section corresponds to a group of related inputs in the UI.
 */
export type InputSection =
  | 'company'            // companyName, companyAddress
  | 'workforce'          // totalEmployees
  | 'currentCoverage'    // hasExistingCoverage, tier counts, tier premiums, current employer contribution
  | 'tierCounts'         // mwCountEE, mwCountE1, mwCountEF
  | 'oopLevel'           // unsharedAmount / deductible selector
  | 'contribution'       // contributionType, contributionValueType, contributionValue(s)
  | 'currentRemainCount' // partial switch: employees staying on current plan (per-tier)
  | 'enrollmentDates';   // enrollmentDateOptions

/**
 * Maps each calculation type key to the input sections it depends on.
 * Used by the form to only show inputs that are actually needed by
 * the calculations present in the selected document(s).
 *
 * 'company', 'workforce', 'tierCounts', 'oopLevel' are considered base
 * inputs that are always shown when any business calc field is present.
 */
export const CALC_REQUIRED_INPUTS: Record<string, InputSection[]> = {
  // ── Shared — Enrollment & Tier Mix (S1–S5) ────────────────────────
  calcTotalMwEnrollees:       [],
  calcMwTierCountDisplay_EE:  ['tierCounts'],
  calcMwTierCountDisplay_E1:  ['tierCounts'],
  calcMwTierCountDisplay_EC:  ['tierCounts'],
  calcMwTierCountDisplay_EF:  ['tierCounts'],
  calcTierMixPct_EE:          [],
  calcTierMixPct_E1:          [],
  calcTierMixPct_EC:          [],
  calcTierMixPct_EF:          [],
  calcMwEnrollmentPct:        [],
  calcCurrentEnrollmentPct:   ['currentCoverage'],
  calcNotEnrolledCount:       ['currentCoverage'],
  calcNotEnrolledCountGeneric: [],

  // ── Shared — MW Pricing (S6–S10) ─────────────────────────────────
  calcMwTierPrice_EE:         [],
  calcMwTierPrice_E1:         [],
  calcMwTierPrice_EC:         [],
  calcMwTierPrice_EF:         [],
  calcMwTierCost_EE:          [],
  calcMwTierCost_E1:          [],
  calcMwTierCost_EC:          [],
  calcMwTierCost_EF:          [],
  calcMwTotalMonthly:         [],
  calcMwTotalYearly:          [],
  calcUnsharedAmountDisplay:  [],

  // ── Shared — Employer Contribution (S11–S15) ─────────────────────
  calcEmployerContrib_EE:       ['contribution'],
  calcEmployerContrib_E1:       ['contribution'],
  calcEmployerContrib_EC:       ['contribution'],
  calcEmployerContrib_EF:       ['contribution'],
  calcEmployeeCost_EE:          ['contribution'],
  calcEmployeeCost_E1:          ['contribution'],
  calcEmployeeCost_EC:          ['contribution'],
  calcEmployeeCost_EF:          ['contribution'],
  calcTotalEmployerMwMonthly:   ['contribution'],
  calcTotalEmployerMwYearly:    ['contribution'],
  calcTotalEmployeeCostMonthly: ['contribution'],

  // ── Shared — Current Plan & Net Change (S16–S22) ─────────────────
  calcCurrentPremiumYearly:           ['currentCoverage'],
  calcNetCostChangeMonthly:           ['currentCoverage', 'contribution'],
  calcNetCostChangeYearly:            ['currentCoverage', 'contribution'],
  calcNetCostChangeMonthly_partial:   ['currentCoverage', 'contribution', 'currentRemainCount'],
  calcNetCostChangeYearly_partial:    ['currentCoverage', 'contribution', 'currentRemainCount'],
  calcNetCostChangeMonthly_generic:   ['currentCoverage', 'contribution'],
  calcNetCostChangeYearly_generic:    ['currentCoverage', 'contribution'],
  calcSavingsMonthly:                 ['currentCoverage', 'contribution'],
  calcSavingsYearly:                  ['currentCoverage', 'contribution'],
  calcSavingsMonthly_partial:         ['currentCoverage', 'contribution', 'currentRemainCount'],
  calcSavingsYearly_partial:          ['currentCoverage', 'contribution', 'currentRemainCount'],
  calcSavingsMonthly_generic:         ['currentCoverage', 'contribution'],
  calcSavingsYearly_generic:          ['currentCoverage', 'contribution'],
  calcEmployerCostReductionPct_partial: ['currentCoverage', 'contribution', 'currentRemainCount'],
  calcEmployeeCostReductionPct_partial: ['currentCoverage', 'contribution'],
  calcNetEnrollmentChangeCount:       ['currentCoverage'],
  calcNetEnrollmentChangePct:         ['currentCoverage'],

  // ── Shared — Display Steps & Dates (S23–S26) ─────────────────────
  calcStepTierAlloc_EE:       [],
  calcStepTierAlloc_E1:       [],
  calcStepTierAlloc_EC:       [],
  calcStepTierAlloc_EF:       [],
  calcStepTierCost_EE:        [],
  calcStepTierCost_E1:        [],
  calcStepTierCost_EC:        [],
  calcStepTierCost_EF:        [],
  calcStepTotalCost:          [],
  calcEnrollmentDatesDisplay: ['enrollmentDates'],
  calcEmployerContribStrategyText: ['contribution'],

  // ── New Display Fields (S27–S32) ──────────────────────────────────
  calcTotalEmployeesDisplay:       [],
  calcCurrentPremiumMonthly:       ['currentCoverage'],
  calcNetChangePremiumMonthly:     ['currentCoverage'],
  calcNetChangePremiumYearly:      ['currentCoverage'],
  calcOverallSavingsYearly_partial_beforeContrib: ['currentCoverage', 'currentRemainCount'],
  calcCurrentRemainCountDisplay:              ['currentRemainCount'],
  calcCurrentRemainTierCountDisplay_EE:       ['currentRemainCount'],
  calcCurrentRemainTierCountDisplay_E1:       ['currentRemainCount'],
  calcCurrentRemainTierCountDisplay_EC:       ['currentRemainCount'],
  calcCurrentRemainTierCountDisplay_EF:       ['currentRemainCount'],
  calcAvgCurrentPerEmployee:                  ['currentCoverage'],
  calcCurrentlyEnrolledDisplay:               ['currentCoverage'],

  // ── Partial Switch Estimate (P3–P13) ─────────────────────────────
  calcCurrentRemainMonthly:     ['currentCoverage', 'currentRemainCount'],
  calcCurrentRemainYearly:      ['currentCoverage', 'currentRemainCount'],
  calcTotalProjectedEnrolled:   ['currentRemainCount'],
  calcProjectedEnrollmentPct:   ['currentRemainCount'],
  calcMixedEmployerMonthly:     ['currentCoverage', 'contribution', 'currentRemainCount'],
  calcMixedEmployerYearly:      ['currentCoverage', 'contribution', 'currentRemainCount'],
  calcCombinedPremiumMonthly:   ['currentCoverage', 'contribution', 'currentRemainCount'],
  calcCombinedPremiumYearly:    ['currentCoverage', 'contribution', 'currentRemainCount'],
  calcCombinedEmployerMonthly:  ['currentCoverage', 'contribution', 'currentRemainCount'],
  calcCombinedEmployerYearly:   ['currentCoverage', 'contribution', 'currentRemainCount'],
  calcBlendedEmployerMonthly:   ['currentCoverage', 'contribution', 'currentRemainCount'],
  calcBlendedEmployerYearly:    ['currentCoverage', 'contribution', 'currentRemainCount'],
  calcHeadlinePartialSwitch:    ['currentCoverage', 'contribution', 'currentRemainCount'],
  calcPartMixMwCount:           [],
  calcPartMixRemainCount:       ['currentRemainCount'],
  calcPartMixNotEnrolled:       ['currentRemainCount'],
  calcNetBusinessImpact:        ['currentCoverage'],

  // ── Generic Quote (G3, G8) ───────────────────────────────────────
  calcHeadlineGenericQuote:     ['currentCoverage', 'contribution'],
  calcStepEnrollment:           [],

  // ── Employee Proposal (E1–E6) ────────────────────────────────────
  calcEmployerContribDisplay_EE:  ['contribution'],
  calcEmployerContribDisplay_E1:  ['contribution'],
  calcEmployerContribDisplay_EC:  ['contribution'],
  calcEmployerContribDisplay_EF:  ['contribution'],
  calcEmployerSharePct_EE:        ['contribution'],
  calcEmployerSharePct_E1:        ['contribution'],
  calcEmployerSharePct_EC:        ['contribution'],
  calcEmployerSharePct_EF:        ['contribution'],
  calcEmployeeSharePct_EE:        ['contribution'],
  calcEmployeeSharePct_E1:        ['contribution'],
  calcEmployeeSharePct_EC:        ['contribution'],
  calcEmployeeSharePct_EF:        ['contribution'],
  calcEmployeeMonthlyCost_EE:     ['contribution'],
  calcEmployeeMonthlyCost_E1:     ['contribution'],
  calcEmployeeMonthlyCost_EC:     ['contribution'],
  calcEmployeeMonthlyCost_EF:     ['contribution'],
  calcEmployeeAnnualCost_EE:      ['contribution'],
  calcEmployeeAnnualCost_E1:      ['contribution'],
  calcEmployeeAnnualCost_EC:      ['contribution'],
  calcEmployeeAnnualCost_EF:      ['contribution'],
  calcEmployerAnnualContrib_EE:   ['contribution'],
  calcEmployerAnnualContrib_E1:   ['contribution'],
  calcEmployerAnnualContrib_EC:   ['contribution'],
  calcEmployerAnnualContrib_EF:   ['contribution'],

  // ── Employee Proposal — Savings by Switching (E7–E8) ──────────────
  calcEmployeeSavingsMonthly_EE:  ['contribution', 'currentCoverage'],
  calcEmployeeSavingsMonthly_E1:  ['contribution', 'currentCoverage'],
  calcEmployeeSavingsMonthly_EC:  ['contribution', 'currentCoverage'],
  calcEmployeeSavingsMonthly_EF:  ['contribution', 'currentCoverage'],
  calcEmployeeSavingsYearly_EE:   ['contribution', 'currentCoverage'],
  calcEmployeeSavingsYearly_E1:   ['contribution', 'currentCoverage'],
  calcEmployeeSavingsYearly_EC:   ['contribution', 'currentCoverage'],
  calcEmployeeSavingsYearly_EF:   ['contribution', 'currentCoverage'],

  // ── Current Plan Detail Calculations ──────────────────────────────
  calcCurrentTotalEnrolled:            ['currentCoverage'],
  calcCurrentTierPriceDisplay_EE:      ['currentCoverage'],
  calcCurrentTierPriceDisplay_E1:      ['currentCoverage'],
  calcCurrentTierPriceDisplay_EC:      ['currentCoverage'],
  calcCurrentTierPriceDisplay_EF:      ['currentCoverage'],
  calcCurrentTierCountDisplay_EE:      ['currentCoverage'],
  calcCurrentTierCountDisplay_E1:      ['currentCoverage'],
  calcCurrentTierCountDisplay_EC:      ['currentCoverage'],
  calcCurrentTierCountDisplay_EF:      ['currentCoverage'],
  calcCurrentTierCost_EE:              ['currentCoverage'],
  calcCurrentTierCost_E1:              ['currentCoverage'],
  calcCurrentTierCost_EC:              ['currentCoverage'],
  calcCurrentTierCost_EF:              ['currentCoverage'],
  calcCurrentTotalMonthly:             ['currentCoverage'],
  calcCurrentTotalYearly:              ['currentCoverage'],
  calcCurrentNotEnrolledCount:         ['currentCoverage'],
  calcCurrentEmployerContrib_EE:       ['currentCoverage'],
  calcCurrentEmployerContrib_E1:       ['currentCoverage'],
  calcCurrentEmployerContrib_EC:       ['currentCoverage'],
  calcCurrentEmployerContrib_EF:       ['currentCoverage'],
  calcCurrentEmployeeCost_EE:          ['currentCoverage'],
  calcCurrentEmployeeCost_E1:          ['currentCoverage'],
  calcCurrentEmployeeCost_EC:          ['currentCoverage'],
  calcCurrentEmployeeCost_EF:          ['currentCoverage'],
  calcCurrentTotalEmployerMonthly:     ['currentCoverage'],
  calcCurrentTotalEmployerYearly:      ['currentCoverage'],
  calcCurrentTotalEmployeeCostMonthly: ['currentCoverage'],
  calcCurrentTierMixPct_EE:            ['currentCoverage'],
  calcCurrentTierMixPct_E1:            ['currentCoverage'],
  calcCurrentTierMixPct_EC:            ['currentCoverage'],
  calcCurrentTierMixPct_EF:            ['currentCoverage'],
  calcCurrentRemainEnrollmentPct:      ['currentCoverage', 'currentRemainCount'],

  // ── MW Employee Aggregates ────────────────────────────────────────
  calcTotalEmployeeCostYearly:         ['contribution'],
  calcAvgEmployeeCostMonthly:          ['contribution'],
  calcAvgEmployeeCostYearly:           ['contribution'],

  // ── Net Employee Cost Change ──────────────────────────────────────
  calcAvgCurrentEmployeeCostMonthly:   ['currentCoverage'],
  calcAvgEmployeeCostChangeMonthly:    ['currentCoverage', 'contribution'],
  calcAvgEmployeeCostChangeYearly:     ['currentCoverage', 'contribution'],

  // ── Dynamic Fields ──────────────────────────────────────────────
  dynamicPrice:                        [],
  combinedPrice:                       [],
};

/**
 * Given a list of calculation field names from a document, returns
 * the set of input sections required to compute them.
 * Base sections (company, workforce, tierCounts, oopLevel) are always
 * included when there is at least one calc field.
 */
export function getRequiredInputSections(calcFieldNames: string[]): Set<InputSection> {
  const sections = new Set<InputSection>();

  if (calcFieldNames.length === 0) return sections;

  // Base inputs always required for any business proposal
  sections.add('company');
  sections.add('workforce');
  sections.add('tierCounts');
  sections.add('oopLevel');

  for (const fieldName of calcFieldNames) {
    const deps = CALC_REQUIRED_INPUTS[fieldName];
    if (deps) {
      for (const dep of deps) sections.add(dep);
    }
  }

  // currentRemainCount implies currentCoverage (can't have remain without existing plan)
  if (sections.has('currentRemainCount')) {
    sections.add('currentCoverage');
  }

  return sections;
}
