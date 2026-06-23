// services/notificationService.js
// In-app notifications for back-office (vendor) users, persisted in
// oe.Notifications. One row per recipient per event so read state is per-user.
//
// Writers (createMentionNotifications / createFormSubmissionNotifications) are
// best-effort: they never throw into the note-save or form-submission paths.
// Readers (listForVendorUser / markRead / markAllRead) are vendor-scoped — a
// user only ever sees rows for their own vendor.

const { getPool, sql } = require('../config/database');

const MAX_LIST = 50;
const SNIPPET_LEN = 500;
const LABEL_LEN = 255;

const clamp = (s, n) => (s == null ? null : String(s).slice(0, n));

/**
 * Insert one notification row. Best-effort: returns true on success, false on
 * failure (e.g. the table doesn't exist yet). When dedupeOnContext is set, the
 * row is skipped if one already exists for the same recipient + type + context
 * (used by form-submission fan-out so re-processing can't double-notify).
 */
async function insertOne(pool, row, { dedupeOnContext = false } = {}) {
    try {
        const req = pool.request();
        req.input('recipientUserId', sql.UniqueIdentifier, row.recipientUserId);
        req.input('vendorId', sql.UniqueIdentifier, row.vendorId || null);
        req.input('tenantId', sql.UniqueIdentifier, row.tenantId || null);
        req.input('type', sql.NVarChar, row.type);
        req.input('contextType', sql.NVarChar, row.contextType || null);
        req.input('contextId', sql.UniqueIdentifier, row.contextId || null);
        req.input('contextLabel', sql.NVarChar, clamp(row.contextLabel, LABEL_LEN));
        req.input('actorUserId', sql.UniqueIdentifier, row.actorUserId || null);
        req.input('actorName', sql.NVarChar, clamp(row.actorName, LABEL_LEN));
        req.input('body', sql.NVarChar, clamp(row.body, SNIPPET_LEN));
        req.input('href', sql.NVarChar, clamp(row.href, 500));

        const columns = `
            NotificationId, RecipientUserId, VendorId, TenantId, Type,
            ContextType, ContextId, ContextLabel, ActorUserId, ActorName, Body, Href`;
        const values = `
            NEWID(), @recipientUserId, @vendorId, @tenantId, @type,
            @contextType, @contextId, @contextLabel, @actorUserId, @actorName, @body, @href`;

        if (dedupeOnContext) {
            await req.query(`
                INSERT INTO oe.Notifications (${columns})
                SELECT ${values}
                WHERE NOT EXISTS (
                    SELECT 1 FROM oe.Notifications
                    WHERE RecipientUserId = @recipientUserId
                      AND Type = @type
                      AND ContextId = @contextId
                )
            `);
        } else {
            await req.query(`INSERT INTO oe.Notifications (${columns}) VALUES (${values})`);
        }
        return true;
    } catch (e) {
        console.error('[notifications] insert failed:', e.message);
        return false;
    }
}

/**
 * Bulk-create notification rows. Best-effort, never throws.
 * @param {Array<Object>} rows
 * @param {{ dedupeOnContext?: boolean }} [opts]
 * @returns {Promise<{ created: number }>}
 */
async function createNotifications(rows, opts = {}) {
    const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.recipientUserId && r.type);
    if (list.length === 0) return { created: 0 };
    try {
        const pool = await getPool();
        let created = 0;
        for (const row of list) {
            // eslint-disable-next-line no-await-in-loop
            if (await insertOne(pool, row, opts)) created += 1;
        }
        return { created };
    } catch (e) {
        console.error('[notifications] createNotifications failed:', e.message);
        return { created: 0 };
    }
}

/**
 * Create in-app mention notifications for already-validated recipients.
 * Callers (noteMentionService) resolve + security-check the recipient list, so
 * this just writes one row each. Resolves a friendly context label
 * (RequestNumber / CaseNumber) for display.
 *
 * @param {Object} p
 * @param {Array<{UserId:string}>} p.recipients  validated recipients
 * @param {string} p.vendorId
 * @param {string} [p.tenantId]
 * @param {'share-request'|'case'} p.contextType
 * @param {string} p.contextId
 * @param {string} p.actorUserId
 * @param {string} [p.actorName]
 * @param {string} p.body       note snippet
 * @param {string} p.href       deep link
 */
async function createMentionNotifications({
    recipients,
    vendorId,
    tenantId,
    contextType,
    contextId,
    actorUserId,
    actorName,
    body,
    href
}) {
    const targets = (Array.isArray(recipients) ? recipients : []).filter((r) => r && r.UserId);
    if (targets.length === 0 || !contextId) return { created: 0 };

    let contextLabel = null;
    try {
        const pool = await getPool();
        const labelReq = pool.request();
        labelReq.input('id', sql.UniqueIdentifier, contextId);
        const query =
            contextType === 'case'
                ? `SELECT TOP 1 CaseNumber AS Label FROM oe.Cases WHERE CaseId = @id`
                : `SELECT TOP 1 RequestNumber AS Label FROM oe.ShareRequests WHERE ShareRequestId = @id`;
        const r = await labelReq.query(query);
        contextLabel = r.recordset?.[0]?.Label || null;
    } catch (e) {
        console.warn('[notifications] mention label lookup failed:', e.message);
    }

    const rows = targets.map((r) => ({
        recipientUserId: r.UserId,
        vendorId,
        tenantId,
        type: 'mention',
        contextType,
        contextId,
        contextLabel,
        actorUserId,
        actorName,
        body,
        href
    }));
    return createNotifications(rows);
}

