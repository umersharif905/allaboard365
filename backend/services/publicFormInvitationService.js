// publicFormInvitationService — create + redeem + revoke "send to member" invitations.
//
// Tokens are 64-char hex strings (32 random bytes). The plaintext token lives
// only in the URL handed to the care team / emailed to the recipient; the DB
// stores SHA-256(token) in TokenHash. Invitations are multi-use within their
// expiry window; FirstUsedAt records when they were first submitted against.
//
// Spec: docs/superpowers/specs/2026-05-13-forms-redesign/design.md
//   Sections 1 (schema), 2 (send modal), 3 (targeted flow), 4 (authenticated flow).

const crypto = require('crypto');
const { getPool, sql } = require('../config/database');

const DEFAULT_EXPIRY_DAYS = 7;
const TOKEN_BYTES = 32;
const VALID_MODES = new Set(['targeted', 'authenticated']);
const VALID_DELIVERY_METHODS = new Set(['email', 'copy', 'both']);

function generateTokenAndHash() {
    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    return { token, hash };
}

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * @returns {Promise<{invitationId: string, token: string, expiresAt: Date}>}
 */
async function createInvitation({
    tenantId,
    formTemplateId,
    memberId,
    mode,
    linkedShareRequestId = null,
    linkedCaseId = null,
    deliveryMethod,
    sentByUserId,
    sentToEmail,
    expiryDays = DEFAULT_EXPIRY_DAYS
}) {
    if (!VALID_MODES.has(mode)) {
        throw new Error(`Invalid mode: ${mode}`);
    }
    if (!VALID_DELIVERY_METHODS.has(deliveryMethod)) {
        throw new Error(`Invalid deliveryMethod: ${deliveryMethod}`);
    }
    if (!sentToEmail || !/^.+@.+\..+$/.test(sentToEmail)) {
        throw new Error('Invalid recipient email');
    }

    const invitationId = crypto.randomUUID();
    const { token, hash } = generateTokenAndHash();
    const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

    const pool = await getPool();
    await pool.request()
        .input('invitationId', sql.UniqueIdentifier, invitationId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('formTemplateId', sql.UniqueIdentifier, formTemplateId)
        .input('memberId', sql.UniqueIdentifier, memberId)
        .input('mode', sql.NVarChar(20), mode)
        .input('linkedShareRequestId', sql.UniqueIdentifier, linkedShareRequestId)
        .input('linkedCaseId', sql.UniqueIdentifier, linkedCaseId)
        .input('tokenHash', sql.Char(64), hash)
        .input('expiresAt', sql.DateTime2, expiresAt)
        .input('deliveryMethod', sql.NVarChar(20), deliveryMethod)
        .input('sentByUserId', sql.UniqueIdentifier, sentByUserId)
        .input('sentToEmail', sql.NVarChar(254), sentToEmail)
        .query(`
            INSERT INTO oe.PublicFormInvitations (
                InvitationId, TenantId, FormTemplateId, MemberId, Mode,
                LinkedShareRequestId, LinkedCaseId, TokenHash, ExpiresAt,
                DeliveryMethod, SentByUserId, SentToEmail
            ) VALUES (
                @invitationId, @tenantId, @formTemplateId, @memberId, @mode,
                @linkedShareRequestId, @linkedCaseId, @tokenHash, @expiresAt,
                @deliveryMethod, @sentByUserId, @sentToEmail
            )
        `);

    return { invitationId, token, expiresAt };
}

/**
 * Look up an invitation by its plaintext token. Returns null on miss / expired /
 * revoked. Callers MUST treat all failure modes identically (no oracle).
 *
 * @returns {Promise<null | {
 *   invitationId: string,
 *   tenantId: string,
 *   formTemplateId: string,
 *   memberId: string,
 *   mode: 'targeted' | 'authenticated',
 *   linkedShareRequestId: string | null,
 *   linkedCaseId: string | null,
 *   expiresAt: Date,
 *   firstUsedAt: Date | null,
 *   sentToEmail: string
 * }>}
 */
async function findActiveByToken(token) {
    const hash = hashToken(token);
    const pool = await getPool();
    const r = await pool.request()
        .input('tokenHash', sql.Char(64), hash)
        .query(`
            SELECT
                InvitationId, TenantId, FormTemplateId, MemberId, Mode,
                LinkedShareRequestId, LinkedCaseId, ExpiresAt, FirstUsedAt,
                SentToEmail
            FROM oe.PublicFormInvitations
            WHERE TokenHash = @tokenHash
              AND RevokedAt IS NULL
              AND ExpiresAt > SYSUTCDATETIME()
        `);
    const row = r.recordset[0];
    if (!row) return null;
    return {
        invitationId: row.InvitationId,
        tenantId: row.TenantId,
        formTemplateId: row.FormTemplateId,
        memberId: row.MemberId,
        mode: row.Mode,
        linkedShareRequestId: row.LinkedShareRequestId,
        linkedCaseId: row.LinkedCaseId,
        expiresAt: row.ExpiresAt,
        firstUsedAt: row.FirstUsedAt,
        sentToEmail: row.SentToEmail
    };
}

/**
 * Stamp FirstUsedAt if it is currently NULL. Idempotent.
 */
async function markFirstUsed(invitationId) {
    const pool = await getPool();
    await pool.request()
        .input('invitationId', sql.UniqueIdentifier, invitationId)
        .query(`
            UPDATE oe.PublicFormInvitations
            SET FirstUsedAt = SYSUTCDATETIME()
            WHERE InvitationId = @invitationId AND FirstUsedAt IS NULL
        `);
}

/**
 * Revoke. Only succeeds if invitation belongs to the given tenant. Returns
 * { ok: true } on success, { ok: false, reason } on failure.
 */
async function revokeInvitation({ invitationId, tenantId }) {
    const pool = await getPool();
    const r = await pool.request()
        .input('invitationId', sql.UniqueIdentifier, invitationId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
            UPDATE oe.PublicFormInvitations
            SET RevokedAt = SYSUTCDATETIME()
            WHERE InvitationId = @invitationId
              AND TenantId = @tenantId
              AND RevokedAt IS NULL
        `);
    if (!r.rowsAffected || r.rowsAffected[0] === 0) {
        return { ok: false, reason: 'not_found_or_already_revoked' };
    }
    return { ok: true };
}

/**
 * List invitations for a template (audit view). Excludes the plaintext token
 * (we don't store it). Returns most recent first.
 */
async function listForTemplate({ tenantId, formTemplateId }) {
    const pool = await getPool();
    const r = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('formTemplateId', sql.UniqueIdentifier, formTemplateId)
        .query(`
            SELECT
                i.InvitationId, i.MemberId, i.Mode, i.LinkedShareRequestId,
                i.LinkedCaseId, i.ExpiresAt, i.FirstUsedAt, i.DeliveryMethod,
                i.RevokedAt, i.SentByUserId, i.SentToEmail, i.CreatedDate,
                u.FirstName + ' ' + u.LastName AS SentByName,
                mu.FirstName + ' ' + mu.LastName AS MemberName,
                (
                    SELECT COUNT(1)
                    FROM oe.PublicFormSubmissions s
                    WHERE s.InvitationId = i.InvitationId
                ) AS SubmissionCount
            FROM oe.PublicFormInvitations i
            LEFT JOIN oe.Users u ON u.UserId = i.SentByUserId
            LEFT JOIN oe.Members m ON m.MemberId = i.MemberId
            LEFT JOIN oe.Users mu ON mu.UserId = m.UserId
            WHERE i.TenantId = @tenantId
              AND i.FormTemplateId = @formTemplateId
            ORDER BY i.CreatedDate DESC
        `);
    return r.recordset;
}

/**
 * List invitations addressed to a specific member, tenant-scoped, newest
 * first. Used by the care-team member workspace so revoke / status can
 * render inline alongside the member's submissions (followup A.1.b).
 */
async function listForMember({ tenantId, memberId }) {
    const pool = await getPool();
    const r = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('memberId', sql.UniqueIdentifier, memberId)
        .query(`
            SELECT
                i.InvitationId, i.FormTemplateId, i.MemberId, i.Mode,
                i.LinkedShareRequestId, i.LinkedCaseId, i.ExpiresAt,
                i.FirstUsedAt, i.DeliveryMethod, i.RevokedAt,
                i.SentByUserId, i.SentToEmail, i.CreatedDate,
                t.Title AS FormTitle, t.FormKind,
                u.FirstName + ' ' + u.LastName AS SentByName,
                (
                    SELECT COUNT(1)
                    FROM oe.PublicFormSubmissions s
                    WHERE s.InvitationId = i.InvitationId
                ) AS SubmissionCount
            FROM oe.PublicFormInvitations i
            INNER JOIN oe.PublicFormTemplates t ON t.FormTemplateId = i.FormTemplateId
            LEFT JOIN oe.Users u ON u.UserId = i.SentByUserId
            WHERE i.TenantId = @tenantId
              AND i.MemberId = @memberId
            ORDER BY i.CreatedDate DESC
        `);
    return r.recordset;
}

/**
 * Renew an invitation by revoking the old one and issuing a new one with
 * the same template / member / mode / linkage / recipient. The plaintext
 * token from the original send is gone (only the hash is stored), so a
 * true "resend the same link" isn't possible — a renew issues a fresh
 * token. The old recipient link returns 410 Gone immediately.
 *
 * Forms-page redesign punch-list B-028.
 */
async function renewInvitation({ invitationId, tenantId, sentByUserId, deliveryMethod }) {
    const pool = await getPool();
    const cur = (await pool.request()
        .input('invitationId', sql.UniqueIdentifier, invitationId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
            SELECT InvitationId, FormTemplateId, MemberId, Mode,
                   LinkedShareRequestId, LinkedCaseId, SentToEmail, DeliveryMethod
            FROM oe.PublicFormInvitations
            WHERE InvitationId = @invitationId AND TenantId = @tenantId
        `)).recordset[0];
    if (!cur) return { ok: false, reason: 'not_found' };
    if (!cur.SentToEmail) return { ok: false, reason: 'no_recipient' };
    // Revoke the old invitation. The original token-hash row stays in the
    // table for audit; subsequent token lookups will see RevokedAt and
    // return 410.
    await pool.request()
        .input('invitationId', sql.UniqueIdentifier, invitationId)
        .query(`
            UPDATE oe.PublicFormInvitations
            SET RevokedAt = SYSUTCDATETIME()
            WHERE InvitationId = @invitationId AND RevokedAt IS NULL
        `);
    // Issue a fresh invitation with the same parameters.
    const created = await createInvitation({
        tenantId,
        formTemplateId: cur.FormTemplateId,
        memberId: cur.MemberId,
        mode: cur.Mode,
        linkedShareRequestId: cur.LinkedShareRequestId || null,
        linkedCaseId: cur.LinkedCaseId || null,
        deliveryMethod: deliveryMethod || cur.DeliveryMethod || 'copy',
        sentByUserId,
        sentToEmail: cur.SentToEmail
    });
    return {
        ok: true,
        invitationId: created.invitationId,
        token: created.token,
        expiresAt: created.expiresAt,
        sentToEmail: cur.SentToEmail,
        formTemplateId: cur.FormTemplateId,
        mode: cur.Mode
    };
}

