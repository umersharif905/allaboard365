#!/usr/bin/env node
/**
 * Diagnostic: same DB as backend, check schema + data for create-marketing 404.
 * Run from repo root: node ai_scripts/check-enrollment-create-marketing.cjs
 *
 * Confirms:
 * 1) oe.EnrollmentLinks.AgentId allows NULL
 * 2) Agency 38AA6EB4-... exists in oe.Agencies
 * 3) Template row has AgencyId set (and which templateId to use)
 */
const path = require('path');
const fs = require('fs');

// Load BACKEND .env (same DB as API)
const backendEnvPath = path.join(__dirname, '..', 'backend', '.env');
if (fs.existsSync(backendEnvPath)) {
  const envContent = fs.readFileSync(backendEnvPath, 'utf8');
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
  console.log('Loaded backend .env from', backendEnvPath);
} else {
  console.error('Backend .env not found at', backendEnvPath);
  process.exit(1);
}

const sql = require(path.join(__dirname, '..', 'backend', 'node_modules', 'mssql'));
const config = {
  server: process.env.DB_SERVER || 'oe-sql-srvr.database.windows.net',
  database: process.env.DB_NAME || 'open-enroll-dev',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false },
};

const AGENCY_ID = '38AA6EB4-3BC1-450E-87F1-8984A4B916C5';
const TENANT_ID = '349AF85B-1AB0-41A1-8D0E-8EEC82AC971F';

async function run() {
  if (!config.password) {
    console.error('DB_PASSWORD not set in backend/.env');
    process.exit(1);
  }
  try {
    console.log('Using DB:', config.server, config.database, '\n');
    await sql.connect(config);

    // 1) EnrollmentLinks: AgentId nullability
    const schemaResult = await sql.query(`
      SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = 'oe' AND TABLE_NAME = 'EnrollmentLinks'
        AND COLUMN_NAME IN ('AgentId', 'AgencyId')
      ORDER BY ORDINAL_POSITION
    `);
    console.log('1) oe.EnrollmentLinks – AgentId / AgencyId:');
    if (schemaResult.recordset.length === 0) {
      console.log('   No columns found (table/schema name?).');
    } else {
      schemaResult.recordset.forEach((r) => {
        const ok = r.COLUMN_NAME === 'AgentId' ? r.IS_NULLABLE === 'YES' : true;
        console.log('   ', r.COLUMN_NAME, r.DATA_TYPE, 'IS_NULLABLE=', r.IS_NULLABLE, ok ? '✅' : '❌ AgentId must allow NULL');
      });
    }

    // 2) Agency by ID only (no tenant)
    const agencyResult = await sql.query(`
      SELECT AgencyId, TenantId, AgencyName, Status, OwnerAgentId
      FROM oe.Agencies
      WHERE AgencyId = '${AGENCY_ID}'
    `);
    console.log('\n2) Agency ' + AGENCY_ID + ':');
    if (agencyResult.recordset.length === 0) {
      console.log('   ❌ NOT FOUND. create-marketing will always 404 until this row exists in oe.Agencies.');
    } else {
      const ag = agencyResult.recordset[0];
      console.log('   AgencyName:', ag.AgencyName, '| TenantId:', ag.TenantId, '| Status:', ag.Status, '| OwnerAgentId:', ag.OwnerAgentId ?? 'NULL');
      const tenantMatch = String(ag.TenantId || '').toLowerCase() === TENANT_ID.toLowerCase();
      console.log('   Tenant matches header 349AF85B...?', tenantMatch ? '✅' : '❌ (template creation may still fail or use different tenant)');
    }

    // 3) Agency with tenant filter (what template creation uses)
    const agencyTenantResult = await sql.query(`
      SELECT AgencyId, TenantId, AgencyName
      FROM oe.Agencies
      WHERE AgencyId = '${AGENCY_ID}' AND TenantId = '${TENANT_ID}'
    `);
    console.log('\n3) Agency with TenantId = 349AF85B... (template creation check):');
    if (agencyTenantResult.recordset.length === 0) {
      console.log('   ❌ NOT FOUND. Template creation would return 400 "Selected agent or agency does not belong to your tenant."');
    } else {
      console.log('   ✅ Found – template creation can succeed.');
    }

    // 4) Recent Individual templates with this AgencyId
    const templatesResult = await sql.query(`
      SELECT TOP 5 TemplateId, TemplateName, TenantId, AgentId, AgencyId, IsActive
      FROM oe.EnrollmentLinkTemplates
      WHERE TemplateType = 'Individual' AND (AgencyId = '${AGENCY_ID}' OR AgentId = '${AGENCY_ID}')
      ORDER BY ModifiedDate DESC
    `);
    console.log('\n4) Recent Individual templates with AgencyId/AgentId = 38AA...:');
    if (templatesResult.recordset.length === 0) {
      console.log('   No templates found. Create one first; then create-marketing uses template.AgencyId.');
    } else {
      templatesResult.recordset.forEach((t) => {
        console.log('   ', t.TemplateId, '| AgencyId:', t.AgencyId ?? 'NULL', '| AgentId:', t.AgentId ?? 'NULL', '|', t.TemplateName);
      });
    }

    await sql.close();
    console.log('\nDone.');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

run();
