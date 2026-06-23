'use strict';

const TierCalculator = require('../pricing/TierCalculator');
const {
  resolveCatalogPremiumForPricingRow,
  catalogPremiumStats,
  formatCatalogPremiumHint
} = require('./e123CatalogPricing');

const TIER_CODES = ['EE', 'ES', 'EC', 'EF'];

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function parseNumeric(value) {
  if (value == null || value === '') return null;
  const cleaned = String(value).replace(/[$,\s]/g, '');
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function parseTierToken(value) {
  const match = String(value || '').match(/\b(EE|ES|EC|EF|FA)\b/i);
  if (!match) return null;
  const token = match[1].toUpperCase();
  return token === 'FA' ? 'EF' : token;
}

function parseTierFromLabel(label) {
  const token = parseTierToken(label);
  if (token) return token;

  const normalized = normalizeName(label);
  if (!normalized) return null;

  const synonyms = [
    ['member only', 'EE'],
    ['member spouse', 'ES'],
    ['member child', 'EC'],
    ['member children', 'EC'],
    ['member family', 'EF'],
    ['employee only', 'EE'],
    ['employee spouse', 'ES'],
    ['employee and spouse', 'ES'],
    ['employee children', 'EC'],
    ['employee child', 'EC'],
    ['employee family', 'EF'],
    ['single', 'EE'],
    ['individual', 'EE'],
    ['spouse only', 'ES'],
    ['child only', 'EC'],
    ['children only', 'EC'],
    ['family', 'EF']
  ];

  for (const [phrase, tier] of synonyms) {
    if (normalized.includes(phrase)) return tier;
  }
  return null;
}

function parseE123TobaccoUse(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim().toLowerCase();
  if (['y', 'yes', '1', 'true', 't'].includes(raw)) return 'Yes';
  if (['n', 'no', '0', 'false', 'f'].includes(raw)) return 'No';
  return null;
}

function extractTobaccoFromE123Record(record = {}) {
  const candidates = [
    record.tobacco,
    record.TOBACCO,
    record.bsmoker,
    record.BSMOKER,
    record.btobacco,
    record.smoker,
    record.SMOKER
  ];
  for (const value of candidates) {
    const parsed = parseE123TobaccoUse(value);
    if (parsed) return parsed;
  }
  return null;
}

function normalizePricingTobaccoStatus(value) {
  if (value == null || value === '') return 'No';
  const raw = String(value).trim();
  if (raw === 'Yes' || raw === 'Y') return 'Yes';
  if (raw === 'No' || raw === 'N' || raw === 'N/A') return 'No';
  return parseE123TobaccoUse(raw) || 'No';
}

function formatPricingTobaccoLabel(tobaccoStatus) {
  const normalized = normalizePricingTobaccoStatus(tobaccoStatus);
  if (normalized === 'Yes') return 'Tobacco: Yes';
  return null;
}

function emptyTobaccoCounts() {
  return { yes: 0, no: 0, unknown: 0 };
}

function addTobaccoCount(counts, tobaccoUse) {
  const next = { ...counts };
  if (tobaccoUse === 'Yes') next.yes += 1;
  else if (tobaccoUse === 'No') next.no += 1;
  else next.unknown += 1;
  return next;
}

function computeTobaccoInference(tobaccoCounts = {}) {
  const yes = tobaccoCounts.yes || 0;
  const no = tobaccoCounts.no || 0;
  const unknown = tobaccoCounts.unknown || 0;
  const known = yes + no;
  const total = known + unknown;

  if (!known) {
    return {
      tobaccoCounts: { yes, no, unknown },
      inferredTobaccoUse: null,
      tobaccoConfidence: 0,
      tobaccoBreakdownLabel: unknown ? `${unknown} unknown` : null
    };
  }

  const inferredTobaccoUse = yes >= no ? 'Yes' : 'No';
  const dominant = Math.max(yes, no);
  const tobaccoConfidence = dominant / known;
  const parts = [];
  if (yes) parts.push(`tobacco ${yes}`);
  if (no) parts.push(`non-tobacco ${no}`);
  if (unknown) parts.push(`unknown ${unknown}`);

  return {
    tobaccoCounts: { yes, no, unknown },
    inferredTobaccoUse,
    tobaccoConfidence,
    tobaccoBreakdownLabel: parts.join(', ')
  };
}

function parseUnsharedFromLabel(label) {
  const text = String(label || '');
  const uaMatch = text.match(/\b(?:UA|UNSHARED)\s*[:#]?\s*(\d[\d,]*)\b/i);
  if (uaMatch) return parseNumeric(uaMatch[1]);
  const loneAmount = text.match(/\b(\d{3,5})\b/);
  if (loneAmount && /ua|unshared|deduct/i.test(text)) return parseNumeric(loneAmount[1]);
  return null;
}

function extractFeeMetadata(fee = {}) {
  const benefitLabel = fee.label
    || fee.description
    || fee.name
    || fee.benefitlabel
    || fee.benefitname
    || null;
  const periodLabel = fee.periodlabel || fee.periodname || null;
  const amount = parseNumeric(
    fee.amount ?? fee.rate ?? fee.price ?? fee.premium ?? fee.fee ?? fee.total
  );
  const commissionableAmount = parseNumeric(fee.commissionableamount ?? fee.commissionableAmount);
  const unsharedAmount = parseNumeric(
    fee.unsharedamount ?? fee.unshared ?? fee.ua ?? fee.configvalue ?? fee.configvalue1
  ) ?? parseUnsharedFromLabel(benefitLabel);

  return {
    benefitLabel,
    periodLabel,
    amount,
    commissionableAmount,
    unsharedAmount,
    feeType: fee.type || fee.feetype || null,
    tierFromLabel: parseTierFromLabel(benefitLabel)
  };
}

function computeAmountStats(amounts = []) {
  const valid = amounts.filter((value) => Number.isFinite(value) && value >= 0);
  if (!valid.length) return null;
  const sorted = [...valid].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median,
    average: sum / sorted.length,
    sampleSize: sorted.length
  };
}

function emptyTierCounts() {
  return { EE: 0, ES: 0, EC: 0, EF: 0 };
}

function addMemberTierCount(counts, tier) {
  const code = TIER_CODES.includes(tier) ? tier : null;
  if (!code) return counts;
  return { ...counts, [code]: (counts[code] || 0) + 1 };
}

function computeTierInference(memberTierCounts = {}) {
  const total = TIER_CODES.reduce((sum, code) => sum + (memberTierCounts[code] || 0), 0);
  if (!total) {
    return {
      memberTierCounts,
      inferredMemberTier: null,
      tierConfidence: 0,
      tierBreakdownLabel: null
    };
  }

  let bestTier = null;
  let bestCount = 0;
  for (const code of TIER_CODES) {
    const count = memberTierCounts[code] || 0;
    if (count > bestCount) {
      bestCount = count;
      bestTier = code;
    }
  }

  const confidence = bestCount / total;
  const parts = TIER_CODES
    .filter((code) => (memberTierCounts[code] || 0) > 0)
    .map((code) => `${code} ${memberTierCounts[code]}`);

  return {
    memberTierCounts,
    inferredMemberTier: confidence >= 0.8 || bestCount === total ? bestTier : null,
    tierConfidence: confidence,
    tierBreakdownLabel: parts.join(', ')
  };
}

function computeAgeStats(ages = []) {
  const valid = ages.filter((age) => Number.isFinite(age) && age >= 0);
  if (!valid.length) return null;
  const sorted = [...valid].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median: sorted.length % 2 === 0
      ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
      : sorted[mid],
    sampleSize: sorted.length
  };
}

function safeMemberAge(dateOfBirth) {
  if (!dateOfBirth) return null;
  try {
    return TierCalculator.calculateAge(dateOfBirth);
  } catch {
    return null;
  }
}

function tierDisplayLabel(tier) {
  switch (tier) {
    case 'EE': return 'Employee Only (EE)';
    case 'ES': return 'Employee + Spouse (ES)';
    case 'EC': return 'Employee + Children (EC)';
    case 'EF': return 'Employee + Family (EF)';
    default: return tier;
  }
}

function buildTierContext({
  sourceBenefitKey,
  sourceBenefitLabel,
  memberTierCounts,
  inferredMemberTier,
  tierConfidence,
  tierBreakdownLabel,
  memberAgeRange,
  feeHints,
  feeAmountStats,
  catalogPricingRows,
  catalogTier,
  catalogBenefitName,
  catalogUnsharedAmount,
  tobaccoCounts,
  inferredTobaccoUse,
  tobaccoConfidence,
  tobaccoBreakdownLabel
}) {
  const labelTier = feeHints?.tierFromLabel || parseTierFromLabel(sourceBenefitLabel);
  const resolvedTier = catalogTier || inferredMemberTier || labelTier || null;
  const catalogStats = catalogPremiumStats(catalogPricingRows, sourceBenefitKey);

  const hints = [];
  if (catalogTier) {
    hints.push(`ShareWELL catalog: ${tierDisplayLabel(catalogTier)}`);
  } else if (inferredMemberTier) {
    hints.push(`Member households: ${tierDisplayLabel(inferredMemberTier)} (${Math.round((tierConfidence || 0) * 100)}% match)`);
  } else if (tierBreakdownLabel) {
    hints.push(`Member mix: ${tierBreakdownLabel}`);
  }
  if (labelTier && labelTier !== resolvedTier) {
    hints.push(`Benefit label suggests ${tierDisplayLabel(labelTier)}`);
  }
  if (catalogBenefitName && catalogBenefitName !== sourceBenefitLabel) {
    hints.push(`Catalog name: ${catalogBenefitName}`);
  }
  const ua = catalogUnsharedAmount ?? feeHints?.unsharedAmount;
  if (ua != null) hints.push(`Unshared amount ${ua}`);
  const catalogHint = formatCatalogPremiumHint(catalogStats);
  if (catalogHint) {
    hints.push(catalogHint);
  } else if (feeAmountStats?.median != null) {
    hints.push(`Member premium $${feeAmountStats.median.toFixed(2)}/mo (${feeAmountStats.sampleSize} member${feeAmountStats.sampleSize === 1 ? '' : 's'})`);
  } else if (feeHints?.amount != null) {
    hints.push(`Member premium $${Number(feeHints.amount).toFixed(2)}/mo`);
  }
  if (memberAgeRange) {
    hints.push(`Member ages ${memberAgeRange.min}-${memberAgeRange.max}`);
  }
  if (feeHints?.periodLabel && feeHints.periodLabel !== sourceBenefitLabel) {
    hints.push(`Billing period: ${feeHints.periodLabel}`);
  }
  if (tobaccoBreakdownLabel) {
    hints.push(`Tobacco mix: ${tobaccoBreakdownLabel}`);
  } else if (inferredTobaccoUse) {
    hints.push(`Tobacco ${inferredTobaccoUse} (${Math.round((tobaccoConfidence || 0) * 100)}% of known)`);
  }

  return {
    sourceBenefitKey,
    sourceBenefitLabel,
    memberTierCounts,
    inferredMemberTier,
    tierConfidence,
    tierBreakdownLabel,
    memberAgeRange,
    feeHints,
    feeAmountStats,
    catalogPricingRows: catalogPricingRows || [],
    catalogTier,
    catalogBenefitName,
    catalogUnsharedAmount,
    tobaccoCounts,
    inferredTobaccoUse,
    tobaccoConfidence,
    tobaccoBreakdownLabel,
    resolvedTier,
    displayHint: hints.join(' · ') || null
  };
}

function pricingRowAmount(pricingRow) {
  if (pricingRow?.msrpRate != null && pricingRow.msrpRate > 0) {
    return Number(pricingRow.msrpRate);
  }
  if (pricingRow?.totalRate != null && pricingRow.totalRate > 0) {
    return Number(pricingRow.totalRate);
  }
  const net = parseNumeric(pricingRow.netRate) || 0;
  const override = parseNumeric(pricingRow.overrideRate) || 0;
  const commission = parseNumeric(pricingRow.commission ?? pricingRow.vendorCommission) || 0;
  const systemFees = parseNumeric(pricingRow.systemFees) || 0;
  const total = net + override + commission + systemFees;
  return total > 0 ? total : null;
}

function pricingRowComponentSum(pricingRow) {
  const net = parseNumeric(pricingRow?.netRate) || 0;
  const override = parseNumeric(pricingRow?.overrideRate) || 0;
  const commission = parseNumeric(pricingRow?.commission ?? pricingRow?.vendorCommission) || 0;
  const systemFees = parseNumeric(pricingRow?.systemFees) || 0;
  const total = net + override + commission + systemFees;
  return total > 0 ? total : null;
}

/**
 * MSRPRate may be member retail (components + included fee) or legacy base-only.
 * Returns member-facing retail total plus catalog base/included split for enrollment writes.
 */
function resolvePricingRowRetailAndBase(pricingRow) {
  const includeFee = pricingRow?.includeProcessingFee === true;
  const storedIncluded =
    pricingRow?.includedProcessingFee != null ? Number(pricingRow.includedProcessingFee) : 0;
  const msrp =
    pricingRow?.msrpRate != null && Number(pricingRow.msrpRate) > 0
      ? Number(pricingRow.msrpRate)
      : null;
  const componentSum = pricingRowComponentSum(pricingRow);
  const amountFromFields = pricingRowAmount(pricingRow);

  if (!includeFee || storedIncluded <= 0) {
    const retail = amountFromFields;
    return {
      retailAmount: retail,
      baseAmount: retail,
      includedProcessingFee: 0
    };
  }

  if (msrp != null && componentSum != null) {
    const retailTotal = Math.round((componentSum + storedIncluded) * 100) / 100;
    if (Math.abs(msrp - retailTotal) <= 0.02) {
      return {
        retailAmount: msrp,
        baseAmount: componentSum,
        includedProcessingFee: storedIncluded
      };
    }
    if (Math.abs(msrp - componentSum) <= 0.02) {
      return {
        retailAmount: retailTotal,
        baseAmount: msrp,
        includedProcessingFee: storedIncluded
      };
    }
    const inferredBase = Math.max(0, Math.round((msrp - storedIncluded) * 100) / 100);
    return {
      retailAmount: msrp,
      baseAmount: inferredBase,
      includedProcessingFee: storedIncluded
    };
  }

  if (amountFromFields == null) {
    return { retailAmount: null, baseAmount: null, includedProcessingFee: 0 };
  }

  const retailAmount = Math.round((amountFromFields + storedIncluded) * 100) / 100;
  return {
    retailAmount,
    baseAmount: amountFromFields,
    includedProcessingFee: storedIncluded
  };
}

function pricingRowDisplayAmount(pricingRow) {
  const { retailAmount } = resolvePricingRowRetailAndBase(pricingRow);
  return retailAmount;
}

function getResolvedTierCode(tierContext) {
  return tierContext.resolvedTier
    || tierContext.catalogTier
    || tierContext.inferredMemberTier
    || tierContext.feeHints?.tierFromLabel
    || parseTierFromLabel(tierContext.sourceBenefitLabel)
    || null;
}

function getTargetUnsharedAmount(tierContext) {
  const ua = tierContext.catalogUnsharedAmount ?? tierContext.feeHints?.unsharedAmount;
  return ua != null ? String(ua) : null;
}

function filterPricingRowsForTier(tierContext, pricingRows = []) {
  const targetTier = getResolvedTierCode(tierContext);
  if (!targetTier) return pricingRows;
  const tierMatches = pricingRows.filter(
    (row) => String(row.tierType || '').toUpperCase() === targetTier
  );
  return tierMatches.length ? tierMatches : pricingRows;
}

function filterPricingRowsForUa(tierContext, pricingRows = []) {
  const ua = getTargetUnsharedAmount(tierContext);
  if (!ua) return pricingRows;
  const uaMatches = pricingRows.filter((row) => String(row.configValue1 || '') === ua);
  return uaMatches.length ? uaMatches : pricingRows;
}

function buildPricingMatchSearchSets(tierContext, pricingRows = []) {
  const tierRows = filterPricingRowsForTier(tierContext, pricingRows);
  const tierUaRows = filterPricingRowsForUa(tierContext, tierRows);
  const allUaRows = filterPricingRowsForUa(tierContext, pricingRows);
  const sets = [];
  const seen = new Set();
  for (const rows of [tierUaRows, tierRows, allUaRows, pricingRows]) {
    const key = rows.map((row) => row.productPricingId).join('|');
    if (!rows.length || seen.has(key)) continue;
    seen.add(key);
    sets.push(rows);
  }
  return sets;
}

function scoreAmountMatch(sourceAmount, pricingRow, tierContext) {
  const source = tierContext && pricingRow
    ? resolveE123PremiumForPricingRow(tierContext, pricingRow)
    : sourceAmount;
  if (source == null) return { score: 0, reasons: [] };
  const target = pricingRowDisplayAmount(pricingRow);
  if (target == null) return { score: 0, reasons: [] };

  const diff = Math.abs(source - target);
  const basis = Math.max(source, target, 1);
  const pctDiff = diff / basis;

  if (diff < 0.01) {
    return { score: 95, reasons: [`$${source.toFixed(2)}`] };
  }
  if (pctDiff <= 0.02) {
    return { score: 88, reasons: [`$${source.toFixed(2)} ≈ $${target.toFixed(2)}`] };
  }
  if (pctDiff <= 0.05) {
    return { score: 72, reasons: [`~$${source.toFixed(2)} vs $${target.toFixed(2)}`] };
  }
  if (pctDiff <= 0.1) {
    return { score: 45, reasons: [`Amount near $${target.toFixed(2)}`] };
  }
  return { score: 0, reasons: [] };
}

function getSourcePremiumAmount(tierContext) {
  const catalogStats = catalogPremiumStats(
    tierContext.catalogPricingRows,
    tierContext.sourceBenefitKey
  );
  if (catalogStats) {
    if (catalogStats.rows.length === 1) return catalogStats.rows[0].amount;
    return catalogStats.median;
  }
  return tierContext.feeAmountStats?.median
    ?? tierContext.feeAmountStats?.average
    ?? tierContext.feeHints?.amount
    ?? null;
}

function resolveE123PremiumForPricingRow(tierContext, pricingRow) {
  const catalogAmount = resolveCatalogPremiumForPricingRow(
    tierContext.catalogPricingRows,
    tierContext.sourceBenefitKey,
    pricingRow
  );
  if (catalogAmount != null) return catalogAmount;
  return getSourcePremiumAmount(tierContext);
}

function isExactAmountMatch(sourceAmount, pricingRow, tierContext) {
  const source = tierContext && pricingRow
    ? resolveE123PremiumForPricingRow(tierContext, pricingRow)
    : sourceAmount;
  if (source == null) return false;
  const target = pricingRowDisplayAmount(pricingRow);
  if (target == null) return false;
  return Math.abs(source - target) < 0.01;
}

function scorePricingMatchSecondary(tierContext, pricingRow) {
  let score = 0;
  const reasons = [];

  const targetTier = tierContext.resolvedTier
    || tierContext.catalogTier
    || tierContext.inferredMemberTier
    || tierContext.feeHints?.tierFromLabel
    || parseTierFromLabel(tierContext.sourceBenefitLabel);

  if (targetTier && String(pricingRow.tierType || '').toUpperCase() === targetTier) {
    score += 100;
    reasons.push(`Tier ${targetTier}`);
  }

  const targetTobacco = tierContext.inferredTobaccoUse;
  const rowTobacco = normalizePricingTobaccoStatus(pricingRow.tobaccoStatus);
  if (targetTobacco && (tierContext.tobaccoConfidence || 0) >= 0.5) {
    if (targetTobacco === rowTobacco) {
      score += 90;
      reasons.push(rowTobacco === 'Yes' ? 'Tobacco surcharge' : 'Non-tobacco rate');
    } else {
      score -= 150;
    }
  }

  const ua = tierContext.catalogUnsharedAmount ?? tierContext.feeHints?.unsharedAmount;
  if (ua != null && String(pricingRow.configValue1 || '') === String(ua)) {
    score += 90;
    reasons.push(`UA ${ua}`);
  } else if (ua != null && pricingRow.configValue1) {
    const config = normalizeName(pricingRow.configValue1);
    const uaText = String(ua);
    if (config === normalizeName(uaText) || config.includes(uaText)) {
      score += 65;
      reasons.push(`UA ~${ua}`);
    }
  }

  if (tierContext.memberAgeRange && pricingRow.minAge != null && pricingRow.maxAge != null) {
    const { min, max } = tierContext.memberAgeRange;
    if (min >= pricingRow.minAge && max <= pricingRow.maxAge) {
      score += 55;
      reasons.push(`Ages ${min}-${max}`);
    } else if (min <= pricingRow.maxAge && max >= pricingRow.minAge) {
      score += 25;
      reasons.push('Age overlap');
    }
  }

  const benefitKey = tierContext.sourceBenefitKey != null ? String(tierContext.sourceBenefitKey) : '';
  if (benefitKey) {
    if (String(pricingRow.configValue1 || '') === benefitKey) {
      score += 80;
      reasons.push(`Benefit ${benefitKey}`);
    }
    if (String(pricingRow.productPricingId || '').toLowerCase() === benefitKey.toLowerCase()) {
      score += 75;
      reasons.push(`Pricing id ${benefitKey}`);
    }
  }

  const benefitLabel = normalizeName(tierContext.sourceBenefitLabel);
  if (benefitLabel) {
    const label = normalizeName(pricingRow.label);
    if (label && (label === benefitLabel || label.includes(benefitLabel) || benefitLabel.includes(label))) {
      score += 40;
      reasons.push('Label match');
    }
  }

  const catalogName = normalizeName(tierContext.catalogBenefitName);
  if (catalogName) {
    const label = normalizeName(pricingRow.label);
    if (label && (label === catalogName || label.includes(catalogName) || catalogName.includes(label))) {
      score += 45;
      reasons.push('Catalog label match');
    }
  }

  return { score, reasons };
}

function scorePricingMatch(tierContext, pricingRow) {
  const secondary = scorePricingMatchSecondary(tierContext, pricingRow);
  const sourceAmount = getSourcePremiumAmount(tierContext);
  const amountMatch = scoreAmountMatch(sourceAmount, pricingRow, tierContext);
  return {
    score: secondary.score + amountMatch.score,
    reasons: [...secondary.reasons, ...amountMatch.reasons]
  };
}

function pickBestExactAmountMatch(tierContext, exactMatches, sourceAmount) {
  if (!exactMatches.length) return null;

  let candidates = exactMatches;
  const uaMatches = filterPricingRowsForUa(tierContext, exactMatches);
  if (uaMatches.length) candidates = uaMatches;

  const tierMatches = filterPricingRowsForTier(tierContext, candidates);
  if (tierMatches.length && tierMatches.length < candidates.length) {
    candidates = tierMatches;
  } else if (getResolvedTierCode(tierContext)) {
    const strictTierMatches = candidates.filter(
      (row) => String(row.tierType || '').toUpperCase() === getResolvedTierCode(tierContext)
    );
    if (strictTierMatches.length) candidates = strictTierMatches;
  }

  const amountReason = `$${Number(sourceAmount).toFixed(2)} exact`;
  if (candidates.length === 1) {
    const row = candidates[0];
    const secondary = scorePricingMatchSecondary(tierContext, row);
    return {
      productPricingId: row.productPricingId,
      suggestReason: [amountReason, ...secondary.reasons].filter(Boolean).join(' · ')
    };
  }

  let best = null;
  let bestScore = -Infinity;
  let bestReasons = [];
  for (const row of candidates) {
    const secondary = scorePricingMatchSecondary(tierContext, row);
    if (secondary.score > bestScore) {
      bestScore = secondary.score;
      best = row;
      bestReasons = secondary.reasons;
    }
  }

  return {
    productPricingId: best.productPricingId,
    suggestReason: [amountReason, ...bestReasons].filter(Boolean).join(' · ')
  };
}

function pickBestCompositeMatch(tierContext, pricingRows) {
  let best = null;
  let bestScore = 0;
  let bestReasons = [];
  for (const row of pricingRows) {
    const { score, reasons } = scorePricingMatch(tierContext, row);
    if (score > bestScore) {
      bestScore = score;
      best = row;
      bestReasons = reasons;
    }
  }
  if (best && bestScore >= 40) {
    return {
      productPricingId: best.productPricingId,
      suggestReason: bestReasons.join(' · ')
    };
  }
  return null;
}

function pickClosestPremiumMatch(tierContext, pricingRows, sourceAmount) {
  if (sourceAmount == null || pricingRows.length <= 1) return null;

  let closest = null;
  let closestDiff = Infinity;
  for (const row of pricingRows) {
    const target = pricingRowAmount(row);
    if (target == null) continue;
    const diff = Math.abs(sourceAmount - target);
    const tobaccoPenalty = tierContext.inferredTobaccoUse
      && normalizePricingTobaccoStatus(row.tobaccoStatus) !== tierContext.inferredTobaccoUse
      ? diff * 0.15
      : 0;
    const adjustedDiff = diff + tobaccoPenalty;
    if (adjustedDiff < closestDiff) {
      closestDiff = adjustedDiff;
      closest = row;
    }
  }

  const closestAmount = closest ? pricingRowAmount(closest) : null;
  if (closestAmount != null) {
    const pctDiff = closestDiff / Math.max(sourceAmount, closestAmount, 1);
    if (pctDiff <= 0.25) {
      return {
        productPricingId: closest.productPricingId,
        suggestReason: `Closest premium $${sourceAmount.toFixed(2)} → $${closestAmount.toFixed(2)}`
      };
    }
  }
  return null;
}

function suggestPricingMatch(tierContext, pricingRows, savedMap) {
  if (savedMap?.ProductPricingId) {
    return {
      productPricingId: savedMap.ProductPricingId,
      suggestReason: 'Previously saved'
    };
  }

  if (!pricingRows?.length) return { productPricingId: null, suggestReason: null };

  const sourceAmount = getSourcePremiumAmount(tierContext);
  const searchSets = buildPricingMatchSearchSets(tierContext, pricingRows);

  if (sourceAmount != null) {
    for (const rows of searchSets) {
      const exactMatches = rows.filter((row) => isExactAmountMatch(sourceAmount, row, tierContext));
      const exactPick = pickBestExactAmountMatch(tierContext, exactMatches, sourceAmount);
      if (exactPick) return exactPick;
    }
  }

  for (const rows of searchSets) {
    const compositePick = pickBestCompositeMatch(tierContext, rows);
    if (compositePick) return compositePick;
  }

  if (sourceAmount != null) {
    for (const rows of searchSets) {
      const closestPick = pickClosestPremiumMatch(tierContext, rows, sourceAmount);
      if (closestPick) return closestPick;
    }
  }

  if (pricingRows.length === 1) {
    return {
      productPricingId: pricingRows[0].productPricingId,
      suggestReason: 'Only pricing tier available'
    };
  }

  return { productPricingId: null, suggestReason: null };
}

function comparePremiumMatch(e123Amount, pricingRow, tierContext) {
  const resolvedE123 = tierContext && pricingRow
    ? resolveE123PremiumForPricingRow(tierContext, pricingRow)
    : e123Amount;
  const ab365Amount = pricingRow ? pricingRowDisplayAmount(pricingRow) : null;
  if (resolvedE123 == null || ab365Amount == null) {
    return {
      status: 'unknown',
      e123Amount: resolvedE123 ?? null,
      ab365Amount,
      diff: null
    };
  }
  const diff = Math.abs(resolvedE123 - ab365Amount);
  if (diff < 0.01) {
    return { status: 'exact', e123Amount: resolvedE123, ab365Amount, diff: 0 };
  }
  if (diff <= ab365Amount * 0.02) {
    return { status: 'close', e123Amount: resolvedE123, ab365Amount, diff };
  }
  return { status: 'mismatch', e123Amount: resolvedE123, ab365Amount, diff };
}

function needsDualTobaccoMapping(tierContext) {
  const yes = tierContext.tobaccoCounts?.yes || 0;
  const no = tierContext.tobaccoCounts?.no || 0;
  if (yes > 0 && no > 0) return true;
  const stats = tierContext.feeAmountStats;
  if (stats && stats.sampleSize >= 3 && (stats.max - stats.min) >= 5) return true;
  return false;
}

function inferTobaccoFromPremiumAmount(amount, pricingRows = [], tierContext = {}) {
  if (amount == null || !pricingRows.length) return null;
  const rows = filterPricingRowsForTier(tierContext, pricingRows);
  const noRows = rows.filter((row) => normalizePricingTobaccoStatus(row.tobaccoStatus) === 'No');
  const yesRows = rows.filter((row) => normalizePricingTobaccoStatus(row.tobaccoStatus) === 'Yes');
  if (!noRows.length && !yesRows.length) return null;

  const pickClosest = (candidates) => {
    let best = null;
    let bestDiff = Infinity;
    for (const row of candidates) {
      const rate = pricingRowDisplayAmount(row);
      if (rate == null) continue;
      const diff = Math.abs(amount - rate);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = row;
      }
    }
    return best ? { row: best, diff: bestDiff } : null;
  };

  const closestNo = pickClosest(noRows);
  const closestYes = pickClosest(yesRows);
  if (closestNo && closestYes) {
    if (closestYes.diff + 0.01 < closestNo.diff) return 'Yes';
    if (closestNo.diff + 0.01 < closestYes.diff) return 'No';
    return null;
  }
  if (closestYes && (!closestNo || closestYes.diff < 1)) return 'Yes';
  if (closestNo && (!closestYes || closestNo.diff < 1)) return 'No';
  return null;
}

