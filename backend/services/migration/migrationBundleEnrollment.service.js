'use strict';

const { v4: uuidv4 } = require('uuid');
const { sql, getPool } = require('../../config/database');
const migrationProductMapping = require('./migrationProductMapping.service');
const productMapService = require('./productMap.service');
const { resolveMemberPricingForProduct, resolveMigrationProductEnrollmentAmounts } = require('./e123TierInference');
const { pickMigrationRecordDate } = require('./householdNormalizer');

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function zeroAmounts() {
  return {
    premiumAmount: 0,
    netRate: 0,
    overrideRate: 0,
    commission: 0,
    includedPaymentProcessingFeeAmount: 0
  };
}

async function resolveProductMapping(instanceId, product) {
  const benefitKey = product.benefitId != null ? String(product.benefitId) : null;
  let map = await productMapService.getProductMap({
    instanceId,
    sourceSystem: 'e123',
    sourceProductKey: String(product.pdid),
    sourceBenefitKey: benefitKey
  });
  if (!map && benefitKey) {
    map = await productMapService.getProductMap({
      instanceId,
      sourceSystem: 'e123',
      sourceProductKey: String(product.pdid),
      sourceBenefitKey: null
    });
  }
  return map;
}

function isIgnoredProductMap(map) {
  return !!map?.IgnoreImport;
}

async function loadProductIsBundleMap(pool, productIds) {
  const map = new Map();
  const ids = [...new Set((productIds || []).filter(Boolean).map(String))];
  if (!ids.length) return map;

  for (const chunk of chunkArray(ids, 200)) {
    const idList = chunk.map((id) => `'${id}'`).join(',');
    const result = await pool.request().query(`
      SELECT ProductId, IsBundle
      FROM oe.Products
      WHERE ProductId IN (${idList})
    `);
    for (const row of result.recordset || []) {
      map.set(String(row.ProductId), row.IsBundle === true || row.IsBundle === 1);
    }
  }
  return map;
}

async function loadBundleComponentsByBundleId(pool, bundleProductId) {
  const result = await pool.request()
    .input('bundleProductId', sql.UniqueIdentifier, bundleProductId)
    .query(`
      SELECT
        pb.IncludedProductId,
        pb.SortOrder,
        p.Name AS ProductName
      FROM oe.ProductBundles pb
      INNER JOIN oe.Products p ON p.ProductId = pb.IncludedProductId
      WHERE pb.BundleProductId = @bundleProductId
        AND p.Status = 'Active'
      ORDER BY pb.SortOrder, p.Name
    `);
  return (result.recordset || []).map((row) => ({
    includedProductId: String(row.IncludedProductId),
    sortOrder: row.SortOrder,
    productName: row.ProductName
  }));
}

