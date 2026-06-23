/**
 * Run a single file from sql-changes/allaboard365/ against DB from backend/.env
 * Usage: node scripts/run-sql-changes-file.js 2026-04-07-public-form-submissions-search-metrics.sql
 */
const path = require('path');
const fs = require('fs');
const sql = require('mssql');

require('dotenv').config({
    path: path.join(__dirname, '..', '.env'),
    override: true
});

const fileArg = process.argv[2];
if (!fileArg) {
    console.error('Usage: node scripts/run-sql-changes-file.js <filename.sql>');
    console.error('Example: node scripts/run-sql-changes-file.js 2026-04-07-public-form-submissions-search-metrics.sql');
    process.exit(1);
}

const sqlFile = path.join(__dirname, '..', '..', 'sql-changes', 'allaboard365', path.basename(fileArg));

if (!fs.existsSync(sqlFile)) {
    console.error('File not found:', sqlFile);
    process.exit(1);
}

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

    console.log('File:', path.basename(sqlFile));
    console.log('Connecting to', config.server, '/', config.database);
    const pool = await sql.connect(config);

    for (let i = 0; i < batches.length; i++) {
        console.log(`Running batch ${i + 1} of ${batches.length}...`);
        await pool.request().query(batches[i]);
    }

    await pool.close();
    console.log('Done.');
}

main().catch((err) => {
    console.error('Failed:', err.message);
    if (err.originalError) console.error(err.originalError);
    process.exit(1);
});
