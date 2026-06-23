const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../../../config/database');
const { authorize, getUserRoles } = require('../../../middleware/auth');
const {
    isUplineAncestor,
    getSelfAndDownlineAgentIds,
    getAgentIdsForAgency,
    getDirectDownlineAgentIds
} = require('../../../utils/agentHierarchy');
const agencyAdmins = require('../../../utils/agencyAdmins');
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
 * @route   GET /api/me/agent/members
 * @desc    Get all members assigned to the authenticated agent
 * @access  Private (Agent)
 */
router.get('/', authorize(['Agent']), async (req, res) => {
    try {
        const { 
            status, 
            search, 
            billType,
            memberTypeFilter,
            relationshipType,
            groupId,
            state,
            householdOnly,
            enrollmentStatus = 'all', // active | futureEffective | effectiveCurrently | all
            enrollmentLifecycleStatus, // optional: paymentHold | enrollmentLinkSent | notEnrolled | noLinkSent
            productId,
            vendorId,
            sortBy = 'CreatedDate',
            sortOrder = 'desc',
            page = 1, 
            limit = 50,
            agentId: requestedAgentId,
            scope: scopeParam
        } = req.query;
        
        console.log('🔍 GET /api/me/agent/members - Request received');
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

        // Get AgentId + AgencyId from oe.Agents
        const agentQuery = 'SELECT AgentId, AgencyId FROM oe.Agents WHERE UserId = @userId AND Status = \'Active\'';
        console.log('🔎 Agent query:', agentQuery);

        const agentRequest = pool.request();
        agentRequest.input('userId', sql.UniqueIdentifier, userId);
        const agentResult = await agentRequest.query(agentQuery);

        console.log('🔎 Agent query result:', agentResult.recordset);

        if (agentResult.recordset.length === 0) {
            console.log('❌ No agent profile found for user:', userId);
            return res.status(404).json({ success: false, message: 'Agent profile not found for this user.' });
        }

        let agentId = agentResult.recordset[0].AgentId;
        const myAgencyId = agentResult.recordset[0].AgencyId;
        const currentUserAgentId = agentId;
        const userRoles = getUserRoles(req.user) || [];
        const hasAgencyOwnerRole = userRoles.includes('AgencyOwner');
        const isAgencyOwner =
            hasAgencyOwnerRole ||
            (currentUserAgentId && myAgencyId
                ? await agencyAdmins.isAgencyAdmin(pool, myAgencyId, currentUserAgentId)
                : false);
        const hasRequestedAgentId = requestedAgentId && String(requestedAgentId).trim();
        if (hasRequestedAgentId) {
            const isSelf = String(requestedAgentId).toLowerCase() === String(currentUserAgentId).toLowerCase();
            const isDownline = await isUplineAncestor(pool, requestedAgentId, currentUserAgentId);
            let sameAgency = false;
            if (isAgencyOwner && myAgencyId) {
                const check = await pool.request()
                    .input('requestedAgentId', sql.UniqueIdentifier, requestedAgentId)
                    .input('agencyId', sql.UniqueIdentifier, myAgencyId)
                    .query('SELECT AgentId FROM oe.Agents WHERE AgentId = @requestedAgentId AND AgencyId = @agencyId AND Status = \'Active\'');
                sameAgency = check.recordset.length > 0;
            }
            if (!isSelf && !isDownline && !sameAgency) {
                return res.status(403).json({ success: false, message: 'Agent not in your downline.' });
            }
            agentId = requestedAgentId;
            console.log('🧑‍💼 Filtering by downline AgentId:', agentId);
        } else {
            console.log('🧑‍💼 Found AgentId:', agentId);
        }

        const scopeNorm = String(scopeParam || '').toLowerCase();
        const scopeDownline = !hasRequestedAgentId && scopeNorm === 'downline';
        const scopeAgency = !hasRequestedAgentId && scopeNorm === 'agency';
        const scopeDirect = !hasRequestedAgentId && scopeNorm === 'direct';
        let agentWhereSql = 'm.AgentId = @agentId';
        let downlineScopeIds = null;
        if (scopeAgency) {
            if (!isAgencyOwner) {
                return res.status(403).json({ success: false, message: 'Agency-wide scope requires Agency Owner role.' });
            }
            if (!myAgencyId) {
                return res.json({
                    success: true,
                    data: { members: [], total: 0, page: parseInt(page), limit: parseInt(limit) }
                });
            }
            downlineScopeIds = await getAgentIdsForAgency(pool, myAgencyId);
            if (downlineScopeIds.length === 0) {
                return res.json({
                    success: true,
                    data: { members: [], total: 0, page: parseInt(page), limit: parseInt(limit) }
                });
            }
            agentWhereSql = `m.AgentId IN (${downlineScopeIds.map((_, i) => `@mScope${i}`).join(', ')})`;
        } else if (scopeDirect) {
            downlineScopeIds = await getDirectDownlineAgentIds(pool, currentUserAgentId);
            if (downlineScopeIds.length === 0) {
                return res.json({
                    success: true,
                    data: { members: [], total: 0, page: parseInt(page), limit: parseInt(limit) }
                });
            }
            agentWhereSql = `m.AgentId IN (${downlineScopeIds.map((_, i) => `@mScope${i}`).join(', ')})`;
        } else if (scopeDownline) {
            downlineScopeIds = await getSelfAndDownlineAgentIds(pool, userId);
            if (downlineScopeIds.length === 0) {
                return res.json({
                    success: true,
                    data: { members: [], total: 0, page: parseInt(page), limit: parseInt(limit) }
                });
            }
            agentWhereSql = `m.AgentId IN (${downlineScopeIds.map((_, i) => `@mScope${i}`).join(', ')})`;
        }

        // Calculate pagination
        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const offset = (pageNum - 1) * limitNum;

        // Build base query for agent members with search and filters
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
                u.TenantId, t.Name as TenantName,
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
            LEFT JOIN oe.Agents ga ON g.AgentId = ga.AgentId
            LEFT JOIN oe.Users gag ON ga.UserId = gag.UserId
            WHERE ${agentWhereSql}
        `;

        // Build count query
        let countQuery = `
            SELECT COUNT(*) as total
            FROM oe.Members m
            JOIN oe.Users u ON m.UserId = u.UserId
            LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
            WHERE ${agentWhereSql}
        `;

        const request = pool.request();
        const countRequest = pool.request();
        const summaryRequest = pool.request();

        if (downlineScopeIds && downlineScopeIds.length) {
            downlineScopeIds.forEach((id, i) => {
                request.input(`mScope${i}`, sql.UniqueIdentifier, id);
                countRequest.input(`mScope${i}`, sql.UniqueIdentifier, id);
                summaryRequest.input(`mScope${i}`, sql.UniqueIdentifier, id);
            });
        } else {
            request.input('agentId', sql.UniqueIdentifier, agentId);
            countRequest.input('agentId', sql.UniqueIdentifier, agentId);
            summaryRequest.input('agentId', sql.UniqueIdentifier, agentId);
        }

        // Member status filter: when provided, filter by m.Status (e.g. Active, Terminated)
        if (status) {
            const statusCondition = ' AND m.Status = @status';
            query += statusCondition;
            countQuery += statusCondition;
            request.input('status', sql.NVarChar, status);
            countRequest.input('status', sql.NVarChar, status);
            summaryRequest.input('status', sql.NVarChar, status);
        }

        // Apply search filter (multi-word: each token must match FirstName, LastName, Email, Phone, or HouseholdMemberID)
        const searchTrim = (search || '').trim();
        if (searchTrim) {
            const tokens = searchTrim.split(/\s+/).filter(Boolean);
            const searchParts = [];
            tokens.forEach((token, i) => {
                const param = `search${i}`;
                const pattern = `%${String(token).replace(/%/g, '[%]').replace(/_/g, '[_]')}%`;
                searchParts.push(`(u.FirstName LIKE @${param} OR u.LastName LIKE @${param} OR u.Email LIKE @${param} OR u.PhoneNumber LIKE @${param} OR m.HouseholdMemberID LIKE @${param})`);
                request.input(param, sql.NVarChar, pattern);
                countRequest.input(param, sql.NVarChar, pattern);
                summaryRequest.input(param, sql.NVarChar, pattern);
            });
            if (searchParts.length) {
                const searchCondition = ' AND ' + searchParts.join(' AND ');
                query += searchCondition;
                countQuery += searchCondition;
                console.log('🔍 Applying search filter:', searchTrim);
            }
        }

        // Apply other filters
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

        if (householdOnly) {
            const householdCondition = ' AND m.RelationshipType = \'P\'';
            query += householdCondition;
            countQuery += householdCondition;
        }

        const agentLifecycleFilterSql = getEnrollmentLifecycleFilterSql(enrollmentLifecycleStatus);
        if (agentLifecycleFilterSql) {
            query += agentLifecycleFilterSql;
            countQuery += agentLifecycleFilterSql;
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

        const [membersResult, countResult, summaryResult] = await Promise.all([
            request.query(query),
            countRequest.query(countQuery),
            summaryRequest.query(summaryQuery)
        ]);

        const members = membersResult.recordset || [];
        const total = countResult.recordset[0]?.total || 0;
        const summaryRow = summaryResult.recordset?.[0] || {};
        const summary = {
            householdCount: Number(summaryRow.householdCount) || 0,
            monthlyPremiums: Number(summaryRow.monthlyPremiums) || 0
        };
        
        console.log('📋 Agent members query result:', { 
            membersCount: members.length,
            totalCount: total,
            searchTerm: search || 'none',
            page: pageNum,
            limit: limitNum
        });

        console.log('✅ Returning agent members:', members.length);
        
        res.json({ success: true, data: { members, total, summary } });

    } catch (error) {
        console.error('❌ Error fetching agent members:', error.message);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
});



module.exports = router; 