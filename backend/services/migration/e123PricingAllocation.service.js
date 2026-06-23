'use strict';

const { v4: uuidv4 } = require('uuid');
const { scorePricingMatch, pricingRowAmount } = require('./e123TierInference');

const TIER_CODES = ['EE', 'ES', 'EC', 'EF'];

const DEFAULT_COMMISSION_BY_TIER = {
  EE: 26,
  ES: 32,
  EC: 32,
  EF: 38
};

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function normalizeTobacco(value) {
  if (value == null || value === '') return 'No';
  const raw = String(value).trim();
  if (raw === 'Yes' || raw === 'Y') return 'Yes';
  if (raw === 'N/A') return 'N/A';
  return 'No';
}

function pricingRowMsrp(row) {
  if (row.msrpRate != null && row.msrpRate > 0) return row.msrpRate;
  const net = Number(row.netRate) || 0;
  const override = Number(row.overrideRate) || 0;
  const commission = Number(row.commission ?? row.vendorCommission) || 0;
  const systemFees = Number(row.systemFees) || 0;
  const total = net + override + commission + systemFees;
  return total > 0 ? total : pricingRowAmount(row);
}

function flattenWizardPricingTiers(pricingTiers = []) {
  const rows = [];
  for (const tier of pricingTiers) {
    for (const band of tier.ageBands || []) {
      rows.push({
        productPricingId: band.productPricingId || null,
        tierType: tier.tierType,
        label: tier.label || tier.tierType,
        configValue1: band.configValue1 || '',
        tobaccoStatus: band.tobaccoStatus || 'No',
        minAge: band.minAge,
        maxAge: band.maxAge,
        netRate: Number(band.netRate) || 0,
        overrideRate: Number(band.overrideRate) || 0,
        commission: Number(band.commission) || 0,
        systemFees: Number(band.systemFees) || 0,
        msrpRate: Number(band.msrpRate) || 0,
        overrides: Array.isArray(band.overrides) ? band.overrides.map(cloneOverrideForDraft) : []
      });
    }
  }
  return rows;
}

function cloneOverrideForDraft(override) {
  return {
    OverrideId: override.OverrideId,
    ProductId: override.ProductId,
    ProductPricingId: override.ProductPricingId,
    TenantId: override.TenantId,
    OverrideACHId: override.OverrideACHId,
    OverrideName: override.OverrideName,
    OverrideAmount: Number(override.OverrideAmount) || 0,
    Priority: override.Priority ?? null,
    IsActive: override.IsActive !== false,
    EffectiveDate: override.EffectiveDate || null,
    ExpirationDate: override.ExpirationDate || null,
    TenantName: override.TenantName || null,
    ACHAccountHolderName: override.ACHAccountHolderName || null,
    ACHBankName: override.ACHBankName || null,
    ACHAccountType: override.ACHAccountType || null,
    PricingName: override.PricingName || null
  };
}

function buildTierContextFromBand({
  tierCode,
  configValue1,
  tobaccoStatus,
  migrationTier,
  benefit
}) {
  return {
    sourceBenefitKey: benefit?.benefitId || migrationTier?.sourceBenefitKey || null,
    sourceBenefitLabel: benefit?.benefitName || migrationTier?.sourceBenefitLabel || null,
    resolvedTier: tierCode,
    catalogTier: benefit?.tier || null,
    catalogUnsharedAmount: benefit?.unsharedAmount ?? null,
    inferredMemberTier: migrationTier?.inferredMemberTier || null,
    feeHints: migrationTier?.feeHints || null,
    feeAmountStats: migrationTier?.feeAmountStats || null,
    commissionableAmountStats: migrationTier?.commissionableAmountStats || null
  };
}

function scoreMsrpMatch(msrp, row) {
  const target = pricingRowMsrp(row);
  if (target == null || msrp == null) return { score: 0, pctDiff: Infinity };
  const diff = Math.abs(msrp - target);
  const basis = Math.max(msrp, target, 1);
  const pctDiff = diff / basis;
  if (diff < 0.01) return { score: 100, pctDiff: 0 };
  if (pctDiff <= 0.02) return { score: 85, pctDiff };
  if (pctDiff <= 0.05) return { score: 65, pctDiff };
  if (pctDiff <= 0.1) return { score: 40, pctDiff };
  return { score: 0, pctDiff };
}

function findBestPricingRow({
  msrp,
  tierCode,
  configValue1,
  tobaccoStatus,
  referenceRows,
  tierContext
}) {
  let best = null;
  let bestScore = 0;

  for (const row of referenceRows || []) {
    let score = 0;
    if (tierCode && String(row.tierType || '').toUpperCase() === tierCode) score += 50;
    if (configValue1 && String(row.configValue1 || '') === String(configValue1)) score += 40;
    if (tobaccoStatus && normalizeTobacco(row.tobaccoStatus) === normalizeTobacco(tobaccoStatus)) score += 25;
    score += scoreMsrpMatch(msrp, row).score;

    if (tierContext) {
      const contextual = scorePricingMatch(tierContext, row);
      score += Math.min(contextual.score, 120) * 0.35;
    }

    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }

  return bestScore >= 55 ? best : null;
}