function suggestTobaccoPricingPair(tierContext, pricingRows, savedMap) {
  const rows = filterPricingRowsForTier(tierContext, pricingRows);
  const noRows = rows.filter((row) => normalizePricingTobaccoStatus(row.tobaccoStatus) === 'No');
  const yesRows = rows.filter((row) => normalizePricingTobaccoStatus(row.tobaccoStatus) === 'Yes');
  if (!noRows.length || !yesRows.length) {
    const single = suggestPricingMatch(tierContext, pricingRows, savedMap);
    const selected = pricingRows.find((row) => row.productPricingId === single.productPricingId);
    return {
      ...single,
      productPricingIdTobacco: null,
      premiumMatch: comparePremiumMatch(getSourcePremiumAmount(tierContext), selected, tierContext)
    };
  }

  const noPick = suggestPricingMatch(
    { ...tierContext, inferredTobaccoUse: 'No', tobaccoConfidence: 1 },
    noRows,
    savedMap?.ProductPricingId && !savedMap?.ProductPricingIdTobacco ? savedMap : null
  );
  const yesPick = suggestPricingMatch(
    { ...tierContext, inferredTobaccoUse: 'Yes', tobaccoConfidence: 1 },
    yesRows,
    savedMap?.ProductPricingIdTobacco ? { ProductPricingId: savedMap.ProductPricingIdTobacco } : null
  );

  const noRow = pricingRows.find((row) => row.productPricingId === noPick.productPricingId);
  const yesRow = pricingRows.find((row) => row.productPricingId === yesPick.productPricingId);
  const e123Amount = getSourcePremiumAmount(tierContext);

  return {
    productPricingId: savedMap?.ProductPricingId || noPick.productPricingId,
    productPricingIdTobacco: savedMap?.ProductPricingIdTobacco || yesPick.productPricingId,
    suggestReason: [noPick.suggestReason, yesPick.suggestReason].filter(Boolean).join(' · '),
    // E123 has no separate tobacco tier — only the non-tobacco premium is comparable.
    premiumMatch: comparePremiumMatch(e123Amount, noRow, tierContext),
    tobaccoPremiumMatch: null
  };
}

