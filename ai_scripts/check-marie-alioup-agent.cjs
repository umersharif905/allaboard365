#!/usr/bin/env node
/**
 * Confirm Marie Kamm is a qualified agent for the Alioup agency.
 * Run from repo root: node ai_scripts/check-marie-alioup-agent.cjs
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

    // 1) Get Alioup agency
    const agencyResult = await sql.query(`
      SELECT AgencyId, AgencyName, TenantId, OwnerAgentId, Status
      FROM oe.Agencies
      WHERE AgencyName = 'Alioup'
    `);
    if (agencyResult.recordset.length === 0) {
      console.log('Agency "Alioup" not found.');
      await sql.close();
      return;
    }
    const agency = agencyResult.recordset[0];
    const agencyId = agency.AgencyId;
    console.log('Alioup agency:', JSON.stringify(agency, null, 2));
    console.log('');

    // 2) Get agents for this agency (Marie Kamm by name or email)
    const agentsResult = await sql.query(`
      SELECT
        a.AgentId,
        a.AgencyId,
        a.TenantId,
        a.Status AS AgentStatus,
        u.FirstName,
        u.LastName,
        u.Email,
        u.PhoneNumber
      FROM oe.Agents a
      INNER JOIN oe.Users u ON a.UserId = u.UserId
      WHERE a.AgencyId = '${agencyId}'
        AND (u.FirstName + ' ' + u.LastName LIKE '%Marie%' OR u.Email LIKE '%marie%')
    `);
    console.log('Agents for Alioup matching Marie:');
    console.log(JSON.stringify(agentsResult.recordset, null, 2));
    console.log('Count:', agentsResult.recordset.length);
    console.log('');

    if (agentsResult.recordset.length === 0) {
      console.log('No agent named Marie found for Alioup agency.');
      await sql.close();
      return;
    }

    // 3) Check licenses (qualified = has active license if required)
    const agentId = agentsResult.recordset[0].AgentId;
    const licensesResult = await sql.query(`
      SELECT LicenseId, StateCode, Status, ExpirationDate
      FROM oe.AgentLicenses
      WHERE AgentId = '${agentId}'
      ORDER BY Status, ExpirationDate
    `);
    console.log('Licenses for this agent:');
    console.log(JSON.stringify(licensesResult.recordset, null, 2));
    const activeLicenses = (licensesResult.recordset || []).filter(l => l.Status === 'Active');
    console.log('Active licenses:', activeLicenses.length);
    console.log('');

    const row = agentsResult.recordset[0];
    const isActive = row.AgentStatus === 'Active';
    const hasActiveLicense = activeLicenses.length > 0;
    console.log('Summary:');
    console.log('  Agent:', row.FirstName, row.LastName, row.Email);
    console.log('  Status:', row.AgentStatus, isActive ? '(Active)' : '');
    console.log('  Qualified (Active agent with agency):', isActive ? 'Yes' : 'No');
    console.log('  Has active license(s):', hasActiveLicense ? 'Yes' : 'No');
    console.log('  Marie Kamm is a qualified agent for Alioup:', isActive ? 'Yes' : 'No');

    await sql.close();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

run();
