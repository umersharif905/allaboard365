#!/usr/bin/env node
/**
 * Check Alioup agency has an agent assigned (OwnerAgentId).
 * Run from repo root: node ai_scripts/check-alioup-agency-owner.cjs
 */
const path = require('path');
const fs = require('fs');

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
}

const sql = require(path.join(__dirname, '..', 'backend', 'node_modules', 'mssql'));
const config = {
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false },
};

async function run() {
  try {
    await sql.connect(config);
    console.log('Querying oe.Agencies for AgencyName = \'Alioup\'...\n');

    const result = await sql.query(`
      SELECT AgencyId, AgencyName, TenantId, OwnerAgentId, Status
      FROM oe.Agencies
      WHERE AgencyName = 'Alioup'
    `);

    console.log('Results:');
    console.log(JSON.stringify(result.recordset, null, 2));
    console.log('\nTotal rows:', result.recordset.length);

    if (result.recordset.length > 0) {
      const row = result.recordset[0];
      const hasOwner = row.OwnerAgentId != null;
      console.log('\nAlioup agency OwnerAgentId:', row.OwnerAgentId ?? 'NULL');
      console.log(hasOwner ? '✅ Agency has an agent assigned.' : '❌ Agency has NO agent assigned (OwnerAgentId is NULL).');
    }

    await sql.close();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

run();
