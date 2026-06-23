// services/emailMailboxJobs.service.js
// Scheduled-job orchestration for the Back Office inbox: keep each configured
// vendor's Graph subscription alive (renewal) and pull anything webhooks missed
// (delta reconcile). Driven by Azure Function timers via /api/scheduled-jobs/*.
// Spec: docs/superpowers/specs/2026-06-02-back-office-email/design.md (§7, B-004)

const { getPool, sql } = require('../config/database');
const emailSubscriptionService = require('./emailSubscriptionService');
const emailSyncService = require('./emailSyncService');

// Renew when a subscription expires within this window (or is missing).
const RENEW_WHEN_WITHIN_MS = parseInt(process.env.GRAPH_RENEW_WITHIN_HOURS || '24', 10) * 60 * 60 * 1000;

/** Vendors that have a usable Office365 mailbox configured. */
async function getEmailEnabledVendorIds() {
    const pool = await getPool();
    const r = await pool.request().query(`
        SELECT VendorId
        FROM oe.Vendors
        WHERE Office365TenantId IS NOT NULL
          AND Office365ClientId IS NOT NULL
          AND Office365ClientSecret IS NOT NULL
          AND Office365SharedMailbox IS NOT NULL
    `);
    return r.recordset.map((row) => row.VendorId);
}

/**
 * Renew subscriptions nearing expiry (creates one if missing). Returns a
 * per-vendor result list; one vendor's failure never aborts the others.
 */
async function renewDueSubscriptions() {
    const vendorIds = await getEmailEnabledVendorIds();
    const results = [];
    for (const vendorId of vendorIds) {
        try {
            const state = await emailSyncService.getSyncState(vendorId);
            const expiresAt = state?.SubscriptionExpiresAt ? new Date(state.SubscriptionExpiresAt).getTime() : 0;
            const due = !state?.SubscriptionId || expiresAt < Date.now() + RENEW_WHEN_WITHIN_MS;
            if (!due) { results.push({ vendorId, action: 'skipped', reason: 'not due' }); continue; }
            const sub = await emailSubscriptionService.renewSubscription(vendorId);
            results.push({ vendorId, action: 'renewed', expiresAt: sub?.expirationDateTime || null });
        } catch (err) {
            results.push({ vendorId, action: 'error', error: err.message });
        }
    }
    return { vendors: vendorIds.length, results };
}

/**
 * Run the Inbox + Sent Items delta for every configured vendor (gap recovery +
 * seed). The Sent pass captures replies sent directly from Outlook so threads
 * reflect them; one vendor's failure never aborts the others.
 */
async function reconcileAllMailboxes() {
    const vendorIds = await getEmailEnabledVendorIds();
    const results = [];
    for (const vendorId of vendorIds) {
        try {
            const r = await emailSyncService.reconcileDelta(vendorId);
            const s = await emailSyncService.reconcileSentDelta(vendorId);
            results.push({ vendorId, action: 'reconciled', ingested: r.ingested, sentIngested: s.ingested });
        } catch (err) {
            results.push({ vendorId, action: 'error', error: err.message });
        }
    }
    return { vendors: vendorIds.length, results };
}

module.exports = {
    getEmailEnabledVendorIds,
    renewDueSubscriptions,
    reconcileAllMailboxes,
    RENEW_WHEN_WITHIN_MS,
};
