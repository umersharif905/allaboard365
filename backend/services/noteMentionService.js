// services/noteMentionService.js
// Emails VendorAgents/VendorAdmins who were @-mentioned in a Share Request or
// Case note. Best-effort: this never throws into the note-save path — a note
// must still save even if notification email fails.
//
// Security: recipient ids are re-validated server-side against the author's
// vendor (active users only) so a tampered client payload can't email
// arbitrary people. The note author is always excluded.

const { getPool, sql } = require('../config/database');
const MessageQueueService = require('./messageQueue.service');
const notificationService = require('./notificationService');

const escapeHtml = (s) =>
    String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

/**
 * @param {Object} params
 * @param {string} params.authorUserId      UserId of the note author
 * @param {string} [params.authorName]      Display name of the note author
 * @param {string[]} params.mentionedUserIds Candidate tagged UserIds (from client)
 * @param {string} params.vendorId          Vendor that owns the record
 * @param {'share-request'|'case'} params.contextType
 * @param {string} params.contextId         Share Request / Case id
 * @param {string} [params.contextLabel]    Friendly label (e.g. member name)
 * @param {string} params.noteText          The note body
 * @param {string} params.baseUrl           App origin for the deep link
 * @returns {Promise<{sent:number, error?:string}>}
 */
async function sendNoteMentionEmails({
    authorUserId,
    authorName,
    mentionedUserIds,
    vendorId,
    contextType,
    contextId,
    contextLabel,
    noteText,
    baseUrl
}) {
    try {
        const ids = Array.from(
            new Set(
                (Array.isArray(mentionedUserIds) ? mentionedUserIds : [])
                    .map((x) => String(x == null ? '' : x).trim())
                    .filter(Boolean)
            )
        ).filter((id) => id !== String(authorUserId));

        if (ids.length === 0 || !vendorId || !contextId) {
            return {
                sent: 0,
                reason: `no_targets (ids=${ids.length}, vendorId=${!!vendorId}, contextId=${!!contextId})`
            };
        }

        const pool = await getPool();

        // oe.Vendors has no TenantId column — resolve the vendor's tenant via
        // its products, the same way VendorExportService.getPrimaryTenantInfoForVendor
        // does. queueEmail needs a tenantId to resolve from-address / immediate send.
        const vReq = pool.request();
        vReq.input('vendorId', sql.UniqueIdentifier, vendorId);
        const vRes = await vReq.query(`
            SELECT TOP 1 t.TenantId
            FROM oe.Products p
            INNER JOIN oe.Tenants t ON p.ProductOwnerId = t.TenantId
            WHERE p.VendorId = @vendorId AND p.ProductOwnerId IS NOT NULL
            ORDER BY t.Name
        `);
        const tenantId = vRes.recordset && vRes.recordset[0] && vRes.recordset[0].TenantId;
        if (!tenantId) {
            return { sent: 0, reason: 'vendor_has_no_tenant (no product/tenant link)' };
        }

        const reqU = pool.request();
        reqU.input('vendorId', sql.UniqueIdentifier, vendorId);
        ids.forEach((id, i) => reqU.input(`u${i}`, sql.UniqueIdentifier, id));
        const inList = ids.map((_, i) => `@u${i}`).join(', ');
        const uRes = await reqU.query(`
            SELECT UserId, FirstName, LastName, Email
            FROM oe.Users
            WHERE VendorId = @vendorId
              AND Status = 'Active'
              AND UserId IN (${inList})
        `);

        const recipients = (uRes.recordset || []).filter((r) => r.Email);
        if (recipients.length === 0) {
            return {
                sent: 0,
                reason: `no_active_recipients_with_email (matched=${(uRes.recordset || []).length} of ${ids.length} tagged)`
            };
        }

        const contextWord = contextType === 'case' ? 'case' : 'share request';
        const path =
            contextType === 'case'
                ? `/vendor/cases/${encodeURIComponent(contextId)}?tab=notes`
                : `/vendor/share-requests/${encodeURIComponent(contextId)}?tab=notes`;
        const link = `${String(baseUrl || '').replace(/\/+$/, '')}${path}`;
        const safeLabel = contextLabel ? String(contextLabel).trim() : '';
        const author = (authorName && String(authorName).trim()) || 'A teammate';
        const snippet = String(noteText || '').trim().slice(0, 600);

        const subject = safeLabel
            ? `${author} mentioned you in a note on ${safeLabel}`
            : `${author} mentioned you in a ${contextWord} note`;

        const headline = safeLabel
            ? `${escapeHtml(author)} mentioned you in a note on <strong>${escapeHtml(safeLabel)}</strong>.`
            : `${escapeHtml(author)} mentioned you in a note on a ${escapeHtml(contextWord)}.`;

        const htmlContent = `
<div style="font-family:Arial,Helvetica,sans-serif;color:#111827;line-height:1.5;">
  <p style="font-size:15px;margin:0 0 16px;">${headline}</p>
  <blockquote style="margin:0 0 20px;padding:12px 16px;background:#f3f4f6;border-left:4px solid #1f8dbf;border-radius:6px;font-size:14px;color:#374151;white-space:pre-wrap;">${escapeHtml(snippet)}</blockquote>
  <p style="margin:0 0 24px;">
    <a href="${escapeHtml(link)}" style="display:inline-block;background:#1f8dbf;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:6px;">Open the ${escapeHtml(contextWord)}</a>
  </p>
  <p style="font-size:12px;color:#6b7280;margin:0;">If the button doesn't work, copy this link into your browser:<br><span style="color:#1f8dbf;">${escapeHtml(link)}</span></p>
</div>`.trim();

        const textContent = [
            `${author} mentioned you in a note on ${safeLabel || `a ${contextWord}`}.`,
            '',
            snippet,
            '',
            `Open the ${contextWord}: ${link}`
        ].join('\n');

        // In-app notification rows for the bell (best-effort; reuses the
        // already security-validated recipient list so we don't re-resolve or
        // re-authorize who gets notified).
        await notificationService.createMentionNotifications({
            recipients,
            vendorId,
            tenantId,
            contextType,
            contextId,
            actorUserId: authorUserId,
            actorName: author,
            body: snippet,
            href: link
        });

        let sent = 0;
        for (const r of recipients) {
            try {
                await MessageQueueService.queueEmail({
                    tenantId,
                    toEmail: r.Email,
                    toName:
                        `${r.FirstName || ''} ${r.LastName || ''}`.trim() || r.Email,
                    subject,
                    htmlContent,
                    textContent,
                    messageType: 'Email',
                    createdBy: authorUserId,
                    recipientId: r.UserId,
                    tryImmediateSend: true
                });
                sent += 1;
            } catch (e) {
                console.error(
                    `[noteMention] email queue failed for user ${r.UserId}:`,
                    e.message
                );
            }
        }

        return { sent };
    } catch (e) {
        console.error('[noteMention] sendNoteMentionEmails failed:', e.message);
        return { sent: 0, error: e.message };
    }
}

module.exports = { sendNoteMentionEmails };
