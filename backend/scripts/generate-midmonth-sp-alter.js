#!/usr/bin/env node
// backend/scripts/generate-midmonth-sp-alter.js
require('dotenv').config();
const sql = require('mssql');
const fs = require('fs');
const path = require('path');

const TARGET_DB = process.env.TARGET_DB || process.env.DB_NAME;

async function extractSp(pool, spName) {
  const r = await pool.request().input('n', sql.NVarChar, spName).query(`
    SELECT m.definition
    FROM sys.sql_modules m
    INNER JOIN sys.objects o ON o.object_id = m.object_id
    INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
    WHERE s.name = 'oe' AND o.name = @n
  `);
  return r.recordset[0]?.definition;
}

async function main() {
  const pool = await sql.connect({
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER, database: TARGET_DB,
    options: { encrypt: true, trustServerCertificate: false }
  });

  for (const name of ['sp_CalculateGroupTotalPremium', 'sp_GenerateGroupInvoices']) {
    const def = await extractSp(pool, name);
    if (!def) {
      console.log(`NOT FOUND on ${TARGET_DB}: ${name}`);
      continue;
    }
    const out = path.join('/tmp', `oe.${name}.${TARGET_DB}.backup.sql`);
    fs.writeFileSync(out, def);
    console.log(`Saved: ${out}`);
  }

  await pool.close();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
