const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authorize } = require('../../../middleware/auth');
const requireTenantAccess = require('../../../middleware/requireTenantAccess');
const {
    parseEffectiveDateParts,
    buildEffectiveDateExistsSql,
    bindEffectiveDateParams,
    buildEnrollmentStatusExistsSql,
    bindAsOfDateParam
} = require('../../../utils/memberEffectiveDateFilter');
const {
  buildMemberListSummarySelectSql,
  MEMBER_LIST_SUMMARY_JOINS_SQL,
} = require('../../../utils/memberStatsSql');
const {
  MEMBER_LIST_ENROLLMENT_STATUS_SQL,
  MEMBER_LIST_ENROLLMENT_LINK_SENT_AT_SQL,
  MEMBER_LIST_MONTHLY_PREMIUM_SQL,
} = require('../../../utils/memberEnrollmentStatusSql');
const { getEnrollmentLifecycleFilterSql } = require('../../../utils/memberEnrollmentLifecycleFilterSql');
const {
  buildMemberListProductFilterExistsSql,
  ENROLLMENT_TYPE_PRODUCT_LIKE_SQL,
} = require('../../../utils/memberListProductFilterSql');

/**
 * @route   GET /api/me/tenant-admin/members
 * @desc    Get all members in the tenant of the authenticated TenantAdmin
 * @access  Private (TenantAdmin)
 */