function suggestPricingMatchWithMeta(tierContext, pricingRows, savedMap) {
  const rows = filterPricingRowsForTier(tierContext, pricingRows);
  const noRows = rows.filter((row) => normalizePricingTobaccoStatus(row.tobaccoStatus) === 'No');
  const yesRows = rows.filter((row) => normalizePricingTobaccoStatus(row.tobaccoStatus) === 'Yes');
  const hasPairedTobaccoRows = noRows.length > 0 && yesRows.length > 0;

  if (hasPairedTobaccoRows && (needsDualTobaccoMapping(tierContext) || yesRows.length)) {
    return suggestTobaccoPricingPair(tierContext, pricingRows, savedMap);
  }
  const suggestion = suggestPricingMatch(tierContext, pricingRows, savedMap);
  const selected = pricingRows.find((row) => row.productPricingId === suggestion.productPricingId);
  return {
    ...suggestion,
    productPricingIdTobacco: savedMap?.ProductPricingIdTobacco || null,
    premiumMatch: comparePremiumMatch(getSourcePremiumAmount(tierContext), selected, tierContext)
  };
}

function resolveHouseholdProductPremium(product) {
  if (!product) return null;
  const fees = product.productfees || [];
  if (!fees.length) return null;
  const benefitKey = product.benefitId != null ? String(product.benefitId) : null;
  const matched = benefitKey
    ? fees.find((fee) => String(fee.benefitid ?? fee.periodid ?? '') === benefitKey)
    : fees[0];
  const meta = extractFeeMetadata(matched || fees[0]);
  return meta.amount;
}

