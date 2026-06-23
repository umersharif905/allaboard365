/**
 * Apply a .sql migration file (idempotent CREATE/ALTER) to testing or prod,
 * splitting on GO batch separators (mssql's sql.query can't parse GO).
 *
 * Usage (inside the backend container with repo env sourced):
 *   node apply-sql.cjs <path-to-sql>            # DRY RUN (prints batches) on testing
 *   node apply-sql.cjs <path-to-sql> --apply    # run on testing
 *   node apply-sql.cjs <path-to-sql> --apply --prod
 */
const fs = require('fs');
const sql = require('mssql');

const file = process.argv[2];
const APPLY = process.argv.includes('--apply');
const PROD = process.argv.includes('--prod');

if (!file) {
  console.error('Usage: node apply-sql.cjs <path-to-sql> [--apply] [--prod]');
  process.exit(1);
}

const dbConfig = {
  server: process.env.DB_SERVER,
  database: PROD ? 'allaboard-prod' : 'allaboard-testing',
  user: PROD ? process.env.DB_USER : process.env.DB_USER_TESTING_RW || process.env.DB_USER,
  password: PROD ? process.env.DB_PASSWORD : process.env.DB_PASSWORD_TESTING_RW || process.env.DB_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false }
};

async function main() {
  const text = fs.readFileSync(file, 'utf8');
  const batches = text
    .split(/^\s*GO\s*$/im)
    .map((b) => b.trim())
    .filter(Boolean);
  console.log(`\n=== apply-sql ${file} — ${PROD ? 'PROD' : 'TESTING'} — ${APPLY ? 'APPLY' : 'DRY RUN'} ===`);
  console.log(`${batches.length} batch(es).`);
  if (!APPLY) {
    batches.forEach((b, i) => console.log(`\n--- batch ${i + 1} ---\n${b.slice(0, 200)}${b.length > 200 ? '…' : ''}`));
    console.log('\nDry run only — re-run with --apply to execute.');
    return;
  }
  await sql.connect(dbConfig);
  console.log(`📌 ${dbConfig.server} / ${dbConfig.database}`);
  for (let i = 0; i < batches.length; i++) {
    await new sql.Request().batch(batches[i]);
    console.log(`✅ batch ${i + 1}/${batches.length} done`);
  }
  await sql.close();
}

main().catch((e) => {
  console.error('❌', e.message);
  process.exit(1);
});
