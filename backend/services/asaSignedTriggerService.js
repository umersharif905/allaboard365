/**
 * Scheduled job: event-triggered run when a Vendor ASA (Agent Service Agreement) is signed
 * by a group — for any product belonging to the vendor.
 *
 * Unlike calendar-based VendorScheduledJobs (eligibility_export, payables_export, new_group_form),
 * this job is NOT polled by the 5-min scheduler. It fires from the ASA signing routes
 * (both GroupOnboardingWizard and GroupDetails admin-side signing) immediately after
 * SignedASAAgreements row(s) are inserted, then emails one message per **group** with an
 * attachment for every **unsent** completed ASA in that group (same vendor) so multiple
 * product signings land in a single email.
 *
 * Uses the same oe.VendorScheduledJobs row shape as other vendor jobs for UI consistency:
 *   JobType       = 'asa_signed'
 *   ExportTrigger = 'asa_signed'       -- excluded from the time-based scheduler query
 *   ExportSchedule, ExportScheduleDay/Time/DayOfMonth may be NULL (unused for this trigger)
 */

const { getPool, sql } = require('../config/database');
const VendorExportService = require('./vendorExportService');
const sendGridEmailService = require('./sendGridEmailService');

/**
 * Return the set of GroupIds (lowercased) from `groupIds` that have at least
 * one currently-active enrollment. The active-enrollment definition matches
 * the rest of the codebase (oe.Enrollments e JOIN oe.Members m, e.Status='Active',
 * TerminationDate NULL or in the future).
 *
 * Used to gate ASA email sends so vendors don't get countersigned PDFs for
 * groups that have no live members on any product.
 *
 * @param {string[]} groupIds
 * @returns {Promise<Set<string>>}  lowercased GroupId strings with active enrollments
 */
async function getGroupIdsWithActiveEnrollments(groupIds) {
    const out = new Set();
    if (!Array.isArray(groupIds) || groupIds.length === 0) return out;
    const pool = await getPool();
    const req = pool.request();
    const tvpNames = [];
    groupIds.forEach((id, i) => {
        const name = `gid_${i}`;
        try {
            req.input(name, sql.UniqueIdentifier, id);
            tvpNames.push(`@${name}`);
        } catch (_) { /* skip invalid GUIDs */ }
    });
    if (tvpNames.length === 0) return out;
    const r = await req.query(`
        SELECT DISTINCT m.GroupId
        FROM oe.Enrollments e
        INNER JOIN oe.Members m ON m.MemberId = e.MemberId
        WHERE m.GroupId IN (${tvpNames.join(',')})
          AND e.Status = N'Active'
          AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE())
    `);
    for (const row of r.recordset || []) {
        if (row.GroupId) out.add(String(row.GroupId).toLowerCase());
    }
    return out;
}

/**
 * Persist the outcome of an email attempt back to the signed agreement row so the
 * vendor portal Signed ASAs tab can show sent/unsent state. Best-effort — columns
 * may not exist on older databases, in which case we swallow the error.
 * @param {object} opts
 * @param {string} opts.signedAgreementId
 * @param {boolean} opts.success
 * @param {string[]} [opts.recipients]
 * @param {string} [opts.userId]  null/undefined = automatic trigger
 * @param {string} [opts.error]   when success=false
 */
async function recordEmailAttempt({ signedAgreementId, success, recipients, userId, error }) {
    try {
        if (!signedAgreementId) return;
        const pool = await getPool();
        const now = new Date();
        const recipientList = Array.isArray(recipients) && recipients.length
            ? recipients.join(', ').slice(0, 1999)
            : null;
        const errStr = error ? String(error).slice(0, 1999) : null;
        const req = pool.request();
        req.input('id', sql.UniqueIdentifier, signedAgreementId);
        req.input('now', sql.DateTime2, now);
        req.input('recipients', sql.NVarChar(2000), recipientList);
        req.input('userId', sql.UniqueIdentifier, userId || null);
        req.input('err', sql.NVarChar(2000), errStr);
        if (success) {
            await req.query(`
                UPDATE oe.SignedASAAgreements
                SET LastEmailedDate = @now,
                    LastEmailAttemptDate = @now,
                    LastEmailedTo = @recipients,
                    LastEmailedByUserId = @userId,
                    LastEmailError = NULL,
                    EmailSendCount = ISNULL(EmailSendCount, 0) + 1
                WHERE SignedAgreementId = @id
            `);
        } else {
            await req.query(`
                UPDATE oe.SignedASAAgreements
                SET LastEmailAttemptDate = @now,
                    LastEmailError = @err
                WHERE SignedAgreementId = @id
            `);
        }
    } catch (e) {
        const msg = (e && e.message) ? e.message : '';
        if (msg.includes('Invalid column') || msg.includes('Invalid object name')) {
            // Columns not yet deployed — the migration sql-changes/2026-04-21-signed-asa-email-tracking.sql
            // adds them; ignore until then so the send itself still succeeds.
            return;
        }
        console.warn('⚠️ asaSignedTrigger: failed to record email attempt:', msg);
    }
}

function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Download the signed ASA PDF from Azure Blob Storage so it can be attached to the email.
 * Accepts either a base blob URL (no SAS) or an authenticated URL with a SAS token —
 * both contain the same container/blob path which is all we need since we re-auth using
 * the storage account connection string.
 * @param {string} blobUrl
 * @returns {Promise<Buffer|null>} PDF bytes, or null if download fails
 */
async function downloadSignedPdfBuffer(blobUrl) {
    try {
        const { BlobServiceClient } = require('@azure/storage-blob');
        const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
        if (!connectionString) {
            console.warn('⚠️ asaSignedTrigger: AZURE_STORAGE_CONNECTION_STRING not set; cannot attach signed PDF');
            return null;
        }
        if (!blobUrl || typeof blobUrl !== 'string') return null;
        const clean = blobUrl.split('?')[0];
        const urlObj = new URL(clean);
        const pathParts = urlObj.pathname.split('/').filter((p) => p);
        if (pathParts.length < 2) return null;
        const containerName = pathParts[0];
        const blobName = pathParts.slice(1).join('/');
        const svc = BlobServiceClient.fromConnectionString(connectionString);
        const container = svc.getContainerClient(containerName);
        const blob = container.getBlockBlobClient(blobName);
        const exists = await blob.exists();
        if (!exists) {
            console.warn(`⚠️ asaSignedTrigger: signed PDF blob not found at ${containerName}/${blobName}`);
            return null;
        }
        return await blob.downloadToBuffer();
    } catch (e) {
        console.warn('⚠️ asaSignedTrigger: failed to download signed PDF:', e.message);
        return null;
    }
}

