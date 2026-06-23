// services/emailSyncService.js
// Pulls inbound mail from Graph into the unified store — via webhook (one
// message by id) and via Inbox delta (seed + gap recovery). Idempotent.
// Spec: docs/superpowers/specs/2026-06-02-back-office-email/design.md

const { getPool, sql } = require('../config/database');
const graph = require('./graphClient');
const emailThreadService = require('./emailThreadService');

/** Normalize a Graph message into the shape emailThreadService expects. */
function parseGraphMessage(m) {
    return {
        graphMessageId: m.id,
        conversationId: m.conversationId,
        internetMessageId: m.internetMessageId || null,
        subject: m.subject || null,
        bodyHtml: m.body?.content || null,
        bodyPreview: m.bodyPreview || null,
        fromAddress: m.from?.emailAddress?.address || null,
        fromName: m.from?.emailAddress?.name || null,
        toAddresses: (m.toRecipients || []).map((r) => r.emailAddress?.address).filter(Boolean),
        ccAddresses: (m.ccRecipients || []).map((r) => r.emailAddress?.address).filter(Boolean),
        receivedAt: m.receivedDateTime || null,
        sentAt: m.sentDateTime || null,
        isRead: !!m.isRead,
        hasAttachments: !!m.hasAttachments,
    };
}

/** Fetch one message by id and record it. Returns the record result (or null if it vanished). */
async function ingestMessage(vendorId, graphMessageId) {
    const msg = await graph.getMessage(vendorId, graphMessageId);
    if (!msg || !msg.conversationId) return null;
    return emailThreadService.recordInboundMessage(vendorId, parseGraphMessage(msg));
}

// ---------------------------------------------------------------------------
// Sync-state (oe.EmailMailboxSync)
// ---------------------------------------------------------------------------

async function getSyncState(vendorId) {
    const pool = await getPool();
    const r = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .query(`SELECT * FROM oe.EmailMailboxSync WHERE VendorId=@vendorId`);
    return r.recordset[0] || null;
}

async function upsertSyncState(vendorId, fields) {
    const pool = await getPool();
    const existing = await getSyncState(vendorId);
    const req = pool.request().input('vendorId', sql.UniqueIdentifier, vendorId);
    const cols = { ...fields };
    const setSql = Object.keys(cols).map((k) => `${k}=@${k}`).join(', ');
    Object.entries(cols).forEach(([k, v]) => {
        if (k === 'DeltaLink' || k === 'SentDeltaLink' || k === 'LastError') req.input(k, sql.NVarChar(sql.MAX), v ?? null);
        else if (k.endsWith('At') || k === 'SubscriptionExpiresAt') req.input(k, sql.DateTime2, v ? new Date(v) : null);
        else req.input(k, sql.NVarChar, v ?? null);
    });
    if (existing) {
        await req.query(`UPDATE oe.EmailMailboxSync SET ${setSql}, ModifiedDate=SYSUTCDATETIME() WHERE VendorId=@vendorId`);
    } else {
        const colNames = ['VendorId', ...Object.keys(cols)].join(', ');
        const valNames = ['@vendorId', ...Object.keys(cols).map((k) => `@${k}`)].join(', ');
        await req.query(`INSERT INTO oe.EmailMailboxSync (${colNames}) VALUES (${valNames})`);
    }
}

/**
 * Run the Inbox delta from the saved deltaLink (or a fresh start), ingesting
 * every message and persisting the new deltaLink for next time. Seeds initial
 * state and recovers gaps after missed/subscriptionRemoved lifecycle events.
 */
async function reconcileDelta(vendorId) {
    const state = await getSyncState(vendorId);
    let link = state?.DeltaLink || undefined;
    let ingested = 0;
    let payload;
    try {
        // Page through until we get a deltaLink (end of changes).
        // eslint-disable-next-line no-constant-condition
        while (true) {
            payload = await graph.inboxDelta(vendorId, link);
            const items = payload?.value || [];
            for (const m of items) {
                if (m['@removed']) continue; // deletion tombstone — ignore for now
                if (!m.conversationId) {
                    // delta rows can be sparse; fetch full message
                    const full = await graph.getMessage(vendorId, m.id);
                    if (full?.conversationId) { await emailThreadService.recordInboundMessage(vendorId, parseGraphMessage(full)); ingested++; }
                    continue;
                }
                await emailThreadService.recordInboundMessage(vendorId, parseGraphMessage(m));
                ingested++;
            }
            if (payload['@odata.nextLink']) { link = payload['@odata.nextLink']; continue; }
            break;
        }
        await upsertSyncState(vendorId, {
            DeltaLink: payload?.['@odata.deltaLink'] || state?.DeltaLink || null,
            LastPollAt: new Date(),
            SyncStatus: 'active',
            LastError: null,
        });
    } catch (err) {
        await upsertSyncState(vendorId, { SyncStatus: 'error', LastError: err.message, LastPollAt: new Date() });
        throw err;
    }
    return { ingested };
}

/**
 * Run the Sent Items delta from the saved SentDeltaLink (or a fresh start),
 * recording every message as outbound and persisting the new deltaLink. A fresh
 * delta (no saved link) seeds the full Sent Items folder — which is how we
 * backfill replies sent from Outlook. Idempotent: back-office sends already
 * recorded dedupe out (same immutable GraphMessageId / InternetMessageId).
 */
async function reconcileSentDelta(vendorId) {
    const state = await getSyncState(vendorId);
    let link = state?.SentDeltaLink || undefined;
    let ingested = 0;
    let payload;
    try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            payload = await graph.sentDelta(vendorId, link);
            const items = payload?.value || [];
            for (const m of items) {
                if (m['@removed']) continue; // deletion tombstone — ignore for now
                if (!m.conversationId) {
                    const full = await graph.getMessage(vendorId, m.id);
                    if (full?.conversationId) { await emailThreadService.recordOutboundFromSync(vendorId, parseGraphMessage(full)); ingested++; }
                    continue;
                }
                await emailThreadService.recordOutboundFromSync(vendorId, parseGraphMessage(m));
                ingested++;
            }
            if (payload['@odata.nextLink']) { link = payload['@odata.nextLink']; continue; }
            break;
        }
        await upsertSyncState(vendorId, {
            SentDeltaLink: payload?.['@odata.deltaLink'] || state?.SentDeltaLink || null,
            LastPollAt: new Date(),
            SyncStatus: 'active',
            LastError: null,
        });
    } catch (err) {
        await upsertSyncState(vendorId, { SyncStatus: 'error', LastError: err.message, LastPollAt: new Date() });
        throw err;
    }
    return { ingested };
}

async function findVendorBySubscription(subscriptionId) {
    const pool = await getPool();
    const r = await pool.request()
        .input('subscriptionId', sql.NVarChar, subscriptionId)
        .query(`SELECT VendorId FROM oe.EmailMailboxSync WHERE SubscriptionId=@subscriptionId`);
    return r.recordset[0]?.VendorId || null;
}

module.exports = {
    parseGraphMessage,
    ingestMessage,
    reconcileDelta,
    reconcileSentDelta,
    getSyncState,
    upsertSyncState,
    findVendorBySubscription,
};
