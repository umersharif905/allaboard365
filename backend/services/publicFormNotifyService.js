const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getPool, sql } = require('../config/database');
const SendGridEmailService = require('./sendGridEmailService');
const MessageQueueService = require('./messageQueue.service');
const { prepareInlineEmailHeaderBuffer } = require('./emailHeaderLogoTransparency');

const SUBMITTER_CONFIRM_EMAIL_BG = '#FFFFFF';

/** Inline header image: use a transparent PNG so alpha shows the white body (SUBMITTER_CONFIRM_EMAIL_BG). */
const SHAREWELL_HEADER_LOGO_CID = 'sharewell_header_logo';
const SHAREWELL_HEADER_LOGO_PATH = path.join(__dirname, '../assets/email/sharewell-partners-logo.png');

function hashRecipient(email) {
    return crypto.createHash('sha256').update(String(email).toLowerCase().trim()).digest('hex');
}

function appBaseUrl() {
    return (
        process.env.FRONTEND_URL ||
        process.env.APP_URL ||
        process.env.VITE_APP_URL ||
        process.env.DEFAULT_APP_URL ||
        ''
    ).replace(/\/$/, '');
}

/**
 * Normalize a caller-supplied link base override (e.g. tenant admin chose a
 * specific origin from the resend dialog dropdown). Strips trailing slashes
 * and rejects anything that isn't a valid http(s) origin so we never embed a
 * relative or javascript: URL in an email link.
 *
 * @param {string|null|undefined} raw
 * @returns {string} absolute origin without trailing slash, or '' when invalid
 */
function normalizeLinkBaseOverride(raw) {
    if (!raw || typeof raw !== 'string') return '';
    const s = raw.trim();
    if (!s) return '';
    try {
        const url = new URL(s);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
        return `${url.protocol}//${url.host}`.replace(/\/$/, '');
    } catch {
        return '';
    }
}

/**
 * Best-effort absolute base URL for links embedded in notification emails.
 * Falls back through env vars, then request headers (Origin, Referer origin,
 * forwarded proto+host from Express with trust-proxy enabled) so the anonymous
 * submission link in the email is always clickable, even when FRONTEND_URL is
 * missing from the deployment config.
 *
 * @param {import('express').Request|null|undefined} [req]
 * @param {{ linkBaseOverride?: string|null }} [opts] explicit override that wins
 *   over every other source (used by the resend dialog so tenant admins can
 *   pick localhost / a verified custom domain / the default allaboard host).
 * @returns {string} absolute base URL without trailing slash, or '' if unknown
 */
function resolveSubmissionLinkBase(req, opts) {
    const overrideRaw = opts && typeof opts === 'object' ? opts.linkBaseOverride : null;
    const override = normalizeLinkBaseOverride(overrideRaw);
    if (override) return override;
    const fromEnv = appBaseUrl();
    if (fromEnv) return fromEnv;
    if (!req) return '';
    const origin = String(req.headers?.origin || '').trim();
    if (/^https?:\/\//i.test(origin)) {
        return origin.replace(/\/$/, '');
    }
    const referer = String(req.headers?.referer || req.headers?.referrer || '').trim();
    if (referer) {
        try {
            const url = new URL(referer);
            if (url.origin && url.origin !== 'null') {
                return url.origin.replace(/\/$/, '');
            }
        } catch {
            // ignore malformed Referer
        }
    }
    try {
        const host = (typeof req.get === 'function' ? req.get('host') : '') || req.headers?.host || '';
        const proto = req.protocol || (req.headers?.['x-forwarded-proto'] || 'https').toString().split(',')[0].trim();
        if (host) {
            return `${proto}://${host}`.replace(/\/$/, '');
        }
    } catch {
        // ignore
    }
    return '';
}

/**
 * Build the absolute `/forms/submissions/<token>` URL with the best base we can
 * resolve. Logs a warning when we still couldn't produce an absolute URL so ops
 * can set FRONTEND_URL.
 *
 * @param {string} publicAccessToken
 * @param {import('express').Request|null|undefined} [req]
 * @param {{ linkBaseOverride?: string|null }} [opts] explicit base override
 *   (third arg keeps existing two-arg callers working unchanged).
 */
