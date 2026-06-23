'use strict';

const { sql, getPool } = require('../../config/database');
const { aggregateProductGroups } = require('./householdNormalizer');
const productMapService = require('./productMap.service');
const { lookupBenefitsForProduct } = require('./e123BenefitCatalog.service');
const { lookupCatalogStatusForPdids } = require('./e123ProductCatalog.service');
const migrationBatch = require('./migrationBatch.service');
const migrationInstance = require('./migrationInstance.service');
const { getProductSnapshot } = require('./e123CatalogSnapshot.service');
const {
  normalizeCatalogPricingRows,
  buildEffectiveCatalogPricingRows,
  catalogPremiumStats
} = require('./e123CatalogPricing');
const { fetchProductRateGrid } = require('./e123Rates.service');
const { inferE123TobaccoPricingRecommendation } = require('./e123TobaccoPricingInference');
const { resolveOrgBrokerId } = require('./orgBrokerResolver.service');
const { authenticateProductUrls } = require('../../routes/uploads');
const {
  buildTierContext,
  suggestPricingMatch,
  suggestPricingMatchWithMeta,
  needsDualTobaccoMapping,
  pricingRowAmount,
  pricingRowDisplayAmount,
  formatPricingTobaccoLabel
} = require('./e123TierInference');

const NULL_GUID = '00000000-0000-0000-0000-000000000000';

function normalizeName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function salesTypeLabel(salesType) {
  const raw = String(salesType || 'Both').trim();
  if (/^individual$/i.test(raw)) return 'Individual';
  if (/^group$/i.test(raw)) return 'Group';
  if (/^both$/i.test(raw)) return 'Individual & Group';
  return raw;
}

function inferSalesTypeFromCategory(category) {
  const normalized = normalizeName(category);
  if (!normalized) return 'Both';
  if (normalized.includes('group product') || normalized === 'group') return 'Group';
  if (normalized.includes('individual product') || normalized === 'individual') return 'Individual';
  return 'Both';
}

function productKindLabel(isBundle) {
  return isBundle ? 'Bundle' : 'Product';
}

/** Platform/admin/fee vendors on bundle wrappers — not the carrier shown in mapping UI. */
function isBundlePlatformVendor(vendorName) {
  const normalized = String(vendorName || '').toLowerCase();
  if (!normalized) return true;
  return (
    normalized.includes('sharewell')
    || normalized.includes('mightywell')
    || normalized.includes('mighty well')
    || normalized.includes('merchant fee')
    || normalized.includes('mwp admin')
    || normalized.includes('unified tpa')
    || normalized.includes('lyric')
    || (normalized.includes('partner') && normalized.includes('sharewell'))
  );
}

function pickBundleDisplayVendor(includedRows) {
  const ordered = [...(includedRows || [])].sort(
    (left, right) => (left.SortOrder ?? 0) - (right.SortOrder ?? 0)
  );
  const carrier = ordered.find((row) => row.VendorName && !isBundlePlatformVendor(row.VendorName));
  const pick = carrier || ordered.find((row) => row.VendorName) || null;
  if (!pick) return null;
  return {
    vendorId: pick.VendorId,
    vendorName: pick.VendorName
  };
}

async function loadBundleIncludedVendors(pool, bundleProductIds) {
  if (!bundleProductIds.length) return new Map();

  const idList = bundleProductIds.map((productId) => `'${productId}'`).join(',');
  const result = await pool.request().query(`
    SELECT
      pb.BundleProductId,
      pb.SortOrder,
      p.VendorId,
      v.VendorName
    FROM oe.ProductBundles pb
    INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
    LEFT JOIN oe.Vendors v ON p.VendorId = v.VendorId
    WHERE pb.BundleProductId IN (${idList})
      AND p.Status = 'Active'
    ORDER BY pb.BundleProductId, pb.SortOrder
  `);

  const byBundle = new Map();
  for (const row of result.recordset || []) {
    const key = String(row.BundleProductId).toLowerCase();
    if (!byBundle.has(key)) byBundle.set(key, []);
    byBundle.get(key).push(row);
  }
  return byBundle;
}

