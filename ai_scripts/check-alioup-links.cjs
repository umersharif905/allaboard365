#!/usr/bin/env node
/**
 * Check Alioup tenant enrollment link templates and oe.EnrollmentLinks.
 * Run from repo root: node ai_scripts/check-alioup-links.cjs
 */
const path = require('path');
const fs = require('fs');

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

// mssql is in backend/node_modules when run from repo
const sql = require(path.join(__dirname, '..', 'backend', 'node_modules', 'mssql'));
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

    // 0) Alioup agency - must have OwnerAgentId for create-marketing/create-static to work
    const agencyId = '38AA6EB4-3BC1-450E-87F1-8984A4B916C5';
    const agencyQuery = `
      SELECT ag.AgencyId, ag.AgencyName, ag.TenantId, ag.OwnerAgentId, ag.Status,
             t.Name AS TenantName
      FROM oe.Agencies ag
      JOIN oe.Tenants t ON ag.TenantId = t.TenantId
      WHERE ag.AgencyId = '${agencyId}'
    `;
    console.log('📋 0) Alioup agency (required for create-marketing/create-static):');
    const agencyResult = await sql.query(agencyQuery);
    if (agencyResult.recordset.length === 0) {
      console.log('   Agency not found.\n');
    } else {
      const ag = agencyResult.recordset[0];
      console.log('   AgencyName:', ag.AgencyName, '| TenantId:', ag.TenantId, '| OwnerAgentId:', ag.OwnerAgentId || 'NULL', '| Status:', ag.Status);
      if (!ag.OwnerAgentId) {
        console.log('   ❌ OwnerAgentId is NULL - create-marketing/create-static need an owner agent to create links.');
      } else {
        console.log('   ✅ OwnerAgentId set - backend can resolve agency to owner for link creation.');
      }
      console.log('');
    }

    // 1) All Alioup enrollment link templates
    const templatesQuery = `
      SELECT elt.TemplateId, elt.TemplateName, elt.TenantId, elt.AgentId, elt.AgencyId,
             elt.TemplateType, elt.IsActive, t.Name AS TenantName
      FROM oe.EnrollmentLinkTemplates elt
      JOIN oe.Tenants t ON elt.TenantId = t.TenantId
      WHERE t.Name LIKE '%Alioup%'
      ORDER BY elt.ModifiedDate DESC
    `;
    console.log('📋 1) Alioup enrollment link templates (oe.EnrollmentLinkTemplates):');
    const templatesResult = await sql.query(templatesQuery);
    if (templatesResult.recordset.length === 0) {
      console.log('   No templates found for Alioup tenant.\n');
    } else {
      console.log('   Count:', templatesResult.recordset.length);
      templatesResult.recordset.forEach((r, i) => {
        console.log(`   [${i + 1}] TemplateName: "${r.TemplateName}" | TemplateId: ${r.TemplateId} | AgencyId: ${r.AgencyId || 'NULL'} | AgentId: ${r.AgentId || 'NULL'}`);
      });
      console.log('');
    }

    // 2) All EnrollmentLinks for Alioup tenant (any template)
    const linksQuery = `
      SELECT el.LinkId, el.EnrollmentLinkTemplateId AS TemplateId, elt.TemplateName,
             el.AgentId, el.LinkType, el.ShortCode, el.IsActive, el.CreatedDate
      FROM oe.EnrollmentLinks el
      JOIN oe.EnrollmentLinkTemplates elt ON el.EnrollmentLinkTemplateId = elt.TemplateId
      JOIN oe.Tenants t ON elt.TenantId = t.TenantId
      WHERE t.Name LIKE '%Alioup%'
        AND (el.LinkType = 'Agent-Static' OR el.LinkType = 'Marketing')
      ORDER BY elt.TemplateName, el.LinkType
    `;
    console.log('📋 2) EnrollmentLinks for Alioup (oe.EnrollmentLinks, LinkType Agent-Static or Marketing):');
    const linksResult = await sql.query(linksQuery);
    if (linksResult.recordset.length === 0) {
      console.log('   ❌ No Marketing or Static links found for any Alioup template.');
      console.log('   → This is why badges do not show: HasStaticLink/HasMarketingLink are 0.');
      console.log('   → If create-marketing/create-static fail with "cannot insert NULL":');
      console.log('     Run sql-changes/enrollment-links-agent-id-nullable.sql to allow AgentId NULL.');
    } else {
      console.log('   Count:', linksResult.recordset.length);
      linksResult.recordset.forEach((r, i) => {
        console.log(`   [${i + 1}] Template: "${r.TemplateName}" | LinkType: ${r.LinkType} | ShortCode: ${r.ShortCode} | IsActive: ${r.IsActive}`);
      });
    }

    await sql.close();
    console.log('\n✅ Done.');
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

run();
