// routes/me/vendor/members.js
// Member search routes for Vendor Portal (Share Request Management)

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authenticate, authorize } = require('../../../middleware/auth');
const { attachVendorContext } = require('../../../middleware/shareRequestAccess');
const sendGridEmailService = require('../../../services/sendGridEmailService');
const publicFormInvitationService = require('../../../services/publicFormInvitationService');
const FinanceSummaryService = require('../../../services/financeSummaryService');
const { classifyExactSearch } = require('../../../utils/exactMemberSearch');

// Digits-only normalize of a stored phone column, last-10 comparison (mirrors
// the resolver / emailThreadService). Alias `u` = oe.Users.
const PHONE_DIGITS_SQL =
    "RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(u.PhoneNumber,' ',''),'(',''),')',''),'-',''),'+',''),'.',''),CHAR(9),''),10)";

// All routes require authentication and vendor context (not gated on ShareRequestEnabled — members are cross-tenant)
router.use(authenticate);
router.use(authorize(['VendorAdmin', 'VendorAgent']));
router.use(attachVendorContext);

// Member search predicate (shared by the members list + typeahead). Matches the
// member directly on name / email / member #, AND — so a dependent or spouse
// search also surfaces their account — pulls in the household PRIMARY whenever any
// member of that household matches the term. Expects an `@search` ('%term%') input
// and table aliases `u` (oe.Users) + `m` (oe.Members).
const MEMBER_SEARCH_PREDICATE = `(
    u.FirstName LIKE @search
    OR u.LastName LIKE @search
    OR u.Email LIKE @search
    OR m.HouseholdMemberID LIKE @search
    OR (u.FirstName + ' ' + u.LastName) LIKE @search
    OR (
        m.RelationshipType = 'P'
        AND m.HouseholdId IS NOT NULL
        AND EXISTS (
            SELECT 1
            FROM oe.Members ms
            INNER JOIN oe.Users us ON ms.UserId = us.UserId
            WHERE ms.HouseholdId = m.HouseholdId
              AND (
                  us.FirstName LIKE @search
                  OR us.LastName LIKE @search
                  OR us.Email LIKE @search
                  OR ms.HouseholdMemberID LIKE @search
                  OR (us.FirstName + ' ' + us.LastName) LIKE @search
              )
        )
    )
)`;

/**
 * GET /api/me/vendor/members
 * Get all members enrolled in vendor's products with pagination
 */
