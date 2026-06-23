/**
 * Backfill PayloadFirstName, PayloadLastName, SearchableText on oe.PublicFormSubmissions
 * where any of those are missing/empty (e.g. legacy rows before search columns, or camelCase payloads).
 * Run: npm run backfill:public-form-search
 * Requires DB env + PUBLIC_FORMS_ENCRYPTION_KEY_B64 (same as API).
 * Uses keyset pagination by SubmissionId so each row is visited at most once (no infinite loop when
 * SearchableText is already set but names stay empty).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { getPool, sql } = require('../config/database');
const { decryptPayloadObject } = require('../services/publicFormCrypto');
const { derivePayloadSearchFields } = require('../services/publicFormSubmissionService');

const BATCH = 50;
const CURSOR_START = '00000000-0000-0000-0000-000000000000';

async function main() {
    const pool = await getPool();
    let done = 0;
    let cursor = CURSOR_START;
    for (;;) {
        const rows = (await pool.request()
            .input('cursor', sql.UniqueIdentifier, cursor)
            .query(`
            SELECT TOP (${BATCH})
                SubmissionId,
                PayloadEncrypted,
                PayloadIv,
                PayloadAuthTag
            FROM oe.PublicFormSubmissions
            WHERE SubmissionId > @cursor
              AND (
                  SearchableText IS NULL
                  OR NULLIF(LTRIM(RTRIM(ISNULL(PayloadFirstName, N''))), N'') IS NULL
                  OR NULLIF(LTRIM(RTRIM(ISNULL(PayloadLastName, N''))), N'') IS NULL
              )
            ORDER BY SubmissionId
        `)).recordset;
        if (!rows.length) break;

        for (const row of rows) {
            let payload;
            try {
                payload = decryptPayloadObject(row.PayloadEncrypted, row.PayloadIv, row.PayloadAuthTag);
            } catch (e) {
                console.warn('Skip decrypt', row.SubmissionId, e.message);
                continue;
            }
            const sf = derivePayloadSearchFields(payload);
            await pool.request()
                .input('sid', sql.UniqueIdentifier, row.SubmissionId)
                .input('pfn', sql.NVarChar(200), sf.payloadFirstName)
                .input('pln', sql.NVarChar(200), sf.payloadLastName)
                .input('st', sql.NVarChar(sql.MAX), sf.searchableText)
                .query(`
                    UPDATE oe.PublicFormSubmissions
                    SET PayloadFirstName = @pfn,
                        PayloadLastName = @pln,
                        SearchableText = @st
                    WHERE SubmissionId = @sid
                `);
            done += 1;
        }

        cursor = rows[rows.length - 1].SubmissionId;
        console.log('Backfilled batch, total updates:', done, 'cursor:', cursor);
    }
    console.log('Done. Rows updated:', done);
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
