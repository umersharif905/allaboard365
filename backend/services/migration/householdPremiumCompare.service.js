'use strict';

const { sql, getPool } = require('../../config/database');
const { getMigratableProducts } = require('./householdNormalizer');
const {
  comparePremiumMatch,
  pricingRowDisplayAmount,
  resolveMemberPricingForProduct
} = require('./e123TierInference');
const {
  buildMigrationEnrollmentPlan,
  resolveProductMapping,
  isIgnoredProductMap
} = require('./migrationBundleEnrollment.service');
const migrationProductMapping = require('./migrationProductMapping.service');

const productNameCache = new Map();

async function getProductDisplayName(productId) {
  if (!productId) return null;
  const key = String(productId);
  if (productNameCache.has(key)) return productNameCache.get(key);
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('productId', sql.UniqueIdentifier, productId)
      .query(`
        SELECT Name
        FROM oe.Products
        WHERE ProductId = @productId
      `);
    const name = result.recordset?.[0]?.Name || null;
    productNameCache.set(key, name);
    return name;
  } catch {
    productNameCache.set(key, null);
    return null;
  }
}

function clearPricingCache() {
  productNameCache.clear();
}

async function compareHouseholdPremiums(household, instanceId) {
  if (!instanceId || !household) {
    return {
      e123PremiumTotal: null,
      ab365PremiumTotal: null,
      premiumMismatch: false,
      premiumBreakdown: []
    };
  }

  const migratable = getMigratableProducts(household.products || [], {
    includeTerminatedHouseholds: !!household?.e123Terminated
  });
  const plan = await buildMigrationEnrollmentPlan(household, migratable, instanceId);

  let e123Total = 0;
  let ab365Total = 0;
  let hasE123 = false;
  let hasAb365 = false;
  const breakdown = [];

  for (const product of migratable) {
    const map = await resolveProductMapping(instanceId, product);
    if (!map || isIgnoredProductMap(map) || !map.ProductId) continue;
    const resolved = resolveMemberPricingForProduct({
      household,
      product,
      map,
      pricingRows: await migrationProductMapping.listProductPricingRows(map.ProductId)
    });
    if (resolved.premiumAmount != null) {
      hasE123 = true;
      e123Total += resolved.premiumAmount;
    }
  }

  for (const item of plan.enrollmentItems) {
    const e123Amount = item.amounts?.premiumAmount ?? 0;
    const pricingRows = await migrationProductMapping.listProductPricingRows(item.productId);
    const pricingRow = item.productPricingId
      ? pricingRows.find((row) => String(row.productPricingId) === String(item.productPricingId))
      : pricingRows[0];
    const ab365Amount = pricingRow ? pricingRowDisplayAmount(pricingRow) : null;
    if (ab365Amount != null) {
      hasAb365 = true;
      ab365Total += ab365Amount;
    }

    const ab365ProductName = await getProductDisplayName(item.productId);
    const match = comparePremiumMatch(e123Amount, pricingRow);
    breakdown.push({
      pdid: item.product?.pdid ?? null,
      benefitId: item.product?.benefitId ?? null,
      e123Label: item.product?.label || null,
      ab365ProductId: item.productId,
      ab365ProductName,
      ab365PricingLabel: pricingRow?.displayLabel || pricingRow?.label || null,
      e123Amount: roundMoney(e123Amount),
      ab365Amount: ab365Amount != null ? roundMoney(ab365Amount) : null,
      tobaccoUse: item.tobaccoUse || null,
      productPricingId: item.productPricingId || null,
      productBundleId: item.productBundleId || null,
      matchStatus: match.status
    });
  }

  e123Total = roundMoney(e123Total);
  ab365Total = roundMoney(ab365Total);
  const premiumMismatch = hasE123 && hasAb365 && Math.abs(e123Total - ab365Total) >= 0.01;

  return {
    e123PremiumTotal: hasE123 ? e123Total : null,
    ab365PremiumTotal: hasAb365 ? ab365Total : null,
    premiumMismatch,
    premiumBreakdown: breakdown
  };
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

module.exports = {
  compareHouseholdPremiums,
  clearPricingCache
};