async function loadParentBundlesForComponents(pool, componentProductIds) {
  const parentMap = new Map();
  const ids = [...new Set((componentProductIds || []).filter(Boolean).map(String))];
  if (!ids.length) return parentMap;

  for (const chunk of chunkArray(ids, 200)) {
    const idList = chunk.map((id) => `'${id}'`).join(',');
    const result = await pool.request().query(`
      SELECT pb.BundleProductId, pb.IncludedProductId
      FROM oe.ProductBundles pb
      INNER JOIN oe.Products bp ON bp.ProductId = pb.BundleProductId AND bp.Status = 'Active'
      INNER JOIN oe.Products ip ON ip.ProductId = pb.IncludedProductId AND ip.Status = 'Active'
      WHERE pb.IncludedProductId IN (${idList})
    `);
    for (const row of result.recordset || []) {
      const componentId = String(row.IncludedProductId);
      const bundleId = String(row.BundleProductId);
      if (!parentMap.has(componentId)) parentMap.set(componentId, new Set());
      parentMap.get(componentId).add(bundleId);
    }
  }
  return parentMap;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Expand bundle enrollments only when unambiguous:
 * - explicit bundle wrapper map, OR
 * - exactly one AB365 bundle contains every mapped non-bundle component.
 */
function findUnambiguousBundleForComponents(lineItems, isBundleMap, parentBundlesMap) {
  const components = lineItems.filter((item) => !isBundleMap.get(item.productId));
  if (!components.length) return null;

  const candidateScores = new Map();
  for (const item of components) {
    const parents = parentBundlesMap.get(item.productId);
    if (!parents?.size) return null;
    for (const bundleId of parents) {
      candidateScores.set(bundleId, (candidateScores.get(bundleId) || 0) + 1);
    }
  }

  const requiredMatches = components.length;
  const fullMatches = [...candidateScores.entries()]
    .filter(([, score]) => score === requiredMatches)
    .map(([id]) => id);

  if (fullMatches.length === 1) return fullMatches[0];
  return null;
}

function resolveBundleIdsForHousehold(lineItems, isBundleMap, parentBundlesMap) {
  const resolved = new Set();

  for (const item of lineItems) {
    if (isBundleMap.get(item.productId)) {
      resolved.add(item.productId);
    }
  }

  const inferred = findUnambiguousBundleForComponents(lineItems, isBundleMap, parentBundlesMap);
  if (inferred) resolved.add(inferred);

  return [...resolved];
}

async function buildLineItem(household, product, instanceId) {
  const map = await resolveProductMapping(instanceId, product);
  if (isIgnoredProductMap(map) || !map?.ProductId) return null;

  const effectiveDate = product.dteffective ? new Date(product.dteffective) : new Date();
  const recordDate = pickMigrationRecordDate(product) || product.modifiedDate || effectiveDate;
  const pricingRows = await migrationProductMapping.listProductPricingRows(map.ProductId);
  const resolved = resolveMemberPricingForProduct({
    household,
    product,
    map,
    pricingRows
  });
  const pricingRow = pricingRows.find(
    (row) => String(row.productPricingId) === String(resolved.productPricingId)
  );
  const amounts = resolveMigrationProductEnrollmentAmounts(pricingRow, resolved.premiumAmount);

  return {
    product,
    map,
    productId: String(map.ProductId),
    amounts,
    effectiveDate,
    recordDate,
    productPricingId: resolved.productPricingId || null,
    tobaccoUse: resolved.tobaccoUse || null,
    pricingRow,
    e123Premium: resolved.premiumAmount
  };
}

function absorbLineItemIntoComponent(componentState, lineItem) {
  const premium = lineItem.e123Premium != null ? Number(lineItem.e123Premium) : 0;
  componentState.e123PremiumTotal = roundMoney((componentState.e123PremiumTotal || 0) + premium);
  if (!componentState.sourceProduct && lineItem.product) {
    componentState.sourceProduct = lineItem.product;
  }
  if (!componentState.productPricingId && lineItem.productPricingId) {
    componentState.productPricingId = lineItem.productPricingId;
    componentState.tobaccoUse = lineItem.tobaccoUse;
    componentState.amounts = lineItem.amounts;
    componentState.effectiveDate = lineItem.effectiveDate;
    componentState.recordDate = lineItem.recordDate;
  }
}

async function buildMigrationEnrollmentPlan(household, migratableProducts, instanceId) {
  const productLines = [];
  const enrollmentItems = [];
  let earliestEffectiveDate = new Date();

  const rawLineItems = [];
  for (const product of migratableProducts) {
    const lineItem = await buildLineItem(household, product, instanceId);
    if (lineItem) rawLineItems.push(lineItem);
  }
  if (!rawLineItems.length) {
    return { productLines, enrollmentItems, earliestEffectiveDate };
  }

  const pool = await getPool();
  const mappedProductIds = rawLineItems.map((row) => row.productId);
  const isBundleMap = await loadProductIsBundleMap(pool, mappedProductIds);
  const nonBundleIds = mappedProductIds.filter((id) => !isBundleMap.get(id));
  const parentBundlesMap = await loadParentBundlesForComponents(pool, nonBundleIds);
  const bundleIds = resolveBundleIdsForHousehold(rawLineItems, isBundleMap, parentBundlesMap);

  const consumedProductIds = new Set();
  const enrollmentKeys = new Set();

  for (const bundleProductId of bundleIds) {
    const components = await loadBundleComponentsByBundleId(pool, bundleProductId);
    if (!components.length) {
      consumedProductIds.add(bundleProductId);
      continue;
    }

    const componentStateById = new Map();
    for (const comp of components) {
      componentStateById.set(comp.includedProductId, {
        includedProductId: comp.includedProductId,
        productName: comp.productName,
        e123PremiumTotal: 0,
        sourceProduct: null,
        productPricingId: null,
        tobaccoUse: null,
        amounts: null,
        effectiveDate: null,
        recordDate: null
      });
    }

    for (const lineItem of rawLineItems) {
      if (lineItem.productId === bundleProductId) {
        if (lineItem.e123Premium != null && lineItem.e123Premium !== 0) {
          const firstComponent = components[0];
          if (firstComponent) {
            absorbLineItemIntoComponent(componentStateById.get(firstComponent.includedProductId), lineItem);
          }
        }
        continue;
      }
      const parents = parentBundlesMap.get(lineItem.productId);
      if (parents?.has(bundleProductId) && componentStateById.has(lineItem.productId)) {
        absorbLineItemIntoComponent(componentStateById.get(lineItem.productId), lineItem);
      }
    }

    for (const comp of components) {
      const state = componentStateById.get(comp.includedProductId);
      const premiumFromE123 = state.e123PremiumTotal || 0;
      let amounts;
      let productPricingId = state.productPricingId;
      let tobaccoUse = state.tobaccoUse;
      let effectiveDate = state.effectiveDate || new Date();
      let recordDate = state.recordDate || effectiveDate;
      let sourceProduct = state.sourceProduct;

      if (state.amounts && premiumFromE123 > 0) {
        amounts = { ...state.amounts, premiumAmount: roundMoney(premiumFromE123) };
      } else if (premiumFromE123 > 0) {
        amounts = {
          premiumAmount: roundMoney(premiumFromE123),
          netRate: 0,
          overrideRate: 0,
          commission: 0,
          includedPaymentProcessingFeeAmount: 0
        };
      } else {
        amounts = zeroAmounts();
        if (!productPricingId) {
          const pricingRows = await migrationProductMapping.listProductPricingRows(comp.includedProductId);
          const pricingRow = pricingRows[0];
          if (pricingRow) {
            productPricingId = pricingRow.productPricingId;
            amounts = resolveMigrationProductEnrollmentAmounts(pricingRow, 0);
            amounts.premiumAmount = 0;
          }
        }
      }

      if (effectiveDate < earliestEffectiveDate) earliestEffectiveDate = effectiveDate;

      const itemKey = `${bundleProductId}:${comp.includedProductId}`;
      if (enrollmentKeys.has(itemKey)) continue;
      enrollmentKeys.add(itemKey);

      productLines.push({
        productId: comp.includedProductId,
        basePremium: amounts.premiumAmount,
        includedPaymentProcessingFeeAmount: amounts.includedPaymentProcessingFeeAmount
      });

      enrollmentItems.push({
        enrollmentId: uuidv4(),
        product: sourceProduct,
        productId: comp.includedProductId,
        productBundleId: bundleProductId,
        amounts,
        effectiveDate,
        recordDate,
        productPricingId,
        tobaccoUse
      });

      consumedProductIds.add(comp.includedProductId);
    }

    consumedProductIds.add(bundleProductId);
  }

  for (const lineItem of rawLineItems) {
    if (consumedProductIds.has(lineItem.productId)) continue;
    if (isBundleMap.get(lineItem.productId)) continue;

    const itemKey = `standalone:${lineItem.productId}`;
    if (enrollmentKeys.has(itemKey)) continue;
    enrollmentKeys.add(itemKey);

    if (lineItem.effectiveDate < earliestEffectiveDate) earliestEffectiveDate = lineItem.effectiveDate;

    productLines.push({
      productId: lineItem.productId,
      basePremium: lineItem.amounts.premiumAmount,
      includedPaymentProcessingFeeAmount: lineItem.amounts.includedPaymentProcessingFeeAmount
    });

    enrollmentItems.push({
      enrollmentId: uuidv4(),
      product: lineItem.product,
      productId: lineItem.productId,
      productBundleId: null,
      amounts: lineItem.amounts,
      effectiveDate: lineItem.effectiveDate,
      recordDate: lineItem.recordDate,
      productPricingId: lineItem.productPricingId,
      tobaccoUse: lineItem.tobaccoUse
    });
  }

  return { productLines, enrollmentItems, earliestEffectiveDate };
}

module.exports = {
  buildMigrationEnrollmentPlan,
  loadBundleComponentsByBundleId,
  loadProductIsBundleMap,
  loadParentBundlesForComponents,
  resolveProductMapping,
  isIgnoredProductMap
};
