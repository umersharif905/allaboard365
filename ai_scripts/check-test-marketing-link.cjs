#!/usr/bin/env node
/**
 * Check if the "test" enrollment link template is set up correctly as a Marketing link.
 * Uses ai_scripts/.env for DB config. Run from repo root: node ai_scripts/check-test-marketing-link.cjs
 * Or from backend (with env loaded): node -r dotenv/config ../ai_scripts/check-test-marketing-link.cjs (dotenv from backend)
 */
const path = require('path');
const fs = require('fs');

// Load ai_scripts/.env manually so we can run from any cwd
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
        process.env[key] = val;
      }
    }
  });
}

const sql = require('mssql');
const config = {
  server: process.env.DB_SERVER || 'oe-sql-srvr.database.windows.net',
  database: process.env.DB_NAME || 'open-enroll-dev',
  user: process.env.DB_USER || 'oe-sqladmin',
  password: process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false }
};

async function run() {
  if (!config.password) {
    console.error('❌ DB_PASSWORD not set. Check ai_scripts/.env');
    process.exit(1);
  }
  try {
    console.log('🔍 Connecting to database...', config.server, config.database);
    await sql.connect(config);
    console.log('✅ Connected\n');

    // 1) "test" template in EnrollmentLinkTemplates
    const templateQuery = `
      SELECT elt.TemplateId, elt.TemplateName, elt.TenantId, elt.AgentId, elt.AgencyId,
             elt.TemplateType, elt.IsActive, t.Name AS TenantName
      FROM oe.EnrollmentLinkTemplates elt
      LEFT JOIN oe.Tenants t ON elt.TenantId = t.TenantId
      WHERE elt.TemplateName = 'test'
    `;
    console.log('📋 1) "test" template in oe.EnrollmentLinkTemplates:');
    console.log('   Query:', templateQuery.trim().replace(/\s+/g, ' '));
    const templateResult = await sql.query(templateQuery);
    if (templateResult.recordset.length === 0) {
      console.log('   No template named "test" found.\n');
    } else {
      console.log('   Result:', JSON.stringify(templateResult.recordset, null, 2));
      const templateId = templateResult.recordset[0].TemplateId;
      console.log('   TemplateId (for links check):', templateId);
      console.log('');

      // 2) EnrollmentLinks for this template (Marketing / Agent-Static)
      const linksQuery = `
        SELECT el.LinkId, el.EnrollmentLinkTemplateId AS TemplateId, el.AgentId, el.LinkType,
               el.ShortCode, el.IsActive, el.CreatedDate
        FROM oe.EnrollmentLinks el
        WHERE el.EnrollmentLinkTemplateId = '${templateId}'
          AND (el.LinkType = 'Agent-Static' OR el.LinkType = 'Marketing')
        ORDER BY el.LinkType
      `;
      console.log('📋 2) Links in oe.EnrollmentLinks for this template (Agent-Static / Marketing):');
      const linksResult = await sql.query(linksQuery);
      if (linksResult.recordset.length === 0) {
        console.log('   No Marketing or Static links found for template "test".');
        console.log('   → Template is NOT set up as a Marketing link (no row in EnrollmentLinks with LinkType = \'Marketing\').');
      } else {
        console.log('   Result:', JSON.stringify(linksResult.recordset, null, 2));
        const hasMarketing = linksResult.recordset.some((r) => r.LinkType === 'Marketing');
        if (hasMarketing) {
          console.log('   ✅ Template "test" HAS a Marketing link.');
        } else {
          console.log('   ⚠️ Template "test" has link(s) but none with LinkType = \'Marketing\' (e.g. only Agent-Static).');
        }
      }
    }

    await sql.close();
    console.log('\n✅ Done.');
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

run();
