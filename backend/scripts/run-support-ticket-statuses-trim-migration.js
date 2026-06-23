/**
 * One-shot runner for sql-changes/2026-05-19-support-ticket-statuses-trim.sql.
 *
 * Usage (from host):
 *   sudo docker exec allaboard365-backend \
 *     node /app/backend/scripts/run-support-ticket-statuses-trim-migration.js
 *
 * Idempotent — re-running on a fully-migrated DB matches zero rows.
 */
const path = require('path');
const fs = require('fs');
const sql = require('mssql');

require('dotenv').config({
    path: path.join(__dirname, '..', '.env'),
    override: true
});

const sqlFile = path.join(
    __dirname, '..', '..', 'sql-changes',
    '2026-05-19-support-ticket-statuses-trim.sql'
);

async function main() {
    const content = fs.readFileSync(sqlFile, 'utf8');
    const batches = content
        .split(/^\s*GO\s*$/gim)
        .map((b) => b.trim())
        .filter((b) => b.length > 0);

    const config = {
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

    console.log(`Connecting to ${config.server} / ${config.database}`);
    const pool = await sql.connect(config);

    for (let i = 0; i < batches.length; i++) {
        const label = `Batch ${i + 1}/${batches.length}`;
        try {
            const result = await pool.request().query(batches[i]);
            if (result.recordset && result.recordset.length > 0) {
                console.log(`${label} rows:`);
                console.table(result.recordset);
            } else {
                console.log(`${label}: ok`);
            }
        } catch (err) {
            console.error(`${label}: FAILED`);
            console.error('SQL (first 400 chars):', batches[i].slice(0, 400));
            console.error('Error:', err.message);
            throw err;
        }
    }

    await pool.close();
    console.log('Migration finished successfully.');
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