router.get('/', async (req, res) => {
    try {
        const {
            page = 1,
            limit = 25,
            search = '',
            status = '',
            memberStatus = '',
            productId = '',
            sortBy = 'LastName',
            sortOrder = 'ASC'
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);
        const pool = await getPool();

        // Build query conditions. Default scope is intentionally broad: every member
        // with any enrollment on this vendor's products, including Terminated and
        // e123 migration placeholders. Callers narrow via `memberStatus` or `status`.
        // Default member search shows household PRIMARIES (and standalone members)
        // only — never dependents/spouses as their own rows. A dependent search
        // still works (MEMBER_SEARCH_PREDICATE pulls in the primary) and the matched
        // dependent is surfaced as a sub-note (MatchedMembers) on the primary's row.
        let whereConditions = [
            'p.VendorId = @vendorId',
            "(m.RelationshipType IS NULL OR m.RelationshipType NOT IN ('S','C'))"
        ];

        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId);
        request.input('offset', sql.Int, offset);
        request.input('limit', sql.Int, parseInt(limit));

        if (search) {
            whereConditions.push(MEMBER_SEARCH_PREDICATE);
            request.input('search', sql.NVarChar, `%${search}%`);
        }

        // Legacy `status` param: only applied when explicitly set (filters on enrollment status).
        if (status) {
            whereConditions.push('e.Status = @status');
            request.input('status', sql.NVarChar, status);
        }

        if (productId) {
            whereConditions.push('e.ProductId = @productId');
            request.input('productId', sql.UniqueIdentifier, productId);
        }

        const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

        const validSortColumns = ['LastName', 'FirstName', 'Email', 'HouseholdMemberID', 'EnrollmentDate', 'Status', 'MemberStatus'];
        const safeSort = validSortColumns.includes(sortBy) ? sortBy : 'LastName';
        const safeSortOrder = sortOrder.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

        // Shared CTE: derives MemberStatus inline so both count + data + ORDER BY can use it.
        const baseCte = `
            WITH MemberList AS (
                SELECT DISTINCT
                    m.MemberId,
                    m.HouseholdId,
                    m.HouseholdMemberID,
                    m.RelationshipType,
                    m.Address,
                    m.City,
                    m.State,
                    m.Zip,
                    m.DateOfBirth,
                    m.Status AS MemberRawStatus,
                    m.IsPendingMigration,
                    m.MigrationSourceSystem,
                    u.FirstName,
                    u.LastName,
                    u.Email,
                    u.PhoneNumber as Phone,
                    (
                        SELECT COUNT(*) FROM oe.Enrollments e2
                        INNER JOIN oe.Products p2 ON e2.ProductId = p2.ProductId
                        WHERE e2.MemberId = m.MemberId AND p2.VendorId = @vendorId
                          AND e2.Status NOT IN ('Terminated','Inactive')
                    ) AS LiveEnrollments,
                    (
                        SELECT COUNT(*) FROM oe.Enrollments e3
                        INNER JOIN oe.Products p3 ON e3.ProductId = p3.ProductId
                        WHERE e3.MemberId = m.MemberId AND p3.VendorId = @vendorId
                          AND e3.Status = 'Terminated'
                    ) AS TerminatedEnrollments,
                    (
                        SELECT COUNT(*) FROM oe.Enrollments e4
                        INNER JOIN oe.Products p4 ON e4.ProductId = p4.ProductId
                        WHERE e4.MemberId = m.MemberId AND p4.VendorId = @vendorId
                          AND e4.Status = 'Active'
                    ) AS ActiveEnrollments,
                    (
                        SELECT STRING_AGG(p5.Name, ', ') FROM oe.Enrollments e5
                        INNER JOIN oe.Products p5 ON e5.ProductId = p5.ProductId
                        WHERE e5.MemberId = m.MemberId AND p5.VendorId = @vendorId
                          AND e5.Status IN ('Active','Pending Payment')
                    ) AS ProductNames
                FROM oe.Members m
                INNER JOIN oe.Users u ON m.UserId = u.UserId
                INNER JOIN oe.Enrollments e ON m.MemberId = e.MemberId
                INNER JOIN oe.Products p ON e.ProductId = p.ProductId
                ${whereClause}
            ),
            MemberListWithStatus AS (
                SELECT
                    ml.*,
                    CASE
                        WHEN ml.IsPendingMigration = 1 THEN 'PendingMigration'
                        WHEN ml.MemberRawStatus IN ('Terminated','Pending Termination') THEN 'Terminated'
                        WHEN ml.LiveEnrollments = 0 THEN 'Terminated'
                        WHEN ml.MemberRawStatus IN ('Inactive','Declined') THEN 'Inactive'
                        ELSE 'Active'
                    END AS MemberStatus
                FROM MemberList ml
            )
        `;

        const memberStatusFilter = (memberStatus || '').toString();
        const memberStatusWhere = memberStatusFilter ? 'WHERE MemberStatus = @memberStatus' : '';
        if (memberStatusFilter) {
            request.input('memberStatus', sql.NVarChar, memberStatusFilter);
        }

        const countResult = await request.query(`
            ${baseCte}
            SELECT COUNT(*) AS total FROM MemberListWithStatus
            ${memberStatusWhere}
        `);
        const total = countResult.recordset[0].total;

        const dataReq = pool.request()
            .input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId)
            .input('offset', sql.Int, offset)
            .input('limit', sql.Int, parseInt(limit));
        if (search) dataReq.input('search', sql.NVarChar, `%${search}%`);
        if (status) dataReq.input('status', sql.NVarChar, status);
        if (productId) dataReq.input('productId', sql.UniqueIdentifier, productId);
        if (memberStatusFilter) dataReq.input('memberStatus', sql.NVarChar, memberStatusFilter);

        // When searching, attach the household member(s) that actually matched the
        // term (excluding the primary itself) so the UI can show a sub-note — e.g.
        // searching "John Doe" surfaces him under primary "Jason Doe".
        const matchedSelect = search ? `,
            (
                SELECT us.FirstName, us.LastName, ms.RelationshipType, ms.MemberId
                FROM oe.Members ms
                INNER JOIN oe.Users us ON ms.UserId = us.UserId
                WHERE ms.HouseholdId = mls.HouseholdId
                  AND ms.MemberId <> mls.MemberId
                  AND (
                      us.FirstName LIKE @search
                      OR us.LastName LIKE @search
                      OR us.Email LIKE @search
                      OR ms.HouseholdMemberID LIKE @search
                      OR (us.FirstName + ' ' + us.LastName) LIKE @search
                  )
                FOR JSON PATH
            ) AS MatchedMembersJson` : '';

        const dataResult = await dataReq.query(`
            ${baseCte}
            SELECT mls.*${matchedSelect}
            FROM MemberListWithStatus mls
            ${memberStatusWhere}
            ORDER BY ${safeSort} ${safeSortOrder}
            OFFSET @offset ROWS
            FETCH NEXT @limit ROWS ONLY
        `);

        const data = dataResult.recordset.map((row) => {
            const { MatchedMembersJson, ...rest } = row;
            let matchedMembers = [];
            if (MatchedMembersJson) {
                try { matchedMembers = JSON.parse(MatchedMembersJson); } catch { /* ignore bad JSON */ }
            }
            return { ...rest, MatchedMembers: matchedMembers };
        });

        // Off-plan members: people who exist in AllAboard365 but have NO enrollment
        // on this vendor's products (no plan, or only other vendors' plans). They
        // are surfaced ONLY on a strict identity match (exact email / phone / full
        // name / member-card id) — never fuzzy — so the care team can't enumerate
        // other vendors' membership. The UI renders these non-clickable. The normal
        // on-plan fuzzy search above is unchanged.
        let offPlanMatches = [];
        const exact = search ? classifyExactSearch(search) : null;
        if (exact) {
            const offReq = pool.request();
            offReq.input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId);
            const exactPreds = [];
            if (exact.email) {
                exactPreds.push('LOWER(LTRIM(RTRIM(u.Email))) = @oxEmail');
                offReq.input('oxEmail', sql.NVarChar, exact.email);
            }
            if (exact.phone) {
                exactPreds.push(`u.PhoneNumber IS NOT NULL AND ${PHONE_DIGITS_SQL} = @oxPhone`);
                offReq.input('oxPhone', sql.NVarChar, exact.phone);
            }
            if (exact.fullName) {
                exactPreds.push("LOWER(LTRIM(RTRIM(u.FirstName + ' ' + u.LastName))) = @oxName");
                offReq.input('oxName', sql.NVarChar, exact.fullName);
            }
            if (exact.card) {
                exactPreds.push("LOWER(REPLACE(REPLACE(LTRIM(RTRIM(m.HouseholdMemberID)), '-', ''), ' ', '')) = @oxCard");
                offReq.input('oxCard', sql.NVarChar, exact.card);
            }

            const offResult = await offReq.query(`
                SELECT TOP (25)
                    m.MemberId,
                    u.FirstName,
                    u.LastName,
                    (
                        SELECT STRING_AGG(av.VendorName, ', ')
                        FROM (
                            SELECT DISTINCT v.VendorName
                            FROM oe.Enrollments eo
                            INNER JOIN oe.Products po ON eo.ProductId = po.ProductId
                            INNER JOIN oe.Vendors v ON po.VendorId = v.VendorId
                            WHERE eo.MemberId = m.MemberId AND eo.Status = 'Active'
                        ) av
                    ) AS OtherPlanVendorName
                FROM oe.Members m
                INNER JOIN oe.Users u ON m.UserId = u.UserId
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM oe.Enrollments e
                    INNER JOIN oe.Products p ON e.ProductId = p.ProductId
                    WHERE e.MemberId = m.MemberId AND p.VendorId = @vendorId
                )
                AND (${exactPreds.join(' OR ')})
            `);
            offPlanMatches = offResult.recordset;
        }

        res.json({
            success: true,
            data,
            offPlanMatches,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                totalPages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (error) {
        console.error('❌ Error fetching members list:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch members',
            error: error.message
        });
    }
});

/**
 * GET /api/me/vendor/members/search
 * Search for members to create share requests
 * 
 * This searches members who have enrolled in products owned by the vendor
 */
