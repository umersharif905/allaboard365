'use strict';

const { v4: uuidv4 } = require('uuid');
const { sql, getPool } = require('../../config/database');

async function listProductMaps(instanceId) {
  const pool = await getPool();
  const result = await pool.request()
    .input('instanceId', sql.UniqueIdentifier, instanceId)
    .query(`
      SELECT pm.*, p.Name AS ProductName, pp.Label AS PricingLabel
      FROM oe.MigrationProductMap pm
      LEFT JOIN oe.Products p ON p.ProductId = pm.ProductId
      LEFT JOIN oe.ProductPricing pp ON pp.ProductPricingId = pm.ProductPricingId
      WHERE pm.InstanceId = @instanceId
      ORDER BY pm.SourceProductKey, pm.SourceBenefitKey
    `);
  return result.recordset || [];
}

async function getProductMap({ instanceId, sourceSystem, sourceProductKey, sourceBenefitKey }) {
  const pool = await getPool();
  const result = await pool.request()
    .input('instanceId', sql.UniqueIdentifier, instanceId)
    .input('sourceSystem', sql.NVarChar, sourceSystem)
    .input('sourceProductKey', sql.NVarChar, sourceProductKey)
    .input('sourceBenefitKey', sql.NVarChar, sourceBenefitKey || null)
    .query(`
      SELECT TOP 1 *
      FROM oe.MigrationProductMap
      WHERE InstanceId = @instanceId
        AND SourceSystem = @sourceSystem
        AND SourceProductKey = @sourceProductKey
        AND (
          (SourceBenefitKey IS NULL AND @sourceBenefitKey IS NULL)
          OR SourceBenefitKey = @sourceBenefitKey
        )
    `);
  return result.recordset?.[0] || null;
}

async function saveProductMap({
  instanceId,
  sourceSystem,
  sourceProductKey,
  sourceBenefitKey,
  sourceProductLabel,
  productId,
  productPricingId,
  productPricingIdTobacco = undefined,
  ignoreImport = false
}) {
  const pool = await getPool();
  const mapId = uuidv4();
  const request = pool.request()
    .input('mapId', sql.UniqueIdentifier, mapId)
    .input('instanceId', sql.UniqueIdentifier, instanceId)
    .input('sourceSystem', sql.NVarChar, sourceSystem)
    .input('sourceProductKey', sql.NVarChar, sourceProductKey)
    .input('sourceBenefitKey', sql.NVarChar, sourceBenefitKey || null)
    .input('sourceProductLabel', sql.NVarChar, sourceProductLabel || null)
    .input('productId', sql.UniqueIdentifier, ignoreImport ? null : productId)
    .input('productPricingId', sql.UniqueIdentifier, ignoreImport ? null : (productPricingId || null))
    .input('ignoreImport', sql.Bit, ignoreImport ? 1 : 0);

  const tobaccoSet = productPricingIdTobacco !== undefined
    ? ', ProductPricingIdTobacco = @productPricingIdTobacco'
    : '';
  const tobaccoInsertCol = productPricingIdTobacco !== undefined
    ? ', ProductPricingIdTobacco'
    : '';
  const tobaccoInsertVal = productPricingIdTobacco !== undefined
    ? ', @productPricingIdTobacco'
    : '';
  if (productPricingIdTobacco !== undefined) {
    request.input(
      'productPricingIdTobacco',
      sql.UniqueIdentifier,
      ignoreImport ? null : (productPricingIdTobacco || null)
    );
  }

  await request.query(`
      MERGE oe.MigrationProductMap AS target
      USING (
        SELECT @instanceId AS InstanceId, @sourceSystem AS SourceSystem,
               @sourceProductKey AS SourceProductKey, @sourceBenefitKey AS SourceBenefitKey
      ) AS source
      ON target.InstanceId = source.InstanceId
        AND target.SourceSystem = source.SourceSystem
        AND target.SourceProductKey = source.SourceProductKey
        AND (
          (target.SourceBenefitKey IS NULL AND source.SourceBenefitKey IS NULL)
          OR target.SourceBenefitKey = source.SourceBenefitKey
        )
      WHEN MATCHED THEN
        UPDATE SET ProductId = @productId, ProductPricingId = @productPricingId${tobaccoSet},
          SourceProductLabel = @sourceProductLabel, IgnoreImport = @ignoreImport,
          ModifiedUtc = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN
        INSERT (ProductMapId, InstanceId, SourceSystem, SourceProductKey, SourceBenefitKey,
          SourceProductLabel, ProductId, ProductPricingId${tobaccoInsertCol}, IgnoreImport)
        VALUES (@mapId, @instanceId, @sourceSystem, @sourceProductKey, @sourceBenefitKey,
          @sourceProductLabel, @productId, @productPricingId${tobaccoInsertVal}, @ignoreImport);
    `);
}

