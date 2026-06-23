/**
 * PROPOSAL CALCULATION SERVICE
 *
 * All 46 unique calculation functions for the three business proposal documents:
 *   - Partial Switch Estimate
 *   - Generic Quote
 *   - Employee Proposal
 *
 * Tier model: EE (Employee Only), E1 (Employee+One/Spouse), EC (Employee+Children, optional), EF (Employee+Family).
 * Most products use 3 tiers (EE/E1/EF). 4-tier products (e.g. MightyWELL Health Concierge) add EC.
 * For 3-tier products, EC values default to 0 throughout — calculations remain correct.
 *
 * Pricing baseline: Over 40 rate (age 40). No age-band splits.
 *
 * Each function is standalone and exported individually.
 * The master orchestrator (computeAllCalculations) wires them together.
 */

const PricingEngine = require('./pricing/PricingEngine');
const BundleProcessor = require('./pricing/BundleProcessor');
const pricingAuthority = require('./pricing/pricingAuthority.service');
const { getPool } = require('../config/database');
const sql = require('mssql');

const TIERS = ['EE', 'E1', 'EC', 'EF'];

/**
 * Maps display tier names to database TierType values.
 * The DB stores EE, ES, EC, EF. The frontend uses EE, E1, EC, EF.
 * E1 (Employee+One) maps to ES (Employee+Spouse) in the DB — same pricing.
 */
const TIER_TO_DB = { EE: 'EE', E1: 'ES', EC: 'EC', EF: 'EF' };

// ============================================================================
// FORMATTING HELPERS
// ============================================================================

function formatCurrency(amount) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(amount);
}

function formatPct(value) {
  return `${Math.round(value)}%`;
}

// Yearly displays should equal (rounded monthly) × 12 so that readers who
// multiply the PDF's monthly value by 12 get the PDF's yearly value. Without
// this, raw monthly × 12 can drift from the rounded-monthly display (e.g. raw
// $3,052.50 shows as $3,053/mo but yearly shows $36,630 instead of $36,636).
// Up to a ~$6/yr accuracy loss vs raw math, traded for internal PDF consistency.
function yearlyFromMonthly(monthly) {
  return Math.round(monthly || 0) * 12;
}

function formatSignedCount(value) {
  return `${value >= 0 ? '+' : ''}${value}`;
}

function formatSignedPct(value) {
  return `${value >= 0 ? '+' : ''}${Math.round(value)}%`;
}

// ============================================================================
// S1–S26: SHARED CALCULATIONS
// ============================================================================

/** S1 — Total MW Enrollees (EC defaults to 0 for legacy 3-tier callers) */
function calcTotalMwEnrollees(mwCountEE, mwCountE1, mwCountEF, mwCountEC = 0) {
  return mwCountEE + mwCountE1 + mwCountEF + mwCountEC;
}

/** S1b — MW Tier Count Display (per tier) */
function calcMwTierCountDisplay(count) {
  return count;
}

/** S1c — Current Remain Tier Count Display (per tier) */
function calcCurrentRemainTierCountDisplay(count) {
  return count;
}

/** S2 — Tier Mix Percentage (per tier) */
function calcTierMixPct(tierCount, totalMwEnrollees) {
  if (totalMwEnrollees === 0) return 0;
  return (tierCount / totalMwEnrollees) * 100;
}

/** S3 — MW Enrollment Percentage */
function calcMwEnrollmentPct(totalMwEnrollees, totalEmployees) {
  if (totalEmployees === 0) return 0;
  return (totalMwEnrollees / totalEmployees) * 100;
}

/** S4 — Current Enrollment Percentage */
function calcCurrentEnrollmentPct(currentlyEnrolled, totalEmployees) {
  if (totalEmployees === 0) return 0;
  return (currentlyEnrolled / totalEmployees) * 100;
}

/** S5 — Not Enrolled Count (subtracts remain on current — use for Partial Switch) */
function calcNotEnrolledCount(totalEmployees, totalMwEnrollees, currentRemainCount) {
  return totalEmployees - totalMwEnrollees - (currentRemainCount || 0);
}

/** Not Enrolled Count Generic (totalEmployees - mwEnrollees only — use for Generic Quote) */
function calcNotEnrolledCountGeneric(totalEmployees, totalMwEnrollees) {
  return totalEmployees - totalMwEnrollees;
}

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

/**
 * Load fee context for a tenant + set of product IDs.
 * Matches the quick-quote endpoint's fee loading logic.
 */
async function loadProposalFeeContext(tenantId, productIds) {
  if (!tenantId || !productIds || !productIds.length) return null;
  const pool = await getPool();

  const tenantReq = pool.request();
  tenantReq.input('tenantId', sql.UniqueIdentifier, tenantId);
  const tenantRes = await tenantReq.query(`
    SELECT TOP 1 PaymentProcessorSettings, SystemFees
    FROM oe.Tenants WHERE TenantId = @tenantId
  `);
  const parseJson = (v) => {
    if (!v) return null;
    try { return typeof v === 'string' ? JSON.parse(v) : v; } catch (_) { return null; }
  };
  const tenantRow = tenantRes.recordset?.[0];
  const paymentProcessorSettings = tenantRow ? parseJson(tenantRow.PaymentProcessorSettings) : null;
  const systemFeesSettings = tenantRow ? parseJson(tenantRow.SystemFees) : null;
  const chargeFeeToMember = paymentProcessorSettings?.chargeFeeToMember === true;

  const uniqueIds = Array.from(new Set(productIds.map((id) => String(id).trim()).filter(Boolean)));
  const subReq = pool.request();
  subReq.input('tenantId', sql.UniqueIdentifier, tenantId);
  uniqueIds.forEach((id, idx) => subReq.input(`fpid_${idx}`, sql.UniqueIdentifier, id));
  const inList = uniqueIds.map((_, idx) => `@fpid_${idx}`).join(', ');
  const subRes = await subReq.query(`
    SELECT ProductId, IncludeProcessingFee, RoundUpProcessingFee, ZeroFeeForACH, CustomSystemFeeEnabled, CustomSystemFeeAmount
    FROM oe.TenantProductSubscriptions
    WHERE TenantId = @tenantId AND ProductId IN (${inList})
      AND SubscriptionStatus IN ('Active', 'Approved')
  `);

  const toBool = (v) => {
    if (v === true || v === 1) return true;
    const s = String(v ?? '').trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes' || s === 'y';
  };
  const feesByProductId = {};
  (subRes.recordset || []).forEach((row) => {
    feesByProductId[String(row.ProductId).toLowerCase()] = {
      includeProcessingFee: toBool(row.IncludeProcessingFee),
      roundUpProcessingFee: (() => {
        const v = row.RoundUpProcessingFee;
        if (v === true || v === 1) return true;
        if (v === false || v === 0) return false;
        const s = String(v ?? '').trim().toLowerCase();
        if (['true', '1', 'yes', 'y'].includes(s)) return true;
        if (['false', '0', 'no', 'n'].includes(s)) return false;
        return true;
      })(),
      zeroFeeForACH: toBool(row.ZeroFeeForACH),
      customSystemFeeEnabled: toBool(row.CustomSystemFeeEnabled),
      customSystemFeeAmount: row.CustomSystemFeeAmount != null ? Number(row.CustomSystemFeeAmount) : null
    };
  });

  return { tenantId, chargeFeeToMember, paymentProcessorSettings, systemFeesSettings, feesByProductId };
}

/**
 * Apply processing fees + system fees to underlying product premiums via pricingAuthority.
 * Single source of truth for fee math. Callers must await.
 */
async function applyQuoteFeesToParts(parts, feeCtx, paymentMethod) {
  if (!Array.isArray(parts) || parts.length === 0) {
    return { basePremium: 0, processingFee: 0, systemFees: 0, totalPremium: 0, authority: null };
  }

  const pricingProducts = parts.map((p) => ({
    productId: String(p.productId),
    productName: p.productName || '',
    monthlyPremium: Number(p.basePremium || 0),
    isBundle: false,
    ...(p.pricingDetails ? { pricingDetails: p.pricingDetails } : {})
  }));

  const pool = await getPool();
  const output = await pricingAuthority.computePricing({
    poolOrTransaction: pool,
    tenantId: feeCtx.tenantId,
    pricingProducts,
    paymentMethodType: paymentMethod
  });

  return {
    basePremium: output.totals.basePremiumTotal,
    processingFee: output.totals.nonIncludedFeeTotal,
    systemFees: output.totals.systemFees,
    totalPremium: output.totals.monthlyContribution,
    authority: output
  };
}

/**
 * S6 — MW Tier Price (async — calls PricingEngine)
 * Returns the monthly MightyWELL rate for the given tier at Over 40 rate.
 */