router.get('/search', async (req, res) => {
    try {
        const { q, limit = 20 } = req.query;
        
        if (!q || q.length < 2) {
            return res.json({
                success: true,
                data: []
            });
        }

        const pool = await getPool();
        const request = pool.request();
        request.input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId);
        request.input('search', sql.NVarChar, `%${q}%`);
        request.input('limit', sql.Int, parseInt(limit));

        // Search members who have any enrollment (any status) on this vendor's products.
        // Includes terminated members and e123 migration placeholders — UI is responsible
        // for badging non-active states.
        const result = await request.query(`
            SELECT DISTINCT TOP (@limit)
                m.MemberId,
                u.FirstName,
                u.LastName,
                u.Email,
                u.PhoneNumber as Phone,
                m.HouseholdId,
                m.HouseholdMemberID,
                m.Status AS MemberRawStatus,
                m.IsPendingMigration,
                m.MigrationSourceSystem,
                CASE
                    WHEN m.IsPendingMigration = 1 THEN 'PendingMigration'
                    WHEN m.Status IN ('Terminated','Pending Termination') THEN 'Terminated'
                    WHEN NOT EXISTS (
                        SELECT 1 FROM oe.Enrollments ex
                        INNER JOIN oe.Products px ON ex.ProductId = px.ProductId
                        WHERE ex.MemberId = m.MemberId AND px.VendorId = @vendorId
                          AND ex.Status NOT IN ('Terminated','Inactive')
                    ) THEN 'Terminated'
                    WHEN m.Status IN ('Inactive','Declined') THEN 'Inactive'
                    ELSE 'Active'
                END AS MemberStatus
            FROM oe.Members m
            INNER JOIN oe.Users u ON m.UserId = u.UserId
            INNER JOIN oe.Enrollments e ON m.MemberId = e.MemberId
            INNER JOIN oe.Products p ON e.ProductId = p.ProductId
            WHERE p.VendorId = @vendorId
            AND ${MEMBER_SEARCH_PREDICATE}
            ORDER BY u.LastName, u.FirstName
        `);

        res.json({
            success: true,
            data: result.recordset
        });
    } catch (error) {
        console.error('❌ Error searching members:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to search members',
            error: error.message
        });
    }
});

/**
 * GET /api/me/vendor/members/household/:householdId
 * Get all members of a household
 */
router.get('/household/:householdId', async (req, res) => {
    try {
        const householdId = req.params.householdId;
        
        // Validate GUID format
        const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!householdId || !guidPattern.test(householdId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid household ID format',
                data: []
            });
        }

        const pool = await getPool();
        const request = pool.request();
        request.input('householdId', sql.UniqueIdentifier, householdId);
        request.input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId);

        // Get all members of the household who have enrollment with vendor's products
        const result = await request.query(`
            SELECT 
                m.MemberId,
                u.FirstName,
                u.LastName,
                u.Email,
                u.PhoneNumber as Phone,
                m.HouseholdId,
                m.HouseholdMemberID,
                m.DateOfBirth,
                m.RelationshipType,
                CASE m.RelationshipType 
                    WHEN 'P' THEN 'Primary'
                    WHEN 'S' THEN 'Spouse'
                    WHEN 'C' THEN 'Dependent'
                    ELSE 'Other'
                END as Relationship
            FROM oe.Members m
            INNER JOIN oe.Users u ON m.UserId = u.UserId
            WHERE m.HouseholdId = @householdId
            AND EXISTS (
                SELECT 1 FROM oe.Enrollments e
                INNER JOIN oe.Products p ON e.ProductId = p.ProductId
                WHERE e.MemberId = m.MemberId
                AND p.VendorId = @vendorId
                AND e.Status IN ('Active', 'Pending')
            )
            ORDER BY 
                CASE m.RelationshipType 
                    WHEN 'P' THEN 1 
                    WHEN 'S' THEN 2 
                    ELSE 3 
                END,
                u.FirstName
        `);

        res.json({
            success: true,
            data: result.recordset
        });
    } catch (error) {
        console.error('❌ Error fetching household members:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch household members',
            error: error.message
        });
    }
});

/**
 * GET /api/me/vendor/members/by-household-id/:householdMemberId
 * Get a member by their HouseholdMemberID (e.g., OED15990596)
 */
router.get('/by-household-id/:householdMemberId', async (req, res) => {
    try {
        const pool = await getPool();
        const request = pool.request();
        request.input('householdMemberId', sql.NVarChar, req.params.householdMemberId.toUpperCase());
        request.input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId);

        // Look up member by HouseholdMemberID and verify they have enrollment with vendor's products
        const result = await request.query(`
            SELECT DISTINCT
                m.MemberId,
                u.FirstName,
                u.LastName,
                u.Email,
                u.PhoneNumber as Phone,
                m.HouseholdId,
                m.HouseholdMemberID
            FROM oe.Members m
            INNER JOIN oe.Users u ON m.UserId = u.UserId
            INNER JOIN oe.Enrollments e ON m.MemberId = e.MemberId
            INNER JOIN oe.Products p ON e.ProductId = p.ProductId
            WHERE m.HouseholdMemberID = @householdMemberId
            AND p.VendorId = @vendorId
            AND e.Status IN ('Active', 'Pending')
        `);

        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Member not found or not enrolled in vendor products'
            });
        }

        res.json({
            success: true,
            data: result.recordset[0]
        });
    } catch (error) {
        console.error('❌ Error fetching member by HouseholdMemberID:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch member',
            error: error.message
        });
    }
});

// ----------------------------------------------------------------------------
// Helper: ensure a member belongs to this vendor (via product enrollment)
// Returns { MemberId, HouseholdId, Email } or null.
// ----------------------------------------------------------------------------
async function loadVendorMember(pool, memberId, vendorId) {
    const result = await pool.request()
        .input('memberId', sql.UniqueIdentifier, memberId)
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .query(`
            SELECT TOP 1
                m.MemberId,
                m.HouseholdId,
                m.UserId,
                m.TenantId,
                u.Email
            FROM oe.Members m
            INNER JOIN oe.Users u ON m.UserId = u.UserId
            INNER JOIN oe.Enrollments e ON m.MemberId = e.MemberId
            INNER JOIN oe.Products p ON e.ProductId = p.ProductId
            WHERE m.MemberId = @memberId
            AND p.VendorId = @vendorId
        `);
    return result.recordset[0] || null;
}

/**
 * GET /api/me/vendor/members/:id/household
 * Member-scoped household lookup. Returns all household members (regardless of enrollment).
 */
router.get('/:id/household', async (req, res) => {
    try {
        const pool = await getPool();
        const member = await loadVendorMember(pool, req.params.id, req.vendor.VendorId);
        if (!member) {
            return res.status(404).json({ success: false, message: 'Member not found' });
        }

        const result = await pool.request()
            .input('householdId', sql.UniqueIdentifier, member.HouseholdId)
            .query(`
                SELECT
                    m.MemberId,
                    m.HouseholdMemberID,
                    u.FirstName,
                    u.LastName,
                    u.Email,
                    u.PhoneNumber as Phone,
                    FORMAT(m.DateOfBirth, 'yyyy-MM-dd') as DateOfBirth,
                    m.Gender,
                    m.RelationshipType,
                    CASE m.RelationshipType
                        WHEN 'P' THEN 'Primary'
                        WHEN 'S' THEN 'Spouse'
                        WHEN 'C' THEN 'Dependent'
                        ELSE 'Other'
                    END as Relationship
                FROM oe.Members m
                INNER JOIN oe.Users u ON m.UserId = u.UserId
                WHERE m.HouseholdId = @householdId
                ORDER BY
                    CASE m.RelationshipType
                        WHEN 'P' THEN 1
                        WHEN 'S' THEN 2
                        ELSE 3
                    END,
                    u.FirstName
            `);

        res.json({ success: true, data: result.recordset });
    } catch (error) {
        console.error('❌ Error fetching member household:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch household', error: error.message });
    }
});

