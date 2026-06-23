/**
 * Test script to verify tenant logo retrieval for custom domain
 * Usage: node backend/scripts/test-tenant-logo-query.js portal.mightywellhealth.com
 */

const { getPool, sql } = require('../config/database');

async function testTenantLogoQuery(hostname) {
  try {
    console.log(`🔍 Testing tenant logo query for hostname: ${hostname}`);
    
    const pool = await getPool();
    const request = pool.request();
    request.input('hostname', sql.NVarChar(255), hostname);
    
    const query = `
      SELECT 
        t.TenantId,
        t.Name,
        t.DefaultUrlPath as UrlPath,
        t.CustomDomain,
        t.CustomLogoUrl,
        json_value(t.AdvancedSettings, '$.domain.customDomain') as CustomDomainFromJson,
        t.AdvancedSettings,
        ISNULL(t.CustomLogoUrl, ISNULL(NULLIF(json_value(t.AdvancedSettings, '$.branding.logoUrl'), ''), '/images/branding/allaboard365/allaboard365-logo-transparent.png')) as LogoUrl,
        ISNULL(json_value(t.AdvancedSettings, '$.branding.colors.primary'), '#1f6db0') as PrimaryColorHex,
        ISNULL(json_value(t.AdvancedSettings, '$.branding.colors.secondary'), '#424242') as SecondaryColorHex
      FROM oe.Tenants t
      WHERE (t.CustomDomain = @hostname OR json_value(t.AdvancedSettings, '$.domain.customDomain') = @hostname)
        AND t.Status = 'Active'
    `;
    
    console.log(`🔍 Executing query...`);
    const result = await request.query(query);
    
    console.log(`🔍 Records found: ${result.recordset.length}`);
    
    if (result.recordset.length > 0) {
      const tenant = result.recordset[0];
      
      console.log(`\n✅ TENANT FOUND:`);
      console.log(`   Tenant ID: ${tenant.TenantId}`);
      console.log(`   Name: ${tenant.Name}`);
      console.log(`   CustomDomain field: ${tenant.CustomDomain}`);
      console.log(`   CustomDomainFromJson: ${tenant.CustomDomainFromJson}`);
      console.log(`   CustomLogoUrl: ${tenant.CustomLogoUrl}`);
      console.log(`   LogoUrl (from query): ${tenant.LogoUrl}`);
      console.log(`   Primary Color: ${tenant.PrimaryColorHex}`);
      console.log(`   Secondary Color: ${tenant.SecondaryColorHex}`);
      
      // Parse AdvancedSettings to check logo URL
      if (tenant.AdvancedSettings) {
        try {
          const advancedSettings = typeof tenant.AdvancedSettings === 'string' 
            ? JSON.parse(tenant.AdvancedSettings) 
            : tenant.AdvancedSettings;
          
          console.log(`\n🔍 AdvancedSettings.branding.logoUrl: ${advancedSettings?.branding?.logoUrl || 'NOT FOUND'}`);
          console.log(`🔍 AdvancedSettings structure:`, JSON.stringify(advancedSettings?.branding || {}, null, 2));
        } catch (parseError) {
          console.error(`❌ Error parsing AdvancedSettings:`, parseError.message);
        }
      }
      
      // Test the JavaScript fallback
      if (!tenant.LogoUrl || tenant.LogoUrl === '/images/branding/allaboard365/allaboard365-logo-transparent.png' || tenant.LogoUrl.trim() === '') {
        console.log(`\n⚠️ Logo URL is empty or default, testing JavaScript fallback...`);
        if (tenant.AdvancedSettings) {
          try {
            const advancedSettings = typeof tenant.AdvancedSettings === 'string' 
              ? JSON.parse(tenant.AdvancedSettings) 
              : tenant.AdvancedSettings;
            
            if (advancedSettings?.branding?.logoUrl) {
              console.log(`✅ JavaScript fallback would set LogoUrl to: ${advancedSettings.branding.logoUrl}`);
            } else {
              console.log(`❌ JavaScript fallback: No logoUrl found in AdvancedSettings.branding`);
            }
          } catch (parseError) {
            console.error(`❌ JavaScript fallback: Error parsing AdvancedSettings:`, parseError.message);
          }
        }
      }
      
    } else {
      console.log(`\n❌ NO TENANT FOUND for hostname: ${hostname}`);
      console.log(`\n🔍 Testing with different variations...`);
      
      // Try without subdomain
      const rootDomain = hostname.split('.').slice(-2).join('.');
      console.log(`   Trying root domain: ${rootDomain}`);
      request.input('hostname2', sql.NVarChar(255), rootDomain);
      const result2 = await request.query(query.replace('@hostname', '@hostname2'));
      console.log(`   Records found: ${result2.recordset.length}`);
    }
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

const hostname = process.argv[2] || 'portal.mightywellhealth.com';
testTenantLogoQuery(hostname);


