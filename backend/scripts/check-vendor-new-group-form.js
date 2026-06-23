/**
 * Check ARM (or any vendor) NewGroupFormConfig in DB (same DB as backend).
 * Usage: node scripts/check-vendor-new-group-form.js 406B4EEA-F334-4EFC-82D5-89545E55CC01
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { getPool } = require('../config/database');
const sql = require('mssql');

const vendorId = process.argv[2] || '406B4EEA-F334-4EFC-82D5-89545E55CC01';

async function main() {
  const pool = await getPool();
  const r = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .query('SELECT VendorId, VendorName, NewGroupFormConfig, ModifiedDate FROM oe.Vendors WHERE VendorId = @vendorId');
  const row = r.recordset[0];
  if (!row) {
    console.log('Vendor not found:', vendorId);
    process.exit(1);
  }
  console.log('Vendor:', row.VendorName, '| ModifiedDate:', row.ModifiedDate);
  const raw = row.NewGroupFormConfig;
  if (!raw || !raw.trim()) {
    console.log('NewGroupFormConfig: (empty)');
    process.exit(0);
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch (e) {
    console.log('NewGroupFormConfig: invalid JSON');
    process.exit(1);
  }
  const fields = config.fields || [];
  console.log('Form title:', config.formTitle || '(none)');
  console.log('Fields (' + fields.length + '):');
  fields.forEach((f, i) => {
    const sv = (f.systemVariable ?? '').trim();
    const addr = sv === 'group.PhysicalAddress' || sv === 'group.Address' ? ' <-- address mapping' : '';
    console.log('  ', i + 1, '| label:', (f.label || '').slice(0, 30).padEnd(30), '| map:', sv || '(blank)' + addr);
  });
  const addressField = fields.find((f) => (f.label || '').toLowerCase().includes('address') || (f.key || '').toLowerCase().includes('address'));
  if (addressField) {
    console.log('\nAddress field in config:');
    console.log('  systemVariable:', JSON.stringify(addressField.systemVariable));
    console.log('  Saved correctly:', addressField.systemVariable === 'group.PhysicalAddress' ? 'YES' : 'NO (expected group.PhysicalAddress)');
  }
  const productIdFields = fields.filter((f) => (f.systemVariable || '').startsWith('group.vendorProductGroupId_') && (f.systemVariable || '').length > 35);
  if (productIdFields.length) {
    console.log('\nProduct group ID fields (by ProductId):');
    productIdFields.forEach((f) => console.log('  ', f.label, '->', f.systemVariable));
    console.log('  Tip: For "CoPay Group ID" / "HSA Group ID" use "CoPay (group id by type)" / "HSA (group id by type)" so the value resolves for any group product of that type.');
  }
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