/**
 * GET /api/me/vendor/members/:id/call-logs
 * List vendor call logs scoped to a member.
 */
router.get('/:id/call-logs', async (req, res) => {
    try {
        const pool = await getPool();
        const member = await loadVendorMember(pool, req.params.id, req.vendor.VendorId);
        if (!member) {
            return res.status(404).json({ success: false, message: 'Member not found' });
        }

        const result = await pool.request()
            .input('memberId', sql.UniqueIdentifier, member.MemberId)
            .input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId)
            .query(`
                SELECT
                    cl.CallLogId,
                    cl.CallType AS Direction,
                    cl.CallStatus,
                    cl.CallerNumber,
                    cl.CalleeNumber,
                    cl.CallStartTime,
                    cl.CallEndTime,
                    cl.CallDurationSeconds,
                    cl.CallNotes,
                    cl.Source,
                    cl.HasRecording,
                    cl.RecordingUrl,
                    cl.CreatedDate,
                    u.FirstName + ' ' + u.LastName AS CreatedByName
                FROM oe.VendorCallLogs cl
                LEFT JOIN oe.Users u ON cl.CreatedBy = u.UserId
                WHERE cl.MemberId = @memberId
                AND cl.VendorId = @vendorId
                AND cl.IsActive = 1
                ORDER BY cl.CallStartTime DESC
            `);

        res.json({ success: true, data: result.recordset });
    } catch (error) {
        console.error('❌ Error fetching member call logs:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch call logs', error: error.message });
    }
});

/**
 * POST /api/me/vendor/members/:id/call-logs
 * Manually log a call against a member.
 */
router.post('/:id/call-logs', async (req, res) => {
    try {
        const pool = await getPool();
        const member = await loadVendorMember(pool, req.params.id, req.vendor.VendorId);
        if (!member) {
            return res.status(404).json({ success: false, message: 'Member not found' });
        }

        const {
            direction = 'Inbound',
            phoneNumber = '',
            startTime,
            endTime,
            notes = '',
        } = req.body || {};

        if (!['Inbound', 'Outbound'].includes(direction)) {
            return res.status(400).json({ success: false, message: 'Invalid direction' });
        }

        const start = startTime ? new Date(startTime) : new Date();
        const end = endTime ? new Date(endTime) : start;
        const duration = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
        const userId = req.user?.UserId || req.user?.userId || null;

        const insertResult = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId)
            .input('memberId', sql.UniqueIdentifier, member.MemberId)
            .input('direction', sql.NVarChar, direction)
            .input('phoneNumber', sql.NVarChar, phoneNumber)
            .input('start', sql.DateTime, start)
            .input('end', sql.DateTime, end)
            .input('duration', sql.Int, duration)
            .input('notes', sql.NVarChar(sql.MAX), notes)
            .input('createdBy', sql.UniqueIdentifier, userId)
            .query(`
                DECLARE @callLogId UNIQUEIDENTIFIER = NEWID();
                INSERT INTO oe.VendorCallLogs (
                    CallLogId, VendorId, CallType, CallStatus,
                    CallerNumber, CalleeNumber,
                    CallStartTime, CallEndTime, CallDurationSeconds,
                    MemberId, CallNotes, Source,
                    CreatedDate, CreatedBy, IsActive
                ) VALUES (
                    @callLogId, @vendorId, @direction, 'Completed',
                    CASE WHEN @direction = 'Inbound' THEN @phoneNumber ELSE NULL END,
                    CASE WHEN @direction = 'Outbound' THEN @phoneNumber ELSE NULL END,
                    @start, @end, @duration,
                    @memberId, @notes, 'manual',
                    GETDATE(), @createdBy, 1
                );
                SELECT @callLogId AS CallLogId;
            `);

        res.json({ success: true, data: { callLogId: insertResult.recordset[0].CallLogId } });
    } catch (error) {
        console.error('❌ Error creating member call log:', error);
        res.status(500).json({ success: false, message: 'Failed to create call log', error: error.message });
    }
});

/**
 * PUT /api/me/vendor/members/:id/call-logs/:callLogId
 * Update notes/times on an existing call log entry.
 */
router.put('/:id/call-logs/:callLogId', async (req, res) => {
    try {
        const pool = await getPool();
        const member = await loadVendorMember(pool, req.params.id, req.vendor.VendorId);
        if (!member) {
            return res.status(404).json({ success: false, message: 'Member not found' });
        }

        const { phoneNumber, direction, startTime, endTime, notes } = req.body || {};
        const start = startTime ? new Date(startTime) : null;
        const end = endTime ? new Date(endTime) : null;
        const duration = start && end
            ? Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000))
            : null;
        const userId = req.user?.UserId || req.user?.userId || null;

        const updateResult = await pool.request()
            .input('callLogId', sql.UniqueIdentifier, req.params.callLogId)
            .input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId)
            .input('memberId', sql.UniqueIdentifier, member.MemberId)
            .input('direction', sql.NVarChar, direction || null)
            .input('phoneNumber', sql.NVarChar, phoneNumber || null)
            .input('start', sql.DateTime, start)
            .input('end', sql.DateTime, end)
            .input('duration', sql.Int, duration)
            .input('notes', sql.NVarChar(sql.MAX), notes ?? null)
            .input('modifiedBy', sql.UniqueIdentifier, userId)
            .query(`
                UPDATE oe.VendorCallLogs
                SET
                    CallType = COALESCE(@direction, CallType),
                    CallerNumber = CASE
                        WHEN @direction = 'Inbound' THEN @phoneNumber
                        WHEN @direction = 'Outbound' THEN NULL
                        ELSE CallerNumber
                    END,
                    CalleeNumber = CASE
                        WHEN @direction = 'Outbound' THEN @phoneNumber
                        WHEN @direction = 'Inbound' THEN NULL
                        ELSE CalleeNumber
                    END,
                    CallStartTime = COALESCE(@start, CallStartTime),
                    CallEndTime = COALESCE(@end, CallEndTime),
                    CallDurationSeconds = COALESCE(@duration, CallDurationSeconds),
                    CallNotes = COALESCE(@notes, CallNotes),
                    ModifiedDate = GETDATE(),
                    ModifiedBy = @modifiedBy
                WHERE CallLogId = @callLogId
                AND VendorId = @vendorId
                AND MemberId = @memberId;
                SELECT @@ROWCOUNT AS rows;
            `);

        if (updateResult.recordset[0].rows === 0) {
            return res.status(404).json({ success: false, message: 'Call log not found' });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('❌ Error updating member call log:', error);
        res.status(500).json({ success: false, message: 'Failed to update call log', error: error.message });
    }
});

