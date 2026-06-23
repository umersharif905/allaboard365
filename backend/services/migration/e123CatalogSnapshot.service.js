'use strict';

const { v4: uuidv4 } = require('uuid');
const { sql, getPool } = require('../../config/database');
const {
  loadCsvBundleFromUploads,
  buildCatalogFromBundle,
  inferBrokerIdFromFilenames,
  CSV_KIND_LABELS,
  REQUIRED_CSV_KINDS
} = require('./e123CsvExport/csvParser');
const { resolveOrgBrokerId } = require('./orgBrokerResolver.service');
const e123AgentTreeSnapshot = require('./e123AgentTreeSnapshot.service');

async function resolveCatalogBrokerId(rootBrokerId = null, instanceId = null) {
  const explicit = rootBrokerId != null ? Number(rootBrokerId) : null;
  if (Number.isFinite(explicit) && explicit > 0) return explicit;

  if (instanceId) {
    const orgBrokerDiscovery = require('./orgBrokerDiscovery.service');
    await orgBrokerDiscovery.ensureOrgBrokerDiscovery(instanceId);
    const discovered = orgBrokerDiscovery.getDiscoveredOrgBrokerId(instanceId);
    if (discovered) return discovered;
  }

  const fromResolver = await resolveOrgBrokerId();
  if (fromResolver) return fromResolver;

  if (instanceId) {
    const treeExport = await e123AgentTreeSnapshot.getLatestAgentTreeExport(instanceId);
    const treeRoot = treeExport?.RootBrokerId != null ? Number(treeExport.RootBrokerId) : null;
    if (Number.isFinite(treeRoot) && treeRoot > 0) return treeRoot;
  }

  return null;
}

async function getLatestCatalogExport(rootBrokerId) {
  const pool = await getPool();
  const result = await pool.request()
    .input('rootBrokerId', sql.Int, rootBrokerId)
    .query(`
      SELECT TOP 1 ExportId, RootBrokerId, UploadedBy, FileManifestJson, ProductCount,
             MissingKindsJson, CreatedUtc
      FROM oe.MigrationE123CatalogExport
      WHERE RootBrokerId = @rootBrokerId
      ORDER BY CreatedUtc DESC
    `);
  return result.recordset?.[0] || null;
}

async function getCatalogStatus(rootBrokerId = null, instanceId = null) {
  const brokerId = await resolveCatalogBrokerId(rootBrokerId, instanceId);
  if (!brokerId) {
    return {
      configured: false,
      rootBrokerId: null,
      latestExport: null,
      productCount: 0,
      requiredFileTypes: REQUIRED_CSV_KINDS.map((k) => ({
        kind: k,
        label: CSV_KIND_LABELS[k]
      }))
    };
  }

  const latestExport = await getLatestCatalogExport(brokerId);
  let productCount = 0;
  if (latestExport) {
    const pool = await getPool();
    const countResult = await pool.request()
      .input('rootBrokerId', sql.Int, brokerId)
      .query(`
        SELECT COUNT(*) AS cnt
        FROM oe.MigrationE123ProductSnapshot
        WHERE RootBrokerId = @rootBrokerId
      `);
    productCount = countResult.recordset?.[0]?.cnt || 0;
  }

  return {
    configured: true,
    rootBrokerId: brokerId,
    latestExport: latestExport ? {
      exportId: latestExport.ExportId,
      rootBrokerId: latestExport.RootBrokerId,
      productCount: latestExport.ProductCount,
      fileManifest: safeJsonParse(latestExport.FileManifestJson, []),
      missingKinds: safeJsonParse(latestExport.MissingKindsJson, []),
      createdUtc: latestExport.CreatedUtc
    } : null,
    productCount,
    requiredFileTypes: REQUIRED_CSV_KINDS.map((k) => ({
      kind: k,
      label: CSV_KIND_LABELS[k]
    }))
  };
}

async function listCatalogProducts(rootBrokerId = null, instanceId = null) {
  const brokerId = await resolveCatalogBrokerId(rootBrokerId, instanceId);
  if (!brokerId) return [];

  const pool = await getPool();
  const result = await pool.request()
    .input('rootBrokerId', sql.Int, brokerId)
    .query(`
      SELECT Pdid, Label, PricingTierCount, ModifiedUtc
      FROM oe.MigrationE123ProductSnapshot
      WHERE RootBrokerId = @rootBrokerId
      ORDER BY Label, Pdid
    `);
  return (result.recordset || []).map((row) => ({
    pdid: row.Pdid,
    label: row.Label,
    pricingTierCount: row.PricingTierCount,
    modifiedUtc: row.ModifiedUtc
  }));
}

async function getProductSnapshot(pdid, rootBrokerId = null, instanceId = null) {
  const brokerId = await resolveCatalogBrokerId(rootBrokerId, instanceId);
  if (!brokerId) return null;

  const pool = await getPool();
  const result = await pool.request()
    .input('rootBrokerId', sql.Int, brokerId)
    .input('pdid', sql.Int, Number(pdid))
    .query(`
      SELECT TOP 1 SnapshotJson, Label, PricingTierCount, ModifiedUtc, ExportId
      FROM oe.MigrationE123ProductSnapshot
      WHERE RootBrokerId = @rootBrokerId AND Pdid = @pdid
    `);
  const row = result.recordset?.[0];
  if (!row) return null;
  return {
    pdid: Number(pdid),
    label: row.Label,
    pricingTierCount: row.PricingTierCount,
    modifiedUtc: row.ModifiedUtc,
    exportId: row.ExportId,
    snapshot: safeJsonParse(row.SnapshotJson, null)
  };
}

