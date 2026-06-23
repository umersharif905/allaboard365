/**
 * Update any vendor's NewGroupFormConfig: for fields whose systemVariable is
 * group.vendorProductGroupId_<ProductId>, look up that product's ProductType in the DB
 * and set systemVariable to group.vendorProductGroupId_<ProductType>. So one field
 * works for any group that has a product of that type (no hardcoded product names/IDs).
 * Usage: node scripts/fix-arm-new-group-form-product-ids.js <VendorId>
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { getPool } = require('../config/database');
const sql = require('mssql');

const vendorId = process.argv[2];
if (!vendorId) {
  console.log('Usage: node scripts/fix-arm-new-group-form-product-ids.js <VendorId>');
  process.exit(1);
}

const UUID_REGEX = /^group\.vendorProductGroupId_([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

async function getProductTypeForProduct(pool, vendorId, productId) {
  const r = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('productId', sql.UniqueIdentifier, productId)
    .query(`
      SELECT TOP 1 vgi.ProductType
      FROM oe.GroupProductVendorGroupIds vgi
      INNER JOIN oe.GroupProducts gp ON vgi.GroupProductId = gp.GroupProductId
      WHERE vgi.VendorId = @vendorId AND gp.ProductId = @productId
        AND vgi.ProductType IS NOT NULL AND LTRIM(RTRIM(vgi.ProductType)) != ''
        AND vgi.ProductType != 'Master'
    `);
  const row = (r.recordset || [])[0];
  return row ? (row.ProductType || '').toString().trim() : null;
}

async function main() {
  const pool = await getPool();
  const r = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .query('SELECT VendorId, VendorName, NewGroupFormConfig FROM oe.Vendors WHERE VendorId = @vendorId');
  const row = r.recordset[0];
  if (!row) {
    console.log('Vendor not found:', vendorId);
    process.exit(1);
  }
  const raw = row.NewGroupFormConfig;
  if (!raw || !raw.trim()) {
    console.log('NewGroupFormConfig empty');
    process.exit(0);
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch (e) {
    console.log('NewGroupFormConfig invalid JSON');
    process.exit(1);
  }
  const fields = config.fields || [];
  let changed = false;
  for (const f of fields) {
    const sv = (f.systemVariable || '').trim();
    const m = sv.match(UUID_REGEX);
    if (!m) continue;
    const productId = m[1];
    const productType = await getProductTypeForProduct(pool, vendorId, productId);
    if (!productType) continue;
    const newSv = 'group.vendorProductGroupId_' + productType;
    if (sv === newSv) continue;
    console.log('Updating', f.label || f.key, ':', sv, '->', newSv);
    f.systemVariable = newSv;
    changed = true;
  }
  if (!changed) {
    console.log('No product group ID fields needed updating.');
    process.exit(0);
  }
  config.fields = fields;
  const json = JSON.stringify(config);
  await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('config', sql.NVarChar(sql.MAX), json)
    .query('UPDATE oe.Vendors SET NewGroupFormConfig = @config, ModifiedDate = GETUTCDATE() WHERE VendorId = @vendorId');
  console.log('Saved.', row.VendorName, 'New Group Form config updated.');
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