function findTemplateTierRow({
  msrp,
  tierCode,
  configValue1,
  tobaccoStatus,
  templateRows
}) {
  const exact = (templateRows || []).find((row) => (
    String(row.tierType || '').toUpperCase() === tierCode
    && String(row.configValue1 || '') === String(configValue1 || '')
    && normalizeTobacco(row.tobaccoStatus) === normalizeTobacco(tobaccoStatus)
  ));
  if (exact) return exact;

  return (templateRows || []).find((row) => (
    String(row.tierType || '').toUpperCase() === tierCode
    && normalizeTobacco(row.tobaccoStatus) === normalizeTobacco(tobaccoStatus)
  )) || null;
}

function scalePricingRow(row, targetMsrp) {
  const sourceMsrp = pricingRowMsrp(row);
  if (!sourceMsrp || !targetMsrp) {
    return componentsFromRow(row, targetMsrp);
  }
  if (Math.abs(sourceMsrp - targetMsrp) < 0.01) {
    return componentsFromRow(row, targetMsrp);
  }

  const ratio = targetMsrp / sourceMsrp;
  const netRate = roundMoney((Number(row.netRate) || 0) * ratio);
  const overrideRate = roundMoney((Number(row.overrideRate) || 0) * ratio);
  let commission = Number(row.commission ?? row.vendorCommission) || 0;
  if (commission > 0 && commission < sourceMsrp * 0.5) {
    commission = roundMoney(commission);
  } else {
    commission = roundMoney(commission * ratio);
  }
  const systemFees = roundMoney((Number(row.systemFees) || 0) * ratio);
  return balanceComponents({
    netRate,
    overrideRate,
    commission,
    systemFees,
    msrpRate: targetMsrp
  });
}

function componentsFromRow(row, msrpRate) {
  const netRate = roundMoney(row.netRate || 0);
  const overrideRate = roundMoney(row.overrideRate || 0);
  const commission = roundMoney(row.commission ?? row.vendorCommission ?? 0);
  const systemFees = roundMoney(row.systemFees || 0);
  const computed = netRate + overrideRate + commission + systemFees;
  if (computed > 0 && Math.abs(computed - msrpRate) > 0.02) {
    return balanceComponents({ netRate, overrideRate, commission, systemFees, msrpRate });
  }
  return {
    netRate,
    overrideRate,
    commission,
    systemFees,
    msrpRate: roundMoney(msrpRate || computed)
  };
}

function balanceComponents({ netRate, overrideRate, commission, systemFees, msrpRate }) {
  let net = roundMoney(netRate);
  let override = roundMoney(overrideRate);
  let comm = roundMoney(commission);
  const fees = roundMoney(systemFees);
  const target = roundMoney(msrpRate);
  let total = net + override + comm + fees;
  let diff = roundMoney(target - total);
  if (Math.abs(diff) < 0.01) {
    return {
      netRate: Math.max(0, net),
      overrideRate: Math.max(0, override),
      commission: Math.max(0, comm),
      systemFees: Math.max(0, fees),
      msrpRate: target
    };
  }
  if (net > 0) net = roundMoney(net + diff);
  else if (override > 0) override = roundMoney(override + diff);
  else if (comm > 0) comm = roundMoney(comm + diff);
  else net = roundMoney(net + diff);

  total = net + override + comm + fees;
  diff = roundMoney(target - total);
  if (Math.abs(diff) >= 0.01) {
    if (comm > 0) comm = roundMoney(Math.max(0, comm + diff));
    else if (net > 0) net = roundMoney(Math.max(0, net + diff));
    else override = roundMoney(Math.max(0, override + diff));
  }

  return {
    netRate: Math.max(0, net),
    overrideRate: Math.max(0, override),
    commission: Math.max(0, comm),
    systemFees: Math.max(0, fees),
    msrpRate: target
  };
}

function allocateFromCommissionableGap(msrp, commissionableAmount) {
  if (msrp == null || msrp <= 0) return null;
  if (commissionableAmount == null || commissionableAmount <= 0) return null;
  if (Math.abs(msrp - commissionableAmount) < 0.01) return null;

  const overrideRate = roundMoney(Math.max(0, msrp - commissionableAmount));
  if (overrideRate <= 0) return null;

  return balanceComponents({
    netRate: 0,
    overrideRate,
    commission: roundMoney(commissionableAmount),
    systemFees: 0,
    msrpRate: msrp
  });
}

function inferTierCommissionDefault(tierCode, referenceRows, productType) {
  const tierRows = (referenceRows || []).filter((row) => String(row.tierType || '').toUpperCase() === tierCode);
  const commissions = tierRows
    .map((row) => Number(row.commission ?? row.vendorCommission) || 0)
    .filter((value) => value > 0);
  if (commissions.length) {
    commissions.sort((a, b) => a - b);
    return commissions[Math.floor(commissions.length / 2)];
  }
  if (/healthcare|dental|vision|accident|critical|hospital|telemed/i.test(productType || '')) {
    return DEFAULT_COMMISSION_BY_TIER[tierCode] || DEFAULT_COMMISSION_BY_TIER.EE;
  }
  return DEFAULT_COMMISSION_BY_TIER[tierCode] || 0;
}