async function calcMwTierPrice(productId, oopLevel, tier, tenantId = null, effectiveDate = null) {
  const dbTier = TIER_TO_DB[tier] || tier;
  const memberCriteria = { tier: dbTier, age: 40, tobaccoUse: 'no' };
  const configValues = oopLevel ? { ConfigValue1: String(oopLevel) } : {};

  // Default to today when no effective date is provided so the pricing query
  // filters by EffectiveDate/TerminationDate and picks the most-recent rate.
  const resolvedDate = effectiveDate || new Date().toISOString().slice(0, 10);

  const isBundle = await BundleProcessor.isBundleProduct(productId);
  let pricingResult;
  if (isBundle) {
    pricingResult = await BundleProcessor.processBundleProduct(productId, memberCriteria, configValues, resolvedDate);
  } else {
    pricingResult = await PricingEngine.calculateProductPricing(productId, memberCriteria, configValues, resolvedDate);
  }

  let selectedVariation = null;
  if (oopLevel && pricingResult.pricingVariations) {
    selectedVariation = pricingResult.pricingVariations.find(
      p => p.configValue === String(oopLevel)
    );
  }
  const pricing = selectedVariation || pricingResult;

  // Collect underlying product parts with their base premiums
  const parts = [];
  if (pricingResult.isBundle && pricingResult.includedProducts && Array.isArray(pricingResult.includedProducts)) {
    for (const prod of pricingResult.includedProducts) {
      const prodPremium = Number(prod.monthlyPremium || 0);
      if (prodPremium > 0 && prod.productId) {
        parts.push({ productId: String(prod.productId), basePremium: round2(prodPremium) });
      }
    }
    const bundleDiscount = Number(pricingResult.bundleDiscount || 0);
    if (bundleDiscount > 0) {
      const totalBefore = parts.reduce((s, p) => s + p.basePremium, 0);
      const adjusted = round2(Math.max(0, totalBefore - bundleDiscount));
      if (totalBefore > 0) {
        const ratio = adjusted / totalBefore;
        for (const part of parts) {
          part.basePremium = round2(part.basePremium * ratio);
        }
      }
    }
  } else {
    const basePremium = Number(pricing.monthlyPremium || 0);
    if (basePremium > 0) {
      parts.push({ productId: String(productId), basePremium: round2(basePremium) });
    }
  }

  if (!tenantId || parts.length === 0) {
    return Math.round(parts.reduce((s, p) => s + p.basePremium, 0));
  }

  // Load fee context and apply fees using quick-quote logic
  const feeCtx = await loadProposalFeeContext(tenantId, parts.map(p => p.productId));
  if (!feeCtx) {
    return Math.round(parts.reduce((s, p) => s + p.basePremium, 0));
  }
  const result = await applyQuoteFeesToParts(parts, feeCtx, 'ACH');
  return Math.round(result.totalPremium);
}

/** S7 — MW Tier Cost (per tier) */
function calcMwTierCost(tierCount, tierPrice) {
  return tierCount * tierPrice;
}

/** S8 — MW Total Monthly (EC defaults to 0 for legacy 3-tier callers) */
function calcMwTotalMonthly(tierCostEE, tierCostE1, tierCostEF, tierCostEC = 0) {
  return tierCostEE + tierCostE1 + tierCostEF + tierCostEC;
}

/** S9 — MW Total Yearly */
function calcMwTotalYearly(totalMonthly) {
  return yearlyFromMonthly(totalMonthly);
}

/** S10 — Unshared Amount Display */
function calcUnsharedAmountDisplay(oopLevel) {
  const num = Number(oopLevel);
  if (!Number.isFinite(num)) return '';
  return `$${num.toLocaleString()}`;
}

/**
 * S11 — Employer Contribution Per Member (per tier)
 * Each tier can independently be dollar or percentage. Always capped at the tier price.
 */
function calcEmployerContrib(tier, contributionValueTypes, contributionValues, tierPrice) {
  const rawValue = contributionValues[tier] || 0;
  const valueType = contributionValueTypes[tier] || 'percentage';
  let contrib;
  if (valueType === 'dollar') {
    contrib = Math.min(rawValue, tierPrice);
  } else {
    contrib = tierPrice * (rawValue / 100);
  }
  return Math.round(Math.min(Math.max(contrib, 0), tierPrice));
}

/** S12 — Employee Cost Per Tier */
function calcEmployeeCost(tierPrice, employerContrib) {
  return Math.max(tierPrice - employerContrib, 0);
}

/**
 * S13 — Total Employer MW Cost Monthly
 *
 * Computes from FULL-PRECISION tier math (count × price × pct%) rather than
 * from the rounded per-member `employerContribs`. The per-member values are
 * Math.round'd for clean per-row display on the PDF, but multiplying rounded
 * values by count introduces cumulative drift: e.g. 50% of $397 rounds to
 * $199/member, × 2 = $398 instead of the correct $397.
 *
 * This function takes the raw contribution config so it can recompute at full
 * precision, round once at the end, and stay exactly proportional to
 * `mwTotalMonthly`.
 */
function calcTotalEmployerMwMonthly(mwCounts, tierPrices, contribValueTypes, contribValues) {
  let total = 0;
  for (const tier of TIERS) {
    const count = mwCounts[tier] || 0;
    const price = tierPrices[tier] || 0;
    if (count === 0 || price === 0) continue;
    const rawValue = contribValues[tier] || 0;
    const valueType = contribValueTypes[tier] || 'percentage';
    let tierEmployerTotal;
    if (valueType === 'dollar') {
      tierEmployerTotal = count * Math.min(rawValue, price);
    } else {
      tierEmployerTotal = count * price * (rawValue / 100);
    }
    total += tierEmployerTotal;
  }
  // Return UNROUNDED — formatCurrency handles display rounding. If we Math.round
  // here, the $0.50 error compounds when yearly = monthly × 12 ($6/yr drift).
  return total;
}

/** S14 — Total Employer MW Cost Yearly */
function calcTotalEmployerMwYearly(monthly) {
  return yearlyFromMonthly(monthly);
}

/**
 * S15 — Total Employee Cost Monthly
 *
 * Same full-precision approach as calcTotalEmployerMwMonthly: derive employee
 * cost as (total - employer) at the aggregate level so rounding is consistent.
 */
function calcTotalEmployeeCostMonthly(mwTotalMonthly, totalEmployerMonthly) {
  return Math.max(mwTotalMonthly - totalEmployerMonthly, 0);
}

/** S16 — Current Premium Yearly */
function calcCurrentPremiumYearly(monthlyPremium) {
  return yearlyFromMonthly(monthlyPremium);
}

/** S17 — Net Cost Change Monthly */
function calcNetCostChangeMonthly(proposedEmployerMonthly, currentMonthlyPremium) {
  return proposedEmployerMonthly - currentMonthlyPremium;
}

/** S18 — Net Cost Change Yearly */
function calcNetCostChangeYearly(netMonthly) {
  return yearlyFromMonthly(netMonthly);
}

/** S19 — Savings Monthly */
function calcSavingsMonthly(currentMonthlyPremium, proposedEmployerMonthly) {
  return currentMonthlyPremium - proposedEmployerMonthly;
}

/** S20 — Savings Yearly */
function calcSavingsYearly(savingsMonthly) {
  return yearlyFromMonthly(savingsMonthly);
}

/**
 * S20b — Employer Cost Reduction Pct (Partial Switch)
 * Percent change from current monthly employer-paid cost to projected monthly employer-paid cost.
 * Negative = cost reduction, positive = cost increase.
 */
function calcEmployerCostReductionPctPartial(currentEmployerMonthly, projectedEmployerMonthly) {
  const current = Number(currentEmployerMonthly || 0);
  if (current === 0) return 0;
  return ((projectedEmployerMonthly - current) / current) * 100;
}

/**
 * S20c — Employee Cost Reduction Pct (Partial Switch)
 * Percent change from current average employee monthly cost to MW average employee monthly cost.
 * Negative = cost reduction, positive = cost increase.
 */
function calcEmployeeCostReductionPctPartial(avgCurrentEmployeeCost, avgMwEmployeeCost) {
  const current = Number(avgCurrentEmployeeCost || 0);
  if (current === 0) return 0;
  return ((avgMwEmployeeCost - current) / current) * 100;
}

/** S21 — Net Enrollment Change (Count) */
function calcNetEnrollmentChangeCount(totalProjectedEnrolled, currentlyEnrolled) {
  return totalProjectedEnrolled - currentlyEnrolled;
}

/** S22 — Net Enrollment Change (Pct) */
function calcNetEnrollmentChangePct(projectedPct, currentPct) {
  return projectedPct - currentPct;
}

/** S23 — Calc Step: Tier Allocation (display string per tier) */
function calcStepTierAlloc(totalMwEnrollees, tierMixPctVal, tierCount) {
  return `${totalMwEnrollees} × ${Math.round(tierMixPctVal)}% = ${tierCount}`;
}

/** S24 — Calc Step: Tier Cost (display string per tier) */
function calcStepTierCost(tierCount, tierPrice, tierCost) {
  return `${tierCount} × ${formatCurrency(tierPrice)} = ${formatCurrency(tierCost)}`;
}

/** S25 — Calc Step: Total Cost (display string) */
function calcStepTotalCost(totalMonthly) {
  return `Total: ${formatCurrency(totalMonthly)} / month`;
}

/** S27 — Total Employees Display (pass-through for PDF use) */
function calcTotalEmployeesDisplay(totalEmployees) {
  return totalEmployees;
}

/** S33 — Currently Enrolled Display (pass-through for PDF use) */
function calcCurrentlyEnrolledDisplay(currentlyEnrolled) {
  return currentlyEnrolled || 0;
}

/** S31 — Current Remain Count Display (pass-through for PDF use) */
function calcCurrentRemainCountDisplay(currentRemainCount) {
  return currentRemainCount || 0;
}

/** S28 — Current Premium Monthly (display field — the employer's current full monthly cost) */
function calcCurrentPremiumMonthly(currentMonthlyPremium) {
  return formatCurrency(currentMonthlyPremium || 0);
}

/**
 * S29 — Net Change Premium Monthly (full plan cost comparison, BEFORE employer/employee split)
 * mwTotalMonthly is the full quoted premium; currentMonthlyPremium is the employer's current spend.
 * Negative = proposed plan is cheaper overall.
 */
function calcNetChangePremiumMonthly(mwTotalMonthly, currentMonthlyPremium) {
  return mwTotalMonthly - (currentMonthlyPremium || 0);
}

/** S30 — Net Change Premium Yearly (full plan cost comparison × 12) */
function calcNetChangePremiumYearly(netChangePremiumMonthly) {
  return yearlyFromMonthly(netChangePremiumMonthly);
}

/** S30b — Overall Savings Yearly (Partial Switch, before contributions) */
function calcOverallSavingsYearlyPartialBeforeContrib(currentTotalYearly, combinedPremiumYearly) {
  return (currentTotalYearly || 0) - (combinedPremiumYearly || 0);
}

