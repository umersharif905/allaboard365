require('dotenv').config();
const { getPool, sql } = require('./backend/config/database');

async function testEmailSettings() {
  try {
    console.log('Testing email settings preservation...');
    const pool = await getPool();
    
    const result = await pool.request()
      .query(`SELECT TOP 1 TenantId, AdvancedSettings FROM oe.Tenants WHERE AdvancedSettings LIKE '%sendgridDomainId%'`);
    
    if (result.recordset.length > 0) {
      const tenant = result.recordset[0];
      const settings = JSON.parse(tenant.AdvancedSettings);
      console.log('\nCurrent email settings:');
      console.log(JSON.stringify(settings.email, null, 2));
    } else {
      console.log('No tenants with DKIM settings found');
    }
  } catch (error) {
    console.error('Error:', error.message);
  }
}

testEmailSettings();