/**
 * DELETE /api/me/vendor/members/:id/call-logs/:callLogId
 * Soft-delete a call log entry.
 */
router.delete('/:id/call-logs/:callLogId', async (req, res) => {
    try {
        const pool = await getPool();
        const member = await loadVendorMember(pool, req.params.id, req.vendor.VendorId);
        if (!member) {
            return res.status(404).json({ success: false, message: 'Member not found' });
        }

        const userId = req.user?.UserId || req.user?.userId || null;

        const result = await pool.request()
            .input('callLogId', sql.UniqueIdentifier, req.params.callLogId)
            .input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId)
            .input('memberId', sql.UniqueIdentifier, member.MemberId)
            .input('modifiedBy', sql.UniqueIdentifier, userId)
            .query(`
                UPDATE oe.VendorCallLogs
                SET IsActive = 0, ModifiedDate = GETDATE(), ModifiedBy = @modifiedBy
                WHERE CallLogId = @callLogId AND VendorId = @vendorId AND MemberId = @memberId;
                SELECT @@ROWCOUNT AS rows;
            `);

        if (result.recordset[0].rows === 0) {
            return res.status(404).json({ success: false, message: 'Call log not found' });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('❌ Error deleting member call log:', error);
        res.status(500).json({ success: false, message: 'Failed to delete call log', error: error.message });
    }
});

/**
 * GET /api/me/vendor/members/:id/email-logs
 * List emails sent to this member's email address (read-only).
 */
router.get('/:id/email-logs', async (req, res) => {
    try {
        const pool = await getPool();
        const member = await loadVendorMember(pool, req.params.id, req.vendor.VendorId);
        if (!member) {
            return res.status(404).json({ success: false, message: 'Member not found' });
        }

        if (!member.Email) {
            return res.json({ success: true, data: [] });
        }

        const result = await pool.request()
            .input('email', sql.NVarChar, member.Email)
            .query(`
                SELECT TOP 200
                    EmailLogId,
                    Recipient,
                    Subject,
                    Status,
                    MessageId,
                    Error,
                    CreatedDate
                FROM oe.EmailLogs
                WHERE Recipient = @email
                ORDER BY CreatedDate DESC
            `);

        res.json({ success: true, data: result.recordset });
    } catch (error) {
        console.error('❌ Error fetching member email logs:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch email logs', error: error.message });
    }
});

/**
 * GET /api/me/vendor/members/:id/communications
 * Read-only feed of MessageHistory rows sent to this member's user account.
 * Mirrors the tenant Communications tab (`/api/message-center/history?recipientId=`).
 */
router.get('/:id/communications', async (req, res) => {
    try {
        const pool = await getPool();
        const member = await loadVendorMember(pool, req.params.id, req.vendor.VendorId);
        if (!member) {
            return res.status(404).json({ success: false, message: 'Member not found' });
        }

        if (!member.UserId) {
            return res.json({
                success: true,
                data: { data: [], total: 0, page: 1, limit: 0, totalPages: 0 }
            });
        }

        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const offset = (page - 1) * limit;

        const request = pool.request();
        request.input('recipientId', sql.UniqueIdentifier, member.UserId);
        request.input('offset', sql.Int, offset);
        request.input('limit', sql.Int, limit);

        const countResult = await request.query(`
            SELECT COUNT(*) AS totalCount
            FROM oe.MessageHistory mh
            WHERE mh.RecipientId = @recipientId
        `);
        const totalItems = countResult.recordset[0].totalCount;

        const result = await request.query(`
            SELECT
                mh.HistoryId AS historyId,
                mh.MessageId AS messageId,
                mh.TenantId AS tenantId,
                mh.RecipientId AS recipientId,
                COALESCE(u.FirstName + ' ' + u.LastName, 'Unknown User') AS recipientName,
                mh.RecipientAddress AS recipientAddress,
                mh.MessageType AS messageType,
                mh.Subject AS subject,
                mh.Status AS status,
                mh.ProviderMessageId AS providerMessageId,
                mh.ErrorMessage AS errorMessage,
                mh.SentDate AS sentDate,
                mh.BatchId AS batchId
            FROM oe.MessageHistory mh
            LEFT JOIN oe.Users u ON mh.RecipientId = u.UserId
            WHERE mh.RecipientId = @recipientId
            ORDER BY mh.SentDate DESC
            OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
        `);

        res.json({
            success: true,
            data: {
                data: result.recordset,
                total: totalItems,
                page,
                limit,
                totalPages: Math.ceil(totalItems / limit)
            }
        });
    } catch (error) {
        console.error('❌ Error fetching member communications:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch communications', error: error.message });
    }
});

/**
 * GET /api/me/vendor/members/:id/communications/:historyId
 * Single message body + provider events, scoped to a member we have access to.
 */
router.get('/:id/communications/:historyId', async (req, res) => {
    try {
        const pool = await getPool();
        const member = await loadVendorMember(pool, req.params.id, req.vendor.VendorId);
        if (!member || !member.UserId) {
            return res.status(404).json({ success: false, message: 'Member not found' });
        }

        const historyResult = await pool.request()
            .input('historyId', sql.UniqueIdentifier, req.params.historyId)
            .input('recipientId', sql.UniqueIdentifier, member.UserId)
            .query(`
                SELECT
                    mh.HistoryId AS historyId,
                    mh.MessageId AS messageId,
                    mh.TenantId AS tenantId,
                    mh.RecipientId AS recipientId,
                    COALESCE(u.FirstName + ' ' + u.LastName, 'Unknown User') AS recipientName,
                    mh.RecipientAddress AS recipientAddress,
                    mh.MessageType AS messageType,
                    mh.Subject AS subject,
                    mh.Status AS status,
                    mh.ProviderMessageId AS providerMessageId,
                    mh.ErrorMessage AS errorMessage,
                    mh.SentDate AS sentDate,
                    mh.Body AS body,
                    mh.FromAddress AS fromAddress
                FROM oe.MessageHistory mh
                LEFT JOIN oe.Users u ON mh.RecipientId = u.UserId
                WHERE mh.HistoryId = @historyId
                  AND mh.RecipientId = @recipientId
            `);

        if (historyResult.recordset.length === 0) {
            return res.status(404).json({ success: false, message: 'Message not found' });
        }

        const message = historyResult.recordset[0];

        const eventsResult = await pool.request()
            .input('messageId', sql.UniqueIdentifier, message.messageId)
            .query(`
                SELECT EventType AS event,
                       EventTime AS timestamp,
                       Reason    AS details,
                       Provider  AS provider,
                       MxServer  AS mxServer,
                       EventType AS eventType
                FROM oe.MessageEvent
                WHERE MessageId = @messageId
                ORDER BY EventTime ASC
            `);

        res.json({ success: true, data: { ...message, events: eventsResult.recordset } });
    } catch (error) {
        console.error('❌ Error fetching communication details:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch communication details', error: error.message });
    }
});