router.get('/', authorize(['TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { 
            status, 
            search, 
            billType,
            memberTypeFilter,
            relationshipType,
            groupId,
            agentId,
            agencyId,
            state,
            householdOnly,
            enrollmentStatus = 'all', // active | futureEffective | effectiveCurrently | all
            enrollmentLifecycleStatus, // optional: paymentHold | enrollmentLinkSent | notEnrolled | noLinkSent
            productId,
            vendorId,
            sortBy = 'CreatedDate',
            sortOrder = 'desc',
            page = 1, 
            limit = 50 
        } = req.query;
        
        console.log('🔍 GET /api/me/tenant-admin/members - Request received');
        console.log('👤 User:', { 
            userId: req.user?.UserId,
            tenantId: req.tenantId || req.user?.TenantId,
            email: req.user?.Email
        });
        console.log('📋 Query params:', req.query);
        
        // Use req.tenantId (set by requireTenantAccess) which respects tenant switching
        const tenantId = req.tenantId || req.user?.TenantId;
        if (!tenantId) {
            console.log('❌ TenantId missing in request');
            return res.status(400).json({ 
                success: false, 
                message: 'TenantId not found in user token' 
            });
        }
        
        const pool = await getPool();
        
        // Calculate pagination
        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const offset = (pageNum - 1) * limitNum;
        
        // Build base query for tenant members
        let query = `
            SELECT 
                m.MemberId, m.UserId, m.GroupId, m.HouseholdId, m.MemberSequence,
                m.HouseholdMemberID,
                m.RelationshipType, m.Status, m.CreatedDate, m.IsPendingMigration,
                FORMAT(m.DateOfBirth, 'yyyy-MM-dd') as DateOfBirth,
                FORMAT(m.HireDate, 'yyyy-MM-dd') as HireDate,
                m.Gender, m.Address, m.City, m.State, m.Zip,
                m.WorkLocation, m.Tier, m.TobaccoUse,
                u.FirstName, u.LastName, u.Email, u.PhoneNumber,
                u.TenantId, u.Status as UserStatus, t.Name as TenantName,
                t.MemberIDPrefix as TenantMemberIDPrefix,
                t.IndividualMemberIDPrefix as TenantIndividualMemberIDPrefix,
                CASE WHEN g.GroupId IS NOT NULL THEN 'LB' ELSE 'SB' END as BillType,
                g.Name as GroupName,
                CASE m.RelationshipType
                    WHEN 'P' THEN 'Primary'
                    WHEN 'S' THEN 'Spouse'
                    WHEN 'C' THEN 'Child'
                    ELSE 'Unknown'
                END as RelationshipDescription,
                -- Include household member count
                (SELECT COUNT(*) FROM oe.Members m2 WHERE m2.HouseholdId = m.HouseholdId) as HouseholdSize,
                -- Include enrollment stats
                (SELECT COUNT(*) FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = 'Active') as ActiveEnrollments,
                (SELECT COUNT(*) FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = N'PaymentHold') as PaymentHoldEnrollmentCount,
                (SELECT COUNT(*) FROM oe.Enrollments e WHERE e.MemberId = m.MemberId) as TotalEnrollments,
                ${MEMBER_LIST_MONTHLY_PREMIUM_SQL},
                -- Earliest effective dates for "plan goes into effect in X days" indicator
                (SELECT MIN(e.EffectiveDate) FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status IN ('Active', 'Pending') AND (e.EnrollmentType = 'Product' OR (e.EnrollmentType IS NULL AND e.ProductId IS NOT NULL)) AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE()) AND CAST(e.EffectiveDate AS DATE) >= CAST(GETUTCDATE() AS DATE)) as EarliestFutureEffectiveDate,
                (SELECT MIN(e.EffectiveDate) FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status IN ('Active', 'Pending') AND (e.EnrollmentType = 'Product' OR (e.EnrollmentType IS NULL AND e.ProductId IS NOT NULL)) AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE()) AND CAST(e.EffectiveDate AS DATE) < CAST(GETUTCDATE() AS DATE)) as EarliestActiveEffectiveDate,
                (SELECT COUNT(*) FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status IN ('Active', 'Pending') AND (e.EnrollmentType = 'Product' OR (e.EnrollmentType IS NULL AND e.ProductId IS NOT NULL)) AND (e.TerminationDate IS NULL OR e.TerminationDate > GETUTCDATE()) AND CAST(e.EffectiveDate AS DATE) >= CAST(GETUTCDATE() AS DATE)) as FutureEffectiveDateCount,
                ${MEMBER_LIST_ENROLLMENT_STATUS_SQL},
                ${MEMBER_LIST_ENROLLMENT_LINK_SENT_AT_SQL},
                -- Primary member name for household context
                (SELECT u2.FirstName + ' ' + u2.LastName 
                 FROM oe.Members m2 
                 JOIN oe.Users u2 ON m2.UserId = u2.UserId 
                 WHERE m2.HouseholdId = m.HouseholdId AND m2.RelationshipType = 'P') as PrimaryMemberName,
                -- Agent information
                m.AgentId,
                ag.FirstName + ' ' + ag.LastName as AgentName,
                ag.Email as AgentEmail,
                a.AgencyId,
                agy.AgencyName,
                -- Group agent information
                g.AgentId as GroupAgentId,
                gag.FirstName + ' ' + gag.LastName as GroupAgentName,
                gag.Email as GroupAgentEmail
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
            LEFT JOIN oe.Tenants t ON u.TenantId = t.TenantId
            LEFT JOIN oe.Agents a ON m.AgentId = a.AgentId
            LEFT JOIN oe.Users ag ON a.UserId = ag.UserId
            LEFT JOIN oe.Agencies agy ON a.AgencyId = agy.AgencyId
            LEFT JOIN oe.Agents ga ON g.AgentId = ga.AgentId
            LEFT JOIN oe.Users gag ON ga.UserId = gag.UserId
            WHERE u.TenantId = @tenantId
        `;
        
        // Build count query - include necessary JOINs for filtering
        let countQuery = `
            SELECT COUNT(*) as total
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
            LEFT JOIN oe.Agents a ON m.AgentId = a.AgentId
            WHERE u.TenantId = @tenantId
        `;
        
        const request = pool.request();
        const countRequest = pool.request();
        const summaryRequest = pool.request();
        
        // Member status filter: when provided, filter by m.Status (e.g. Active, Terminated)
        if (status) {
            const statusCondition = ' AND m.Status = @status';
            query += statusCondition;
            countQuery += statusCondition;
            request.input('status', sql.NVarChar, status);
            countRequest.input('status', sql.NVarChar, status);
            summaryRequest.input('status', sql.NVarChar, status);
        }
        
        request.input('tenantId', sql.UniqueIdentifier, tenantId);
        countRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
        summaryRequest.input('tenantId', sql.UniqueIdentifier, tenantId);
        
        // Apply filters (multi-word: each token must match FirstName, LastName, Email, or HouseholdMemberID)
        const searchTrim = (search || '').trim();
        if (searchTrim) {
            const tokens = searchTrim.split(/\s+/).filter(Boolean);
            const searchParts = [];
            tokens.forEach((token, i) => {
                const param = `search${i}`;
                const pattern = `%${String(token).replace(/%/g, '[%]').replace(/_/g, '[_]')}%`;
                searchParts.push(`(u.FirstName LIKE @${param} OR u.LastName LIKE @${param} OR u.Email LIKE @${param} OR m.HouseholdMemberID LIKE @${param})`);
                request.input(param, sql.NVarChar, pattern);
                countRequest.input(param, sql.NVarChar, pattern);
                summaryRequest.input(param, sql.NVarChar, pattern);
            });
            if (searchParts.length) {
                const searchCondition = ' AND ' + searchParts.join(' AND ');
                query += searchCondition;
                countQuery += searchCondition;
            }
        }
        
        if (groupId) {
            const groupCondition = ' AND m.GroupId = @groupId';
            query += groupCondition;
            countQuery += groupCondition;
            request.input('groupId', sql.UniqueIdentifier, groupId);
            countRequest.input('groupId', sql.UniqueIdentifier, groupId);
            summaryRequest.input('groupId', sql.UniqueIdentifier, groupId);
        }
        
        const memberTypeNorm = (() => {
            const mt = String(memberTypeFilter || '').toLowerCase();
            if (mt === 'group' || mt === 'individual') return mt;
            if (billType === 'LB') return 'group';
            if (billType === 'SB') return 'individual';
            return '';
        })();
        if (memberTypeNorm === 'group') {
            const billCondition = ' AND m.GroupId IS NOT NULL';
            query += billCondition;
            countQuery += billCondition;
        } else if (memberTypeNorm === 'individual') {
            const billCondition = ' AND m.GroupId IS NULL';
            query += billCondition;
            countQuery += billCondition;
        }
        
        if (relationshipType) {
            const relationshipCondition = ' AND m.RelationshipType = @relationshipType';
            query += relationshipCondition;
            countQuery += relationshipCondition;
            request.input('relationshipType', sql.NVarChar, relationshipType);
            countRequest.input('relationshipType', sql.NVarChar, relationshipType);
            summaryRequest.input('relationshipType', sql.NVarChar, relationshipType);
        }
        
        if (state) {
            const stateCondition = ' AND m.State = @state';
            query += stateCondition;
            countQuery += stateCondition;
            request.input('state', sql.NVarChar, state);
            countRequest.input('state', sql.NVarChar, state);
            summaryRequest.input('state', sql.NVarChar, state);
        }
        
        if (householdOnly === 'true') {
            const householdCondition = ' AND m.HouseholdId IS NOT NULL';
            query += householdCondition;
            countQuery += householdCondition;
        }
        
        if (agentId) {
            const agentCondition = ' AND m.AgentId = @agentId';
            query += agentCondition;
            countQuery += agentCondition;
            request.input('agentId', sql.UniqueIdentifier, agentId);
            countRequest.input('agentId', sql.UniqueIdentifier, agentId);
            summaryRequest.input('agentId', sql.UniqueIdentifier, agentId);
        }
        
        if (agencyId) {
            const agencyCondition = ' AND a.AgencyId = @agencyId';
            query += agencyCondition;
            countQuery += agencyCondition;
            request.input('agencyId', sql.UniqueIdentifier, agencyId);
            countRequest.input('agencyId', sql.UniqueIdentifier, agencyId);
            summaryRequest.input('agencyId', sql.UniqueIdentifier, agencyId);
        }
        
        const lifecycleFilterSql = getEnrollmentLifecycleFilterSql(enrollmentLifecycleStatus);
        if (lifecycleFilterSql) {
            query += lifecycleFilterSql;
            countQuery += lifecycleFilterSql;
        }

        const enrollmentStatusSql = buildEnrollmentStatusExistsSql(enrollmentStatus);
        if (enrollmentStatusSql) {
            query += enrollmentStatusSql;
            countQuery += enrollmentStatusSql;
        }

        // Product filter: members enrolled in a specific product
        if (productId) {
            const productCondition = ` AND ${buildMemberListProductFilterExistsSql()}`;
            query += productCondition;
            countQuery += productCondition;
            request.input('productId', sql.UniqueIdentifier, productId);
            countRequest.input('productId', sql.UniqueIdentifier, productId);
            summaryRequest.input('productId', sql.UniqueIdentifier, productId);
        }

        // Vendor filter: members enrolled in products from a specific vendor (direct or via bundle)
        if (vendorId) {
            const vendorCondition = ` AND (
                EXISTS (
                    SELECT 1 FROM oe.Enrollments e 
                    INNER JOIN oe.Products p ON e.ProductId = p.ProductId 
                    WHERE e.MemberId = m.MemberId AND p.VendorId = @vendorId 
                    AND (e.Status = 'Active' OR e.Status = 'Pending')
                    AND (e.TerminationDate IS NULL OR e.TerminationDate > GETDATE())
                    AND ${ENROLLMENT_TYPE_PRODUCT_LIKE_SQL}
                )
                OR EXISTS (
                    SELECT 1 FROM oe.Enrollments e 
                    INNER JOIN oe.ProductBundles pb ON pb.BundleProductId = e.ProductId 
                    INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId 
                    WHERE e.MemberId = m.MemberId AND p.VendorId = @vendorId 
                    AND (e.Status = 'Active' OR e.Status = 'Pending')
                    AND (e.TerminationDate IS NULL OR e.TerminationDate > GETDATE())
                    AND ${ENROLLMENT_TYPE_PRODUCT_LIKE_SQL}
                )
            )`;
            query += vendorCondition;
            countQuery += vendorCondition;
            request.input('vendorId', sql.UniqueIdentifier, vendorId);
            countRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
            summaryRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
        }

        const edParsed = parseEffectiveDateParts(req.query);
        if (edParsed.error) {
            return res.status(400).json({ success: false, message: edParsed.error });
        }
        if (enrollmentStatusSql) {
            bindAsOfDateParam(edParsed.parts, request, countRequest, summaryRequest);
        }
        if (edParsed.parts) {
            // Legacy effective-date matching remains available only when enrollment status is "all".
            if (!enrollmentStatusSql) {
                const edSql = buildEffectiveDateExistsSql(edParsed.parts);
                query += edSql;
                countQuery += edSql;
                bindEffectiveDateParams(edParsed.parts, request, countRequest, summaryRequest);
            }
        }
        
        // Build ORDER BY clause based on sortBy and sortOrder
        const sortOrderUpper = (sortOrder || 'desc').toUpperCase();
        let orderByClause = '';
        
        // Map frontend field names to database columns
        switch (sortBy) {
            case 'CreatedDate':
                orderByClause = `m.CreatedDate ${sortOrderUpper}`;
                break;
            case 'LastName':
                orderByClause = `u.LastName ${sortOrderUpper}, u.FirstName ${sortOrderUpper}`;
                break;
            case 'FirstName':
                orderByClause = `u.FirstName ${sortOrderUpper}, u.LastName ${sortOrderUpper}`;
                break;
            case 'Email':
                orderByClause = `u.Email ${sortOrderUpper}`;
                break;
            case 'Status':
                orderByClause = `m.Status ${sortOrderUpper}`;
                break;
            case 'AgencyName':
                orderByClause = `agy.AgencyName ${sortOrderUpper}`;
                break;
            case 'AgentName':
                orderByClause = `ag.LastName ${sortOrderUpper}, ag.FirstName ${sortOrderUpper}`;
                break;
            default:
                // Default to newest first (CreatedDate DESC)
                orderByClause = 'm.CreatedDate DESC';
        }
        
        // Add ordering and pagination
        query += ` ORDER BY ${orderByClause} OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`;
        request.input('offset', sql.Int, offset);
        request.input('limit', sql.Int, limitNum);
        
        let summaryFromAndWhere = countQuery.replace('SELECT COUNT(*) as total', '');
        summaryFromAndWhere = summaryFromAndWhere.trim();
        if (summaryFromAndWhere.startsWith('FROM')) {
            summaryFromAndWhere = summaryFromAndWhere.slice(4).trim();
        }
        const whereIndex = summaryFromAndWhere.toUpperCase().indexOf('WHERE');
        const summaryWhereClause = whereIndex >= 0
            ? summaryFromAndWhere.slice(whereIndex + 5).trim()
            : '1=1';
        const summaryQuery = buildMemberListSummarySelectSql({
            memberWhereClause: summaryWhereClause,
            joinsSql: MEMBER_LIST_SUMMARY_JOINS_SQL,
        });

        // Execute queries
        const [result, countResult, summaryResult] = await Promise.all([
            request.query(query),
            countRequest.query(countQuery),
            summaryRequest.query(summaryQuery)
        ]);
        
        const members = result.recordset || [];
        const total = countResult.recordset[0]?.total || 0;
        const summaryRow = summaryResult.recordset?.[0] || {};
        const summary = {
            householdCount: Number(summaryRow.householdCount) || 0,
            monthlyPremiums: Number(summaryRow.monthlyPremiums) || 0
        };
        
        console.log('✅ TenantAdmin members query result:', { 
            membersCount: members.length,
            total: total,
            tenantId: tenantId,
            page: pageNum,
            limit: limitNum
        });
        
        res.json({ 
            success: true, 
            data: { 
                members, 
                total,
                page: pageNum,
                limit: limitNum,
                totalPages: Math.ceil(total / limitNum),
                summary
            }
        });
        
    } catch (error) {
        console.error('❌ Error fetching tenant-admin members:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Server error while fetching tenant members',
            error: {
                message: error.message,
                code: 'TENANT_MEMBERS_FETCH_ERROR'
            }
        });
    }
});

