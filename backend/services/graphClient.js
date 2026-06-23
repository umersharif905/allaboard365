// services/graphClient.js
// Thin Microsoft Graph wrapper for the Back Office email client.
// Resolves per-vendor Office365 config + token (reusing graphEmailService),
// prefers immutable ids, and handles 429/Retry-After with bounded retries.
// Spec: docs/superpowers/specs/2026-06-02-back-office-email/design.md
//
// All methods take a vendorId; config + access token + shared mailbox are
// resolved internally and cached per vendor.

const GraphEmailService = require('./graphEmailService');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const MAX_RETRIES = 4;

// token cache: vendorId -> { token, mailbox, fromName, expiresAt }
const _tokenCache = new Map();

async function resolveContext(vendorId) {
    const cached = _tokenCache.get(vendorId);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached;

    const config = await GraphEmailService.getVendorEmailConfig(vendorId);
    const token = await GraphEmailService.getAccessToken(config);
    // Client-credentials tokens are ~60 min; cache conservatively for 50.
    const ctx = {
        token,
        mailbox: config.sharedMailbox,
        fromName: config.fromName,
        expiresAt: Date.now() + 50 * 60 * 1000,
    };
    _tokenCache.set(vendorId, ctx);
    return ctx;
}

function _invalidate(vendorId) { _tokenCache.delete(vendorId); }

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Low-level Graph request. `path` is absolute-from-base (e.g.
 * `/users/{mb}/messages/{id}`) OR a full https URL (used for delta @odata.nextLink).
 * Returns parsed JSON, or null for 202/204.
 */
