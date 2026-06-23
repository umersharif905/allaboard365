// services/emailAttachmentService.js
// Email attachments for the Back Office inbox. Inbound: pull attachment bytes
// from Graph and persist to Azure Blob (+ oe.EmailAttachments) so we retain the
// files independently of Microsoft. Outbound: store a sent file the same way and
// hand back a Graph-ready attachment object.
// Spec: docs/superpowers/specs/2026-06-02-back-office-email/design.md
//
// Mirrors the encounter/case attachment pattern: container "members", 1-hour
// read SAS for downloads.

const crypto = require('crypto');
const { BlobServiceClient, generateBlobSASQueryParameters, BlobSASPermissions } = require('@azure/storage-blob');
const { getPool, sql } = require('../config/database');
const graph = require('./graphClient');

const CONTAINER = 'members';

let _blob;
function blobClient() {
    if (_blob !== undefined) return _blob;
    const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
    _blob = cs ? BlobServiceClient.fromConnectionString(cs) : null;
    if (!_blob) console.warn('⚠️ email attachments: AZURE_STORAGE_CONNECTION_STRING not set — attachments disabled');
    return _blob;
}

const safeName = (n) => String(n || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120);

async function uploadBuffer(vendorId, emailMessageId, fileName, mimeType, buffer) {
    const client = blobClient();
    if (!client) throw new Error('Storage service unavailable');
    const container = client.getContainerClient(CONTAINER);
    await container.createIfNotExists();
    const blobPath = `_email/${vendorId}/messages/${emailMessageId}/${crypto.randomUUID()}-${safeName(fileName)}`;
    const block = container.getBlockBlobClient(blobPath);
    await block.uploadData(buffer, { blobHTTPHeaders: { blobContentType: mimeType || 'application/octet-stream' } });
    return { blobUrl: block.url, blobPath };
}

/** 1-hour read SAS URL for a stored blob (used by the download route). */
function authenticatedUrl(blobUrl, blobPath) {
    const client = blobClient();
    if (!client || !blobUrl) return blobUrl || null;
    try {
        const path = blobPath || blobUrl.split(`/${CONTAINER}/`)[1]?.split('?')[0];
        if (!path) return blobUrl;
        const expiresOn = new Date(); expiresOn.setHours(expiresOn.getHours() + 1);
        const sas = generateBlobSASQueryParameters({
            containerName: CONTAINER, blobName: path,
            permissions: BlobSASPermissions.parse('r'), expiresOn, startsOn: new Date(),
        }, client.credential).toString();
        return `${client.getContainerClient(CONTAINER).getBlockBlobClient(path).url}?${sas}`;
    } catch (e) {
        console.warn('email attachment SAS failed:', e.message);
        return blobUrl;
    }
}

async function recordAttachment(emailMessageId, a) {
    const pool = await getPool();
    const r = await pool.request()
        .input('emailMessageId', sql.UniqueIdentifier, emailMessageId)
        .input('fileName', sql.NVarChar, a.fileName)
        .input('mimeType', sql.NVarChar, a.mimeType || null)
        .input('fileSize', sql.BigInt, a.fileSize ?? null)
        .input('blobUrl', sql.NVarChar, a.blobUrl || null)
        .input('blobPath', sql.NVarChar, a.blobPath || null)
        .input('graphAttachmentId', sql.NVarChar, a.graphAttachmentId || null)
        .input('isInline', sql.Bit, a.isInline ? 1 : 0)
        .input('contentId', sql.NVarChar, a.contentId || null)
        .input('createdBy', sql.UniqueIdentifier, a.createdBy || null)
        .query(`
            INSERT INTO oe.EmailAttachments
                (EmailMessageId, FileName, MimeType, FileSize, BlobUrl, BlobPath, GraphAttachmentId, IsInline, ContentId, CreatedBy)
            OUTPUT INSERTED.AttachmentId
            VALUES (@emailMessageId, @fileName, @mimeType, @fileSize, @blobUrl, @blobPath, @graphAttachmentId, @isInline, @contentId, @createdBy)
        `);
    return r.recordset[0].AttachmentId;
}