/** S26 — Enrollment Date Display */
function calcEnrollmentDatesDisplay(enrollmentDate) {
  if (!enrollmentDate) return '';
  // Avoid timezone shifts for YYYY-MM-DD input by parsing manually first.
  const m = String(enrollmentDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    return `${month}/${day}/${String(year).slice(2)}`;
  }

  const d = new Date(enrollmentDate);
  if (isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
}

// ============================================================================
// P2–P13: PARTIAL SWITCH CALCULATIONS
// ============================================================================

/** P2 — Avg Current Per-Employee Cost */
function calcAvgCurrentPerEmployee(currentMonthlyPremium, currentlyEnrolled) {
  if (currentlyEnrolled === 0) return 0;
  return Math.round(currentMonthlyPremium / currentlyEnrolled);
}

/** P3 — Current Remain Monthly Employer Cost */
function calcCurrentRemainMonthly(avgCurrentPerEmployee, currentRemainCount) {
  return avgCurrentPerEmployee * currentRemainCount;
}

/** P4 — Current Remain Yearly Employer Cost */
function calcCurrentRemainYearly(currentRemainMonthly) {
  return yearlyFromMonthly(currentRemainMonthly);
}

/** P5 / G1 — Total Projected Enrolled */
function calcTotalProjectedEnrolled(totalMwEnrollees, currentRemainCount) {
  return totalMwEnrollees + (currentRemainCount || 0);
}

/** P6 / G2 — Projected Enrollment Pct */
function calcProjectedEnrollmentPct(totalProjectedEnrolled, totalEmployees) {
  if (totalEmployees === 0) return 0;
  return (totalProjectedEnrolled / totalEmployees) * 100;
}

/** P7 — Mixed Employer Cost Monthly (MW employees + employees remaining on current plan) */
function calcMixedEmployerMonthly(totalEmployerMwMonthly, currentRemainMonthly) {
  return totalEmployerMwMonthly + currentRemainMonthly;
}
/** Backward-compat alias */
const calcBlendedEmployerMonthly = calcMixedEmployerMonthly;

/** P8 — Mixed Employer Cost Yearly */
function calcMixedEmployerYearly(mixedMonthly) {
  return yearlyFromMonthly(mixedMonthly);
}
/** Backward-compat alias */
const calcBlendedEmployerYearly = calcMixedEmployerYearly;

/** Combined total premium monthly (MW full premium + remaining employees' current premium, per-tier) */
function calcCombinedPremiumMonthly(mwTotalMonthly, remainCounts, currentPrices) {
  let remainPremium = 0;
  for (const tier of TIERS) {
    remainPremium += (remainCounts[tier] || 0) * (currentPrices[tier] || 0);
  }
  return mwTotalMonthly + remainPremium;
}

function calcCombinedPremiumYearly(combinedPremiumMonthly) {
  return yearlyFromMonthly(combinedPremiumMonthly);
}

/** Combined employer cost monthly (MW employer contrib + current plan employer contrib for remaining, per-tier) */
function calcCombinedEmployerMonthly(totalEmployerMwMonthly, remainCounts, currentEmployerContribs) {
  let remainEmployerCost = 0;
  for (const tier of TIERS) {
    remainEmployerCost += (remainCounts[tier] || 0) * (currentEmployerContribs[tier] || 0);
  }
  return totalEmployerMwMonthly + remainEmployerCost;
}

function calcCombinedEmployerYearly(combinedEmployerMonthly) {
  return yearlyFromMonthly(combinedEmployerMonthly);
}

/** P9 — Headline Value (Partial Switch) */
function calcHeadlinePartialSwitch(netCostChangeYearly) {
  if (netCostChangeYearly < 0) {
    return `Saving ${formatCurrency(Math.abs(netCostChangeYearly))} / Year`;
  }
  return `+${formatCurrency(netCostChangeYearly)} / Year`;
}

/** P10 / G4 — Participation Mix: MW Count */
function calcPartMixMwCount(totalMwEnrollees) {
  return totalMwEnrollees;
}

/** P11 / G5 — Participation Mix: Remain Count */
function calcPartMixRemainCount(currentRemainCount) {
  return currentRemainCount || 0;
}

/** P12 / G6 — Participation Mix: Not Enrolled */
function calcPartMixNotEnrolled(notEnrolledCount) {
  return notEnrolledCount;
}

/** P13 / G7 — Net Business Impact Text */
function calcNetBusinessImpact(netEnrollChangeCount, netEnrollChangePct, hasExistingCoverage, totalProjectedEnrolled, projectedEnrollPct) {
  if (hasExistingCoverage) {
    return `${formatSignedCount(netEnrollChangeCount)} employees, ${formatSignedPct(netEnrollChangePct)} participation`;
  }
  return `${totalProjectedEnrolled} employees enrolled, ${formatPct(projectedEnrollPct)} participation`;
}

// ============================================================================
// G3, G8: GENERIC QUOTE–ONLY CALCULATIONS
// ============================================================================

/** G3 — Headline Value (Generic Quote) */
function calcHeadlineGenericQuote(hasExistingCoverage, netCostChangeYearly, totalEmployerMwYearly, totalEmployerMwMonthly) {
  if (hasExistingCoverage) {
    if (netCostChangeYearly < 0) {
      return `Saving ${formatCurrency(Math.abs(netCostChangeYearly))} / Year`;
    }
    return `+${formatCurrency(netCostChangeYearly)} / Year`;
  }
  return `${formatCurrency(totalEmployerMwYearly)} / Year (${formatCurrency(totalEmployerMwMonthly)} / Monthly)`;
}

/** G8 — Calc Step: Enrollment (display string) */
function calcStepEnrollment(totalEmployees, mwEnrollmentPct, totalMwEnrollees) {
  return `${totalEmployees} × ${Math.round(mwEnrollmentPct)}% = ${totalMwEnrollees}`;
}

// ============================================================================
// E1–E6: EMPLOYEE PROPOSAL CALCULATIONS
// ============================================================================

/** E1 — Employer Contribution Display (per tier) */
function calcEmployerContribDisplay(employerContrib, tierPrice) {
  if (tierPrice === 0) return '$0 (0% of premium)';
  const pct = (employerContrib / tierPrice) * 100;
  return `${formatCurrency(employerContrib)} (${Math.round(pct)}% of premium)`;
}

/** E2 — Employer Share Percentage (per tier) */
function calcEmployerSharePct(employerContrib, tierPrice) {
  if (tierPrice === 0) return 0;
  return (employerContrib / tierPrice) * 100;
}

/** E3 — Employee Share Percentage (per tier) */
function calcEmployeeSharePct(employeeCost, tierPrice) {
  if (tierPrice === 0) return 0;
  return (employeeCost / tierPrice) * 100;
}

/** E4 — Employee Monthly Cost Display (per tier) */
function calcEmployeeMonthlyCost(employeeCost) {
  return formatCurrency(employeeCost);
}

/** E5 — Employee Annual Cost (per tier) */
function calcEmployeeAnnualCost(employeeCost) {
  return yearlyFromMonthly(employeeCost);
}

/** E6 — Employer Annual Contribution (per tier) */
function calcEmployerAnnualContrib(employerContrib) {
  return yearlyFromMonthly(employerContrib);
}

/**
 * E7 — Employee Savings Monthly (per tier)
 * How much less the employee pays per month on the new MW plan vs the current plan average.
 * avgCurrentPerEmployee is the current plan's average cost per employee (currentPremium / enrolled).
 * employeeCost is what they'd pay on MW after the employer contribution.
 * Positive = employee saves money by switching.
 */
function calcEmployeeSavingsMonthly(avgCurrentPerEmployee, employeeCost) {
  return (avgCurrentPerEmployee || 0) - employeeCost;
}

/** E8 — Employee Savings Yearly (per tier) */
function calcEmployeeSavingsYearly(savingsMonthly) {
  return yearlyFromMonthly(savingsMonthly);
}

// ============================================================================
// CURRENT PLAN DETAIL CALCULATIONS
// ============================================================================

/** Current total enrolled (sum of per-tier counts; EC defaults to 0 for legacy 3-tier callers) */
function calcCurrentTotalEnrolled(currentCountEE, currentCountE1, currentCountEF, currentCountEC = 0) {
  return (currentCountEE || 0) + (currentCountE1 || 0) + (currentCountEF || 0) + (currentCountEC || 0);
}

/** Current tier cost = count x price for a tier */
function calcCurrentTierCost(currentCount, currentPrice) {
  return (currentCount || 0) * (currentPrice || 0);
}

/** Current total monthly = sum of all tier costs (EC defaults to 0 for legacy 3-tier callers) */
function calcCurrentTotalMonthly(tierCostEE, tierCostE1, tierCostEF, tierCostEC = 0) {
  return tierCostEE + tierCostE1 + tierCostEF + tierCostEC;
}

/** Current total yearly */
function calcCurrentTotalYearly(totalMonthly) {
  return yearlyFromMonthly(totalMonthly);
}

/** Employees not enrolled on current plan (before MW changes) */
function calcCurrentNotEnrolledCount(totalEmployees, currentTotalEnrolled) {
  return totalEmployees - currentTotalEnrolled;
}

/** Current tier mix percentage */
function calcCurrentTierMixPct(currentTierCount, currentTotalEnrolled) {
  if (currentTotalEnrolled === 0) return 0;
  return (currentTierCount / currentTotalEnrolled) * 100;
}

/**
 * Current employer contribution per member (per tier).
 * Each tier can independently be dollar or percentage. Always capped at the tier price.
 */
function calcCurrentEmployerContrib(tier, currentContribValueTypes, currentContribValues, currentTierPrice) {
  const rawValue = currentContribValues[tier] || 0;
  const valueType = currentContribValueTypes[tier] || 'percentage';
  let contrib;
  if (valueType === 'dollar') {
    contrib = Math.min(rawValue, currentTierPrice);
  } else {
    contrib = currentTierPrice * (rawValue / 100);
  }
  return Math.round(Math.min(Math.max(contrib, 0), currentTierPrice));
}

/** Current employee cost per tier */
function calcCurrentEmployeeCostTier(currentTierPrice, currentEmployerContrib) {
  return Math.max(currentTierPrice - currentEmployerContrib, 0);
}

/** Current total employer monthly */
function calcCurrentTotalEmployerMonthly(currentCounts, currentEmployerContribs) {
  let total = 0;
  for (const tier of TIERS) {
    total += (currentCounts[tier] || 0) * (currentEmployerContribs[tier] || 0);
  }
  return total;
}

/** Current total employee cost monthly */
function calcCurrentTotalEmployeeCostMonthlyFn(currentCounts, currentEmployeeCosts) {
  let total = 0;
  for (const tier of TIERS) {
    total += (currentCounts[tier] || 0) * (currentEmployeeCosts[tier] || 0);
  }
  return total;
}

/** Current remain enrollment percentage */
function calcCurrentRemainEnrollmentPct(currentRemainCount, totalEmployees) {
  if (totalEmployees === 0) return 0;
  return ((currentRemainCount || 0) / totalEmployees) * 100;
}

// ============================================================================
// MW EMPLOYEE AGGREGATES
// ============================================================================

/** Total employee cost yearly */
function calcTotalEmployeeCostYearly(totalEmployeeCostMonthly) {
  return yearlyFromMonthly(totalEmployeeCostMonthly);
}

/** Average employee cost monthly = total / count */
function calcAvgEmployeeCostMonthly(totalEmployeeCostMonthly, totalMwEnrollees) {
  if (totalMwEnrollees === 0) return 0;
  return Math.round(totalEmployeeCostMonthly / totalMwEnrollees);
}

/** Average employee cost yearly */
function calcAvgEmployeeCostYearly(avgMonthly) {
  return yearlyFromMonthly(avgMonthly);
}

// ============================================================================
// NET EMPLOYEE COST CHANGE
// ============================================================================

/** Average current employee cost monthly (from per-tier data) */
function calcAvgCurrentEmployeeCostMonthly(currentTotalEmployeeCostMonthly, currentTotalEnrolled) {
  if (currentTotalEnrolled === 0) return 0;
  return Math.round(currentTotalEmployeeCostMonthly / currentTotalEnrolled);
}

/** Average employee cost change monthly = current avg - MW avg */
function calcAvgEmployeeCostChangeMonthly(avgCurrentEmployeeCost, avgMwEmployeeCost) {
  return avgCurrentEmployeeCost - avgMwEmployeeCost;
}

/** Average employee cost change yearly */
function calcAvgEmployeeCostChangeYearly(changeMonthly) {
  return yearlyFromMonthly(changeMonthly);
}

/** S34 — Employer Contribution Strategy Text
 * Generates a one-sentence description of how the employer splits costs with employees.
 * Handles all contribution type combinations: flat, per-tier, mixed, apply-EE-to-all.
 */
function calcEmployerContribStrategyText(contribValueTypes, contribValues, tierPrices) {
  const typeEE = contribValueTypes.EE || 'percentage';
  const typeE1 = contribValueTypes.E1 || 'percentage';
  const typeEF = contribValueTypes.EF || 'percentage';
  const typeEC = contribValueTypes.EC || 'percentage';
  const valEE = contribValues.EE || 0;
  const valE1 = contribValues.E1 || 0;
  const valEF = contribValues.EF || 0;
  const valEC = contribValues.EC || 0;

  // EC participates in pattern matching only when the product actually has an EC tier
  // (signaled by a positive EC tier price). For 3-tier products, EC is ignored entirely
  // so existing 3-tier strategy text remains unchanged.
  const hasEC = (tierPrices?.EC || 0) > 0;

  // Helper to format a tier's contribution
  const fmtTier = (val, type) => type === 'dollar' ? `$${Math.round(val).toLocaleString()}` : `${Math.round(val)}%`;

  if (hasEC) {
    const allSameType = typeEE === typeE1 && typeE1 === typeEC && typeEC === typeEF;
    const allSameValue = valEE === valE1 && valE1 === valEC && valEC === valEF;

    // "Apply EE to All" pattern: EE is percentage, others are dollar with same value
    if (typeEE === 'percentage' && typeE1 === 'dollar' && typeEC === 'dollar' && typeEF === 'dollar'
        && valE1 === valEF && valE1 === valEC && valEE > 0) {
      return `Employer covers ${Math.round(valEE)}% of EE premium, applied as $${Math.round(valE1).toLocaleString()} to E+1, EC, and EF`;
    }

    if (allSameType && allSameValue) {
      if (typeEE === 'dollar') {
        return `Employer covers $${Math.round(valEE).toLocaleString()} per employee (all tiers)`;
      }
      return `Employer covers ${Math.round(valEE)}% of each tier's premium`;
    }

    if (allSameType) {
      if (typeEE === 'dollar') {
        return `Employer covers $${Math.round(valEE).toLocaleString()} for EE, $${Math.round(valE1).toLocaleString()} for E+1, $${Math.round(valEC).toLocaleString()} for EC, and $${Math.round(valEF).toLocaleString()} for EF`;
      }
      return `Employer covers ${Math.round(valEE)}% for EE, ${Math.round(valE1)}% for E+1, ${Math.round(valEC)}% for EC, and ${Math.round(valEF)}% for EF`;
    }

    return `Employer covers ${fmtTier(valEE, typeEE)} for EE, ${fmtTier(valE1, typeE1)} for E+1, ${fmtTier(valEC, typeEC)} for EC, and ${fmtTier(valEF, typeEF)} for EF`;
  }

  // ---- 3-tier path (unchanged behavior) ----
  const allSameType = typeEE === typeE1 && typeE1 === typeEF;
  const allSameValue = valEE === valE1 && valE1 === valEF;

  if (typeEE === 'percentage' && typeE1 === 'dollar' && typeEF === 'dollar' && valE1 === valEF && valEE > 0) {
    return `Employer covers ${Math.round(valEE)}% of EE premium, applied as $${Math.round(valE1).toLocaleString()} to E+1 and EF`;
  }

  if (allSameType && allSameValue) {
    if (typeEE === 'dollar') {
      return `Employer covers $${Math.round(valEE).toLocaleString()} per employee (all tiers)`;
    }
    return `Employer covers ${Math.round(valEE)}% of each tier's premium`;
  }

  if (allSameType) {
    if (typeEE === 'dollar') {
      return `Employer covers $${Math.round(valEE).toLocaleString()} for EE, $${Math.round(valE1).toLocaleString()} for E+1, and $${Math.round(valEF).toLocaleString()} for EF`;
    }
    return `Employer covers ${Math.round(valEE)}% for EE, ${Math.round(valE1)}% for E+1, and ${Math.round(valEF)}% for EF`;
  }

  return `Employer covers ${fmtTier(valEE, typeEE)} for EE, ${fmtTier(valE1, typeE1)} for E+1, and ${fmtTier(valEF, typeEF)} for EF`;
}

// ============================================================================
// MASTER ORCHESTRATOR
// ============================================================================

/**
 * Compute all calculations needed for a set of documents.
 *
 * @param {Object} inputs — Raw form inputs from the agent
 * @param {string[]} documentCalcTypes — Flat list of calculationType keys found on
 *   all selected PDF templates (e.g. ['calcTotalMwEnrollees', 'calcMwTierPrice_EE', …])
 * @param {Object[]} productSlots — Array of { slotNumber, productId } from the templates
 * @returns {Promise<Record<string, string|number>>} — Flat map of key → display value
 */
async function computeAllCalculations(inputs, documentCalcTypes, productSlots) {
  const {
    companyName,
    companyAddress,
    totalEmployees,
    hasExistingCoverage,
    // Per-tier current coverage (new)
    currentCountEE: inputCurrentCountEE,
    currentCountE1: inputCurrentCountE1,
    currentCountEC: inputCurrentCountEC,
    currentCountEF: inputCurrentCountEF,
    currentPremiumEE: inputCurrentPremiumEE,
    currentPremiumE1: inputCurrentPremiumE1,
    currentPremiumEC: inputCurrentPremiumEC,
    currentPremiumEF: inputCurrentPremiumEF,
    currentContributionType: inputCurrentContribType,
    currentContributionValueType: inputCurrentContribValueType,
    currentContributionValue: inputCurrentContribValue,
    currentContributionValueEE: inputCurrentContribValueEE,
    currentContributionValueE1: inputCurrentContribValueE1,
    currentContributionValueEC: inputCurrentContribValueEC,
    currentContributionValueEF: inputCurrentContribValueEF,
    currentContributionValueTypeEE: inputCurrentContribValueTypeEE,
    currentContributionValueTypeE1: inputCurrentContribValueTypeE1,
    currentContributionValueTypeEC: inputCurrentContribValueTypeEC,
    currentContributionValueTypeEF: inputCurrentContribValueTypeEF,
    // Backward-compatible derived values
    currentlyEnrolled,
    currentMonthlyPremium,
    oopLevel,
    mwCountEE,
    mwCountE1,
    mwCountEC,
    mwCountEF,
    currentRemainCount,
    currentRemainCountEE,
    currentRemainCountE1,
    currentRemainCountEC,
    currentRemainCountEF,
    contributionType,
    contributionValueType,
    contributionValue,
    contributionValueEE: inputContribValueEE,
    contributionValueE1: inputContribValueE1,
    contributionValueEC: inputContribValueEC,
    contributionValueEF: inputContribValueEF,
    contributionValueTypeEE: inputContribValueTypeEE,
    contributionValueTypeE1: inputContribValueTypeE1,
    contributionValueTypeEC: inputContribValueTypeEC,
    contributionValueTypeEF: inputContribValueTypeEF,
    enrollmentDate,
    tenantId: inputTenantId
  } = inputs;

  const needs = new Set(documentCalcTypes);
  const results = {};

  // Backward compat: expand old flat/global fields into per-tier
  const contributionValueEE = (inputContribValueEE != null && inputContribValueEE !== 0)
    ? inputContribValueEE
    : (contributionType === 'flat' ? (contributionValue || 0) : (inputContribValueEE || 0));
  const contributionValueE1 = (inputContribValueE1 != null && inputContribValueE1 !== 0)
    ? inputContribValueE1
    : (contributionType === 'flat' ? (contributionValue || 0) : (inputContribValueE1 || 0));
  const contributionValueEC = (inputContribValueEC != null && inputContribValueEC !== 0)
    ? inputContribValueEC
    : (contributionType === 'flat' ? (contributionValue || 0) : (inputContribValueEC || 0));
  const contributionValueEF = (inputContribValueEF != null && inputContribValueEF !== 0)
    ? inputContribValueEF
    : (contributionType === 'flat' ? (contributionValue || 0) : (inputContribValueEF || 0));

  const contributionValueTypeEE = inputContribValueTypeEE || contributionValueType || 'percentage';
  const contributionValueTypeE1 = inputContribValueTypeE1 || contributionValueType || 'percentage';
  const contributionValueTypeEC = inputContribValueTypeEC || contributionValueType || 'percentage';
  const contributionValueTypeEF = inputContribValueTypeEF || contributionValueType || 'percentage';

  const contribValues = { EE: contributionValueEE, E1: contributionValueE1, EC: contributionValueEC, EF: contributionValueEF };
  const contribValueTypes = { EE: contributionValueTypeEE, E1: contributionValueTypeE1, EC: contributionValueTypeEC, EF: contributionValueTypeEF };

  const mwCounts = { EE: mwCountEE || 0, E1: mwCountE1 || 0, EC: mwCountEC || 0, EF: mwCountEF || 0 };

  // --- Company info (always available) ---
  results.companyName = companyName || '';
  results.companyAddress = companyAddress || '';

  // --- S1: Total MW Enrollees ---
  const totalMwEnrollees = calcTotalMwEnrollees(mwCounts.EE, mwCounts.E1, mwCounts.EF, mwCounts.EC);
  results.calcTotalMwEnrollees = totalMwEnrollees;
  results.calcMwTierCountDisplay_EE = calcMwTierCountDisplay(mwCounts.EE);
  results.calcMwTierCountDisplay_E1 = calcMwTierCountDisplay(mwCounts.E1);
  results.calcMwTierCountDisplay_EC = calcMwTierCountDisplay(mwCounts.EC);
  results.calcMwTierCountDisplay_EF = calcMwTierCountDisplay(mwCounts.EF);

  // --- S2: Tier Mix Pct (per tier) ---
  const tierMixPcts = {};
  for (const tier of TIERS) {
    tierMixPcts[tier] = calcTierMixPct(mwCounts[tier], totalMwEnrollees);
    results[`calcTierMixPct_${tier}`] = formatPct(tierMixPcts[tier]);
  }

  // --- S3: MW Enrollment Pct ---
  const mwEnrollmentPctVal = calcMwEnrollmentPct(totalMwEnrollees, totalEmployees);
  results.calcMwEnrollmentPct = formatPct(mwEnrollmentPctVal);

  // --- S4: Current Enrollment Pct ---
  const currentEnrollPctVal = calcCurrentEnrollmentPct(currentlyEnrolled || 0, totalEmployees);
  results.calcCurrentEnrollmentPct = formatPct(currentEnrollPctVal);

  // --- S5: Not Enrolled Count ---
  const crCount = currentRemainCount || 0;
  const notEnrolledCount = calcNotEnrolledCount(totalEmployees, totalMwEnrollees, crCount);
  results.calcNotEnrolledCount = notEnrolledCount;

  results.calcNotEnrolledCountGeneric = calcNotEnrolledCountGeneric(totalEmployees, totalMwEnrollees);

  // --- Per-tier remain on current plan display ---
  results.calcCurrentRemainTierCountDisplay_EE = calcCurrentRemainTierCountDisplay(currentRemainCountEE || 0);
  results.calcCurrentRemainTierCountDisplay_E1 = calcCurrentRemainTierCountDisplay(currentRemainCountE1 || 0);
  results.calcCurrentRemainTierCountDisplay_EC = calcCurrentRemainTierCountDisplay(currentRemainCountEC || 0);
  results.calcCurrentRemainTierCountDisplay_EF = calcCurrentRemainTierCountDisplay(currentRemainCountEF || 0);

  // --- S6: MW Tier Price (async — per tier, per product slot) ---
  // Fetch prices for each product slot
  const tierPricesBySlot = {};
  const slotsToUse = (productSlots && productSlots.length > 0)
    ? productSlots
    : [{ slotNumber: 1, productId: null }];

  for (const slot of slotsToUse) {
    if (!slot.productId) continue;
    tierPricesBySlot[slot.slotNumber] = {};
    for (const tier of TIERS) {
      try {
        const price = await calcMwTierPrice(slot.productId, oopLevel, tier, inputTenantId, enrollmentDate || null);
        tierPricesBySlot[slot.slotNumber][tier] = price;
      } catch (err) {
        console.error(`⚠️ Failed to fetch tier price for slot ${slot.slotNumber}, tier ${tier}:`, err.message);
        tierPricesBySlot[slot.slotNumber][tier] = 0;
      }
    }
  }

  // Pick the primary slot for unsuffixed tier prices / employer contribution base:
  //   1. prefer a slot explicitly flagged IsPrimary
  //   2. fall back to the first slot in slotsToUse
  const primarySlot = slotsToUse.find(s => s.isPrimary && s.productId) || slotsToUse[0];
  const primarySlotNum = primarySlot?.slotNumber || 1;
  const tierPrices = tierPricesBySlot[primarySlotNum] || { EE: 0, E1: 0, EC: 0, EF: 0 };

  // Write tier prices to results (with slot suffixes for multi-slot)
  for (const slotNum of Object.keys(tierPricesBySlot)) {
    const prices = tierPricesBySlot[slotNum];
    const suffix = Object.keys(tierPricesBySlot).length > 1 ? `_slot_${slotNum}` : '';
    for (const tier of TIERS) {
      results[`calcMwTierPrice_${tier}${suffix}`] = formatCurrency(prices[tier]);
    }
  }
  // Always write unsuffixed from primary slot
  for (const tier of TIERS) {
    results[`calcMwTierPrice_${tier}`] = formatCurrency(tierPrices[tier]);
  }

  // --- Employer Contribution (per tier, uses primary slot prices) ---
  const employerContribs = {};
  const employeeCosts = {};
  for (const tier of TIERS) {
    employerContribs[tier] = calcEmployerContrib(tier, contribValueTypes, contribValues, tierPrices[tier]);
    employeeCosts[tier] = calcEmployeeCost(tierPrices[tier], employerContribs[tier]);
    results[`calcEmployerContrib_${tier}`] = formatCurrency(employerContribs[tier]);
    results[`calcEmployeeCost_${tier}`] = formatCurrency(employeeCosts[tier]);
  }

  // Per-slot employer contributions and employee costs for multi-slot
  for (const slotNum of Object.keys(tierPricesBySlot)) {
    if (String(slotNum) === String(primarySlotNum) && Object.keys(tierPricesBySlot).length <= 1) continue;
    const prices = tierPricesBySlot[slotNum];
    const suffix = `_slot_${slotNum}`;
    for (const tier of TIERS) {
      const ec = calcEmployerContrib(tier, contribValueTypes, contribValues, prices[tier]);
      const empC = calcEmployeeCost(prices[tier], ec);
      results[`calcEmployerContrib_${tier}${suffix}`] = formatCurrency(ec);
      results[`calcEmployeeCost_${tier}${suffix}`] = formatCurrency(empC);
    }
  }

  // --- S34: Employer Contribution Strategy Text ---
  results.calcEmployerContribStrategyText = calcEmployerContribStrategyText(contribValueTypes, contribValues, tierPrices);

  // Stash raw contribution config for dynamicPrice employee cost calculations in PDF generator
  results._contribValueTypes = contribValueTypes;
  results._contribValues = contribValues;

  // --- S7: MW Tier Cost (per tier) ---
  const tierCosts = {};
  for (const tier of TIERS) {
    tierCosts[tier] = calcMwTierCost(mwCounts[tier], tierPrices[tier]);
    results[`calcMwTierCost_${tier}`] = formatCurrency(tierCosts[tier]);
  }

  // --- S8: MW Total Monthly ---
  const mwTotalMonthly = calcMwTotalMonthly(tierCosts.EE, tierCosts.E1, tierCosts.EF, tierCosts.EC);
  results.calcMwTotalMonthly = formatCurrency(mwTotalMonthly);

  // --- S9: MW Total Yearly ---
  const mwTotalYearly = calcMwTotalYearly(mwTotalMonthly);
  results.calcMwTotalYearly = formatCurrency(mwTotalYearly);

  // --- S10: Unshared Amount Display ---
  results.calcUnsharedAmountDisplay = calcUnsharedAmountDisplay(oopLevel);

  // --- S27: Total Employees Display ---
  results.calcTotalEmployeesDisplay = calcTotalEmployeesDisplay(totalEmployees);

  // --- S33: Currently Enrolled Display ---
  results.calcCurrentlyEnrolledDisplay = calcCurrentlyEnrolledDisplay(currentlyEnrolled || 0);

  // --- S28: Current Premium Monthly ---
  results.calcCurrentPremiumMonthly = calcCurrentPremiumMonthly(currentMonthlyPremium);

  // --- S31: Current Remain Count Display ---
  results.calcCurrentRemainCountDisplay = calcCurrentRemainCountDisplay(currentRemainCount);

  // --- S29: Net Change Premium Monthly (full plan cost, before employer/employee split) ---
  const netChangePremiumMonthlyVal = calcNetChangePremiumMonthly(mwTotalMonthly, currentMonthlyPremium);
  results.calcNetChangePremiumMonthly = formatCurrency(netChangePremiumMonthlyVal);

  // --- S30: Net Change Premium Yearly ---
  const netChangePremiumYearlyVal = calcNetChangePremiumYearly(netChangePremiumMonthlyVal);
  results.calcNetChangePremiumYearly = formatCurrency(netChangePremiumYearlyVal);

  // --- S13: Total Employer MW Cost Monthly (full-precision, rounded once) ---
  const totalEmployerMwMonthly = calcTotalEmployerMwMonthly(mwCounts, tierPrices, contribValueTypes, contribValues);
  results.calcTotalEmployerMwMonthly = formatCurrency(totalEmployerMwMonthly);

  // --- S14: Total Employer MW Cost Yearly ---
  const totalEmployerMwYearly = calcTotalEmployerMwYearly(totalEmployerMwMonthly);
  results.calcTotalEmployerMwYearly = formatCurrency(totalEmployerMwYearly);

  // --- S15: Total Employee Cost Monthly (total minus employer — stays consistent) ---
  const totalEmployeeCostMonthly = calcTotalEmployeeCostMonthly(mwTotalMonthly, totalEmployerMwMonthly);
  results.calcTotalEmployeeCostMonthly = formatCurrency(totalEmployeeCostMonthly);

  // --- S16: Current Premium Yearly ---
  const currentPremiumYearly = calcCurrentPremiumYearly(currentMonthlyPremium || 0);
  results.calcCurrentPremiumYearly = formatCurrency(currentPremiumYearly);

  // --- Partial Switch specific (P2–P8) ---
  const avgCurrentPerEmp = calcAvgCurrentPerEmployee(currentMonthlyPremium || 0, currentlyEnrolled || 0);
  results.calcAvgCurrentPerEmployee = formatCurrency(avgCurrentPerEmp);

  const currentRemainMonthlyVal = calcCurrentRemainMonthly(avgCurrentPerEmp, crCount);
  results.calcCurrentRemainMonthly = formatCurrency(currentRemainMonthlyVal);

  const currentRemainYearlyVal = calcCurrentRemainYearly(currentRemainMonthlyVal);
  results.calcCurrentRemainYearly = formatCurrency(currentRemainYearlyVal);

  // P5/G1 — Total Projected Enrolled
  const totalProjectedEnrolled = calcTotalProjectedEnrolled(totalMwEnrollees, crCount);
  results.calcTotalProjectedEnrolled = totalProjectedEnrolled;

  // P6/G2 — Projected Enrollment Pct
  const projectedEnrollPctVal = calcProjectedEnrollmentPct(totalProjectedEnrolled, totalEmployees);
  results.calcProjectedEnrollmentPct = formatPct(projectedEnrollPctVal);

  // P7 — Mixed Employer Monthly (was Blended)
  const mixedMonthly = calcMixedEmployerMonthly(totalEmployerMwMonthly, currentRemainMonthlyVal);
  results.calcMixedEmployerMonthly = formatCurrency(mixedMonthly);
  results.calcBlendedEmployerMonthly = results.calcMixedEmployerMonthly; // backward compat

  // P8 — Mixed Employer Yearly (was Blended)
  const mixedYearly = calcMixedEmployerYearly(mixedMonthly);
  results.calcMixedEmployerYearly = formatCurrency(mixedYearly);
  results.calcBlendedEmployerYearly = results.calcMixedEmployerYearly; // backward compat

  // --- Net Change calculations ---
  // Generic Quote uses MW-only employer cost vs current full premium.
  // Partial values are initially computed here, then finalized later using
  // after-contribution employer-paid amounts on both plans once those totals are available.
  const netChangeMonthlyPartial = calcNetCostChangeMonthly(mixedMonthly, currentMonthlyPremium || 0);
  const netChangeYearlyPartial = calcNetCostChangeYearly(netChangeMonthlyPartial);
  const savingsMonthlyPartial = calcSavingsMonthly(currentMonthlyPremium || 0, mixedMonthly);
  const savingsYearlyPartial = calcSavingsYearly(savingsMonthlyPartial);

  const netChangeMonthlyGeneric = calcNetCostChangeMonthly(totalEmployerMwMonthly, currentMonthlyPremium || 0);
  const netChangeYearlyGeneric = calcNetCostChangeYearly(netChangeMonthlyGeneric);
  const savingsMonthlyGeneric = calcSavingsMonthly(currentMonthlyPremium || 0, totalEmployerMwMonthly);
  const savingsYearlyGeneric = calcSavingsYearly(savingsMonthlyGeneric);

  // S17–S20 — partial switch variants
  results.calcNetCostChangeMonthly_partial = formatCurrency(netChangeMonthlyPartial);
  results.calcNetCostChangeYearly_partial = formatCurrency(netChangeYearlyPartial);
  results.calcSavingsMonthly_partial = formatCurrency(savingsMonthlyPartial);
  results.calcSavingsYearly_partial = formatCurrency(savingsYearlyPartial);

  // S17–S20 — generic quote variants
  results.calcNetCostChangeMonthly_generic = formatCurrency(netChangeMonthlyGeneric);
  results.calcNetCostChangeYearly_generic = formatCurrency(netChangeYearlyGeneric);
  results.calcSavingsMonthly_generic = formatCurrency(savingsMonthlyGeneric);
  results.calcSavingsYearly_generic = formatCurrency(savingsYearlyGeneric);

  // Unsuffixed defaults to generic.
  results.calcNetCostChangeMonthly = formatCurrency(netChangeMonthlyGeneric);
  results.calcNetCostChangeYearly = formatCurrency(netChangeYearlyGeneric);
  results.calcSavingsMonthly = formatCurrency(savingsMonthlyGeneric);
  results.calcSavingsYearly = formatCurrency(savingsYearlyGeneric);

  // S21 — Net Enrollment Change Count
  const netEnrollChangeCount = calcNetEnrollmentChangeCount(totalProjectedEnrolled, currentlyEnrolled || 0);
  results.calcNetEnrollmentChangeCount = formatSignedCount(netEnrollChangeCount);

  // S22 — Net Enrollment Change Pct
  const netEnrollChangePctVal = calcNetEnrollmentChangePct(projectedEnrollPctVal, currentEnrollPctVal);
  results.calcNetEnrollmentChangePct = formatSignedPct(netEnrollChangePctVal);

  // S23 — Calc Step: Tier Allocation (per tier)
  for (const tier of TIERS) {
    results[`calcStepTierAlloc_${tier}`] = calcStepTierAlloc(totalMwEnrollees, tierMixPcts[tier], mwCounts[tier]);
  }

  // S24 — Calc Step: Tier Cost (per tier)
  for (const tier of TIERS) {
    results[`calcStepTierCost_${tier}`] = calcStepTierCost(mwCounts[tier], tierPrices[tier], tierCosts[tier]);
  }

  // S25 — Calc Step: Total Cost
  results.calcStepTotalCost = calcStepTotalCost(mwTotalMonthly);

  // S26 — Enrollment Date Display
  results.calcEnrollmentDatesDisplay = calcEnrollmentDatesDisplay(enrollmentDate);

  // --- P9 — Headline (Partial Switch) ---
  results.calcHeadlinePartialSwitch = calcHeadlinePartialSwitch(netChangeYearlyPartial);

  // --- P10–P12 — Participation Mix ---
  results.calcPartMixMwCount = calcPartMixMwCount(totalMwEnrollees);
  results.calcPartMixRemainCount = calcPartMixRemainCount(crCount);
  results.calcPartMixNotEnrolled = calcPartMixNotEnrolled(notEnrolledCount);

  // --- P13 / G7 — Net Business Impact ---
  results.calcNetBusinessImpact = calcNetBusinessImpact(
    netEnrollChangeCount, netEnrollChangePctVal,
    hasExistingCoverage, totalProjectedEnrolled, projectedEnrollPctVal
  );

  // --- G3 — Headline (Generic Quote) ---
  results.calcHeadlineGenericQuote = calcHeadlineGenericQuote(
    hasExistingCoverage, netChangeYearlyGeneric, totalEmployerMwYearly, totalEmployerMwMonthly
  );

  // --- G8 — Calc Step: Enrollment ---
  results.calcStepEnrollment = calcStepEnrollment(totalEmployees, mwEnrollmentPctVal, totalMwEnrollees);

  // --- E1–E8: Employee Proposal calculations (per tier) ---
  for (const tier of TIERS) {
    results[`calcEmployerContribDisplay_${tier}`] = calcEmployerContribDisplay(employerContribs[tier], tierPrices[tier]);
    results[`calcEmployerSharePct_${tier}`] = formatPct(calcEmployerSharePct(employerContribs[tier], tierPrices[tier]));
    results[`calcEmployeeSharePct_${tier}`] = formatPct(calcEmployeeSharePct(employeeCosts[tier], tierPrices[tier]));
    results[`calcEmployeeMonthlyCost_${tier}`] = calcEmployeeMonthlyCost(employeeCosts[tier]);
    results[`calcEmployeeAnnualCost_${tier}`] = formatCurrency(calcEmployeeAnnualCost(employeeCosts[tier]));
    results[`calcEmployerAnnualContrib_${tier}`] = formatCurrency(calcEmployerAnnualContrib(employerContribs[tier]));

    // E7–E8: Employee savings by switching (avg current per-employee cost vs MW employee cost)
    const empSavingsMonthly = calcEmployeeSavingsMonthly(avgCurrentPerEmp, employeeCosts[tier]);
    results[`calcEmployeeSavingsMonthly_${tier}`] = formatCurrency(empSavingsMonthly);
    results[`calcEmployeeSavingsYearly_${tier}`] = formatCurrency(calcEmployeeSavingsYearly(empSavingsMonthly));
  }

  // ===================================================================
  // CURRENT PLAN DETAIL CALCULATIONS (from new per-tier inputs)
  // ===================================================================

  const curCounts = {
    EE: inputCurrentCountEE || 0,
    E1: inputCurrentCountE1 || 0,
    EC: inputCurrentCountEC || 0,
    EF: inputCurrentCountEF || 0
  };
  const curPrices = {
    EE: inputCurrentPremiumEE || 0,
    E1: inputCurrentPremiumE1 || 0,
    EC: inputCurrentPremiumEC || 0,
    EF: inputCurrentPremiumEF || 0
  };

  const curTotalEnrolled = calcCurrentTotalEnrolled(curCounts.EE, curCounts.E1, curCounts.EF, curCounts.EC);
  results.calcCurrentTotalEnrolled = curTotalEnrolled;

  for (const tier of TIERS) {
    results[`calcCurrentTierPriceDisplay_${tier}`] = formatCurrency(curPrices[tier]);
    results[`calcCurrentTierCountDisplay_${tier}`] = curCounts[tier];
    const curTierCostVal = calcCurrentTierCost(curCounts[tier], curPrices[tier]);
    results[`calcCurrentTierCost_${tier}`] = formatCurrency(curTierCostVal);
    results[`calcCurrentTierMixPct_${tier}`] = formatPct(calcCurrentTierMixPct(curCounts[tier], curTotalEnrolled));
  }

  const curTotalMonthlyVal = calcCurrentTotalMonthly(
    calcCurrentTierCost(curCounts.EE, curPrices.EE),
    calcCurrentTierCost(curCounts.E1, curPrices.E1),
    calcCurrentTierCost(curCounts.EF, curPrices.EF),
    calcCurrentTierCost(curCounts.EC, curPrices.EC)
  );
  results.calcCurrentTotalMonthly = formatCurrency(curTotalMonthlyVal);
  results.calcCurrentTotalYearly = formatCurrency(calcCurrentTotalYearly(curTotalMonthlyVal));
  results.calcCurrentNotEnrolledCount = calcCurrentNotEnrolledCount(totalEmployees, curTotalEnrolled);

  // Current employer contribution per tier (per-tier value types with backward compat)
  const curContribValueEE = (inputCurrentContribValueEE != null && inputCurrentContribValueEE !== 0)
    ? inputCurrentContribValueEE
    : (inputCurrentContribType === 'flat' ? (inputCurrentContribValue || 0) : (inputCurrentContribValueEE || 0));
  const curContribValueE1 = (inputCurrentContribValueE1 != null && inputCurrentContribValueE1 !== 0)
    ? inputCurrentContribValueE1
    : (inputCurrentContribType === 'flat' ? (inputCurrentContribValue || 0) : (inputCurrentContribValueE1 || 0));
  const curContribValueEC = (inputCurrentContribValueEC != null && inputCurrentContribValueEC !== 0)
    ? inputCurrentContribValueEC
    : (inputCurrentContribType === 'flat' ? (inputCurrentContribValue || 0) : (inputCurrentContribValueEC || 0));
  const curContribValueEF = (inputCurrentContribValueEF != null && inputCurrentContribValueEF !== 0)
    ? inputCurrentContribValueEF
    : (inputCurrentContribType === 'flat' ? (inputCurrentContribValue || 0) : (inputCurrentContribValueEF || 0));

  const curContribValues = { EE: curContribValueEE, E1: curContribValueE1, EC: curContribValueEC, EF: curContribValueEF };
  const curContribValueTypes = {
    EE: inputCurrentContribValueTypeEE || inputCurrentContribValueType || 'percentage',
    E1: inputCurrentContribValueTypeE1 || inputCurrentContribValueType || 'percentage',
    EC: inputCurrentContribValueTypeEC || inputCurrentContribValueType || 'percentage',
    EF: inputCurrentContribValueTypeEF || inputCurrentContribValueType || 'percentage'
  };

  const curEmployerContribs = {};
  const curEmployeeCosts = {};
  for (const tier of TIERS) {
    curEmployerContribs[tier] = calcCurrentEmployerContrib(tier, curContribValueTypes, curContribValues, curPrices[tier]);
    curEmployeeCosts[tier] = calcCurrentEmployeeCostTier(curPrices[tier], curEmployerContribs[tier]);
    results[`calcCurrentEmployerContrib_${tier}`] = formatCurrency(curEmployerContribs[tier]);
    results[`calcCurrentEmployeeCost_${tier}`] = formatCurrency(curEmployeeCosts[tier]);
  }

  const curTotalEmployerMonthlyVal = calcCurrentTotalEmployerMonthly(curCounts, curEmployerContribs);
  results.calcCurrentTotalEmployerMonthly = formatCurrency(curTotalEmployerMonthlyVal);
  results.calcCurrentTotalEmployerYearly = formatCurrency(yearlyFromMonthly(curTotalEmployerMonthlyVal));

  const curTotalEmployeeCostMonthlyVal = calcCurrentTotalEmployeeCostMonthlyFn(curCounts, curEmployeeCosts);
  results.calcCurrentTotalEmployeeCostMonthly = formatCurrency(curTotalEmployeeCostMonthlyVal);

  results.calcCurrentRemainEnrollmentPct = formatPct(calcCurrentRemainEnrollmentPct(crCount, totalEmployees));

  // ===================================================================
  // COMBINED COST (MW + Remaining on Current, per-tier)
  // ===================================================================

  const remainCounts = {
    EE: currentRemainCountEE || 0,
    E1: currentRemainCountE1 || 0,
    EC: currentRemainCountEC || 0,
    EF: currentRemainCountEF || 0,
  };

  const combinedPremiumMonthlyVal = calcCombinedPremiumMonthly(mwTotalMonthly, remainCounts, curPrices);
  results.calcCombinedPremiumMonthly = formatCurrency(combinedPremiumMonthlyVal);
  const combinedPremiumYearlyVal = calcCombinedPremiumYearly(combinedPremiumMonthlyVal);
  results.calcCombinedPremiumYearly = formatCurrency(combinedPremiumYearlyVal);
  results.calcOverallSavingsYearly_partial_beforeContrib = formatCurrency(
    calcOverallSavingsYearlyPartialBeforeContrib(calcCurrentTotalYearly(curTotalMonthlyVal), combinedPremiumYearlyVal)
  );

  const combinedEmployerMonthlyVal = calcCombinedEmployerMonthly(totalEmployerMwMonthly, remainCounts, curEmployerContribs);
  results.calcCombinedEmployerMonthly = formatCurrency(combinedEmployerMonthlyVal);
  results.calcCombinedEmployerYearly = formatCurrency(calcCombinedEmployerYearly(combinedEmployerMonthlyVal));

  // Recompute Partial Switch savings/change using employer-paid amounts AFTER contributions on both plans:
  // projected = combined employer monthly, current = current total employer monthly.
  const netChangeMonthlyPartialAfterContrib = calcNetCostChangeMonthly(combinedEmployerMonthlyVal, curTotalEmployerMonthlyVal);
  const netChangeYearlyPartialAfterContrib = calcNetCostChangeYearly(netChangeMonthlyPartialAfterContrib);
  const savingsMonthlyPartialAfterContrib = calcSavingsMonthly(curTotalEmployerMonthlyVal, combinedEmployerMonthlyVal);
  const savingsYearlyPartialAfterContrib = calcSavingsYearly(savingsMonthlyPartialAfterContrib);
  results.calcNetCostChangeMonthly_partial = formatCurrency(netChangeMonthlyPartialAfterContrib);
  results.calcNetCostChangeYearly_partial = formatCurrency(netChangeYearlyPartialAfterContrib);
  results.calcSavingsMonthly_partial = formatCurrency(savingsMonthlyPartialAfterContrib);
  results.calcSavingsYearly_partial = formatCurrency(savingsYearlyPartialAfterContrib);
  results.calcEmployerCostReductionPct_partial = formatSignedPct(
    calcEmployerCostReductionPctPartial(curTotalEmployerMonthlyVal, combinedEmployerMonthlyVal)
  );
  results.calcHeadlinePartialSwitch = calcHeadlinePartialSwitch(netChangeYearlyPartialAfterContrib);

  // ===================================================================
  // MW EMPLOYEE AGGREGATES
  // ===================================================================

  const totalEmployeeCostYearlyVal = calcTotalEmployeeCostYearly(totalEmployeeCostMonthly);
  results.calcTotalEmployeeCostYearly = formatCurrency(totalEmployeeCostYearlyVal);

  const avgEmpCostMonthlyVal = calcAvgEmployeeCostMonthly(totalEmployeeCostMonthly, totalMwEnrollees);
  results.calcAvgEmployeeCostMonthly = formatCurrency(avgEmpCostMonthlyVal);
  results.calcAvgEmployeeCostYearly = formatCurrency(calcAvgEmployeeCostYearly(avgEmpCostMonthlyVal));

  // ===================================================================
  // NET EMPLOYEE COST CHANGE
  // ===================================================================

  const avgCurEmpCostMonthlyVal = calcAvgCurrentEmployeeCostMonthly(curTotalEmployeeCostMonthlyVal, curTotalEnrolled);
  results.calcAvgCurrentEmployeeCostMonthly = formatCurrency(avgCurEmpCostMonthlyVal);

  const avgEmpCostChangeMonthlyVal = calcAvgEmployeeCostChangeMonthly(avgCurEmpCostMonthlyVal, avgEmpCostMonthlyVal);
  results.calcAvgEmployeeCostChangeMonthly = formatCurrency(avgEmpCostChangeMonthlyVal);
  results.calcAvgEmployeeCostChangeYearly = formatCurrency(calcAvgEmployeeCostChangeYearly(avgEmpCostChangeMonthlyVal));
  results.calcEmployeeCostReductionPct_partial = formatSignedPct(
    calcEmployeeCostReductionPctPartial(avgCurEmpCostMonthlyVal, avgEmpCostMonthlyVal)
  );

  // --- Multi-slot pricing-dependent calculations ---
  for (const slotNum of Object.keys(tierPricesBySlot)) {
    if (String(slotNum) === String(primarySlotNum) && Object.keys(tierPricesBySlot).length <= 1) continue;
    const slotPrices = tierPricesBySlot[slotNum];
    const suffix = `_slot_${slotNum}`;

    // Tier costs for this slot
    const slotTierCosts = {};
    for (const tier of TIERS) {
      slotTierCosts[tier] = calcMwTierCost(mwCounts[tier], slotPrices[tier]);
      results[`calcMwTierCost_${tier}${suffix}`] = formatCurrency(slotTierCosts[tier]);
    }

    const slotTotalMonthly = calcMwTotalMonthly(slotTierCosts.EE, slotTierCosts.E1, slotTierCosts.EF, slotTierCosts.EC);
    results[`calcMwTotalMonthly${suffix}`] = formatCurrency(slotTotalMonthly);
    results[`calcMwTotalYearly${suffix}`] = formatCurrency(calcMwTotalYearly(slotTotalMonthly));
    results[`calcUnsharedAmountDisplay${suffix}`] = calcUnsharedAmountDisplay(oopLevel);
    const slotCombinedPremiumMonthly = calcCombinedPremiumMonthly(slotTotalMonthly, remainCounts, curPrices);
    const slotCombinedPremiumYearly = calcCombinedPremiumYearly(slotCombinedPremiumMonthly);
    results[`calcOverallSavingsYearly_partial_beforeContrib${suffix}`] = formatCurrency(
      calcOverallSavingsYearlyPartialBeforeContrib(calcCurrentTotalYearly(curTotalMonthlyVal), slotCombinedPremiumYearly)
    );

    // Employer totals for this slot (full-precision, same as primary)
    const slotContribs = {};
    const slotEmpCosts = {};
    for (const tier of TIERS) {
      slotContribs[tier] = calcEmployerContrib(tier, contribValueTypes, contribValues, slotPrices[tier]);
      slotEmpCosts[tier] = calcEmployeeCost(slotPrices[tier], slotContribs[tier]);
    }
    const slotTotalEmployerMw = calcTotalEmployerMwMonthly(mwCounts, slotPrices, contribValueTypes, contribValues);
    results[`calcTotalEmployerMwMonthly${suffix}`] = formatCurrency(slotTotalEmployerMw);
    results[`calcTotalEmployerMwYearly${suffix}`] = formatCurrency(calcTotalEmployerMwYearly(slotTotalEmployerMw));
    const slotTotalEmployeeCostMonthly = calcTotalEmployeeCostMonthly(slotTotalMonthly, slotTotalEmployerMw);
    results[`calcTotalEmployeeCostMonthly${suffix}`] = formatCurrency(slotTotalEmployeeCostMonthly);

    // Employee-facing per-tier display values for this slot
    for (const tier of TIERS) {
      results[`calcEmployerContribDisplay_${tier}${suffix}`] =
        calcEmployerContribDisplay(slotContribs[tier], slotPrices[tier]);
      results[`calcEmployerSharePct_${tier}${suffix}`] =
        formatPct(calcEmployerSharePct(slotContribs[tier], slotPrices[tier]));
      results[`calcEmployeeSharePct_${tier}${suffix}`] =
        formatPct(calcEmployeeSharePct(slotEmpCosts[tier], slotPrices[tier]));
      results[`calcEmployeeMonthlyCost_${tier}${suffix}`] =
        calcEmployeeMonthlyCost(slotEmpCosts[tier]);
      results[`calcEmployeeAnnualCost_${tier}${suffix}`] =
        formatCurrency(calcEmployeeAnnualCost(slotEmpCosts[tier]));
      results[`calcEmployerAnnualContrib_${tier}${suffix}`] =
        formatCurrency(calcEmployerAnnualContrib(slotContribs[tier]));

      const slotEmpSavingsMonthly = calcEmployeeSavingsMonthly(avgCurrentPerEmp, slotEmpCosts[tier]);
      results[`calcEmployeeSavingsMonthly_${tier}${suffix}`] = formatCurrency(slotEmpSavingsMonthly);
      results[`calcEmployeeSavingsYearly_${tier}${suffix}`] =
        formatCurrency(calcEmployeeSavingsYearly(slotEmpSavingsMonthly));
    }

    // Slot-scoped aggregate employee metrics
    const slotTotalEmployeeCostYearly = calcTotalEmployeeCostYearly(slotTotalEmployeeCostMonthly);
    const slotAvgEmployeeCostMonthly = calcAvgEmployeeCostMonthly(slotTotalEmployeeCostMonthly, totalMwEnrollees);
    results[`calcTotalEmployeeCostYearly${suffix}`] = formatCurrency(slotTotalEmployeeCostYearly);
    results[`calcAvgEmployeeCostMonthly${suffix}`] = formatCurrency(slotAvgEmployeeCostMonthly);
    results[`calcAvgEmployeeCostYearly${suffix}`] = formatCurrency(calcAvgEmployeeCostYearly(slotAvgEmployeeCostMonthly));

    const slotAvgEmployeeCostChangeMonthly = calcAvgEmployeeCostChangeMonthly(avgCurEmpCostMonthlyVal, slotAvgEmployeeCostMonthly);
    results[`calcAvgEmployeeCostChangeMonthly${suffix}`] = formatCurrency(slotAvgEmployeeCostChangeMonthly);
    results[`calcAvgEmployeeCostChangeYearly${suffix}`] =
      formatCurrency(calcAvgEmployeeCostChangeYearly(slotAvgEmployeeCostChangeMonthly));

    // Savings for this slot (generic quote style = MW-only)
    const slotNetMonthly = calcNetCostChangeMonthly(slotTotalEmployerMw, currentMonthlyPremium || 0);
    const slotNetYearly = calcNetCostChangeYearly(slotNetMonthly);
    results[`calcNetCostChangeMonthly${suffix}`] = formatCurrency(slotNetMonthly);
    results[`calcNetCostChangeYearly${suffix}`] = formatCurrency(slotNetYearly);
    results[`calcNetCostChangeMonthly_generic${suffix}`] = formatCurrency(slotNetMonthly);
    results[`calcNetCostChangeYearly_generic${suffix}`] = formatCurrency(slotNetYearly);
    results[`calcSavingsMonthly${suffix}`] = formatCurrency(calcSavingsMonthly(currentMonthlyPremium || 0, slotTotalEmployerMw));
    results[`calcSavingsYearly${suffix}`] = formatCurrency(calcSavingsYearly(calcSavingsMonthly(currentMonthlyPremium || 0, slotTotalEmployerMw)));
    results[`calcSavingsMonthly_generic${suffix}`] = results[`calcSavingsMonthly${suffix}`];
    results[`calcSavingsYearly_generic${suffix}`] = results[`calcSavingsYearly${suffix}`];
    results[`calcHeadlineGenericQuote${suffix}`] = calcHeadlineGenericQuote(hasExistingCoverage, slotNetYearly, calcMwTotalYearly(slotTotalMonthly), slotTotalMonthly);

    // Calc steps for this slot
    for (const tier of TIERS) {
      results[`calcStepTierCost_${tier}${suffix}`] = calcStepTierCost(mwCounts[tier], slotPrices[tier], slotTierCosts[tier]);
    }
    results[`calcStepTotalCost${suffix}`] = calcStepTotalCost(slotTotalMonthly);
  }

  return results;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Formatting helpers
  formatCurrency,
  formatPct,

  // Shared (S1–S26)
  calcTotalMwEnrollees,
  calcMwTierCountDisplay,
  calcCurrentRemainTierCountDisplay,
  calcTierMixPct,
  calcMwEnrollmentPct,
  calcCurrentEnrollmentPct,
  calcNotEnrolledCount,
  calcNotEnrolledCountGeneric,
  calcMwTierPrice,
  calcMwTierCost,
  calcMwTotalMonthly,
  calcMwTotalYearly,
  calcUnsharedAmountDisplay,
  calcEmployerContrib,
  calcEmployeeCost,
  calcTotalEmployerMwMonthly,
  calcTotalEmployerMwYearly,
  calcTotalEmployeeCostMonthly,
  calcCurrentPremiumYearly,
  calcNetCostChangeMonthly,
  calcNetCostChangeYearly,
  calcSavingsMonthly,
  calcSavingsYearly,
  calcEmployerCostReductionPctPartial,
  calcEmployeeCostReductionPctPartial,
  calcNetEnrollmentChangeCount,
  calcNetEnrollmentChangePct,
  calcStepTierAlloc,
  calcStepTierCost,
  calcStepTotalCost,
  calcEnrollmentDatesDisplay,
  calcTotalEmployeesDisplay,
  calcCurrentPremiumMonthly,
  calcNetChangePremiumMonthly,
  calcNetChangePremiumYearly,
  calcOverallSavingsYearlyPartialBeforeContrib,
  calcCurrentRemainCountDisplay,
  calcCurrentlyEnrolledDisplay,

  // Partial Switch (P2–P13)
  calcAvgCurrentPerEmployee,
  calcCurrentRemainMonthly,
  calcCurrentRemainYearly,
  calcTotalProjectedEnrolled,
  calcProjectedEnrollmentPct,
  calcMixedEmployerMonthly,
  calcMixedEmployerYearly,
  calcBlendedEmployerMonthly,
  calcBlendedEmployerYearly,
  calcCombinedPremiumMonthly,
  calcCombinedPremiumYearly,
  calcCombinedEmployerMonthly,
  calcCombinedEmployerYearly,
  calcHeadlinePartialSwitch,
  calcPartMixMwCount,
  calcPartMixRemainCount,
  calcPartMixNotEnrolled,
  calcNetBusinessImpact,

  // Generic Quote (G3, G8)
  calcHeadlineGenericQuote,
  calcStepEnrollment,

  // Employee Proposal (E1–E8)
  calcEmployerContribDisplay,
  calcEmployerSharePct,
  calcEmployeeSharePct,
  calcEmployeeMonthlyCost,
  calcEmployeeAnnualCost,
  calcEmployerAnnualContrib,
  calcEmployeeSavingsMonthly,
  calcEmployeeSavingsYearly,

  // Current Plan Details
  calcCurrentTotalEnrolled,
  calcCurrentTierCost,
  calcCurrentTotalMonthly,
  calcCurrentTotalYearly,
  calcCurrentNotEnrolledCount,
  calcCurrentTierMixPct,
  calcCurrentEmployerContrib,
  calcCurrentEmployeeCostTier,
  calcCurrentTotalEmployerMonthly,
  calcCurrentTotalEmployeeCostMonthly: calcCurrentTotalEmployeeCostMonthlyFn,
  calcCurrentRemainEnrollmentPct,

  // MW Employee Aggregates
  calcTotalEmployeeCostYearly,
  calcAvgEmployeeCostMonthly,
  calcAvgEmployeeCostYearly,

  // Net Employee Cost Change
  calcAvgCurrentEmployeeCostMonthly,
  calcAvgEmployeeCostChangeMonthly,
  calcAvgEmployeeCostChangeYearly,
  calcEmployerContribStrategyText,

  // Master orchestrator
  computeAllCalculations,

  // Fee helpers (reused by proposalGenerator.service.js)
  round2,
  loadProposalFeeContext,
  applyQuoteFeesToParts,

  // Constants
  TIERS,
  TIER_TO_DB
};