/**
 * GET /api/me/vendor/members/:id/notes
 * Aggregate notes from all of this member's share requests for this vendor.
 */
router.get('/:id/notes', async (req, res) => {
    try {
        const pool = await getPool();
        const member = await loadVendorMember(pool, req.params.id, req.vendor.VendorId);
        if (!member) {
            return res.status(404).json({ success: false, message: 'Member not found' });
        }

        const result = await pool.request()
            .input('memberId', sql.UniqueIdentifier, member.MemberId)
            .input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId)
            .query(`
                SELECT
                    n.NoteId,
                    n.ShareRequestId,
                    sr.RequestNumber,
                    n.NoteType,
                    n.Note,
                    n.IsInternal,
                    n.CreatedDate,
                    n.CreatedByName
                FROM oe.ShareRequestNotes n
                INNER JOIN oe.ShareRequests sr ON n.ShareRequestId = sr.ShareRequestId
                WHERE sr.MemberId = @memberId
                AND sr.VendorId = @vendorId
                ORDER BY n.CreatedDate DESC
            `);

        res.json({ success: true, data: result.recordset });
    } catch (error) {
        console.error('❌ Error fetching member notes:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch notes', error: error.message });
    }
});

/**
 * GET /api/me/vendor/members/:id/documents
 * Aggregate documents from all of this member's share requests for this vendor.
 */
router.get('/:id/documents', async (req, res) => {
    try {
        const pool = await getPool();
        const member = await loadVendorMember(pool, req.params.id, req.vendor.VendorId);
        if (!member) {
            return res.status(404).json({ success: false, message: 'Member not found' });
        }

        const result = await pool.request()
            .input('memberId', sql.UniqueIdentifier, member.MemberId)
            .input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId)
            .query(`
                SELECT
                    d.DocumentId,
                    d.ShareRequestId,
                    sr.RequestNumber,
                    d.DocumentName,
                    d.DocumentType,
                    d.FileName,
                    d.FileSize,
                    d.MimeType,
                    d.BlobUrl,
                    d.Description,
                    d.CreatedDate
                FROM oe.ShareRequestDocuments d
                INNER JOIN oe.ShareRequests sr ON d.ShareRequestId = sr.ShareRequestId
                WHERE sr.MemberId = @memberId
                AND sr.VendorId = @vendorId
                AND d.IsActive = 1
                ORDER BY d.CreatedDate DESC
            `);

        res.json({ success: true, data: result.recordset });
    } catch (error) {
        console.error('❌ Error fetching member documents:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch documents', error: error.message });
    }
});

/**
 * GET /api/me/vendor/members/:id/form-submissions
 * Form submissions tied to this member (forms-redesign Section 5). Returns
 * lightweight metadata grouped by linked share request — used by the member
 * Documents tab to fold form submissions into the per-SR folders + an
 * "Other submissions" bucket.
 */
router.get('/:id/form-submissions', async (req, res) => {
    try {
        const pool = await getPool();
        const member = await loadVendorMember(pool, req.params.id, req.vendor.VendorId);
        if (!member) {
            return res.status(404).json({ success: false, message: 'Member not found' });
        }
        const result = await pool.request()
            .input('memberId', sql.UniqueIdentifier, member.MemberId)
            .input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId)
            .query(`
                SELECT
                    s.SubmissionId,
                    s.FormTemplateId,
                    s.ShareRequestId,
                    s.CaseId,
                    s.AuthMode,
                    s.InvitationId,
                    s.MemberMatchStatus,
                    s.CreatedDate,
                    t.Title AS FormTitle,
                    t.FormKind,
                    sr.RequestNumber
                FROM oe.PublicFormSubmissions s
                INNER JOIN oe.PublicFormTemplates t ON t.FormTemplateId = s.FormTemplateId
                LEFT JOIN oe.ShareRequests sr ON sr.ShareRequestId = s.ShareRequestId
                WHERE s.MemberId = @memberId
                  AND (sr.ShareRequestId IS NULL OR sr.VendorId = @vendorId)
                ORDER BY s.CreatedDate DESC
            `);
        res.json({ success: true, data: result.recordset });
    } catch (error) {
        console.error('❌ Error fetching member form-submissions:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch form submissions' });
    }
});

/**
 * GET /api/me/vendor/members/:id/form-invitations
 * Public-form invitations addressed to this member (forms-redesign
 * followup Slice A.1.b). Returns all invitations regardless of state;
 * the care-team UI filters for active ones to surface the Revoke button
 * inline on the member's "Form submissions" folder.
 */
router.get('/:id/form-invitations', async (req, res) => {
    try {
        const pool = await getPool();
        const member = await loadVendorMember(pool, req.params.id, req.vendor.VendorId);
        if (!member) {
            return res.status(404).json({ success: false, message: 'Member not found' });
        }
        const rows = await publicFormInvitationService.listForMember({
            tenantId: member.TenantId,
            memberId: member.MemberId
        });
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('❌ Error fetching member form-invitations:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch form invitations' });
    }
});

/**
 * POST /api/me/vendor/members/:id/id-cards/send
 * Email a member's ID card PDF (generated client-side) to a recipient.
 * Body: { to, subject?, message?, productName, fileName, pdfBase64 }
 */