/**
 * Fan a new-form-submission notification out to every active user of the vendor
 * that owns the form template. Best-effort; deduped per recipient + submission.
 *
 * @param {Object} p
 * @param {string} p.vendorId       DefaultVendorId of the form template
 * @param {string} [p.tenantId]
 * @param {string} p.submissionId
 * @param {string} [p.formTitle]
 */
async function createFormSubmissionNotifications({ vendorId, tenantId, submissionId, formTitle }) {
    if (!vendorId || !submissionId) return { created: 0 };
    try {
        const pool = await getPool();
        const usersReq = pool.request();
        usersReq.input('vendorId', sql.UniqueIdentifier, vendorId);
        const usersRes = await usersReq.query(`
            SELECT UserId
            FROM oe.Users
            WHERE VendorId = @vendorId AND Status = 'Active'
        `);
        const userIds = (usersRes.recordset || []).map((u) => u.UserId).filter(Boolean);
        if (userIds.length === 0) return { created: 0 };

        const href = `/vendor/sharing-forms/submissions/${submissionId}`;
        const rows = userIds.map((userId) => ({
            recipientUserId: userId,
            vendorId,
            tenantId,
            type: 'form-submission',
            contextType: 'form-submission',
            contextId: submissionId,
            contextLabel: formTitle || 'New form submission',
            actorUserId: null,
            actorName: null,
            body: null,
            href
        }));
        return createNotifications(rows, { dedupeOnContext: true });
    } catch (e) {
        console.error('[notifications] createFormSubmissionNotifications failed:', e.message);
        return { created: 0 };
    }
}

/**
 * List a vendor user's notifications (newest first) plus their unread count.
 * Vendor-scoped: only rows for this recipient AND vendor are returned.
 */
async function listForVendorUser({ userId, vendorId, limit = MAX_LIST }) {
    const pool = await getPool();
    const top = Math.min(Math.max(parseInt(limit, 10) || MAX_LIST, 1), MAX_LIST);

    const listReq = pool.request();
    listReq.input('userId', sql.UniqueIdentifier, userId);
    listReq.input('vendorId', sql.UniqueIdentifier, vendorId);
    const listRes = await listReq.query(`
        SELECT TOP ${top}
            NotificationId, Type, ContextType, ContextId, ContextLabel,
            ActorName, Body, Href, IsRead, CreatedDate
        FROM oe.Notifications
        WHERE RecipientUserId = @userId AND VendorId = @vendorId
        ORDER BY CreatedDate DESC
    `);

    const countReq = pool.request();
    countReq.input('userId', sql.UniqueIdentifier, userId);
    countReq.input('vendorId', sql.UniqueIdentifier, vendorId);
    const countRes = await countReq.query(`
        SELECT COUNT(*) AS UnreadCount
        FROM oe.Notifications
        WHERE RecipientUserId = @userId AND VendorId = @vendorId AND IsRead = 0
    `);

    const data = (listRes.recordset || []).map((row) => ({
        id: row.NotificationId,
        type: row.Type,
        contextType: row.ContextType,
        contextId: row.ContextId,
        contextLabel: row.ContextLabel || '',
        noteSnippet: row.Body || null,
        createdByName: row.ActorName || null,
        createdDate: row.CreatedDate,
        href: row.Href || '',
        isRead: !!row.IsRead
    }));

    return { data, unreadCount: countRes.recordset?.[0]?.UnreadCount || 0 };
}

/**
 * Mark specific notifications read. Scoped to recipient + vendor so a user
 * can't flip read state on someone else's rows.
 */
async function markRead({ userId, vendorId, ids }) {
    const list = (Array.isArray(ids) ? ids : []).map((x) => String(x || '').trim()).filter(Boolean);
    if (list.length === 0) return { updated: 0 };
    const pool = await getPool();
    const req = pool.request();
    req.input('userId', sql.UniqueIdentifier, userId);
    req.input('vendorId', sql.UniqueIdentifier, vendorId);
    list.forEach((id, i) => req.input(`n${i}`, sql.UniqueIdentifier, id));
    const inList = list.map((_, i) => `@n${i}`).join(', ');
    const res = await req.query(`
        UPDATE oe.Notifications
        SET IsRead = 1, ReadDate = SYSUTCDATETIME()
        WHERE RecipientUserId = @userId
          AND VendorId = @vendorId
          AND IsRead = 0
          AND NotificationId IN (${inList})
    `);
    return { updated: res.rowsAffected?.[0] || 0 };
}

/** Mark all of a vendor user's unread notifications read. */
async function markAllRead({ userId, vendorId }) {
    const pool = await getPool();
    const req = pool.request();
    req.input('userId', sql.UniqueIdentifier, userId);
    req.input('vendorId', sql.UniqueIdentifier, vendorId);
    const res = await req.query(`
        UPDATE oe.Notifications
        SET IsRead = 1, ReadDate = SYSUTCDATETIME()
        WHERE RecipientUserId = @userId AND VendorId = @vendorId AND IsRead = 0
    `);
    return { updated: res.rowsAffected?.[0] || 0 };
}

module.exports = {
    createNotifications,
    createMentionNotifications,
    createFormSubmissionNotifications,
    listForVendorUser,
    markRead,
    markAllRead
};