function buildSubmissionDataUrl(publicAccessToken, req, opts) {
    const base = resolveSubmissionLinkBase(req, opts);
    if (!base) {
        console.warn(
            'publicFormNotifyService: no absolute base URL for submission link (set FRONTEND_URL env var); email link will be relative'
        );
        return `/forms/submissions/${publicAccessToken}`;
    }
    return `${base}/forms/submissions/${publicAccessToken}`;
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Email address the submitter typed on the form (common field names).
 * @param {Record<string, unknown>} payload
 * @returns {string | null}
 */
function extractSubmitterEmail(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const keys = [
        'email',
        'Email',
        'emailAddress',
        'EmailAddress',
        'contact_email',
        'contactEmail',
        'primaryEmail',
        'primary_email',
        'e_mail',
        'mail'
    ];
    for (const k of keys) {
        if (!Object.prototype.hasOwnProperty.call(payload, k)) continue;
        const v = payload[k];
        if (typeof v !== 'string') continue;
        const t = v.trim();
        if (t.length > 254) continue;
        if (EMAIL_LIKE.test(t)) return t;
    }
    for (const [k, v] of Object.entries(payload)) {
        if (typeof v !== 'string') continue;
        const kl = k.toLowerCase();
        if (!kl.includes('email') && kl !== 'mail' && !kl.endsWith('_mail')) continue;
        const t = v.trim();
        if (t.length > 254 || !EMAIL_LIKE.test(t)) continue;
        return t;
    }
    return null;
}

/** Trim and bound a payload string. Returns null when empty after trim. */
function pickStringValue(payload, keys, maxLen = 200) {
    for (const k of keys) {
        if (!Object.prototype.hasOwnProperty.call(payload, k)) continue;
        const v = payload[k];
        if (v === null || v === undefined) continue;
        const t = String(v).trim();
        if (!t) continue;
        return t.length > maxLen ? t.slice(0, maxLen) : t;
    }
    return null;
}

/** Same as pickStringValue but the keys come from a regex match against payload keys. */
function pickStringValueByRegex(payload, regex, maxLen = 200) {
    const keys = Object.keys(payload).filter((k) => regex.test(k));
    keys.sort((a, b) => {
        const na = a.match(/_(\d+)$/i);
        const nb = b.match(/_(\d+)$/i);
        const ia = na ? parseInt(na[1], 10) : 0;
        const ib = nb ? parseInt(nb[1], 10) : 0;
        return ia - ib;
    });
    return pickStringValue(payload, keys, maxLen);
}

function extractSubmitterFirstName(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const direct = pickStringValue(payload, [
        'firstName',
        'first_name',
        'FirstName',
        'givenName',
        'given_name',
        'GivenName',
        'fname'
    ]);
    if (direct) return direct;
    return pickStringValueByRegex(payload, /^firstName(_\d+)?$/i);
}

function extractSubmitterLastName(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const direct = pickStringValue(payload, [
        'lastName',
        'last_name',
        'LastName',
        'familyName',
        'family_name',
        'FamilyName',
        'surname',
        'lname'
    ]);
    if (direct) return direct;
    const suffixed = pickStringValueByRegex(payload, /^lastName(_\d+)?$/i);
    if (suffixed) return suffixed;
    return pickStringValue(payload, ['verifyLastName', 'VerifyLastName']);
}

const PHONE_DIGIT_RE = /\d/g;

/**
 * Pull a phone-like string from common field names, then any payload key that
 * looks like a phone field (phone, phoneNumber, mobile, cell, tel, …). We
 * accept anything with at least 7 digits so international and partial entries
 * still surface in the email even when formatting varies.
 *
 * @param {Record<string, unknown>} payload
 * @returns {string | null}
 */
function extractSubmitterPhone(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const isPhoneLike = (raw) => {
        if (typeof raw !== 'string') return false;
        const digits = (raw.match(PHONE_DIGIT_RE) || []).length;
        return digits >= 7 && raw.trim().length <= 64;
    };
    const direct = pickStringValue(payload, [
        'phone',
        'Phone',
        'phoneNumber',
        'phone_number',
        'PhoneNumber',
        'mobile',
        'Mobile',
        'mobilePhone',
        'mobile_phone',
        'cell',
        'cellPhone',
        'cell_phone',
        'tel',
        'telephone'
    ]);
    if (direct && isPhoneLike(direct)) return direct;
    for (const [k, v] of Object.entries(payload)) {
        if (typeof v !== 'string') continue;
        const kl = k.toLowerCase();
        if (!/(phone|mobile|cell|^tel$|^telephone$)/.test(kl)) continue;
        const t = v.trim();
        if (isPhoneLike(t)) return t.length > 64 ? t.slice(0, 64) : t;
    }
    return null;
}

/**
 * Best-effort identity fields pulled from a submission payload, used to
 * personalize routing notification emails.
 *
 * @param {Record<string, unknown>|null|undefined} payload
 * @returns {{ firstName: string|null, lastName: string|null, email: string|null, phone: string|null }}
 */
function extractSubmitterIdentity(payload) {
    return {
        firstName: extractSubmitterFirstName(payload),
        lastName: extractSubmitterLastName(payload),
        email: extractSubmitterEmail(payload),
        phone: extractSubmitterPhone(payload)
    };
}

/**
 * Prefer inline CID attachment (Gmail blocks many remote and data: URLs). Fallback to HTTPS URL.
 * @returns {Promise<{ attachments?: Array<{content: string, filename: string, type: string, disposition: string, content_id: string}>, headerMode: 'cid'|'url'|'none', headerSrc?: string }>}
 */
async function getSubmitterConfirmationLogoParts() {
    try {
        if (fs.existsSync(SHAREWELL_HEADER_LOGO_PATH)) {
            const raw = fs.readFileSync(SHAREWELL_HEADER_LOGO_PATH);
            let pngBuf = raw;
            try {
                pngBuf = await prepareInlineEmailHeaderBuffer(raw);
            } catch (e) {
                console.warn('publicFormNotifyService: logo prepare failed, using raw bytes', e.message);
            }
            const content = pngBuf.toString('base64');
            return {
                attachments: [
                    {
                        content,
                        filename: 'sharewell-partners-header.png',
                        type: 'image/png',
                        disposition: 'inline',
                        content_id: SHAREWELL_HEADER_LOGO_CID
                    }
                ],
                headerMode: 'cid'
            };
        }
    } catch (e) {
        console.warn('publicFormNotifyService: logo file read failed', e.message);
    }

    const envUrl = (process.env.PUBLIC_FORM_SUBMITTER_CONFIRM_LOGO_URL || '').trim();
    if (envUrl) return { headerMode: 'url', headerSrc: envUrl };

    const base = appBaseUrl();
    const isLocalBase = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(base);
    if (base && !isLocalBase) {
        return { headerMode: 'url', headerSrc: `${base}/email-assets/sharewell-partners-logo.png` };
    }

    return { headerMode: 'none' };
}

function buildSubmitterConfirmationHtml({ greetingName, formLabel, headerMode, headerSrc }) {
    const safeGreeting = greetingName ? ` ${escapeHtml(greetingName)}` : '';
    const safeForm = escapeHtml(formLabel || 'your form');

    let logoBlock;
    if (headerMode === 'cid') {
        logoBlock = `<img src="cid:${SHAREWELL_HEADER_LOGO_CID}" alt="" width="520" style="max-width:100%;width:100%;height:auto;display:block;margin:0 auto;border:0;outline:none;text-decoration:none;background-color:transparent;background:transparent;" />`;
    } else if (headerMode === 'url' && headerSrc) {
        logoBlock = `<img src="${escapeHtml(headerSrc)}" alt="" width="520" style="max-width:100%;width:100%;height:auto;display:block;margin:0 auto;border:0;outline:none;text-decoration:none;background-color:transparent;background:transparent;" />`;
    } else {
        logoBlock =
            '<p style="margin:0;font-family:Georgia,\'Times New Roman\',serif;font-size:22px;color:#76A5C4;text-align:center;">ShareWELL <span style="color:#99C34D;">Partners</span></p>';
    }

    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background-color:${SUBMITTER_CONFIRM_EMAIL_BG};">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color:${SUBMITTER_CONFIRM_EMAIL_BG};border-collapse:collapse;">
<tr><td align="center" style="padding:28px 16px 12px 16px;background-color:${SUBMITTER_CONFIRM_EMAIL_BG};">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;border-collapse:collapse;">
<tr><td align="center" style="padding:0 0 24px 0;background-color:${SUBMITTER_CONFIRM_EMAIL_BG};">${logoBlock}</td></tr>
<tr><td style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.55;color:#333333;background-color:${SUBMITTER_CONFIRM_EMAIL_BG};">
<p style="margin:0 0 16px 0;">Hello${safeGreeting},</p>
<p style="margin:0 0 16px 0;">Thank you for your submission. We have received your <strong>${safeForm}</strong>.</p>
<p style="margin:0 0 16px 0;">If you have questions or need to follow up, please contact us at <a href="tel:+18002691451" style="color:#2563eb;text-decoration:none;">800-269-1451</a>.</p>
<p style="margin:0;font-size:13px;line-height:1.45;color:#666666;">This is an automated message; please do not reply directly to this email unless you were instructed to.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`.trim();
}

/**
 * Sends immediately via SendGrid (not MessageQueue) so submitters get mail without the Azure
 * MessageProcessor. Same pattern as other transactional sends (e.g. new group form PDF).
 * No PHI beyond optional first-name greeting.
 */
async function sendSubmitterConfirmationEmail({
    tenantId,
    submissionId,
    payload,
    formTitle,
    formKind
}) {
    const disabled = String(process.env.PUBLIC_FORM_SUBMITTER_CONFIRM_EMAIL || '').toLowerCase();
    if (disabled === '0' || disabled === 'false' || disabled === 'off') {
        return { skipped: true, reason: 'disabled' };
    }

    const toEmail = extractSubmitterEmail(payload);
    if (!toEmail) {
        console.warn(
            'publicFormNotifyService: submitter confirmation skipped (no email field in payload keys)'
        );
        return { skipped: true, reason: 'no_email_in_payload' };
    }

    let emailConfig = { tenantName: 'ShareWELL Partners', defaultFromEmail: process.env.DEFAULT_FROM_EMAIL || 'noreply@allaboard365.com' };
    try {
        emailConfig = await SendGridEmailService.getTenantEmailConfig(tenantId);
    } catch (e) {
        console.warn('publicFormNotifyService submitter confirm: tenant email config', e.message);
    }

    const fromEmail = emailConfig.customFromAddress || emailConfig.defaultFromEmail || process.env.DEFAULT_FROM_EMAIL || 'noreply@allaboard365.com';
    const fromName = emailConfig.tenantName || 'ShareWELL Partners';

    const rawName = pickGreetingName(payload);
    const greetingName = rawName ? truncateGreetingName(rawName) : '';
    const formLabel = (formTitle && String(formTitle).trim()) || formKind || 'your form';

    const logoParts = await getSubmitterConfirmationLogoParts();
    const html = buildSubmitterConfirmationHtml({
        greetingName,
        formLabel,
        headerMode: logoParts.headerMode,
        headerSrc: logoParts.headerSrc
    });

    const textLines = [
        greetingName ? `Hello ${greetingName},` : 'Hello,',
        '',
        `Thank you for your submission. We have received your ${formLabel}.`,
        '',
        'If you have questions or need to follow up, please contact us at 800-269-1451.',
        '',
        'This is an automated message.'
    ];
    const textContent = textLines.join('\n');

    const subject = `We received your submission — ${formLabel}`.slice(0, 200);

    try {
        const result = await SendGridEmailService.sendEmail({
            tenantId,
            to: toEmail,
            from: fromEmail,
            subject,
            html,
            text: textContent,
            ...(logoParts.attachments?.length ? { attachments: logoParts.attachments } : {}),
            metadata: {
                fromName,
                emailType: 'public_form_submitter_confirmation'
            },
            categories: ['public-form', 'submitter-confirmation']
        });
        const messageId = result.messageId || null;
        await logEmail({
            submissionId,
            tenantId,
            recipientEmail: toEmail,
            subject,
            messageId,
            emailType: 'submitter_confirmation'
        });
        if (result.messageId === 'dev-mode-skip' || !SendGridEmailService.isEnabled) {
            console.warn(
                'publicFormNotifyService: submitter confirmation not delivered (SendGrid disabled or no API key)'
            );
        } else {
            console.log('publicFormNotifyService: submitter confirmation sent to', toEmail, messageId);
        }
        return { sent: !!result.success, messageId, direct: true };
    } catch (err) {
        console.error('publicFormNotifyService submitter confirmation send failed', toEmail, err);
        return { sent: false, error: err.message };
    }
}

function pickGreetingName(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const keys = ['firstName', 'first_name', 'firstName_2', 'given_name', 'fname'];
    for (const k of keys) {
        if (!Object.prototype.hasOwnProperty.call(payload, k)) continue;
        const v = payload[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
}

function truncateGreetingName(s) {
    const t = String(s).trim();
    if (t.length <= 80) return t;
    return `${t.slice(0, 77)}...`;
}

/**
 * `oe.PublicFormTemplates.NotifyEmails` is usually JSON.stringify(string[]), but some UIs or imports
 * stored plain comma-/semicolon-/newline-separated addresses. Accept both.
 * @param {string|null|undefined} raw
 * @returns {string[]}
 */
function parseNotifyEmailsColumnValue(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return [];
    try {
        const v = JSON.parse(s);
        if (Array.isArray(v)) {
            return v
                .map((e) => String(e).trim())
                .filter((e) => e && EMAIL_LIKE.test(e));
        }
    } catch {
        /* fall through: treat as plain-text list */
    }
    return [
        ...new Set(
            s
                .split(/[,;\n\r]+/)
                .map((x) => x.trim())
                .filter((x) => x && EMAIL_LIKE.test(x))
        )
    ];
}

/**
 * Persist only valid JSON arrays so future reads are consistent.
 * @param {string|null|undefined} raw
 * @returns {string}
 */
function normalizeNotifyEmailsForStorage(raw) {
    return JSON.stringify(parseNotifyEmailsColumnValue(raw));
}

async function logEmail({ submissionId, tenantId, recipientEmail, subject, messageId, emailType }) {
    const pool = await getPool();
    await pool.request()
        .input('logId', sql.UniqueIdentifier, crypto.randomUUID())
        .input('submissionId', sql.UniqueIdentifier, submissionId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('recipientHash', sql.Char(64), hashRecipient(recipientEmail))
        .input('subject', sql.NVarChar, subject)
        .input('messageId', sql.NVarChar, messageId || null)
        .input('emailType', sql.NVarChar, emailType)
        .query(`
            INSERT INTO oe.PublicFormEmailLog (
                LogId, SubmissionId, TenantId, RecipientHash, Subject, MessageId, EmailType, CreatedDate
            ) VALUES (
                @logId, @submissionId, @tenantId, @recipientHash, @subject, @messageId, @emailType, SYSUTCDATETIME()
            )
        `);
}

/**
 * Resolve who receives the tenant "routing" notification (MessageQueue).
 * Order: template NotifyEmails JSON → optional extra addresses from caller → tenant ContactEmail →
 * PUBLIC_FORM_ROUTING_FALLBACK_EMAILS (comma/semicolon, ops/staging).
 * When `options.replaceDefaults` is true, the template/tenant/env fallbacks are skipped and only the
 * caller-supplied `additionalRecipientEmails` list is used (with normalization + de-dupe).
 * @param {string} tenantId
 * @param {string|null|undefined} notifyEmailsJson
 * @param {string[]|null|undefined} additionalRecipientEmails
 * @param {{ replaceDefaults?: boolean }} [options]
 * @returns {Promise<string[]>}
 */
async function resolveRoutingNotificationRecipients(
    tenantId,
    notifyEmailsJson,
    additionalRecipientEmails,
    options = {}
) {
    const addl = Array.isArray(additionalRecipientEmails)
        ? additionalRecipientEmails.map((e) => String(e).trim()).filter((e) => e && EMAIL_LIKE.test(e))
        : [];

    if (options && options.replaceDefaults === true) {
        return [...new Set(addl)];
    }

    let toList = [...new Set(parseNotifyEmailsColumnValue(notifyEmailsJson))];

    if (addl.length) {
        toList = [...new Set([...toList, ...addl])];
    }

    if (toList.length > 0) {
        return toList;
    }

    try {
        const pool = await getPool();
        const r = await pool.request()
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .query(`SELECT ContactEmail FROM oe.Tenants WHERE TenantId = @tenantId`);
        const ce = r.recordset[0]?.ContactEmail;
        if (typeof ce === 'string') {
            const t = ce.trim();
            if (t && EMAIL_LIKE.test(t)) {
                return [t];
            }
        }
    } catch (e) {
        console.warn('publicFormNotifyService: ContactEmail routing fallback failed', e.message);
    }

    const raw = String(process.env.PUBLIC_FORM_ROUTING_FALLBACK_EMAILS || '').trim();
    if (raw) {
        const fromEnv = [
            ...new Set(
                raw.split(/[,;]/).map((s) => s.trim()).filter((s) => s && EMAIL_LIKE.test(s))
            )
        ];
        if (fromEnv.length > 0) {
            return fromEnv;
        }
    }

    return [];
}

const URGENT_WINDOW_DAYS = 14;

/**
 * Days from today (local-midnight) for a YYYY-MM-DD string. Returns null when
 * the value isn't a parseable date. Past dates yield negative numbers.
 */
function daysFromTodayForDateString(raw) {
    if (typeof raw !== 'string') return null;
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]) - 1;
    const day = Number(m[3]);
    const candidate = new Date(year, month, day);
    if (isNaN(candidate.getTime())) return null;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.floor((candidate - today) / 86400000);
}

/**
 * Returns true when the submission payload contains any date-shaped value
 * (YYYY-MM-DD) within the next 14 days — i.e. the member needs care soon. Past
 * dates yield a negative day diff and are excluded, so dateOfBirth / verify
 * DOB / symptomsStartDate fields don't false-trigger. We scan all values
 * (not just `dateOfService`) because tenant form-builder fields use generated
 * names like `field_643d21fd` instead of the canonical key.
 *
 * @param {Record<string, unknown>|null|undefined} payload
 * @returns {boolean}
 */
function isUrgentSubmission(payload) {
    if (!payload || typeof payload !== 'object') return false;
    for (const value of Object.values(payload)) {
        const diff = daysFromTodayForDateString(value);
        if (diff !== null && diff >= 0 && diff < URGENT_WINDOW_DAYS) {
            return true;
        }
    }
    return false;
}

/**
 * Notify tenant routing list + optional third-party addresses from template JSON.
 */
async function sendSubmissionNotifications({
    tenantId,
    submissionId,
    submissionDataUrl,
    formKind,
    formTitle,
    memberMatchStatus,
    shareRequestId,
    requestNumber,
    notifyEmailsJson,
    additionalRecipientEmails,
    replaceDefaults,
    payload
}) {
    let emailConfig = { tenantName: 'Organization', defaultFromEmail: process.env.DEFAULT_FROM_EMAIL || 'noreply@allaboard365.com' };
    try {
        emailConfig = await SendGridEmailService.getTenantEmailConfig(tenantId);
    } catch (e) {
        console.warn('publicFormNotifyService: tenant email config', e.message);
    }

    const toList = await resolveRoutingNotificationRecipients(
        tenantId,
        notifyEmailsJson,
        additionalRecipientEmails,
        { replaceDefaults: replaceDefaults === true }
    );
    if (toList.length === 0) {
        console.warn(
            'publicFormNotifyService: no routing recipients (template NotifyEmails empty, tenant ContactEmail unset, env fallback empty)',
            tenantId
        );
        return { sent: 0, queued: 0, skipped: true, reason: 'no_recipients' };
    }

    const publicUrl = (submissionDataUrl && String(submissionDataUrl).trim()) || null;

    const identity = extractSubmitterIdentity(payload);
    const fullName = [identity.firstName, identity.lastName].filter(Boolean).join(' ').trim();

    const titleForSubject =
        (formTitle && String(formTitle).trim()) || formKind || 'Form';
    const urgentPrefix = isUrgentSubmission(payload) ? 'URGENT! - ' : '';
    const subject = fullName
        ? `${urgentPrefix}New Submission - ${titleForSubject} - ${fullName}`
        : `${urgentPrefix}New Submission - ${titleForSubject}`;
    const submitterRows = [
        identity.firstName ? `<li><strong>First name:</strong> ${escapeHtml(identity.firstName)}</li>` : '',
        identity.lastName ? `<li><strong>Last name:</strong> ${escapeHtml(identity.lastName)}</li>` : '',
        identity.email
            ? `<li><strong>Email:</strong> <a href="mailto:${escapeHtml(identity.email)}">${escapeHtml(identity.email)}</a></li>`
            : '',
        identity.phone
            ? `<li><strong>Phone:</strong> <a href="tel:${escapeHtml(identity.phone.replace(/[^\d+]/g, ''))}">${escapeHtml(identity.phone)}</a></li>`
            : ''
    ].filter(Boolean).join('');
    const html = `
      <ul>
        <li><strong>Form kind:</strong> ${formKind}</li>
        <li><strong>Member match:</strong> ${memberMatchStatus}</li>
        ${requestNumber ? `<li><strong>Request number:</strong> ${requestNumber}</li>` : ''}
        ${submitterRows}
      </ul>
      ${publicUrl ? `<p>Anonymous submission data link (expires in 30 days): <a href="${publicUrl}">${publicUrl}</a></p>` : ''}
      <p style="font-size:12px;color:#666;">Other submission details are excluded from this email; use the secure link above to view the full submission and any attachments.</p>
    `.trim();

    const fromEmail = emailConfig.customFromAddress || emailConfig.defaultFromEmail || process.env.DEFAULT_FROM_EMAIL || 'noreply@allaboard365.com';
    const fromName = emailConfig.tenantName || 'AllAboard365';

    const submitterTextLines = [
        identity.firstName ? `First name: ${identity.firstName}` : '',
        identity.lastName ? `Last name: ${identity.lastName}` : '',
        identity.email ? `Email: ${identity.email}` : '',
        identity.phone ? `Phone: ${identity.phone}` : ''
    ].filter(Boolean).join('\n');

    let queued = 0;
    for (const to of toList) {
        try {
            const messageId = await MessageQueueService.queueEmail({
                tenantId,
                toEmail: to,
                toName: null,
                subject,
                htmlContent: html,
                textContent: `Form kind: ${formKind}
Member match: ${memberMatchStatus}
${requestNumber ? `Request number: ${requestNumber}` : ''}
${submitterTextLines}
${publicUrl ? `Anonymous submission data link (expires in 30 days): ${publicUrl}` : ''}`.trim(),
                messageType: 'Email',
                createdBy: null,
                recipientId: null,
                fromEmail,
                fromName
            });
            await logEmail({
                submissionId,
                tenantId,
                recipientEmail: to,
                subject,
                messageId,
                emailType: 'routing'
            });
            queued += 1;
        } catch (err) {
            console.error('publicFormNotifyService queue failed', to, err);
        }
    }

    return { sent: queued, queued, skipped: false };
}

module.exports = {
    sendSubmissionNotifications,
    sendSubmitterConfirmationEmail,
    extractSubmitterEmail,
    extractSubmitterFirstName,
    extractSubmitterLastName,
    extractSubmitterPhone,
    extractSubmitterIdentity,
    logEmail,
    appBaseUrl,
    resolveSubmissionLinkBase,
    buildSubmissionDataUrl,
    normalizeLinkBaseOverride,
    resolveRoutingNotificationRecipients,
    parseNotifyEmailsColumnValue,
    normalizeNotifyEmailsForStorage,
    isUrgentSubmission
};
