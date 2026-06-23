// routes/me/vendor/dashboard.js
// Back-office dashboard stats. Works for VendorAdmin and VendorAgent regardless
// of whether the Share Request module is enabled — SR/Cases sections come back
// as zeros if the tables are empty (or absent) for the vendor.
//
// Endpoint: GET /api/me/vendor/dashboard/stats
//
// Response shape:
//   userStats           — current user's slice
//   backOfficeStats     — vendor-wide totals
//   today               — "right now" highlight strip
//   dailyVolume         — last 30 days, one row per day { date, sr, cases }
//   srStatusBreakdown   — [{ status, count }]
//   caseStatusBreakdown — [{ status, count }]
//   teamWorkload        — currently claimed counts per back-office user
//   recentShareRequests — 8 most-recent SRs

const express = require('express');
const { getPool, sql } = require('../../../config/database');
const { authenticate, authorize } = require('../../../middleware/auth');
const { attachVendorContext } = require('../../../middleware/shareRequestAccess');

const router = express.Router();
router.use(authenticate);
router.use(authorize(['VendorAdmin', 'VendorAgent']));
router.use(attachVendorContext);

const SR_OPEN_STATUSES = [
    'New',
    'Acknowledged',
    'In Review',
    'Awaiting Member Info',
    'Awaiting Authorization',
    'Processing'
];
const CASE_OPEN_STATUSES = ['Open', 'In Progress', 'Pending'];

const TREND_DAYS = 30;
const RECENT_SR_LIMIT = 8;

const inList = (arr, prefix) => arr.map((_, i) => `@${prefix}${i}`).join(', ');

// Run a query; on failure return a fallback. Tables (e.g. oe.Cases) may not
// exist for tenants that never enabled the module — we want the dashboard to
// degrade gracefully instead of 500-ing.
async function safeQuery(label, fn, fallback) {
    try {
        return await fn();
    } catch (err) {
        console.warn(`[dashboard/stats] ${label} failed:`, err.message);
        return fallback;
    }
}