/**
 * Update an invitation's expiry. Used by the care team to extend an
 * invitation past its original 7-day window without revoking + re-sending.
 * Tenant-scoped; rejects revoked invitations and refuses to set the new
 * expiry to a time in the past.
 *
 * Forms-page redesign Slice D / punch-list B-015.
 */
async function updateExpiry({ invitationId, tenantId, expiresAt }) {
    const pool = await getPool();
    const cur = (await pool.request()
        .input('invitationId', sql.UniqueIdentifier, invitationId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
            SELECT InvitationId, RevokedAt
            FROM oe.PublicFormInvitations
            WHERE InvitationId = @invitationId AND TenantId = @tenantId
        `)).recordset[0];
    if (!cur) return { ok: false, reason: 'not_found' };
    if (cur.RevokedAt) return { ok: false, reason: 'revoked' };
    const next = new Date(expiresAt);
    if (Number.isNaN(next.getTime())) return { ok: false, reason: 'invalid_date' };
    if (next.getTime() <= Date.now()) return { ok: false, reason: 'past' };
    await pool.request()
        .input('invitationId', sql.UniqueIdentifier, invitationId)
        .input('expiresAt', sql.DateTime2, next)
        .query(`
            UPDATE oe.PublicFormInvitations
            SET ExpiresAt = @expiresAt
            WHERE InvitationId = @invitationId
        `);
    return { ok: true, expiresAt: next.toISOString() };
}

/**
 * Single invitation row for audit. Tenant-scoped.
 */
async function getById({ invitationId, tenantId }) {
    const pool = await getPool();
    const r = await pool.request()
        .input('invitationId', sql.UniqueIdentifier, invitationId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
            SELECT
                i.InvitationId, i.FormTemplateId, i.MemberId, i.Mode,
                i.LinkedShareRequestId, i.LinkedCaseId, i.ExpiresAt,
                i.FirstUsedAt, i.DeliveryMethod, i.RevokedAt, i.SentByUserId,
                i.SentToEmail, i.CreatedDate,
                u.FirstName + ' ' + u.LastName AS SentByName,
                mu.FirstName AS MemberFirstName,
                mu.LastName AS MemberLastName
            FROM oe.PublicFormInvitations i
            LEFT JOIN oe.Users u ON u.UserId = i.SentByUserId
            LEFT JOIN oe.Members m ON m.MemberId = i.MemberId
            LEFT JOIN oe.Users mu ON mu.UserId = m.UserId
            WHERE i.InvitationId = @invitationId
              AND i.TenantId = @tenantId
        `);
    return r.recordset[0] || null;
}

/**
 * Greeting payload for a targeted-mode form load. Returns ONLY:
 *   { firstName, sentToEmail }
 * Never returns last name, DOB, MemberId, address, etc. Callers pass the
 * `invitation` object returned by findActiveByToken — this function then
 * looks up the member's first name.
 */
async function getTargetedGreeting(invitation) {
    const pool = await getPool();
    const r = await pool.request()
        .input('memberId', sql.UniqueIdentifier, invitation.memberId)
        .query(`
            SELECT u.FirstName AS FirstName
            FROM oe.Members m
            INNER JOIN oe.Users u ON u.UserId = m.UserId
            WHERE m.MemberId = @memberId
        `);
    const row = r.recordset[0];
    return {
        firstName: row ? row.FirstName : null,
        sentToEmail: invitation.sentToEmail
    };
}

/**
 * Build the recipient-facing URL for an invitation token.
 *
 * The frontend route /forms/i/:token mounts an InvitationRouter that fetches
 * the invitation meta (mode) and either renders the targeted form inline or
 * redirects through /login.
 *
 * Base URL resolution mirrors notifications: explicit override → env vars →
 * the request's Origin / Referer / forwarded proto+host → hard-coded
 * localhost fallback. Passing { req } from the route handler is what makes
 * the URL land on the dev machine's actual LAN IP instead of `localhost` in
 * docker-dev where FRONTEND_URL isn't set.
 */
function buildInvitationUrl(token, opts = {}) {
    const fromOpts = opts.appBaseUrl ? String(opts.appBaseUrl).replace(/\/+$/, '') : '';
    let base = fromOpts;
    if (!base && opts.req) {
        // Lazy-require to avoid an import cycle with publicFormNotifyService,
        // which also pulls invitation helpers in some paths.
        try {
            const { resolveSubmissionLinkBase } = require('./publicFormNotifyService');
            const resolved = resolveSubmissionLinkBase(opts.req);
            if (resolved) base = resolved;
        } catch {
            // fall through to env / localhost
        }
    }
    if (!base) {
        base = (
            process.env.FRONTEND_URL
            || process.env.APP_URL
            || process.env.VITE_APP_URL
            || process.env.DEFAULT_APP_URL
            || 'http://localhost:5173'
        ).replace(/\/+$/, '');
    }
    return `${base}/forms/i/${token}`;
}

/**
 * Send the invitation email via SendGrid. Caller decides whether to invoke
 * based on deliveryMethod. Failures here MUST NOT roll back the invitation —
 * the URL was already returned so the care team can hand it over manually.
 *
 * Returns { sent: true } on success, { sent: false, error } on failure.
 */
async function sendInvitationEmail({
    sendGridService,
    recipientEmail,
    recipientFirstName,
    formTitle,
    invitationUrl,
    mode,
    expiresAt,
    tenantName
}) {
    const safeFormTitle = String(formTitle || 'a form').slice(0, 200);
    const safeFirstName = String(recipientFirstName || '').slice(0, 100).trim() || 'there';
    const safeTenant = String(tenantName || 'your care team').slice(0, 200);
    const expiresLine = expiresAt
        ? `This link expires on ${new Date(expiresAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}.`
        : '';
    const loginNote = mode === 'authenticated'
        ? 'You will be asked to log into your account before filling the form.'
        : 'No login required — the link is uniquely tied to your account.';
    const subject = `Please fill out: ${safeFormTitle}`;
    const text = [
        `Hi ${safeFirstName},`,
        '',
        `${safeTenant} has sent you a form to fill out: ${safeFormTitle}.`,
        '',
        loginNote,
        '',
        `Open the form: ${invitationUrl}`,
        '',
        expiresLine,
        '',
        'If you did not expect this email, please ignore it.'
    ].filter(Boolean).join('\n');
    const html = `
        <p>Hi ${safeFirstName},</p>
        <p>${safeTenant} has sent you a form to fill out: <strong>${safeFormTitle}</strong>.</p>
        <p>${loginNote}</p>
        <p><a href="${invitationUrl}" style="display:inline-block;background:#1f8dbf;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;">Open the form</a></p>
        ${expiresLine ? `<p style="color:#666;font-size:12px;">${expiresLine}</p>` : ''}
        <p style="color:#999;font-size:11px;">If you did not expect this email, please ignore it.</p>
    `;
    try {
        await sendGridService.sendEmail({
            to: recipientEmail,
            subject,
            text,
            html
        });
        return { sent: true };
    } catch (err) {
        return { sent: false, error: err.message || String(err) };
    }
}

/**
 * Send a plain anonymous form link (no invitation token, no member binding).
 * Used by the Send-to-member modal's "Anonymous" delivery option (B-012)
 * so the care team can email a broadcast link without creating an
 * invitation row.
 *
 * Returns { sent: true } on success, { sent: false, error } on failure.
 */
async function sendAnonymousLinkEmail({
    sendGridService,
    recipientEmail,
    formTitle,
    formUrl,
    tenantName,
    customMessage
}) {
    const safeFormTitle = String(formTitle || 'a form').slice(0, 200);
    const safeTenant = String(tenantName || 'your care team').slice(0, 200);
    const safeMessage = customMessage
        ? String(customMessage).slice(0, 2000).trim()
        : '';
    const subject = `Please fill out: ${safeFormTitle}`;
    const introText = safeMessage
        || `${safeTenant} has sent you a form to fill out.`;
    const text = [
        introText,
        '',
        `Open the form: ${formUrl}`,
        '',
        'This link is open to anyone with the URL.'
    ].join('\n');
    const html = `
        <p>${introText.replace(/</g, '&lt;')}</p>
        <p><strong>${safeFormTitle}</strong></p>
        <p><a href="${formUrl}" style="display:inline-block;background:#1f8dbf;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;">Open the form</a></p>
        <p style="color:#999;font-size:11px;">This link is open to anyone with the URL.</p>
    `;
    try {
        await sendGridService.sendEmail({
            to: recipientEmail,
            subject,
            text,
            html
        });
        return { sent: true };
    } catch (err) {
        return { sent: false, error: err.message || String(err) };
    }
}

module.exports = {
    DEFAULT_EXPIRY_DAYS,
    generateTokenAndHash,
    hashToken,
    createInvitation,
    findActiveByToken,
    markFirstUsed,
    revokeInvitation,
    listForTemplate,
    listForMember,
    renewInvitation,
    updateExpiry,
    getById,
    getTargetedGreeting,
    buildInvitationUrl,
    sendInvitationEmail,
    sendAnonymousLinkEmail
};