router.post('/:id/id-cards/send', async (req, res) => {
    try {
        const { to, subject, message, productName, fileName, pdfBase64 } = req.body || {};

        if (!to || !pdfBase64) {
            return res.status(400).json({ success: false, message: 'Recipient and PDF content are required' });
        }

        const pool = await getPool();
        const memberResult = await pool.request()
            .input('memberId', sql.UniqueIdentifier, req.params.id)
            .input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId)
            .query(`
                SELECT TOP 1
                    m.MemberId,
                    m.TenantId,
                    u.FirstName,
                    u.LastName,
                    u.Email
                FROM oe.Members m
                INNER JOIN oe.Users u ON m.UserId = u.UserId
                INNER JOIN oe.Enrollments e ON m.MemberId = e.MemberId
                INNER JOIN oe.Products p ON e.ProductId = p.ProductId
                WHERE m.MemberId = @memberId AND p.VendorId = @vendorId
            `);
        const member = memberResult.recordset[0];
        if (!member) {
            return res.status(404).json({ success: false, message: 'Member not found or not enrolled in vendor products' });
        }

        const safeProductName = (productName && String(productName).trim()) || 'ID Card';
        const safeFileName = (fileName && String(fileName).trim()) || `${safeProductName.replace(/[^\w\-]+/g, '_')}-id-card.pdf`;
        const recipientName = `${member.FirstName || ''} ${member.LastName || ''}`.trim() || 'Member';
        const finalSubject = (subject && String(subject).trim()) || `Your ${safeProductName} ID card`;
        const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
        const customMessageHtml = message
            ? `<p style="white-space:pre-wrap;margin:0 0 16px">${escapeHtml(message)}</p>`
            : '';
        const html = `
            <p>Hi ${escapeHtml(recipientName)},</p>
            ${customMessageHtml}
            <p>Your ${escapeHtml(safeProductName)} ID card is attached to this email as a PDF.</p>
        `;
        const text = `Hi ${recipientName},\n\n${message ? message + '\n\n' : ''}Your ${safeProductName} ID card is attached to this email as a PDF.\n`;

        const sendResult = await sendGridEmailService.sendEmail({
            tenantId: member.TenantId,
            to,
            subject: finalSubject,
            html,
            text,
            attachments: [{
                content: String(pdfBase64).replace(/^data:application\/pdf;base64,/, ''),
                filename: safeFileName,
                type: 'application/pdf',
                disposition: 'attachment'
            }],
            metadata: {
                sentBy: req.user.UserId,
                vendorId: req.vendor.VendorId,
                memberId: member.MemberId,
                purpose: 'id-card'
            }
        });

        if (sendResult && sendResult.messageId === 'dev-mode-skip') {
            return res.status(503).json({
                success: false,
                message: 'Email is not sent: SENDGRID_API_KEY is missing or invalid in this environment.'
            });
        }

        return res.json({ success: true, message: 'ID card emailed', messageId: sendResult?.messageId || null });
    } catch (error) {
        console.error('❌ Error sending ID card email:', error);
        return res.status(500).json({ success: false, message: 'Failed to send ID card', error: error.message });
    }
});

/**
 * POST /api/me/vendor/members/:id/id-cards/send-sms
 * Text a member a short-lived download link to their ID card PDF.
 * Body: { to, message?, productName, fileName, pdfBase64 }
 *
 * The PDF is uploaded to the `id-cards` blob container with a 7-day SAS URL,
 * then routed through MessageQueueService.queueMessage so it follows the same
 * immediate-send + queue + MessageHistory logging path as every other SMS the
 * system sends. Surfaces in the tenant's Message Center logs.
 */
router.post('/:id/id-cards/send-sms', async (req, res) => {
    try {
        const { to, message, productName, fileName, pdfBase64 } = req.body || {};

        if (!to || !pdfBase64) {
            return res.status(400).json({ success: false, message: 'Recipient phone and PDF content are required' });
        }

        const pool = await getPool();
        const memberResult = await pool.request()
            .input('memberId', sql.UniqueIdentifier, req.params.id)
            .input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId)
            .query(`
                SELECT TOP 1
                    m.MemberId,
                    m.TenantId,
                    u.UserId,
                    u.FirstName,
                    u.LastName
                FROM oe.Members m
                INNER JOIN oe.Users u ON m.UserId = u.UserId
                INNER JOIN oe.Enrollments e ON m.MemberId = e.MemberId
                INNER JOIN oe.Products p ON e.ProductId = p.ProductId
                WHERE m.MemberId = @memberId AND p.VendorId = @vendorId
            `);
        const member = memberResult.recordset[0];
        if (!member) {
            return res.status(404).json({ success: false, message: 'Member not found or not enrolled in vendor products' });
        }

        // Upload the PDF to blob storage with a short-lived signed URL.
        const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
        if (!connectionString) {
            return res.status(503).json({ success: false, message: 'Blob storage not configured' });
        }
        const {
            BlobServiceClient,
            generateBlobSASQueryParameters,
            BlobSASPermissions,
        } = require('@azure/storage-blob');
        const { v4: uuidv4 } = require('uuid');

        const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        const containerName = 'id-cards';
        const containerClient = blobServiceClient.getContainerClient(containerName);
        await containerClient.createIfNotExists({ access: 'blob' });

        const safeProductName = (productName && String(productName).trim()) || 'ID Card';
        const safeFileName = (fileName && String(fileName).trim()) || `${safeProductName.replace(/[^\w\-]+/g, '_')}-id-card.pdf`;
        // Flat blob name (no virtual subdirectory) — keeps the URL path simpler
        // for SMS clients and avoids any path-segment edge cases.
        const sanitizedFile = safeFileName.replace(/[^\w\-.]+/g, '_');
        const blobName = `${uuidv4()}-${sanitizedFile}`;
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);

        const pdfBuffer = Buffer.from(
            String(pdfBase64).replace(/^data:application\/pdf;base64,/, ''),
            'base64',
        );
        await blockBlobClient.uploadData(pdfBuffer, {
            blobHTTPHeaders: { blobContentType: 'application/pdf' },
            metadata: {
                memberId: member.MemberId,
                vendorId: req.vendor.VendorId,
                uploadType: 'id-card-sms',
            },
        });

        const expiresOn = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
        const sasToken = generateBlobSASQueryParameters(
            {
                containerName,
                blobName,
                permissions: BlobSASPermissions.parse('r'),
                expiresOn,
                startsOn: new Date(Date.now() - 60 * 1000),
                protocol: 'https',
            },
            blobServiceClient.credential,
        ).toString();
        const pdfUrl = `${blockBlobClient.url}?${sasToken}`;
        console.log(`📎 [id-card-sms] Uploaded blob ${containerName}/${blobName} → ${pdfUrl}`);

        // Body: { vendor-supplied message } { url }.
        // Default message comes from the frontend ("Here is your ID card:");
        // vendor can edit before sending.
        const prefix = (message && String(message).trim()) || 'Here is your ID card:';
        const body = `${prefix} ${pdfUrl}`;

        // Route through the shared queue service so the SMS lands in
        // oe.MessageQueue → oe.MessageHistory just like Message Center sends.
        const MessageQueueService = require('../../../services/messageQueue.service');
        const messageId = await MessageQueueService.queueMessage({
            tenantId: member.TenantId,
            messageType: 'SMS',
            // RecipientId is an FK to oe.Users.UserId, not oe.Members.MemberId.
            recipientId: member.UserId,
            recipientAddress: to,
            subject: null,
            messageBody: body,
            status: 'Pending',
            createdBy: req.user.UserId,
        });

        return res.json({ success: true, message: 'ID card link queued for SMS', messageId, url: pdfUrl });
    } catch (error) {
        console.error('❌ Error sending ID card SMS:', error);
        return res.status(500).json({ success: false, message: 'Failed to send ID card SMS', error: error.message });
    }
});

