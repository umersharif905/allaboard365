// services/emailSubscriptionService.js
// Manages Graph change-notification subscriptions for a vendor's shared mailbox
// inbox: create on enable, renew before expiry, recreate on lifecycle events.
// Spec: docs/superpowers/specs/2026-06-02-back-office-email/design.md
//
// NOTE: live operation depends on blockers B-001..B-003 (app-reg application
// Mail.Read + admin consent, RBAC mailbox scoping, public webhook endpoint).

const crypto = require('crypto');
const graph = require('./graphClient');
const emailSyncService = require('./emailSyncService');

// Outlook message subscriptions max ~7 days; we request a safe margin under it.
const SUBSCRIPTION_MINUTES = parseInt(process.env.GRAPH_SUBSCRIPTION_MINUTES || '4230', 10); // ~70.5h
const APP_BASE_URL = process.env.PUBLIC_API_BASE_URL || process.env.API_BASE_URL || '';

function notificationUrls() {
    const base = APP_BASE_URL.replace(/\/$/, '');
    return {
        notificationUrl: `${base}/api/webhooks/graph-email`,
        lifecycleNotificationUrl: `${base}/api/webhooks/graph-email/lifecycle`,
    };
}

function expiry(minutes = SUBSCRIPTION_MINUTES) {
    return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

/** Per-vendor clientState secret (verifies inbound notifications are genuine). */
function clientStateFor(vendorId) {
    const secret = process.env.GRAPH_WEBHOOK_SECRET || 'dev-graph-webhook-secret';
    return crypto.createHmac('sha256', secret).update(String(vendorId)).digest('hex').slice(0, 64);
}

/** Create a subscription and persist its id/expiry. */
async function ensureSubscription(vendorId) {
    if (!APP_BASE_URL) throw new Error('PUBLIC_API_BASE_URL not set — cannot register Graph webhook (blocker B-003)');
    const urls = notificationUrls();
    const sub = await graph.createSubscription(vendorId, {
        ...urls,
        clientState: clientStateFor(vendorId),
        expirationDateTime: expiry(),
    });
    await emailSyncService.upsertSyncState(vendorId, {
        SubscriptionId: sub.id,
        SubscriptionExpiresAt: sub.expirationDateTime,
        SyncStatus: 'active',
        LastError: null,
    });
    // Seed initial state immediately.
    await emailSyncService.reconcileDelta(vendorId);
    return sub;
}

async function renewSubscription(vendorId) {
    const state = await emailSyncService.getSyncState(vendorId);
    if (!state?.SubscriptionId) return ensureSubscription(vendorId);
    const sub = await graph.renewSubscription(vendorId, state.SubscriptionId, expiry());
    await emailSyncService.upsertSyncState(vendorId, {
        SubscriptionExpiresAt: sub.expirationDateTime,
        SyncStatus: 'active',
    });
    return sub;
}

async function deleteSubscription(vendorId) {
    const state = await emailSyncService.getSyncState(vendorId);
    if (state?.SubscriptionId) {
        try { await graph.deleteSubscription(vendorId, state.SubscriptionId); } catch (_) { /* best effort */ }
    }
    await emailSyncService.upsertSyncState(vendorId, { SubscriptionId: null, SubscriptionExpiresAt: null, SyncStatus: 'idle' });
}

/**
 * Handle a lifecycle notification. reauthorizationRequired/missed → renew + delta
 * resync; subscriptionRemoved → recreate + resync.
 */
async function handleLifecycle(vendorId, lifecycleEvent) {
    switch (lifecycleEvent) {
        case 'reauthorizationRequired':
            await renewSubscription(vendorId);
            break;
        case 'subscriptionRemoved':
            await ensureSubscription(vendorId);
            break;
        case 'missed':
        default:
            await emailSyncService.reconcileDelta(vendorId);
            break;
    }
}

module.exports = {
    SUBSCRIPTION_MINUTES,
    notificationUrls,
    clientStateFor,
    ensureSubscription,
    renewSubscription,
    deleteSubscription,
    handleLifecycle,
};
