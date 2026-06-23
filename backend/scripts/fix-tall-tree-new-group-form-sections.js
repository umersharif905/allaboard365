/**
 * Set fieldType to 'labelHeader' for section fields in Tall Tree's NewGroupFormConfig
 * so "Business Information", "Broker Contact", etc. render as headers, not (missing) fields.
 * Usage: node scripts/fix-tall-tree-new-group-form-sections.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { getPool } = require('../config/database');
const sql = require('mssql');

const TALL_TREE_VENDOR_ID = 'C34859BA-1B50-4AE8-9A14-2DC7794886A4';

async function main() {
  const pool = await getPool();
  const r = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, TALL_TREE_VENDOR_ID)
    .query('SELECT VendorId, VendorName, NewGroupFormConfig FROM oe.Vendors WHERE VendorId = @vendorId');
  const row = r.recordset[0];
  if (!row) {
    console.log('Vendor not found:', TALL_TREE_VENDOR_ID);
    process.exit(1);
  }
  const raw = row.NewGroupFormConfig;
  if (!raw || !raw.trim()) {
    console.log('NewGroupFormConfig empty');
    process.exit(1);
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch (e) {
    console.error('Invalid JSON:', e.message);
    process.exit(1);
  }
  const fields = config.fields || [];
  let updated = 0;
  for (const f of fields) {
    const key = (f.key || '').trim();
    if (key.startsWith('section') || key === 'sectionBusinessInfo' || key === 'sectionBusinessOwner' || key === 'sectionPrimaryContact' || key === 'sectionBroker' || key === 'sectionLicensedAgent') {
      if (f.fieldType !== 'labelHeader') {
        f.fieldType = 'labelHeader';
        updated++;
        console.log('  labelHeader:', f.label || key);
      }
    }
  }
  if (updated === 0) {
    console.log('No changes needed');
    process.exit(0);
  }
  const newJson = JSON.stringify(config);
  await pool.request()
    .input('vendorId', sql.UniqueIdentifier, TALL_TREE_VENDOR_ID)
    .input('config', sql.NVarChar(sql.MAX), newJson)
    .query(`
      UPDATE oe.Vendors
      SET NewGroupFormConfig = @config, ModifiedDate = GETUTCDATE()
      WHERE VendorId = @vendorId
    `);
  console.log('Updated', updated, 'section field(s) to labelHeader for', row.VendorName);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
