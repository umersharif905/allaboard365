'use strict';

/**
 * Read-only: preview bundle enrollment plan for E123 migration households.
 * Does NOT import or write to the database.
 *
 * Usage:
 *   node scripts/preview-bundle-migration-plan.js
 *   node scripts/preview-bundle-migration-plan.js --householdMemberId=SW12345
 *   node scripts/preview-bundle-migration-plan.js --batchId=<uuid> --limit=5
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { getPool, sql } = require('../config/database');
const migrationBatch = require('../services/migration/migrationBatch.service');
const migrationInstance = require('../services/migration/migrationInstance.service');
const { validateHouseholdMappings } = require('../services/migration/memberImport.service');
const { buildMigrationEnrollmentPlan } = require('../services/migration/migrationBundleEnrollment.service');
const { compareHouseholdPremiums } = require('../services/migration/householdPremiumCompare.service');

function parseArgs() {
  const args = { limit: 3, householdMemberId: null, batchId: null };
  for (const raw of process.argv.slice(2)) {
    if (raw.startsWith('--householdMemberId=')) args.householdMemberId = raw.split('=')[1];
    else if (raw.startsWith('--batchId=')) args.batchId = raw.split('=')[1];
    else if (raw.startsWith('--limit=')) args.limit = Number(raw.split('=')[1]) || 3;
  }
  return args;
}

async function loadProductNames(pool, productIds) {
  const ids = [...new Set(productIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const idList = ids.map((id) => `'${id}'`).join(',');
  const result = await pool.request().query(`
    SELECT ProductId, Name, IsBundle
    FROM oe.Products
    WHERE ProductId IN (${idList})
  `);
  const map = new Map();
  for (const row of result.recordset || []) {
    map.set(String(row.ProductId), { name: row.Name, isBundle: row.IsBundle === true || row.IsBundle === 1 });
  }
  return map;
}

async function findBatchWithBundleMaps(pool) {
  const result = await pool.request().query(`
    SELECT TOP 1
      b.BatchId,
      b.TenantId,
      b.InstanceId,
      t.Name AS TenantName
    FROM oe.MigrationImportBatch b
    INNER JOIN oe.Tenants t ON t.TenantId = b.TenantId
    WHERE b.Status IN ('draft', 'ready', 'applied', 'partial')
      AND EXISTS (
        SELECT 1
        FROM oe.MigrationProductMap pm
        INNER JOIN oe.Products p ON p.ProductId = pm.ProductId
        WHERE pm.InstanceId = b.InstanceId
          AND pm.IgnoreImport = 0
          AND (
            p.IsBundle = 1
            OR EXISTS (SELECT 1 FROM oe.ProductBundles pb WHERE pb.BundleProductId = p.ProductId)
            OR EXISTS (SELECT 1 FROM oe.ProductBundles pb WHERE pb.IncludedProductId = p.ProductId)
          )
      )
    ORDER BY b.CreatedUtc DESC
  `);
  return result.recordset?.[0] || null;
}

function summarizePlan(household, plan, productNames) {
  return (plan.enrollmentItems || []).map((item) => ({
    productId: item.productId,
    productName: productNames.get(item.productId)?.name || item.productId,
    productBundleId: item.productBundleId,
    bundleName: item.productBundleId ? (productNames.get(item.productBundleId)?.name || item.productBundleId) : null,
    e123Pdid: item.product?.pdid ?? null,
    e123Label: item.product?.label ?? null,
    premium: item.amounts?.premiumAmount ?? 0,
    productPricingId: item.productPricingId
  }));
}

async function previewHousehold({ household, tenantId, instanceId, label }) {
  const validation = await validateHouseholdMappings(household, instanceId);
  const enrollmentPlan = await buildMigrationEnrollmentPlan(
    household,
    validation.migratableProducts,
    instanceId
  );
  const premium = await compareHouseholdPremiums(household, instanceId);

  const pool = await getPool();
  const productIds = [
    ...(enrollmentPlan.enrollmentItems || []).map((i) => i.productId),
    ...(enrollmentPlan.enrollmentItems || []).map((i) => i.productBundleId)
  ];
  const productNames = await loadProductNames(pool, productIds);

  const e123Products = (household.products || []).map((p) => ({
    pdid: p.pdid,
    label: p.label,
    premium: p.productfees?.[0]?.amount ?? null
  }));

  return {
    label,
    householdMemberId: household.householdMemberId,
    primaryName: `${household.primary?.firstName || ''} ${household.primary?.lastName || ''}`.trim(),
    mappedCount: validation.mappedCount,
    skippedUnmapped: validation.skippedUnmappedCount,
    e123Products,
    enrollmentRows: summarizePlan(household, enrollmentPlan, productNames),
    premiumCompare: {
      e123Total: premium.e123PremiumTotal,
      ab365Total: premium.ab365PremiumTotal,
      mismatch: premium.premiumMismatch,
      breakdown: premium.premiumBreakdown
    }
  };
}

async function main() {
  const args = parseArgs();
  const pool = await getPool();
  const dbName = process.env.DB_NAME || '(unknown)';
  console.log(`\n🔍 Read-only bundle migration preview (DB: ${dbName})\n`);

  if (args.householdMemberId) {
    const row = await pool.request()
      .input('hmid', sql.NVarChar, args.householdMemberId)
      .query(`
        SELECT TOP 1 bh.HouseholdMemberID, bh.HouseholdJson, b.BatchId, b.TenantId, b.InstanceId, t.Name AS TenantName
        FROM oe.MigrationImportBatchHousehold bh
        INNER JOIN oe.MigrationImportBatch b ON b.BatchId = bh.BatchId
        INNER JOIN oe.Tenants t ON t.TenantId = b.TenantId
        WHERE bh.HouseholdMemberID = @hmid
        ORDER BY b.CreatedUtc DESC
      `);
    const hit = row.recordset?.[0];
    if (!hit) {
      console.error(`No batch household found for HouseholdMemberID=${args.householdMemberId}`);
      process.exit(1);
    }
    const household = JSON.parse(hit.HouseholdJson);
    const instanceId = hit.InstanceId || await migrationInstance.resolveInstanceIdForBatch({ InstanceId: hit.InstanceId, TenantId: hit.TenantId });
    const result = await previewHousehold({
      household,
      tenantId: hit.TenantId,
      instanceId,
      label: `${hit.TenantName} / batch ${hit.BatchId}`
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  let batchId = args.batchId;
  let batchMeta = null;
  if (batchId) {
    batchMeta = await migrationBatch.getBatchDetail(batchId);
    if (!batchMeta) {
      console.error(`Batch not found: ${batchId}`);
      process.exit(1);
    }
  } else {
    batchMeta = await findBatchWithBundleMaps(pool);
    if (!batchMeta) {
      console.error('No migration batch with bundle-related product maps found.');
      process.exit(1);
    }
    batchId = batchMeta.BatchId;
  }

  const instanceId = await migrationInstance.resolveInstanceIdForBatch(batchMeta);
  if (!instanceId) {
    console.error('Could not resolve migration instance for batch.');
    process.exit(1);
  }

  console.log(`Batch: ${batchId}`);
  console.log(`Tenant: ${batchMeta.TenantName || batchMeta.TenantId}`);
  console.log(`Instance: ${instanceId}\n`);

  const households = await migrationBatch.listBatchHouseholds(batchId, { page: 1, pageSize: 200, includedOnly: true });
  const candidates = households.filter((row) => {
    const products = row.household?.products || [];
    return products.length >= 2;
  });

  console.log(`Included households: ${households.length}, multi-product candidates: ${candidates.length}\n`);

  const toPreview = candidates.slice(0, args.limit);
  if (!toPreview.length) {
    console.log('No multi-product households in batch to preview.');
    return;
  }

  const results = [];
  for (const row of toPreview) {
    results.push(await previewHousehold({
      household: row.household,
      tenantId: batchMeta.TenantId,
      instanceId,
      label: row.HouseholdMemberID
    }));
  }

  for (const result of results) {
    console.log('─'.repeat(72));
    console.log(`${result.primaryName} (${result.householdMemberId})`);
    console.log(`Mapped E123 products: ${result.mappedCount}, skipped unmapped: ${result.skippedUnmapped}`);
    console.log('E123 products:', JSON.stringify(result.e123Products));
    console.log('Planned enrollments:');
    for (const row of result.enrollmentRows) {
      const bundleNote = row.bundleName ? ` [bundle: ${row.bundleName}]` : '';
      console.log(`  • ${row.productName}${bundleNote} — $${row.premium} (pdid ${row.e123Pdid ?? 'n/a'})`);
    }
    const hasBundleId = result.enrollmentRows.some((r) => r.productBundleId);
    const wrapperOnly = result.enrollmentRows.every((r) => !r.bundleName || r.productName !== r.bundleName);
    console.log(`Bundle pattern: ${hasBundleId ? 'component rows with ProductBundleId' : 'standalone only'}${wrapperOnly ? ' (no wrapper enrollment row)' : ''}`);
    console.log(`Premium: E123 $${result.premiumCompare.e123Total} vs AB365 $${result.premiumCompare.ab365Total} — ${result.premiumCompare.mismatch ? 'MISMATCH' : 'match'}`);
    console.log('');
  }

  console.log('✅ Preview complete — no database writes performed.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
