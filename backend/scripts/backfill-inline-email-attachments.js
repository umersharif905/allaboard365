// One-time backfill: ingest inline images for already-synced inbox messages whose
// body embeds cid: images but have NO stored attachments. Microsoft Graph reports
// hasAttachments=false for inline-only messages, so the original sync skipped them
// (fixed going forward in emailThreadService). This re-fetches their inline images
// from Graph and stores them so the cid: rewrite can resolve them.
//
// Idempotent (ingestAttachments skips messages that already have attachments).
// DRY-RUN by default — pass --commit to actually ingest. Optional: --vendor <id>.
const { getPool } = require('../config/database');
const emailAttachmentService = require('../services/emailAttachmentService');

const COMMIT = process.argv.includes('--commit');
const vIdx = process.argv.indexOf('--vendor');
const VENDOR = vIdx > -1 ? process.argv[vIdx + 1] : null;

(async () => {
    const pool = await getPool();
    const reqq = pool.request();
    let where = `m.GraphMessageId IS NOT NULL
        AND m.BodyHtml LIKE '%cid:%'
        AND NOT EXISTS (SELECT 1 FROM oe.EmailAttachments a WHERE a.EmailMessageId = m.EmailMessageId)`;
    if (VENDOR) { where += ' AND m.VendorId = @vendorId'; reqq.input('vendorId', require('mssql').UniqueIdentifier, VENDOR); }

    const rows = (await reqq.query(`
        SELECT m.EmailMessageId, m.VendorId, m.GraphMessageId, m.Direction
        FROM oe.EmailMessages m
        WHERE ${where}
        ORDER BY COALESCE(m.ReceivedAt, m.SentAt) DESC
    `)).recordset;

    console.log(`candidate messages (cid: body, no stored attachments): ${rows.length}`);
    if (!COMMIT) {
        console.log('DRY RUN — no changes made. Re-run with --commit to ingest.');
        process.exit(0);
    }

    let processed = 0, withStored = 0, failed = 0;
    for (const r of rows) {
        try {
            await emailAttachmentService.ingestAttachments(r.VendorId, r.EmailMessageId, r.GraphMessageId);
            const c = (await pool.request()
                .input('id', require('mssql').UniqueIdentifier, r.EmailMessageId)
                .query('SELECT COUNT(*) AS C FROM oe.EmailAttachments WHERE EmailMessageId=@id')).recordset[0].C;
            processed++; if (c > 0) withStored++;
        } catch (e) {
            failed++;
            console.warn('  fail', r.EmailMessageId, e.message);
        }
    }
    console.log(`done: ${processed} processed, ${withStored} now have stored attachments, ${failed} failed`);
    process.exit(0);
})().catch((e) => { console.error('BACKFILL ERR:', e.message); process.exit(1); });