router.get('/stats', async (req, res) => {
    try {
        const vendorId = req.vendor.VendorId;
        const userId = req.user.UserId;
        const pool = await getPool();

        // ------------------------------------------------------------------
        // Share Request aggregate counts
        // ------------------------------------------------------------------
        const srAgg = await safeQuery(
            'sr aggregate',
            async () => {
                const r = pool.request();
                r.input('vendorId', sql.UniqueIdentifier, vendorId);
                r.input('userId', sql.UniqueIdentifier, userId);
                SR_OPEN_STATUSES.forEach((s, i) => r.input(`srOpen${i}`, sql.NVarChar, s));
                const openList = inList(SR_OPEN_STATUSES, 'srOpen');
                const result = await r.query(`
                    SELECT
                        COUNT(*) AS Total,
                        SUM(CASE WHEN Status IN (${openList}) THEN 1 ELSE 0 END) AS [Open],
                        SUM(CASE
                            WHEN Status IN (${openList})
                             AND SubmittedDate >= DATEADD(day, -7, SYSUTCDATETIME())
                            THEN 1 ELSE 0 END) AS OpenedThisWeek,
                        SUM(CASE
                            WHEN SubmittedDate >= CAST(SYSUTCDATETIME() AS DATE)
                            THEN 1 ELSE 0 END) AS OpenedToday,
                        SUM(CASE
                            WHEN Status IN (${openList}) AND ClaimedByUserId IS NULL
                            THEN 1 ELSE 0 END) AS UnclaimedOpen,
                        SUM(CASE
                            WHEN Status IN (${openList}) AND ClaimedByUserId = @userId
                            THEN 1 ELSE 0 END) AS OpenAssignedToMe
                    FROM oe.ShareRequests
                    WHERE VendorId = @vendorId
                `);
                return result.recordset[0] || {};
            },
            { Total: 0, Open: 0, OpenedThisWeek: 0, OpenedToday: 0, UnclaimedOpen: 0, OpenAssignedToMe: 0 }
        );

        const srWorked = await safeQuery(
            'sr worked',
            async () => {
                const r = await pool.request()
                    .input('vendorId', sql.UniqueIdentifier, vendorId)
                    .input('userId', sql.UniqueIdentifier, userId)
                    .query(`
                        SELECT COUNT(*) AS Worked FROM (
                            SELECT sr.ShareRequestId
                            FROM oe.ShareRequests sr
                            WHERE sr.VendorId = @vendorId AND sr.ClaimedByUserId = @userId
                            UNION
                            SELECT DISTINCT n.ShareRequestId
                            FROM oe.ShareRequestNotes n
                            INNER JOIN oe.ShareRequests sr ON sr.ShareRequestId = n.ShareRequestId
                            WHERE sr.VendorId = @vendorId
                              AND n.CreatedBy = @userId
                              AND n.NoteType = 'SystemActivity'
                              AND (n.Note LIKE 'Share request assigned to%'
                                   OR n.Note LIKE 'Share request claimed by%')
                        ) x
                    `);
                return r.recordset[0]?.Worked || 0;
            },
            0
        );

        // Average minutes from SR submission → first claim, last 30 days.
        const srAvgClaim = await safeQuery(
            'sr avg claim',
            async () => {
                const r = await pool.request()
                    .input('vendorId', sql.UniqueIdentifier, vendorId)
                    .query(`
                        SELECT AVG(CAST(DATEDIFF(MINUTE, SubmittedDate, ClaimedAt) AS FLOAT)) AS AvgMin
                        FROM oe.ShareRequests
                        WHERE VendorId = @vendorId
                          AND ClaimedAt IS NOT NULL
                          AND SubmittedDate IS NOT NULL
                          AND ClaimedAt >= SubmittedDate
                          AND ClaimedAt >= DATEADD(day, -30, SYSUTCDATETIME())
                    `);
                return r.recordset[0]?.AvgMin != null ? Number(r.recordset[0].AvgMin) : null;
            },
            null
        );

        const srStatusBreakdown = await safeQuery(
            'sr status breakdown',
            async () => {
                const r = await pool.request()
                    .input('vendorId', sql.UniqueIdentifier, vendorId)
                    .query(`
                        SELECT Status, COUNT(*) AS Count
                        FROM oe.ShareRequests
                        WHERE VendorId = @vendorId
                        GROUP BY Status
                    `);
                return r.recordset.map((row) => ({ status: row.Status, count: Number(row.Count) }));
            },
            []
        );

        // ------------------------------------------------------------------
        // Case aggregate counts
        // ------------------------------------------------------------------
        const caseAgg = await safeQuery(
            'case aggregate',
            async () => {
                const r = pool.request();
                r.input('vendorId', sql.UniqueIdentifier, vendorId);
                r.input('userId', sql.UniqueIdentifier, userId);
                CASE_OPEN_STATUSES.forEach((s, i) => r.input(`cOpen${i}`, sql.NVarChar, s));
                const openList = inList(CASE_OPEN_STATUSES, 'cOpen');
                const result = await r.query(`
                    SELECT
                        COUNT(*) AS Total,
                        SUM(CASE WHEN Status IN (${openList}) THEN 1 ELSE 0 END) AS [Open],
                        SUM(CASE
                            WHEN Status IN (${openList}) AND ClaimedByUserId = @userId
                            THEN 1 ELSE 0 END) AS OpenAssignedToMe
                    FROM oe.Cases
                    WHERE VendorId = @vendorId
                `);
                return result.recordset[0] || {};
            },
            { Total: 0, Open: 0, OpenAssignedToMe: 0 }
        );

        const casesWorked = await safeQuery(
            'cases worked',
            async () => {
                const r = await pool.request()
                    .input('vendorId', sql.UniqueIdentifier, vendorId)
                    .input('userId', sql.UniqueIdentifier, userId)
                    .query(`
                        SELECT COUNT(*) AS Worked FROM (
                            SELECT c.CaseId
                            FROM oe.Cases c
                            WHERE c.VendorId = @vendorId AND c.ClaimedByUserId = @userId
                            UNION
                            SELECT DISTINCT n.CaseId
                            FROM oe.CaseNotes n
                            INNER JOIN oe.Cases c ON c.CaseId = n.CaseId
                            WHERE c.VendorId = @vendorId
                              AND n.CreatedBy = @userId
                              AND n.NoteType = 'claimed'
                        ) x
                    `);
                return r.recordset[0]?.Worked || 0;
            },
            0
        );

        const caseStatusBreakdown = await safeQuery(
            'case status breakdown',
            async () => {
                const r = await pool.request()
                    .input('vendorId', sql.UniqueIdentifier, vendorId)
                    .query(`
                        SELECT Status, COUNT(*) AS Count
                        FROM oe.Cases
                        WHERE VendorId = @vendorId
                        GROUP BY Status
                    `);
                return r.recordset.map((row) => ({ status: row.Status, count: Number(row.Count) }));
            },
            []
        );

        // ------------------------------------------------------------------
        // Daily volume — last 30 days, one row per day. We build the date
        // spine in JS (always 30 entries) and merge in the SQL counts so the
        // chart never has gaps for zero-volume days.
        // ------------------------------------------------------------------
        const srDaily = await safeQuery(
            'sr daily',
            async () => {
                const r = await pool.request()
                    .input('vendorId', sql.UniqueIdentifier, vendorId)
                    .query(`
                        SELECT CAST(SubmittedDate AS DATE) AS Day, COUNT(*) AS Count
                        FROM oe.ShareRequests
                        WHERE VendorId = @vendorId
                          AND SubmittedDate >= DATEADD(day, -${TREND_DAYS - 1}, CAST(SYSUTCDATETIME() AS DATE))
                        GROUP BY CAST(SubmittedDate AS DATE)
                    `);
                return new Map(r.recordset.map((row) => [toDateKey(row.Day), Number(row.Count)]));
            },
            new Map()
        );

        const caseDaily = await safeQuery(
            'case daily',
            async () => {
                const r = await pool.request()
                    .input('vendorId', sql.UniqueIdentifier, vendorId)
                    .query(`
                        SELECT CAST(CreatedDate AS DATE) AS Day, COUNT(*) AS Count
                        FROM oe.Cases
                        WHERE VendorId = @vendorId
                          AND CreatedDate >= DATEADD(day, -${TREND_DAYS - 1}, CAST(SYSUTCDATETIME() AS DATE))
                        GROUP BY CAST(CreatedDate AS DATE)
                    `);
                return new Map(r.recordset.map((row) => [toDateKey(row.Day), Number(row.Count)]));
            },
            new Map()
        );

        const dailyVolume = buildDateSpine(TREND_DAYS).map((day) => ({
            date: day,
            sr: srDaily.get(day) || 0,
            cases: caseDaily.get(day) || 0
        }));

        // ------------------------------------------------------------------
        // Team workload — currently claimed open SRs + Cases per back-office
        // user.
        // ------------------------------------------------------------------
        const teamWorkload = await safeQuery(
            'team workload',
            async () => {
                const srOpen = SR_OPEN_STATUSES.map((s) => `'${s.replace(/'/g, "''")}'`).join(',');
                const caseOpen = CASE_OPEN_STATUSES.map((s) => `'${s.replace(/'/g, "''")}'`).join(',');
                const r = await pool.request()
                    .input('vendorId', sql.UniqueIdentifier, vendorId)
                    .query(`
                        SELECT
                            u.UserId,
                            u.FirstName,
                            u.LastName,
                            ISNULL(sr.Cnt, 0) AS SrClaimed,
                            ISNULL(c.Cnt, 0)  AS CaseClaimed
                        FROM oe.Users u
                        OUTER APPLY (
                            SELECT COUNT(*) AS Cnt
                            FROM oe.ShareRequests s
                            WHERE s.VendorId = @vendorId
                              AND s.ClaimedByUserId = u.UserId
                              AND s.Status IN (${srOpen})
                        ) sr
                        OUTER APPLY (
                            SELECT COUNT(*) AS Cnt
                            FROM oe.Cases ca
                            WHERE ca.VendorId = @vendorId
                              AND ca.ClaimedByUserId = u.UserId
                              AND ca.Status IN (${caseOpen})
                        ) c
                        WHERE u.VendorId = @vendorId
                          AND u.Status = 'Active'
                          AND (ISNULL(sr.Cnt, 0) + ISNULL(c.Cnt, 0)) > 0
                        ORDER BY (ISNULL(sr.Cnt, 0) + ISNULL(c.Cnt, 0)) DESC
                    `);
                return r.recordset.map((row) => ({
                    userId: row.UserId,
                    name: `${row.FirstName || ''} ${row.LastName || ''}`.trim() || 'Unknown',
                    srClaimed: Number(row.SrClaimed) || 0,
                    caseClaimed: Number(row.CaseClaimed) || 0
                }));
            },
            []
        );

        // ------------------------------------------------------------------
        // Recent share requests — last RECENT_SR_LIMIT regardless of status.
        // ------------------------------------------------------------------
        const recentShareRequests = await safeQuery(
            'recent share requests',
            async () => {
                const r = await pool.request()
                    .input('vendorId', sql.UniqueIdentifier, vendorId)
                    .query(`
                        SELECT TOP ${RECENT_SR_LIMIT}
                            sr.ShareRequestId,
                            sr.RequestNumber,
                            sr.Status,
                            sr.SubmittedDate,
                            sr.TotalBilledAmount,
                            u.FirstName AS MemberFirstName,
                            u.LastName  AS MemberLastName,
                            claimer.FirstName AS ClaimedByFirstName,
                            claimer.LastName  AS ClaimedByLastName
                        FROM oe.ShareRequests sr
                        LEFT JOIN oe.Members m ON sr.MemberId = m.MemberId
                        LEFT JOIN oe.Users u   ON m.UserId = u.UserId
                        LEFT JOIN oe.Users claimer ON sr.ClaimedByUserId = claimer.UserId
                        WHERE sr.VendorId = @vendorId
                        ORDER BY sr.SubmittedDate DESC
                    `);
                return r.recordset.map((row) => ({
                    id: row.ShareRequestId,
                    requestNumber: row.RequestNumber,
                    status: row.Status,
                    submittedDate: row.SubmittedDate,
                    totalBilledAmount: row.TotalBilledAmount != null ? Number(row.TotalBilledAmount) : null,
                    memberName: `${row.MemberFirstName || ''} ${row.MemberLastName || ''}`.trim() || null,
                    claimedByName:
                        `${row.ClaimedByFirstName || ''} ${row.ClaimedByLastName || ''}`.trim() || null
                }));
            },
            []
        );

        // ------------------------------------------------------------------
        // New form submissions (last 7 days)
        // ------------------------------------------------------------------
        const newFormSubmissions = await safeQuery(
            'form submissions',
            async () => {
                const r = await pool.request()
                    .input('vendorId', sql.UniqueIdentifier, vendorId)
                    .query(`
                        SELECT COUNT(*) AS NewSubmissions
                        FROM oe.PublicFormSubmissions s
                        INNER JOIN oe.PublicFormTemplates t
                            ON t.FormTemplateId = s.FormTemplateId
                        WHERE t.DefaultVendorId = @vendorId
                          AND s.CreatedDate >= DATEADD(day, -7, SYSUTCDATETIME())
                    `);
                return r.recordset[0]?.NewSubmissions || 0;
            },
            0
        );

        // ------------------------------------------------------------------
        // Enrollment reach: households + total lives on this vendor's products.
        //   households = distinct households with >=1 active vendor-product
        //               enrollment.
        //   lives      = every person living in those households (family plans
        //               cover spouse/children who don't each carry their own
        //               enrollment row), so lives > households. Test data and
        //               terminated enrollments excluded. Bundles are covered
        //               because bundle products carry the VendorId themselves.
        // ------------------------------------------------------------------
        const enrollmentStats = await safeQuery(
            'enrollment households/lives',
            async () => {
                const r = pool.request();
                r.input('vendorId', sql.UniqueIdentifier, vendorId);
                const result = await r.query(`
                    WITH EnrolledHouseholds AS (
                        SELECT DISTINCT m.HouseholdId
                        FROM oe.Enrollments e
                        INNER JOIN oe.Products p ON p.ProductId = e.ProductId
                        INNER JOIN oe.Members m ON m.MemberId = e.MemberId
                        WHERE p.VendorId = @vendorId
                          AND e.Status = N'Active'
                          AND (e.TerminationDate IS NULL OR e.TerminationDate > SYSUTCDATETIME())
                          AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
                          AND m.HouseholdId IS NOT NULL
                          AND m.IsTestData = 0
                    )
                    SELECT
                        (SELECT COUNT(*) FROM EnrolledHouseholds) AS Households,
                        (SELECT COUNT(*)
                           FROM oe.Members m2
                           INNER JOIN EnrolledHouseholds eh ON eh.HouseholdId = m2.HouseholdId
                           WHERE m2.IsTestData = 0) AS Lives
                `);
                return result.recordset[0] || { Households: 0, Lives: 0 };
            },
            { Households: 0, Lives: 0 }
        );

        res.json({
            success: true,
            data: {
                userStats: {
                    shareRequestsWorked: srWorked,
                    casesWorked: casesWorked,
                    openShareRequestsAssigned: Number(srAgg.OpenAssignedToMe) || 0,
                    openCasesAssigned: Number(caseAgg.OpenAssignedToMe) || 0,
                    newFormSubmissions: newFormSubmissions
                },
                backOfficeStats: {
                    totalShareRequests: Number(srAgg.Total) || 0,
                    totalCases: Number(caseAgg.Total) || 0,
                    openShareRequests: Number(srAgg.Open) || 0,
                    openCases: Number(caseAgg.Open) || 0,
                    shareRequestsOpenedThisWeek: Number(srAgg.OpenedThisWeek) || 0,
                    enrolledHouseholds: Number(enrollmentStats.Households) || 0,
                    enrolledLives: Number(enrollmentStats.Lives) || 0
                },
                today: {
                    srOpenedToday: Number(srAgg.OpenedToday) || 0,
                    srUnclaimedOpen: Number(srAgg.UnclaimedOpen) || 0,
                    srAvgClaimMinutes: srAvgClaim
                },
                dailyVolume,
                srStatusBreakdown,
                caseStatusBreakdown,
                teamWorkload,
                recentShareRequests
            }
        });
    } catch (error) {
        console.error('❌ dashboard/stats:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to load dashboard stats',
            error: error.message
        });
    }
});

// Build an array of YYYY-MM-DD strings for the last N days, oldest first.
function buildDateSpine(days) {
    const out = [];
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    for (let i = days - 1; i >= 0; i -= 1) {
        const d = new Date(today);
        d.setUTCDate(today.getUTCDate() - i);
        out.push(toDateKey(d));
    }
    return out;
}

function toDateKey(value) {
    const d = value instanceof Date ? value : new Date(value);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

module.exports = router;