function inferPremiumHints(migrationTier) {
  const msrp = migrationTier?.feeAmountStats?.median
    ?? migrationTier?.feeAmountStats?.average
    ?? migrationTier?.feeHints?.amount
    ?? null;
  const commissionable = migrationTier?.commissionableAmountStats?.median
    ?? migrationTier?.commissionableAmountStats?.average
    ?? migrationTier?.feeHints?.commissionableAmount
    ?? null;
  return { msrp, commissionable };
}

function resolvePricingAllocation({
  msrp,
  tierCode,
  configValue1,
  tobaccoStatus,
  migrationTier,
  benefit,
  referenceRows = [],
  templateRows = [],
  productType = ''
}) {
  const targetMsrp = roundMoney(msrp);
  if (!targetMsrp || targetMsrp <= 0) {
    return {
      netRate: 0,
      overrideRate: 0,
      commission: 0,
      systemFees: 0,
      msrpRate: 0,
      allocationSource: 'empty',
      overrides: []
    };
  }

  const tierContext = buildTierContextFromBand({
    tierCode,
    configValue1,
    tobaccoStatus,
    migrationTier,
    benefit
  });
  const premiumHints = inferPremiumHints(migrationTier);
  const commissionable = premiumHints.commissionable;

  const exactReference = findBestPricingRow({
    msrp: targetMsrp,
    tierCode,
    configValue1,
    tobaccoStatus,
    referenceRows,
    tierContext
  });
  if (exactReference && scoreMsrpMatch(targetMsrp, exactReference).score >= 85) {
    const components = componentsFromRow(exactReference, targetMsrp);
    return {
      ...components,
      allocationSource: 'msrp_match',
      overrides: exactReference.overrides || []
    };
  }

  const templateRow = findTemplateTierRow({
    msrp: targetMsrp,
    tierCode,
    configValue1,
    tobaccoStatus,
    templateRows
  });
  if (templateRow) {
    const sameUa = String(templateRow.configValue1 || '') === String(configValue1 || '');
    const components = sameUa
      ? componentsFromRow(templateRow, targetMsrp)
      : scalePricingRow(templateRow, targetMsrp);
    return {
      ...components,
      allocationSource: sameUa ? 'template_exact' : 'template_scaled',
      overrides: templateRow.overrides || []
    };
  }

  const gapAllocation = allocateFromCommissionableGap(targetMsrp, commissionable);
  if (gapAllocation) {
    return {
      ...gapAllocation,
      allocationSource: 'commissionable_gap',
      overrides: []
    };
  }

  if (exactReference && scoreMsrpMatch(targetMsrp, exactReference).score >= 65) {
    const components = scalePricingRow(exactReference, targetMsrp);
    return {
      ...components,
      allocationSource: 'reference_scaled',
      overrides: exactReference.overrides || []
    };
  }

  const commission = inferTierCommissionDefault(tierCode, referenceRows, productType);
  const components = balanceComponents({
    netRate: roundMoney(Math.max(0, targetMsrp - commission)),
    overrideRate: 0,
    commission,
    systemFees: 0,
    msrpRate: targetMsrp
  });
  return {
    ...components,
    allocationSource: commission > 0 ? 'tier_commission_default' : 'msrp_all_net',
    overrides: []
  };
}

function buildAgeBandFromAllocation({
  tobaccoStatus,
  minAge,
  maxAge,
  allocation,
  configValue1,
  configFieldName,
  effectiveDate
}) {
  const netRate = allocation.netRate || 0;
  const overrideRate = allocation.overrideRate || 0;
  const commission = allocation.commission || 0;
  const systemFees = allocation.systemFees || 0;
  const msrpRate = allocation.msrpRate || roundMoney(netRate + overrideRate + commission + systemFees);

  return {
    id: uuidv4(),
    tobaccoStatus,
    minAge,
    maxAge,
    netRate,
    overrideRate,
    commission,
    systemFees,
    msrpRate,
    affiliateRate: roundMoney(netRate + overrideRate),
    configValue1: configValue1 || '',
    configField1: configFieldName || '',
    configValue2: '',
    configValue3: '',
    configValue4: '',
    configValue5: '',
    effectiveDate: effectiveDate || new Date().toISOString().slice(0, 10),
    terminationDate: null,
    overrides: (allocation.overrides || []).map(cloneOverrideForDraft)
  };
}

module.exports = {
  DEFAULT_COMMISSION_BY_TIER,
  roundMoney,
  pricingRowMsrp,
  flattenWizardPricingTiers,
  findBestPricingRow,
  scalePricingRow,
  allocateFromCommissionableGap,
  inferTierCommissionDefault,
  resolvePricingAllocation,
  buildAgeBandFromAllocation,
  cloneOverrideForDraft
};