/**
 * @route   GET /api/me/tenant-admin/members/search
 * @desc    Lightweight member-search by name / member-id / email for the
 *          "send to member" forms flow.
 * @access  Private (TenantAdmin)
 */
router.get('/search', authorize(['TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
        if (q.length < 2) {
            return res.json({ success: true, data: [] });
        }
        const pool = await getPool();
        const r = await pool.request()
            .input('tenantId', sql.UniqueIdentifier, req.user.TenantId)
            .input('search', sql.NVarChar, `%${q}%`)
            .input('limit', sql.Int, limit)
            .query(`
                SELECT TOP (@limit)
                    m.MemberId,
                    u.FirstName,
                    u.LastName,
                    u.Email,
                    u.PhoneNumber AS Phone,
                    m.HouseholdId,
                    m.HouseholdMemberID
                FROM oe.Members m
                INNER JOIN oe.Users u ON m.UserId = u.UserId
                WHERE m.TenantId = @tenantId
                  AND (
                      u.FirstName LIKE @search
                      OR u.LastName LIKE @search
                      OR u.Email LIKE @search
                      OR m.HouseholdMemberID LIKE @search
                      OR (u.FirstName + ' ' + u.LastName) LIKE @search
                  )
                ORDER BY u.LastName, u.FirstName
            `);
        res.json({ success: true, data: r.recordset });
    } catch (err) {
        console.error('❌ tenant-admin member-search error:', err);
        res.status(500).json({ success: false, message: 'Member search failed' });
    }
});