async function applyBundleDisplayVendors(pool, products) {
  const bundleIds = products.filter((product) => product.isBundle).map((product) => product.productId);
  if (!bundleIds.length) return products;

  const includedByBundle = await loadBundleIncludedVendors(pool, bundleIds);
  return products.map((product) => {
    if (!product.isBundle) return product;
    const included = includedByBundle.get(String(product.productId).toLowerCase()) || [];
    const display = pickBundleDisplayVendor(included);
    if (!display?.vendorName) return product;
    return {
      ...product,
      vendorId: display.vendorId || product.vendorId,
      vendorName: display.vendorName
    };
  });
}

function mergeCatalogSource(left, right) {
  const rank = { both: 3, owned: 2, subscribed: 1 };
  const leftRank = rank[left] || 0;
  const rightRank = rank[right] || 0;
  return leftRank >= rightRank ? left : right;
}

function dedupeMappingProducts(products) {
  const byProductId = new Map();
  for (const product of products) {
    const existing = byProductId.get(product.productId);
    if (!existing) {
      byProductId.set(product.productId, product);
      continue;
    }
    byProductId.set(product.productId, {
      ...existing,
      catalogSource: mergeCatalogSource(existing.catalogSource, product.catalogSource)
    });
  }
  return [...byProductId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function listInstanceMappingProducts(instanceId) {
  const tenants = await migrationInstance.getInstanceTenants(instanceId);
  const tenantIds = (tenants || []).map((row) => row.TenantId).filter(Boolean);
  if (tenantIds.length === 0) return [];

  const merged = [];
  for (const tenantId of tenantIds) {
    const rows = await listTenantMappingProducts(tenantId);
    merged.push(...rows);
  }
  return dedupeMappingProducts(merged);
}

async function listSubscribedProducts(tenantId) {
  return listTenantMappingProducts(tenantId);
}

async function listTenantMappingProducts(tenantId) {
  const pool = await getPool();
  const result = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT
        p.ProductId,
        p.Name,
        p.ProductType,
        p.IsBundle,
        p.IsHidden,
        p.SalesType,
        p.Status,
        p.ProductOwnerId,
        p.ProductImageUrl,
        p.ProductLogoUrl,
        v.VendorId,
        v.VendorName,
        tps.SubscriptionStatus,
        CASE
          WHEN tps.TenantId IS NOT NULL AND p.ProductOwnerId = @tenantId THEN 'both'
          WHEN tps.TenantId IS NOT NULL THEN 'subscribed'
          ELSE 'owned'
        END AS CatalogSource
      FROM oe.Products p
      LEFT JOIN oe.Vendors v ON p.VendorId = v.VendorId
      LEFT JOIN oe.TenantProductSubscriptions tps
        ON tps.ProductId = p.ProductId
       AND tps.TenantId = @tenantId
       AND tps.SubscriptionStatus IN ('Active', 'Approved')
      WHERE p.Status = 'Active'
        AND p.ProductId <> '${NULL_GUID}'
        AND (
          tps.TenantId IS NOT NULL
          OR p.ProductOwnerId = @tenantId
        )
        AND NOT EXISTS (
          SELECT 1
          FROM oe.ProductBundles pb2
          INNER JOIN oe.TenantProductSubscriptions btps2
            ON btps2.ProductId = pb2.BundleProductId
           AND btps2.TenantId = @tenantId
           AND btps2.SubscriptionStatus IN ('Active', 'Approved')
           AND (tps.RequestId IS NULL OR btps2.RequestId = tps.RequestId)
          WHERE pb2.IncludedProductId = p.ProductId
            AND ISNULL(p.ProductOwnerId, '${NULL_GUID}') <> @tenantId
        )
      ORDER BY p.Name
    `);

  const products = await Promise.all((result.recordset || []).map(async (row) => {
    const authenticated = await authenticateProductUrls({
      ProductImageUrl: row.ProductImageUrl,
      ProductLogoUrl: row.ProductLogoUrl
    });
    return {
      productId: row.ProductId,
      name: row.Name,
      productType: row.ProductType,
      isBundle: !!row.IsBundle,
      isHidden: !!row.IsHidden,
      productKind: productKindLabel(!!row.IsBundle),
      salesType: row.SalesType || 'Both',
      salesTypeLabel: salesTypeLabel(row.SalesType),
      vendorId: row.VendorId,
      vendorName: row.VendorName || 'Unknown vendor',
      subscriptionStatus: row.SubscriptionStatus || null,
      catalogSource: row.CatalogSource || 'subscribed',
      productImageUrl: authenticated.ProductImageUrl || null,
      productLogoUrl: authenticated.ProductLogoUrl || null
    };
  }));

  return applyBundleDisplayVendors(pool, products);
}

async function listProductPricingRows(productId) {
  const pool = await getPool();
  const result = await pool.request()
    .input('productId', sql.UniqueIdentifier, productId)
    .query(`
      SELECT
        pp.ProductPricingId,
        pp.Label,
        pp.PricingName,
        pp.TierType,
        pp.ConfigValue1,
        pp.ConfigValue2,
        pp.MinAge,
        pp.MaxAge,
        pp.TobaccoStatus,
        pp.NetRate,
        pp.OverrideRate,
        pp.VendorCommission,
        pp.SystemFees,
        pp.MSRPRate,
        pp.IncludedProcessingFee,
        pp.Status,
        p.IncludeProcessingFee,
        p.RoundUpProcessingFee,
        p.ProcessingFeePercentage
      FROM oe.ProductPricing pp
      INNER JOIN oe.Products p ON p.ProductId = pp.ProductId
      WHERE pp.ProductId = @productId
        AND pp.Status = 'Active'
      ORDER BY pp.TierType, pp.Label, pp.MinAge, pp.MaxAge
    `);

  return (result.recordset || []).map((row) => {
    const netRate = row.NetRate != null ? Number(row.NetRate) : null;
    const overrideRate = row.OverrideRate != null ? Number(row.OverrideRate) : null;
    const commission = row.VendorCommission != null ? Number(row.VendorCommission) : null;
    const systemFees = row.SystemFees != null ? Number(row.SystemFees) : null;
    const msrpRate = row.MSRPRate != null ? Number(row.MSRPRate) : null;
    const totalRate = msrpRate ?? pricingRowAmount({ netRate, overrideRate, commission, systemFees });
    const includeProcessingFee = row.IncludeProcessingFee === true || row.IncludeProcessingFee === 1;
    const includedProcessingFee = row.IncludedProcessingFee != null
      ? Number(row.IncludedProcessingFee)
      : 0;
    const displayRate = pricingRowDisplayAmount({
      msrpRate,
      totalRate,
      netRate,
      overrideRate,
      commission,
      systemFees,
      includeProcessingFee,
      includedProcessingFee
    });
    return {
      productPricingId: row.ProductPricingId,
      label: row.Label || row.PricingName || row.TierType || 'Pricing tier',
      pricingName: row.PricingName,
      tierType: row.TierType,
      configValue1: row.ConfigValue1,
      configValue2: row.ConfigValue2,
      minAge: row.MinAge,
      maxAge: row.MaxAge,
      tobaccoStatus: row.TobaccoStatus,
      netRate,
      overrideRate,
      commission,
      vendorCommission: commission,
      systemFees,
      msrpRate,
      totalRate,
      includeProcessingFee,
      includedProcessingFee,
      roundUpProcessingFee: row.RoundUpProcessingFee === true || row.RoundUpProcessingFee === 1,
      displayRate,
      displayLabel: [
        row.Label || row.PricingName || row.TierType || 'Tier',
        row.TierType ? `(${row.TierType})` : null,
        displayRate != null ? `$${displayRate.toFixed(2)}/mo` : null,
        includeProcessingFee && includedProcessingFee > 0 && totalRate != null && displayRate !== totalRate
          ? `base $${totalRate.toFixed(2)} + fee $${includedProcessingFee.toFixed(2)}`
          : null,
        row.ConfigValue1 ? `UA ${row.ConfigValue1}` : null,
        row.MinAge != null && row.MaxAge != null ? `ages ${row.MinAge}-${row.MaxAge}` : null,
        formatPricingTobaccoLabel(row.TobaccoStatus)
      ].filter(Boolean).join(' · ')
    };
  });
}

function scoreProductNameMatch(sourceLabel, productName) {
  const source = normalizeName(sourceLabel);
  const target = normalizeName(productName);
  if (!source || !target) return 0;
  if (source === target) return 100;
  if (target.includes(source) || source.includes(target)) return 85;
  const sourceTokens = source.split(' ').filter(Boolean);
  const targetTokens = new Set(target.split(' ').filter(Boolean));
  let overlap = 0;
  for (const token of sourceTokens) {
    if (targetTokens.has(token)) overlap += 1;
  }
  return overlap * 20;
}

function suggestProductId(sourceLabel, subscribedProducts, savedMaps, sourceProductKey) {
  const savedForProduct = savedMaps.find(
    (m) => m.SourceProductKey === String(sourceProductKey) && !m.IgnoreImport && m.ProductId
  );
  if (savedForProduct?.ProductId) return savedForProduct.ProductId;

  let best = null;
  let bestScore = 0;
  for (const product of subscribedProducts) {
    if (product.isBundle) continue;
    const score = scoreProductNameMatch(sourceLabel, product.name);
    if (score > bestScore) {
      bestScore = score;
      best = product.productId;
    }
  }
  return bestScore >= 40 ? best : null;
}

function suggestPricingId(tier, pricingRows, savedMap) {
  const suggestion = suggestPricingMatch(tier, pricingRows, savedMap);
  return suggestion.productPricingId;
}

function mapKey(sourceProductKey, sourceBenefitKey) {
  return `${sourceProductKey}::${sourceBenefitKey || ''}`;
}

async function loadHouseholdsForMapping({ batchId, tenantId }) {
  const pool = await getPool();
  if (batchId) {
    const rows = await pool.request()
      .input('batchId', sql.UniqueIdentifier, batchId)
      .query(`
        SELECT HouseholdJson
        FROM oe.MigrationImportBatchHousehold
        WHERE BatchId = @batchId AND IncludedInImport = 1
      `);
    return (rows.recordset || []).map((r) => JSON.parse(r.HouseholdJson));
  }

  const rows = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT mh.HouseholdJson
      FROM oe.MigrationImportBatchHousehold mh
      INNER JOIN oe.MigrationImportBatch mb ON mb.BatchId = mh.BatchId
      WHERE mb.TenantId = @tenantId AND mh.IncludedInImport = 1
    `);
  return (rows.recordset || []).map((r) => JSON.parse(r.HouseholdJson));
}

async function buildProductMappingWorkspace(households, { brokerId, instanceId } = {}) {
  if (!instanceId) {
    throw new Error('Migration instance is required for product mapping');
  }
  const e123ProductGroups = aggregateProductGroups(households);
  const catalogStatusByPdid = brokerId
    ? await lookupCatalogStatusForPdids(
      brokerId,
      e123ProductGroups.map((group) => group.sourceProductKey)
    )
    : new Map();

  const labelCounts = new Map();
  for (const group of e123ProductGroups) {
    const labelKey = normalizeName(group.sourceProductLabel);
    labelCounts.set(labelKey, (labelCounts.get(labelKey) || 0) + 1);
  }

  const snapshotCategoryByPdid = new Map();
  const catalogPricingByPdid = new Map();
  const rateGridByPdid = new Map();
  if (brokerId) {
    const uniquePdids = [...new Set(e123ProductGroups.map((group) => String(group.sourceProductKey)))];
    await Promise.all(uniquePdids.map(async (pdid) => {
      try {
        const record = await getProductSnapshot(pdid, brokerId);
        const rawMatrixRows = normalizeCatalogPricingRows(record?.snapshot);
        let rateGrid = { byBenefit: new Map(), rows: [] };
        try {
          rateGrid = await fetchProductRateGrid(pdid, brokerId);
        } catch {
          // GetRates optional — catalog-only when unavailable
        }
        rateGridByPdid.set(pdid, rateGrid);
        catalogPricingByPdid.set(
          pdid,
          buildEffectiveCatalogPricingRows(rawMatrixRows, rateGrid)
        );
        const { buildCatalogEntryFromSnapshot } = require('./e123ProductWizardDraft.service');
        const category = buildCatalogEntryFromSnapshot(record?.snapshot)?.category || null;
        if (category) snapshotCategoryByPdid.set(pdid, category);
      } catch {
        catalogPricingByPdid.set(pdid, []);
      }
    }));
  }

  const [subscribedProducts, savedMaps, instanceTenants] = await Promise.all([
    listInstanceMappingProducts(instanceId),
    productMapService.listProductMaps(instanceId),
    migrationInstance.getInstanceTenants(instanceId)
  ]);

  const savedByKey = new Map(
    savedMaps.map((m) => [mapKey(m.SourceProductKey, m.SourceBenefitKey), m])
  );

  const pricingCache = new Map();
  const catalogCache = new Map();
  const groups = [];

  for (const group of e123ProductGroups) {
    if (!catalogCache.has(group.sourceProductKey)) {
      catalogCache.set(
        group.sourceProductKey,
        await lookupBenefitsForProduct(group.sourceProductKey)
      );
    }
    const catalogBenefits = catalogCache.get(group.sourceProductKey) || new Map();

    const suggestedProductId = suggestProductId(
      group.sourceProductLabel,
      subscribedProducts,
      savedMaps,
      group.sourceProductKey
    );

    let pricingRows = [];
    if (suggestedProductId) {
      if (!pricingCache.has(suggestedProductId)) {
        pricingCache.set(suggestedProductId, await listProductPricingRows(suggestedProductId));
      }
      pricingRows = pricingCache.get(suggestedProductId) || [];
    }

    const productIdsForGroup = new Set();
    if (suggestedProductId) productIdsForGroup.add(suggestedProductId);
    for (const tier of group.tiers) {
      const saved = savedByKey.get(mapKey(group.sourceProductKey, tier.sourceBenefitKey));
      if (saved?.ProductId) productIdsForGroup.add(saved.ProductId);
    }
    for (const productId of productIdsForGroup) {
      if (!pricingCache.has(productId)) {
        pricingCache.set(productId, await listProductPricingRows(productId));
      }
    }

    const catalogPricingRows = catalogPricingByPdid.get(String(group.sourceProductKey)) || [];

    const tiers = group.tiers.map((tier) => {
      const saved = savedByKey.get(mapKey(group.sourceProductKey, tier.sourceBenefitKey));
      const ignored = !!saved?.IgnoreImport;
      const mapped = !!saved?.ProductId && !ignored;
      const productId = saved?.ProductId || suggestedProductId;
      const tierPricingRows = productId ? (pricingCache.get(productId) || []) : pricingRows;

      const catalog = tier.sourceBenefitKey
        ? catalogBenefits.get(String(tier.sourceBenefitKey))
        : null;
      const tierContext = buildTierContext({
        sourceBenefitKey: tier.sourceBenefitKey,
        sourceBenefitLabel: tier.sourceBenefitLabel,
        memberTierCounts: tier.memberTierCounts,
        inferredMemberTier: tier.inferredMemberTier,
        tierConfidence: tier.tierConfidence,
        tierBreakdownLabel: tier.tierBreakdownLabel,
        memberAgeRange: tier.memberAgeRange,
        feeHints: tier.feeHints,
        feeAmountStats: tier.feeAmountStats,
        catalogPricingRows,
        catalogTier: catalog?.tier || null,
        catalogBenefitName: catalog?.benefitName || null,
        catalogUnsharedAmount: catalog?.unsharedAmount ?? null,
        tobaccoCounts: tier.tobaccoCounts,
        inferredTobaccoUse: tier.inferredTobaccoUse,
        tobaccoConfidence: tier.tobaccoConfidence,
        tobaccoBreakdownLabel: tier.tobaccoBreakdownLabel
      });
      const pricingSuggestion = suggestPricingMatchWithMeta(tierContext, tierPricingRows, saved);
      const dualTobacco = needsDualTobaccoMapping(tierContext);
      const catalogPricing = catalogPremiumStats(catalogPricingRows, tier.sourceBenefitKey);

      return {
        sourceBenefitKey: tier.sourceBenefitKey,
        sourceBenefitLabel: tier.sourceBenefitLabel,
        memberCount: tier.memberCount,
        memberTierCounts: tier.memberTierCounts,
        inferredMemberTier: tier.inferredMemberTier,
        tierConfidence: tier.tierConfidence,
        tierBreakdownLabel: tier.tierBreakdownLabel,
        tobaccoCounts: tier.tobaccoCounts,
        inferredTobaccoUse: tier.inferredTobaccoUse,
        tobaccoConfidence: tier.tobaccoConfidence,
        tobaccoBreakdownLabel: tier.tobaccoBreakdownLabel,
        memberAgeRange: tier.memberAgeRange,
        feeHints: tier.feeHints,
        feeAmountStats: tier.feeAmountStats,
        catalogPricing,
        resolvedTier: tierContext.resolvedTier,
        displayHint: tierContext.displayHint,
        needsDualTobaccoMapping: dualTobacco,
        premiumMatch: pricingSuggestion.premiumMatch || null,
        tobaccoPremiumMatch: pricingSuggestion.tobaccoPremiumMatch || null,
        ignored,
        mapped,
        savedMap: saved ? {
          productId: saved.ProductId,
          productPricingId: saved.ProductPricingId,
          productPricingIdTobacco: saved.ProductPricingIdTobacco || null,
          sourceProductLabel: saved.SourceProductLabel
        } : null,
        suggestedProductId: productId || null,
        suggestedPricingId: pricingSuggestion.productPricingId,
        suggestedPricingIdTobacco: pricingSuggestion.productPricingIdTobacco || null,
        suggestReason: pricingSuggestion.suggestReason
      };
    });

    const allTiersMapped = tiers.every((tier) => tier.mapped || tier.ignored);
    const ignored = tiers.length > 0 && tiers.every((tier) => tier.ignored);
    const catalogStatus = catalogStatusByPdid.get(String(group.sourceProductKey)) || null;
    const catalogCategory = catalogStatus?.catalogCategory
      || snapshotCategoryByPdid.get(String(group.sourceProductKey))
      || null;
    const salesType = inferSalesTypeFromCategory(catalogCategory);
    const duplicateLabelCount = labelCounts.get(normalizeName(group.sourceProductLabel)) || 1;
    const rateGrid = rateGridByPdid.get(String(group.sourceProductKey)) || null;
    const tobaccoPricingRecommendation = inferE123TobaccoPricingRecommendation(tiers, rateGrid);
    groups.push({
      sourceProductKey: group.sourceProductKey,
      sourceProductLabel: group.sourceProductLabel,
      memberCount: group.memberCount,
      enrollmentStats: group.enrollmentStats || null,
      catalogStatus,
      catalogCategory,
      salesType,
      salesTypeLabel: salesTypeLabel(salesType),
      duplicateLabelCount,
      allTiersMapped,
      ignored,
      suggestedProductId,
      tobaccoPricingRecommendation,
      tiers
    });
  }

  return {
    e123ProductGroups: groups,
    subscribedProducts,
    allMapped: groups.every((g) => g.allTiersMapped),
    householdCount: households.length,
    duplicateLabelGroups: [...labelCounts.values()].filter((count) => count > 1).length,
    instanceId,
    instanceTenantCount: (instanceTenants || []).length
  };
}

async function getProductMappingWorkspace(batchId, { tenantId, instanceId } = {}) {
  const [households, batch] = await Promise.all([
    loadHouseholdsForMapping({ batchId, tenantId }),
    migrationBatch.getBatch(batchId)
  ]);
  const resolvedInstanceId = instanceId || await migrationInstance.resolveInstanceIdForBatch(batch);
  return buildProductMappingWorkspace(households, {
    brokerId: batch?.RootBrokerId || await resolveOrgBrokerId(),
    instanceId: resolvedInstanceId
  });
}

async function getTenantProductMappingWorkspace(tenantId, { batchId, instanceId } = {}) {
  const households = await loadHouseholdsForMapping({ batchId, tenantId });
  let brokerId = await resolveOrgBrokerId();
  if (batchId) {
    const batch = await migrationBatch.getBatch(batchId);
    brokerId = batch?.RootBrokerId || brokerId;
  }
  const resolvedInstanceId = instanceId || await migrationInstance.resolveInstanceIdForTenant(tenantId);
  return buildProductMappingWorkspace(households, { brokerId, instanceId: resolvedInstanceId });
}

async function getProductMapSummary(instanceId) {
  const maps = await productMapService.listProductMaps(instanceId);
  const byProduct = new Map();

  for (const row of maps) {
    const key = row.SourceProductKey;
    if (!byProduct.has(key)) {
      byProduct.set(key, {
        sourceProductKey: key,
        sourceProductLabel: row.SourceProductLabel || key,
        tierCount: 0,
        mappedCount: 0,
        ignoredCount: 0,
        ab365ProductName: null,
        ab365ProductId: null
      });
    }
    const entry = byProduct.get(key);
    entry.tierCount += 1;
    if (row.IgnoreImport) entry.ignoredCount += 1;
    else if (row.ProductId) {
      entry.mappedCount += 1;
      entry.ab365ProductName = row.ProductName || entry.ab365ProductName;
      entry.ab365ProductId = row.ProductId;
    }
  }

  const products = Array.from(byProduct.values()).map((p) => ({
    ...p,
    status: p.ignoredCount === p.tierCount
      ? 'ignored'
      : p.mappedCount === p.tierCount
        ? 'mapped'
        : p.mappedCount > 0
          ? 'partial'
          : 'unmapped'
  }));

  return {
    totalProducts: products.length,
    mappedProducts: products.filter((p) => p.status === 'mapped').length,
    ignoredProducts: products.filter((p) => p.status === 'ignored').length,
    partialProducts: products.filter((p) => p.status === 'partial').length,
    products
  };
}

async function saveProductMappings({ instanceId, mappings = [] }) {
  for (const mapping of mappings) {
    if (mapping.ignoreImport) {
      await productMapService.saveProductMap({
        instanceId,
        sourceSystem: 'e123',
        sourceProductKey: mapping.sourceProductKey,
        sourceBenefitKey: mapping.sourceBenefitKey,
        sourceProductLabel: mapping.sourceProductLabel,
        productId: null,
        productPricingId: null,
        productPricingIdTobacco: null,
        ignoreImport: true
      });
      continue;
    }
    if (!mapping.productId) continue;
    await productMapService.saveProductMap({
      instanceId,
      sourceSystem: 'e123',
      sourceProductKey: mapping.sourceProductKey,
      sourceBenefitKey: mapping.sourceBenefitKey,
      sourceProductLabel: mapping.sourceProductLabel,
      productId: mapping.productId,
      productPricingId: mapping.productPricingId || null,
      productPricingIdTobacco: mapping.productPricingIdTobacco ?? null,
      ignoreImport: false
    });
  }
}

async function clearIgnoredProduct({ instanceId, sourceProductKey }) {
  await productMapService.removeProductMapsForProduct({
    instanceId,
    sourceProductKey
  });
}

async function unsyncProductMapping({ instanceId, sourceProductKey }) {
  await productMapService.removeProductMapsForProduct({
    instanceId,
    sourceProductKey
  });
}

async function suggestTierPricingBulk(productId, tiers = []) {
  if (!productId) return [];
  const pricingRows = await listProductPricingRows(productId);
  return tiers.map((tier) => {
    const tierContext = buildTierContext({
      sourceBenefitKey: tier.sourceBenefitKey,
      sourceBenefitLabel: tier.sourceBenefitLabel,
      memberTierCounts: tier.memberTierCounts,
      inferredMemberTier: tier.inferredMemberTier,
      tierConfidence: tier.tierConfidence,
      tierBreakdownLabel: tier.tierBreakdownLabel,
      memberAgeRange: tier.memberAgeRange,
      feeHints: tier.feeHints,
      feeAmountStats: tier.feeAmountStats,
      catalogPricingRows: tier.catalogPricingRows || tier.catalogPricing?.rows || [],
      catalogTier: tier.catalogTier || null,
      catalogBenefitName: tier.catalogBenefitName || null,
      catalogUnsharedAmount: tier.catalogUnsharedAmount ?? null,
      tobaccoCounts: tier.tobaccoCounts,
      inferredTobaccoUse: tier.inferredTobaccoUse,
      tobaccoConfidence: tier.tobaccoConfidence,
      tobaccoBreakdownLabel: tier.tobaccoBreakdownLabel
    });
    const suggestion = suggestPricingMatchWithMeta(tierContext, pricingRows, null);
    return {
      sourceBenefitKey: tier.sourceBenefitKey,
      needsDualTobaccoMapping: needsDualTobaccoMapping(tierContext),
      ...suggestion
    };
  });
}

module.exports = {
  listSubscribedProducts,
  listTenantMappingProducts,
  listInstanceMappingProducts,
  isBundlePlatformVendor,
  pickBundleDisplayVendor,
  suggestProductId,
  scoreProductNameMatch,
  dedupeMappingProducts,
  mergeCatalogSource,
  listProductPricingRows,
  loadHouseholdsForMapping,
  getProductMappingWorkspace,
  getTenantProductMappingWorkspace,
  getProductMapSummary,
  saveProductMappings,
  clearIgnoredProduct,
  unsyncProductMapping,
  suggestTierPricingBulk,
  suggestPricingId
};