async function importCatalogFromUploads({ files = [], rootBrokerId = null, uploadedBy = null }) {
  if (!files.length) {
    const err = new Error('At least one CSV file is required');
    err.code = 'E123_CATALOG_NO_FILES';
    throw err;
  }

  const uploads = files.map((f) => ({
    originalname: f.originalname,
    buffer: f.buffer
  }));

  const { bundle, manifest, missingKinds } = loadCsvBundleFromUploads(uploads);
  const inferredBrokerId = inferBrokerIdFromFilenames(uploads.map((f) => f.originalname));
  const brokerId = Number(rootBrokerId || inferredBrokerId);
  if (!Number.isFinite(brokerId) || brokerId <= 0) {
    const err = new Error('Could not determine E123 broker ID. Pass rootBrokerId or use filenames like 775982_Product_*.csv');
    err.code = 'E123_CATALOG_NO_BROKER';
    throw err;
  }

  if (missingKinds.length === REQUIRED_CSV_KINDS.length) {
    const err = new Error('No recognized E123 product CSV files found. Upload exports from the E123 Products tab.');
    err.code = 'E123_CATALOG_UNRECOGNIZED';
    throw err;
  }

  const catalog = buildCatalogFromBundle(bundle);

  if (catalog.productCount === 0) {
    const err = new Error(
      'CSV files were recognized but no valid Product ID values were found. '
      + 'Ensure exports include a Product ID column with numeric pdid values.'
    );
    err.code = 'E123_CATALOG_NO_PRODUCTS';
    throw err;
  }

  const exportId = uuidv4();
  const pool = await getPool();
  const transaction = pool.transaction();
  await transaction.begin();

  try {
    await transaction.request()
      .input('exportId', sql.UniqueIdentifier, exportId)
      .input('rootBrokerId', sql.Int, brokerId)
      .input('uploadedBy', sql.UniqueIdentifier, uploadedBy || null)
      .input('fileManifestJson', sql.NVarChar(sql.MAX), JSON.stringify(manifest))
      .input('productCount', sql.Int, catalog.productCount)
      .input('missingKindsJson', sql.NVarChar(sql.MAX), JSON.stringify(
        missingKinds.map((k) => ({ kind: k, label: CSV_KIND_LABELS[k] }))
      ))
      .query(`
        INSERT INTO oe.MigrationE123CatalogExport
          (ExportId, RootBrokerId, UploadedBy, FileManifestJson, ProductCount, MissingKindsJson)
        VALUES
          (@exportId, @rootBrokerId, @uploadedBy, @fileManifestJson, @productCount, @missingKindsJson)
      `);

    for (const product of catalog.products) {
      const pdid = Number(product.pdid);
      if (!Number.isFinite(pdid) || pdid <= 0) continue;
      const snapshotId = uuidv4();
      const pricingTierCount = product.stats?.derivedTierCount || product.derivedTiers?.length || 0;
      await transaction.request()
        .input('snapshotId', sql.UniqueIdentifier, snapshotId)
        .input('exportId', sql.UniqueIdentifier, exportId)
        .input('rootBrokerId', sql.Int, brokerId)
        .input('pdid', sql.Int, pdid)
        .input('label', sql.NVarChar, product.label || null)
        .input('pricingTierCount', sql.Int, pricingTierCount)
        .input('snapshotJson', sql.NVarChar(sql.MAX), JSON.stringify(product))
        .query(`
          MERGE oe.MigrationE123ProductSnapshot AS target
          USING (
            SELECT @rootBrokerId AS RootBrokerId, @pdid AS Pdid
          ) AS source
          ON target.RootBrokerId = source.RootBrokerId AND target.Pdid = source.Pdid
          WHEN MATCHED THEN
            UPDATE SET
              ExportId = @exportId,
              Label = @label,
              PricingTierCount = @pricingTierCount,
              SnapshotJson = @snapshotJson,
              ModifiedUtc = SYSUTCDATETIME()
          WHEN NOT MATCHED THEN
            INSERT (SnapshotId, ExportId, RootBrokerId, Pdid, Label, PricingTierCount, SnapshotJson)
            VALUES (@snapshotId, @exportId, @rootBrokerId, @pdid, @label, @pricingTierCount, @snapshotJson);
        `);
    }

    await transaction.commit();
  } catch (err) {
    await transaction.rollback();
    throw err;
  }

  return {
    exportId,
    rootBrokerId: brokerId,
    productCount: catalog.productCount,
    fileManifest: manifest,
    missingKinds: missingKinds.map((k) => ({ kind: k, label: CSV_KIND_LABELS[k] })),
    products: catalog.products.map((p) => ({
      pdid: p.pdid,
      label: p.label,
      pricingTierCount: p.stats?.derivedTierCount || 0
    }))
  };
}

function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

module.exports = {
  resolveCatalogBrokerId,
  getCatalogStatus,
  getLatestCatalogExport,
  listCatalogProducts,
  getProductSnapshot,
  importCatalogFromUploads,
  CSV_KIND_LABELS,
  REQUIRED_CSV_KINDS
};
