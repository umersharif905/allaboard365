'use strict';

const { lookupRateForBenefit } = require('./e123Rates.service');

function parseAmount(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeCatalogPricingRows(snapshot) {
  const matrix = snapshot?.pricingMatrix;
  if (!Array.isArray(matrix) || !matrix.length) return [];
  return matrix
    .map((row) => {
      const amount = parseAmount(row.amount);
      if (amount == null) return null;
      return {
        benefitId: row.benefitId != null ? String(row.benefitId) : null,
        benefitLabel: row.benefitLabel || null,
        amount,
        memberAgeMin: row.memberAgeMin != null ? Number(row.memberAgeMin) : null,
        memberAgeMax: row.memberAgeMax != null ? Number(row.memberAgeMax) : null,
        period: row.period || null,
        displayStart: row.displayStart || null,
        source: amount > 0 ? 'catalog' : null
      };
    })
    .filter(Boolean);
}

/**
 * Pricing Matrix MSRP first; when Price is $0 (Sharewell-style products), fill from E123 GetRates.
 */
function buildEffectiveCatalogPricingRows(rawMatrixRows, rateGrid) {
  const effective = [];
  const seenBenefits = new Set();

  for (const row of rawMatrixRows || []) {
    const benefitId = row.benefitId != null ? String(row.benefitId) : null;
    let amount = row.amount;
    let source = row.source || (amount > 0 ? 'catalog' : null);

    if (!amount || amount <= 0) {
      const lookup = lookupRateForBenefit(rateGrid, {
        benefitId: row.benefitId,
        benefitName: row.benefitLabel
      });
      const rate = lookup?.nonTobaccoRate ?? lookup?.tobaccoRate ?? null;
      if (rate != null && rate > 0) {
        amount = rate;
        source = 'getrates';
      }
    }

    if (amount > 0) {
      effective.push({
        ...row,
        amount,
        source: source || 'catalog'
      });
    }
    if (benefitId) seenBenefits.add(benefitId);
  }

  for (const rate of rateGrid?.rows || []) {
    const benefitId = rate.benefitId != null ? String(rate.benefitId) : null;
    if (benefitId && seenBenefits.has(benefitId)) continue;
    const amount = rate.nonTobaccoRate ?? rate.tobaccoRate ?? null;
    if (amount == null || amount <= 0) continue;
    effective.push({
      benefitId,
      benefitLabel: rate.benefitLabel || null,
      amount,
      memberAgeMin: null,
      memberAgeMax: null,
      period: 'Monthly',
      displayStart: null,
      source: 'getrates'
    });
    if (benefitId) seenBenefits.add(benefitId);
  }

  return effective;
}

function catalogRowsForBenefit(catalogPricingRows, sourceBenefitKey) {
  if (!catalogPricingRows?.length) return [];
  if (sourceBenefitKey == null || sourceBenefitKey === '') return catalogPricingRows;
  const key = String(sourceBenefitKey);
  const matched = catalogPricingRows.filter((row) => row.benefitId === key);
  return matched.length ? matched : catalogPricingRows;
}

function ageRangesOverlap(minA, maxA, minB, maxB) {
  if (minA == null || maxA == null || minB == null || maxB == null) return true;
  return minA <= maxB && maxA >= minB;
}

function ab365RowDisplayAmount(pricingRow) {
  if (!pricingRow) return null;
  return pricingRow.displayRate ?? pricingRow.msrpRate ?? pricingRow.totalRate ?? null;
}

function resolveCatalogPremiumForPricingRow(catalogPricingRows, sourceBenefitKey, pricingRow) {
  const rows = catalogRowsForBenefit(catalogPricingRows, sourceBenefitKey);
  if (!rows.length) return null;

  const minAge = pricingRow?.minAge;
  const maxAge = pricingRow?.maxAge;

  if (minAge != null && maxAge != null) {
    const overlapping = rows.filter((row) =>
      ageRangesOverlap(row.memberAgeMin, row.memberAgeMax, minAge, maxAge)
    );
    const pool = overlapping.length ? overlapping : rows;
    if (pool.length === 1) return pool[0].amount;

    const ab365Amount = ab365RowDisplayAmount(pricingRow);
    if (ab365Amount != null) {
      let best = pool[0].amount;
      let bestDiff = Math.abs(best - ab365Amount);
      for (let i = 1; i < pool.length; i += 1) {
        const diff = Math.abs(pool[i].amount - ab365Amount);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = pool[i].amount;
        }
      }
      return best;
    }
    return pool[0].amount;
  }

  if (rows.length === 1) return rows[0].amount;
  return null;
}

function catalogPremiumStats(catalogPricingRows, sourceBenefitKey) {
  const rows = catalogRowsForBenefit(catalogPricingRows, sourceBenefitKey)
    .filter((row) => row.amount != null && row.amount > 0);
  if (!rows.length) return null;
  const amounts = rows.map((row) => row.amount);
  const sorted = [...amounts].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
  const sum = sorted.reduce((total, value) => total + value, 0);
  const sources = [...new Set(rows.map((row) => row.source || 'catalog'))];
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median,
    average: sum / sorted.length,
    sampleSize: rows.length,
    sources,
    rows
  };
}

function formatCatalogPremiumHint(stats) {
  if (!stats?.rows?.length) return null;
  const labelPrefix = (() => {
    const sources = stats.sources || [...new Set(stats.rows.map((row) => row.source || 'catalog'))];
    if (sources.length === 1 && sources[0] === 'getrates') return 'E123 GetRates';
    if (sources.includes('getrates')) return 'E123 catalog/GetRates';
    return 'E123 catalog';
  })();

  if (stats.rows.length === 1) {
    const row = stats.rows[0];
    const ages = row.memberAgeMin != null && row.memberAgeMax != null
      ? ` · ages ${row.memberAgeMin}-${row.memberAgeMax}`
      : '';
    return `${labelPrefix} $${row.amount.toFixed(2)}/mo${ages}`;
  }
  return `${labelPrefix} $${stats.min.toFixed(2)}–$${stats.max.toFixed(2)}/mo (${stats.rows.length} tiers)`;
}

module.exports = {
  normalizeCatalogPricingRows,
  buildEffectiveCatalogPricingRows,
  catalogRowsForBenefit,
  resolveCatalogPremiumForPricingRow,
  catalogPremiumStats,
  formatCatalogPremiumHint,
  ageRangesOverlap,
  ab365RowDisplayAmount
};
