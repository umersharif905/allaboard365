// backend/services/shareWellStatsService.js
//
// Computes public, aggregate ShareWELL sharing statistics for display on the
// ShareWELL (sharewellhealth.org) and MightyWell (mightywellhealth.com) marketing
// sites. Read-only; returns ONLY rolled-up aggregate figures — dollar totals and
// request counts — never any member-, provider-, or vendor-identifying detail.
//
// Source of truth: oe.ShareRequestTransactions (the money ledger), scoped to the
// ShareWELL Health/Partners vendor. Mirrors the validated methodology:
//   - "shared"      = Payment to Provider + Reimbursement (Completed/Cleared)
//   - "negotiated"  = Discount from Provider + Discount from Emry RBP (Completed/Cleared)
//   - "member resp" = UA Payment + Member Payment (Completed/Cleared)
// Header columns on oe.ShareRequests / oe.ShareRequestBills are intentionally NOT
// used for shared/negotiated totals because they are not reliably populated.

const { getPool } = require('../config/database');

// ShareWELL Health/Partners vendor. Overridable for non-prod databases.
const SHAREWELL_VENDOR_ID =
    process.env.SHAREWELL_VENDOR_ID || 'D2A84803-5A9B-4E97-98A5-BEE1A11BBDA6';

// Stats change slowly (nightly jobs + manual processing), so cache aggressively
// to avoid hitting the production DB on every marketing-site page view.
const CACHE_TTL_MS = Number(process.env.SHAREWELL_STATS_CACHE_TTL_MS) || 60 * 60 * 1000; // 60 min

let cachedStats = null;
let cachedAt = 0;

const SHARED_TYPES = "('Payment to Provider','Reimbursement')";
const NEGOTIATED_TYPES = "('Discount from Provider','Discount from Emry RBP')";
const SETTLED_STATUSES = "('Completed','Cleared')";

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function monthYearLabel(d) {
    if (!d) return null;
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return null;
    return `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}

async function queryStats() {
    const pool = await getPool();
    // Only count transactions dated on or before today so published figures are
    // always truthfully "as of" the current date (guards against future-dated rows).
    const result = await pool.request()
        .input('vendorId', SHAREWELL_VENDOR_ID)
        .query(`
            WITH swr AS (
                SELECT sr.ShareRequestId
                FROM oe.ShareRequests sr
                WHERE sr.VendorId = @vendorId
            ),
            tx AS (
                SELECT t.ShareRequestId, t.TransactionType, t.TransactionStatus,
                       t.Amount, t.TransactionDate
                FROM oe.ShareRequestTransactions t
                INNER JOIN swr ON swr.ShareRequestId = t.ShareRequestId
                WHERE t.TransactionDate <= CAST(GETUTCDATE() AS DATE)
            )
            SELECT
                (SELECT ISNULL(SUM(Amount),0) FROM tx
                   WHERE TransactionType IN ${SHARED_TYPES}
                     AND TransactionStatus IN ${SETTLED_STATUSES})            AS totalShared,
                (SELECT ISNULL(SUM(Amount),0) FROM tx
                   WHERE TransactionType IN ${NEGOTIATED_TYPES}
                     AND TransactionStatus IN ${SETTLED_STATUSES})            AS totalNegotiated,
                -- billedInternal is used only to derive avgPercentReduced; it is
                -- deliberately NOT included in the public response.
                (SELECT ISNULL(SUM(b.BilledAmount),0)
                   FROM oe.ShareRequestBills b
                   INNER JOIN swr ON swr.ShareRequestId = b.ShareRequestId)   AS billedInternal,
                -- Every sharing request members opened for the vendor (any status).
                (SELECT COUNT(*) FROM swr)                                    AS totalRequests,
                -- Distinct requests that actually received community sharing.
                (SELECT COUNT(DISTINCT ShareRequestId) FROM tx
                   WHERE TransactionType IN ${SHARED_TYPES}
                     AND TransactionStatus IN ${SETTLED_STATUSES})            AS requestsShared,
                (SELECT MIN(TransactionDate) FROM tx
                   WHERE TransactionType IN ${SHARED_TYPES}
                     AND TransactionStatus IN ${SETTLED_STATUSES})            AS sinceDate,
                (SELECT MAX(TransactionDate) FROM tx
                   WHERE TransactionType IN ${SHARED_TYPES}
                     AND TransactionStatus IN ${SETTLED_STATUSES})            AS lastDate
        `);

    const row = result.recordset[0] || {};

    const totalShared = round2(row.totalShared);
    const totalNegotiated = round2(row.totalNegotiated);
    const billedInternal = round2(row.billedInternal);
    const avgPercentReduced = billedInternal > 0
        ? Math.round((totalNegotiated / billedInternal) * 100)
        : 0;

    // Public payload — rolled-up aggregates only. Billed totals / member
    // responsibility remain internal and are NOT exposed.
    return {
        totalShared,                 // shared by the community toward eligible needs
        totalNegotiated,             // reduced via negotiated provider discounts
        avgPercentReduced,           // ~% reduction negotiated on members' bills
        totalRequests: Number(row.totalRequests) || 0,    // sharing requests opened
        requestsShared: Number(row.requestsShared) || 0,  // requests that received sharing
        since: row.sinceDate || null,
        sinceLabel: monthYearLabel(row.sinceDate),
        asOf: row.lastDate || null,
        asOfLabel: monthYearLabel(row.lastDate),
        updatedAt: new Date().toISOString(),
    };
}

/**
 * Returns cached aggregate ShareWELL stats, refreshing from the DB when the
 * cache is cold or expired. Pass { force: true } to bypass the cache.
 */
async function getShareWellStats({ force = false } = {}) {
    const now = Date.now();
    if (!force && cachedStats && (now - cachedAt) < CACHE_TTL_MS) {
        return { ...cachedStats, cached: true };
    }
    const stats = await queryStats();
    cachedStats = stats;
    cachedAt = now;
    return { ...stats, cached: false };
}

module.exports = { getShareWellStats, SHAREWELL_VENDOR_ID, CACHE_TTL_MS };