/**
 * @route   GET /api/me/tenant-admin/members/:memberId/open-share-requests
 * @desc    List the member's open share requests (excludes Completed / Denied /
 *          Withdrawn). Used by the "Send to member" linkage picker.
 * @access  Private (TenantAdmin)
 */
router.get('/:memberId/open-share-requests', authorize(['TenantAdmin']), requireTenantAccess, async (req, res) => {
    try {
        const { memberId } = req.params;
        const guidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!guidRe.test(memberId)) {
            return res.status(400).json({ success: false, message: 'Invalid member id' });
        }
        const pool = await getPool();
        const r = await pool.request()
            .input('memberId', sql.UniqueIdentifier, memberId)
            .input('tenantId', sql.UniqueIdentifier, req.user.TenantId)
            .query(`
                SELECT
                    sr.ShareRequestId, sr.RequestNumber,
                    sr.RequestTypeId, rt.Name AS RequestTypeName, sr.SubType,
                    sr.Status, sr.SubmittedDate, sr.TotalBilledAmount,
                    sr.Balance
                FROM oe.ShareRequests sr
                INNER JOIN oe.Members m ON m.MemberId = sr.MemberId
                LEFT JOIN oe.VendorShareRequestTypes rt ON sr.RequestTypeId = rt.TypeId
                WHERE sr.MemberId = @memberId
                  AND m.TenantId = @tenantId
                  AND sr.Status NOT IN ('Completed', 'Denied', 'Withdrawn')
                ORDER BY sr.SubmittedDate DESC
            `);
        res.json({ success: true, data: r.recordset });
    } catch (err) {
        console.error('❌ tenant-admin open-share-requests error:', err);
        res.status(500).json({ success: false, message: 'Failed to load open share requests' });
    }
});

module.exports = router;