function resolveMigrationProductEnrollmentAmounts(pricingRow, e123PremiumAmount) {
  if (!pricingRow) {
    return {
      premiumAmount: e123PremiumAmount ?? 0,
      includedPaymentProcessingFeeAmount: 0,
      netRate: 0,
      overrideRate: 0,
      commission: 0
    };
  }

  const { baseAmount, includedProcessingFee } = resolvePricingRowRetailAndBase(pricingRow);

  return {
    premiumAmount: baseAmount ?? e123PremiumAmount ?? 0,
    includedPaymentProcessingFeeAmount: includedProcessingFee > 0 ? includedProcessingFee : 0,
    netRate: pricingRow.netRate != null ? Number(pricingRow.netRate) : 0,
    overrideRate: pricingRow.overrideRate != null ? Number(pricingRow.overrideRate) : 0,
    commission: pricingRow.commission != null
      ? Number(pricingRow.commission)
      : (pricingRow.vendorCommission != null ? Number(pricingRow.vendorCommission) : 0)
  };
}

function resolveMemberPricingForProduct({
  household,
  product,
  map,
  pricingRows = []
}) {
  if (!map?.ProductId) return { productPricingId: null, tobaccoUse: household.primary?.tobaccoUse || null };

  let tobaccoUse = household.primary?.tobaccoUse || extractTobaccoFromE123Record(household.primary || {});
  const premiumAmount = resolveHouseholdProductPremium(product);
  const tierContext = buildTierContext({
    sourceBenefitKey: product.benefitId != null ? String(product.benefitId) : null,
    inferredMemberTier: household.primary?.tier || null,
    feeHints: { amount: premiumAmount },
    feeAmountStats: premiumAmount != null ? { median: premiumAmount, min: premiumAmount, max: premiumAmount, sampleSize: 1 } : null
  });

  if (!tobaccoUse && premiumAmount != null) {
    tobaccoUse = inferTobaccoFromPremiumAmount(premiumAmount, pricingRows, tierContext);
  }

  if (tobaccoUse === 'Yes' && map.ProductPricingIdTobacco) {
    return { productPricingId: map.ProductPricingIdTobacco, tobaccoUse: 'Yes', premiumAmount };
  }
  if (map.ProductPricingId) {
    return { productPricingId: map.ProductPricingId, tobaccoUse: tobaccoUse || 'No', premiumAmount };
  }
  if (tobaccoUse === 'Yes') {
    const yesRow = pricingRows.find((row) => normalizePricingTobaccoStatus(row.tobaccoStatus) === 'Yes');
    if (yesRow) return { productPricingId: yesRow.productPricingId, tobaccoUse: 'Yes', premiumAmount };
  }
  const suggestion = suggestPricingMatchWithMeta(tierContext, pricingRows, map);
  return {
    productPricingId: tobaccoUse === 'Yes'
      ? (suggestion.productPricingIdTobacco || suggestion.productPricingId)
      : suggestion.productPricingId,
    tobaccoUse: tobaccoUse || 'No',
    premiumAmount
  };
}