/**
 * GET /api/me/vendor/members/:id
 * Get a specific member's details
 */
router.get('/:id', async (req, res) => {
    try {
        const pool = await getPool();
        const request = pool.request();
        request.input('memberId', sql.UniqueIdentifier, req.params.id);
        request.input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId);

        // Verify the member has an enrollment with this vendor's products.
        // Returns regardless of enrollment status so vendors can view terminated /
        // pending-migration members. UI uses MemberStatus to badge / banner.
        const result = await request.query(`
            SELECT DISTINCT
                m.MemberId,
                m.HouseholdId,
                m.HouseholdMemberID,
                m.RelationshipType,
                m.Gender,
                u.FirstName,
                u.LastName,
                u.Email,
                u.PhoneNumber as Phone,
                m.Address,
                m.City,
                m.State,
                m.Zip as ZipCode,
                FORMAT(m.DateOfBirth, 'yyyy-MM-dd') as DateOfBirth,
                m.Status AS MemberRawStatus,
                m.IsPendingMigration,
                m.MigrationSourceSystem,
                CASE
                    WHEN m.IsPendingMigration = 1 THEN 'PendingMigration'
                    WHEN m.Status IN ('Terminated','Pending Termination') THEN 'Terminated'
                    WHEN NOT EXISTS (
                        SELECT 1 FROM oe.Enrollments ex
                        INNER JOIN oe.Products px ON ex.ProductId = px.ProductId
                        WHERE ex.MemberId = m.MemberId AND px.VendorId = @vendorId
                          AND ex.Status NOT IN ('Terminated','Inactive')
                    ) THEN 'Terminated'
                    WHEN m.Status IN ('Inactive','Declined') THEN 'Inactive'
                    ELSE 'Active'
                END AS MemberStatus,
                au.FirstName AS AgentFirstName,
                au.LastName AS AgentLastName,
                au.Email AS AgentEmail,
                au.PhoneNumber AS AgentPhone,
                -- Dependents/spouses usually carry no AgentId of their own; the
                -- agent is recorded on the household's primary. Flag when the
                -- contact shown was inherited so the UI can label it.
                CASE WHEN m.AgentId IS NULL AND hp.AgentId IS NOT NULL THEN 1 ELSE 0 END AS AgentFromHouseholdPrimary
            FROM oe.Members m
            INNER JOIN oe.Users u ON m.UserId = u.UserId
            INNER JOIN oe.Enrollments e ON m.MemberId = e.MemberId
            INNER JOIN oe.Products p ON e.ProductId = p.ProductId
            -- Fall back to the household primary's agent when this member has none.
            OUTER APPLY (
                SELECT TOP 1 pm.AgentId
                FROM oe.Members pm
                WHERE pm.HouseholdId = m.HouseholdId
                  AND pm.RelationshipType = 'P'
                  AND pm.AgentId IS NOT NULL
            ) hp
            LEFT JOIN oe.Agents a ON a.AgentId = COALESCE(m.AgentId, hp.AgentId)
            LEFT JOIN oe.Users au ON a.UserId = au.UserId
            WHERE m.MemberId = @memberId
            AND p.VendorId = @vendorId
        `);

        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Member not found or not enrolled in vendor products'
            });
        }

        res.json({
            success: true,
            data: result.recordset[0]
        });
    } catch (error) {
        console.error('❌ Error fetching member:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch member',
            error: error.message
        });
    }
});

/**
 * GET /api/me/vendor/members/:id/finance-summary
 * Aggregate finances for a member across all their share requests (scoped to
 * the requesting vendor), including the trailing-12-month "two unshared amounts
 * paid in full" coverage analysis. Backs the member workspace Finances tab and
 * provides a normalized contract for future AI / reporting consumers.
 */
router.get('/:id/finance-summary', async (req, res) => {
    try {
        const guidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!guidRe.test(req.params.id)) {
            return res.status(400).json({ success: false, message: 'Invalid member id' });
        }
        const summary = await FinanceSummaryService.getMemberFinanceSummary(
            req.params.id,
            req.vendor.VendorId
        );
        res.json({
            success: true,
            data: summary
        });
    } catch (error) {
        console.error('❌ Error computing member finance summary:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to compute member finance summary',
            error: error.message
        });
    }
});

/**
 * GET /api/me/vendor/members/:memberId/open-share-requests
 * List the member's open share requests (excludes Completed / Denied /
 * Withdrawn). Scoped to the requesting vendor — only returns SRs where
 * sr.VendorId = req.vendor.VendorId so a vendor never sees another vendor's
 * cases. Used by the "Send to member" linkage picker.
 */
router.get('/:memberId/open-share-requests', async (req, res) => {
    try {
        const { memberId } = req.params;
        const guidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!guidRe.test(memberId)) {
            return res.status(400).json({ success: false, message: 'Invalid member id' });
        }
        const pool = await getPool();
        const r = await pool.request()
            .input('memberId', sql.UniqueIdentifier, memberId)
            .input('vendorId', sql.UniqueIdentifier, req.vendor.VendorId)
            .query(`
                SELECT
                    sr.ShareRequestId, sr.RequestNumber,
                    sr.RequestTypeId, rt.Name AS RequestTypeName, sr.SubType,
                    sr.Status, sr.SubmittedDate, sr.TotalBilledAmount,
                    sr.Balance
                FROM oe.ShareRequests sr
                LEFT JOIN oe.VendorShareRequestTypes rt ON sr.RequestTypeId = rt.TypeId
                WHERE sr.MemberId = @memberId
                  AND sr.VendorId = @vendorId
                  AND sr.Status NOT IN ('Completed', 'Denied', 'Withdrawn')
                ORDER BY sr.SubmittedDate DESC
            `);
        res.json({ success: true, data: r.recordset });
    } catch (error) {
        console.error('❌ vendor open-share-requests error:', error);
        res.status(500).json({ success: false, message: 'Failed to load open share requests' });
    }
});

console.log('✅ Mounted Vendor Member routes');

module.exports = router;

