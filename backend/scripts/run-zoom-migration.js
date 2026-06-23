// One-off runner for the Zoom Call Center migration.
//   node scripts/run-zoom-migration.js            # DRY RUN (read-only preview)
//   node scripts/run-zoom-migration.js --apply    # APPLY (sets @DryRun = 0)
// Connects to whatever DB backend/.env points at (allaboard-testing locally).
// Captures PRINT messages (info stream) as well as result sets.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sql = require('mssql');

const APPLY = process.argv.includes('--apply');
const sqlPath = path.join(
    __dirname,
    '..', '..', 'sql-changes', '2026-05-20-zoom-call-center-transcripts-and-agents.sql'
);

let script = fs.readFileSync(sqlPath, 'utf8');
if (APPLY) {
    script = script.replace('DECLARE @DryRun BIT = 1;', 'DECLARE @DryRun BIT = 0;');
}

const config = {
    server: process.env.DB_SERVER,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    options: { encrypt: true, trustServerCertificate: false },
};

(async () => {
    console.log(`Target: ${config.server} / ${config.database}`);
    console.log(`Mode:   ${APPLY ? 'APPLY (@DryRun = 0)' : 'DRY RUN (@DryRun = 1)'}`);
    console.log('-----------------------------------------------------------');
    const pool = await sql.connect(config);
    pool.on('info', (msg) => console.log('  ' + (msg.message || msg)));
    const req = pool.request();
    req.on('info', (msg) => console.log('  ' + (msg.message || msg)));
    const result = await req.query(script);
    if (result.recordsets && result.recordsets.length) {
        result.recordsets.forEach((rs, i) => {
            console.log(`\n--- result set ${i + 1} (${rs.length} rows) ---`);
            console.table(rs);
        });
    }
    await pool.close();
    console.log('\nDone.');
})().catch((err) => {
    console.error('ERROR:', err.message);
    process.exit(1);
});