module.exports = {
  TIER_CODES,
  normalizeName,
  parseE123TobaccoUse,
  extractTobaccoFromE123Record,
  normalizePricingTobaccoStatus,
  formatPricingTobaccoLabel,
  emptyTobaccoCounts,
  addTobaccoCount,
  computeTobaccoInference,
  parseTierFromLabel,
  parseUnsharedFromLabel,
  extractFeeMetadata,
  computeAmountStats,
  pricingRowAmount,
  pricingRowDisplayAmount,
  resolvePricingRowRetailAndBase,
  scoreAmountMatch,
  getSourcePremiumAmount,
  resolveE123PremiumForPricingRow,
  isExactAmountMatch,
  scorePricingMatchSecondary,
  emptyTierCounts,
  addMemberTierCount,
  computeTierInference,
  computeAgeStats,
  safeMemberAge,
  tierDisplayLabel,
  buildTierContext,
  scorePricingMatch,
  suggestPricingMatch,
  comparePremiumMatch,
  needsDualTobaccoMapping,
  inferTobaccoFromPremiumAmount,
  suggestTobaccoPricingPair,
  suggestPricingMatchWithMeta,
  resolveHouseholdProductPremium,
  resolveMigrationProductEnrollmentAmounts,
  resolveMemberPricingForProduct
};
