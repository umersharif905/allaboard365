/**
 * Apply a sql-changes/*.sql file using backend .env DB credentials.
 * Splits on standalone GO lines (SQL Server batch separator); mssql driver does not accept GO.
 *
 * Usage: node scripts/apply-sql-file.js ../sql-changes/2026-04-09-member-communication-preferences.sql
 */
const fs = require('fs');
const path = require('path');
const sql = require('mssql');

require('dotenv').config({
  path: path.join(__dirname, '..', '.env'),
  override: true
});

const rel = process.argv[2];
if (!rel) {
  console.error('Usage: node scripts/apply-sql-file.js <path-to.sql>');
  process.exit(1);
}

const sqlPath = path.isAbsolute(rel) ? rel : path.join(process.cwd(), rel);
if (!fs.existsSync(sqlPath)) {
  console.error('File not found:', sqlPath);
  process.exit(1);
}

const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  options: {
    encrypt: true,
    trustServerCertificate: false,
    enableArithAbort: true,
    connectionTimeout: 60000,
    requestTimeout: 120000
  }
};

function splitBatches(raw) {
  return raw
    .split(/^\s*GO\s*$/gim)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

(async () => {
  if (!dbConfig.user || !dbConfig.password || !dbConfig.server || !dbConfig.database) {
    console.error('Missing DB_USER, DB_PASSWORD, DB_SERVER, or DB_NAME in environment / .env');
    process.exit(1);
  }

  const raw = fs.readFileSync(sqlPath, 'utf8');
  const batches = splitBatches(raw);
  console.log(`Applying ${sqlPath} (${batches.length} batch(es)) → ${dbConfig.server} / ${dbConfig.database}`);

  const pool = await sql.connect(dbConfig);
  try {
    for (let i = 0; i < batches.length; i++) {
      const preview = batches[i].slice(0, 80).replace(/\s+/g, ' ');
      console.log(`Batch ${i + 1}/${batches.length}: ${preview}…`);
      await pool.request().query(batches[i]);
    }
    console.log('✅ Migration finished successfully.');
  } finally {
    await pool.close();
  }
})().catch((err) => {
  console.error('❌ Migration failed:', err.message);
  process.exit(1);
});