async function rawRequest(vendorId, method, path, { body, headers = {}, immutableId = false } = {}) {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const ctx = await resolveContext(vendorId);
        const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`;
        const reqHeaders = {
            Authorization: `Bearer ${ctx.token}`,
            'Content-Type': 'application/json',
            ...(immutableId ? { Prefer: 'IdType="ImmutableId"' } : {}),
            ...headers,
        };
        const res = await fetch(url, {
            method,
            headers: reqHeaders,
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });

        if (res.status === 401 && attempt < 1) {
            // token might be stale — drop cache and retry once.
            _invalidate(vendorId);
            attempt++;
            continue;
        }
        if (res.status === 429 || res.status === 503) {
            if (attempt >= MAX_RETRIES) break;
            const retryAfter = parseInt(res.headers.get('retry-after') || '', 10);
            const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 2 ** attempt * 1000;
            await _sleep(waitMs);
            attempt++;
            continue;
        }
        if (res.status === 202 || res.status === 204) return null;
        if (!res.ok) {
            const text = await res.text();
            let msg = text;
            try { msg = JSON.parse(text).error?.message || text; } catch (_) { /* keep text */ }
            const err = new Error(`Graph ${method} ${path} failed (${res.status}): ${msg}`);
            err.statusCode = res.status;
            throw err;
        }
        const ctype = res.headers.get('content-type') || '';
        return ctype.includes('application/json') ? res.json() : null;
    }
    const err = new Error(`Graph ${method} ${path} throttled after ${MAX_RETRIES} retries`);
    err.statusCode = 429;
    throw err;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const MESSAGE_SELECT =
    'id,conversationId,internetMessageId,subject,bodyPreview,body,from,toRecipients,' +
    'ccRecipients,receivedDateTime,sentDateTime,isRead,hasAttachments,internetMessageHeaders';

async function getMessage(vendorId, messageId) {
    const ctx = await resolveContext(vendorId);
    return rawRequest(
        vendorId,
        'GET',
        `/users/${encodeURIComponent(ctx.mailbox)}/messages/${messageId}?$select=${MESSAGE_SELECT}`,
        { immutableId: true }
    );
}

/**
 * Fetch the next page of the Inbox delta. Pass a saved deltaLink/nextLink to
 * continue, or omit to start a fresh delta. Returns the raw Graph payload
 * ({ value, '@odata.nextLink'?, '@odata.deltaLink'? }).
 */
async function inboxDelta(vendorId, link) {
    const ctx = await resolveContext(vendorId);
    const path = link ||
        `/users/${encodeURIComponent(ctx.mailbox)}/mailFolders('inbox')/messages/delta?$select=${MESSAGE_SELECT}`;
    return rawRequest(vendorId, 'GET', path, { immutableId: true });
}

/**
 * Fetch the next page of the Sent Items delta. Mirrors inboxDelta — used to
 * capture replies a care-team member sent directly from Outlook (not the back
 * office) so the thread reflects them. Pass a saved deltaLink/nextLink to
 * continue, or omit to start fresh (a fresh delta seeds the full folder).
 */
async function sentDelta(vendorId, link) {
    const ctx = await resolveContext(vendorId);
    const path = link ||
        `/users/${encodeURIComponent(ctx.mailbox)}/mailFolders('sentitems')/messages/delta?$select=${MESSAGE_SELECT}`;
    return rawRequest(vendorId, 'GET', path, { immutableId: true });
}

/** List a message's attachments (fileAttachment entries include contentBytes when small). */
async function listAttachments(vendorId, messageId) {
    const ctx = await resolveContext(vendorId);
    return rawRequest(vendorId, 'GET', `/users/${encodeURIComponent(ctx.mailbox)}/messages/${messageId}/attachments`, {
        immutableId: true,
    });
}

async function markRead(vendorId, messageId, isRead = true) {
    const ctx = await resolveContext(vendorId);
    return rawRequest(vendorId, 'PATCH', `/users/${encodeURIComponent(ctx.mailbox)}/messages/${messageId}`, {
        body: { isRead },
        immutableId: true,
    });
}

// ---------------------------------------------------------------------------
// Send / reply
// ---------------------------------------------------------------------------

/** Create a reply draft (inherits conversationId + threading). Returns the draft message. */
async function createReplyDraft(vendorId, messageId, { replyAll = false } = {}) {
    const ctx = await resolveContext(vendorId);
    const verb = replyAll ? 'createReplyAll' : 'createReply';
    return rawRequest(vendorId, 'POST', `/users/${encodeURIComponent(ctx.mailbox)}/messages/${messageId}/${verb}`, {
        body: {},
        immutableId: true,
    });
}

/** Patch a draft (body, headers, recipients). */
async function updateMessage(vendorId, messageId, patch) {
    const ctx = await resolveContext(vendorId);
    return rawRequest(vendorId, 'PATCH', `/users/${encodeURIComponent(ctx.mailbox)}/messages/${messageId}`, {
        body: patch,
        immutableId: true,
    });
}

/** Add a small attachment to a draft message (single request; Graph caps this ~3MB). */
async function addAttachment(vendorId, messageId, attachment) {
    const ctx = await resolveContext(vendorId);
    return rawRequest(vendorId, 'POST', `/users/${encodeURIComponent(ctx.mailbox)}/messages/${messageId}/attachments`, {
        body: attachment,
        immutableId: true,
    });
}

// Single-request attachments are capped ~3MB; larger files must use an upload session.
const SIMPLE_ATTACHMENT_MAX = 3 * 1024 * 1024;

/**
 * Attach a large file (>3MB) to a draft via an upload session: createUploadSession
 * then PUT the bytes in chunks. Chunk size must be a multiple of 320 KiB (except
 * the final chunk), per Graph's range-upload requirement.
 */
async function uploadLargeAttachment(vendorId, messageId, { name, contentType, buffer }) {
    const ctx = await resolveContext(vendorId);
    const session = await rawRequest(
        vendorId, 'POST',
        `/users/${encodeURIComponent(ctx.mailbox)}/messages/${messageId}/attachments/createUploadSession`,
        {
            body: { AttachmentItem: { attachmentType: 'file', name, size: buffer.length, contentType: contentType || 'application/octet-stream' } },
            immutableId: true,
        }
    );
    const uploadUrl = session?.uploadUrl;
    if (!uploadUrl) throw new Error('createUploadSession returned no uploadUrl');

    const total = buffer.length;
    const CHUNK = 320 * 1024 * 15; // ~4.6MB, a multiple of 320 KiB
    let start = 0;
    while (start < total) {
        const end = Math.min(start + CHUNK, total);
        const chunk = buffer.subarray(start, end);
        // The uploadUrl is pre-authenticated — no bearer token on these PUTs.
        const res = await fetch(uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Length': String(chunk.length), 'Content-Range': `bytes ${start}-${end - 1}/${total}` },
            body: chunk,
        });
        if (![200, 201, 202].includes(res.status)) {
            const t = await res.text().catch(() => '');
            throw new Error(`attachment upload chunk ${start}-${end - 1}/${total} failed (${res.status}): ${t.slice(0, 200)}`);
        }
        start = end;
    }
    return true;
}

/** Send an existing draft by id. */
async function sendDraft(vendorId, messageId) {
    const ctx = await resolveContext(vendorId);
    return rawRequest(vendorId, 'POST', `/users/${encodeURIComponent(ctx.mailbox)}/messages/${messageId}/send`, {
        body: {},
        immutableId: true,
    });
}

/**
 * Create a draft message (Drafts folder) and return it with id + conversationId.
 * Used for composing a brand-new email so we can capture the id/conversationId
 * before sending (sendMail returns 202 with no body). Send it with sendDraft().
 */
async function createDraftMessage(vendorId, message) {
    const ctx = await resolveContext(vendorId);
    return rawRequest(vendorId, 'POST', `/users/${encodeURIComponent(ctx.mailbox)}/messages`, {
        body: message,
        immutableId: true,
    });
}

/** Send a brand-new message (no thread). `message` is a Graph message object. */
async function sendMail(vendorId, message, saveToSentItems = true) {
    const ctx = await resolveContext(vendorId);
    return rawRequest(vendorId, 'POST', `/users/${encodeURIComponent(ctx.mailbox)}/sendMail`, {
        body: { message, saveToSentItems },
    });
}

// ---------------------------------------------------------------------------
// Subscriptions (change notifications)
// ---------------------------------------------------------------------------

async function createSubscription(vendorId, { notificationUrl, lifecycleNotificationUrl, clientState, expirationDateTime }) {
    const ctx = await resolveContext(vendorId);
    return rawRequest(vendorId, 'POST', '/subscriptions', {
        body: {
            changeType: 'created',
            notificationUrl,
            lifecycleNotificationUrl,
            resource: `/users/${ctx.mailbox}/mailFolders('inbox')/messages`,
            clientState,
            expirationDateTime,
        },
    });
}

async function renewSubscription(vendorId, subscriptionId, expirationDateTime) {
    return rawRequest(vendorId, 'PATCH', `/subscriptions/${subscriptionId}`, { body: { expirationDateTime } });
}

async function deleteSubscription(vendorId, subscriptionId) {
    return rawRequest(vendorId, 'DELETE', `/subscriptions/${subscriptionId}`);
}

module.exports = {
    resolveContext,
    rawRequest,
    getMessage,
    inboxDelta,
    sentDelta,
    listAttachments,
    markRead,
    createReplyDraft,
    updateMessage,
    addAttachment,
    uploadLargeAttachment,
    SIMPLE_ATTACHMENT_MAX,
    sendDraft,
    createDraftMessage,
    sendMail,
    createSubscription,
    renewSubscription,
    deleteSubscription,
    _invalidate, // for tests
    _tokenCache, // for tests
};