/**
 * Load the signed agreement + group/product/vendor context needed for the email.
 * @param {string} signedAgreementId
 * @returns {Promise<null | {
 *   signedAgreementId: string, vendorId: string, groupId: string, productId: string,
 *   groupName: string, productName: string, vendorName: string, tenantId: string|null,
 *   vendorEmail: string|null,
 *   signedByName: string, signedByEmail: string, signedDate: Date,
 *   signedDocumentUrl: string|null, documentName: string|null
 * }>}
 */
async function loadSignedAsaContext(signedAgreementId) {
    const pool = await getPool();
    const r = await pool.request()
        .input('id', sql.UniqueIdentifier, signedAgreementId)
        .query(`
            SELECT
                s.SignedAgreementId, s.VendorId, s.GroupId, s.ProductId,
                s.SignedByName, s.SignedByEmail, s.SignedDate, s.SignedDocumentUrl,
                g.Name AS GroupName, g.TenantId,
                p.Name AS ProductName,
                v.VendorName, v.Email AS VendorEmail,
                fu.FileName AS DocumentName
            FROM oe.SignedASAAgreements s
            INNER JOIN oe.Groups g ON g.GroupId = s.GroupId
            INNER JOIN oe.Products p ON p.ProductId = s.ProductId
            INNER JOIN oe.Vendors v ON v.VendorId = s.VendorId
            LEFT JOIN oe.FileUploads fu ON fu.FileId = s.DocumentId
            WHERE s.SignedAgreementId = @id
        `);
    const row = r.recordset && r.recordset[0];
    if (!row) return null;
    return {
        signedAgreementId: String(row.SignedAgreementId),
        vendorId: String(row.VendorId),
        groupId: String(row.GroupId),
        productId: String(row.ProductId),
        groupName: (row.GroupName || '').trim() || 'Group',
        productName: (row.ProductName || '').trim() || 'Product',
        vendorName: (row.VendorName || '').trim() || 'Vendor',
        tenantId: row.TenantId ? String(row.TenantId) : null,
        vendorEmail: row.VendorEmail ? String(row.VendorEmail).trim() : null,
        signedByName: (row.SignedByName || '').trim(),
        signedByEmail: (row.SignedByEmail || '').trim(),
        signedDate: row.SignedDate ? new Date(row.SignedDate) : new Date(),
        signedDocumentUrl: row.SignedDocumentUrl || null,
        documentName: row.DocumentName || null
    };
}

/**
 * Fetch enabled asa_signed jobs for a given vendor. Tolerates missing ExportTrigger column.
 * @param {string} vendorId
 */