/** Raw bytes for a Graph attachment that didn't include contentBytes inline. */
async function fetchAttachmentValue(vendorId, graphMessageId, attachmentId) {
    const ctx = await graph.resolveContext(vendorId);
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(ctx.mailbox)}/messages/${graphMessageId}/attachments/${attachmentId}/$value`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${ctx.token}` } });
    if (!res.ok) throw new Error(`attachment $value ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}

/**
 * Pull a message's attachments from Graph and persist them. Idempotent: skips if
 * we already stored attachments for this message. Only fileAttachments are stored
 * (itemAttachment / referenceAttachment are skipped). Inline images are stored too.
 */
async function ingestAttachments(vendorId, emailMessageId, graphMessageId) {
    const pool = await getPool();
    const existing = await pool.request()
        .input('id', sql.UniqueIdentifier, emailMessageId)
        .query('SELECT COUNT(*) AS C FROM oe.EmailAttachments WHERE EmailMessageId=@id');
    if (existing.recordset[0].C > 0) return { stored: 0, skipped: 'already-present' };

    const list = await graph.listAttachments(vendorId, graphMessageId);
    const items = list?.value || [];
    let stored = 0;
    for (const a of items) {
        if (a['@odata.type'] !== '#microsoft.graph.fileAttachment') continue; // skip item/reference for now
        try {
            const buffer = a.contentBytes
                ? Buffer.from(a.contentBytes, 'base64')
                : await fetchAttachmentValue(vendorId, graphMessageId, a.id);
            const { blobUrl, blobPath } = await uploadBuffer(vendorId, emailMessageId, a.name, a.contentType, buffer);
            await recordAttachment(emailMessageId, {
                fileName: a.name, mimeType: a.contentType, fileSize: a.size ?? buffer.length,
                blobUrl, blobPath, graphAttachmentId: a.id, isInline: a.isInline, contentId: a.contentId,
            });
            stored++;
        } catch (e) {
            console.warn(`email attachment ingest failed (${a.name}):`, e.message);
        }
    }
    return { stored };
}

/** Store an outbound file (already a Buffer) and return a Graph fileAttachment object to send. */
async function storeOutboundFile(vendorId, emailMessageId, file, ctx = {}) {
    const { blobUrl, blobPath } = await uploadBuffer(vendorId, emailMessageId, file.originalname, file.mimetype, file.buffer);
    await recordAttachment(emailMessageId, {
        fileName: file.originalname, mimeType: file.mimetype, fileSize: file.size,
        blobUrl, blobPath, isInline: false, createdBy: ctx.userId || null,
    });
    return {
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: file.originalname,
        contentType: file.mimetype,
        contentBytes: file.buffer.toString('base64'),
    };
}

/** List a thread's attachments (non-inline), keyed for the reader, with SAS download URLs. */
async function listForThread(vendorId, threadId) {
    const pool = await getPool();
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('threadId', sql.UniqueIdentifier, threadId)
        .query(`
            SELECT a.AttachmentId, a.EmailMessageId, a.FileName, a.MimeType, a.FileSize, a.BlobUrl, a.BlobPath, a.IsInline
            FROM oe.EmailAttachments a
            JOIN oe.EmailMessages m ON a.EmailMessageId = m.EmailMessageId
            WHERE m.ThreadId = @threadId AND m.VendorId = @vendorId AND a.IsActive = 1 AND a.IsInline = 0
            ORDER BY a.CreatedDate ASC
        `);
    return r.recordset.map((att) => ({ ...att, AuthenticatedUrl: authenticatedUrl(att.BlobUrl, att.BlobPath) }));
}

/** Normalise a Content-ID for matching: strip surrounding <>, trim, lowercase. */
const normCid = (s) => String(s || '').trim().replace(/^<+|>+$/g, '').toLowerCase();

/**
 * Rewrite inline-image references so they render in the browser. Inbound HTML
 * embeds inline images as <img src="cid:CONTENTID">, which a browser can't resolve
 * (cid: is MIME-only), so they show as broken images. Replace each cid: ref with
 * the matching stored inline attachment's SAS URL. `cidToUrl` is a Map keyed by
 * normCid(ContentId). Pure function — unit-tested.
 */
function rewriteCidReferences(html, cidToUrl) {
    if (!html || !cidToUrl || cidToUrl.size === 0) return html;
    return String(html).replace(
        /\bsrc\s*=\s*(["']?)cid:([^"'>\s]+)\1/gi,
        (match, quote, cid) => {
            const url = cidToUrl.get(normCid(cid));
            if (!url) return match;
            const q = quote || '"';
            return `src=${q}${url}${q}`;
        }
    );
}

/**
 * True when an HTML body embeds inline images via cid:. Microsoft Graph reports
 * hasAttachments=false for messages whose ONLY attachments are inline images, so
 * the sync must also ingest when this is true — otherwise embedded pictures are
 * never stored and can't be rendered.
 */
function bodyHasInlineCids(html) {
    return /\bsrc\s*=\s*["']?cid:/i.test(String(html || ''));
}

/** Map of normalised ContentId -> 1-hour SAS URL for a thread's inline images. */
async function inlineUrlMapForThread(vendorId, threadId) {
    const pool = await getPool();
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('threadId', sql.UniqueIdentifier, threadId)
        .query(`
            SELECT a.ContentId, a.BlobUrl, a.BlobPath
            FROM oe.EmailAttachments a
            JOIN oe.EmailMessages m ON a.EmailMessageId = m.EmailMessageId
            WHERE m.ThreadId = @threadId AND m.VendorId = @vendorId
              AND a.IsActive = 1 AND a.IsInline = 1 AND a.ContentId IS NOT NULL
        `);
    const map = new Map();
    for (const a of r.recordset) {
        const url = authenticatedUrl(a.BlobUrl, a.BlobPath);
        if (url) map.set(normCid(a.ContentId), url);
    }
    return map;
}

module.exports = {
    ingestAttachments,
    storeOutboundFile,
    listForThread,
    authenticatedUrl,
    rewriteCidReferences,
    inlineUrlMapForThread,
    bodyHasInlineCids,
};
