// Runs a .sql migration file against the DB configured in backend/.env,
// splitting on `GO` batch separators (which the mssql driver does not parse).
// Surfaces PRINT output and any verification recordsets.
// Usage (inside backend container):
//   node /app/ai_scripts/run-sql-file.js /app/sql-changes/<file>.sql
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: '/app/backend/.env' });
const sql = require('mssql');

const file = process.argv[2];
if (!file) { console.error('Usage: run-sql-file.js <path-to-sql>'); process.exit(2); }

const raw = fs.readFileSync(file, 'utf8');
// Split on lines containing only GO (optionally with trailing semicolon / whitespace).
const batches = raw
  .split(/^\s*GO\s*;?\s*$/im)
  .map(b => b.trim())
  .filter(b => b.length > 0);

(async () => {
  const pool = await sql.connect({
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER, database: process.env.DB_NAME,
    options: { encrypt: true, trustServerCertificate: false },
  });
  console.log(`DB=${process.env.DB_NAME}  file=${path.basename(file)}  batches=${batches.length}`);
  for (let i = 0; i < batches.length; i++) {
    const req = pool.request();
    req.on('info', m => console.log('  PRINT:', m.message));
    try {
      const r = await req.query(batches[i]);
      if (r.recordset && r.recordset.length) {
        console.log(`  [batch ${i + 1}] result:`);
        console.table(r.recordset);
      }
    } catch (e) {
      console.error(`  [batch ${i + 1}] ERROR:`, e.message);
      console.error('  --- batch source (first 200 chars) ---\n', batches[i].slice(0, 200));
      process.exit(1);
    }
  }
  console.log('DONE OK');
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
