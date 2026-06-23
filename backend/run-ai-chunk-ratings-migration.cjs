#!/usr/bin/env node
// Run 2026-05-21-ai-chunk-ratings.sql against allaboard-prod

const sql = require('mssql');
const fs = require('fs');
const path = require('path');

const config = {
  server: 'allboard-prod.database.windows.net',
  database: 'allaboard-prod',
  user: 'allaboardadmin',
  password: 'AllAboard2026$',
  options: { encrypt: true, trustServerCertificate: false },
};

const migrationPath = path.join(__dirname, '../sql-changes/2026-05-21-ai-chunk-ratings.sql');
const migrationSql = fs.readFileSync(migrationPath, 'utf8');

// mssql doesn't support GO — strip it; the migration wraps itself in BEGIN/COMMIT.
const cleanSql = migrationSql
  .split('\n')
  .filter(line => line.trim().toUpperCase() !== 'GO')
  .join('\n');

async function main() {
  const pool = await sql.connect(config);
  console.log('Connected to allaboard-prod');
  console.log('Running 2026-05-21-ai-chunk-ratings.sql...\n');

  await pool.request().query(cleanSql);

  console.log('Migration complete. Verifying...\n');

  const check = await pool.request().query(`
    SELECT
      CASE WHEN OBJECT_ID('oe.AIChunkRatings') IS NOT NULL THEN 'YES' ELSE 'NO' END AS TableExists,
      CASE WHEN COL_LENGTH('oe.AIChunkRatings', 'Rating') IS NOT NULL THEN 'YES' ELSE 'NO' END AS RatingColExists,
      CASE WHEN COL_LENGTH('oe.AIChunkRatings', 'AIChunkId') IS NOT NULL THEN 'YES' ELSE 'NO' END AS AIChunkIdColExists
  `);

  const r = check.recordset[0];
  console.log('Verification:');
  console.log(`  oe.AIChunkRatings table:   ${r.TableExists}`);
  console.log(`  Rating column:             ${r.RatingColExists}`);
  console.log(`  AIChunkId column:          ${r.AIChunkIdColExists}`);

  await pool.close();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
