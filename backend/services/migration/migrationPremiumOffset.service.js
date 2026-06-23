'use strict';

const { resolveHouseholdProductPremium } = require('./e123TierInference');

const MAX_PROCESSING_FEE_INCREASE = 15;
const EPS = 0.01;

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function computeE123PremiumForEnrollmentItems(enrollmentItems = []) {
  let total = 0;
  let hasAny = false;
  for (const item of enrollmentItems) {
    const amt = resolveHouseholdProductPremium(item.product);
    if (amt == null) continue;
    hasAny = true;
    total += Number(amt);
  }
  return hasAny ? roundMoney(total) : null;
}

function computeProjectedHouseholdTotal(productLines = [], precomputedFees = {}) {
  let total = 0;
  for (const line of productLines) {
    total += Number(line.basePremium || 0);
    total += Number(line.includedPaymentProcessingFeeAmount || line.includedProcessingFeeAmount || 0);
  }
  total += Number(precomputedFees.expectedSystemFeeAmount || 0);
  total += Number(precomputedFees.expectedPaymentProcessingFeeRemainder || 0);
  return roundMoney(total);
}

function resolveFeeOffsetLever(precomputedFees, productLines = []) {
  const ppf = roundMoney(precomputedFees?.expectedPaymentProcessingFeeRemainder);
  if (ppf > EPS) {
    return { type: 'ppf', currentAmount: ppf };
  }

  let bestIdx = -1;
  let bestIncluded = 0;
  for (let i = 0; i < productLines.length; i += 1) {
    const included = roundMoney(productLines[i].includedPaymentProcessingFeeAmount);
    if (included > bestIncluded) {
      bestIncluded = included;
      bestIdx = i;
    }
  }
  if (bestIdx >= 0 && bestIncluded > EPS) {
    return { type: 'included', currentAmount: bestIncluded, productLineIndex: bestIdx };
  }
  return null;
}

function computePremiumProcessingFeeOffset({
  enabled = false,
  e123Total,
  projectedTotal,
  feeLever
}) {
  const base = {
    applied: 0,
    lever: feeLever?.type || null,
    currentAmount: feeLever?.currentAmount ?? null,
    newAmount: feeLever?.currentAmount ?? null,
    productLineIndex: feeLever?.productLineIndex ?? null,
    e123Total,
    projectedTotal,
    projectedTotalAdjusted: projectedTotal,
    reason: null
  };

  if (!enabled) {
    return { ...base, reason: 'disabled' };
  }
  if (e123Total == null || projectedTotal == null || !feeLever) {
    return { ...base, reason: 'incomplete' };
  }

  const gap = roundMoney(e123Total - projectedTotal);
  if (Math.abs(gap) < EPS) {
    return { ...base, reason: 'already_match' };
  }

  const current = roundMoney(feeLever.currentAmount);
  if (gap > EPS) {
    if (gap > MAX_PROCESSING_FEE_INCREASE + EPS) {
      return { ...base, reason: 'exceeds_max_increase' };
    }
    return {
      ...base,
      applied: gap,
      currentAmount: current,
      newAmount: roundMoney(current + gap),
      projectedTotalAdjusted: e123Total,
      reason: 'applied'
    };
  }

  const decrease = Math.abs(gap);
  if (decrease > current + EPS) {
    return { ...base, reason: 'exceeds_available_decrease' };
  }
  return {
    ...base,
    applied: gap,
    currentAmount: current,
    newAmount: roundMoney(current - decrease),
    projectedTotalAdjusted: e123Total,
    reason: 'applied'
  };
}

function syncPrecomputedProcessingFeeTotals(precomputedFees, productLines = []) {
  let includedTotal = 0;
  for (const line of productLines) {
    includedTotal += roundMoney(line.includedPaymentProcessingFeeAmount);
  }
  const ppf = roundMoney(precomputedFees.expectedPaymentProcessingFeeRemainder);
  precomputedFees.expectedIncludedProcessingFeeTotal = roundMoney(includedTotal);
  precomputedFees.expectedProcessingFeeTotal = roundMoney(includedTotal + ppf);
  precomputedFees.expectedPaymentProcessingFeeAmount = precomputedFees.expectedProcessingFeeTotal;
}

function applyPremiumOffsetToPlan(enrollmentPlan, precomputedFees, offset) {
  if (!offset?.applied || Math.abs(offset.applied) < EPS) return;

  if (offset.lever === 'ppf') {
    precomputedFees.expectedPaymentProcessingFeeRemainder = offset.newAmount;
    syncPrecomputedProcessingFeeTotals(precomputedFees, enrollmentPlan.productLines);
    return;
  }

  if (offset.lever === 'included' && offset.productLineIndex != null) {
    const idx = offset.productLineIndex;
    enrollmentPlan.productLines[idx].includedPaymentProcessingFeeAmount = offset.newAmount;
    if (enrollmentPlan.enrollmentItems[idx]?.amounts) {
      enrollmentPlan.enrollmentItems[idx].amounts.includedPaymentProcessingFeeAmount = offset.newAmount;
    }
    syncPrecomputedProcessingFeeTotals(precomputedFees, enrollmentPlan.productLines);
  }
}

function applyPremiumOffsetIfEnabled({
  enabled,
  household,
  enrollmentPlan,
  precomputedFees
}) {
  const e123Total = computeE123PremiumForEnrollmentItems(enrollmentPlan.enrollmentItems);
  const projectedTotal = computeProjectedHouseholdTotal(enrollmentPlan.productLines, precomputedFees);
  const feeLever = resolveFeeOffsetLever(precomputedFees, enrollmentPlan.productLines);
  const offset = computePremiumProcessingFeeOffset({
    enabled,
    e123Total,
    projectedTotal,
    feeLever
  });

  if (offset.applied) {
    applyPremiumOffsetToPlan(enrollmentPlan, precomputedFees, offset);
  }

  return offset;
}

module.exports = {
  MAX_PROCESSING_FEE_INCREASE,
  computeE123PremiumForEnrollmentItems,
  computeProjectedHouseholdTotal,
  resolveFeeOffsetLever,
  computePremiumProcessingFeeOffset,
  applyPremiumOffsetToPlan,
  applyPremiumOffsetIfEnabled
};