async function getEnabledAsaSignedJobs(vendorId) {
    const pool = await getPool();
    try {
        const r = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT
                    VendorScheduledJobId, VendorId, EmailRecipients, UseVendorDefaultSftp
                FROM oe.VendorScheduledJobs
                WHERE VendorId = @vendorId
                  AND IsEnabled = 1
                  AND JobType = N'asa_signed'
                  AND LOWER(LTRIM(RTRIM(ISNULL(ExportTrigger, N'')))) = N'asa_signed'
            `);
        return r.recordset || [];
    } catch (e) {
        const msg = (e && e.message) ? e.message : '';
        if (msg.includes('Invalid column') || msg.includes('Invalid object name')) {
            console.warn('⚠️ asaSignedTrigger: VendorScheduledJobs not available:', msg);
            return [];
        }
        throw e;
    }
}

/**
 * Build the full recipient list for one job:
 * 1. EmailRecipients on the job row (comma-separated, de-duped), when set
 * 2. oe.Vendors.AsaSignedEmailRecipients (ASA-specific default; new column
 *    introduced in sql-changes/2026-04-29-vendor-asa-signed-email-recipients.sql)
 * 3. otherwise vendor.Email + vendor notification contacts
 */
async function resolveRecipients(vendorId, job, vendorEmail) {
    const fromJob = VendorExportService.parseCommaSeparatedEmails(job.EmailRecipients);
    if (fromJob && fromJob.length > 0) {
        const seen = new Set();
        const out = [];
        for (const e of fromJob) {
            const key = String(e).toLowerCase();
            if (!seen.has(key)) { seen.add(key); out.push(e); }
        }
        return out;
    }
    // ASA-specific vendor-level default (column may not exist on older DBs).
    try {
        const pool = await getPool();
        const r = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .query(`
                SELECT AsaSignedEmailRecipients
                FROM oe.Vendors
                WHERE VendorId = @vendorId
            `);
        const raw = r.recordset && r.recordset[0] ? r.recordset[0].AsaSignedEmailRecipients : null;
        const fromVendorAsa = VendorExportService.parseCommaSeparatedEmails(raw);
        if (fromVendorAsa && fromVendorAsa.length > 0) {
            const seen = new Set();
            const out = [];
            for (const e of fromVendorAsa) {
                const key = String(e).toLowerCase();
                if (!seen.has(key)) { seen.add(key); out.push(e); }
            }
            return out;
        }
    } catch (e) {
        const msg = (e && e.message) ? e.message : '';
        if (!msg.includes('Invalid column') && !msg.includes('Invalid object name')) {
            console.warn('⚠️ asaSignedTrigger: read AsaSignedEmailRecipients failed:', msg);
        }
    }
    const out = [];
    const seen = new Set();
    const add = (em) => {
        const v = (em || '').trim();
        if (!v) return;
        const k = v.toLowerCase();
        if (!seen.has(k)) { seen.add(k); out.push(v); }
    };
    add(vendorEmail);
    try {
        const contacts = await VendorExportService.getVendorNotificationContacts(vendorId);
        for (const c of contacts || []) add(c.email);
    } catch (e) {
        console.warn('⚠️ asaSignedTrigger: getVendorNotificationContacts failed:', e.message);
    }
    return out;
}

/** Serialize sends for the same vendor+group so parallel inserts do not duplicate emails. */
const vendorGroupSendQueues = new Map();
function runSerializedVendorGroup(vendorId, groupId, fn) {
    const key = `${String(vendorId).toLowerCase()}:${String(groupId).toLowerCase()}`;
    const prev = vendorGroupSendQueues.get(key) || Promise.resolve();
    const run = prev.then(() => fn());
    vendorGroupSendQueues.set(key, run.catch(() => {}));
    return run;
}

function safeFilePart(s) {
    return String(s || 'x')
        .replace(/[^a-zA-Z0-9-_]/g, '_')
        .replace(/_+/g, '_')
        .slice(0, 80) || 'file';
}

/**
 * @param {string} fallbackSignedAgreementId  used if LastEmailedDate column not deployed yet
 * @returns {Promise<string[]>}
 */
async function fetchUnsentSignedAgreementIdsForVendorGroup(vendorId, groupId, fallbackSignedAgreementId) {
    const pool = await getPool();
    try {
        const r = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('groupId', sql.UniqueIdentifier, groupId)
            .query(`
                SELECT s.SignedAgreementId
                FROM oe.SignedASAAgreements s
                WHERE s.VendorId = @vendorId AND s.GroupId = @groupId
                  AND s.Status = N'Completed'
                  AND s.LastEmailedDate IS NULL
                ORDER BY s.SignedDate ASC, s.ProductId ASC
            `);
        return (r.recordset || []).map((x) => String(x.SignedAgreementId));
    } catch (e) {
        const msg = (e && e.message) ? e.message : '';
        if (msg.includes('Invalid column') && fallbackSignedAgreementId) {
            return [String(fallbackSignedAgreementId)];
        }
        throw e;
    }
}

/**
 * @param {object[]} contexts  from loadSignedAsaContext, same group/vendor, ordered
 * @returns {Promise<{ subject: string, html: string, text: string, attachments: Array }>}
 */
async function buildBatchedSignedAsaEmailBody(contexts) {
    if (!contexts || contexts.length === 0) {
        return { subject: '', html: '', text: '', attachments: [] };
    }
    if (contexts.length === 1) {
        const single = await buildSignedAsaEmailBody(contexts[0]);
        return {
            subject: single.subject,
            html: single.html,
            text: single.text,
            attachments: single.pdfBuffer
                ? [{ content: single.pdfBuffer.toString('base64'), filename: single.attachmentFilename, type: 'application/pdf', disposition: 'attachment' }]
                : []
        };
    }

    const first = contexts[0];
    const n = contexts.length;
    const safeVendor = safeFilePart(first.vendorName);
    const safeGroup = safeFilePart(first.groupName);
    const subject = `${n} ASAs signed — ${first.vendorName} · ${first.groupName}`;

    const perRow = await Promise.all(
        contexts.map(async (ctx) => {
            const pdfBuffer = ctx.signedDocumentUrl ? await downloadSignedPdfBuffer(ctx.signedDocumentUrl) : null;
            let baseName = `ASA-${safeVendor}-${safeGroup}-${safeFilePart(ctx.productName)}.pdf`;
            const idShort = (ctx.signedAgreementId || '').replace(/-/g, '').slice(0, 8);
            if (idShort) {
                baseName = baseName.replace(/\.pdf$/i, `-${idShort}.pdf`);
            }
            let fallbackUrl = ctx.signedDocumentUrl || null;
            try {
                if (fallbackUrl) {
                    const { isBlobUrl, generateAuthenticatedUrl } = require('../routes/uploads');
                    if (isBlobUrl(fallbackUrl)) {
                        fallbackUrl = await generateAuthenticatedUrl(fallbackUrl);
                    }
                }
            } catch (e) {
                console.warn('⚠️ asaSignedTrigger: could not sign batch fallback URL:', e.message);
            }
            const signedWhen = ctx.signedDate instanceof Date
                ? ctx.signedDate.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
                : '';
            return { ctx, pdfBuffer, filename: baseName, fallbackUrl, signedWhen };
        })
    );

    const used = new Set();
    for (const p of perRow) {
        let { filename } = p;
        if (used.has(filename)) {
            const short = String(p.ctx.signedAgreementId || '').replace(/-/g, '').slice(0, 8) || 'id';
            filename = filename.replace(/\.pdf$/i, `-dup${short}.pdf`);
        }
        used.add(filename);
        p.filename = filename;
    }

    const productRows = perRow
        .map(
            (p) => `<tr>
    <td style="padding:6px 12px 6px 0;vertical-align:top;border-bottom:1px solid #e5e7eb;">${escapeHtml(p.ctx.signedByName)} &lt;${escapeHtml(p.ctx.signedByEmail)}&gt;</td>
    <td style="padding:6px 12px 6px 0;vertical-align:top;border-bottom:1px solid #e5e7eb;">${escapeHtml(p.signedWhen)}</td>
    <td style="padding:6px 0;vertical-align:top;border-bottom:1px solid #e5e7eb;">${p.fallbackUrl ? `<a href="${escapeHtml(p.fallbackUrl)}" style="color:#2563eb;">PDF link</a>` : '—'}</td>
  </tr>`
        )
        .join('');

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table width="100%" cellspacing="0" cellpadding="0" style="padding:20px 12px;"><tr><td align="center">
<table width="100%" style="max-width:720px;background:#fff;border-radius:10px;border:1px solid #e5e7eb;padding:22px;">
<tr><td>
  <div style="font-size:18px;font-weight:700;color:#111827;margin-bottom:8px;">${n} vendor ASAs signed — ${escapeHtml(first.vendorName)}</div>
  <p style="font-size:14px;color:#4b5563;margin:0 0 16px;">A group completed <strong>${n}</strong> Agent Service Agreement(s) for <strong>${escapeHtml(first.groupName)}</strong>. Countersigned PDFs are attached.</p>
  <table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;font-size:13px;color:#374151;margin-bottom:12px;">
    <tr style="text-align:left;color:#6b7280;"><th style="padding:4px 12px 8px 0;">Signed by</th><th style="padding:4px 12px 8px 0;">When (UTC)</th><th style="padding:4px 0 8px 0;">Link</th></tr>
    ${productRows}
  </table>
  <p style="font-size:12px;color:#6b7280;margin:0;">Group: <strong>${escapeHtml(first.groupName)}</strong> · Vendor: <strong>${escapeHtml(first.vendorName)}</strong></p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;

    const text = [
        `${n} vendor ASAs signed — ${first.vendorName}`,
        `Group: ${first.groupName}`,
        '',
        ...perRow.map(
            (p) =>
                `- ${p.ctx.signedByName} <${p.ctx.signedByEmail}> — ${p.signedWhen}${p.fallbackUrl ? ` — ${p.fallbackUrl}` : ''}`
        )
    ].join('\n');

    const attachments = [];
    for (const p of perRow) {
        if (p.pdfBuffer) {
            attachments.push({
                content: p.pdfBuffer.toString('base64'),
                filename: p.filename,
                type: 'application/pdf',
                disposition: 'attachment'
            });
        }
    }
    return { subject, html, text, attachments };
}

/**
 * Resolve recipient list for manual vendor-portal sends (optional explicit list, else job, else vendor defaults).
 * @param {string} vendorId
 * @param {string|null} vendorEmail
 * @param {string[]|string|undefined} recipients
 * @returns {Promise<string[]>}
 */
async function resolveManualAsaRecipients(vendorId, vendorEmail, recipients) {
    let finalRecipients = [];
    if (Array.isArray(recipients)) {
        finalRecipients = recipients.map((s) => String(s).trim()).filter(Boolean);
    } else if (typeof recipients === 'string' && recipients.trim()) {
        finalRecipients = VendorExportService.parseCommaSeparatedEmails(recipients) || [];
    }
    if (finalRecipients.length > 0) {
        return finalRecipients;
    }
    const jobs = await getEnabledAsaSignedJobs(vendorId);
    const fromJob = jobs.length > 0
        ? VendorExportService.parseCommaSeparatedEmails(jobs[0].EmailRecipients)
        : [];
    if (fromJob && fromJob.length > 0) {
        return fromJob;
    }
    const defaults = [];
    const seen = new Set();
    const add = (em) => {
        const v = (em || '').trim();
        if (v && !seen.has(v.toLowerCase())) {
            seen.add(v.toLowerCase());
            defaults.push(v);
        }
    };
    add(vendorEmail);
    try {
        const contacts = await VendorExportService.getVendorNotificationContacts(vendorId);
        for (const c of contacts || []) add(c.email);
    } catch (_) { /* ignore */ }
    return defaults;
}

/**
 * Build a single email body that lists signed ASAs from many groups for one
 * vendor. Each row is one signed agreement (no Product column — per UX
 * feedback). When multiple groups are present, a Group column is included so
 * the recipient can tell which agreement is which without the product label.
 *
 * @param {object[]} contexts  loadSignedAsaContext results, all same vendor
 * @returns {Promise<{ subject: string, html: string, text: string, attachments: Array }>}
 */
async function buildBulkSignedAsaEmailBody(contexts) {
    if (!contexts || contexts.length === 0) {
        return { subject: '', html: '', text: '', attachments: [] };
    }
    if (contexts.length === 1) {
        // Single agreement — reuse the existing per-agreement template.
        const single = await buildSignedAsaEmailBody(contexts[0]);
        return {
            subject: single.subject,
            html: single.html,
            text: single.text,
            attachments: single.pdfBuffer
                ? [{ content: single.pdfBuffer.toString('base64'), filename: single.attachmentFilename, type: 'application/pdf', disposition: 'attachment' }]
                : []
        };
    }

    const first = contexts[0];
    const n = contexts.length;
    const groupSet = new Set(contexts.map((c) => String(c.groupId)));
    const isMultiGroup = groupSet.size > 1;
    const safeVendor = safeFilePart(first.vendorName);
    const subject = isMultiGroup
        ? `${n} ASAs signed — ${first.vendorName} · ${groupSet.size} groups`
        : `${n} ASAs signed — ${first.vendorName} · ${first.groupName}`;

    const perRow = await Promise.all(
        contexts.map(async (ctx) => {
            const pdfBuffer = ctx.signedDocumentUrl ? await downloadSignedPdfBuffer(ctx.signedDocumentUrl) : null;
            const safeGroup = safeFilePart(ctx.groupName);
            let baseName = `ASA-${safeVendor}-${safeGroup}.pdf`;
            const idShort = (ctx.signedAgreementId || '').replace(/-/g, '').slice(0, 8);
            if (idShort) {
                baseName = baseName.replace(/\.pdf$/i, `-${idShort}.pdf`);
            }
            let fallbackUrl = ctx.signedDocumentUrl || null;
            try {
                if (fallbackUrl) {
                    const { isBlobUrl, generateAuthenticatedUrl } = require('../routes/uploads');
                    if (isBlobUrl(fallbackUrl)) {
                        fallbackUrl = await generateAuthenticatedUrl(fallbackUrl);
                    }
                }
            } catch (e) {
                console.warn('⚠️ asaSignedTrigger: could not sign bulk fallback URL:', e.message);
            }
            const signedWhen = ctx.signedDate instanceof Date
                ? ctx.signedDate.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
                : '';
            return { ctx, pdfBuffer, filename: baseName, fallbackUrl, signedWhen };
        })
    );

    // De-dupe filenames in the same email (same vendor + same group + same id-short
    // shouldn't collide, but guard anyway so SendGrid doesn't reject duplicates).
    const used = new Set();
    for (const p of perRow) {
        let { filename } = p;
        if (used.has(filename)) {
            const short = String(p.ctx.signedAgreementId || '').replace(/-/g, '').slice(0, 8) || 'id';
            filename = filename.replace(/\.pdf$/i, `-dup${short}.pdf`);
        }
        used.add(filename);
        p.filename = filename;
    }

    const headerCells = isMultiGroup
        ? `<th style="padding:4px 12px 8px 0;">Group</th><th style="padding:4px 12px 8px 0;">Signed by</th><th style="padding:4px 12px 8px 0;">When (UTC)</th><th style="padding:4px 0 8px 0;">Link</th>`
        : `<th style="padding:4px 12px 8px 0;">Signed by</th><th style="padding:4px 12px 8px 0;">When (UTC)</th><th style="padding:4px 0 8px 0;">Link</th>`;

    const rows = perRow
        .map((p) => {
            const groupCell = isMultiGroup
                ? `<td style="padding:6px 12px 6px 0;vertical-align:top;border-bottom:1px solid #e5e7eb;">${escapeHtml(p.ctx.groupName)}</td>`
                : '';
            return `<tr>
    ${groupCell}<td style="padding:6px 12px 6px 0;vertical-align:top;border-bottom:1px solid #e5e7eb;">${escapeHtml(p.ctx.signedByName)} &lt;${escapeHtml(p.ctx.signedByEmail)}&gt;</td>
    <td style="padding:6px 12px 6px 0;vertical-align:top;border-bottom:1px solid #e5e7eb;">${escapeHtml(p.signedWhen)}</td>
    <td style="padding:6px 0;vertical-align:top;border-bottom:1px solid #e5e7eb;">${p.fallbackUrl ? `<a href="${escapeHtml(p.fallbackUrl)}" style="color:#2563eb;">PDF link</a>` : '—'}</td>
  </tr>`;
        })
        .join('');

    const summary = isMultiGroup
        ? `<strong>${n}</strong> Agent Service Agreement(s) across <strong>${groupSet.size}</strong> group(s) for <strong>${escapeHtml(first.vendorName)}</strong>.`
        : `<strong>${n}</strong> Agent Service Agreement(s) for <strong>${escapeHtml(first.groupName)}</strong>.`;

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table width="100%" cellspacing="0" cellpadding="0" style="padding:20px 12px;"><tr><td align="center">
<table width="100%" style="max-width:720px;background:#fff;border-radius:10px;border:1px solid #e5e7eb;padding:22px;">
<tr><td>
  <div style="font-size:18px;font-weight:700;color:#111827;margin-bottom:8px;">${n} vendor ASAs signed — ${escapeHtml(first.vendorName)}</div>
  <p style="font-size:14px;color:#4b5563;margin:0 0 16px;">${summary} Countersigned PDFs are attached.</p>
  <table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;font-size:13px;color:#374151;margin-bottom:12px;">
    <tr style="text-align:left;color:#6b7280;">${headerCells}</tr>
    ${rows}
  </table>
  <p style="font-size:12px;color:#6b7280;margin:0;">Vendor: <strong>${escapeHtml(first.vendorName)}</strong>${isMultiGroup ? '' : ` · Group: <strong>${escapeHtml(first.groupName)}</strong>`}</p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;

    const text = [
        `${n} vendor ASAs signed — ${first.vendorName}`,
        isMultiGroup ? `${groupSet.size} groups` : `Group: ${first.groupName}`,
        '',
        ...perRow.map((p) => {
            const grp = isMultiGroup ? `[${p.ctx.groupName}] ` : '';
            return `- ${grp}${p.ctx.signedByName} <${p.ctx.signedByEmail}> — ${p.signedWhen}${p.fallbackUrl ? ` — ${p.fallbackUrl}` : ''}`;
        })
    ].join('\n');

    const attachments = [];
    for (const p of perRow) {
        if (p.pdfBuffer) {
            attachments.push({
                content: p.pdfBuffer.toString('base64'),
                filename: p.filename,
                type: 'application/pdf',
                disposition: 'attachment'
            });
        }
    }
    return { subject, html, text, attachments };
}

/**
 * Send ALL signed ASAs across ALL groups for a vendor in a SINGLE email
 * (one recipient list, one subject, one body, multiple PDF attachments).
 *
 * Used by the Signed ASAs tab "Send all unsent" / "Send all (resend)" buttons
 * so the vendor doesn't get one email per group.
 *
 * @param {object} opts
 * @param {string} opts.vendorId
 * @param {string[]} opts.signedAgreementIds  IDs across any number of groups
 * @param {string[]|string} [opts.recipients]
 * @param {string} [opts.userId]
 * @returns {Promise<{ success: boolean, message: string, signedAgreementIds: string[], recipients: string[], groupCount: number }>}
 */
async function sendBulkSignedAsaForVendor({ vendorId, signedAgreementIds, recipients, userId }) {
    if (!Array.isArray(signedAgreementIds) || signedAgreementIds.length === 0) {
        return { success: true, message: 'Nothing to send', signedAgreementIds: [], recipients: [], groupCount: 0, skippedNoActiveEnrollmentCount: 0 };
    }
    const vId = String(vendorId);
    const contexts = [];
    for (const id of signedAgreementIds) {
        /* eslint-disable no-await-in-loop */
        const c = await loadSignedAsaContext(id);
        /* eslint-enable no-await-in-loop */
        if (!c || c.vendorId !== vId) {
            return { success: false, message: 'One or more signed ASAs are invalid for this vendor', signedAgreementIds: [], recipients: [], groupCount: 0, skippedNoActiveEnrollmentCount: 0 };
        }
        contexts.push(c);
    }

    // Drop ASAs for groups that have ZERO currently-active enrollments. Vendors
    // shouldn't receive countersigned PDFs for empty/inactive groups.
    const allGroupIds = Array.from(new Set(contexts.map((c) => String(c.groupId))));
    const activeGroupSet = await getGroupIdsWithActiveEnrollments(allGroupIds);
    const skipped = contexts.filter((c) => !activeGroupSet.has(String(c.groupId).toLowerCase()));
    const filtered = contexts.filter((c) => activeGroupSet.has(String(c.groupId).toLowerCase()));
    if (filtered.length === 0) {
        return {
            success: true,
            message: skipped.length > 0
                ? `Skipped ${skipped.length} signed ASA(s) — none of the groups have active enrollments yet.`
                : 'Nothing to send',
            signedAgreementIds: [],
            recipients: [],
            groupCount: 0,
            skippedNoActiveEnrollmentCount: skipped.length
        };
    }

    // Sort: group asc, then signed date asc — keeps related rows together in
    // the email body and gives PDFs a stable attachment order.
    filtered.sort((a, b) => {
        const g = (a.groupName || '').localeCompare(b.groupName || '');
        if (g !== 0) return g;
        return (a.signedDate ? a.signedDate.getTime() : 0) - (b.signedDate ? b.signedDate.getTime() : 0);
    });
    contexts.length = 0;
    contexts.push(...filtered);

    const vendorEmail = contexts[0] ? contexts[0].vendorEmail : null;
    const finalRecipients = await resolveManualAsaRecipients(vendorId, vendorEmail, recipients);
    const groupCount = new Set(contexts.map((c) => String(c.groupId))).size;
    const skippedCount = skipped.length;

    if (finalRecipients.length === 0) {
        const message = 'No recipients — provide an email or set vendor default contacts';
        for (const c of contexts) {
            /* eslint-disable no-await-in-loop */
            await recordEmailAttempt({ signedAgreementId: c.signedAgreementId, success: false, userId, error: message });
        }
        return { success: false, message, signedAgreementIds: contexts.map((x) => x.signedAgreementId), recipients: [], groupCount, skippedNoActiveEnrollmentCount: skippedCount };
    }

    try {
        const { subject, html, text, attachments } = await buildBulkSignedAsaEmailBody(contexts);
        const tenantId = contexts[0].tenantId;
        await sendGridEmailService.sendEmail({
            ...(tenantId ? { tenantId } : {}),
            to: finalRecipients.length === 1 ? finalRecipients[0] : finalRecipients,
            subject,
            html,
            text,
            ...(attachments && attachments.length ? { attachments } : {}),
            metadata: { fromName: contexts[0].vendorName || 'AllAboard365' }
        });
        for (const c of contexts) {
            /* eslint-disable no-await-in-loop */
            await recordEmailAttempt({ signedAgreementId: c.signedAgreementId, success: true, recipients: finalRecipients, userId });
        }
        const skippedNote = skippedCount > 0
            ? ` · skipped ${skippedCount} ASA(s) for group(s) with no active enrollments`
            : '';
        return {
            success: true,
            message: `Sent ${contexts.length} signed ASA PDF(s) across ${groupCount} group(s) in 1 email to ${finalRecipients.length} address(es)${skippedNote}`,
            signedAgreementIds: contexts.map((x) => x.signedAgreementId),
            recipients: finalRecipients,
            groupCount,
            skippedNoActiveEnrollmentCount: skippedCount
        };
    } catch (e) {
        const message = e && e.message ? e.message : String(e);
        for (const c of contexts) {
            /* eslint-disable no-await-in-loop */
            await recordEmailAttempt({ signedAgreementId: c.signedAgreementId, success: false, userId, error: message });
        }
        return { success: false, message, signedAgreementIds: contexts.map((x) => x.signedAgreementId), recipients: finalRecipients, groupCount, skippedNoActiveEnrollmentCount: skippedCount };
    }
}

/**
 * One email with multiple PDFs for a vendor + group. Used by bulk send on the vendor portal.
 * @returns {Promise<{ success: boolean, message: string, signedAgreementIds: string[], recipients: string[] }>}
 */
async function sendBatchedSignedAsaForVendorGroup({ vendorId, groupId, signedAgreementIds, recipients, userId }) {
    return runSerializedVendorGroup(vendorId, groupId, () =>
        sendBatchedSignedAsaForVendorGroupImpl({ vendorId, groupId, signedAgreementIds, recipients, userId })
    );
}

async function sendBatchedSignedAsaForVendorGroupImpl({ vendorId, groupId, signedAgreementIds, recipients, userId }) {
    if (!Array.isArray(signedAgreementIds) || signedAgreementIds.length === 0) {
        return { success: true, message: 'Nothing to send', signedAgreementIds: [], recipients: [] };
    }
    const vId = String(vendorId);
    const gId = String(groupId);
    const contexts = [];
    for (const id of signedAgreementIds) {
        const c = await loadSignedAsaContext(id);
        if (!c || c.vendorId !== vId || c.groupId !== gId) {
            return { success: false, message: 'One or more signed ASAs are invalid for this batch', signedAgreementIds: [], recipients: [] };
        }
        contexts.push(c);
    }

    // Gate: skip the entire batch if the group has no currently-active enrollments.
    const activeGroupSet = await getGroupIdsWithActiveEnrollments([gId]);
    if (!activeGroupSet.has(gId.toLowerCase())) {
        const message = 'Group has no active enrollments — skipped sending signed ASA(s).';
        for (const c of contexts) {
            /* eslint-disable no-await-in-loop */
            await recordEmailAttempt({ signedAgreementId: c.signedAgreementId, success: false, userId, error: message });
        }
        return {
            success: true,
            message,
            signedAgreementIds: contexts.map((x) => x.signedAgreementId),
            recipients: [],
            skippedNoActiveEnrollment: true
        };
    }

    const vendorEmail = contexts[0] ? contexts[0].vendorEmail : null;
    const finalRecipients = await resolveManualAsaRecipients(vendorId, vendorEmail, recipients);
    if (finalRecipients.length === 0) {
        const message = 'No recipients — provide an email or set vendor default contacts';
        for (const c of contexts) {
            /* eslint-disable no-await-in-loop */
            await recordEmailAttempt({ signedAgreementId: c.signedAgreementId, success: false, userId, error: message });
        }
        return { success: false, message, signedAgreementIds: contexts.map((x) => x.signedAgreementId), recipients: [] };
    }
    try {
        const { subject, html, text, attachments } = await buildBatchedSignedAsaEmailBody(contexts);
        const tenantId = contexts[0].tenantId;
        await sendGridEmailService.sendEmail({
            ...(tenantId ? { tenantId } : {}),
            to: finalRecipients.length === 1 ? finalRecipients[0] : finalRecipients,
            subject,
            html,
            text,
            ...(attachments && attachments.length ? { attachments } : {}),
            metadata: { fromName: contexts[0].vendorName || 'AllAboard365' }
        });
        for (const c of contexts) {
            /* eslint-disable no-await-in-loop */
            await recordEmailAttempt({ signedAgreementId: c.signedAgreementId, success: true, recipients: finalRecipients, userId });
        }
        return {
            success: true,
            message: `Sent ${contexts.length} signed ASA PDF(s) in one email to ${finalRecipients.length} address(es)`,
            signedAgreementIds: contexts.map((x) => x.signedAgreementId),
            recipients: finalRecipients
        };
    } catch (e) {
        const message = e && e.message ? e.message : String(e);
        for (const c of contexts) {
            /* eslint-disable no-await-in-loop */
            await recordEmailAttempt({ signedAgreementId: c.signedAgreementId, success: false, userId, error: message });
        }
        return { success: false, message, signedAgreementIds: contexts.map((x) => x.signedAgreementId), recipients: finalRecipients };
    }
}

/**
 * Build the HTML + text body + attachments for a signed-ASA email given a loaded context.
 * Centralised so both the automatic trigger and the manual "send from portal" flow produce
 * the same email.
 * @param {object} ctx  output of loadSignedAsaContext
 * @returns {Promise<{ subject:string, html:string, text:string, attachmentFilename:string,
 *                    pdfBuffer: Buffer|null, fallbackUrl: string|null }>}
 */
async function buildSignedAsaEmailBody(ctx) {
    const pdfBuffer = ctx.signedDocumentUrl ? await downloadSignedPdfBuffer(ctx.signedDocumentUrl) : null;
    const safeGroup = ctx.groupName.replace(/[^a-zA-Z0-9-_]/g, '_');
    const safeVendor = ctx.vendorName.replace(/[^a-zA-Z0-9-_]/g, '_');
    const attachmentFilename = `ASA-${safeVendor}-${safeGroup}.pdf`;

    let fallbackUrl = ctx.signedDocumentUrl || null;
    try {
        if (fallbackUrl) {
            const { isBlobUrl, generateAuthenticatedUrl } = require('../routes/uploads');
            if (isBlobUrl(fallbackUrl)) {
                fallbackUrl = await generateAuthenticatedUrl(fallbackUrl);
            }
        }
    } catch (e) {
        console.warn('⚠️ asaSignedTrigger: could not generate authenticated fallback URL:', e.message);
    }

    const signedWhen = ctx.signedDate instanceof Date
        ? ctx.signedDate.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
        : '';
    const subject = `ASA signed — ${ctx.vendorName} · ${ctx.groupName}`;
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table width="100%" cellspacing="0" cellpadding="0" style="padding:20px 12px;"><tr><td align="center">
<table width="100%" style="max-width:640px;background:#fff;border-radius:10px;border:1px solid #e5e7eb;padding:22px;">
<tr><td>
  <div style="font-size:18px;font-weight:700;color:#111827;margin-bottom:8px;">Vendor ASA Signed — ${escapeHtml(ctx.vendorName)}</div>
  <p style="font-size:14px;color:#4b5563;margin:0 0 16px;">A group signed the Agent Service Agreement for <strong>${escapeHtml(ctx.productName)}</strong>. The countersigned PDF is attached.</p>
  <table cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-bottom:16px;font-size:14px;color:#374151;">
    <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Group</td><td style="padding:4px 0;">${escapeHtml(ctx.groupName)}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Product</td><td style="padding:4px 0;">${escapeHtml(ctx.productName)}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Vendor</td><td style="padding:4px 0;">${escapeHtml(ctx.vendorName)}</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Signed by</td><td style="padding:4px 0;">${escapeHtml(ctx.signedByName)} &lt;${escapeHtml(ctx.signedByEmail)}&gt;</td></tr>
    <tr><td style="padding:4px 12px 4px 0;color:#6b7280;">Signed on</td><td style="padding:4px 0;">${escapeHtml(signedWhen)}</td></tr>
  </table>
  ${fallbackUrl ? `<p style="font-size:13px;color:#6b7280;margin:0;">Direct download link (expires): <a href="${escapeHtml(fallbackUrl)}" style="color:#2563eb;">View signed PDF</a></p>` : ''}
  ${!pdfBuffer ? `<p style="font-size:13px;color:#b45309;margin:12px 0 0;">Note: the PDF attachment was not available at send time — use the link above to download it.</p>` : ''}
</td></tr>
</table>
</td></tr></table>
</body></html>`;
    const text = [
        `Vendor ASA Signed — ${ctx.vendorName}`,
        '',
        `Group: ${ctx.groupName}`,
        `Product: ${ctx.productName}`,
        `Signed by: ${ctx.signedByName} <${ctx.signedByEmail}>`,
        `Signed on: ${signedWhen}`,
        fallbackUrl ? `Download: ${fallbackUrl}` : ''
    ].filter(Boolean).join('\n');

    return { subject, html, text, attachmentFilename, pdfBuffer, fallbackUrl };
}

/**
 * Manually email a single signed ASA. Used by the vendor portal "Signed ASAs" tab
 * (send / resend button). Records success or failure on SignedASAAgreements so the
 * UI can show sent-state.
 *
 * @param {object} opts
 * @param {string} opts.signedAgreementId
 * @param {string[]|string} [opts.recipients]  comma list or array; when empty falls back to vendor defaults
 * @param {string} [opts.userId]               user triggering the manual send (for audit)
 * @returns {Promise<{success:boolean, message:string, recipients:string[], signedAgreementId:string}>}
 */
async function sendSignedAsaEmail({ signedAgreementId, recipients, userId }) {
    const ctx = await loadSignedAsaContext(signedAgreementId);
    if (!ctx) return { success: false, message: 'Signed agreement not found', recipients: [], signedAgreementId };

    // Gate: skip when the signing group has no currently-active enrollments.
    const activeGroupSet = await getGroupIdsWithActiveEnrollments([ctx.groupId]);
    if (!activeGroupSet.has(String(ctx.groupId).toLowerCase())) {
        const message = 'Group has no active enrollments — skipped sending signed ASA.';
        await recordEmailAttempt({ signedAgreementId, success: false, userId, error: message });
        return { success: true, message, recipients: [], signedAgreementId, skippedNoActiveEnrollment: true };
    }

    const finalRecipients = await resolveManualAsaRecipients(ctx.vendorId, ctx.vendorEmail, recipients);

    if (finalRecipients.length === 0) {
        const message = 'No recipients — provide an email address or set vendor default contacts';
        await recordEmailAttempt({ signedAgreementId, success: false, userId, error: message });
        return { success: false, message, recipients: [], signedAgreementId };
    }

    try {
        const { subject, html, text, attachmentFilename, pdfBuffer } = await buildSignedAsaEmailBody(ctx);
        const attachments = pdfBuffer
            ? [{ content: pdfBuffer.toString('base64'), filename: attachmentFilename, type: 'application/pdf', disposition: 'attachment' }]
            : undefined;
        await sendGridEmailService.sendEmail({
            ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
            to: finalRecipients.length === 1 ? finalRecipients[0] : finalRecipients,
            subject, html, text,
            ...(attachments ? { attachments } : {}),
            metadata: { fromName: ctx.vendorName || 'AllAboard365' }
        });
        await recordEmailAttempt({ signedAgreementId, success: true, recipients: finalRecipients, userId });
        return {
            success: true,
            message: `Sent to ${finalRecipients.length} recipient(s)${pdfBuffer ? ' with PDF attached' : ' (link only — PDF unavailable)'}`,
            recipients: finalRecipients,
            signedAgreementId
        };
    } catch (e) {
        const message = e && e.message ? e.message : String(e);
        await recordEmailAttempt({ signedAgreementId, success: false, userId, error: message });
        return { success: false, message, recipients: finalRecipients, signedAgreementId };
    }
}

/**
 * @param {string} signedAgreementId
 * @param {object} ctx  pre-loaded from loadSignedAsaContext
 */
async function runAsaSignedTriggerImpl(signedAgreementId, ctx) {
    const errors = [];
    let triggered = 0;

    const unsentIds = await fetchUnsentSignedAgreementIdsForVendorGroup(
        ctx.vendorId,
        ctx.groupId,
        signedAgreementId
    );
    if (unsentIds.length === 0) {
        return {
            success: true,
            message: 'All ASAs for this group already emailed',
            triggered: 0,
            errors: []
        };
    }

    // Gate: don't auto-email vendor when the signing group has no currently-
    // active enrollments. The signed PDFs stay marked unsent so a later send
    // (manual / bulk) will pick them up once enrollments go live.
    const activeGroupSet = await getGroupIdsWithActiveEnrollments([ctx.groupId]);
    if (!activeGroupSet.has(String(ctx.groupId).toLowerCase())) {
        return {
            success: true,
            message: 'Group has no active enrollments — automatic ASA email skipped.',
            triggered: 0,
            errors: []
        };
    }

    const jobs = await getEnabledAsaSignedJobs(ctx.vendorId);
    if (!jobs.length) {
        return { success: true, message: 'No asa_signed jobs configured for vendor', triggered: 0, errors: [] };
    }

    const contexts = [];
    for (const id of unsentIds) {
        const c = await loadSignedAsaContext(id);
        if (c) {
            contexts.push(c);
        }
    }
    if (contexts.length === 0) {
        return { success: false, message: 'Could not load signed agreement context', triggered: 0, errors: ['load failed'] };
    }

    const { subject, html, text, attachments } = await buildBatchedSignedAsaEmailBody(contexts);
    const asaCount = contexts.length;
    const fileLabel = asaCount === 1
        ? (attachments[0] && attachments[0].filename) || 'ASA.pdf'
        : `${asaCount} PDFs`;

    let anySuccess = false;
    let lastSuccessRecipients = [];
    for (const job of jobs) {
        const jobId = job.VendorScheduledJobId;
        try {
            const recipients = await resolveRecipients(ctx.vendorId, job, ctx.vendorEmail);
            if (recipients.length === 0) {
                const em = 'No email recipients (set job email list or vendor Email / notification contacts)';
                errors.push(em);
                await VendorExportService.recordScheduledJobRun({
                    vendorScheduledJobId: jobId,
                    vendorId: ctx.vendorId,
                    jobType: 'asa_signed',
                    result: null,
                    error: em,
                    triggerSource: 'asa_signed'
                });
                continue;
            }

            await sendGridEmailService.sendEmail({
                ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
                to: recipients.length === 1 ? recipients[0] : recipients,
                subject,
                html,
                text,
                ...(attachments && attachments.length ? { attachments } : {}),
                metadata: { fromName: ctx.vendorName || 'AllAboard365' }
            });

            const result = {
                success: true,
                message: `Emailed ${asaCount} signed ASA(s) to ${recipients.length} recipient(s)${attachments && attachments.length ? ` (${attachments.length} PDF attachment(s))` : ' (link only)'}`,
                recordCount: asaCount,
                fileName: fileLabel,
                exportSkipped: false
            };
            try {
                await VendorExportService.touchScheduledJobLastRun(jobId);
            } catch (_) { /* ignore */ }
            await VendorExportService.recordScheduledJobRun({
                vendorScheduledJobId: jobId,
                vendorId: ctx.vendorId,
                jobType: 'asa_signed',
                result,
                error: null,
                triggerSource: 'asa_signed'
            });
            triggered += 1;
            anySuccess = true;
            lastSuccessRecipients = recipients;
        } catch (jobErr) {
            const em = jobErr && jobErr.message ? jobErr.message : String(jobErr);
            errors.push(em);
            try {
                await VendorExportService.recordScheduledJobRun({
                    vendorScheduledJobId: jobId,
                    vendorId: ctx.vendorId,
                    jobType: 'asa_signed',
                    result: null,
                    error: em,
                    triggerSource: 'asa_signed'
                });
            } catch (_) { /* ignore audit failure */ }
        }
    }

    if (anySuccess) {
        for (const c of contexts) {
            /* eslint-disable no-await-in-loop */
            await recordEmailAttempt({
                signedAgreementId: c.signedAgreementId,
                success: true,
                recipients: lastSuccessRecipients,
                userId: null
            });
        }
    } else if (errors.length > 0) {
        for (const c of contexts) {
            /* eslint-disable no-await-in-loop */
            await recordEmailAttempt({
                signedAgreementId: c.signedAgreementId,
                success: false,
                userId: null,
                error: errors[0]
            });
        }
    }

    return {
        success: errors.length === 0,
        message: `Processed ${jobs.length} asa_signed job(s); ${triggered} email(s) sent; ${asaCount} ASA(s) in batch; ${errors.length} error(s)`,
        triggered,
        errors
    };
}

/**
 * Main entry point. Call after a SignedASAAgreements row is inserted.
 * Fire-and-forget safe: swallows its own errors and always returns a result object.
 *
 * Batches all **unsent** ASAs in the same vendor+group into one message per asa_signed job
 * (multiple PDF attachments) so multi-product signings do not spam separate emails.
 *
 * @param {string} signedAgreementId
 * @returns {Promise<{ success: boolean, message?: string, triggered: number, errors: string[] }>}
 */
async function runAsaSignedTrigger(signedAgreementId) {
    const errors = [];
    let triggered = 0;
    try {
        if (!signedAgreementId) {
            return { success: false, message: 'signedAgreementId required', triggered: 0, errors: [] };
        }

        const ctx = await loadSignedAsaContext(signedAgreementId);
        if (!ctx) {
            return { success: false, message: 'Signed agreement not found', triggered: 0, errors: [] };
        }

        return await runSerializedVendorGroup(ctx.vendorId, ctx.groupId, () =>
            runAsaSignedTriggerImpl(signedAgreementId, ctx)
        );
    } catch (fatal) {
        const msg = fatal && fatal.message ? fatal.message : String(fatal);
        console.error('❌ asaSignedTrigger fatal:', msg);
        return { success: false, message: msg, triggered, errors: [...errors, msg] };
    }
}

module.exports = {
    runAsaSignedTrigger,
    sendSignedAsaEmail,
    sendBatchedSignedAsaForVendorGroup,
    sendBulkSignedAsaForVendor,
    // exposed for unit tests / manual invocation
    loadSignedAsaContext,
    downloadSignedPdfBuffer,
    getEnabledAsaSignedJobs,
    recordEmailAttempt,
    buildSignedAsaEmailBody,
    buildBatchedSignedAsaEmailBody,
    buildBulkSignedAsaEmailBody
};
