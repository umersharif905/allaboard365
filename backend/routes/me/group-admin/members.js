const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authorize } = require('../../../middleware/auth');
const {
    parseEffectiveDateParts,
    buildEffectiveDateExistsSql,
    bindEffectiveDateParams,
    buildEnrollmentStatusExistsSql,
    bindAsOfDateParam
} = require('../../../utils/memberEffectiveDateFilter');
const {
  buildMemberListSummarySelectSql,
} = require('../../../utils/memberStatsSql');
const {
  MEMBER_LIST_ENROLLMENT_STATUS_SQL,
  MEMBER_LIST_ENROLLMENT_LINK_SENT_AT_SQL,
  MEMBER_LIST_MONTHLY_PREMIUM_SQL,
} = require('../../../utils/memberEnrollmentStatusSql');
const {
  buildMemberListProductFilterExistsSql,
  ENROLLMENT_TYPE_PRODUCT_LIKE_SQL,
} = require('../../../utils/memberListProductFilterSql');

/**
 * @route   GET /api/me/group-admin/members
 * @desc    Get all members in the group of the authenticated Group Admin
 * @access  Private (GroupAdmin)
 */
router.get('/', authorize(['GroupAdmin']), async (req, res) => {
    try {
        const { 
            status,
            search,
            memberTypeFilter,
            enrollmentStatus = 'all', // active | futureEffective | effectiveCurrently | all
            enrollmentLifecycleStatus, // optional: 'paymentHold'
            productId,
            vendorId,
            sortBy = 'CreatedDate',
            sortOrder = 'desc'
        } = req.query;
        
        console.log('🔍 GET /api/me/group-admin/members - Request received');
        console.log('👤 User:', { 
            userId: req.user?.UserId,
            roles: req.user?.roles,
            email: req.user?.Email
        });
        console.log('📋 Query params:', req.query);
        
        const userId = req.user?.UserId;
        if (!userId) {
            console.log('❌ User ID missing in request');
            return res.status(401).json({ success: false, message: 'User not authenticated or user ID is missing.' });
        }
        
        const pool = await getPool();
        console.log('📊 Database connection established');

        // Simplified logic: Get the GroupId from the admin's own member record.
        const memberQuery = `
            SELECT GroupId FROM oe.Members WHERE UserId = @userId
        `;
        
        const memberRequest = pool.request();
        memberRequest.input('userId', sql.UniqueIdentifier, userId);
        const memberResult = await memberRequest.query(memberQuery);
        
        console.log('🔎 Member query result:', memberResult.recordset);
        
        if (memberResult.recordset.length === 0 || !memberResult.recordset[0].GroupId) {
            console.log('❌ No group found for GroupAdmin user:', userId);
            return res.json({ 
                success: true, 
                data: { members: [], total: 0 },
                message: 'No group associated with this admin'
            });
        }
        
        const groupId = memberResult.recordset[0].GroupId;
        console.log('👥 Found GroupId for admin:', groupId);

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
            default:
                // Default to newest first (CreatedDate DESC)
                orderByClause = 'm.CreatedDate DESC';
        }

        // Member status filter: when provided, filter by m.Status (e.g. Active, Terminated)
        const statusFilter = status ? `AND m.Status = @status` : '';
        
        const enrollmentFilter = buildEnrollmentStatusExistsSql(enrollmentStatus);

        // Product filter: members enrolled in a specific product
        const productFilter = productId
            ? `AND ${buildMemberListProductFilterExistsSql()}`
            : '';

        // Vendor filter: members enrolled in products from a specific vendor (direct or via bundle)
        const vendorFilter = vendorId
            ? `AND (
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
            )`
            : '';

        const paymentHoldFilter = enrollmentLifecycleStatus === 'paymentHold'
            ? `AND EXISTS (
                SELECT 1 FROM oe.Enrollments e
                WHERE e.MemberId = m.MemberId AND e.Status = N'PaymentHold'
            )`
            : '';

        const edParsed = parseEffectiveDateParts(req.query);
        if (edParsed.error) {
            return res.status(400).json({ success: false, message: edParsed.error });
        }
        const effectiveDateFilter = edParsed.parts && !enrollmentFilter
            ? buildEffectiveDateExistsSql(edParsed.parts)
            : '';

        const searchTrim = (search || '').trim();
        let searchFilter = '';
        const searchParams = [];
        if (searchTrim) {
            const tokens = searchTrim.split(/\s+/).filter(Boolean);
            const searchParts = [];
            tokens.forEach((token, i) => {
                const param = `search${i}`;
                const pattern = `%${String(token).replace(/%/g, '[%]').replace(/_/g, '[_]')}%`;
                searchParams.push({ param, pattern });
                searchParts.push(
                    `(u.FirstName LIKE @${param} OR u.LastName LIKE @${param} OR u.Email LIKE @${param} OR u.PhoneNumber LIKE @${param} OR m.HouseholdMemberID LIKE @${param})`
                );
            });
            if (searchParts.length) {
                searchFilter = ' AND ' + searchParts.join(' AND ');
            }
        }

        // Non-group (individual) members have no GroupId; this route is scoped to one group, so "individual" yields no rows.
        const memberTypeFilterNorm = String(memberTypeFilter || '').toLowerCase();
        const memberTypeFilterSql = memberTypeFilterNorm === 'individual' ? ' AND 1=0' : '';
        
        // Fetch all members belonging to that GroupId.
        const membersQuery = `
            SELECT 
                m.MemberId, m.UserId, u.FirstName, u.LastName, u.Email, u.PhoneNumber,
                m.Status, m.RelationshipType, m.CreatedDate, m.IsPendingMigration, FORMAT(m.DateOfBirth, 'yyyy-MM-dd') as DateOfBirth,
                FORMAT(m.HireDate, 'yyyy-MM-dd') as HireDate,
                m.Address, m.City, m.State, m.Zip, m.Gender,
                m.WorkLocation, m.Tier, m.TobaccoUse,
                m.HouseholdId, m.GroupId, m.HouseholdMemberID,
                g.Name as GroupName,
                (SELECT COUNT(*) FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = 'Active') as ActiveEnrollments,
                (SELECT COUNT(*) FROM oe.Enrollments e WHERE e.MemberId = m.MemberId AND e.Status = N'PaymentHold') as PaymentHoldEnrollmentCount,
                ${MEMBER_LIST_MONTHLY_PREMIUM_SQL},
                ${MEMBER_LIST_ENROLLMENT_STATUS_SQL},
                ${MEMBER_LIST_ENROLLMENT_LINK_SENT_AT_SQL}
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
            WHERE m.GroupId = @groupId
            ${statusFilter}
            ${enrollmentFilter}
            ${effectiveDateFilter}
            ${paymentHoldFilter}
            ${productFilter}
            ${vendorFilter}
            ${searchFilter}
            ${memberTypeFilterSql}
            ORDER BY ${orderByClause};

            -- Fetch the total count for the same GroupId.
            SELECT COUNT(*) as total 
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            WHERE m.GroupId = @groupId
            ${statusFilter}
            ${enrollmentFilter}
            ${effectiveDateFilter}
            ${paymentHoldFilter}
            ${productFilter}
            ${vendorFilter}
            ${searchFilter}
            ${memberTypeFilterSql};
        `;
        
        const membersRequest = pool.request();
        const summaryRequest = pool.request();
        membersRequest.input('groupId', sql.UniqueIdentifier, groupId);
        summaryRequest.input('groupId', sql.UniqueIdentifier, groupId);
        if (status) {
            membersRequest.input('status', sql.NVarChar, status);
            summaryRequest.input('status', sql.NVarChar, status);
        }
        if (productId) {
            membersRequest.input('productId', sql.UniqueIdentifier, productId);
            summaryRequest.input('productId', sql.UniqueIdentifier, productId);
        }
        if (vendorId) {
            membersRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
            summaryRequest.input('vendorId', sql.UniqueIdentifier, vendorId);
        }
        searchParams.forEach(({ param, pattern }) => {
            membersRequest.input(param, sql.NVarChar, pattern);
            summaryRequest.input(param, sql.NVarChar, pattern);
        });
        if (enrollmentFilter) {
            bindAsOfDateParam(edParsed.parts, membersRequest, summaryRequest);
        }
        if (edParsed.parts && !enrollmentFilter) {
            bindEffectiveDateParams(edParsed.parts, membersRequest, summaryRequest);
        }

        const summaryWhereClause = `m.GroupId = @groupId
            ${statusFilter}
            ${enrollmentFilter}
            ${effectiveDateFilter}
            ${paymentHoldFilter}
            ${productFilter}
            ${vendorFilter}
            ${searchFilter}
            ${memberTypeFilterSql}`;
        const groupSummaryJoinsSql = `
          JOIN oe.Users u ON m.UserId = u.UserId
          LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId`;
        const summaryQuery = buildMemberListSummarySelectSql({
            memberWhereClause: summaryWhereClause,
            joinsSql: groupSummaryJoinsSql,
        });

        const [result, summaryResult] = await Promise.all([
            membersRequest.query(membersQuery),
            summaryRequest.query(summaryQuery)
        ]);
        
        console.log('📋 Members query result:', { 
            recordsetCount: result.recordsets.length,
            membersCount: result.recordsets[0]?.length || 0,
            totalCount: result.recordsets[1]?.[0]?.total || 0
        });
        
        const members = result.recordsets[0] || [];
        const total = result.recordsets[1]?.[0]?.total || 0;
        const summaryRow = summaryResult.recordset?.[0] || {};
        const summary = {
            householdCount: Number(summaryRow.householdCount) || 0,
            monthlyPremiums: Number(summaryRow.monthlyPremiums) || 0
        };

        // Ensure we don't return the placeholder NULL row if no group was found.
        const filteredMembers = members.filter(member => member.MemberId !== null);
        
        console.log('✅ Returning members:', filteredMembers.length);
        
        res.json({ success: true, data: { members: filteredMembers, total, summary } });

    } catch (error) {
        console.error('❌ Error fetching group admin members:', error.message);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});

module.exports = router; 