#!/usr/bin/env node
/**
 * Refresh ai_scripts/migration/mightywell-testing-snapshot.json from allaboard-testing (same as --testing db-query).
 * Requires ai_scripts/.env with DB_SERVER, DB_USER, DB_PASSWORD for allboard-prod.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '../..');
require(path.join(repoRoot, 'backend/node_modules/dotenv')).config({
  path: path.join(__dirname, '../.env')
});
const sql = require(path.join(repoRoot, 'node_modules/mssql'));

const MIGHTYWELL_TENANT_ID = '1CD92AF7-B6F2-4E48-A8F3-EC6316158826';

async function main() {
  const server = process.env.DB_SERVER;
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;
  if (!server || !user || !password) {
    console.error('Missing DB_SERVER / DB_USER / DB_PASSWORD in ai_scripts/.env');
    process.exit(1);
  }

  const config = {
    server,
    database: 'allaboard-testing',
    user,
    password,
    options: {
      encrypt: true,
      trustServerCertificate: false,
      requestTimeout: 120000
    }
  };

  const pool = await sql.connect(config);
  try {
    const req = pool.request();
    req.input('tid', sql.UniqueIdentifier, MIGHTYWELL_TENANT_ID);
    const result = await req.query(`
      SELECT t.TenantId, t.Name, t.PaymentProcessorSettings,
             u.PasswordHash AS ReferencePasswordHash, u.Email AS ReferenceEmail
      FROM oe.Tenants t
      OUTER APPLY (
        SELECT TOP 1 PasswordHash, Email FROM oe.Users
        WHERE LOWER(Email) = 'test@mightywell.us' AND PasswordHash IS NOT NULL
      ) u
      WHERE t.TenantId = @tid
    `);
    const row = result.recordset[0];
    if (!row) {
      console.error('MightyWELL tenant not found:', MIGHTYWELL_TENANT_ID);
      process.exit(1);
    }
    if (!row.ReferencePasswordHash) {
      console.error('No reference user test@mightywell.us with PasswordHash in allaboard-testing.');
      process.exit(1);
    }

    const out = {
      description:
        'paymentProcessorSettings from MightyWELL Health on allaboard-testing (applied to every tenant during post-bacpac-sanitize). referencePasswordHash from test@mightywell.us. Testing only.',
      capturedAt: new Date().toISOString(),
      sourceDatabase: 'allaboard-testing',
      mightyWellTenantId: row.TenantId,
      tenantName: row.Name,
      paymentProcessorSettings: row.PaymentProcessorSettings,
      referenceLoginEmail: row.ReferenceEmail || 'test@mightywell.us',
      referencePasswordHash: row.ReferencePasswordHash
    };

    const outPath = path.join(__dirname, 'mightywell-testing-snapshot.json');
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
    console.log('Wrote', outPath);
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