async function removeProductMapsForProduct({
  instanceId,
  sourceSystem = 'e123',
  sourceProductKey
}) {
  const pool = await getPool();
  await pool.request()
    .input('instanceId', sql.UniqueIdentifier, instanceId)
    .input('sourceSystem', sql.NVarChar, sourceSystem)
    .input('sourceProductKey', sql.NVarChar, sourceProductKey)
    .query(`
      DELETE FROM oe.MigrationProductMap
      WHERE InstanceId = @instanceId
        AND SourceSystem = @sourceSystem
        AND SourceProductKey = @sourceProductKey
    `);
}

async function createStubProduct({
  tenantId,
  name,
  vendorId,
  productOwnerId,
  tierType = 'EE',
  configValue1 = null,
  createdBy
}) {
  const pool = await getPool();
  const transaction = pool.transaction();
  await transaction.begin();
  try {
    const productId = uuidv4();
    const pricingId = uuidv4();
    const now = new Date();

    await transaction.request()
      .input('productId', sql.UniqueIdentifier, productId)
      .input('vendorId', sql.UniqueIdentifier, vendorId)
      .input('productOwnerId', sql.UniqueIdentifier, productOwnerId)
      .input('name', sql.NVarChar, name)
      .input('createdBy', sql.UniqueIdentifier, createdBy)
      .input('now', sql.DateTime2, now)
      .query(`
        INSERT INTO oe.Products (
          ProductId, VendorId, IsVendorPrice, VendorCommission, ProductOwnerId,
          Name, Description, ProductType, Status, IsMarketplaceProduct, IsPublic, IsHidden,
          CreatedBy, ModifiedBy, CreatedDate, ModifiedDate, EffectiveDate
        ) VALUES (
          @productId, @vendorId, 0, 0, @productOwnerId,
          @name, 'E123 migration stub product', 'Health', 'Active', 0, 0, 1,
          @createdBy, @createdBy, @now, @now, @now
        )
      `);

    await transaction.request()
      .input('pricingId', sql.UniqueIdentifier, pricingId)
      .input('productId', sql.UniqueIdentifier, productId)
      .input('tierType', sql.NVarChar, tierType)
      .input('configValue1', sql.NVarChar, configValue1)
      .input('createdBy', sql.UniqueIdentifier, createdBy)
      .input('now', sql.DateTime2, now)
      .query(`
        INSERT INTO oe.ProductPricing (
          ProductPricingId, ProductId, PricingName, Label, NetRate, OverrideRate,
          VendorCommission, SystemFees, MSRPRate, MinAge, MaxAge, TierType, TobaccoStatus,
          ConfigValue1, Status, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy, EffectiveDate
        ) VALUES (
          @pricingId, @productId, 'Migration Stub', 'Migration Stub', 0, 0,
          0, 0, 0, 18, 64, @tierType, 'No',
          @configValue1, 'Active', @now, @now, @createdBy, @createdBy, @now
        )
      `);

    await transaction.commit();
    return { productId, productPricingId: pricingId };
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

module.exports = {
  listProductMaps,
  getProductMap,
  saveProductMap,
  removeProductMapsForProduct,
  createStubProduct
};
