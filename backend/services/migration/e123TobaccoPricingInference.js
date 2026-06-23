'use strict';

function requiresTobaccoFromTiers(tiers = []) {
  return shouldUseTobaccoPricing(tiers, null);
}

function shouldUseTobaccoPricing(migrationTiers = [], rateGrid = null) {
  for (const tier of migrationTiers) {
    if (tier.needsDualTobaccoMapping) return true;
    const stats = tier.feeAmountStats;
    // E123 encodes tobacco as a higher premium on the same benefit, not a separate tier.
    if (stats && stats.sampleSize >= 3 && (stats.max - stats.min) >= 5) {
      return true;
    }
  }

  let yesMembers = 0;
  let noMembers = 0;
  for (const tier of migrationTiers) {
    yesMembers += tier.tobaccoCounts?.yes || 0;
    noMembers += tier.tobaccoCounts?.no || 0;
  }
  if (yesMembers > 0 && noMembers > 0) return true;

  for (const row of rateGrid?.rows || []) {
    if (row.nonTobaccoRate != null && row.tobaccoRate != null
      && Math.abs(row.nonTobaccoRate - row.tobaccoRate) >= 0.01) {
      return true;
    }
  }
  return false;
}

function inferE123TobaccoPricingRecommendation(migrationTiers = [], rateGrid = null) {
  const reasonsFor = [];
  const reasonsAgainst = [];
  let rateGridTobaccoPairs = 0;
  let maxTobaccoSurcharge = 0;

  for (const row of rateGrid?.rows || []) {
    if (row.nonTobaccoRate == null || row.tobaccoRate == null) continue;
    const diff = Math.round(Math.abs(row.nonTobaccoRate - row.tobaccoRate) * 100) / 100;
    if (diff < 0.01) continue;
    rateGridTobaccoPairs += 1;
    maxTobaccoSurcharge = Math.max(maxTobaccoSurcharge, diff);
    const label = row.benefitLabel || (row.benefitId ? `benefit ${row.benefitId}` : 'benefit');
    reasonsFor.push(
      `E123 GetRates: ${label} is $${Number(row.nonTobaccoRate).toFixed(2)} non-tobacco vs $${Number(row.tobaccoRate).toFixed(2)} tobacco (+$${diff.toFixed(2)}).`
    );
  }
  if ((rateGrid?.rows || []).length > 0 && rateGridTobaccoPairs === 0) {
    reasonsAgainst.push('E123 GetRates returns the same premium for smokers and non-smokers on all benefits.');
  }

  let yesMembers = 0;
  let noMembers = 0;
  let dualMappingTiers = 0;
  for (const tier of migrationTiers) {
    yesMembers += tier.tobaccoCounts?.yes || 0;
    noMembers += tier.tobaccoCounts?.no || 0;
    if (tier.needsDualTobaccoMapping) dualMappingTiers += 1;
    const stats = tier.feeAmountStats;
    if (stats && stats.sampleSize >= 3 && (stats.max - stats.min) >= 5) {
      const label = tier.sourceBenefitLabel || tier.resolvedTier || tier.sourceBenefitKey || 'tier';
      reasonsFor.push(
        `Imported members on ${label} pay $${stats.min.toFixed(2)}–$${stats.max.toFixed(2)}/mo (likely tobacco surcharge).`
      );
    }
  }
  if (dualMappingTiers > 0) {
    reasonsFor.push(
      `${dualMappingTiers} benefit tier(s) need separate tobacco and non-tobacco AB365 pricing rows.`
    );
  }
  if (yesMembers > 0 && noMembers > 0) {
    reasonsFor.push(
      `This batch includes ${yesMembers} tobacco and ${noMembers} non-tobacco member(s) on this product.`
    );
  } else if (yesMembers === 0 && noMembers > 0 && rateGridTobaccoPairs === 0) {
    reasonsAgainst.push('Imported members are all non-tobacco and E123 rates do not show a tobacco surcharge.');
  }

  const recommended = shouldUseTobaccoPricing(migrationTiers, rateGrid);
  let confidence = 'low';
  if (rateGridTobaccoPairs > 0) confidence = 'high';
  else if (dualMappingTiers > 0 || (yesMembers > 0 && noMembers > 0)) confidence = 'medium';
  else if (reasonsFor.some((reason) => reason.includes('pay $'))) confidence = 'medium';
  else if ((rateGrid?.rows || []).length > 0 && rateGridTobaccoPairs === 0) confidence = 'medium';

  const uniqueReasonsFor = [...new Set(reasonsFor)];
  const uniqueReasonsAgainst = [...new Set(reasonsAgainst)];
  const summary = recommended
    ? (uniqueReasonsFor[0] || 'E123 data suggests separate tobacco pricing tiers.')
    : (uniqueReasonsAgainst[0] || 'E123 data does not indicate a separate tobacco surcharge for this product.');

  return {
    recommended,
    confidence,
    summary,
    reasonsFor: uniqueReasonsFor,
    reasonsAgainst: uniqueReasonsAgainst,
    rateGridTobaccoPairs,
    maxTobaccoSurcharge: maxTobaccoSurcharge > 0 ? maxTobaccoSurcharge : null
  };
}

module.exports = {
  requiresTobaccoFromTiers,
  shouldUseTobaccoPricing,
  inferE123TobaccoPricingRecommendation
};
