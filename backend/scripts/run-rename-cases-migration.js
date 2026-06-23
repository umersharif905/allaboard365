/**
 * One-shot runner for sql-changes/2026-05-19-rename-cases-to-support-tickets.sql.
 * Uses the same DB connection as the app (reads backend/.env).
 *
 * Usage (from host):
 *   sudo docker exec allaboard365-backend \
 *     node /app/backend/scripts/run-rename-cases-migration.js
 *
 * Idempotent — each step is guarded by IF EXISTS / IF NOT EXISTS so re-running
 * is safe. NOT wrapped in a single transaction (sp_rename auto-commits and the
 * runner splits on GO).
 */
const path = require('path');
const fs = require('fs');
const sql = require('mssql');

require('dotenv').config({
    path: path.join(__dirname, '..', '.env'),
    override: true
});

const sqlFile = path.join(
    __dirname,
    '..',
    '..',
    'sql-changes',
    '2026-05-19-rename-cases-to-support-tickets.sql'
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

    if (!config.user || !config.password || !config.server || !config.database) {
        console.error('Missing DB_USER, DB_PASSWORD, DB_SERVER, or DB_NAME in backend/.env');
        process.exit(1);
    }

    console.log(`Connecting to ${config.server} / ${config.database}`);
    const pool = await sql.connect(config);

    for (let i = 0; i < batches.length; i++) {
        const label = `Batch ${i + 1}/${batches.length}`;
        try {
            const result = await pool.request().query(batches[i]);
            if (result.recordset && result.recordset.length > 0) {
                console.log(`${label}: rows returned →`);
                console.table(result.recordset);
            } else if (result.recordsets && result.recordsets.length > 0) {
                result.recordsets.forEach((rs, j) => {
                    if (rs.length > 0) {
                        console.log(`${label} recordset ${j + 1} →`);
                        console.table(rs);
                    }
                });
                if (result.recordsets.every((rs) => rs.length === 0)) {
                    console.log(`${label}: ok`);
                }
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

main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});
